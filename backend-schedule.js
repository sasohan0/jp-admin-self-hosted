'use strict';

const DAY_MAP = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2,
  wed: 3, wednesday: 3, thu: 4, thursday: 4, fri: 5, friday: 5,
  sat: 6, saturday: 6,
};
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULT_SCHEDULE = Object.freeze({
  version: 2,
  timezone: 'Asia/Dhaka',
  windows: Object.freeze([{ start: '04:50', end: '23:30' }]),
  days: Object.freeze([0, 1, 2, 3, 4, 5, 6]),
  dates: Object.freeze([]),
  overrides: Object.freeze({}),
  wakeLeadMinutes: 10,
});

function clockMinutes(value) {
  const match = String(value || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) throw new Error(`Invalid time: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function normalizeClock(value) {
  const minutes = clockMinutes(value);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function parseWindows(value) {
  const parts = String(value || '').split(',').map(item => item.trim()).filter(Boolean);
  if (!parts.length || parts.length > 4) throw new Error('Provide one to four time windows');
  const windows = parts.map(part => {
    const match = part.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
    if (!match) throw new Error('Windows must look like `04:00-23:00`');
    const start = normalizeClock(match[1]);
    const end = normalizeClock(match[2]);
    if (start === end) throw new Error('A backend window cannot cover zero hours');
    return { start, end };
  });
  return windows;
}

function validDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function parseDays(value) {
  const text = String(value || '').trim().toLowerCase();
  if (['everyday', 'every day', 'all'].includes(text)) return [0, 1, 2, 3, 4, 5, 6];
  if (['weekdays', 'weekday', 'sun-thu'].includes(text)) return [0, 1, 2, 3, 4];
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (!parts.length || parts.some(part => DAY_MAP[part] === undefined)) {
    throw new Error('Days must be `everyday`, `weekdays`, or a list such as `mon,wed,fri`');
  }
  return [...new Set(parts.map(part => DAY_MAP[part]))].sort((a, b) => a - b);
}

function normalizeSchedule(value = {}) {
  const timezone = String(value.timezone || DEFAULT_SCHEDULE.timezone).trim().slice(0, 80);
  const windows = Array.isArray(value.windows)
    ? parseWindows(value.windows.map(item => `${item.start}-${item.end}`).join(','))
    : parseWindows(DEFAULT_SCHEDULE.windows.map(item => `${item.start}-${item.end}`).join(','));
  const days = Array.isArray(value.days) && value.days.length && value.days.every(day => Number.isInteger(day) && day >= 0 && day <= 6)
    ? [...new Set(value.days)].sort((a, b) => a - b)
    : [...DEFAULT_SCHEDULE.days];
  const dates = Array.isArray(value.dates)
    ? [...new Set(value.dates.map(String).filter(validDate))].sort().slice(0, 120)
    : [];
  const overrides = {};
  if (value.overrides && !Array.isArray(value.overrides) && typeof value.overrides === 'object') {
    for (const [date, state] of Object.entries(value.overrides)) {
      if (!validDate(date)) continue;
      if (['on', 'off', 'always'].includes(state)) overrides[date] = state;
      else if (state && typeof state === 'object' && !Array.isArray(state) && Array.isArray(state.windows)) {
        overrides[date] = { windows: parseWindows(state.windows.map(item => `${item.start}-${item.end}`).join(',')) };
      }
    }
  }
  return { version: 2, timezone, windows, days, dates, overrides, wakeLeadMinutes: 10 };
}

function scheduleFromWindow(window, timezone = 'Asia/Dhaka') {
  return normalizeSchedule({ timezone, windows: parseWindows(window) });
}

function zonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minutes: Number(values.hour) * 60 + Number(values.minute),
    day: DAY_NAMES.map(name => name.toLowerCase()).indexOf(String(values.weekday || '').slice(0, 3).toLowerCase()),
  };
}

function minuteInWindow(minutes, window) {
  const start = clockMinutes(window.start);
  const end = clockMinutes(window.end);
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function isScheduleActive(scheduleValue, now = new Date(), options = {}) {
  const schedule = normalizeSchedule(scheduleValue);
  const shifted = new Date(now.getTime() + Number(options.leadMinutes || 0) * 60000);
  const local = zonedParts(shifted, schedule.timezone);
  const override = schedule.overrides[local.date];
  if (override === 'off') return false;
  if (override === 'always') return true;
  if (override && typeof override === 'object') {
    return override.windows.some(window => minuteInWindow(local.minutes, window));
  }
  const dateAllowed = override === 'on' || (override !== 'off' && (
    schedule.dates.length ? schedule.dates.includes(local.date) : schedule.days.includes(local.day)
  ));
  return dateAllowed && schedule.windows.some(window => minuteInWindow(local.minutes, window));
}

function parseBackendCommand(value) {
  const text = String(value || '').trim();
  if (!/^!backend(?:\s|$)/i.test(text)) return null;
  if (/^!backend(?:\s+(?:status|help))?$/i.test(text)) {
    return { action: /help$/i.test(text) ? 'help' : 'status' };
  }
  let match = text.match(/^!backend\s+windows?\s+(.+)$/i);
  if (match) return { action: 'windows', windows: parseWindows(match[1]) };
  match = text.match(/^!backend\s+days?\s+(.+)$/i);
  if (match) return { action: 'days', days: parseDays(match[1]) };
  match = text.match(/^!backend\s+date\s+(\d{4}-\d{2}-\d{2})\s+(on|off|clear)$/i);
  if (match) {
    if (!validDate(match[1])) throw new Error('Use a real YYYY-MM-DD date');
    return { action: 'date', date: match[1], state: match[2].toLowerCase() };
  }
  match = text.match(/^!backend\s+override\s+([^\s]+)\s+(.+)$/i);
  if (match) {
    const dates = [...new Set(match[1].split(',').map(item => item.trim()).filter(Boolean))];
    if (!dates.length || dates.some(date => !validDate(date))) {
      throw new Error('Override dates must use `YYYY-MM-DD`, separated by commas');
    }
    const rawOverride = match[2].trim().toLowerCase();
    let override;
    if (['always', 'off', 'clear'].includes(rawOverride)) override = rawOverride;
    else override = { windows: parseWindows(match[2]) };
    return { action: 'override', dates: dates.slice(0, 30).sort(), override };
  }
  match = text.match(/^!backend\s+dates\s+(.+)$/i);
  if (match) {
    if (match[1].trim().toLowerCase() === 'clear') return { action: 'dates', dates: [] };
    const dates = [...new Set(match[1].split(/[\s,]+/).filter(Boolean))];
    if (!dates.length || dates.some(date => !validDate(date))) throw new Error('Dates must use `YYYY-MM-DD`');
    return { action: 'dates', dates: dates.slice(0, 120).sort() };
  }
  throw new Error('Use `!backend help` to see valid backend schedule commands');
}

function formatSchedule(scheduleValue) {
  const schedule = normalizeSchedule(scheduleValue);
  return {
    windows: schedule.windows.map(item => `${item.start}-${item.end}`).join(', '),
    days: schedule.dates.length ? 'Exact dates only' : schedule.days.map(day => DAY_NAMES[day]).join(', '),
    dates: schedule.dates.join(', ') || '—',
    overrides: Object.entries(schedule.overrides).sort(([a], [b]) => a.localeCompare(b))
      .map(([date, state]) => {
        if (state && typeof state === 'object') {
          return `${date} ${state.windows.map(item => `${item.start}-${item.end}`).join(',')}`;
        }
        return `${date} ${state}`;
      }).join(', ') || '—',
  };
}

module.exports = {
  DAY_NAMES,
  DEFAULT_SCHEDULE,
  formatSchedule,
  isScheduleActive,
  normalizeSchedule,
  parseBackendCommand,
  parseDays,
  parseWindows,
  scheduleFromWindow,
  validDate,
};
