'use strict';

// Cohort-local morning templates and evidence-based escalation reports.
// Public output contains only Discord mentions and activity counts; contact
// details and raw Sheet rows remain private.

const { cohorts } = require('./config');
const { appsScriptGet, appsScriptPost } = require('./apps-script-api');
const { isOn } = require('./automations');
const { getRoster, isExcluded, mention, syncMembers } = require('./roster');
const { getNumber, getSetting } = require('./settings');
const { isScheduledToday } = require('./scheduler');
const { scheduleAtSetting } = require('./runtime-schedule');
const { isWarmup } = require('./state');
const { chunkLines } = require('./message-chunks');
const { parseDateValue } = require('./job-tracker');
const {
  calendarDecision,
  dateKeyInZone,
  loadWorkCalendar,
  previousWorkingDates,
  validDateKey,
} = require('./work-calendar');
const { newWarningIncident } = require('./followup-rules');
const { setStudentsInactive } = require('./exclude');
const { notifyRestriction } = require('./appeals');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const attendanceWarningTimers = new Map();
const POST_ATTENDANCE_RETRY_MS = 15 * 60 * 1000;
const POST_ATTENDANCE_MAX_ATTEMPTS = 3;

function attendanceFollowupKey(cohort) {
  return `post_attendance_followup_v1_${cohort.guildId}`;
}

function parseAttendanceFollowup(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    if (!validDateKey(parsed.reportDate) || !['pending', 'completed'].includes(parsed.status)) return null;
    return {
      reportDate: parsed.reportDate,
      status: parsed.status,
      dueAt: Number(parsed.dueAt || 0),
      attempts: Math.max(0, Number(parsed.attempts || 0)),
      warningDone: parsed.warningDone === true,
      mailerDone: parsed.mailerDone === true,
    };
  } catch { return null; }
}

function attendanceFollowupPlan({ working, warmup, warningEnabled, mailerEnabled }) {
  if (warmup || !working) return { warning: false, mailer: false, terminalSkip: true };
  return { warning: Boolean(warningEnabled), mailer: Boolean(mailerEnabled), terminalSkip: false };
}

function parseActivityCommand(content) {
  const match = String(content || '').trim().match(
    /^!activity(prompt|check)(?:\s+(outreach|interview|communication|attendance|jobs|interviews|all))?(?:\s+(\d{4}-\d{2}-\d{2}))?$/i);
  if (!match) return null;
  return {
    action: match[1].toLowerCase(),
    kind: (match[2] || 'all').toLowerCase(),
    date: String(match[3] || ''),
  };
}

async function readAttendanceFollowup(cohort) {
  const stored = await appsScriptGet(cohort, {
    action: 'getstate', k: attendanceFollowupKey(cohort),
  }, { label: 'Post-attendance follow-up state' });
  return parseAttendanceFollowup(stored.value);
}

async function writeAttendanceFollowup(cohort, state) {
  await appsScriptPost(cohort, {
    action: 'setState', k: attendanceFollowupKey(cohort), v: JSON.stringify(state),
  }, { idempotent: true, label: 'Post-attendance follow-up state write' });
}

function localDateKey(timezone, now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: timezone });
}

function shiftDateKey(key, days) {
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekdayNumber(key) {
  return new Date(`${key}T00:00:00Z`).getUTCDay();
}

function previousWorkdays(timezone, count, now = new Date()) {
  const result = [];
  let key = shiftDateKey(localDateKey(timezone, now), -1);
  while (result.length < count) {
    if (![5, 6].includes(weekdayNumber(key))) result.unshift(key);
    key = shiftDateKey(key, -1);
  }
  return result;
}

function currentSunday(key) {
  return shiftDateKey(key, -weekdayNumber(key));
}

function belowJobTarget(students, roster, dates, target) {
  const byEmail = new Map((students || []).map(student => [String(student.email || '').toLowerCase(), student]));
  return roster.filter(student => {
    const row = byEmail.get(String(student.email || '').toLowerCase()) || {};
    return dates.every(date => !row.leaveDays?.[date] && Number(row.jobDays?.[date] || 0) < target);
  }).map(student => {
    const row = byEmail.get(String(student.email || '').toLowerCase()) || {};
    return { ...student, counts: dates.map(date => Number(row.jobDays?.[date] || 0)) };
  });
}

function withoutInterviews(students, roster) {
  const byEmail = new Map((students || []).map(student => [String(student.email || '').toLowerCase(), student]));
  return roster.filter(student => Number(byEmail.get(String(student.email || '').toLowerCase())?.interviews || 0) === 0);
}

function consecutiveAbsenceTail(absentDates, recordedSessions) {
  const absent = new Set((absentDates || []).map(String));
  let count = 0;
  for (const date of [...(recordedSessions || [])].map(String).sort().reverse()) {
    if (!absent.has(date)) break;
    count++;
  }
  return count;
}

function tsvCell(value) {
  return String(value || '').replace(/[\t\r\n]+/g, ' ').trim();
}

function privateContactLines(students, detailFor) {
  return [
    'NAME\tEMAIL\tPHONE\tREASON',
    ...(students || []).map(student => [
      student.name || student.displayName || 'Unknown',
      student.email || 'NO EMAIL',
      student.phone || 'NO PHONE',
      detailFor(student),
    ].map(tsvCell).join('\t')),
  ];
}

async function sendPrivateContactReport(client, cohort, title, students, detailFor) {
  if (!students.length) return;
  const channelId = cohort.channels.supervisor;
  if (!channelId) throw new Error('bot-admin channel is not configured');
  const channel = await client.channels.fetch(channelId);
  const rows = privateContactLines(students, detailFor);
  for (const chunk of chunkLines(rows, 1700)) {
    await channel.send({
      content: `**${title}**\n\`\`\`tsv\n${chunk}\n\`\`\``,
      allowedMentions: { parse: [] },
    });
    await sleep(500);
  }
}

async function activeRoster(client, cohort) {
  await syncMembers(client, cohort);
  return (await getRoster(cohort, true)).filter(student => !isExcluded(cohort, student));
}

async function sendLines(channel, lines, mentionEveryone = true) {
  for (const chunk of chunkLines(lines, 1900)) {
    await channel.send({
      content: chunk,
      allowedMentions: { parse: mentionEveryone ? ['users', 'everyone'] : ['users'] },
    });
    await sleep(700);
  }
}

const PROMPTS = {
  outreach: `@everyone\n📣 **Daily outreach update — use this template**\n\n**Date:**\n**Companies / people contacted:**\n**Contact method:** LinkedIn / email / other\n**Replies or results:**\n**Next follow-up step:**\n\nShare at least the configured daily outreach target. Do not post private passwords or confidential company information.\n\n⏰ JP ADMIN records bot-tracked channel activity only during the **4:50 AM–11:30 PM** active window.`,
  interview: `@everyone\n🎯 **Interview update reminder**\n\nIf you received, scheduled, or completed an interview, share:\n**Interview serial:**\n**Company and position:**\n**Interview date and time:**\n**Remote / onsite:**\n**Job post or company link:**\n**Current stage / result:**\n**Preparation help needed:**\n\nEven an unsuccessful interview is valuable evidence for improving the next one.\n\n⏰ JP ADMIN records bot-tracked channel activity only during the **4:50 AM–11:30 PM** active window.`,
  communication: `@everyone\n🎤 **Daily communication practice**\n\nUse this channel for today’s practice and report:\n**Practice type:** mock interview / technical explanation / English speaking\n**Topic or question practiced:**\n**Practice duration:**\n**What felt difficult:**\n**What you will improve next:**\n\nConsistent practice matters more than waiting to feel confident.\n\n⏰ JP ADMIN records bot-tracked channel activity only during the **4:50 AM–11:30 PM** active window.`,
};

async function postPrompt(client, cohort, kind) {
  const channelId = kind === 'outreach'
    ? cohort.channels.outreach
    : kind === 'interview'
      ? cohort.channels.interviewUpdates
      : cohort.channels.workshop;
  if (!channelId) throw new Error(`${kind} channel is not configured`);
  const channel = await client.channels.fetch(channelId);
  await channel.send({ content: PROMPTS[kind], allowedMentions: { parse: ['everyone'] } });
}

async function runAttendanceWarning(client, cohort, options = {}) {
  const channelId = cohort.channels.warning;
  if (!channelId) throw new Error('warning channel is not configured');
  const end = validDateKey(options.endDate)
    ? options.endDate
    : localDateKey(cohort.timezone);
  const rollingStart = shiftDateKey(end, -10);
  const configuredStart = String(await getSetting(cohort, 'attendancewarningstart') || '').trim();
  const start = validDateKey(configuredStart) && configuredStart > rollingStart
    ? configuredStart
    : rollingStart;
  const data = await appsScriptGet(cohort, {
    action: 'absences', start, end, guildId: cohort.guildId,
  }, { label: 'Consecutive absence warning' });
  if (!(data.recordedSessions || []).map(String).includes(end)) {
    return { count: 0, skipped: true, reason: `No recorded attendance session exists for ${end}` };
  }
  const roster = await activeRoster(client, cohort);
  const activeIds = new Set(roster.map(student => student.discordId));
  const activeById = new Map(roster.map(student => [String(student.discordId || ''), student]));
  const flagged = (data.students || []).map(student => {
    const current = activeById.get(String(student.discordId || '')) || {};
    return {
      ...student,
      name: current.name || student.name,
      email: current.email || student.email,
      phone: current.phone || student.phone,
      currentStreak: consecutiveAbsenceTail(student.absentDates, data.recordedSessions),
    };
  }).filter(student =>
    activeIds.has(String(student.discordId || '')) && student.currentStreak >= 2);
  if (!flagged.length) return { count: 0 };
  const stateKey = `attendance_warning_state_v1_${cohort.guildId}`;
  const stored = await appsScriptGet(cohort, { action: 'getstate', k: stateKey }, {
    label: 'Attendance warning state',
  });
  let warningState = {};
  try { warningState = JSON.parse(String(stored.value || '{}')); } catch { warningState = {}; }
  const incidents = [];
  for (const student of flagged) {
    const incidentDates = [...(student.absentDates || [])].sort().slice(-student.currentStreak);
    const outcome = newWarningIncident(
      warningState, student.discordId, incidentDates, 3, end, localDateKey(cohort.timezone));
    warningState = outcome.state;
    if (!outcome.duplicate) incidents.push({
      ...student, warning: outcome.record.count, remaining: outcome.remaining,
      warningDates: outcome.incidentDates,
      countedAbsenceDates: outcome.record.usedDates || [],
    });
  }
  if (!incidents.length) return { count: 0, duplicate: true };
  const newlyInactive = incidents.filter(student => student.warning >= 3);
  if (newlyInactive.length) {
    await setStudentsInactive(cohort, newlyInactive.map(student => student.discordId), {
      client,
      date: end,
      source: 'attendance-warning',
      reason: 'Reached 3/3 attendance warnings',
      warningState,
    });
  } else {
    await appsScriptPost(cohort, {
      action: 'setState', k: stateKey, v: JSON.stringify(warningState),
    }, { idempotent: true, label: 'Attendance warning state write' });
  }
  const channel = await client.channels.fetch(channelId);
  await sendLines(channel, [
    '@everyone\n⚠️ **Official attendance warning — action required**',
    `Every student is counted from the same cohort baseline: **${start}**. Approved leave (**L**) is not an absence. One run can issue only one warning, using one new pair of two unapproved consecutive recorded-session absences.`,
    'Warnings 1–2 mean you are still active but must contact your mentor and return immediately. Warning 3 means **INACTIVE**: attendance, applications, outreach, interviews, communication, RTBR/leaderboard credit and other bootcamp points will not be recorded until a mentor reactivates you.',
    'Valid appeal causes include a medical emergency, final examination, death/bereavement, or another serious unavoidable event. State the exact affected dates, explain the cause honestly, and promise how you will resume consistently.',
    ...incidents.map(student => student.remaining
      ? `• <@${student.discordId}> — warning **${student.warning}/3** · dates: **${student.warningDates.join(', ')}** · still active · **${student.remaining} warning(s) remaining**`
      : `• <@${student.discordId}> — **INACTIVE (3/3)** · dates: **${student.warningDates.join(', ')}** · no tracking or points until mentor reactivation; use the appeal notice.`),
  ]);
  await sendPrivateContactReport(client, cohort,
    'Private attendance-warning contacts', incidents,
    student => `counted pair ${student.warningDates.join(', ')}; warning ${student.warning}/3; ${student.remaining} remaining`);
  for (const student of newlyInactive) {
    await notifyRestriction(client, cohort, student, {
      scope: 'bootcamp',
      reason: `Reached 3/3 attendance warnings. Counted unapproved attendance dates: ${student.countedAbsenceDates.slice(-6).join(', ') || 'see the private attendance report'}.`,
    });
  }
  return { count: incidents.length, inactive: newlyInactive.length };
}

async function processAttendanceFollowup(client, cohort, pending) {
  const calendar = calendarDecision(await loadWorkCalendar(cohort), pending.reportDate);
  const plan = attendanceFollowupPlan({
    working: calendar.working,
    warmup: await isWarmup(cohort),
    warningEnabled: await isOn(cohort, 'attendancewarning'),
    mailerEnabled: await isOn(cohort, 'mailer'),
  });
  if (plan.terminalSkip) {
    await writeAttendanceFollowup(cohort, { ...pending, status: 'completed', warningDone: true, mailerDone: true });
    console.log(`[post-attendance] ${cohort.name} ${pending.reportDate}: skipped (${calendar.working ? 'warm-up' : 'non-working day'})`);
    return { completed: true, skipped: true };
  }

  let state = { ...pending, status: 'pending', attempts: Number(pending.attempts || 0) + 1 };
  await writeAttendanceFollowup(cohort, state);
  if (!state.warningDone) {
    if (plan.warning) await runAttendanceWarning(client, cohort, { endDate: state.reportDate });
    state = { ...state, warningDone: true };
    await writeAttendanceFollowup(cohort, state);
  }
  if (!state.mailerDone) {
    if (plan.mailer) {
      const { runAttendanceMailer } = require('./mailer');
      await runAttendanceMailer(client, cohort, state.reportDate, { automatic: true });
    }
    state = { ...state, mailerDone: true };
    await writeAttendanceFollowup(cohort, state);
  }
  await writeAttendanceFollowup(cohort, { ...state, status: 'completed', completedAt: Date.now() });
  console.log(`[post-attendance] ${cohort.name} ${state.reportDate}: completed warning=${plan.warning} mailer=${plan.mailer}`);
  return { completed: true };
}

function armAttendanceFollowup(client, cohort, pending) {
  const key = `${cohort.guildId}:${pending.reportDate}`;
  if (attendanceWarningTimers.has(key)) return { scheduled: false, duplicate: true };
  const delayMs = Math.max(0, Number(pending.dueAt || 0) - Date.now());
  const timer = setTimeout(async () => {
    let failed = false;
    try {
      await processAttendanceFollowup(client, cohort, pending);
    } catch (error) {
      failed = true;
      console.error(`[post-attendance] ${cohort.name} warning/mailer check failed:`, error.message);
      const admin = await client.channels.fetch(cohort.channels.supervisor).catch(() => null);
      await admin?.send({
        content: `❌ Post-attendance warning/mailer processing for **${pending.reportDate}** failed and remains queued for recovery: ${String(error.message).slice(0, 250)}`,
        allowedMentions: { parse: [] },
      }).catch(() => {});
    } finally {
      attendanceWarningTimers.delete(key);
      if (failed && Number(pending.attempts || 0) + 1 < POST_ATTENDANCE_MAX_ATTEMPTS) {
        const latest = await readAttendanceFollowup(cohort).catch(() => null);
        const retry = {
          ...(latest?.reportDate === pending.reportDate ? latest : pending),
          status: 'pending',
          attempts: Number(pending.attempts || 0) + 1,
          dueAt: Date.now() + POST_ATTENDANCE_RETRY_MS,
        };
        await writeAttendanceFollowup(cohort, retry).catch(() => {});
        armAttendanceFollowup(client, cohort, retry);
      }
    }
  }, delayMs);
  timer.unref?.();
  attendanceWarningTimers.set(key, timer);
  return { scheduled: true, reportDate: pending.reportDate, delayMs };
}

async function recoverAttendanceFollowup(client, cohort) {
  const pending = await readAttendanceFollowup(cohort);
  if (!pending || pending.status !== 'pending') return { recovered: false };
  return { recovered: true, ...armAttendanceFollowup(client, cohort, pending) };
}

async function scheduleAttendanceWarningAfterReport(client, cohort, reportDate, delayMs = 10 * 60 * 1000) {
  if (!validDateKey(reportDate)) return { scheduled: false, reason: 'invalid-report-date' };
  const existing = await readAttendanceFollowup(cohort);
  if (existing?.reportDate === reportDate && existing.status === 'completed') {
    return { scheduled: false, duplicate: true, completed: true };
  }
  const pending = {
    reportDate,
    status: 'pending',
    dueAt: Date.now() + Math.max(0, Number(delayMs) || 0),
    attempts: 0,
    warningDone: existing?.reportDate === reportDate && existing.warningDone === true,
    mailerDone: existing?.reportDate === reportDate && existing.mailerDone === true,
  };
  await writeAttendanceFollowup(cohort, pending);
  return armAttendanceFollowup(client, cohort, pending);
}

async function runJobEmergency(client, cohort) {
  const channelId = cohort.channels.emergency;
  if (!channelId) throw new Error('emergency channel is not configured');
  const dates = previousWorkingDates(
    await loadWorkCalendar(cohort),
    dateKeyInZone(cohort.timezone),
    2,
  );
  const target = await getNumber(cohort, 'jobstarget');
  const [performance, roster] = await Promise.all([
    appsScriptGet(cohort, { action: 'performance', start: dates[0], end: dates[1] }, { label: 'Two-day application review' }),
    activeRoster(client, cohort),
  ]);
  const flagged = belowJobTarget(performance.students, roster, dates, target);
  if (!flagged.length) return { count: 0, dates };
  const channel = await client.channels.fetch(channelId);
  await sendLines(channel, [
    '@everyone\n🚨 **Application emergency — below target on two consecutive weekdays**',
    `Required target: **${target} applications per weekday**. Checked: **${dates.join(' and ')}**.`,
    'Improve application accuracy immediately. Also verify that your tracker link is public and the application **Date Applied** column contains real dates; fix any wrong tab, GID, header, or date format.',
    ...flagged.map(student => `• ${mention(student)} — **${student.counts[0]}/${target}**, then **${student.counts[1]}/${target}**`),
  ]);
  await sendPrivateContactReport(client, cohort,
    `Private application-emergency contacts (${dates.join(' and ')})`, flagged,
    student => `${student.counts[0]}/${target}, then ${student.counts[1]}/${target}`);
  return { count: flagged.length, dates };
}

async function weeklyInterviewData(client, cohort) {
  const today = localDateKey(cohort.timezone);
  const start = currentSunday(today);
  const [performance, roster] = await Promise.all([
    appsScriptGet(cohort, { action: 'performance', start, end: today }, { label: 'Weekly interview review' }),
    activeRoster(client, cohort),
  ]);
  return { today, start, performance, roster, missing: withoutInterviews(performance.students, roster) };
}

async function runInterviewMorning(client, cohort) {
  if (weekdayNumber(localDateKey(cohort.timezone)) !== 4) return { count: 0, skipped: true };
  const data = await weeklyInterviewData(client, cohort);
  const channel = await client.channels.fetch(cohort.channels.interviewUpdates);
  await sendLines(channel, [
    '@everyone\n🌅 **Thursday interview-update reminder**',
    'If you received or attended any interview from Sunday through today, share it using the pinned template before 7:00 PM.',
    ...(data.missing.length ? [
      'No interview update has been recorded yet for:',
      ...data.missing.map(mention),
    ] : ['Everyone has shared at least one interview update this week.']),
  ]);
  return { count: data.missing.length };
}

async function interviewChallengeStudents(cohort, roster, today) {
  const start = shiftDateKey(today, -90);
  const summary = await appsScriptGet(cohort, { action: 'performance', start, end: today }, { label: 'Interview challenge summary' });
  const activeByEmail = new Map(roster.map(student => [String(student.email || '').toLowerCase(), student]));
  const candidates = (summary.students || []).filter(student =>
    Number(student.interviews) >= 3 && activeByEmail.has(String(student.email || '').toLowerCase()));
  const cutoff = shiftDateKey(today, -7);
  const result = [];
  for (const candidate of candidates) {
    const detail = await appsScriptGet(cohort, {
      action: 'performance', start, end: today, email: candidate.email, includeHistory: 1,
    }, { label: 'Interview challenge detail' });
    const history = detail.students?.[0]?.interviewHistory || [];
    const last = history.map(item =>
      parseDateValue(item.interviewDate, '', cohort.timezone) ||
      parseDateValue(item.loggedDate, '', cohort.timezone))
      .filter(Boolean).sort().at(-1) || '';
    if (last && last <= cutoff) result.push({
      ...activeByEmail.get(String(candidate.email || '').toLowerCase()),
      interviews: candidate.interviews,
      last,
    });
    await sleep(150);
  }
  return result;
}

async function runInterviewReview(client, cohort) {
  if (weekdayNumber(localDateKey(cohort.timezone)) !== 4) return { count: 0, skipped: true };
  const data = await weeklyInterviewData(client, cohort);
  const challenges = await interviewChallengeStudents(cohort, data.roster, data.today);
  const channel = await client.channels.fetch(cohort.channels.interviewUpdates);
  const lines = [
    '@everyone\n📋 **Thursday interview and application-process review**',
    'Students with no recorded interview update this week must share their updated resume and profiles with the mentor and sit for a job-application process review:',
    ...(data.missing.length ? data.missing.map(mention) : ['• None']),
  ];
  if (challenges.length) {
    lines.push(
      '',
      'Students with at least three recent interviews but no hired update seven days after the latest interview should discuss interview challenges, communication gaps, and whether a one-to-one session is needed:',
      ...challenges.map(student => `• ${mention(student)} — ${student.interviews} interviews · latest recorded ${student.last}`),
    );
  }
  await sendLines(channel, lines);
  return { count: data.missing.length, challenges: challenges.length };
}

function activityResultLine(kind, result) {
  const count = Math.max(0, Number(result?.count || 0));
  if (kind === 'attendance') {
    if (result?.skipped) return `Attendance warnings: skipped — ${result.reason || 'the evaluated session is not recorded'}.`;
    if (result?.duplicate) return 'Attendance warnings: **0 new** (qualifying incidents were already counted).';
    return count
      ? `Attendance warnings: **${count} new**${result?.inactive ? ` · **${result.inactive}** became inactive` : ''}.`
      : 'Attendance warnings: **0 new** (no active student currently has a new two-session unapproved absence incident).';
  }
  if (kind === 'jobs') return `Application emergencies: **${count}** student(s) flagged.`;
  if (kind === 'interviews') return result?.skipped
    ? 'Interview review: skipped because today is not Thursday.'
    : `Interview review: **${count}** student(s) without a weekly update${result?.challenges ? ` · **${result.challenges}** interview-challenge follow-up(s)` : ''}.`;
  return `${kind}: completed.`;
}

module.exports = function registerActivityAutomation(client) {
  const recoverPending = async () => {
    await sleep(15 * 1000);
    for (const cohort of cohorts) {
      await recoverAttendanceFollowup(client, cohort).catch(error => {
        console.error(`[post-attendance] ${cohort.name} startup recovery failed:`, error.message);
      });
    }
  };
  if (client.isReady?.()) recoverPending();
  else client.once('clientReady', recoverPending);

  for (const cohort of cohorts) {
    for (const [kind, setting] of [
      ['outreach', 'outreachprompttime'],
      ['interview', 'interviewprompttime'],
      ['communication', 'communicationprompttime'],
    ]) {
      scheduleAtSetting(cohort, `activityprompt:${kind}`, setting, async () => {
        if (!(await isOn(cohort, `${kind}prompt`)) || !(await isScheduledToday(cohort, `${kind}prompt`)) || (await isWarmup(cohort))) return;
        await postPrompt(client, cohort, kind);
      });
    }
    scheduleAtSetting(cohort, 'attendancewarning', 'attendancewarningtime', async () => {
      await recoverAttendanceFollowup(client, cohort);
    });
    scheduleAtSetting(cohort, 'jobemergency', 'jobemergencytime', async () => {
      if ((await isOn(cohort, 'jobemergency')) && !(await isWarmup(cohort))) await runJobEmergency(client, cohort);
    });
    scheduleAtSetting(cohort, 'interviewmorning', 'interviewmorningtime', async () => {
      if ((await isOn(cohort, 'interviewfollowup')) && (await isScheduledToday(cohort, 'interviewfollowup')) && !(await isWarmup(cohort))) await runInterviewMorning(client, cohort);
    });
    scheduleAtSetting(cohort, 'interviewreview', 'interviewreviewtime', async () => {
      if ((await isOn(cohort, 'interviewfollowup')) && (await isScheduledToday(cohort, 'interviewfollowup')) && !(await isWarmup(cohort))) await runInterviewReview(client, cohort);
    });
  }

  client.on('messageCreate', async message => {
    if (message.author.bot) return;
    const parsed = parseActivityCommand(message.content);
    if (!parsed) return;
    const cohort = cohorts.find(item => item.guildId === message.guildId);
    if (!cohort || !cohort.supervisorIds.includes(message.author.id)) return;
    if (message.channelId !== cohort.channels.supervisor) return message.reply(`Run this command in <#${cohort.channels.supervisor}>.`);
    const { action, kind, date: requestedDate } = parsed;
    try {
      await message.reply('⏳ Running the requested cohort activity automation...');
      if (action === 'prompt') {
        const kinds = kind === 'all' ? ['outreach', 'interview', 'communication'] : [kind];
        if (!kinds.every(item => PROMPTS[item])) throw new Error('Prompt choices: outreach, interview, communication, all');
        for (const item of kinds) await postPrompt(client, cohort, item);
      } else {
        const runners = {
          attendance: (bot, item) => runAttendanceWarning(bot, item, {
            endDate: requestedDate || localDateKey(item.timezone),
          }),
          jobs: runJobEmergency,
          interviews: runInterviewReview,
        };
        if (requestedDate && (!validDateKey(requestedDate) || kind !== 'attendance')) {
          throw new Error('A date can be supplied only with `!activitycheck attendance YYYY-MM-DD`.');
        }
        const kinds = kind === 'all' ? Object.keys(runners) : [kind];
        if (!kinds.every(item => runners[item])) throw new Error('Check choices: attendance, jobs, interviews, all');
        const results = [];
        for (const item of kinds) {
          results.push(activityResultLine(item, await runners[item](client, cohort)));
        }
        await message.reply({
          content: `✅ Activity check completed.\n${results.map(line => `• ${line}`).join('\n')}`,
          allowedMentions: { parse: [] },
        });
        return;
      }
      await message.reply('✅ Activity automation completed.');
    } catch (error) {
      await message.reply(`❌ Activity automation failed: ${String(error.message).slice(0, 300)}`);
    }
  });
};

module.exports.PROMPTS = PROMPTS;
module.exports.belowJobTarget = belowJobTarget;
module.exports.consecutiveAbsenceTail = consecutiveAbsenceTail;
module.exports.runAttendanceWarning = runAttendanceWarning;
module.exports.scheduleAttendanceWarningAfterReport = scheduleAttendanceWarningAfterReport;
module.exports.attendanceFollowupPlan = attendanceFollowupPlan;
module.exports.parseAttendanceFollowup = parseAttendanceFollowup;
module.exports.parseActivityCommand = parseActivityCommand;
module.exports.currentSunday = currentSunday;
module.exports.previousWorkdays = previousWorkdays;
module.exports.privateContactLines = privateContactLines;
module.exports.sendPrivateContactReport = sendPrivateContactReport;
module.exports.withoutInterviews = withoutInterviews;
module.exports.activityResultLine = activityResultLine;
