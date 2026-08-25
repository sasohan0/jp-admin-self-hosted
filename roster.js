// ============================================================
//  roster.js - shared identity helper (every module imports this)
//
//  What it gives you:
//    getRoster(cohort)          -> cached student list with IDs
//    isExcluded(cohort, entry)  -> true for supervisors/hired/left
//    mention(entry)             -> "<@id>" if ID known, else name
//    syncMembers(client, cohort)-> rebuild active Bot_Map from Discord members
// ============================================================

const cache = {}; // guildId -> { at: timestamp, roster: [...] }
const excluded = {}; // guildId -> Set(discordId) - manual !exclude list
const CACHE_MS = 10 * 60 * 1000; // 10 minutes
const { fetchGuildMembers } = require('./discord-members');
const { appsScriptGet, appsScriptPost } = require('./apps-script-api');
const SYNC_REUSE_MS = 15 * 60 * 1000;

async function getRoster(cohort, force = false) {
  const hit = cache[cohort.guildId];
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.roster;

  const data = await appsScriptGet(cohort, {
    action: 'roster',
    guildId: cohort.guildId,
  }, { label: 'Roster read' });

  setRosterSnapshot(cohort, data.roster, data.excludedIds);
  return data.roster;
}

async function postJson(cohort, body) {
  return appsScriptPost(cohort, body, {
    idempotent: body?.action === 'syncDiscordRoster',
    label: 'Roster write',
    timeoutMs: 180000,
  });
}

function setRosterSnapshot(cohort, roster, excludedIds) {
  if (Array.isArray(excludedIds)) {
    excluded[cohort.guildId] = new Set(excludedIds.map(String).map(s => s.trim()).filter(Boolean));
  }
  cache[cohort.guildId] = { at: Date.now(), roster: roster || [] };
  return cache[cohort.guildId].roster;
}

// Supervisors are excluded by Discord ID (never by name - names change).
// Students with status "hired" or "left" are excluded everywhere too.
function isExcluded(cohort, entry) {
  if (entry.discordId && (cohort.supervisorIds || []).includes(entry.discordId)) return true;
  if (entry.active === false) return true;
  if (entry.status === 'hired' || entry.status === 'left') return true;
  const ex = excluded[cohort.guildId];
  if (ex && entry.discordId && ex.has(entry.discordId)) return true; // manual !exclude
  return false;
}

// Real ping if we know the ID, plain name as fallback.
function mention(entry) {
  return entry.discordId ? `<@${entry.discordId}>` : `**${entry.name}**`;
}

// ============================================================
//  !syncmembers - Discord is the active-student source of truth.
//  All Data and enrollment responses supply identity/contact matches only.
// ============================================================
function normalizeUsername(u) {
  return String(u || '')
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '') // strip invisible chars (zero-width, nbsp)
    .trim().toLowerCase()
    .replace(/^@/, '')        // strip leading @
    .replace(/#\d+$/, '')     // strip old-style #1234 tags
    .replace(/\s+/g, '');     // usernames never contain spaces
}

function buildDiscordSyncPeople(members, supervisorIds = []) {
  const people = [];
  for (const m of members.values()) {
    if (m.user.bot || supervisorIds.includes(m.id)) continue;
    people.push({
      discordId: m.id,
      username: m.user.username,
      globalName: m.user.globalName || '',
      nickname: m.nickname || '',
      displayName: m.nickname || m.user.globalName || m.user.username,
    });
  }
  return people;
}

async function performSyncMembers(client, cohort) {
  const guild = await client.guilds.fetch(cohort.guildId);
  const members = await fetchGuildMembers(guild, { force: true }); // requires Server Members Intent!
  const people = buildDiscordSyncPeople(members, cohort.supervisorIds || []);

  const result = await postJson(cohort, {
    action: 'syncDiscordRoster',
    guildId: cohort.guildId,
    people,
  });
  clearCache(cohort);
  await getRoster(cohort, true);
  return Object.assign(result, {
    totalMembers: members.size,
    eligibleMembers: people.length,
  });
}

function createRosterSyncCoordinator(options = {}) {
  const run = options.run;
  if (typeof run !== 'function') throw new Error('roster sync run function is required');
  const now = options.now || Date.now;
  const reuseMs = Math.max(0, Number(options.reuseMs ?? SYNC_REUSE_MS));
  const states = new Map();

  async function sync(client, cohort, syncOptions = {}) {
    const guildId = String(cohort?.guildId || '');
    if (!guildId) throw new Error('cohort guild ID is required for roster sync');
    const state = states.get(guildId) || { inFlight: null, completedAt: 0, result: null };
    states.set(guildId, state);

    // Multiple modules often request a fresh roster at the same minute. One
    // Discord fetch and one Apps Script write are sufficient for all callers.
    if (state.inFlight) return state.inFlight;
    if (!syncOptions.force && state.result && now() - state.completedAt <= reuseMs) {
      return state.result;
    }

    const request = Promise.resolve().then(() => run(client, cohort));
    state.inFlight = request;
    try {
      const result = await request;
      state.result = result;
      state.completedAt = now();
      return result;
    } finally {
      if (state.inFlight === request) state.inFlight = null;
    }
  }

  return { sync, states };
}

const syncCoordinator = createRosterSyncCoordinator({ run: performSyncMembers });

function syncMembers(client, cohort, options = {}) {
  return syncCoordinator.sync(client, cohort, options);
}

async function rosterForBackfill(client, cohort, options = {}) {
  const sync = options.sync || syncMembers;
  const read = options.read || getRoster;
  let refreshWarning = '';
  try {
    await sync(client, cohort);
  } catch (error) {
    // Historical imports can safely use the last durable roster. Do not throw
    // away a long history scan merely because Google's edge briefly rejected
    // the optional pre-scan refresh. The completion message must disclose it.
    refreshWarning = String(error?.message || 'roster refresh failed').slice(0, 250);
  }
  const roster = await read(cohort, true);
  return { roster, refreshed: !refreshWarning, refreshWarning };
}

function clearCache(cohort) {
  const guildId = typeof cohort === 'object' ? cohort?.guildId : cohort;
  if (guildId) cache[guildId] = null;
}

module.exports = {
  getRoster,
  isExcluded,
  mention,
  syncMembers,
  rosterForBackfill,
  createRosterSyncCoordinator,
  normalizeUsername,
  buildDiscordSyncPeople,
  clearCache,
  setRosterSnapshot,
  excluded,
};
