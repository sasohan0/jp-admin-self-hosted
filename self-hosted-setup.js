// Private, Discord-guided setup for a mentor-owned JP ADMIN deployment.
// Secrets stay in Render. Discord stores only a signed, non-secret capsule so
// the bot can rediscover its server after a restart.
const crypto = require('crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  OverwriteType,
  PermissionFlagsBits,
  PermissionsBitField,
} = require('discord.js');
const { cohortDefaults, cohorts, mode } = require('./config');
const { normalizeChannelName } = require('./channel-names');
const { ensureStandardChannels, repairAllStandardPermissions } = require('./setup-command');
const { syncMembers } = require('./roster');

const PREFIX = 'jp-setup';
const CAPSULE_PREFIX = 'JPADMIN_SETUP_V1:';
const REQUEST_TIMEOUT_MS = 15000;

function installerSecret() {
  const secret = String(process.env.COHORT_API_KEY || '').trim();
  if (secret.length < 32) throw new Error('COHORT_API_KEY must contain at least 32 characters');
  return secret;
}

function validateInstallerBackend() {
  let url;
  try { url = new URL(String(process.env.COHORT_API_URL || '').trim()); }
  catch { throw new Error('COHORT_API_URL is missing or invalid'); }
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com' || !/\/macros\/s\/[^/]+\/exec$/.test(url.pathname)) {
    throw new Error('COHORT_API_URL must be a deployed Apps Script Web App /exec URL');
  }
  installerSecret();
  return url.toString();
}

function signSetupPayload(payload, secret = installerSecret()) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${CAPSULE_PREFIX}${encoded}.${signature}`;
}

function parseSetupCapsule(content, secret = installerSecret()) {
  const raw = String(content || '');
  if (!raw.startsWith(CAPSULE_PREFIX)) return null;
  const parts = raw.slice(CAPSULE_PREFIX.length).split('.');
  if (parts.length !== 2) throw new Error('saved setup capsule is malformed');
  const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest();
  const received = Buffer.from(parts[1], 'base64url');
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    throw new Error('saved setup capsule signature is invalid');
  }
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); }
  catch { throw new Error('saved setup capsule contains invalid JSON'); }
  if (payload?.version !== 1) throw new Error('saved setup capsule version is unsupported');
  if (!/^\d{15,20}$/.test(String(payload.guildId || ''))) throw new Error('saved setup has an invalid server ID');
  if (!String(payload.name || '').trim()) throw new Error('saved setup has no cohort name');
  if (!Array.isArray(payload.supervisorIds) || !payload.supervisorIds.length ||
      !payload.supervisorIds.every(id => /^\d{15,20}$/.test(String(id)))) {
    throw new Error('saved setup has invalid supervisor IDs');
  }
  if (!payload.channels || Array.isArray(payload.channels) || typeof payload.channels !== 'object') {
    throw new Error('saved setup has invalid channel settings');
  }
  return payload;
}

function cohortFromPayload(payload) {
  return cohortDefaults({
    name: String(payload.name).trim(),
    registryKey: 'self_hosted',
    guildId: String(payload.guildId),
    supervisorIds: payload.supervisorIds.map(String),
    appsScriptUrl: validateInstallerBackend(),
    apiKey: installerSecret(),
    timezone: String(payload.timezone || process.env.COHORT_TIMEZONE || 'Asia/Dhaka'),
    channels: { ...payload.channels },
  });
}

function setupPayload(cohort) {
  return {
    version: 1,
    name: cohort.name,
    guildId: cohort.guildId,
    supervisorIds: [...cohort.supervisorIds],
    timezone: cohort.timezone,
    channels: { ...cohort.channels },
  };
}

async function pinnedMessages(channel) {
  const result = await channel.messages.fetchPins();
  return result.items.map(item => item.message);
}

async function findCapsuleMessage(channel, client) {
  const pinned = await pinnedMessages(channel).catch(() => []);
  return pinned.find(message =>
    message.author?.id === client.user.id && String(message.content || '').startsWith(CAPSULE_PREFIX));
}

async function saveSetupCapsule(client, cohort) {
  if (mode !== 'installer') return null;
  const channel = await client.channels.fetch(cohort.channels.supervisor);
  if (!channel?.isTextBased()) throw new Error('the private bot-admin channel is unavailable');
  const content = signSetupPayload(setupPayload(cohort));
  let message = await findCapsuleMessage(channel, client);
  if (message) await message.edit({ content, allowedMentions: { parse: [] } });
  else {
    message = await channel.send({ content, allowedMentions: { parse: [] } });
    await message.pin('JP ADMIN self-hosted setup state');
  }
  return message;
}

async function restoreSelfHostedCohort(client) {
  if (mode !== 'installer') return null;
  validateInstallerBackend();
  const restored = [];
  for (const guild of client.guilds.cache.values()) {
    const channels = await guild.channels.fetch();
    const candidates = [...channels.values()].filter(channel =>
      channel?.type === ChannelType.GuildText && normalizeChannelName(channel.name) === 'bot-admin');
    for (const channel of candidates) {
      const message = await findCapsuleMessage(channel, client);
      if (!message) continue;
      const payload = parseSetupCapsule(message.content);
      if (payload.guildId !== guild.id || payload.channels.supervisor !== channel.id) {
        throw new Error(`saved setup in ${guild.name} does not match its private channel`);
      }
      restored.push(cohortFromPayload(payload));
    }
  }
  if (restored.length > 1) throw new Error('self-hosted installer mode supports one configured server');
  if (!restored.length) return null;
  cohorts.splice(0, cohorts.length, restored[0]);
  return restored[0];
}

function adminOverwrites(guild, client, userId) {
  const access = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.ManageMessages,
  ];
  return [
    { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    { id: userId, type: OverwriteType.Member, allow: access },
    { id: client.user.id, type: OverwriteType.Member, allow: access },
  ];
}

async function ensurePrivateBotAdmin(client, guild, userId) {
  const channels = await guild.channels.fetch();
  let channel = [...channels.values()].find(item =>
    item?.type === ChannelType.GuildText && normalizeChannelName(item.name) === 'bot-admin');
  if (!channel) {
    channel = await guild.channels.create({
      name: 'bot-admin',
      type: ChannelType.GuildText,
      permissionOverwrites: adminOverwrites(guild, client, userId),
      reason: 'JP ADMIN private setup channel',
    });
  } else {
    for (const overwrite of adminOverwrites(guild, client, userId)) {
      await channel.permissionOverwrites.edit(overwrite.id, {
        ViewChannel: overwrite.deny?.includes(PermissionFlagsBits.ViewChannel) ? false : true,
        SendMessages: overwrite.allow?.includes(PermissionFlagsBits.SendMessages) ? true : null,
        ReadMessageHistory: overwrite.allow?.includes(PermissionFlagsBits.ReadMessageHistory) ? true : null,
        EmbedLinks: overwrite.allow?.includes(PermissionFlagsBits.EmbedLinks) ? true : null,
        AttachFiles: overwrite.allow?.includes(PermissionFlagsBits.AttachFiles) ? true : null,
        ManageMessages: overwrite.allow?.includes(PermissionFlagsBits.ManageMessages) ? true : null,
      }, { type: overwrite.type, reason: 'JP ADMIN private setup channel repair' });
    }
  }
  return channel;
}

function setupRows(includeAddCohort = false) {
  const first = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:permissions`).setLabel('1 · Google permissions').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${PREFIX}:channels`).setLabel('2 · Match channels').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${PREFIX}:sync`).setLabel('3 · Sync students').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${PREFIX}:verify`).setLabel('4 · Verify').setStyle(ButtonStyle.Success),
  );
  const second = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:explain`).setLabel('I need help').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PREFIX}:refresh`).setLabel('Retry / refresh').setStyle(ButtonStyle.Secondary),
  );
  if (includeAddCohort) {
    second.addComponents(
      new ButtonBuilder().setCustomId('cohort-manager:add:start').setLabel('Add another cohort').setStyle(ButtonStyle.Success),
    );
  }
  return [first, second];
}

function panelPayload(cohort) {
  return {
    embeds: [{
      title: `JP ADMIN setup · ${cohort.name}`,
      description: [
        'Complete these four private steps in order. You can safely retry any step.',
        '',
        '**1. Google permissions** — authorize the copied Apps Script and test its Web App.',
        '**2. Match channels** — reuse existing channels first; create only missing channels.',
        '**3. Sync students** — capture every current non-bot, non-supervisor member, even without intake.',
        '**4. Verify** — check the backend, channel privacy, and show the final diagnostic commands.',
        '',
        'No setup action deletes a channel, Sheet tab, message history, or student record.',
      ].join('\n'),
      color: 0x5865f2,
      footer: { text: 'Secrets remain in Render and are never shown here.' },
    }],
    components: setupRows(mode === 'multi'),
    allowedMentions: { parse: [] },
  };
}

function permissionsPayload() {
  return {
    embeds: [{
      title: 'Step 1 · Authorize Google and Apps Script',
      description: [
        '1. Open the Google Sheet you copied for this cohort.',
        '2. Choose **Extensions → Apps Script**.',
        '3. Confirm the complete `Code-v19-FINAL.gs` file is present and its `CONFIG` has your cohort name and the same private key you saved in Render.',
        '4. In the function list, choose **`authorizeAllRequiredServices`**, then press **Run**.',
        '5. Choose **Review permissions**, select your Google account, open **Advanced** if Google shows an unverified-app notice, and allow the requested access.',
        '6. Run **`setup`** once. Then choose **Deploy → New deployment → Web app**. Execute as **Me** and allow access to **Anyone**.',
        '7. Put the final `/exec` Web App URL into Render as `COHORT_API_URL`. Do not paste the private key into Discord.',
        '',
        'When finished, press **Done — test connection**. A failed test is read-only and safe to retry.',
      ].join('\n'),
      color: 0x4285f4,
    }],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Open Apps Script').setStyle(ButtonStyle.Link).setURL('https://script.google.com/home'),
        new ButtonBuilder().setCustomId(`${PREFIX}:backend-test`).setLabel('Done — test connection').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${PREFIX}:permissions-help`).setLabel('Could not understand').setStyle(ButtonStyle.Secondary),
      ),
    ],
    ephemeral: true,
    allowedMentions: { parse: [] },
  };
}

async function checkBackend(cohort) {
  const url = new URL(cohort.appsScriptUrl);
  url.searchParams.set('action', 'health');
  url.searchParams.set('key', cohort.apiKey);
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Apps Script returned invalid JSON (HTTP ${response.status})`); }
  if (!response.ok || data?.error) throw new Error(`Apps Script health check failed (HTTP ${response.status})`);
  return data;
}

function configuredContext(guildId, channelId, userId) {
  const cohort = cohorts.find(item => item.guildId === guildId);
  if (!cohort?.supervisorIds?.includes(userId)) return null;
  if (cohort.channels?.supervisor !== channelId) return null;
  return cohort;
}

async function safeInteractionReply(interaction, payload) {
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply(payload);
}

function errorText(error) {
  return String(error?.message || error || 'Unknown error')
    .replace(/https:\/\/script\.google\.com\/\S+/gi, '[Apps Script URL hidden]')
    .slice(0, 1200);
}

function registerSelfHostedSetup(client, options = {}) {
  if (client.__jpSetupAssistantRegistered) return;
  client.__jpSetupAssistantRegistered = true;

  client.on('messageCreate', async message => {
    if (message.author.bot || !/^!setup(?:\s+(?:guide|wizard))?$/i.test(message.content.trim())) return;
    if (!message.guild) return;
    let cohort = cohorts.find(item => item.guildId === message.guildId);
    if (cohort) {
      if (!cohort.supervisorIds.includes(message.author.id)) return;
      if (message.channelId !== cohort.channels?.supervisor) {
        await message.reply({ content: `Continue privately in <#${cohort.channels.supervisor}>.`, allowedMentions: { parse: [] } });
        return;
      }
      await message.channel.send(panelPayload(cohort));
      return;
    }
    if (mode !== 'installer') return;
    if (cohorts.length) {
      await message.reply({
        content: 'This self-hosted bot is already paired with another server. Use that server’s private `#bot-admin`; no settings were changed here.',
        allowedMentions: { parse: [] },
      });
      return;
    }
    const member = message.member;
    if (!member?.permissions?.has(PermissionsBitField.Flags.Administrator) &&
        !member?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) {
      await message.reply({ content: 'Only a server administrator can start setup.', allowedMentions: { parse: [] } });
      return;
    }
    try {
      validateInstallerBackend();
      const channel = await ensurePrivateBotAdmin(client, message.guild, message.author.id);
      cohort = cohortFromPayload({
        version: 1,
        name: process.env.COHORT_NAME || message.guild.name,
        guildId: message.guild.id,
        supervisorIds: [message.author.id],
        timezone: process.env.COHORT_TIMEZONE || 'Asia/Dhaka',
        channels: { supervisor: channel.id },
      });
      cohorts.splice(0, cohorts.length, cohort);
      await saveSetupCapsule(client, cohort);
      await channel.send(panelPayload(cohort));
      if (message.channelId !== channel.id) {
        await message.reply({ content: `Private setup is ready in <#${channel.id}>.`, allowedMentions: { parse: [] } });
      }
    } catch (error) {
      await message.reply({ content: `Setup could not start: ${errorText(error)}`, allowedMentions: { parse: [] } });
    }
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.isButton() || !interaction.customId?.startsWith(`${PREFIX}:`)) return;
    const cohort = configuredContext(interaction.guildId, interaction.channelId, interaction.user.id);
    if (!cohort) {
      await interaction.reply({ content: 'This setup control is private to configured supervisors.', ephemeral: true }).catch(() => {});
      return;
    }
    const action = interaction.customId.slice(PREFIX.length + 1);
    try {
      if (action === 'permissions') {
        await interaction.reply(permissionsPayload());
        return;
      }
      if (action === 'permissions-help') {
        await interaction.reply({
          content: [
            '**What this permission step does**',
            'Google asks once because the backend must read/write your cohort Sheet, create Forms and triggers, and send supervisor-approved Gmail batches. Running the helper does not email students or delete anything.',
            'If **Review permissions** does not appear, reload the Apps Script tab and run `authorizeAllRequiredServices` again. If deployment fails, confirm you are using the same Google account that owns the Sheet.',
          ].join('\n'),
          ephemeral: true,
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (action === 'backend-test') {
        await interaction.deferReply({ ephemeral: true });
        const result = await checkBackend(cohort);
        await interaction.editReply({
          content: `✅ Apps Script responded safely (backend ${result.version || 'version unknown'}). Next press **2 · Match channels**.`,
          allowedMentions: { parse: [] },
        });
        await options.onConfigured?.(cohort);
        return;
      }
      if (action === 'channels') {
        await interaction.deferReply({ ephemeral: true });
        const result = await ensureStandardChannels(client, cohort, interaction.guild);
        await saveSetupCapsule(client, cohort);
        await interaction.editReply({
          content: [
            `✅ Channel matching finished: **${result.reused.length} reused**, **${result.created.length} created**, **${result.failed.length} issues**.`,
            'Existing channels and messages were preserved. Private/locked channel permissions were repaired.',
            result.failed.length ? `Issues: ${result.failed.join('; ').slice(0, 700)}` : 'Next press **3 · Sync students**.',
          ].join('\n'),
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (action === 'sync') {
        await interaction.deferReply({ ephemeral: true });
        const result = await syncMembers(client, cohort, { force: true });
        await interaction.editReply({
          content: [
            `✅ Synced **${result.eligibleMembers || 0} existing Discord students**; **${result.activeRows || 0}** are trackable.`,
            `New provisional profiles: **${result.provisionalCreated || 0}**. Intake completion was not required.`,
            result.replacementSkipped
              ? `The Bot_Map replacement was skipped safely: ${String(result.skipReason || 'review required').slice(0, 500)}`
              : 'No existing student record was deleted; stale or duplicate mappings were preserved in Bot_Map Archive.',
            'Next press **4 · Verify**.',
          ].join('\n'),
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (action === 'verify') {
        await interaction.deferReply({ ephemeral: true });
        const [backend, permissions] = await Promise.all([
          checkBackend(cohort),
          repairAllStandardPermissions(client, cohort, interaction.guild),
        ]);
        await saveSetupCapsule(client, cohort);
        await interaction.editReply({
          content: [
            `✅ Backend **${backend.version || 'unknown'}** is reachable and ${permissions.repaired.length} private/locked channels were checked.`,
            permissions.failed.length ? `⚠️ Permission issues: ${permissions.failed.join('; ').slice(0, 700)}` : '✅ No permission repair failed.',
            '',
            'Final private checks: run `!checkperms`, then `!doctor`, then `!syncmembers` once more after students change.',
            'Setup is complete when `!doctor` shows the required backend, permissions, roster, and schedules as healthy.',
          ].join('\n'),
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (action === 'explain') {
        await interaction.reply({
          content: 'Use the numbered buttons from left to right. Every action is safe to retry. The bot reuses matching channels, never deletes channels or Sheet data, and does not ping students. The beginner guide included with the package explains Discord, Render, Google, and each button.',
          ephemeral: true,
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (action === 'refresh') {
        await interaction.reply({ ...panelPayload(cohort), ephemeral: true });
      }
    } catch (error) {
      await safeInteractionReply(interaction, {
        content: `❌ This step did not finish: ${errorText(error)}\nNothing was deleted. Fix the named issue and press the same button to retry.`,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`${PREFIX}:${action}`).setLabel('Retry').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`${PREFIX}:explain`).setLabel('Could not understand').setStyle(ButtonStyle.Secondary),
        )],
        allowedMentions: { parse: [] },
      }).catch(() => {});
    }
  });
}

module.exports = {
  CAPSULE_PREFIX,
  checkBackend,
  cohortFromPayload,
  ensurePrivateBotAdmin,
  parseSetupCapsule,
  registerSelfHostedSetup,
  restoreSelfHostedCohort,
  setupPayload,
  signSetupPayload,
  validateInstallerBackend,
};
