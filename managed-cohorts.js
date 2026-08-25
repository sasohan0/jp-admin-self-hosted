// Durable cohort registry stored in the configured control cohort's Apps Script
// state. Environment registry values remain the safe bootstrap/fallback.
const { cohortDefaults, cohorts, mode } = require('./config');
const { appsScriptGet, appsScriptPost } = require('./apps-script-api');

const STATE_KEY_PREFIX = 'managed_cohort_registry_v1';
const MAX_COHORTS = 3;
const MAX_STATE_BYTES = 8500;
const REQUEST_TIMEOUT_MS = 15000;
const STARTUP_RETRY_DELAY_MS = 30000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanText(value, max) {
  return String(value || '').trim().slice(0, max);
}

function requiredText(value, max, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} is required`);
  if (text.length > max) throw new Error(`${label} must be ${max} characters or fewer`);
  return text;
}

function normalizeSupervisorIds(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  return [...new Set(values.map(String).map(item => item.trim()).filter(Boolean))];
}

function normalizeChannels(value, label) {
  if (value === undefined || value === null || value === '') return {};
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${label}.channels must be an object`);
  }
  const channels = {};
  for (const [key, id] of Object.entries(value)) {
    if (!/^\d{15,20}$/.test(String(id))) continue;
    channels[cleanText(key, 50)] = String(id);
  }
  return channels;
}

function validateAppsScriptUrl(value, label) {
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch { throw new Error(`${label}.appsScriptUrl must be a valid URL`); }
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com' || !/\/macros\/s\/[^/]+\/exec$/.test(url.pathname)) {
    throw new Error(`${label}.appsScriptUrl must be a deployed Google Apps Script /exec URL`);
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

function normalizeManagedEntries(entries) {
  if (!Array.isArray(entries)) throw new Error('Managed cohort registry must be an array');
  if (!entries.length) throw new Error('Managed cohort registry cannot be empty');
  if (entries.length > MAX_COHORTS) throw new Error(`Managed cohort registry supports at most ${MAX_COHORTS} cohorts`);

  const keys = new Set();
  const names = new Set();
  const guildIds = new Set();
  return entries.map((entry, index) => {
    const label = `managed registry[${index}]`;
    if (!entry || Array.isArray(entry) || typeof entry !== 'object') throw new Error(`${label} must be an object`);
    const registryKey = requiredText(entry.registryKey || entry.key, 32, `${label}.key`).toLowerCase();
    const name = requiredText(entry.name, 80, `${label}.name`);
    const guildId = requiredText(entry.guildId, 20, `${label}.guildId`);
    const supervisorIds = normalizeSupervisorIds(entry.supervisorIds);
    const apiKey = requiredText(entry.apiKey, 1000, `${label}.apiKey`);

    if (!/^[a-z0-9_]+$/.test(registryKey)) throw new Error(`${label}.key is invalid`);
    if (!/^\d{15,20}$/.test(guildId)) throw new Error(`${label}.guildId must be a Discord server ID`);
    if (!supervisorIds.length || !supervisorIds.every(id => /^\d{15,20}$/.test(id))) {
      throw new Error(`${label}.supervisorIds must contain Discord user IDs`);
    }
    if (keys.has(registryKey)) throw new Error(`Duplicate managed cohort key: ${registryKey}`);
    if (names.has(name.toLowerCase())) throw new Error(`Duplicate managed cohort name: ${name}`);
    if (guildIds.has(guildId)) throw new Error(`Duplicate managed Discord server ID: ${guildId}`);
    keys.add(registryKey);
    names.add(name.toLowerCase());
    guildIds.add(guildId);

    return {
      registryKey,
      name,
      guildId,
      supervisorIds,
      appsScriptUrl: validateAppsScriptUrl(entry.appsScriptUrl, label),
      apiKey,
      timezone: cleanText(entry.timezone, 80) || 'Asia/Dhaka',
      channels: normalizeChannels(entry.channels, label),
      formOpenReminder: cleanText(entry.formOpenReminder, 100),
      formCloseReminder: cleanText(entry.formCloseReminder, 100),
      outreachCheckCron: cleanText(entry.outreachCheckCron, 100),
      jobsCheckCron: cleanText(entry.jobsCheckCron, 100),
      workshopMeetUrl: cleanText(entry.workshopMeetUrl, 1000),
      workshopGptUrl: cleanText(entry.workshopGptUrl, 1000),
    };
  });
}

function buildManagedCohorts(entries) {
  return normalizeManagedEntries(entries).map(entry => cohortDefaults(entry));
}

function serializeCohort(cohort) {
  return {
    registryKey: cohort.registryKey,
    name: cohort.name,
    guildId: cohort.guildId,
    supervisorIds: [...cohort.supervisorIds],
    appsScriptUrl: cohort.appsScriptUrl,
    apiKey: cohort.apiKey,
    timezone: cohort.timezone,
    channels: { ...(cohort.channels || {}) },
    formOpenReminder: cohort.formOpenReminder,
    formCloseReminder: cohort.formCloseReminder,
    outreachCheckCron: cohort.outreachCheckCron,
    jobsCheckCron: cohort.jobs?.checkCron,
    workshopMeetUrl: cohort.workshopSessions?.meetUrl,
    workshopGptUrl: cohort.workshopSessions?.speakMoreUrl,
  };
}

function controlKey() {
  return cleanText(process.env.COHORT_CONTROL_KEY, 32).toLowerCase();
}

function controlCohort() {
  const key = controlKey();
  if (!key) return null;
  const cohort = cohorts.find(item => item.registryKey === key);
  if (!cohort) throw new Error(`COHORT_CONTROL_KEY=${key} is not present in the bootstrap registry`);
  return cohort;
}

function stateKey(control) {
  return `${STATE_KEY_PREFIX}_${control.guildId}`;
}

async function readManagedState(control) {
  const data = await appsScriptGet(control, {
    action: 'getstate',
    k: stateKey(control),
  }, {
    label: 'Managed registry read',
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  return data.value || '';
}

async function writeManagedState(control, entries) {
  const normalized = normalizeManagedEntries(entries);
  const value = JSON.stringify(normalized);
  if (Buffer.byteLength(value, 'utf8') > MAX_STATE_BYTES) {
    throw new Error('Managed cohort registry is too large to save');
  }
  await appsScriptPost(control, {
    action: 'setState',
    k: stateKey(control),
    v: value,
  }, {
    idempotent: true,
    label: 'Managed registry write',
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  return normalized;
}

async function loadManagedCohorts() {
  const control = controlCohort();
  if (!control) return { enabled: false, source: 'environment', count: cohorts.length };
  if (mode !== 'multi') throw new Error('COHORT_CONTROL_KEY requires COHORT_REGISTRY_JSON mode');

  const raw = await readManagedState(control);
  if (!raw) {
    const seeded = await writeManagedState(control, cohorts.map(serializeCohort));
    return { enabled: true, source: 'seeded', count: seeded.length };
  }

  let entries;
  try { entries = JSON.parse(raw); }
  catch { throw new Error('Managed registry state is invalid JSON; Discord login stopped to avoid stale cohort routing'); }
  const managed = buildManagedCohorts(entries);
  const managedControl = managed.find(item => item.registryKey === control.registryKey);
  if (!managedControl) throw new Error(`Managed registry cannot retire its control cohort (${control.name})`);

  // The control backend stays anchored to Render bootstrap credentials so an
  // accidental modal edit cannot lock the bot out of its registry.
  managedControl.appsScriptUrl = control.appsScriptUrl;
  managedControl.apiKey = control.apiKey;
  cohorts.splice(0, cohorts.length, ...managed);
  return { enabled: true, source: 'stored', count: managed.length };
}

async function loadManagedCohortsWithRetry(options = {}) {
  const load = options.load || loadManagedCohorts;
  const wait = options.wait || sleep;
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? STARTUP_RETRY_DELAY_MS));
  const maxAttempts = options.maxAttempts === undefined
    ? Infinity
    : Math.max(1, Number(options.maxAttempts));
  const onRetry = typeof options.onRetry === 'function' ? options.onRetry : () => {};
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      return await load();
    } catch (error) {
      if (error?.transient !== true || attempt >= maxAttempts) throw error;
      onRetry(error, { attempt, retryDelayMs });
      await wait(retryDelayMs);
    }
  }

  throw new Error('Managed cohort registry retry loop ended unexpectedly');
}

async function saveCurrentCohorts(entries) {
  const control = controlCohort();
  if (!control) throw new Error('Managed cohorts are not enabled; set COHORT_CONTROL_KEY once in Render');
  const normalized = await writeManagedState(control, entries);
  return buildManagedCohorts(normalized);
}

module.exports = {
  MAX_COHORTS,
  STATE_KEY_PREFIX,
  buildManagedCohorts,
  controlCohort,
  loadManagedCohorts,
  loadManagedCohortsWithRetry,
  normalizeManagedEntries,
  saveCurrentCohorts,
  serializeCohort,
  stateKey,
  validateAppsScriptUrl,
};
