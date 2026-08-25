const { cohorts } = require('./config');

const CACHE_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;
const MINIMUM_INTAKE_BACKEND_VERSION = 36;
const cache = new Map();

function backendVersionNumber(value) {
  const match = String(value || '').trim().match(/^v(\d+)$/i);
  return match ? Number(match[1]) : null;
}

function slugify(value) {
  return String(value || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function stateKey(cohort) {
  return `intake_portal_v1_${cohort.guildId}`;
}

function defaultSettings(cohort) {
  return { enabled: false, slug: slugify(cohort.registryKey || cohort.name) };
}

function normalizeSettings(cohort, value) {
  const fallback = defaultSettings(cohort);
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const slug = slugify(input.slug) || fallback.slug;
  return { enabled: input.enabled === true, slug };
}

async function parseResponse(response, label) {
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`${label} returned invalid JSON (HTTP ${response.status})`); }
  if (!response.ok || data?.error) throw new Error(data?.error || `${label} failed (HTTP ${response.status})`);
  return data;
}

async function getIntakeSettings(cohort, force = false) {
  const cached = cache.get(cohort.guildId);
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const url = new URL(cohort.appsScriptUrl);
  url.searchParams.set('action', 'getstate');
  url.searchParams.set('key', cohort.apiKey);
  url.searchParams.set('k', stateKey(cohort));
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = (await parseResponse(response, 'Intake settings read')).value || '';
  let parsed = {};
  if (raw) {
    try { parsed = JSON.parse(raw); }
    catch { throw new Error('Saved intake settings are invalid; disable/re-enable the intake portal'); }
  }
  const value = normalizeSettings(cohort, parsed);
  cache.set(cohort.guildId, { at: Date.now(), value });
  return value;
}

async function setIntakeSettings(cohort, value) {
  const normalized = normalizeSettings(cohort, value);
  const response = await fetch(cohort.appsScriptUrl, {
    method: 'POST',
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: cohort.apiKey,
      action: 'setState',
      k: stateKey(cohort),
      v: JSON.stringify(normalized),
    }),
  });
  await parseResponse(response, 'Intake settings write');
  cache.set(cohort.guildId, { at: Date.now(), value: normalized });
  return normalized;
}

async function validateIntakeBackend(cohort) {
  const url = new URL(cohort.appsScriptUrl);
  url.searchParams.set('action', 'health');
  url.searchParams.set('key', cohort.apiKey);
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const health = await parseResponse(response, 'Intake backend health');
  const version = backendVersionNumber(health.version);
  if (version === null || version < MINIMUM_INTAKE_BACKEND_VERSION) {
    throw new Error(
      `Apps Script ${health.version || 'unknown'} is installed; deploy v${MINIMUM_INTAKE_BACKEND_VERSION} or later before opening intake`,
    );
  }
  return health;
}

function portalConfigProblems(env = process.env) {
  const problems = [];
  if (!String(env.DISCORD_TOKEN || '').trim()) problems.push('DISCORD_TOKEN');
  if (!/^\d{15,22}$/.test(String(env.DISCORD_CLIENT_ID || ''))) problems.push('DISCORD_CLIENT_ID');
  if (!String(env.DISCORD_CLIENT_SECRET || '').trim()) problems.push('DISCORD_CLIENT_SECRET');
  if (String(env.INTAKE_SESSION_SECRET || '').trim().length < 32) problems.push('INTAKE_SESSION_SECRET (32+ characters)');
  try {
    const url = new URL(String(env.INTAKE_PUBLIC_URL || ''));
    if (url.protocol !== 'https:') throw new Error('HTTPS required');
  } catch {
    problems.push('INTAKE_PUBLIC_URL (HTTPS Render URL)');
  }
  return problems;
}

function portalBaseUrl(env = process.env) {
  const url = new URL(String(env.INTAKE_PUBLIC_URL || ''));
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

async function resolveEnabledCohort(slug) {
  const normalized = slugify(slug);
  for (const cohort of cohorts) {
    const settings = await getIntakeSettings(cohort);
    if (settings.enabled && settings.slug === normalized) return { cohort, settings };
  }
  return null;
}

async function findSlugOwner(slug, excludeGuildId = '') {
  const normalized = slugify(slug);
  if (!normalized) return null;
  for (const cohort of cohorts) {
    if (cohort.guildId === excludeGuildId) continue;
    const settings = await getIntakeSettings(cohort);
    if (settings.slug === normalized) return { cohort, settings };
  }
  return null;
}

module.exports = {
  MINIMUM_INTAKE_BACKEND_VERSION,
  backendVersionNumber,
  defaultSettings,
  findSlugOwner,
  getIntakeSettings,
  normalizeSettings,
  portalBaseUrl,
  portalConfigProblems,
  resolveEnabledCohort,
  setIntakeSettings,
  slugify,
  stateKey,
  validateIntakeBackend,
};
