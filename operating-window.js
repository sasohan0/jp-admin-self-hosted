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
  const timezone = options.timezone || process.env.BOT_ACTIVE_TIMEZONE || 'Asia/Dhaka';
  const now = options.now || (() => new Date());
  const intervalMs = options.intervalMs || 30 * 1000;
  const setTimer = options.setInterval || setInterval;
  const clearTimer = options.clearInterval || clearInterval;
  const scheduleProvider = options.scheduleProvider;
  const refreshEveryMs = Math.max(30000, Number(options.refreshEveryMs || 5 * 60 * 1000));

  if (!raw) {
    client.login(token);
    return { mode: 'always-on', stop() {} };
  }

  const window = parseWindow(raw);
  let schedule = options.schedule
    ? normalizeSchedule(options.schedule)
    : scheduleFromWindow(raw, timezone);
  let connecting = false;
  let expectedOnline = false;
  let reconciling = false;
  let lastRefresh = Date.now();

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
      const shouldBeOnline = isScheduleActive(schedule, now());
      if (shouldBeOnline) {
        expectedOnline = true;
        if (client.isReady?.() || connecting) return;
        connecting = true;
        try { await client.login(token); }
        catch (err) { console.error('[window] Discord login failed:', err.message); }
        finally { connecting = false; }
        return;
      }

      expectedOnline = false;
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
      const shown = formatSchedule(schedule);
      console.log(`[window] Discord online inside ${shown.windows} ${schedule.timezone}`);
    }
  });
  reconcile();
  const timer = setTimer(reconcile, intervalMs);
  timer.unref?.();
  return {
    mode: 'scheduled',
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
