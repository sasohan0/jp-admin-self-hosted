// Shared, secret-safe Apps Script JSON transport.
// Google occasionally returns an HTML 404/5xx page before a Web App request
// reaches doGet/doPost. Read operations and explicitly idempotent writes retry
// with bounded backoff so a brief edge failure does not drop an attendance or
// outreach operation.

const TRANSIENT_STATUS = new Set([404, 408, 409, 425, 429, 500, 502, 503, 504]);
// Roster and workbook audits can legitimately take tens of seconds. Keep the
// request bounded without imposing a short interactive timeout on Sheet work.
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MUTATION_TIMEOUT_MS = 180000;
const DEFAULT_RETRY_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [750, 2000, 5000, 10000];
const cohortMutationChains = new Map();

// These legacy GET actions change Apps Script/Sheet state. Keep them in the
// same per-cohort lane as POST writes so a report cannot overlap a roster sync
// and turn one slow request into a lock/retry storm.
const MUTATING_GET_ACTIONS = new Set([
  'attendance', 'closeform', 'nextquestion', 'nextresource', 'openform',
  'setactiveform',
]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requireCohort(cohort) {
  if (!cohort?.appsScriptUrl || !cohort?.apiKey) {
    throw new Error('Apps Script backend is not configured for this cohort');
  }
}

function safeMessage(label, response, parsed) {
  if (parsed?.error) return `${label}: ${String(parsed.error).slice(0, 300)}`;
  if (!parsed) return `${label} returned HTTP ${response.status} with non-JSON content`;
  return `${label} returned HTTP ${response.status}`;
}

function shouldRetry(error) {
  if (error?.transient === true) return true;
  const name = String(error?.name || '');
  return name === 'AbortError' || name === 'TimeoutError' || error instanceof TypeError;
}

async function requestJson(cohort, options = {}) {
  requireCohort(cohort);
  const method = String(options.method || 'GET').toUpperCase();
  const retryable = method === 'GET' || options.idempotent === true;
  const attempts = Math.max(1, Number(options.attempts || (retryable ? DEFAULT_RETRY_ATTEMPTS : 1)));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  const fetchImpl = options.fetchImpl || fetch;
  const sleepImpl = options.sleepImpl || sleep;
  const label = String(options.label || 'Apps Script');
  let lastError;
  let usedAttempts = 0;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    usedAttempts = attempt;
    try {
      const url = new URL(cohort.appsScriptUrl);
      // Google Web Apps occasionally serve a cached HTML 404 at the edge even
      // while the deployment itself is healthy. Give retries a distinct URL
      // without changing the Apps Script action or payload.
      if (attempt > 1) {
        url.searchParams.set('_jpAttempt', String(attempt));
        url.searchParams.set('_jpNonce', String(Date.now()));
      }
      const init = {
        method,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      };
      if (method === 'GET') {
        for (const [key, value] of Object.entries({ key: cohort.apiKey, ...(options.params || {}) })) {
          if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
        }
      } else {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify({ key: cohort.apiKey, ...(options.body || {}) });
      }

      const response = await fetchImpl(url.toString(), init);
      const text = await response.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* handled below */ }
      if (response.ok && data && !data.error) return data;

      const error = new Error(safeMessage(label, response, data));
      error.transient = !data && (response.ok || TRANSIENT_STATUS.has(response.status));
      throw error;
    } catch (error) {
      lastError = error;
      if (!retryable || attempt >= attempts || !shouldRetry(error)) break;
      await sleepImpl(RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]);
    }
  }

  const suffix = usedAttempts > 1 ? ` after ${usedAttempts} attempts` : '';
  const finalError = new Error(`${String(lastError?.message || `${label} request failed`)}${suffix}`);
  finalError.transient = shouldRetry(lastError);
  finalError.attempts = usedAttempts;
  throw finalError;
}

function appsScriptGet(cohort, params, options = {}) {
  const request = () => requestJson(cohort, { ...options, method: 'GET', params });
  return options.exclusive === true || MUTATING_GET_ACTIONS.has(String(params?.action || ''))
    ? runCohortMutation(cohort, request)
    : request();
}

function appsScriptPost(cohort, body, options = {}) {
  const request = () => requestJson(cohort, {
    timeoutMs: DEFAULT_MUTATION_TIMEOUT_MS,
    ...options,
    method: 'POST',
    body,
  });
  return options.exclusive === false ? request() : runCohortMutation(cohort, request);
}

function runCohortMutation(cohort, task) {
  const key = String(cohort?.appsScriptUrl || cohort?.guildId || '');
  const previous = cohortMutationChains.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  const tracked = current.finally(() => {
    if (cohortMutationChains.get(key) === tracked) cohortMutationChains.delete(key);
  });
  cohortMutationChains.set(key, tracked);
  return tracked;
}

module.exports = {
  TRANSIENT_STATUS,
  DEFAULT_RETRY_ATTEMPTS,
  DEFAULT_MUTATION_TIMEOUT_MS,
  RETRY_DELAYS_MS,
  MUTATING_GET_ACTIONS,
  appsScriptGet,
  appsScriptPost,
  requestJson,
  runCohortMutation,
  shouldRetry,
};
