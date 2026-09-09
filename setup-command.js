// ============================================================
//  setup-command.js - !setupserver: one command for a new server
//   1. creates any missing standard channels (needs Admin or
//      Manage Channels) with correct privacy
//   2. re-discovers channel IDs by name
//   3. posts + pins all intro announcements
//   4. records the setup date -> workshop drops/polls and job
//      checks stay silent for 3 days (warm-up)
// ============================================================
const { ChannelType, OverwriteType, PermissionFlagsBits } = require('discord.js');
const { cohorts } = require('./config');
const { discoverChannels } = require('./discover');
const { runAnnounceAll } = require('./announce');
const { setSetupDate } = require('./state');
const { report } = require('./reporter');
const { ensureOnboardingSetup } = require('./onboarding');
const { normalizeChannelName: norm } = require('./channel-names');
const { applyStarterPreset } = require('./automations');
const { syncAutomationChannelVisibility } = require('./channel-visibility');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// name -> { key, privacy }
const STANDARD_CHANNELS = [
  { name: 'welcome-to-the-bootcamp', key: 'welcome', aliases: ['welcome-to-bootcamp', 'bootcamp-welcome', 'welcome'], lockedPosting: true },
  { name: 'rules-and-regulations', key: 'rules', aliases: ['rules-and-regulation', 'rules-regulations', 'server-rules', 'rules'], lockedPosting: true },
  { name: 'discussion', key: 'discussion' },
  { name: 'bot-admin', key: 'supervisor', private: true },
  { name: 'successfully-hired', key: 'hired', lockedPosting: true },
  { name: 'outreach-update', key: 'outreach', aliases: ['outreach-updates', 'outreach'] },
  { name: 'interview-update', key: 'interviewUpdates', aliases: ['interview-updates'] },
  { name: 'communication-workshop', key: 'workshop' },
  { name: 'job-tracking-sheet', key: 'jobTracking', aliases: ['job-tracking'] },
  { name: 'right-to-be-referred', key: 'rtbr', lockedPosting: true },
  { name: 'automation-announcement', key: 'automationLog', lockedPosting: true },
  { name: 'resources', key: 'resources' },
  { name: 'updated-resume', key: 'resumeUpdates', aliases: ['update-resume', 'resume'] },
  { name: 'my-best-projects', key: 'projects', aliases: ['best-projects'] },
  { name: 'job-hunting-channels', key: 'jobHunting', aliases: ['job-hunting-channel', 'job-hunting'] },
  { name: 'warning', key: 'warning', aliases: ['warnings'], lockedPosting: true },
  { name: 'emergency', key: 'emergency', lockedPosting: true },
  { name: 'issues', key: 'issues', aliases: ['issue', 'leave-requests', 'leave-request'] },
  { name: 'eliminated-students', key: 'eliminated', aliases: ['eliminated-student', 'inactive-students'], lockedPosting: true },
];

function permissionOverwrites(spec, guild, client, cohort) {
  const overwrites = [];
  const normalAccess = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
  ];
  if (spec.private) {
    overwrites.push({ id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] });
    for (const sid of cohort.supervisorIds) {
      overwrites.push({ id: sid, type: OverwriteType.Member, allow: normalAccess });
    }
    overwrites.push({ id: client.user.id, type: OverwriteType.Member, allow: normalAccess });
  } else if (spec.lockedPosting) {
    overwrites.push({ id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.SendMessages] });
    for (const sid of cohort.supervisorIds) {
      overwrites.push({
        id: sid,
        type: OverwriteType.Member,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
      });
    }
    overwrites.push({
      id: client.user.id,
      type: OverwriteType.Member,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    });
  }
  return overwrites;
}

async function repairPermissions(channel, spec, guild, client, cohort) {
  const warnings = [];
  for (const overwrite of permissionOverwrites(spec, guild, client, cohort)) {
    const target = await resolveOverwriteTarget(overwrite, guild, client);
    if (!target) {
      warnings.push(`configured supervisor \`${overwrite.id}\` is not currently in this server`);
      continue;
    }
    await channel.permissionOverwrites.edit(target, {
      ViewChannel: overwrite.allow?.includes(PermissionFlagsBits.ViewChannel) ? true :
        overwrite.deny?.includes(PermissionFlagsBits.ViewChannel) ? false : null,
      SendMessages: overwrite.allow?.includes(PermissionFlagsBits.SendMessages) ? true :
        overwrite.deny?.includes(PermissionFlagsBits.SendMessages) ? false : null,
      ReadMessageHistory: overwrite.allow?.includes(PermissionFlagsBits.ReadMessageHistory) ? true : null,
      EmbedLinks: overwrite.allow?.includes(PermissionFlagsBits.EmbedLinks) ? true : null,
      AttachFiles: overwrite.allow?.includes(PermissionFlagsBits.AttachFiles) ? true : null,
    }, {
      type: overwrite.type,
      reason: 'JP ADMIN standard channel permissions',
    });
  }
  return { warnings };
}

async function resolveOverwriteTarget(overwrite, guild, client) {
  if (overwrite.type === OverwriteType.Role) {
    return guild.roles.resolve?.(overwrite.id) ||
      (overwrite.id === guild.roles.everyone.id ? guild.roles.everyone : null);
  }
  if (overwrite.id === client.user.id) return client.user;

  const cached = guild.members.resolve?.(overwrite.id);
  if (cached) return cached.user;
  try {
    const member = await guild.members.fetch(overwrite.id);
    return member.user;
  } catch (err) {
    if (err?.code === 10007 || err?.status === 404) return null;
    throw err;
  }
}

async function filterResolvableOverwrites(overwrites, guild, client) {
  const resolved = [];
  const warnings = [];
  for (const overwrite of overwrites) {
    const target = await resolveOverwriteTarget(overwrite, guild, client);
    if (!target) {
      warnings.push(`configured supervisor \`${overwrite.id}\` is not currently in this server`);
      continue;
    }
    resolved.push(overwrite);
  }
  return { overwrites: resolved, warnings };
}

function findStandardChannel(existing, spec, cohort) {
  const acceptedNames = [spec.name, ...(spec.aliases || [])].map(norm);
  const configuredRaw = cohort.channels?.[spec.key]
    ? existing.get(cohort.channels[spec.key])
    : null;
  const configured = configuredRaw?.type === ChannelType.GuildText ? configuredRaw : null;
  return configured || existing.find(
    c => c && c.type === ChannelType.GuildText && acceptedNames.includes(norm(c.name)),
  );
}

async function repairAllStandardPermissions(client, cohort, guild) {
  const existing = await guild.channels.fetch();
  const repaired = [];
  const failed = [];
  const warnings = new Set();

  for (const spec of STANDARD_CHANNELS.filter(item => item.private || item.lockedPosting)) {
    const channel = findStandardChannel(existing, spec, cohort);
    if (!channel) {
      failed.push(`${spec.name}: channel not found`);
      continue;
    }
    try {
      const result = await repairPermissions(channel, spec, guild, client, cohort);
      result.warnings.forEach(warning => warnings.add(warning));
      cohort.channels[spec.key] = channel.id;
      repaired.push(`#${channel.name}`);
    } catch (err) {
      failed.push(`${channel.name}: ${err.message}`);
    }
  }

  return { repaired, failed, warnings: [...warnings] };
}

async function removeStandardSupervisorPermissions(guild, cohort, supervisorId) {
  const existing = await guild.channels.fetch();
  const removed = [];
  const failed = [];

  for (const spec of STANDARD_CHANNELS.filter(item => item.private || item.lockedPosting)) {
    const channel = findStandardChannel(existing, spec, cohort);
    if (!channel?.permissionOverwrites?.cache?.has(supervisorId)) continue;
    try {
      await channel.permissionOverwrites.delete(
        supervisorId,
        'JP ADMIN supervisor access removed',
      );
      removed.push(`#${channel.name}`);
    } catch (err) {
      failed.push(`${channel.name}: ${err.message}`);
    }
  }

  return { removed, failed };
}

async function ensureStandardChannels(client, cohort, guild) {
  const existing = await guild.channels.fetch();
  const created = [];
  const reused = [];
  const failed = [];
  const permissionWarnings = new Set();
  cohort.channels = cohort.channels || {};

  for (const spec of STANDARD_CHANNELS) {
    const match = findStandardChannel(existing, spec, cohort);
    if (match) {
      cohort.channels[spec.key] = match.id;
      reused.push(`#${match.name} → ${spec.key}`);
      if (spec.private || spec.lockedPosting) {
        try {
          const result = await repairPermissions(match, spec, guild, client, cohort);
          result.warnings.forEach(warning => permissionWarnings.add(warning));
        } catch (err) {
          failed.push(`${match.name} permissions: ${err.message}`);
        }
      }
      continue;
    }

    try {
      const resolution = await filterResolvableOverwrites(
        permissionOverwrites(spec, guild, client, cohort),
        guild,
        client,
      );
      resolution.warnings.forEach(warning => permissionWarnings.add(warning));
      const channel = await guild.channels.create({
        name: spec.name,
        type: ChannelType.GuildText,
        permissionOverwrites: resolution.overwrites.length ? resolution.overwrites : undefined,
      });
      cohort.channels[spec.key] = channel.id;
      existing.set(channel.id, channel);
      created.push(spec.name);
      await sleep(600);
    } catch (err) {
      failed.push(`${spec.name}: ${err.message}`);
    }
  }

  await discoverChannels(client);
  return { created, reused, failed, permissionWarnings: [...permissionWarnings] };
}

module.exports = function registerSetup(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const command = msg.content.trim().toLowerCase();
    if (!['!setupserver', '!ensurechannels', '!repairpermissions'].includes(command)) return;
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;

    if (command === '!repairpermissions') {
      if (!cohort.channels?.supervisor || msg.channelId !== cohort.channels.supervisor) {
        await msg.reply({
          content: '❌ Run `!repairpermissions` in the configured private `#bot-admin` channel.',
          allowedMentions: { parse: [] },
        });
        return;
      }

      await msg.reply({
        content: '🔐 Repairing standard channel permission overwrites...',
        allowedMentions: { parse: [] },
      });
      const result = await repairAllStandardPermissions(client, cohort, msg.guild);
      await msg.channel.send({
        embeds: [{
          title: `🔐 Permission Repair — ${cohort.name}`,
          color: result.failed.length ? 0xe67e22 : 0x2ecc71,
          fields: [
            {
              name: `✅ Repaired (${result.repaired.length})`,
              value: result.repaired.length ? result.repaired.join('\n') : '— none',
            },
            ...(result.failed.length ? [{
              name: `⚠️ Failed (${result.failed.length})`,
              value: result.failed.join('\n').slice(0, 1024),
            }] : []),
            ...(result.warnings.length ? [{
              name: `ℹ️ Skipped absent supervisors (${result.warnings.length})`,
              value: result.warnings.join('\n').slice(0, 1024),
            }] : []),
          ],
          footer: { text: 'Next: !checkperms → !doctor' },
        }],
        allowedMentions: { parse: [] },
      });
      report(cohort.name, `Permission repair completed (${result.repaired.length} repaired, ${result.failed.length} failed)`);
      return;
    }

    if (command === '!ensurechannels') {
      await msg.reply({
        content: '🛠 Ensuring standard channels and permission overwrites without reposting announcements...',
        allowedMentions: { parse: [] },
      });
      try {
        const result = await ensureStandardChannels(client, cohort, msg.guild);
        await msg.channel.send({
          embeds: [{
            title: `🛠 Channel Check Complete — ${cohort.name}`,
            color: result.failed.length ? 0xe67e22 : 0x2ecc71,
            fields: [
              { name: `Created (${result.created.length})`, value: result.created.length ? result.created.map(name => `#${name}`).join('\n') : '— none' },
              { name: `Reused (${result.reused.length})`, value: result.reused.length ? result.reused.join('\n').slice(0, 1024) : '— none' },
              ...(result.permissionWarnings.length ? [{ name: 'Permission notices', value: result.permissionWarnings.join('\n').slice(0, 1024) }] : []),
              ...(result.failed.length ? [{ name: `Failed (${result.failed.length})`, value: result.failed.join('\n').slice(0, 1024) }] : []),
            ],
            footer: { text: 'No announcements were reposted and no warm-up date was changed.' },
          }],
          allowedMentions: { parse: [] },
        });
        report(cohort.name, `Channel check completed (${result.created.length} created, ${result.failed.length} failed)`);
      } catch (err) {
        await msg.reply({
          content: `❌ Channel check failed: ${err.message}`,
          allowedMentions: { parse: [] },
        });
      }
      return;
    }

    await msg.reply('🛠 Setting up this server: channels → discovery → announcements → warm-up timer...');

    try {
      const guild = msg.guild;
      const ensured = await ensureStandardChannels(client, cohort, guild);
      const { created, reused, failed } = ensured;
      const permissionWarnings = new Set(ensured.permissionWarnings);
      const today = new Date().toLocaleDateString('en-CA', { timeZone: cohort.timezone });
      await setSetupDate(cohort, today);       // start the 3-day warm-up
      let starter = 'Not applied';
      try {
        const preset = await applyStarterPreset(cohort);
        const visibility = await syncAutomationChannelVisibility(client, cohort, preset.states);
        starter = `attendance, jobs, contentsync active; ${visibility.updated.length} workflow channel(s) synchronized`;
        if (preset.failures.length) failed.push(...preset.failures.map(item => `starter switch: ${item}`));
        if (visibility.failed.length) failed.push(...visibility.failed.map(item => `visibility: ${item}`));
      } catch (err) {
        starter = `⚠️ ${err.message}`;
        failed.push('starter preset: ' + err.message);
      }
      const announced = await runAnnounceAll(client, cohort); // intro posts + pins
      let onboarding = 'Not configured';
      try {
        const ready = await ensureOnboardingSetup(client, cohort);
        onboarding = `Ready: [welcome panel](${ready.panel.url}) · [rules](${ready.rulesMessage.url})`;
      } catch (err) {
        onboarding = `⚠️ ${err.message}`;
        failed.push('onboarding: ' + err.message);
      }

      await msg.channel.send({
        embeds: [{
          title: `🛠 Server Setup Complete — ${cohort.name}`,
          color: failed.length ? 0xe67e22 : 0x2ecc71,
          fields: [
            { name: `📁 Channels created (${created.length})`, value: created.length ? created.map(c => `• #${c}`).join('\n') : '— all existed already' },
            { name: `♻️ Template channels reused (${reused.length})`, value: reused.length ? reused.join('\n').slice(0, 1024) : '— none' },
            { name: `📣 Announcements posted`, value: String(announced) },
            { name: '🧰 Starter automation preset', value: starter },
            { name: '👋 Welcome onboarding', value: onboarding },
            { name: '⏳ Warm-up', value: 'Attendance, job tracking, roster/intake syncing, and manual supervisor commands are ready. Noisy student programmes stay held until a mentor starts them.' },
            ...(permissionWarnings.size ? [{ name: 'ℹ️ Permission notices', value: [...permissionWarnings].join('\n').slice(0, 1024) }] : []),
            ...(failed.length ? [{ name: '⚠️ Failed', value: failed.join('\n').slice(0, 1024) }] : []),
          ],
          footer: { text: 'Next: !syncmembers → !audit → !checkperms' },
        }],
      });
      report(cohort.name, `Server setup completed (${created.length} channels created)`);
    } catch (err) {
      await msg.reply('❌ Setup failed: ' + err.message + '\nMake sure the bot has Administrator (or Manage Channels + Manage Roles).');
    }
  });
};

module.exports.permissionOverwrites = permissionOverwrites;
module.exports.repairPermissions = repairPermissions;
module.exports.repairAllStandardPermissions = repairAllStandardPermissions;
module.exports.removeStandardSupervisorPermissions = removeStandardSupervisorPermissions;
module.exports.resolveOverwriteTarget = resolveOverwriteTarget;
module.exports.ensureStandardChannels = ensureStandardChannels;
