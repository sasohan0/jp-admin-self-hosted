'use strict';

const {
  ChannelType,
  OverwriteType,
  PermissionFlagsBits,
} = require('discord.js');
const { cohorts } = require('./config');
const { appsScriptGet, appsScriptPost } = require('./apps-script-api');
const { normalizeChannelName } = require('./channel-names');

const CHANNEL_NAME = 'group-activities';
const IDENTITY_PREFIX = 'Bootcamp · ';

function isIdentityRoleName(name) {
  return String(name || '').startsWith(IDENTITY_PREFIX);
}

function stateKey(cohort) {
  return `group_activities_v1_${cohort.guildId}`;
}

async function loadState(cohort) {
  const data = await appsScriptGet(cohort, { action: 'getstate', k: stateKey(cohort) }, {
    label: 'Group activities state',
  });
  try {
    const parsed = JSON.parse(data.value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

async function saveState(cohort, state) {
  await appsScriptPost(cohort, {
    action: 'setState', k: stateKey(cohort), v: JSON.stringify(state),
  }, { idempotent: true, label: 'Group activities state write' });
}

async function ensureChannel(client, cohort, guild) {
  await guild.channels.fetch();
  let channel = guild.channels.cache.get(cohort.channels?.groupActivities) ||
    guild.channels.cache.find(item => item.type === ChannelType.GuildText &&
      normalizeChannelName(item.name) === CHANNEL_NAME);
  if (!channel) {
    channel = await guild.channels.create({
      name: CHANNEL_NAME,
      type: ChannelType.GuildText,
      topic: 'Private identity-team threads for outreach research, regional IT connections, mock interviews, and problem solving.',
      reason: 'JP ADMIN group activities workspace',
    });
  }
  const botMember = guild.members.me || await guild.members.fetchMe();
  await channel.permissionOverwrites.edit(guild.roles.everyone, {
    ViewChannel: true,
    SendMessages: false,
    CreatePublicThreads: false,
    CreatePrivateThreads: false,
    SendMessagesInThreads: true,
    ReadMessageHistory: true,
  }, { type: OverwriteType.Role, reason: 'Private team threads only' });
  await channel.permissionOverwrites.edit(botMember, {
    ViewChannel: true,
    SendMessages: true,
    CreatePrivateThreads: true,
    ManageThreads: true,
    SendMessagesInThreads: true,
    ReadMessageHistory: true,
  }, { type: OverwriteType.Member, reason: 'JP ADMIN group activities management' });
  for (const supervisorId of cohort.supervisorIds) {
    const supervisor = await guild.members.fetch(supervisorId).catch(() => null);
    if (!supervisor) continue;
    await channel.permissionOverwrites.edit(supervisor, {
      ViewChannel: true,
      SendMessages: true,
      ManageThreads: true,
      SendMessagesInThreads: true,
      ReadMessageHistory: true,
    }, { type: OverwriteType.Member, reason: 'Supervisor group activities access' });
  }
  cohort.channels.groupActivities = channel.id;
  return channel;
}

async function findOrCreateThread(channel, role, savedId) {
  let thread = savedId ? await channel.threads.fetch(savedId).catch(() => null) : null;
  if (!thread) {
    await channel.threads.fetchActive().catch(() => null);
    thread = channel.threads.cache.find(item => item.name === role.name) || null;
  }
  if (!thread) {
    thread = await channel.threads.create({
      name: role.name.slice(0, 100),
      type: ChannelType.PrivateThread,
      autoArchiveDuration: 10080,
      invitable: false,
      reason: `JP ADMIN identity-team workspace for ${role.name}`,
    });
    await thread.send({
      content: [
        `## ${role.name} — Group Activities`,
        'Use this private team space for:',
        '• finding companies and planning professional outreach',
        '• sharing regional IT-company knowledge and useful connections',
        '• inter-group mock-interview preparation and competitions',
        '• collaborative problem solving, project review, and future team activities',
        '',
        'Keep personal contact data private and follow the server rules.',
      ].join('\n'),
      allowedMentions: { parse: [] },
    });
  } else if (thread.archived) {
    await thread.setArchived(false, 'JP ADMIN group activities sync');
  }
  return thread;
}

async function syncGroupActivities(client, cohort, guild) {
  await Promise.all([guild.roles.fetch(), guild.members.fetch()]);
  const channel = await ensureChannel(client, cohort, guild);
  const state = await loadState(cohort);
  state.threads = state.threads && typeof state.threads === 'object' ? state.threads : {};
  const roles = [...guild.roles.cache.values()]
    .filter(role => isIdentityRoleName(role.name) && role.members.some(member =>
      !member.user.bot && !cohort.supervisorIds.includes(member.id)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const details = [];
  for (const role of roles) {
    const thread = await findOrCreateThread(channel, role, state.threads[role.id]);
    const desired = new Set([
      ...role.members.filter(member => !member.user.bot).keys(),
      ...cohort.supervisorIds.filter(id => guild.members.cache.has(id)),
    ]);
    const current = await thread.members.fetch().catch(() => null);
    if (current) {
      for (const member of current.values()) {
        if (member.id === client.user.id || desired.has(member.id)) continue;
        await thread.members.remove(member.id, 'No longer in this identity team').catch(() => {});
      }
    }
    for (const memberId of desired) {
      await thread.members.add(memberId, `Member of ${role.name}`).catch(() => {});
    }
    state.threads[role.id] = thread.id;
    details.push({ roleId: role.id, roleName: role.name, threadId: thread.id, members: desired.size });
  }
  state.channelId = channel.id;
  state.updatedAt = new Date().toISOString();
  await saveState(cohort, state);
  return { channel, details };
}

module.exports = function registerGroupActivities(client) {
  client.on('messageCreate', async message => {
    if (message.author.bot) return;
    const match = message.content.trim().match(/^!groupactivities(?:\s+(setup|sync|status))?$/i);
    if (!match) return;
    const cohort = cohorts.find(item => item.guildId === message.guildId);
    if (!cohort || !cohort.supervisorIds.includes(message.author.id)) return;
    if (message.channelId !== cohort.channels.supervisor) {
      return message.reply(`Run this private command in <#${cohort.channels.supervisor}>.`);
    }
    const action = (match[1] || 'status').toLowerCase();
    try {
      if (action === 'status') {
        const state = await loadState(cohort);
        const count = Object.keys(state.threads || {}).length;
        return message.reply({
          content: `Group activities: ${state.channelId ? `<#${state.channelId}>` : 'not set up'} · mapped private team threads: **${count}**.`,
          allowedMentions: { parse: [] },
        });
      }
      await message.reply('⏳ Creating/reusing the group activities channel and syncing private threads from identity-region roles...');
      const result = await syncGroupActivities(client, cohort, message.guild);
      const lines = result.details.map(item => `• <@&${item.roleId}> → <#${item.threadId}> (${item.members} members)`);
      return message.channel.send({
        content: [
          `✅ **Group activities ready:** <#${result.channel.id}>`,
          lines.length ? lines.join('\n') : 'No populated identity-region roles exist yet. Complete/finalize onboarding, then run `!groupactivities sync`.',
        ].join('\n').slice(0, 1950),
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      return message.reply(`❌ Group activities failed: ${String(error.message).slice(0, 300)}`);
    }
  });
};

module.exports.CHANNEL_NAME = CHANNEL_NAME;
module.exports.IDENTITY_PREFIX = IDENTITY_PREFIX;
module.exports.isIdentityRoleName = isIdentityRoleName;
module.exports.syncGroupActivities = syncGroupActivities;
