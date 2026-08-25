'use strict';

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  OverwriteType,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} = require('discord.js');
const { cohorts } = require('./config');
const { appsScriptGet, appsScriptPost } = require('./apps-script-api');
const { getRoster } = require('./roster');
const { isOn } = require('./automations');
const { isScheduledToday } = require('./scheduler');
const { scheduleAtSetting, scheduleEveryMinute } = require('./runtime-schedule');
const { getSetting, setSetting } = require('./settings');
const { normalizeChannelName } = require('./channel-names');
const { appealButton, notifyRestriction } = require('./appeals');
const {
  attendanceWindowUtcBounds,
  discordSnowflakeAt,
  firstQualifyingMessages,
  isChannelWindowOpen,
  isVerifiedDawnEmail,
  localDateKey,
  localMinutes,
  membershipTransition,
  parseAttendanceWindow,
  parseChannelWindow,
} = require('./dawn-attendance');

const ROLE_NAME = 'Dawn Focus Circle';
const CHANNEL_NAME = 'dawn-focus-circle';
const LIMITS = { medical: 2, exam: 2, recommit: 1 };
const queues = new Map();
const appliedWindows = new Map();
const configCache = new Map();
const setupPromises = new Map();
const memberLoadPromises = new Map();
const memberCacheReady = new Set();
const CONFIG_CACHE_MS = 30 * 60 * 1000;
const DEFAULT_ATTENDANCE_WINDOW = '05:00-07:00';

function shiftDateKey(key, days) {
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekStartKey(dateKey) {
  const day = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return shiftDateKey(dateKey, -day);
}

function isDawnAttendanceDay(timezone, value = new Date()) {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(value);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu'].includes(day);
}

function profileStateKey(cohort) {
  return `dawn_profiles_v1_${cohort.guildId}`;
}

function checkinStateKey(cohort, dateKey) {
  return `dawn_checkins_v1_${cohort.guildId}_${weekStartKey(dateKey)}`;
}

function configStateKey(cohort) {
  return `dawn_config_v1_${cohort.guildId}`;
}

async function getState(cohort, key) {
  const data = await appsScriptGet(cohort, { action: 'getstate', k: key }, { label: 'Dawn Focus state' });
  return String(data.value || '');
}

async function setState(cohort, key, value) {
  await appsScriptPost(cohort, { action: 'setState', k: key, v: String(value) }, {
    idempotent: true,
    label: 'Dawn Focus state write',
  });
}

async function dawnConfig(cohort) {
  const cached = configCache.get(cohort.guildId);
  if (cached && Date.now() - cached.at < CONFIG_CACHE_MS) return { ...cached.value,
    legacyChannelIds: [...cached.value.legacyChannelIds] };
  const config = parseJson(await getState(cohort, configStateKey(cohort)), {});
  config.channelId = String(config.channelId || '');
  config.legacyChannelIds = Array.isArray(config.legacyChannelIds)
    ? [...new Set(config.legacyChannelIds.map(String).filter(Boolean))]
    : [];
  configCache.set(cohort.guildId, { at: Date.now(), value: config });
  return { ...config, legacyChannelIds: [...config.legacyChannelIds] };
}

async function saveDawnConfig(cohort, config) {
  const value = {
    channelId: String(config.channelId || ''),
    legacyChannelIds: [...new Set((config.legacyChannelIds || []).map(String).filter(Boolean))],
  };
  await setState(cohort, configStateKey(cohort), JSON.stringify(value));
  configCache.set(cohort.guildId, { at: Date.now(), value });
}

async function dawnAttendanceWindow(cohort) {
  return parseAttendanceWindow(await getSetting(cohort, 'dawnattendancewindow')) ||
    parseAttendanceWindow(DEFAULT_ATTENDANCE_WINDOW);
}

function parseJson(raw, fallback) {
  try {
    const value = JSON.parse(raw || '');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  } catch { return fallback; }
}

async function profiles(cohort) {
  const state = parseJson(await getState(cohort, profileStateKey(cohort)), { members: {} });
  state.members = state.members && typeof state.members === 'object' ? state.members : {};
  return state;
}

async function updateProfiles(cohort, updater) {
  return enqueue(cohort, async () => {
    const state = await profiles(cohort);
    const result = await updater(state);
    await setState(cohort, profileStateKey(cohort), JSON.stringify(state));
    return result;
  });
}

function defaultProfile(existing = {}) {
  return {
    status: existing.status || 'active',
    missed: Number(existing.missed) || 0,
    missedDates: Array.isArray(existing.missedDates)
      ? existing.missedDates.map(String).filter(Boolean).slice(-3)
      : [],
    pending: Boolean(existing.pending),
    appealRequired: Boolean(existing.appealRequired),
    lastReviewedDate: String(existing.lastReviewedDate || ''),
    everJoined: Boolean(existing.everJoined),
    rolePresent: typeof existing.rolePresent === 'boolean' ? existing.rolePresent : null,
    lastMembershipEvent: existing.lastMembershipEvent && typeof existing.lastMembershipEvent === 'object'
      ? existing.lastMembershipEvent
      : null,
    permits: {
      medical: Number(existing.permits?.medical) || 0,
      exam: Number(existing.permits?.exam) || 0,
      recommit: Number(existing.permits?.recommit) || 0,
    },
  };
}

async function dawnStudent(cohort, member) {
  const roster = await getRoster(cohort, true);
  return roster.find(student => student.discordId === member.id) || null;
}

async function recordMembershipEvent(cohort, member, isMember, options = {}) {
  const dateKey = options.dateKey || localDateKey(cohort.timezone);
  const outcome = await updateProfiles(cohort, state => {
    const profile = defaultProfile(state.members[member.id]);
    let transition = membershipTransition(profile, isMember, dateKey);
    if (!transition.changed && options.bootstrap && isMember && !profile.lastMembershipEvent) {
      transition = { changed: true, event: profile.everJoined ? 'Rejoined' : 'Joined', everJoined: true,
        rolePresent: true, status: 'active', date: dateKey };
    }
    if (!transition.changed) return { changed: false };
    profile.everJoined = transition.everJoined;
    profile.rolePresent = transition.rolePresent;
    profile.status = transition.status;
    profile.pending = false;
    profile.appealRequired = !isMember && options.appealRequired !== false;
    if (isMember) {
      profile.missed = 0;
      profile.missedDates = [];
    }
    profile.lastMembershipEvent = { date: dateKey, event: transition.event };
    state.members[member.id] = profile;
    return { changed: true, event: transition.event, date: dateKey };
  });
  if (!outcome.changed) return outcome;
  const student = await dawnStudent(cohort, member);
  if (!student?.email) {
    const supervisor = await member.guild.channels.fetch(cohort.channels.supervisor).catch(() => null);
    await supervisor?.send({
      content: `⚠️ Dawn membership changed for <@${member.id}>, but no verified email is available. Run \`!completionreminder\` or correct the private profile, then toggle/re-add the role.`,
      allowedMentions: { parse: [] },
    }).catch(() => {});
    return { ...outcome, sheetSaved: false };
  }
  await appsScriptPost(cohort, {
    action: 'saveDawnMembershipEvent',
    date: dateKey,
    event: outcome.event,
    entry: {
      discordId: member.id,
      displayName: student.name || member.displayName,
      email: student.email,
      phone: student.phone || '',
    },
  }, { idempotent: true, label: 'Dawn membership lifecycle' });
  return { ...outcome, sheetSaved: true };
}

async function syncDawnRoleMembers(cohort, guild, role) {
  return enqueue(cohort, async () => {
    const today = localDateKey(cohort.timezone);
    const [state, roster] = await Promise.all([profiles(cohort), getRoster(cohort, true)]);
    const studentById = new Map(roster.filter(student => student.discordId)
      .map(student => [String(student.discordId), student]));
    const activeMembers = [...role.members.values()].filter(member =>
      !member.user.bot && !cohort.supervisorIds.includes(member.id));
    const activeIds = new Set(activeMembers.map(member => member.id));
    const entries = [];
    const missing = [];
    let joined = 0;
    let rejoined = 0;
    let removed = 0;

    for (const member of activeMembers) {
      const profile = defaultProfile(state.members[member.id]);
      let transition = membershipTransition(profile, true, today);
      if (!transition.changed && !profile.lastMembershipEvent) {
        transition = {
          changed: true,
          event: profile.everJoined ? 'Rejoined' : 'Joined',
          everJoined: true,
          rolePresent: true,
          status: 'active',
          date: today,
        };
      }
      if (transition.changed) {
        profile.everJoined = true;
        profile.rolePresent = true;
        profile.status = 'active';
        profile.pending = false;
        profile.appealRequired = false;
        profile.missed = 0;
        profile.missedDates = [];
        profile.lastMembershipEvent = { date: transition.date, event: transition.event };
        if (transition.event === 'Rejoined') rejoined++;
        else joined++;
      }
      state.members[member.id] = profile;
      const student = studentById.get(member.id);
      if (!student?.email) {
        missing.push({ id: member.id, name: member.displayName });
        continue;
      }
      if (!isVerifiedDawnEmail(student.email)) {
        missing.push({ id: member.id, name: student.name || member.displayName });
      }
      entries.push({
        discordId: member.id,
        displayName: student.name || member.displayName,
        email: student.email,
        phone: student.phone || '',
        event: transition.changed ? transition.event : '',
        eventDate: transition.changed ? transition.date : '',
      });
    }
    const matchedActive = entries.length;

    // Reconcile role removals that happened while the bot was offline. This
    // never deletes a historical row; it adds one lifecycle marker when the
    // previous durable profile still says the role was present.
    for (const [discordId, rawProfile] of Object.entries(state.members)) {
      if (activeIds.has(discordId)) continue;
      const profile = defaultProfile(rawProfile);
      if (profile.rolePresent !== true) continue;
      const transition = membershipTransition(profile, false, today);
      if (!transition.changed) continue;
      profile.everJoined = true;
      profile.rolePresent = false;
      profile.status = 'removed';
      profile.pending = false;
      profile.appealRequired = true;
      profile.lastMembershipEvent = { date: today, event: 'Removed' };
      state.members[discordId] = profile;
      removed++;
      const student = studentById.get(discordId);
      if (!student?.email) {
        missing.push({ id: discordId, name: guild.members.cache.get(discordId)?.displayName || discordId });
        continue;
      }
      if (!isVerifiedDawnEmail(student.email)) {
        missing.push({ id: discordId, name: student.name || guild.members.cache.get(discordId)?.displayName || discordId });
      }
      entries.push({
        discordId,
        displayName: student.name || guild.members.cache.get(discordId)?.displayName || discordId,
        email: student.email,
        phone: student.phone || '',
        event: 'Removed',
        eventDate: today,
      });
    }

    const sheet = await appsScriptPost(cohort, {
      action: 'syncDawnMembers',
      date: today,
      guildId: cohort.guildId,
      entries,
    }, { idempotent: true, label: 'Dawn member sync' });
    await setState(cohort, profileStateKey(cohort), JSON.stringify(state));
    return {
      roleMembers: activeMembers.length,
      matched: matchedActive,
      missing,
      joined,
      rejoined,
      removed,
      sheet,
    };
  });
}

function enqueue(cohort, task) {
  const previous = queues.get(cohort.guildId) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  const tracked = next.finally(() => {
    if (queues.get(cohort.guildId) === tracked) queues.delete(cohort.guildId);
  });
  queues.set(cohort.guildId, tracked);
  return next;
}

function findRole(guild) {
  return guild.roles.cache.find(role => role.name.toLowerCase() === ROLE_NAME.toLowerCase()) || null;
}

function findTextChannel(guild, cohort, config = {}) {
  const candidates = [config.channelId, cohort.channels?.discipline].filter(Boolean);
  for (const id of candidates) {
    const channel = guild.channels.cache.get(id);
    if (channel?.type === ChannelType.GuildText) return channel;
  }
  return guild.channels.cache.find(channel =>
    channel.type === ChannelType.GuildText && normalizeChannelName(channel.name) === CHANNEL_NAME) || null;
}

function legacyDawnChannels(guild, cohort, config, textChannel) {
  const ids = new Set(config.legacyChannelIds || []);
  if (cohort.channels?.discipline && cohort.channels.discipline !== textChannel?.id) {
    ids.add(cohort.channels.discipline);
  }
  for (const channel of guild.channels.cache.values()) {
    const normalized = normalizeChannelName(channel.name);
    if (channel.id !== textChannel?.id &&
        (normalized === CHANNEL_NAME || normalized === `${CHANNEL_NAME}-archive`)) ids.add(channel.id);
  }
  return [...ids].map(id => guild.channels.cache.get(id)).filter(Boolean);
}

async function clearLegacyMemberDenials(channel, role, supervisors) {
  for (const member of role.members.values()) {
    if (supervisors.includes(member.id)) continue;
    const overwrite = channel.permissionOverwrites.cache.get(member.id);
    if (!overwrite?.deny.has(PermissionFlagsBits.SendMessages)) continue;
    await channel.permissionOverwrites.edit(member, { SendMessages: null }, {
      type: OverwriteType.Member,
      reason: 'Remove obsolete per-student Dawn check-in lockout',
    }).catch(() => {});
  }
}

async function ensureGuildMemberCache(guild) {
  if (memberCacheReady.has(guild.id)) return;
  if (memberLoadPromises.has(guild.id)) return memberLoadPromises.get(guild.id);
  const pending = guild.members.list({ limit: 1000 }).then(() => {
    memberCacheReady.add(guild.id);
  }).finally(() => {
    if (memberLoadPromises.get(guild.id) === pending) memberLoadPromises.delete(guild.id);
  });
  memberLoadPromises.set(guild.id, pending);
  return pending;
}

async function ensureDawnSetupInner(client, cohort, guild) {
  await guild.roles.fetch();
  await guild.channels.fetch();
  await ensureGuildMemberCache(guild);
  let role = findRole(guild);
  if (!role) {
    role = await guild.roles.create({ name: ROLE_NAME, color: 0xf1c40f, reason: 'JP ADMIN Dawn Focus Circle' });
  }
  const config = await dawnConfig(cohort);
  let channel = findTextChannel(guild, cohort, config);
  let legacyChannels = legacyDawnChannels(guild, cohort, config, channel);
  for (const legacy of legacyChannels) {
    if (legacy.type === ChannelType.GuildText) continue;
    if (normalizeChannelName(legacy.name) === CHANNEL_NAME) {
      await legacy.edit({ name: `${CHANNEL_NAME}-archive` },
        'Replace threads-only Dawn channel with a text channel').catch(() => {});
    }
  }
  if (!channel) {
    channel = await guild.channels.create({
      name: CHANNEL_NAME,
      type: ChannelType.GuildText,
      topic: 'Morning accountability, focused study, exclusive workshops, AI learning, and resource sharing.',
      permissionOverwrites: [
        { id: guild.roles.everyone.id, type: OverwriteType.Role,
          deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.CreatePublicThreads,
            PermissionFlagsBits.CreatePrivateThreads, PermissionFlagsBits.SendMessagesInThreads] },
        { id: role.id, type: OverwriteType.Role,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory],
          deny: [PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads,
            PermissionFlagsBits.SendMessagesInThreads] },
        { id: client.user.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory] },
      ],
      reason: 'JP ADMIN Dawn Focus Circle',
    });
  }
  if (/^6:00\s*[–-]\s*7:00 AM accountability/i.test(String(channel.topic || ''))) {
    await channel.edit({ topic: 'Morning accountability, focused study, exclusive workshops, AI learning, and resource sharing.' },
      'Replace legacy fixed Dawn attendance topic').catch(() => {});
  }
  legacyChannels = legacyDawnChannels(guild, cohort, config, channel);
  await channel.permissionOverwrites.edit(guild.roles.everyone, {
    ViewChannel: false,
    CreatePublicThreads: false,
    CreatePrivateThreads: false,
    SendMessagesInThreads: false,
  }, {
    type: OverwriteType.Role,
    reason: 'JP ADMIN Dawn Focus privacy',
  });
  const window = parseChannelWindow(await getSetting(cohort, 'dawnchannelwindow')) ||
    parseChannelWindow('always');
  const open = isChannelWindowOpen(window, localMinutes(cohort.timezone));
  await channel.permissionOverwrites.edit(role, {
    ViewChannel: true,
    SendMessages: open,
    ReadMessageHistory: true,
    CreatePublicThreads: false,
    CreatePrivateThreads: false,
    SendMessagesInThreads: false,
  }, { type: OverwriteType.Role, reason: 'JP ADMIN Dawn Focus member access' });
  const botMember = guild.members.me || await guild.members.fetchMe();
  await channel.permissionOverwrites.edit(botMember, {
    ViewChannel: true, SendMessages: true, ManageMessages: true, ManageThreads: true,
    ReadMessageHistory: true,
  }, { type: OverwriteType.Member, reason: 'JP ADMIN Dawn Focus bot access' });
  for (const supervisorId of cohort.supervisorIds) {
    const supervisor = await guild.members.fetch(supervisorId).catch(() => null);
    if (!supervisor) continue;
    await channel.permissionOverwrites.edit(supervisor, {
      ViewChannel: true, SendMessages: true, ManageMessages: true, ReadMessageHistory: true,
    }, { type: OverwriteType.Member, reason: 'JP ADMIN Dawn Focus supervisor access' });
  }
  await clearLegacyMemberDenials(channel, role, cohort.supervisorIds);
  for (const legacy of legacyChannels) {
    await legacy.permissionOverwrites.edit(role, {
      ViewChannel: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      SendMessagesInThreads: false,
    }, { type: OverwriteType.Role, reason: 'Archive replaced Dawn threads-only channel' }).catch(() => {});
  }
  const nextConfig = { channelId: channel.id, legacyChannelIds: legacyChannels.map(item => item.id) };
  if (config.channelId !== nextConfig.channelId ||
      JSON.stringify(config.legacyChannelIds) !== JSON.stringify(nextConfig.legacyChannelIds)) {
    await saveDawnConfig(cohort, nextConfig);
  }
  cohort.channels.discipline = channel.id;
  appliedWindows.set(cohort.guildId, `${channel.id}:${window.label}:${open}`);
  return { role, channel, legacyChannels, window, open };
}

async function ensureDawnSetup(client, cohort, guild) {
  if (setupPromises.has(cohort.guildId)) return setupPromises.get(cohort.guildId);
  const pending = ensureDawnSetupInner(client, cohort, guild).finally(() => {
    if (setupPromises.get(cohort.guildId) === pending) setupPromises.delete(cohort.guildId);
  });
  setupPromises.set(cohort.guildId, pending);
  return pending;
}

async function applyChannelWindowAccess(client, cohort, force = false) {
  const guild = client.guilds.cache.get(cohort.guildId);
  if (!guild) return null;
  const config = await dawnConfig(cohort);
  const role = findRole(guild);
  const channel = findTextChannel(guild, cohort, config);
  if (!role || !channel) return null;
  const window = parseChannelWindow(await getSetting(cohort, 'dawnchannelwindow')) ||
    parseChannelWindow('always');
  const open = isChannelWindowOpen(window, localMinutes(cohort.timezone));
  const token = `${channel.id}:${window.label}:${open}`;
  if (!force && appliedWindows.get(cohort.guildId) === token) {
    return { role, channel, window, open, changed: false };
  }
  await channel.permissionOverwrites.edit(role, {
    ViewChannel: true,
    SendMessages: open,
    ReadMessageHistory: true,
    CreatePublicThreads: false,
    CreatePrivateThreads: false,
    SendMessagesInThreads: false,
  }, { type: OverwriteType.Role, reason: `Dawn channel window ${window.label}` });
  appliedWindows.set(cohort.guildId, token);
  return { role, channel, window, open, changed: true };
}

function enrollmentPayload(cohort, attendanceWindow = parseAttendanceWindow(DEFAULT_ATTENDANCE_WINDOW)) {
  return {
    content: '@everyone',
    embeds: [{
      title: '🌅 Join the Dawn Focus Circle',
      color: 0xf1c40f,
      description: [
        `Build discipline by checking in during **${attendanceWindow.label}, Sunday-Thursday**. Messages outside that window do not count as attendance. The channel itself stays open unless a mentor sets a separate sending window.`,
        '',
        '**Members receive:**',
        '• exclusive communication workshops and mock-interview practice',
        '• AI learning and knowledge-sharing sessions',
        '• curated technical, project, interview, and career resources',
        '• a focused hour for technical questions, project study, and deliberate practice',
        '• an accountability group committed to better time utilization',
        '',
        '**Terms:** Check in honestly during the one-hour window. Missing three consecutive scheduled check-ins requires a private reason survey. Each member has 2 medical-emergency permits, 2 exam permits, and 1 recommitment permit. When a required survey is ignored or matching permits are exhausted, access is removed. Rejoining then requires a private appeal and mentor approval.',
        '',
        '**Allah is watching. Be truthful about your check-ins, situation, causes, and permit use.**',
      ].join('\n'),
      footer: { text: `${cohort.name} · Participation is optional; commitment after joining is expected.` },
    }],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`dawn:review:${cohort.guildId}`).setLabel('Review terms and join').setStyle(ButtonStyle.Success),
    )],
    allowedMentions: { parse: ['everyone'] },
  };
}

async function saveCheckedIds(cohort, userIds, dateKey) {
  return enqueue(cohort, async () => {
    const key = checkinStateKey(cohort, dateKey);
    const week = parseJson(await getState(cohort, key), {});
    const ids = new Set([...userIds].map(String));
    week[dateKey] = [...ids];
    await setState(cohort, key, JSON.stringify(week));
    return ids.size;
  });
}

async function checkedIds(cohort, dateKey) {
  const week = parseJson(await getState(cohort, checkinStateKey(cohort, dateKey)), {});
  return new Set(Array.isArray(week[dateKey]) ? week[dateKey].map(String) : []);
}

async function resetChannelAccess(client, cohort) {
  const guild = await client.guilds.fetch(cohort.guildId);
  const { role, channel } = await ensureDawnSetup(client, cohort, guild);
  await clearLegacyMemberDenials(channel, role, cohort.supervisorIds);
  await applyChannelWindowAccess(client, cohort, true);
}

async function fetchDawnWindowMessages(channel, timezone, dateKey, attendanceWindow) {
  if (!channel?.messages?.fetch) return [];
  const bounds = attendanceWindowUtcBounds(dateKey, timezone, attendanceWindow);
  if (!bounds) throw new Error('Invalid Dawn attendance window');
  const messages = [];
  let before = discordSnowflakeAt(bounds.endMs);
  let reachedStart = false;
  let fetchedCount = 0;
  for (let page = 0; page < 10; page++) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    const values = [...batch.values()];
    fetchedCount += values.length;
    messages.push(...values.filter(message => {
      const timestamp = Number(message.createdTimestamp || message.createdAt?.getTime?.() || 0);
      return timestamp >= bounds.startMs && timestamp < bounds.endMs;
    }));
    const oldest = values[values.length - 1];
    const oldestTimestamp = Number(oldest.createdTimestamp || oldest.createdAt?.getTime?.() || 0);
    if (oldestTimestamp < bounds.startMs) {
      reachedStart = true;
      break;
    }
    before = oldest.id;
  }
  if (!reachedStart && fetchedCount >= 1000) {
    throw new Error(`Dawn attendance scan exceeded 1,000 messages inside ${attendanceWindow.label}; no attendance was written.`);
  }
  return messages;
}

async function dawnMessageSources(channel) {
  if (!channel) return [];
  if (channel.messages?.fetch) return [channel];
  if (!channel.threads) return [];
  const found = new Map();
  const active = await channel.threads.fetchActive().catch(() => null);
  for (const thread of active?.threads?.values?.() || []) found.set(thread.id, thread);
  const archived = await channel.threads.fetchArchived({ limit: 100 }).catch(() => null);
  for (const thread of archived?.threads?.values?.() || []) found.set(thread.id, thread);
  return [...found.values()].slice(0, 100);
}

async function fetchDawnSourcesMessages(channels, timezone, dateKey, attendanceWindow) {
  const collected = new Map();
  for (const channel of channels.filter(Boolean)) {
    const sources = await dawnMessageSources(channel);
    for (const source of sources) {
      // A failed source must abort the batch. Treating a Discord read failure
      // as an empty channel would falsely mark every member absent.
      const messages = await fetchDawnWindowMessages(source, timezone, dateKey, attendanceWindow);
      for (const message of messages) collected.set(message.id, message);
    }
  }
  return [...collected.values()];
}

function localDateTime(timezone, value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(value);
  const get = type => parts.find(part => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

async function collectDawnAttendance(cohort, role, channels, dateKey, leaveIds = new Set(),
  attendanceWindow = parseAttendanceWindow(DEFAULT_ATTENDANCE_WINDOW)) {
  const members = [...role.members.values()].filter(member =>
    !member.user.bot && !cohort.supervisorIds.includes(member.id));
  const messages = await fetchDawnSourcesMessages(
    Array.isArray(channels) ? channels : [channels], cohort.timezone, dateKey, attendanceWindow);
  const first = firstQualifyingMessages(messages, members.map(member => member.id), cohort.timezone, dateKey,
    attendanceWindow.startMinute, attendanceWindow.endMinute);
  const roster = await getRoster(cohort, true);
  const studentById = new Map(roster.filter(student => student.discordId).map(student => [student.discordId, student]));
  const entries = members.map(member => {
    const message = first.get(member.id);
    const student = studentById.get(member.id) || {};
    return {
      discordId: member.id,
      displayName: student.name || member.displayName,
      email: student.email || '',
      phone: student.phone || '',
      status: message ? 'Present' : (leaveIds.has(member.id) ? 'Leave' : 'Absent'),
      firstMessageAt: message ? localDateTime(cohort.timezone, message.createdAt) : '',
    };
  });
  await appsScriptPost(cohort, {
    action: 'saveDawnAttendance',
    date: dateKey,
    guildId: cohort.guildId,
    entries,
  }, { idempotent: true, label: 'Dawn attendance batch' });
  await saveCheckedIds(cohort, first.keys(), dateKey);
  return { entries, checked: new Set(first.keys()), scanned: messages.length };
}

async function sendDawnPrompt(client, cohort) {
  const guild = await client.guilds.fetch(cohort.guildId);
  const { role, channel } = await ensureDawnSetup(client, cohort, guild);
  const attendanceWindow = await dawnAttendanceWindow(cohort);
  await channel.send({
    content: `<@&${role.id}> **Good morning. If you are awake, send any message during ${attendanceWindow.label}.**\nSalam, “I woke up,” or a short focus plan all count. The bot records the first qualifying message once after the window closes, Sunday-Thursday.`,
    allowedMentions: { roles: [role.id] },
  });
}

async function reviewCheckins(client, cohort) {
  if (!isDawnAttendanceDay(cohort.timezone)) {
    return { checked: 0, absent: 0, scanned: 0, warnings: 0, removed: 0, skipped: true };
  }
  const guild = await client.guilds.fetch(cohort.guildId);
  const { role, channel, legacyChannels } = await ensureDawnSetup(client, cohort, guild);
  const today = localDateKey(cohort.timezone);
  const attendanceWindow = await dawnAttendanceWindow(cohort);
  if (localMinutes(cohort.timezone) < attendanceWindow.endMinute) {
    throw new Error(`Today's Dawn attendance window (${attendanceWindow.label}) has not closed yet.`);
  }
  const previouslyChecked = await checkedIds(cohort, today);
  const leaveCalendar = await appsScriptGet(cohort, {
    action: 'leavecalendar', date: today,
  }, { label: 'Dawn approved-leave calendar' });
  const leaveIds = new Set((leaveCalendar.students || []).map(student => String(student.discordId || '')).filter(Boolean));
  const batch = await collectDawnAttendance(
    cohort, role, [channel, ...legacyChannels], today, leaveIds, attendanceWindow);
  const checked = batch.checked;
  const state = await profiles(cohort);
  const warnings = [];
  const removed = [];
  for (const member of role.members.values()) {
    if (member.user.bot || cohort.supervisorIds.includes(member.id)) continue;
    const profile = defaultProfile(state.members[member.id]);
    if (profile.lastReviewedDate === today) {
      // A mentor may rerun the review after widening/correcting the window. A
      // newly recovered presence must undo today's false miss/pending state,
      // while another rerun must never increment absence twice.
      if ((checked.has(member.id) || leaveIds.has(member.id)) && !previouslyChecked.has(member.id)) {
        profile.missed = 0;
        profile.missedDates = [];
        profile.pending = false;
        profile.status = 'active';
      }
      state.members[member.id] = profile;
      continue;
    }
    if (profile.pending) {
      await member.roles.remove(role, 'Dawn Focus permit survey not completed before next review').catch(() => {});
      profile.status = 'removed';
      profile.everJoined = true;
      profile.rolePresent = false;
      profile.lastMembershipEvent = { date: today, event: 'Removed' };
      profile.pending = false;
      profile.appealRequired = true;
      removed.push({ userId: member.id, dates: profile.missedDates.slice(-3) });
    } else if (checked.has(member.id) || leaveIds.has(member.id)) {
      profile.missed = 0;
      profile.missedDates = [];
    } else {
      profile.missed += 1;
      profile.missedDates = [...new Set([...profile.missedDates, today])].sort().slice(-3);
      if (profile.missed >= 3) {
        profile.pending = true;
        warnings.push({ userId: member.id, dates: profile.missedDates.slice(-3) });
      }
    }
    profile.lastReviewedDate = today;
    state.members[member.id] = profile;
  }
  await setState(cohort, profileStateKey(cohort), JSON.stringify(state));
  for (const removal of removed) {
    const userId = removal.userId;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) continue;
    const student = await dawnStudent(cohort, member);
    if (student?.email) {
      await appsScriptPost(cohort, {
        action: 'saveDawnMembershipEvent', date: today, event: 'Removed',
        entry: { discordId: userId, displayName: student.name || member.displayName,
          email: student.email, phone: student.phone || '' },
      }, { idempotent: true, label: 'Dawn automatic removal' });
    }
    await notifyRestriction(client, cohort, {
      discordId: userId, name: student?.name || member.displayName,
      email: student?.email || '', phone: student?.phone || '',
    }, {
      scope: 'dawn', public: true, publicChannelId: cohort.channels.emergency,
      reason: `Dawn Focus access was removed after three missed scheduled check-ins${removal.dates.length ? ` (${removal.dates.join(', ')})` : ''} and the required private permit survey was not completed before the next review.`,
    });
  }
  for (const warning of warnings) {
    const userId = warning.userId;
    await channel.send({
      content: `<@${userId}> ⚠️ **Dawn removal warning**\nYou missed **3 consecutive scheduled check-ins**${warning.dates.length ? `: **${warning.dates.join(', ')}**` : ''}. Submit the private reason form **before the next scheduled review**. If you do not respond, or the selected permit is exhausted, your Dawn role and channel access will be removed.\nUse a truthful valid cause (medical emergency, examination, or the one recommitment permit), explain what happened, and promise to return consistently. Allah is watching; do not misuse permits.`,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`dawn:reason:${cohort.guildId}:${userId}`).setLabel('Submit private reason').setStyle(ButtonStyle.Danger),
      )],
      allowedMentions: { users: [userId] },
    });
  }
  if (removed.length) {
    await channel.send({
      content: `**Dawn access removed:** ${removed.map(item => `<@${item.userId}>`).join(' ')}\nThey were also mentioned in ${cohort.channels.emergency ? `<#${cohort.channels.emergency}>` : 'the emergency channel'} with a mobile appeal button. Only a mentor-approved appeal can restore the role; the normal join form cannot bypass removal.`,
      allowedMentions: { users: removed.map(item => item.userId) },
    });
  }
  const present = batch.entries.filter(entry => entry.status === 'Present');
  const leave = batch.entries.filter(entry => entry.status === 'Leave');
  const absent = batch.entries.filter(entry => entry.status === 'Absent');
  const mentions = absent.map(entry => `<@${entry.discordId}>`).join(' ');
  const presentNames = present.map(entry => entry.displayName).join(', ');
  const content = [
    `## 🌅 Dawn Focus Attendance — ${today}`,
    `✅ Present: **${present.length}** · 🟦 Approved leave: **${leave.length}** · ❌ Absent: **${absent.length}** · messages scanned: **${batch.scanned}**`,
    `**Present:** ${presentNames || '—'}`,
    absent.length ? `**No qualifying message during ${attendanceWindow.label}:** ${mentions}` : `🎉 Everyone checked in during ${attendanceWindow.label}.`,
  ].join('\n');
  await channel.send({
    content: content.length <= 1950
      ? content
      : `## 🌅 Dawn Focus Attendance — ${today}\n✅ Present: **${present.length}** · 🟦 Leave: **${leave.length}** · ❌ Absent: **${absent.length}**\n${mentions}`,
    allowedMentions: { users: absent.map(entry => entry.discordId) },
  });
  return {
    checked: checked.size,
    leave: leave.length,
    absent: absent.length,
    scanned: batch.scanned,
    warnings: warnings.length,
    removed: removed.length,
    window: attendanceWindow.label,
  };
}

function reasonPayload(guildId, userId) {
  return {
    content: 'Choose the truthful reason. Your selection and remaining permits are private.',
    components: [new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`dawn:reasonselect:${guildId}:${userId}`)
        .setPlaceholder('Choose your reason')
        .addOptions(
          { label: 'Medical emergency', value: 'medical', description: 'Uses one of two medical-emergency permits' },
          { label: 'Examination', value: 'exam', description: 'Uses one of two examination permits' },
          { label: 'Could not keep up — recommit', value: 'recommit', description: 'Uses the single recommitment permit' },
        ),
    )],
    ephemeral: true,
  };
}

async function dawnAppealRequired(cohort, userId) {
  const state = await profiles(cohort);
  return defaultProfile(state.members[String(userId || '')]).appealRequired;
}

async function restoreDawnAccess(client, cohort, member, mentorId) {
  const setup = await ensureDawnSetup(client, cohort, member.guild);
  await updateProfiles(cohort, state => {
    const profile = defaultProfile(state.members[member.id]);
    profile.status = 'active';
    profile.missed = 0;
    profile.missedDates = [];
    profile.pending = false;
    profile.appealRequired = false;
    state.members[member.id] = profile;
  });
  if (!member.roles.cache.has(setup.role.id)) {
    await member.roles.add(setup.role, `Mentor ${mentorId || 'approval'} restored Dawn Focus access`);
  }
  await recordMembershipEvent(cohort, member, true, { appealApproved: true });
  return { restored: true, roleId: setup.role.id, channelId: setup.channel.id };
}

module.exports = function registerDawnDiscipline(client) {
  for (const cohort of cohorts) {
    scheduleEveryMinute(cohort, 'dawn-channel-window', async () => {
      await applyChannelWindowAccess(client, cohort);
    });
    scheduleAtSetting(cohort, 'dawnreset', 'dawnresettime', async () => {
      if ((await isOn(cohort, 'discipline')) && (await isScheduledToday(cohort, 'discipline')) && cohort.channels.discipline) {
        await resetChannelAccess(client, cohort);
      }
    });
    scheduleAtSetting(cohort, 'dawnprompt', 'dawnprompttime', async () => {
      if ((await isOn(cohort, 'discipline')) && (await isScheduledToday(cohort, 'discipline')) && cohort.channels.discipline) {
        await sendDawnPrompt(client, cohort);
      }
    });
    scheduleAtSetting(cohort, 'dawncheck', 'dawnchecktime', async () => {
      if ((await isOn(cohort, 'discipline')) && (await isScheduledToday(cohort, 'discipline')) && cohort.channels.discipline) {
        await reviewCheckins(client, cohort);
      }
    });
  }

  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    const cohort = cohorts.find(item => item.guildId === newMember.guild.id);
    if (!cohort || newMember.user.bot || cohort.supervisorIds.includes(newMember.id)) return;
    const role = findRole(newMember.guild);
    if (!role) return;
    const hadRole = oldMember.roles.cache.has(role.id);
    const hasRole = newMember.roles.cache.has(role.id);
    if (hadRole === hasRole) return;
    await recordMembershipEvent(cohort, newMember, hasRole).catch(() => {});
  });

  client.on('messageCreate', async message => {
    if (message.author.bot) return;
    const cohort = cohorts.find(item => item.guildId === message.guildId);
    if (!cohort) return;
    const command = message.content.trim().match(
      /^!dawn(?:\s+(setup|invite|status|review|repair|sync|add|remove|window|attendance))?(?:\s+(.+))?$/i);
    if (command && cohort.supervisorIds.includes(message.author.id)) {
      if (message.channelId !== cohort.channels.supervisor) return message.reply(`Run this command in <#${cohort.channels.supervisor}>.`);
      const action = (command[1] || 'status').toLowerCase();
      const argument = String(command[2] || '').trim();
      try {
        const setup = await ensureDawnSetup(client, cohort, message.guild);
        if (action === 'setup') {
          return message.reply(`Dawn setup ready: <#${setup.channel.id}> is a normal text channel. Student thread creation is disabled; sending is ${setup.open ? 'open' : 'closed'} (${setup.window.label}).`);
        }
        if (action === 'repair') {
          const sheet = await appsScriptPost(cohort, { action: 'repairDawnAttendance' }, {
            idempotent: true,
            label: 'Dawn attendance repair',
          });
          await clearLegacyMemberDenials(setup.channel, setup.role, cohort.supervisorIds);
          await applyChannelWindowAccess(client, cohort, true);
          return message.reply({
            content: `Dawn repair complete. Text channel: <#${setup.channel.id}> | archived old channel(s): **${setup.legacyChannels.length}** | merged old Dawn tabs: **${Number(sheet.migratedTabs || 0)}** | students preserved: **${Number(sheet.students || 0)}**.`,
            allowedMentions: { parse: [] },
          });
        }
        if (action === 'sync') {
          await message.reply({
            content: 'Synchronizing every current Dawn role member with the canonical attendance matrix...',
            allowedMentions: { parse: [] },
          });
          const result = await syncDawnRoleMembers(cohort, message.guild, setup.role);
          const lines = [
            `Dawn member sync complete — **${cohort.name}**`,
            `Role members: **${result.roleMembers}**`,
            `Role members submitted from roster: **${result.matched}**`,
            `Sheet rows added: **${Number(result.sheet.added || 0)}**`,
            `Existing rows refreshed: **${Number(result.sheet.updated || 0)}**`,
            `Lifecycle events repaired: **${Number(result.sheet.eventsSaved || 0)}**`,
            `Offline role removals reconciled: **${result.removed}**`,
            `Missing verified contact profiles: **${result.missing.length}**`,
          ];
          if (result.missing.length) {
            lines.push('', 'Complete these profiles, then run `!dawn sync` again:');
            lines.push(...result.missing.slice(0, 30).map(item => `- ${item.name} — Discord ID \`${item.id}\``));
          }
          return message.channel.send({ content: lines.join('\n').slice(0, 1990), allowedMentions: { parse: [] } });
        }
        if (action === 'window') {
          const attendanceWindow = await dawnAttendanceWindow(cohort);
          if (!argument) {
            return message.reply(`Dawn channel sending window: **${setup.window.label}** (${setup.open ? 'open now' : 'closed now'}). Attendance is counted only **${attendanceWindow.label}, Sunday-Thursday**.`);
          }
          const window = parseChannelWindow(argument);
          if (!window) throw new Error('Use `!dawn window always` or `!dawn window HH:MM-HH:MM`, for example `05:30-08:00`.');
          await setSetting(cohort, 'dawnchannelwindow', window.mode === 'always' ? 'always' : window.label);
          appliedWindows.delete(cohort.guildId);
          const applied = await applyChannelWindowAccess(client, cohort, true);
          return message.reply(`Dawn channel window set to **${window.label}** (${applied?.open ? 'open now' : 'closed now'}). Attendance remains **${attendanceWindow.label}, Sunday-Thursday**.`);
        }
        if (action === 'attendance') {
          const current = await dawnAttendanceWindow(cohort);
          if (!argument) {
            return message.reply(`Dawn attendance window: **${current.label}**, Sunday-Thursday. Use \`!dawn attendance HH:MM-HH:MM\` to change it.`);
          }
          const window = parseAttendanceWindow(argument);
          if (!window) throw new Error('Use a same-day range from 15 minutes to 6 hours, for example `!dawn attendance 05:00-07:00`.');
          const reviewTime = String(await getSetting(cohort, 'dawnchecktime'));
          const reviewMinute = Number(reviewTime.slice(0, 2)) * 60 + Number(reviewTime.slice(3));
          if (!Number.isFinite(reviewMinute) || window.endMinute >= reviewMinute) {
            throw new Error(`Set \`!time dawncheck HH:MM\` later than ${window.end} first.`);
          }
          await setSetting(cohort, 'dawnattendancewindow', window.label);
          return message.reply(`✅ Dawn attendance window set to **${window.label}**, Sunday-Thursday. Only messages inside this exact interval count.`);
        }
        if (action === 'invite') {
          const discussion = await client.channels.fetch(cohort.channels.discussion);
          await discussion.send(enrollmentPayload(cohort, await dawnAttendanceWindow(cohort)));
          return message.reply(`✅ Enrollment form posted in <#${discussion.id}>.`);
        }
        if (action === 'review') {
          const attendanceWindow = await dawnAttendanceWindow(cohort);
          await message.reply(`⏳ Scanning only today's completed **${attendanceWindow.label}** window and writing one Dawn attendance batch...`);
          const result = await reviewCheckins(client, cohort);
          if (result.skipped) {
            return message.channel.send('Dawn attendance is not counted on Friday or Saturday. No Sheet marks or absence penalties were created.');
          }
          return message.channel.send({
            content: `✅ Dawn review complete for **${result.window}**: **${result.checked} present**, **${result.absent} absent**, **${result.scanned} in-window messages scanned**.`,
            allowedMentions: { parse: [] },
          });
        }
        if (['add', 'remove'].includes(action)) {
          const userId = argument.match(/\d{15,20}/)?.[0];
          if (!userId) throw new Error(`Use \`!dawn ${action} @student\``);
          const member = await message.guild.members.fetch(userId);
        if (action === 'add') {
            await restoreDawnAccess(client, cohort, member, message.author.id);
          } else {
            await member.roles.remove(setup.role, 'Supervisor removed Dawn Focus access');
            await recordMembershipEvent(cohort, member, false);
          }
          return message.reply({
            content: `✅ Dawn Focus access ${action === 'add' ? 'granted to' : 'removed from'} <@${userId}>.`,
            allowedMentions: { parse: [] },
          });
        }
        const state = await profiles(cohort);
        const today = localDateKey(cohort.timezone);
        const checked = await checkedIds(cohort, today);
        const active = setup.role.members.filter(member => !member.user.bot && !cohort.supervisorIds.includes(member.id));
        const pending = Object.values(state.members).filter(profile => profile.pending).length;
        const attendanceWindow = await dawnAttendanceWindow(cohort);
        const statusContent = `**Dawn Focus Circle**\nRole members: **${active.size}** | checked in today: **${checked.size}** | pending permit surveys: **${pending}**\nChannel: <#${setup.channel.id}> (normal text)\nSending: **${setup.window.label}** | ${setup.open ? 'open now' : 'closed now'}\nAttendance: **${attendanceWindow.label}, Sunday-Thursday only**`;
        return message.reply({
          content: statusContent,
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        return message.reply(`❌ Dawn Focus command failed: ${String(error.message).slice(0, 300)}`);
      }
    }

    // Do not write, reply, or react for each Dawn message. After the configured
    // scans the completed window and saves one idempotent Sheet batch.
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.customId?.startsWith('dawn:')) return;
    const [, action, guildId, targetId] = interaction.customId.split(':');
    const cohort = cohorts.find(item => item.guildId === guildId);
    if (!cohort || interaction.guildId !== guildId) return;
    try {
      if (action === 'review' && interaction.isButton()) {
        const attendanceWindow = await dawnAttendanceWindow(cohort);
        await interaction.reply({
          content: `**Dawn Focus terms**\nI will check in honestly during ${attendanceWindow.label}, Sunday-Thursday. I understand the 3-miss survey, permit limits, and removal policy. Allah is watching, and I will be truthful.`,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`dawn:agree:${guildId}`).setLabel('I agree — join').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`dawn:cancel:${guildId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
          )],
          ephemeral: true,
        });
        return;
      }
      if (action === 'cancel' && interaction.isButton()) {
        await interaction.update({ content: 'Enrollment cancelled.', components: [] });
        return;
      }
      if (action === 'agree' && interaction.isButton()) {
        await interaction.deferUpdate();
        if (await dawnAppealRequired(cohort, interaction.user.id)) {
          await interaction.editReply({
            content: 'Your previous Dawn Focus removal requires mentor review. Submit an appeal; the regular join form cannot restore access.',
            components: [new ActionRowBuilder().addComponents(
              appealButton(cohort, 'dawn', interaction.user.id, 'Appeal Dawn removal'),
            )],
          });
          return;
        }
        const setup = await ensureDawnSetup(client, cohort, interaction.guild);
        await interaction.member.roles.add(setup.role, 'Accepted Dawn Focus Circle terms');
        await recordMembershipEvent(cohort, interaction.member, true);
        await interaction.editReply({ content: `✅ You joined **${ROLE_NAME}**. Your private channel is <#${setup.channel.id}>.`, components: [] });
        return;
      }
      if (action === 'reason' && interaction.isButton()) {
        if (interaction.user.id !== targetId) return interaction.reply({ content: 'This private reason form belongs to another member.', ephemeral: true });
        await interaction.reply(reasonPayload(guildId, targetId));
        return;
      }
      if (action === 'reasonselect' && interaction.isStringSelectMenu()) {
        if (interaction.user.id !== targetId) return interaction.reply({ content: 'This private reason form belongs to another member.', ephemeral: true });
        await interaction.deferUpdate();
        const reason = interaction.values[0];
        const setup = await ensureDawnSetup(client, cohort, interaction.guild);
        if (!(reason in LIMITS)) throw new Error('Invalid permit reason');
        const outcome = await updateProfiles(cohort, async state => {
          const profile = defaultProfile(state.members[targetId]);
          if (!profile.pending) return { status: 'not-pending' };
          if (profile.permits[reason] >= LIMITS[reason]) {
            await interaction.member.roles.remove(setup.role, 'Dawn Focus permit limit exhausted');
            profile.status = 'removed';
            profile.everJoined = true;
            profile.rolePresent = false;
            profile.appealRequired = true;
            profile.lastMembershipEvent = { date: localDateKey(cohort.timezone), event: 'Removed' };
            profile.pending = false;
            state.members[targetId] = profile;
            return { status: 'exhausted' };
          }
          profile.permits[reason] += 1;
          profile.missed = 0;
          profile.missedDates = [];
          profile.pending = false;
          profile.status = 'active';
          state.members[targetId] = profile;
          return { status: 'approved', remaining: LIMITS[reason] - profile.permits[reason] };
        });
        if (outcome.status === 'not-pending') {
          return interaction.editReply({ content: 'No permit survey is pending for your account.', components: [] });
        }
        if (outcome.status === 'exhausted') {
          const student = await dawnStudent(cohort, interaction.member);
          if (student?.email) {
            await appsScriptPost(cohort, {
              action: 'saveDawnMembershipEvent', date: localDateKey(cohort.timezone), event: 'Removed',
              entry: { discordId: targetId, displayName: student.name || interaction.member.displayName,
                email: student.email, phone: student.phone || '' },
            }, { idempotent: true, label: 'Dawn permit removal' });
          }
          await notifyRestriction(client, cohort, {
            discordId: targetId, name: student?.name || interaction.member.displayName,
            email: student?.email || '', phone: student?.phone || '',
          }, {
            scope: 'dawn', public: true, publicChannelId: cohort.channels.emergency,
            reason: `Dawn Focus access was removed because the ${reason} permit limit was exhausted.`,
          });
          await interaction.editReply({ content: 'Your permit for that reason is exhausted. Dawn Focus access was removed. A private appeal button was sent; mentor approval is required before you can rejoin.', components: [] });
          return;
        }
        await setup.channel.permissionOverwrites.delete(targetId, 'Approved Dawn Focus permit').catch(() => {});
        await interaction.editReply({ content: `✅ Your private reason was recorded. **${outcome.remaining}** permit(s) remain for this reason. Access continues.`, components: [] });
      }
    } catch (error) {
      const payload = { content: `Dawn Focus action failed: ${String(error.message).slice(0, 250)}`, ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  });
};

module.exports.CHANNEL_NAME = CHANNEL_NAME;
module.exports.LIMITS = LIMITS;
module.exports.ROLE_NAME = ROLE_NAME;
module.exports.defaultProfile = defaultProfile;
module.exports.dawnAppealRequired = dawnAppealRequired;
module.exports.dawnAttendanceWindow = dawnAttendanceWindow;
module.exports.enrollmentPayload = enrollmentPayload;
module.exports.isDawnAttendanceDay = isDawnAttendanceDay;
module.exports.localMinutes = localMinutes;
module.exports.restoreDawnAccess = restoreDawnAccess;
module.exports.syncDawnRoleMembers = syncDawnRoleMembers;
module.exports.weekStartKey = weekStartKey;
