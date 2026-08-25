// Shared, rate-limit-aware bulk Discord member fetch.
//
// Discord uses gateway opcode 8 for a full guild member request. Repeating
// that request for every onboarding answer can be rate limited. Keep one
// in-flight request per guild, reuse a recent successful result, and retry a
// bounded rate-limit response without letting it become an unhandled promise.

const recent = new Map(); // guildId -> { at, members }
const inFlight = new Map(); // guildId -> Promise<Collection>

const DEFAULT_FRESH_MS = 2 * 60 * 1000;
const DEFAULT_MAX_RETRIES = 2;

function gatewayRetryDelayMs(error, fallbackMs = 30000) {
  const candidates = [
    error?.retryAfter,
    error?.retry_after,
    error?.data?.retry_after,
    error?.rawError?.retry_after,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (!Number.isFinite(value) || value <= 0) continue;
    return Math.min(60000, Math.max(1000, value < 1000 ? value * 1000 : value));
  }
  const match = String(error?.message || '').match(/retry after\s+([\d.]+)\s*seconds?/i);
  if (match) return Math.min(60000, Math.max(1000, Number(match[1]) * 1000));
  return fallbackMs;
}

function isGatewayMemberRateLimit(error) {
  return error?.name === 'GatewayRateLimitError' ||
    /opcode\s*8.*rate limit|gatewayratelimiterror|rate limited/i.test(String(error?.message || ''));
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(guild, options) {
  let lastError;
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      const members = await guild.members.fetch({ time: options.timeoutMs });
      recent.set(guild.id, { at: Date.now(), members });
      return members;
    } catch (error) {
      lastError = error;
      if (!isGatewayMemberRateLimit(error) || attempt === options.maxRetries) throw error;
      await wait(gatewayRetryDelayMs(error) + 500);
    }
  }
  throw lastError;
}

function fetchGuildMembers(guild, options = {}) {
  if (!guild?.id || !guild.members?.fetch) {
    return Promise.reject(new Error('Discord guild member manager is unavailable'));
  }
  const freshMs = Number.isFinite(options.freshMs) ? options.freshMs : DEFAULT_FRESH_MS;
  const cached = recent.get(guild.id);
  if (!options.force && cached && Date.now() - cached.at <= freshMs) {
    return Promise.resolve(cached.members);
  }
  if (inFlight.has(guild.id)) return inFlight.get(guild.id);

  const request = fetchWithRetry(guild, {
    maxRetries: Number.isInteger(options.maxRetries) ? options.maxRetries : DEFAULT_MAX_RETRIES,
    timeoutMs: Number.isInteger(options.timeoutMs) ? options.timeoutMs : 60000,
  });
  inFlight.set(guild.id, request);
  request.then(
    () => { if (inFlight.get(guild.id) === request) inFlight.delete(guild.id); },
    () => { if (inFlight.get(guild.id) === request) inFlight.delete(guild.id); },
  );
  return request;
}

function clearGuildMemberCache(guildId) {
  recent.delete(String(guildId || ''));
}

module.exports = {
  clearGuildMemberCache,
  fetchGuildMembers,
  gatewayRetryDelayMs,
  isGatewayMemberRateLimit,
};
