// Runtime-editable daily scheduling. Each feature registers a one-minute tick,
// reads its guild-scoped time from settings, and fires at most once per local
// calendar day. This lets !time changes apply without restarting Render.
const cron = require('node-cron');

const fired = new Map();

function normalizeTime(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return '';
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return '';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function localClock(timezone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
    dayOfMonth: Number(values.day),
  };
}

function clockMinutes(value) {
  const normalized = normalizeTime(value);
  if (!normalized) return NaN;
  const [hour, minute] = normalized.split(':').map(Number);
  return hour * 60 + minute;
}

function dueToken(cohort, taskKey, configuredTime, now = new Date(), options = {}) {
  const time = normalizeTime(configuredTime);
  if (!time) return '';
  const local = localClock(cohort.timezone, now);
  const graceMinutes = Math.max(0, Math.min(180, Number(options.graceMinutes || 0)));
  const elapsed = clockMinutes(local.time) - clockMinutes(time);
  if (elapsed < 0 || elapsed > graceMinutes) return '';
  return `${cohort.guildId}:${taskKey}:${local.date}:${time}`;
}

async function runIfDue(cohort, taskKey, configuredTime, handler, now = new Date(), options = {}) {
  const token = dueToken(cohort, taskKey, configuredTime, now, options);
  if (!token || fired.has(token)) return false;
  fired.set(token, Date.now());
  // Bound memory even for a long-lived process.
  if (fired.size > 500) {
    const oldest = [...fired.entries()].sort((a, b) => a[1] - b[1]).slice(0, 200);
    for (const [key] of oldest) fired.delete(key);
  }
  try {
    await handler();
    return true;
  } catch (error) {
    // A failed task may be retried manually, but never automatically duplicated
    // inside the same minute/day.
    throw error;
  }
}

function scheduleAtSetting(cohort, taskKey, settingKey, handler, options = {}) {
  cron.schedule('* * * * *', async () => {
    try {
      const { getSetting } = require('./settings');
      const time = await getSetting(cohort, settingKey);
      const now = new Date();
      if (!dueToken(cohort, taskKey, time, now, options)) return;
      const { getCalendarDay } = require('./work-calendar');
      if (!(await getCalendarDay(cohort, now)).working) return;
      await runIfDue(cohort, taskKey, time, handler, now, options);
    } catch (error) {
      console.error(`[schedule] ${cohort.name}/${taskKey} failed:`, error.message);
    }
  }, { timezone: cohort.timezone });
}

// Maintenance reconciliations must run on calendar days too: they repair
// already-posted Discord activity and do not publish student-facing reports.
function scheduleAtSettingEveryDay(cohort, taskKey, settingKey, handler, options = {}) {
  cron.schedule('* * * * *', async () => {
    try {
      const { getSetting } = require('./settings');
      const time = await getSetting(cohort, settingKey);
      const now = new Date();
      if (!dueToken(cohort, taskKey, time, now, options)) return;
      await runIfDue(cohort, taskKey, time, handler, now, options);
    } catch (error) {
      console.error(`[schedule] ${cohort.name}/${taskKey} failed:`, error.message);
    }
  }, { timezone: cohort.timezone });
}

function scheduleEveryMinute(cohort, taskKey, handler) {
  return cron.schedule('* * * * *', async () => {
    try {
      await handler();
    } catch (error) {
      console.error(`[schedule] ${cohort.name}/${taskKey} failed:`, error.message);
    }
  }, { timezone: cohort.timezone });
}

module.exports = {
  dueToken,
  localClock,
  normalizeTime,
  runIfDue,
  scheduleAtSetting,
  scheduleAtSettingEveryDay,
  scheduleEveryMinute,
};
