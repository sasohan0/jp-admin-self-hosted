// ============================================================
//  scheduler.js - day-of-week schedule per automation
//  Default: follow the cohort working calendar. Override per key:
//   !schedule questions sun-thu     (Sunday to Thursday)
//   !schedule jobs mon,wed,fri      (specific days)
//   !schedule workshop everyday     (reset to every day)
//   !schedule                       (list current schedules)
//  Used by every cron wrapper: check isScheduledToday(key) before firing.
//  Calendar holidays are an absolute scheduled-output stop. Stored in Sheet
//  and applied immediately in this process.
// ============================================================
const { cohorts } = require('./config');
const { getSetting, setSetting } = require('./settings');
const { getCalendarDay, parseCalendarDays } = require('./work-calendar');

const DAY_MAP = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SCHEDULE_KEYS = [
  'attendance', 'outreach', 'jobs', 'questions', 'workshop',
  'specialworkshop',
  'leaderboard', 'weeklyreport', 'rtbr', 'resources', 'dmnudges', 'suggestions',
  'outreachprompt', 'interviewprompt', 'communicationprompt',
  'interviewfollowup',
  'warningreport',
  'contentsync', 'discipline',
];
const DEFAULT_DAYS = {
  weeklyreport: [4], rtbr: [4], interviewfollowup: [4],
  warningreport: [4],
};
const FIXED_WEEKDAY_KEYS = new Set([
  'weeklyreport', 'rtbr', 'interviewfollowup',
  'warningreport',
]);

async function getScheduleRaw(cohort, key) {
  let raw = await getSetting(cohort, 'sched_' + key);
  if (!raw && ['leaderboard', 'weeklyreport'].includes(key)) {
    raw = await getSetting(cohort, 'sched_reports');
  }
  return raw;
}

function parseDays(str) {
  str = String(str || '').toLowerCase().trim();
  if (!str || str === 'everyday' || str === 'every day' || str === 'all') return null; // null = every day
  const parsed = parseCalendarDays(str);
  if (parsed) return parsed;
  // range: sun-thu
  const range = str.match(/^(\w+)\s*[-–]\s*(\w+)$/);
  if (range) {
    const a = DAY_MAP[range[1]], b = DAY_MAP[range[2]];
    if (a === undefined || b === undefined) return null;
    const days = [];
    if (a <= b) for (let d = a; d <= b; d++) days.push(d);
    else { for (let d = a; d <= 6; d++) days.push(d); for (let d = 0; d <= b; d++) days.push(d); }
    return [...new Set(days)].sort((x, y) => x - y);
  }
  // list: mon,wed,fri
  const parts = str.split(/[,\s]+/).filter(Boolean);
  if (!parts.length || parts.some(part => DAY_MAP[part.trim()] === undefined)) return null;
  const days = parts.map(p => DAY_MAP[p.trim()]);
  return days.length ? [...new Set(days)].sort((a, b) => a - b) : null;
}

async function isScheduledToday(cohort, key) {
  const calendar = await getCalendarDay(cohort);
  const raw = await getScheduleRaw(cohort, key);
  const todayDow = new Date().toLocaleString('en-US', { weekday: 'short', timeZone: cohort.timezone }).slice(0, 3);
  return scheduleAllowsCalendarDay(calendar, key, raw, DAY_NAMES.indexOf(todayDow));
}

function scheduleAllowsCalendarDay(calendar, key, raw, dayIndex) {
  if (!calendar.working) return false;
  // A date explicitly promoted to a working day runs ordinary daily
  // automation even when an older feature schedule still says Sun-Thu. Fixed
  // weekly publications keep their own intended weekday.
  if (calendar.source === 'override' && !FIXED_WEEKDAY_KEYS.has(key)) return true;
  let days = DEFAULT_DAYS[key] || null;
  if (raw) {
    try { days = JSON.parse(raw); }
    catch { days = DEFAULT_DAYS[key] || null; }
  }
  if (!days || !days.length) return true;
  return days.includes(dayIndex);
}

function formatDays(raw) {
  if (!raw) return 'every day';
  try {
    const days = JSON.parse(raw);
    return days.length ? days.map(d => DAY_NAMES[d]).join(', ') : 'every day';
  } catch { return 'every day'; }
}

function registerScheduler(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const content = msg.content.trim();
    const lower = content.toLowerCase();
    if (!lower.startsWith('!schedule')) return;
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;

    const parts = content.split(/\s+/);
    if (parts.length === 1) {
      const lines = [];
      for (const k of SCHEDULE_KEYS) {
        const raw = await getScheduleRaw(cohort, k);
        const shown = raw || (DEFAULT_DAYS[k] ? JSON.stringify(DEFAULT_DAYS[k]) : '');
        lines.push(`\`${k}\` — **${formatDays(shown)}**`);
      }
      return msg.channel.send({
        embeds: [{
          title: '📅 Automation Schedules',
          description: lines.join('\n'),
          color: 0x3498db,
          footer: { text: '!schedule <key> <days>   e.g. !schedule questions sun-thu   or !schedule jobs mon,wed,fri   or !schedule jobs everyday' },
        }],
      });
    }

    const key = parts[1].toLowerCase();
    if (![...SCHEDULE_KEYS, 'reports'].includes(key)) {
      return msg.reply(`Unknown key. Valid: ${SCHEDULE_KEYS.map(k => `\`${k}\``).join(', ')}`);
    }
    const dayStr = parts.slice(2).join(' ');
    if (!dayStr) return msg.reply('Specify days, e.g. `sun-thu` or `mon,wed,fri` or `everyday`');

    const days = parseDays(dayStr);
    const everyday = /^(every\s*day|everyday|all)$/i.test(dayStr.trim());
    if (!days && !everyday) return msg.reply('Invalid days. Use `sun-thu`, `mon,wed,fri`, or `everyday`.');
    await setSetting(cohort, 'sched_' + key, days ? JSON.stringify(days) : '[]');
    await msg.reply(`📅 \`${key}\` → **${days ? days.map(d => DAY_NAMES[d]).join(', ') : 'every day'}** (live immediately)`);
  });
}

module.exports = {
  DEFAULT_DAYS,
  FIXED_WEEKDAY_KEYS,
  SCHEDULE_KEYS,
  formatDays,
  getScheduleRaw,
  isScheduledToday,
  parseDays,
  registerScheduler,
  scheduleAllowsCalendarDay,
};
