// ============================================================
//  config.js - cohort configuration
//
//  Modes, in precedence order:
//   1. COHORT_REGISTRY_JSON: one Render service, up to 3 cohorts.
//   2. COHORT_*: one isolated cohort (backward compatible).
//   3. JP_INSTALLER_MODE=true: self-hosted Discord-guided bootstrap.
//   4. No generic identity variables: legacy EJP-13.
// ============================================================

function csv(value) {
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

function channelsFromEnv() {
  const raw = process.env.COHORT_CHANNELS_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('must be an object');
    return parsed;
  } catch (err) {
    throw new Error(`COHORT_CHANNELS_JSON is invalid JSON: ${err.message}`);
  }
}

function channelsFromValue(value, label) {
  if (value === undefined || value === null || value === '') return {};
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${label}.channels must be an object`);
  }
  return { ...value };
}

function normalizeJobsCheckCron(value) {
  const cron = String(value || '').trim() || '30 22 * * *';
  // Migrate both historical built-in defaults to the current 10:30 PM check.
  // Preserve every other explicitly customized value.
  return ['59 23 * * *', '0 23 * * *'].includes(cron) ? '30 22 * * *' : cron;
}

function cohortDefaults(input) {
  return {
    name: input.name,
    registryKey: input.registryKey || '',
    appsScriptUrl: input.appsScriptUrl,
    apiKey: input.apiKey,
    timezone: input.timezone || 'Asia/Dhaka',
    guildId: input.guildId,
    supervisorIds: input.supervisorIds,
    channels: input.channels || {},
    formOpenReminder: input.formOpenReminder || '0 21 * * *',
    formCloseReminder: input.formCloseReminder || '15 22 * * *',
    outreachCheckCron: input.outreachCheckCron || '0 20 * * *',
    outreachStaleDays: 2,
    jobs: {
      dailyTarget: 15,
      historyDays: 3,
      checkCron: normalizeJobsCheckCron(input.jobsCheckCron),
    },
    questions: {
      workshopTechPerDay: 18,
      workshopCommPerDay: 3,
      workshopWindowMin: 20,
      workshopStartHour: 10,
      workshopEndMin: 19 * 60 + 30,
      discussionTechPerDay: 0,
      discussionWindowMin: 10,
      discussionStartHour: 10,
      discussionLastDropMin: 18 * 60 + 45,
      leaderboardCron: '0 20 */2 * *',
      weeklyReportCron: '0 18 * * 4',
    },
    workshopSessions: {
      announceCron: '30 9 * * *',
      pollWindowMin: 15,
      noShowCron: '40 20 * * *',
      meetUrl: input.workshopMeetUrl || 'https://meet.google.com/rvp-cihj-txb',
      speakMoreUrl: input.workshopGptUrl || 'https://chatgpt.com/g/g-6a001f14177c8191a786e3037582ad33-speak-more',
      slots: [
        { name: 'Morning', label: '11:30 AM – 1:00 PM', pollCron: '10 12 * * *' },
        { name: 'Afternoon', label: '3:00 PM – 5:00 PM', pollCron: '40 15 * * *' },
        { name: 'Evening', label: '7:00 PM – 8:30 PM', pollCron: '40 19 * * *' },
      ],
    },
    rtbr: { days: 7, announceCron: '0 20 * * 5' },
    resources: { autoPostCron: '0 11 * * *' },
  };
}

const singleIdentityVariables = [
  'COHORT_NAME',
  'COHORT_GUILD_ID',
  'COHORT_API_URL',
  'COHORT_API_KEY',
  'COHORT_SUPERVISOR_IDS',
];

const installerMode = /^(1|true|yes|on)$/i.test(String(process.env.JP_INSTALLER_MODE || '').trim());
const isolatedMode = !installerMode && singleIdentityVariables.some(key => Boolean(process.env[key]));

function parseRegistry() {
  const raw = process.env.COHORT_REGISTRY_JSON;
  if (!raw) return null;
  if (isolatedMode) {
    throw new Error('Use COHORT_REGISTRY_JSON or single-cohort COHORT_* variables, not both');
  }

  let entries;
  try { entries = JSON.parse(raw); }
  catch { throw new Error('COHORT_REGISTRY_JSON is invalid JSON'); }
  if (!Array.isArray(entries)) throw new Error('COHORT_REGISTRY_JSON must be an array');

  const enabled = entries.filter(entry => entry?.enabled !== false);
  if (!enabled.length) throw new Error('COHORT_REGISTRY_JSON has no enabled cohorts');
  if (enabled.length > 3) throw new Error('COHORT_REGISTRY_JSON supports at most 3 enabled cohorts');

  const names = new Set();
  const guildIds = new Set();
  const keys = new Set();
  return enabled.map((entry, index) => {
    const label = `COHORT_REGISTRY_JSON[${index}]`;
    if (!entry || Array.isArray(entry) || typeof entry !== 'object') {
      throw new Error(`${label} must be an object`);
    }
    const registryKey = String(entry.key || '').trim().toLowerCase();
    const name = String(entry.name || '').trim();
    const guildId = String(entry.guildId || '').trim();
    const supervisorIds = Array.isArray(entry.supervisorIds)
      ? entry.supervisorIds.map(String).map(value => value.trim()).filter(Boolean)
      : csv(entry.supervisorIds);

    if (!/^[a-z0-9_]+$/.test(registryKey)) {
      throw new Error(`${label}.key must use lowercase letters, numbers, or underscores`);
    }
    if (!name) throw new Error(`${label}.name is required`);
    if (!/^\d{15,20}$/.test(guildId)) throw new Error(`${label}.guildId must be a Discord server ID`);
    if (!supervisorIds.length || !supervisorIds.every(id => /^\d{15,20}$/.test(id))) {
      throw new Error(`${label}.supervisorIds must contain Discord user IDs`);
    }
    if (keys.has(registryKey)) throw new Error(`duplicate cohort registry key: ${registryKey}`);
    if (names.has(name.toLowerCase())) throw new Error(`duplicate cohort name: ${name}`);
    if (guildIds.has(guildId)) throw new Error(`duplicate cohort guild ID: ${guildId}`);
    keys.add(registryKey);
    names.add(name.toLowerCase());
    guildIds.add(guildId);

    const prefix = registryKey.toUpperCase();
    const urlEnv = String(entry.apiUrlEnv || `${prefix}_API_URL`).trim();
    const keyEnv = String(entry.apiKeyEnv || `${prefix}_API_KEY`).trim();
    const appsScriptUrl = process.env[urlEnv] || '';
    const apiKey = process.env[keyEnv] || '';
    if (!appsScriptUrl) throw new Error(`${name}: backend URL environment variable ${urlEnv} is missing`);
    if (!apiKey) throw new Error(`${name}: backend key environment variable ${keyEnv} is missing`);

    return cohortDefaults({
      name,
      registryKey,
      guildId,
      supervisorIds,
      appsScriptUrl,
      apiKey,
      timezone: entry.timezone,
      channels: channelsFromValue(entry.channels, label),
      formOpenReminder: entry.formOpenReminder,
      formCloseReminder: entry.formCloseReminder,
      outreachCheckCron: entry.outreachCheckCron,
      jobsCheckCron: entry.jobsCheckCron,
      workshopMeetUrl: entry.workshopMeetUrl,
      workshopGptUrl: entry.workshopGptUrl,
    });
  });
}

const registryCohorts = parseRegistry();

const isolatedCohort = isolatedMode ? cohortDefaults({
  name: process.env.COHORT_NAME || '',
  appsScriptUrl: process.env.COHORT_API_URL || '',
  apiKey: process.env.COHORT_API_KEY || '',
  timezone: process.env.COHORT_TIMEZONE || 'Asia/Dhaka',
  guildId: process.env.COHORT_GUILD_ID || '',
  supervisorIds: csv(process.env.COHORT_SUPERVISOR_IDS),
  channels: channelsFromEnv(),
  formOpenReminder: process.env.FORM_OPEN_REMINDER,
  formCloseReminder: process.env.FORM_CLOSE_REMINDER,
  outreachCheckCron: process.env.OUTREACH_CHECK_CRON,
  jobsCheckCron: process.env.JOBS_CHECK_CRON,
  workshopMeetUrl: process.env.WORKSHOP_MEET_URL,
  workshopGptUrl: process.env.WORKSHOP_GPT_URL,
}) : null;

// Kept in a separate file so the mentor ZIP can omit production-only IDs.
// Installer mode never loads or requires this module.
const legacyEjp = installerMode ? null : require('./legacy-cohort');

const cohorts = registryCohorts || (isolatedCohort ? [isolatedCohort] : installerMode ? [] : [legacyEjp]);
const mode = registryCohorts ? 'multi' : isolatedCohort ? 'isolated' : installerMode ? 'installer' : 'legacy';

function findCohort(guildId) {
  return cohorts.find(cohort => cohort.guildId === guildId);
}

module.exports = {
  groq: { model: 'llama-3.3-70b-versatile' },
  mode,
  installerMode,
  cohorts,
  cohortDefaults,
  normalizeJobsCheckCron,
  findCohort,
  forwarder: {
    hubGuildId: process.env.FORWARDER_HUB_GUILD_ID || '',
    sourceChannelId: mode === 'legacy'
      ? '1511285725499232397'
      : (process.env.FORWARDER_SOURCE_CHANNEL_ID || ''),
    destinationChannelId: mode === 'legacy'
      ? '1527624229548195911'
      : (process.env.FORWARDER_DESTINATION_CHANNEL_ID || ''),
    deprecatedDestinationChannelIds: mode === 'legacy' ? ['1491800679495241844'] : [],
    targetUserId: mode === 'legacy'
      ? '688079587728556043'
      : (process.env.FORWARDER_TARGET_USER_ID || ''),
  },
};
