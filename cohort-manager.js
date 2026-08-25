// ============================================================
// cohort-manager.js - private Discord control panel for the
// durable managed cohort registry.
// ============================================================
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  PermissionsBitField,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { cohorts, findCohort } = require('./config');
const {
  MAX_COHORTS,
  buildManagedCohorts,
  controlCohort,
  saveCurrentCohorts,
  serializeCohort,
  validateAppsScriptUrl,
} = require('./managed-cohorts');
const {
  repairAllStandardPermissions,
  removeStandardSupervisorPermissions,
} = require('./setup-command');
const { syncMembers } = require('./roster');

const PREFIX = 'cohort-manager';
const REQUEST_TIMEOUT_MS = 15000;

function deriveRegistryKey(name) {
  const key = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  if (!key) throw new Error('Cohort name must contain letters or numbers');
  return key;
}

function parseSupervisorIds(value) {
  const ids = [...new Set(String(value || '').split(/[\s,]+/).map(item => item.trim()).filter(Boolean))];
  if (!ids.length || !ids.every(id => /^\d{15,20}$/.test(id))) {
    throw new Error('Supervisor IDs must be comma-separated Discord user IDs');
  }
  return ids;
}

function parseSupervisorCommand(value) {
  const text = String(value || '').trim();
  if (!/^!supervisors?(?:\s|$)/i.test(text)) return null;
  const match = text.match(/^!supervisors?(?:\s+(list|add|remove)(?:\s+(.+))?)?$/i);
  if (!match) throw new Error('Use `!supervisor list`, `!supervisor add @user`, or `!supervisor remove @user`.');
  const action = String(match[1] || 'list').toLowerCase();
  if (action === 'list') {
    if (match[2]) throw new Error('`!supervisor list` does not take a user.');
    return { action, userId: '' };
  }
  const rawTarget = String(match[2] || '').trim();
  const idMatch = rawTarget.match(/^(?:<@!?(\d{15,20})>|(\d{15,20}))$/);
  if (!idMatch) throw new Error(`Use \`!supervisor ${action} @user\` or provide the user's Discord ID.`);
  return { action, userId: idMatch[1] || idMatch[2] };
}

function applySupervisorChange(currentIds, action, targetId, actorId) {
  const ids = [...new Set((currentIds || []).map(String))];
  if (action === 'add') {
    if (ids.includes(targetId)) return { ids, changed: false };
    return { ids: [...ids, targetId], changed: true };
  }
  if (action !== 'remove') throw new Error('Supervisor action must be add or remove');
  if (targetId === actorId) throw new Error('You cannot remove yourself. Ask another supervisor to remove you.');
  if (!ids.includes(targetId)) return { ids, changed: false };
  const next = ids.filter(id => id !== targetId);
  if (!next.length) throw new Error('A cohort must keep at least one supervisor.');
  return { ids: next, changed: true };
}

function isGlobalManager(userId) {
  return Boolean(userId) && cohorts.length > 0
    && cohorts.every(cohort => cohort.supervisorIds.includes(userId));
}

function validateDeployHookUrl(value, expectedServiceId = process.env.RENDER_SERVICE_ID || '') {
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch { throw new Error('RENDER_DEPLOY_HOOK_URL is missing or invalid'); }
  const match = url.pathname.match(/^\/deploy\/(srv-[a-z0-9]+)$/i);
  if (url.protocol !== 'https:' || url.hostname !== 'api.render.com' || !match || !url.searchParams.get('key')) {
    throw new Error('RENDER_DEPLOY_HOOK_URL must be this service’s Render deploy hook');
  }
  if (expectedServiceId && match[1] !== expectedServiceId) {
    throw new Error('The deploy hook belongs to a different Render service');
  }
  return url;
}

async function triggerDeploy() {
  const url = validateDeployHookUrl(process.env.RENDER_DEPLOY_HOOK_URL);
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Render restart request failed (HTTP ${response.status})`);
}

async function checkBackend(appsScriptUrl, apiKey) {
  const url = new URL(validateAppsScriptUrl(appsScriptUrl, 'Cohort'));
  url.searchParams.set('action', 'health');
  url.searchParams.set('key', apiKey);
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Apps Script returned invalid JSON (HTTP ${response.status})`); }
  if (!response.ok || data?.error) {
    throw new Error(`Apps Script health check failed (HTTP ${response.status}); verify the Web App deployment and key`);
  }
  return { version: data.version || 'unknown', cohort: data.cohort || 'unknown' };
}

function managerContext(guildId, channelId, userId) {
  const current = findCohort(guildId);
  if (!current) return null;
  if (!current.channels?.supervisor || channelId !== current.channels.supervisor) return null;
  if (!isGlobalManager(userId)) return null;
  return current;
}

function localSupervisorContext(guildId, channelId, userId) {
  const current = findCohort(guildId);
  if (!current?.supervisorIds?.includes(userId)) return null;
  if (!current.channels?.supervisor || channelId !== current.channels.supervisor) return null;
  return current;
}

function cohortOptions({ includeControl = true } = {}) {
  const protectedKey = controlCohort()?.registryKey;
  return cohorts
    .filter(cohort => includeControl || cohort.registryKey !== protectedKey)
    .map(cohort => ({
      label: cohort.name.slice(0, 100),
      description: `Server ${cohort.guildId}${cohort.registryKey === protectedKey ? ' · protected control cohort' : ''}`.slice(0, 100),
      value: cohort.registryKey,
    }));
}

function panelPayload() {
  const control = controlCohort();
  const lines = cohorts.map(cohort => {
    const protectedLabel = cohort.registryKey === control?.registryKey ? ' · protected' : '';
    return `• **${cohort.name}** — server \`${cohort.guildId}\`${protectedLabel}`;
  });
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:add:start`)
      .setLabel('Add cohort')
      .setStyle(ButtonStyle.Success)
      .setDisabled(cohorts.length >= MAX_COHORTS),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:update:start`)
      .setLabel('Update cohort')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:retire:start`)
      .setLabel('Retire cohort')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(cohorts.length <= 1),
  );
  return {
    embeds: [{
      title: `Cohort manager · ${cohorts.length}/${MAX_COHORTS} active`,
      description: [
        ...lines,
        '',
        'Each cohort keeps its own server, Sheet, Apps Script, settings, forms, and reports.',
        `The protected control cohort (${control?.name || 'not configured'}) is intentionally omitted from Retire. Transfer COHORT_CONTROL_KEY and its bootstrap registry in Render before retiring it.`,
        'Backend URLs and keys are intentionally hidden.',
      ].join('\n'),
      color: 0x5865f2,
      footer: { text: 'Retirement stops bot activity only; it never deletes the server or Sheet.' },
    }],
    components: [buttons],
    allowedMentions: { parse: [] },
  };
}

function textInput(id, label, options = {}) {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(options.style || TextInputStyle.Short)
    .setRequired(options.required !== false)
    .setMaxLength(options.maxLength || 1000);
  if (options.placeholder) input.setPlaceholder(options.placeholder);
  if (options.value) input.setValue(options.value);
  return new ActionRowBuilder().addComponents(input);
}

function addModal() {
  return new ModalBuilder()
    .setCustomId(`${PREFIX}:add:submit`)
    .setTitle('Add a cohort')
    .addComponents(
      textInput('name', 'Cohort name', { maxLength: 80, placeholder: 'Example: EJP-14' }),
      textInput('guild', 'Discord server ID', { maxLength: 20 }),
      textInput('supervisors', 'Supervisor user IDs (comma-separated)', { maxLength: 1000 }),
      textInput('url', 'Apps Script Web App /exec URL', { maxLength: 1000 }),
      textInput('key', 'Apps Script secret key', { maxLength: 1000 }),
    );
}

function updateModal(cohort) {
  const control = controlCohort();
  const modal = new ModalBuilder()
    .setCustomId(`${PREFIX}:update:submit:${cohort.registryKey}`)
    .setTitle(`Update ${cohort.name}`.slice(0, 45))
    .addComponents(
      textInput('name', 'Cohort name', { maxLength: 80, value: cohort.name }),
      textInput('supervisors', 'Supervisor user IDs (comma-separated)', {
        maxLength: 1000,
        value: cohort.supervisorIds.join(', '),
      }),
    );
  if (cohort.registryKey !== control?.registryKey) {
    modal.addComponents(
      textInput('url', 'Apps Script Web App /exec URL', { maxLength: 1000, value: cohort.appsScriptUrl }),
      textInput('key', 'Apps Script key (enter current or new)', { maxLength: 1000 }),
    );
  }
  return modal;
}

function selectPayload(action, options) {
  return {
    content: `Choose the cohort to ${action}:`,
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${PREFIX}:${action}:select`)
          .setPlaceholder(`Select a cohort to ${action}`)
          .addOptions(options),
      ),
    ],
    ephemeral: true,
    allowedMentions: { parse: [] },
  };
}

async function validateDiscordGuild(client, guildId) {
  let guild;
  try { guild = await client.guilds.fetch(guildId); }
  catch { throw new Error('The bot is not installed in that Discord server'); }
  const me = guild.members.me || await guild.members.fetchMe();
  if (!me.permissions.has(PermissionsBitField.Flags.Administrator)) {
    throw new Error('The bot role must have Administrator in the new server');
  }
  return guild;
}

function safeError(err) {
  const message = String(err?.message || 'Unknown error');
  return message
    .replace(/https:\/\/script\.google\.com\/\S+/gi, '[Apps Script URL hidden]')
    .replace(/https:\/\/api\.render\.com\/\S+/gi, '[Render deploy hook hidden]')
    .slice(0, 1500);
}

async function saveAndRestart(interaction, entries, successMessage) {
  buildManagedCohorts(entries);
  await saveCurrentCohorts(entries);
  await interaction.editReply({
    content: `${successMessage}\nRestarting JP ADMIN now. It should reconnect within a few minutes.`,
    components: [],
    allowedMentions: { parse: [] },
  });
  try { await triggerDeploy(); }
  catch (err) {
    await interaction.followUp({
      content: `The cohort change was saved, but automatic restart failed: ${safeError(err)}\nUse **Manual Deploy → Deploy latest commit** once in Render.`,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  }
}

async function handleAddSubmit(client, interaction) {
  await interaction.deferReply({ ephemeral: true });
  const name = interaction.fields.getTextInputValue('name').trim();
  const guildId = interaction.fields.getTextInputValue('guild').trim();
  const supervisorIds = parseSupervisorIds(interaction.fields.getTextInputValue('supervisors'));
  const appsScriptUrl = interaction.fields.getTextInputValue('url').trim();
  const apiKey = interaction.fields.getTextInputValue('key').trim();
  if (!supervisorIds.includes(interaction.user.id)) {
    throw new Error('Your own Discord user ID must remain in the supervisor list');
  }
  if (cohorts.length >= MAX_COHORTS) throw new Error(`At most ${MAX_COHORTS} cohorts can be active`);
  await validateDiscordGuild(client, guildId);
  const backend = await checkBackend(appsScriptUrl, apiKey);
  const entry = {
    registryKey: deriveRegistryKey(name),
    name,
    guildId,
    supervisorIds,
    appsScriptUrl,
    apiKey,
    timezone: 'Asia/Dhaka',
    channels: {},
  };
  await saveAndRestart(
    interaction,
    [...cohorts.map(serializeCohort), entry],
    `Added **${name}**. Apps Script ${backend.version} responded successfully.`,
  );
}

async function handleUpdateSubmit(interaction, registryKey) {
  await interaction.deferReply({ ephemeral: true });
  const cohort = cohorts.find(item => item.registryKey === registryKey);
  if (!cohort) throw new Error('That cohort is no longer active');
  const supervisorIds = parseSupervisorIds(interaction.fields.getTextInputValue('supervisors'));
  if (!supervisorIds.includes(interaction.user.id)) {
    throw new Error('Your own Discord user ID must remain in the supervisor list');
  }
  const next = serializeCohort(cohort);
  next.name = interaction.fields.getTextInputValue('name').trim();
  if (registryKey !== controlCohort()?.registryKey) {
    next.appsScriptUrl = interaction.fields.getTextInputValue('url').trim();
    next.apiKey = interaction.fields.getTextInputValue('key').trim();
    await checkBackend(next.appsScriptUrl, next.apiKey);
  }
  next.supervisorIds = supervisorIds;
  const entries = cohorts.map(item => item.registryKey === registryKey ? next : serializeCohort(item));
  await saveAndRestart(interaction, entries, `Updated **${next.name}**.`);
}

async function handleRetireConfirm(interaction, registryKey) {
  await interaction.deferUpdate();
  const control = controlCohort();
  if (registryKey === control?.registryKey) throw new Error(`${control.name} is the protected control cohort and cannot be retired`);
  const retiring = cohorts.find(item => item.registryKey === registryKey);
  if (!retiring) throw new Error('That cohort is no longer active');
  const entries = cohorts.filter(item => item.registryKey !== registryKey).map(serializeCohort);
  await saveAndRestart(
    interaction,
    entries,
    `Retired **${retiring.name}** from JP ADMIN. Its Discord server and Google Sheet were not deleted.`,
  );
}

function supervisorListPayload(cohort) {
  return {
    embeds: [{
      title: `Supervisors — ${cohort.name}`,
      color: 0x5865f2,
      description: cohort.supervisorIds
        .map((id, index) => `${index + 1}. <@${id}> · \`${id}\``)
        .join('\n'),
      footer: { text: 'Add: !supervisor add @user · Remove: !supervisor remove @user' },
    }],
    allowedMentions: { parse: [] },
  };
}

async function handleSupervisorCommand(client, msg, cohort, command) {
  if (command.action === 'list') {
    await msg.channel.send(supervisorListPayload(cohort));
    return;
  }
  if (!controlCohort()) {
    throw new Error('Discord-managed supervisors require COHORT_CONTROL_KEY in the unified Render service.');
  }

  let targetPresent = false;
  if (command.action === 'add') {
    try {
      const targetMember = await msg.guild.members.fetch(command.userId);
      if (targetMember.user.bot) throw new Error('A bot cannot be configured as a supervisor.');
      targetPresent = true;
    } catch (err) {
      if (err?.message === 'A bot cannot be configured as a supervisor.') throw err;
      if (err?.code !== 10007 && err?.status !== 404) throw err;
      // A raw Discord ID can be configured before the person joins. Permission
      // repair will skip them now; membership reconciliation will still exclude
      // that ID immediately when they arrive.
    }
  }

  const change = applySupervisorChange(
    cohort.supervisorIds,
    command.action,
    command.userId,
    msg.author.id,
  );
  if (!change.changed) {
    const state = command.action === 'add' ? 'already a supervisor' : 'not a configured supervisor';
    await msg.reply({ content: `<@${command.userId}> is ${state}.`, allowedMentions: { parse: [] } });
    return;
  }

  const next = serializeCohort(cohort);
  next.supervisorIds = change.ids;
  const entries = cohorts.map(item => item.registryKey === cohort.registryKey ? next : serializeCohort(item));
  buildManagedCohorts(entries);

  await msg.reply({
    content: `Updating **${cohort.name}** supervisors, permissions, and student tracking...`,
    allowedMentions: { parse: [] },
  });
  await saveCurrentCohorts(entries);

  // Apply authorization immediately; the managed-registry restart will rebuild
  // the same array on startup.
  cohort.supervisorIds.splice(0, cohort.supervisorIds.length, ...change.ids);

  const issues = command.action === 'add' && !targetPresent
    ? ['the user has not joined yet; private access will be applied after joining and `!repairpermissions`']
    : [];
  if (command.action === 'remove') {
    try {
      const revoked = await removeStandardSupervisorPermissions(msg.guild, cohort, command.userId);
      if (revoked.failed.length) issues.push(`permission removals failed: ${revoked.failed.join('; ')}`);
    } catch (err) {
      issues.push(`permission removal failed: ${safeError(err)}`);
    }
  }
  try {
    const permissions = await repairAllStandardPermissions(client, cohort, msg.guild);
    if (permissions.failed.length) issues.push(`permission repairs failed: ${permissions.failed.join('; ')}`);
    if (permissions.warnings.length && targetPresent) {
      issues.push(`permission notices: ${permissions.warnings.join('; ')}`);
    }
  } catch (err) {
    issues.push(`permission repair failed: ${safeError(err)}`);
  }

  let rosterResult = null;
  try { rosterResult = await syncMembers(client, cohort); }
  catch (err) { issues.push(`roster resync failed: ${safeError(err)}`); }

  const verb = command.action === 'add' ? 'Added' : 'Removed';
  const tracking = rosterResult
    ? ` Active student tracking now contains ${rosterResult.eligibleMembers} Discord members.`
    : '';
  await msg.channel.send({
    content: [
      `✅ ${verb} <@${command.userId}> ${command.action === 'add' ? 'as' : 'from'} **${cohort.name}** supervisor access.${tracking}`,
      issues.length ? `⚠️ ${issues.join('\n⚠️ ')}` : 'Private/locked channel permissions were reconciled.',
      'Restarting JP ADMIN so every handler and schedule uses the saved supervisor list.',
    ].join('\n'),
    allowedMentions: { parse: [] },
  });

  try { await triggerDeploy(); }
  catch (err) {
    await msg.channel.send({
      content: `The supervisor change is saved and active, but automatic restart failed: ${safeError(err)}\nUse **Manual Deploy → Deploy latest commit** once in Render.`,
      allowedMentions: { parse: [] },
    });
  }
}

module.exports = function registerCohortManager(client) {
  client.on('messageCreate', async msg => {
    if (msg.author.bot) return;
    let supervisorCommand;
    try { supervisorCommand = parseSupervisorCommand(msg.content); }
    catch (err) {
      const cohort = localSupervisorContext(msg.guildId, msg.channelId, msg.author.id);
      if (cohort) await msg.reply({ content: `❌ ${err.message}`, allowedMentions: { parse: [] } });
      return;
    }
    if (supervisorCommand) {
      const cohort = localSupervisorContext(msg.guildId, msg.channelId, msg.author.id);
      if (!cohort) return;
      try { await handleSupervisorCommand(client, msg, cohort, supervisorCommand); }
      catch (err) {
        await msg.reply({ content: `❌ Could not change supervisors: ${safeError(err)}`, allowedMentions: { parse: [] } });
      }
      return;
    }
    if (!/^!(cohorts|cohortmanager)$/i.test(msg.content.trim())) return;
    if (!managerContext(msg.guildId, msg.channelId, msg.author.id)) return;
    try {
      if (!controlCohort()) throw new Error('Set COHORT_CONTROL_KEY once in Render');
      validateDeployHookUrl(process.env.RENDER_DEPLOY_HOOK_URL);
      await msg.channel.send(panelPayload());
    } catch (err) {
      await msg.reply({
        content: `Cohort manager is not ready: ${safeError(err)}`,
        allowedMentions: { parse: [] },
      });
    }
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.customId?.startsWith(`${PREFIX}:`)) return;
    if (!managerContext(interaction.guildId, interaction.channelId, interaction.user.id)) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'This control is private to the authorized cohort manager.', ephemeral: true });
      }
      return;
    }

    try {
      const parts = interaction.customId.split(':');
      const action = parts[1];
      const phase = parts[2];
      if (interaction.isButton() && action === 'add' && phase === 'start') {
        await interaction.showModal(addModal());
        return;
      }
      if (interaction.isButton() && action === 'update' && phase === 'start') {
        await interaction.reply(selectPayload('update', cohortOptions()));
        return;
      }
      if (interaction.isButton() && action === 'retire' && phase === 'start') {
        const options = cohortOptions({ includeControl: false });
        if (!options.length) throw new Error('There is no removable cohort');
        await interaction.reply(selectPayload('retire', options));
        return;
      }
      if (interaction.isStringSelectMenu() && action === 'update' && phase === 'select') {
        const cohort = cohorts.find(item => item.registryKey === interaction.values[0]);
        if (!cohort) throw new Error('That cohort is no longer active');
        await interaction.showModal(updateModal(cohort));
        return;
      }
      if (interaction.isStringSelectMenu() && action === 'retire' && phase === 'select') {
        const cohort = cohorts.find(item => item.registryKey === interaction.values[0]);
        if (!cohort) throw new Error('That cohort is no longer active');
        await interaction.update({
          content: `Retire **${cohort.name}** from this bot?\nThis does not delete its Discord server, Sheet, or Apps Script.`,
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`${PREFIX}:retire:confirm:${cohort.registryKey}`)
                .setLabel(`Retire ${cohort.name}`.slice(0, 80))
                .setStyle(ButtonStyle.Danger),
              new ButtonBuilder()
                .setCustomId(`${PREFIX}:cancel`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Secondary),
            ),
          ],
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (interaction.isButton() && action === 'retire' && phase === 'confirm') {
        await handleRetireConfirm(interaction, parts[3]);
        return;
      }
      if (interaction.isButton() && action === 'cancel') {
        await interaction.update({ content: 'Cancelled.', components: [] });
        return;
      }
      if (interaction.isModalSubmit() && action === 'add' && phase === 'submit') {
        await handleAddSubmit(client, interaction);
        return;
      }
      if (interaction.isModalSubmit() && action === 'update' && phase === 'submit') {
        await handleUpdateSubmit(interaction, parts[3]);
      }
    } catch (err) {
      const payload = {
        content: `Could not change cohorts: ${safeError(err)}`,
        ephemeral: true,
        allowedMentions: { parse: [] },
      };
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  });
};

module.exports.deriveRegistryKey = deriveRegistryKey;
module.exports.applySupervisorChange = applySupervisorChange;
module.exports.isGlobalManager = isGlobalManager;
module.exports.parseSupervisorCommand = parseSupervisorCommand;
module.exports.parseSupervisorIds = parseSupervisorIds;
module.exports.supervisorListPayload = supervisorListPayload;
module.exports.validateDeployHookUrl = validateDeployHookUrl;
