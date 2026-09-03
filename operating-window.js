// Keeps the Discord Gateway connection inside an optional daily window.
// The HTTP keepalive server remains available so Render can wake the process.
const { formatSchedule, isScheduleActive, normalizeSchedule, scheduleFromWindow } = require('./backend-schedule');

function parseClock(value) {
  const match = String(value || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) throw new Error(`Invalid clock time: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function parseWindow(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (!match) throw new Error('BOT_ACTIVE_WINDOW must look like 04:50-23:30');
  const start = parseClock(match[1]);
  const end = parseClock(match[2]);
  if (start === end) throw new Error('BOT_ACTIVE_WINDOW start and end cannot be equal');
  return { start, end };
}

function localMinutes(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find(part => part.type === 'hour')?.value);
  const minute = Number(parts.find(part => part.type === 'minute')?.value);
  return hour * 60 + minute;
}

function isWithinWindow(minutes, window) {
  if (window.start < window.end) return minutes >= window.start && minutes < window.end;
  return minutes >= window.start || minutes < window.end;
}

function startOperatingWindow(client, token, options = {}) {
  const raw = options.window || process.env.BOT_ACTIVE_WINDOW || '04:50-23:30';
  const alwaysOn = /^(?:always|24\/?7)$/i.test(String(raw).trim());
  const timezone = options.timezone || process.env.BOT_ACTIVE_TIMEZONE || 'Asia/Dhaka';
  const now = options.now || (() => new Date());
  const intervalMs = options.intervalMs || 30 * 1000;
  const setTimer = options.setInterval || setInterval;
  const clearTimer = options.clearInterval || clearInterval;
  const scheduleProvider = options.scheduleProvider;
  const refreshEveryMs = Math.max(30000, Number(options.refreshEveryMs || 5 * 60 * 1000));
  const loginTimeoutMs = Math.max(5000, Number(options.loginTimeoutMs || 45 * 1000));
  const restartAfterMs = Math.max(loginTimeoutMs * 2, Number(options.restartAfterMs || 5 * 60 * 1000));
  const clockMs = options.clockMs || Date.now;
  const exit = options.exit || (code => process.exit(code));
  const health = options.health;

  if (!raw) {
    client.login(token);
    return { mode: 'always-on', stop() {} };
  }

  const window = alwaysOn ? null : parseWindow(raw);
  let schedule = options.schedule
    ? normalizeSchedule(options.schedule)
    : scheduleFromWindow(alwaysOn ? '00:00-23:59' : raw, timezone);
  let connecting = false;
  let expectedOnline = false;
  let reconciling = false;
  let lastRefresh = Date.now();
  let unreadySince = null;
  let restartRequested = false;

  const markDisconnected = issue => {
    if (expectedOnline) health?.markDisconnected?.(issue, now());
  };

  const loginWithTimeout = async () => {
    let timeout;
    try {
      return await Promise.race([
        client.login(token),
        new Promise((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(`Discord login timed out after ${loginTimeoutMs}ms`)), loginTimeoutMs);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  const refreshSchedule = async () => {
    if (!scheduleProvider || Date.now() - lastRefresh < refreshEveryMs) return;
    lastRefresh = Date.now();
    try { schedule = normalizeSchedule(await scheduleProvider()); }
    catch (err) { console.error('[window] Backend schedule refresh failed:', err.message); }
  };

  const reconcile = async () => {
    if (reconciling) return;
    reconciling = true;
    try {
      await refreshSchedule();
      const shouldBeOnline = alwaysOn || isScheduleActive(schedule, now());
      if (shouldBeOnline) {
        expectedOnline = true;
        health?.update?.({ expectedOnline: true, phase: 'running' });
        if (client.isReady?.()) {
          unreadySince = null;
          health?.markReady?.(now());
          return;
        }
        if (connecting) return;
        if (unreadySince === null) unreadySince = clockMs();
        if (!restartRequested && clockMs() - unreadySince >= restartAfterMs) {
          restartRequested = true;
          health?.markFailure?.('discord_watchdog_restart');
          console.error(`[window] Discord remained unavailable for ${Math.round(restartAfterMs / 1000)} seconds; restarting for a clean gateway session`);
          exit(1);
          return;
        }
        connecting = true;
        try {
          await loginWithTimeout();
          if (client.isReady?.()) {
            unreadySince = null;
            health?.markReady?.(now());
          }
        }
        catch (err) {
          health?.markFailure?.(err.message.includes('timed out') ? 'discord_login_timeout' : 'discord_login_failed');
          console.error('[window] Discord login failed:', err.message);
          try { client.destroy(); }
          catch (destroyError) { console.error('[window] Discord session reset failed:', destroyError.message); }
        }
        finally { connecting = false; }
        return;
      }

      expectedOnline = false;
      unreadySince = null;
      restartRequested = false;
      health?.update?.({ expectedOnline: false, phase: 'running', discordReady: false, issue: null, consecutiveFailures: 0 });
      if (client.isReady?.() || connecting) {
        try { client.destroy(); }
        catch (err) { console.error('[window] Discord disconnect failed:', err.message); }
        connecting = false;
        const shown = formatSchedule(schedule);
        console.log(`[window] Discord offline outside ${shown.windows} ${schedule.timezone}`);
      }
    } finally {
      reconciling = false;
    }
  };

  client.on?.('clientReady', () => {
    if (expectedOnline) {
      unreadySince = null;
      health?.markReady?.(now());
          const shown = formatSchedule(schedule);
          console.log(alwaysOn
            ? `[window] Discord online in continuous failover mode ${schedule.timezone}`
            : `[window] Discord online inside ${shown.windows} ${schedule.timezone}`);
    }
  });
  client.on?.('shardDisconnect', () => markDisconnected('discord_shard_disconnected'));
  client.on?.('shardError', () => markDisconnected('discord_shard_error'));
  client.on?.('invalidated', () => markDisconnected('discord_session_invalidated'));
  client.on?.('error', () => markDisconnected('discord_client_error'));
  reconcile();
  const timer = setTimer(reconcile, intervalMs);
  timer.unref?.();
  return {
    mode: alwaysOn ? 'always-on-watchdog' : 'scheduled',
    window,
    get schedule() { return schedule; },
    timezone: schedule.timezone,
    stop() { clearTimer(timer); },
    reconcile,
    async setSchedule(value) {
      schedule = normalizeSchedule(value);
      lastRefresh = Date.now();
      await reconcile();
      return schedule;
    },
  };
}

module.exports = {
  isWithinWindow,
  localMinutes,
  parseClock,
  parseWindow,
  startOperatingWindow,
};
