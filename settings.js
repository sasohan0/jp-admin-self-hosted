// ============================================================
//  settings.js - runtime settings, changeable from Discord
//   !settings / !targets   - show current values / performance targets
//   !set <key> <value>     - change one (persists in the Sheet)
//   !target <metric> <n>   - safely change a performance target
//  Keys: jobstarget, outreachstale, outreachdaily, pollwindow,
//        preminutes, announcetime, noshowtime, slots, meeturl,
//        gpturl
//  slots format: 11:30-13:00,15:00-17:00,19:00-20:30
// ============================================================
const { cohorts } = require('./config');
const { appsScriptGet, appsScriptPost } = require('./apps-script-api');
const { normalizeTime } = require('./runtime-schedule');
const { parseAttendanceWindow, parseChannelWindow } = require('./dawn-attendance');

const CACHE_MS = 30 * 60 * 1000;

const DEFAULTS = {
  // targets & thresholds
  jobstarget: '15',
  outreachstale: '2',
  outreachdaily: '3',
  weeklyattendance: '5',
  weeklyinterviews: '1',
  weeklycommunication: '3',
  weeklyworkshops: '3',
  rtbrdays: '7',
  rtbrtop: '10',
  weeklytop: '10',
  jobshistory: '3',
  // question drops
  workshoptech: '18',      // technical questions per day
  workshopcomm: '3',       // communication questions per day
  discussiontech: '0',     // discussion-channel questions per day
  qwindow: '20',           // answer window (min)
  qstart: '10:00',         // legacy first-drop setting
  qend: '19:30',           // legacy last-drop setting
  qmorningtime: '07:00',
  qmorningcount: '2',
  qafternoontime: '13:00',
  qafternooncount: '2',
  qeveningtime: '18:00',
  qeveningcount: '2',
  qperiodgap: '10',
  qchannel: 'discussion',
  // Plan before the first 07:00 question block. Startup also plans the
  // remaining same-day drops after a restart.
  questionplantime: '06:30',
  leaderboardtime: '20:00',
  leaderboardinterval: '2',
  // workshop sessions
  pollwindow: '15',
  preminutes: '10',
  announcetime: '10:05',
  noshowtime: '20:40',
  slots: '11:30-13:00,15:00-17:00,19:00-20:30',
  meeturl: 'https://meet.google.com/rvp-cihj-txb',
  gpturl: 'https://chatgpt.com/g/g-6a001f14177c8191a786e3037582ad33-speak-more',
  specialworkshopdate: '',
  specialworkshoptime: '18:00',
  specialworkshoptitle: 'Dawn Focus Special Workshop',
  specialworkshoplink: '',
  specialworkshopcontext: 'Exclusive practical workshop for Dawn Focus Circle members.',
  workshoplastsent: '',
  specialworkshoplastsent: '',
  // automation clock times (24-hour HH:MM, cohort timezone)
  formopenremindertime: '21:00',
  formcloseremindertime: '22:15',
  outreachtime: '20:00',
  jobschecktime: '22:30',
  activityreconciletime: '22:50',
  outreachprompttime: '06:00',
  interviewprompttime: '06:00',
  communicationprompttime: '06:00',
  attendancewarningtime: '08:00',
  attendancewarningstart: '',
  warningreporttime: '19:15',
  jobemergencytime: '08:10',
  interviewmorningtime: '08:20',
  interviewreviewtime: '19:00',
  contenttime: '10:00',
  dawnresettime: '04:50',
  dawnprompttime: '05:00',
  dawnchecktime: '07:10',
  dawnchannelwindow: 'always',
  dawnattendancewindow: '05:00-07:00',
  weeklyreporttime: '18:00',
  rtbrtime: '20:00',
  resourcetime: '11:00',
  dmnudgestime: '23:45',
  suggestiontime: '21:00',
  // channel overrides - empty = use the default channel.
  // set with: !set channel_jobs #channel   (or a raw channel ID)
  channel_attendance: '',   // default: discussion
  channel_outreach: '',     // default: outreach
  channel_interview: '',    // default: interview-update
  channel_jobs: '',         // default: job-tracking-sheet
  channel_workshop: '',     // default: communication-workshop
  channel_questions: '',    // default: qchannel legacy destination
  channel_discussion: '',   // default: discussion (session reminders/announcements)
  channel_reports: '',      // leaderboard + weekly (default: workshop)
  channel_rtbr: '',         // default: right-to-be-referred
  channel_noshow: '',       // default: workshop
};

const TARGETS = {
  applications: { key: 'jobstarget', label: 'Daily applications', min: 1, max: 100, aliases: ['application', 'applications', 'app', 'apps', 'job', 'jobs', 'jobstarget'] },
  outreach: { key: 'outreachdaily', label: 'Daily outreach', min: 1, max: 50, aliases: ['outreach', 'outreachdaily'] },
  attendance: { key: 'weeklyattendance', label: 'Weekly attendance', min: 0, max: 14, aliases: ['attendance', 'weeklyattendance'] },
  interviews: { key: 'weeklyinterviews', label: 'Weekly interviews', min: 0, max: 20, aliases: ['interview', 'interviews', 'weeklyinterviews'] },
  communication: { key: 'weeklycommunication', label: 'Weekly communication practice', min: 0, max: 50, aliases: ['communication', 'communications', 'practice', 'weeklycommunication'] },
  workshops: { key: 'weeklyworkshops', label: 'Weekly workshops', min: 0, max: 21, aliases: ['workshop', 'workshops', 'weeklyworkshops'] },
};

const NUMERIC_RULES = Object.fromEntries(Object.values(TARGETS).map(target => [target.key, target]));
Object.assign(NUMERIC_RULES, {
  outreachstale: { label: 'Outreach stale-day threshold', min: 0, max: 30 },
  rtbrdays: { label: 'RTBR counting window', min: 1, max: 90 },
  rtbrtop: { label: 'RTBR published student count', min: 1, max: 25 },
  weeklytop: { label: 'Weekly leaderboard top section', min: 1, max: 25 },
  jobshistory: { label: 'Job recent-history days', min: 1, max: 14 },
  workshoptech: { label: 'Daily technical questions', min: 0, max: 50 },
  workshopcomm: { label: 'Daily communication questions', min: 0, max: 30 },
  discussiontech: { label: 'Daily discussion questions', min: 0, max: 20 },
  qmorningcount: { label: 'Morning question count', min: 0, max: 10 },
  qafternooncount: { label: 'Afternoon question count', min: 0, max: 10 },
  qeveningcount: { label: 'Evening question count', min: 0, max: 10 },
  qperiodgap: { label: 'Minutes between questions in one period', min: 1, max: 180 },
  qwindow: { label: 'Question answer window', min: 1, max: 120 },
  pollwindow: { label: 'Workshop poll window', min: 1, max: 120 },
  preminutes: { label: 'Workshop reminder lead time', min: 0, max: 120 },
  leaderboardinterval: { label: 'Leaderboard interval', min: 1, max: 31 },
});
const TARGET_ALIASES = new Map(Object.entries(TARGETS).flatMap(([name, target]) =>
  target.aliases.map(alias => [alias, { name, ...target }])
));

const TIMES = {
  formopen: { key: 'formopenremindertime', label: 'Attendance open reminder' },
  formclose: { key: 'formcloseremindertime', label: 'Attendance close reminder' },
  outreach: { key: 'outreachtime', label: 'Outreach report' },
  jobs: { key: 'jobschecktime', label: 'Job tracker report' },
  activityreconcile: { key: 'activityreconciletime', label: 'Interview/outreach history reconciliation' },
  questionplan: { key: 'questionplantime', label: 'Daily question planning' },
  leaderboard: { key: 'leaderboardtime', label: 'Question leaderboard' },
  workshopannounce: { key: 'announcetime', label: 'Workshop announcement' },
  workshopnoshow: { key: 'noshowtime', label: 'Workshop no-show report' },
  weeklyreport: { key: 'weeklyreporttime', label: 'Weekly performance report' },
  rtbr: { key: 'rtbrtime', label: 'RTBR report' },
  resources: { key: 'resourcetime', label: 'Resource repost' },
  dmnudges: { key: 'dmnudgestime', label: 'Student DM nudges' },
  suggestions: { key: 'suggestiontime', label: 'AI activity suggestion' },
  outreachprompt: { key: 'outreachprompttime', label: 'Outreach template prompt' },
  interviewprompt: { key: 'interviewprompttime', label: 'Interview-update prompt' },
  communicationprompt: { key: 'communicationprompttime', label: 'Communication prompt' },
  attendancewarning: { key: 'attendancewarningtime', label: 'Consecutive-absence warning' },
  warningreport: { key: 'warningreporttime', label: 'Weekly private warning report' },
  jobemergency: { key: 'jobemergencytime', label: 'Two-day application emergency' },
  interviewmorning: { key: 'interviewmorningtime', label: 'Thursday interview reminder' },
  interviewreview: { key: 'interviewreviewtime', label: 'Thursday interview review list' },
  contentsync: { key: 'contenttime', label: 'Periodic content backfill' },
  dawnreset: { key: 'dawnresettime', label: 'Dawn channel daily reset' },
  dawnprompt: { key: 'dawnprompttime', label: 'Dawn wake-up prompt' },
  dawncheck: { key: 'dawnchecktime', label: 'Dawn check-in review' },
};
const TIME_KEYS = new Set(Object.values(TIMES).map(item => item.key).concat([
  'qstart', 'qend', 'qmorningtime', 'qafternoontime', 'qeveningtime', 'specialworkshoptime',
]));

const cache = {}; // guildId -> { at, values }
const inflight = {}; // guildId -> one shared backend read

async function fetchAll(cohort) {
  const hit = cache[cohort.guildId];
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.values;
  if (inflight[cohort.guildId]) return inflight[cohort.guildId];
  inflight[cohort.guildId] = (async () => { try {
    const data = await appsScriptGet(cohort, {
      action: 'getstates',
      prefix: `set_${cohort.guildId}_`,
    }, { label: 'Runtime settings' });
    const states = data.states || {};
    const values = {};
    for (const [k, v] of Object.entries(states)) {
      values[k.replace(`set_${cohort.guildId}_`, '')] = v;
    }
    cache[cohort.guildId] = { at: Date.now(), values };
    return values;
  } catch { return (hit && hit.values) || {}; } })();
  try { return await inflight[cohort.guildId]; }
  finally { delete inflight[cohort.guildId]; }
}

async function getSetting(cohort, key) {
  const values = await fetchAll(cohort);
  return values[key] !== undefined ? values[key] : cohortDefaultSetting(cohort, key);
}
async function getNumber(cohort, key) {
  const value = Number(await getSetting(cohort, key));
  return Number.isFinite(value) ? value : Number(DEFAULTS[key]);
}

async function setSetting(cohort, key, value) {
  await appsScriptPost(cohort, {
    action: 'setState',
    k: `set_${cohort.guildId}_${key}`,
    v: String(value),
  }, { idempotent: true, label: 'Runtime setting write' });
  cache[cohort.guildId] = null;
}

function cronTime(expression, fallback) {
  const match = String(expression || '').trim().match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(?:\*|\d)$/);
  return match ? normalizeTime(`${match[2]}:${match[1]}`) || fallback : fallback;
}

function cohortDefaultSetting(cohort, key) {
  const configuredTimes = {
    formopenremindertime: cronTime(cohort.formOpenReminder, DEFAULTS.formopenremindertime),
    formcloseremindertime: cronTime(cohort.formCloseReminder, DEFAULTS.formcloseremindertime),
    outreachtime: cronTime(cohort.outreachCheckCron, DEFAULTS.outreachtime),
    jobschecktime: cronTime(cohort.jobs?.checkCron, DEFAULTS.jobschecktime),
    leaderboardtime: cronTime(cohort.questions?.leaderboardCron, DEFAULTS.leaderboardtime),
    weeklyreporttime: cronTime(cohort.questions?.weeklyReportCron, DEFAULTS.weeklyreporttime),
    rtbrtime: cronTime(cohort.rtbr?.announceCron, DEFAULTS.rtbrtime),
    resourcetime: cronTime(cohort.resources?.autoPostCron, DEFAULTS.resourcetime),
  };
  return configuredTimes[key] !== undefined ? configuredTimes[key] : DEFAULTS[key];
}

function validateNumericSetting(key, value) {
  const rule = NUMERIC_RULES[key];
  if (!rule) return null;
  if (!/^\d+$/.test(String(value).trim())) return `${rule.label} must be a whole number from ${rule.min} to ${rule.max}.`;
  const number = Number(value);
  if (number < rule.min || number > rule.max) return `${rule.label} must be from ${rule.min} to ${rule.max}.`;
  return null;
}

async function targetSummary(cohort) {
  const values = await Promise.all(Object.entries(TARGETS).map(async ([name, target]) => ({
    name,
    label: target.label,
    value: await getNumber(cohort, target.key),
    cadence: target.key.endsWith('daily') || target.key === 'jobstarget' ? 'per scheduled day' : 'per week',
  })));
  return values;
}

function parseSlots(str) {
  const NAMES = ['Morning', 'Afternoon', 'Evening', 'Night', 'Extra'];
  return String(str).split(',').map((s, i) => {
    const [a, b, extra] = s.trim().split('-');
    const start = normalizeTime(a);
    const end = normalizeTime(b);
    if (!start || !end || extra !== undefined) return null;
    const [h1, m1] = start.split(':').map(Number);
    const [h2, m2] = end.split(':').map(Number);
    const startMin = h1 * 60 + m1;
    const endMin = h2 * 60 + m2;
    if (endMin <= startMin) return null;
    return { name: NAMES[i] || `Slot ${i + 1}`, startMin, endMin, label: `${start}-${end}` };
  }).filter(Boolean);
}

function registerSettings(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const content = msg.content.trim();
    const lower = content.toLowerCase();
    if (!['!settings', '!targets', '!times', '!time'].includes(lower) &&
        !lower.startsWith('!set ') && !lower.startsWith('!target ') && !lower.startsWith('!time ')) return;
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;

    if (lower === '!targets') {
      const targets = await targetSummary(cohort);
      const lines = targets.map(target => `\`${target.name}\` = **${target.value}** ${target.cadence}`);
      return msg.channel.send({
        embeds: [{
          title: 'Performance Targets', color: 0x2ecc71,
          description: `${lines.join('\n')}\n\nChange one with \`!target <metric> <amount>\`. Daily goals are multiplied by the matching scheduled days in weekly reports.`,
        }],
      });
    }

    if (lower.startsWith('!target ')) {
      const parts = content.split(/\s+/);
      const target = TARGET_ALIASES.get((parts[1] || '').toLowerCase());
      const value = parts[2];
      if (!target || parts.length !== 3) return msg.reply('Usage: `!target <applications|outreach|attendance|interviews|communication|workshops> <amount>`');
      const error = validateNumericSetting(target.key, value);
      if (error) return msg.reply(`Invalid target: ${error}`);
      try { await setSetting(cohort, target.key, value); }
      catch (err) { return msg.reply(`Target update failed: ${err.message.slice(0, 300)}`); }
      return msg.reply(`Target updated: **${target.label} = ${value}**. This applies only to **${cohort.name}**.`);
    }

    if (lower === '!times' || lower === '!time') {
      const lines = [];
      for (const [name, item] of Object.entries(TIMES)) {
        lines.push(`\`${name}\` = **${await getSetting(cohort, item.key)}** — ${item.label}`);
      }
      return msg.channel.send({
        embeds: [{
          title: 'Automation Times', color: 0x5865f2,
          description: `${lines.join('\n')}\n\nChange one with \`!time <name> HH:MM\`. Times use **${cohort.timezone}** and apply without restarting.`,
        }],
        allowedMentions: { parse: [] },
      });
    }

    if (lower.startsWith('!time ')) {
      const parts = content.split(/\s+/);
      const item = TIMES[(parts[1] || '').toLowerCase()];
      const time = normalizeTime(parts[2]);
      if (!item || parts.length !== 3 || !time) {
        return msg.reply(`Usage: \`!time <${Object.keys(TIMES).join('|')}> HH:MM\` (24-hour cohort time)`);
      }
      if (item.key === 'dawnchecktime') {
        const window = parseAttendanceWindow(await getSetting(cohort, 'dawnattendancewindow')) ||
          parseAttendanceWindow(DEFAULTS.dawnattendancewindow);
        const reviewMinute = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
        if (reviewMinute <= window.endMinute) {
          return msg.reply(`Dawn review must be later than the attendance-window end (**${window.end}**).`);
        }
      }
      try { await setSetting(cohort, item.key, time); }
      catch (err) { return msg.reply(`Time update failed: ${err.message.slice(0, 300)}`); }
      return msg.reply(`Clock updated: **${item.label} = ${time}** (${cohort.timezone}). This applies only to **${cohort.name}**.`);
    }

    if (lower === '!settings') {
      const values = await fetchAll(cohort);
      const lines = Object.keys(DEFAULTS).map(k => {
        const inherited = cohortDefaultSetting(cohort, k);
        const cur = values[k] !== undefined ? values[k] : inherited;
        const changed = values[k] !== undefined && values[k] !== inherited;
        return `\`${k}\` = **${cur}**${changed ? ' _(customized)_' : ''}`;
      });
      return msg.channel.send({
        embeds: [{
          title: '⚙️ Runtime Settings', color: 0x3498db,
          description: lines.join('\n') + '\n\nChange with `!set <key> <value>` — applies immediately, no restart.',
        }],
      });
    }

    const parts = content.split(/\s+/);
    const key = (parts[1] || '').toLowerCase();
    const value = parts.slice(2).join(' ');
    if (!(key in DEFAULTS)) {
      return msg.reply(`❓ Unknown key \`${key}\`. Valid: ${Object.keys(DEFAULTS).map(k => `\`${k}\``).join(', ')}`);
    }
    if (!value) return msg.reply('Usage: `!set <key> <value>`');
    let clean = value;
    const numericError = validateNumericSetting(key, value);
    if (numericError) return msg.reply(`Invalid setting: ${numericError}`);
    if (TIME_KEYS.has(key)) {
      const time = normalizeTime(value);
      if (!time) return msg.reply('Invalid time. Use 24-hour `HH:MM`, for example `23:00`.');
      clean = time;
    }
    if (key === 'slots' && parseSlots(value).length !== value.split(',').filter(Boolean).length) {
      return msg.reply('⚠️ Slots format: `11:30-13:00,15:00-17:00,19:00-20:30`');
    }
    if (key === 'qchannel' && !['discussion', 'workshop', 'dawn'].includes(value.toLowerCase())) {
      return msg.reply('Question channel must be `discussion`, `workshop`, or `dawn`.');
    }
    if (key === 'dawnchannelwindow') {
      const window = parseChannelWindow(value);
      if (!window) return msg.reply('Dawn channel window must be `always` or `HH:MM-HH:MM`, for example `05:30-08:00`.');
      clean = window.mode === 'always' ? 'always' : window.label;
    }
    if (key === 'dawnattendancewindow') {
      const window = parseAttendanceWindow(value);
      if (!window) return msg.reply('Dawn attendance window must be a same-day `HH:MM-HH:MM` range from 15 minutes to 6 hours, for example `05:00-07:00`.');
      const review = normalizeTime(await getSetting(cohort, 'dawnchecktime'));
      const reviewMinute = Number(review.slice(0, 2)) * 60 + Number(review.slice(3));
      if (window.endMinute >= reviewMinute) {
        return msg.reply(`Set the review later first with \`!time dawncheck HH:MM\`. It must be after **${window.end}**.`);
      }
      clean = window.label;
    }
    if (key === 'attendancewarningstart') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
        return msg.reply('Attendance warning start must be a real `YYYY-MM-DD` date. Prefer `!warnings start YYYY-MM-DD` because it also safely rebases existing warning records.');
      }
      clean = value;
    }
    if (key.startsWith('sched_')) {
      // schedule keys set by !schedule command, not !set - handled separately
      return msg.reply('Use `!schedule <key> <days>` to change schedules, not `!set`.');
    }
    if (key.startsWith('channel_')) {
      clean = value.replace(/[<#>]/g, '').trim();
      if (clean && !/^\d{15,20}$/.test(clean)) return msg.reply('⚠️ Give a #channel mention or a channel ID (or empty to reset).');
    }
    try { await setSetting(cohort, key, clean); }
    catch (err) { return msg.reply(`Setting update failed: ${err.message.slice(0, 300)}`); }
    await msg.reply(`✅ \`${key}\` = **${clean || '(default)'}** — live immediately.`);
  });
}

// resolve where an automation should post: override wins, else default
async function resolveChannel(cohort, overrideKey, defaultId) {
  const v = await getSetting(cohort, overrideKey);
  return (v && String(v).trim()) || defaultId;
}

module.exports = {
  DEFAULTS,
  TIMES,
  cohortDefaultSetting,
  cronTime,
  TARGETS,
  getNumber,
  getSetting,
  parseSlots,
  registerSettings,
  resolveChannel,
  setSetting,
  targetSummary,
  validateNumericSetting,
};
