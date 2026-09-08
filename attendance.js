// ============================================================
//  attendance.js v2 - daily attendance with real absent mentions
//  + per-student inactivity history + !attendance test command
//
//  Post structure (mentions inside embeds do NOT notify, so):
//   1) Summary EMBED: counts, mood, interviews, present names
//   2) Plain MESSAGES: absent @mentions + history (these ping)
// ============================================================

const { cohorts } = require('./config');
const { isOn } = require('./automations');
const { isScheduledToday } = require('./scheduler');
const { resolveChannel } = require('./settings');
const { scheduleAtSetting } = require('./runtime-schedule');
const { getRoster, isExcluded, syncMembers } = require('./roster');
const { appsScriptGet, appsScriptPost } = require('./apps-script-api');
const {
  absenceCommandQuery,
  absenceTsvLines,
  copyableCodeBlocks,
  parseAbsencePeriod,
} = require('./absence-period');

// remembers which date was already posted per cohort (in-memory)
const lastPosted = {};
const publicationRuns = new Map();

function markPosted(cohort) {
  lastPosted[cohort.guildId] = new Date().toLocaleDateString('en-CA', { timeZone: cohort.timezone });
}
function alreadyPostedToday(cohort) {
  return lastPosted[cohort.guildId] === new Date().toLocaleDateString('en-CA', { timeZone: cohort.timezone });
}

// Reminders TO SUPERVISORS ONLY - the clock never touches students.
async function formStatus(cohort) {
  return appsScriptGet(cohort, { action: 'formstatus' }, { label: 'Attendance form status' });
}

function attendanceIdentityKey(student) {
  const discordId = String(student?.discordId || '').trim();
  if (discordId) return `id:${discordId}`;
  const email = String(student?.email || '').trim().toLowerCase();
  return email ? `email:${email}` : '';
}

function attendanceNameKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function attendanceResponsePolicy(data) {
  return {
    backendBlocked: data?.blocked === true,
    blockReason: String(data?.blockReason || ''),
    rejectedIdentityResponses: (data?.identityIssues || []).length,
    invalidTimestampRows: (data?.invalidDateRows || []).length,
  };
}

// A same-name active account in both present and absent results is usually a
// duplicate Discord account. Never guess which account should be removed and
// never publicly accuse the absent account until a supervisor resolves it.
function conflictingAttendanceIdentities(data) {
  const presentByName = new Map();
  for (const student of [...(data?.present || []), ...(data?.leave || [])]) {
    const key = attendanceNameKey(student.name);
    if (key) presentByName.set(key, student);
  }
  return (data?.absent || []).map(absent => ({
    key: attendanceNameKey(absent.name),
    present: presentByName.get(attendanceNameKey(absent.name)),
    absent,
  })).filter(item => item.key && item.present &&
    String(item.present.discordId || '') !== String(item.absent.discordId || ''));
}

function attendancePublicationKey(cohort, date) {
  return `attendance_publication_v1_${cohort.guildId}_${date}`;
}

function parseAttendancePublication(value, date, channelId) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    if (parsed.date !== date || String(parsed.channelId || '') !== String(channelId || '')) return null;
    return {
      date,
      channelId: String(channelId),
      summaryId: String(parsed.summaryId || ''),
      segmentIds: Array.isArray(parsed.segmentIds)
        ? parsed.segmentIds.map(String).filter(Boolean) : [],
    };
  } catch { return null; }
}

function attendanceSegments(absent, date) {
  if (!absent.length) {
    return [{
      content: `🎉 **Attendance ${date}: everyone submitted attendance or had approved leave. Outstanding!**`,
      ping: false,
    }];
  }
  const lines = absent.map(student => {
    const tag = student.discordId ? `<@${student.discordId}>` : `**${student.name}**`;
    let line = `❌ ${tag}`;
    if (student.history && student.history.total > 0) {
      line += ` — missed ${student.history.missed} of last ${student.history.total} sessions`;
      if (student.history.streak >= 3) line += ` 🔴 ${student.history.streak} in a row`;
    }
    return line;
  });
  const bodyChunks = chunkLines(lines, 1740);
  return bodyChunks.map((body, index) => ({
    content: [
      index === 0 ? '@everyone' : '',
      `📢 **Attendance ${date} — absent students (part ${index + 1}/${bodyChunks.length})**`,
      body,
    ].filter(Boolean).join('\n'),
    ping: true,
  }));
}

async function discoverAttendancePublication(channel, botId, date) {
  const messages = [];
  let before;
  for (let page = 0; page < 5; page++) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    const values = [...batch.values()];
    if (!values.length) break;
    messages.push(...values);
    before = values[values.length - 1].id;
    if (messages.some(message => message.author?.id === botId &&
      message.embeds?.some(embed => String(embed.title || '').endsWith(`Daily Attendance — ${date}`)))) break;
  }
  const summaries = messages.filter(message => message.author?.id === botId &&
    message.embeds?.some(embed => String(embed.title || '').endsWith(`Daily Attendance — ${date}`)));
  const summary = summaries.sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0] || null;
  if (!summary) return { summary: null, segments: [] };
  const segments = messages.filter(message => {
    if (message.author?.id !== botId || message.id === summary.id) return false;
    if (message.createdTimestamp < summary.createdTimestamp ||
        message.createdTimestamp > summary.createdTimestamp + 10 * 60 * 1000) return false;
    const content = String(message.content || '');
    return content.includes(`Attendance ${date}`) ||
      /Absent today — please submit attendance daily|Everyone submitted attendance today/.test(content);
  }).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return { summary, segments };
}

async function publishAttendance(client, cohort, channel, embed, segments) {
  const key = `${cohort.guildId}:${embed.title}`;
  const previousRun = publicationRuns.get(key) || Promise.resolve();
  const run = previousRun.catch(() => {}).then(async () => {
    let stored = null;
    try {
      const response = await appsScriptGet(cohort, {
        action: 'getstate', k: attendancePublicationKey(cohort, embed.date),
      }, { label: 'Attendance publication state' });
      stored = parseAttendancePublication(response.value, embed.date, channel.id);
    } catch (error) {
      console.error(`[attendance] ${cohort.name} publication state read failed:`, error.message);
    }

    let summary = stored?.summaryId
      ? await channel.messages.fetch(stored.summaryId).catch(() => null) : null;
    let existingSegments = [];
    if (stored?.segmentIds?.length) {
      existingSegments = (await Promise.all(stored.segmentIds.map(id =>
        channel.messages.fetch(id).catch(() => null)))).filter(Boolean);
    }
    if (!summary) {
      const discovered = await discoverAttendancePublication(channel, client.user.id, embed.date);
      summary = discovered.summary;
      if (!existingSegments.length) existingSegments = discovered.segments;
    }

    const updated = Boolean(summary);
    if (summary) await summary.edit({ embeds: [embed.payload] });
    else summary = await channel.send({ embeds: [embed.payload] });

    const active = [];
    for (let i = 0; i < segments.length; i++) {
      const payload = {
        content: segments[i].content,
        allowedMentions: updated ? { parse: [] } :
          (segments[i].ping ? { parse: ['users', 'everyone'] } : { parse: [] }),
      };
      let message = existingSegments[i];
      if (message) await message.edit(payload);
      else message = await channel.send(payload);
      active.push(message);
      await sleep(500);
    }
    for (const stale of existingSegments.slice(segments.length)) {
      await stale.edit({
        content: `ℹ️ **Attendance ${embed.date} updated:** this earlier segment is no longer current. See the attendance report above.`,
        allowedMentions: { parse: [] },
      });
    }

    try {
      await appsScriptPost(cohort, {
        action: 'setState',
        k: attendancePublicationKey(cohort, embed.date),
        v: JSON.stringify({
          date: embed.date,
          channelId: channel.id,
          summaryId: summary.id,
          segmentIds: active.map(message => message.id),
        }),
      }, { idempotent: true, label: 'Attendance publication state write' });
    } catch (error) {
      console.error(`[attendance] ${cohort.name} publication state write failed:`, error.message);
    }
    return { updated, summaryId: summary.id, segmentIds: active.map(message => message.id) };
  });
  publicationRuns.set(key, run);
  try { return await run; }
  finally { if (publicationRuns.get(key) === run) publicationRuns.delete(key); }
}

// Apps Script also applies this rule. Keeping a second check immediately
// before Discord publishing prevents a stale backend deployment/state read
// from publicly counting or pinging students who were already inactive.
function reconcileAttendanceRoster(data, cohort, roster, excludedCheck = isExcluded) {
  const eligibleKeys = new Set();
  const eligibleNames = new Set();
  for (const student of roster || []) {
    if (excludedCheck(cohort, student)) continue;
    const key = attendanceIdentityKey(student);
    if (key) eligibleKeys.add(key);
    if (student.name) eligibleNames.add(String(student.name).trim().toLowerCase());
  }

  const filterStudents = students => (students || []).filter(student => {
    const key = attendanceIdentityKey(student);
    return key && eligibleKeys.has(key);
  });
  const absent = filterStudents(data?.absent);
  const present = filterStudents(data?.present);
  const leave = filterStudents(data?.leave);
  const originalCount = (data?.absent || []).length + (data?.present || []).length +
    (data?.leave || []).length;

  return {
    absent,
    present,
    leave,
    interviewsToday: (data?.interviewsToday || []).filter(name =>
      eligibleNames.has(String(name || '').trim().toLowerCase())),
    excludedCount: originalCount - absent.length - present.length - leave.length,
  };
}

async function backendGet(cohort, params) {
  return appsScriptGet(cohort, params, { label: 'Attendance backend read' });
}

async function backendPost(cohort, body) {
  return appsScriptPost(cohort, body, { label: 'Attendance backend write' });
}

async function remindOpen(client, cohort) {
  try {
    if (!(await isOn(cohort, 'attendance'))) return;
    if (!(await isScheduledToday(cohort, 'attendance'))) return;
    const s = await formStatus(cohort);
    if (s.accepting) return; // already open - nothing to say
    const admin = await client.channels.fetch(cohort.channels.supervisor);
    await admin.send('🔔 Attendance form is **not open yet**. If class is on today, run `!openform`. (If it\'s a day off, just ignore me.)');
  } catch (err) { console.error(`[attendance] ${cohort.name} open-reminder failed:`, err.message); }
}

async function remindClose(client, cohort) {
  try {
    if (!(await isOn(cohort, 'attendance'))) return;
    if (!(await isScheduledToday(cohort, 'attendance'))) return;
    const s = await formStatus(cohort);
    if (!s.accepting) return; // already closed (you ran !closeform) - silence
    const admin = await client.channels.fetch(cohort.channels.supervisor);
    await admin.send('🔔 Attendance form is **still open**. When the deadline is over, run `!closeform` — it closes the form and posts the absent announcement automatically.');
  } catch (err) { console.error(`[attendance] ${cohort.name} close-reminder failed:`, err.message); }
}

function setupAttendance(client) {
  for (const cohort of cohorts) {
    if (!cohort.appsScriptUrl || !cohort.channels.discussion) {
      console.warn(`[attendance] ${cohort.name}: missing URL or channel, skipped`);
      continue;
    }
    scheduleAtSetting(cohort, 'formopen', 'formopenremindertime', () => remindOpen(client, cohort));
    scheduleAtSetting(cohort, 'formclose', 'formcloseremindertime', () => remindClose(client, cohort));
    console.log(`[attendance] ${cohort.name}: runtime-configurable reminders active`);
  }

  // !attendance - supervisor-only instant post (testing / manual repost)
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const content = msg.content.trim();
    const lower = content.toLowerCase();
    const command = lower.split(/\s+/)[0];
    if (![
      '!attendance', '!checkattendance', '!repairattendance',
      '!checkpipelines', '!repairpipelines',
      '!setupsheets', '!arrangesheets', '!absent', '!absences',
    ].includes(command)) return;
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;
    if (command === '!attendance') {
      const requestedDate = content.split(/\s+/)[1] || '';
      const parsedDate = requestedDate ? new Date(`${requestedDate}T12:00:00.000Z`) : null;
      if (requestedDate && (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ||
          Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== requestedDate)) {
        await msg.reply('Use `!attendance` for today or `!attendance YYYY-MM-DD` to repair a previous report.');
        return;
      }
      await msg.reply(`📋 Rechecking attendance and posting or updating ${requestedDate || 'today'}...`);
      await postAttendance(client, cohort, requestedDate);
      return;
    }

    if (msg.channelId !== cohort.channels.supervisor) {
      await msg.reply(`Run this private command in <#${cohort.channels.supervisor}>.`);
      return;
    }

    if (command === '!checkattendance') {
      const requestedDate = content.split(/\s+/)[1] || '';
      if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
        await msg.reply('Use `!checkattendance` for today or `!checkattendance YYYY-MM-DD`.');
        return;
      }
      await msg.reply(`🔎 Auditing Attendance roster and responses${requestedDate ? ` for ${requestedDate}` : ''}...`);
      try {
        const data = await backendGet(cohort, {
          action: 'attendanceaudit',
          date: requestedDate,
          guildId: cohort.guildId,
        });
        const responseProblems = (data.identityIssues || []).length;
        const invalidDates = (data.invalidDateRows || []).length;
        const correctedDates = (data.correctedDateRows || []).length;
        const duplicateSubmissions = (data.duplicateSubmissionRows || []).length;
        const interviewConflicts = (data.interviewConflictRows || []).length;
        const incompleteProfiles = data.unlinkedDiscordStudents || [];
        // Missing phone/location data does not mean the immutable Discord ID
        // or the student's Attendance row is unlinked.
        const ready = data.discordRosterCaptured !== false &&
          (data.missingAttendanceRows || []).length === 0 &&
          (data.duplicateAttendanceEmails || []).length === 0 &&
          (data.orphanAttendanceRows || []).length === 0 &&
          responseProblems === 0 && invalidDates === 0;
        await msg.channel.send({
          embeds: [{
            title: `${ready ? '✅' : '⚠️'} Attendance Audit — ${cohort.name}`,
            color: ready ? 0x2ecc71 : 0xe67e22,
            description: [
              `Date: **${data.date}**`,
              `Current Discord students: **${data.currentDiscordStudents}** · profiles complete: **${data.identityLinkedStudents}** · profiles incomplete: **${incompleteProfiles.length}**`,
              data.discordRosterCaptured === false
                ? '⚠️ Roster Review is empty — run `!syncmembers` before trusting Discord coverage.'
                : '',
              `Active Bot_Map students: **${data.activeRosterStudents}** · Attendance rows: **${data.attendanceRows}**`,
              `Color-inactive without hired/left status: **${(data.inactiveRosterStudents || []).length}**`,
              `Missing Attendance rows: **${(data.missingAttendanceRows || []).length}** · duplicate emails: **${(data.duplicateAttendanceEmails || []).length}** · blank-email rows: **${(data.orphanAttendanceRows || []).length}**`,
              `Form submissions by timestamp: **${data.responseRows}** · distinct matched students: **${data.matchedResponses}** · duplicate submissions: **${duplicateSubmissions}**`,
              `Contradictory interview answers suppressed: **${interviewConflicts}**`,
              `Student-entered dates corrected from Timestamp: **${correctedDates}** · identity issues: **${responseProblems}**`,
              `Counted present (Form or matrix P): **${(data.presentStudents || []).length}** · approved leave (L): **${(data.leaveStudents || []).length}** · absent/blank: **${(data.notPresentStudents || []).length}**`,
              invalidDates ? `Unrecognized date rows anywhere in response tab: **${invalidDates}**` : '',
            ].filter(Boolean).join('\n'),
            footer: {
              text: ready
                ? 'Attendance-ready: every active student has one usable row and today has no unmatched response.'
                : 'Run !repairattendance for missing rows. Unmatched identities are rejected; editable dates use the Form Timestamp.',
            },
            timestamp: new Date().toISOString(),
          }],
          allowedMentions: { parse: [] },
        });

        const reviewLines = [
          'STATUS\tNAME\tEMAIL\tPHONE\tDISCORD USERNAME\tDISCORD ID / DETAILS',
          ...(data.notPresentStudents || []).map(item =>
            `NO ATTENDANCE\t${item.name || ''}\t${item.email || ''}\t${item.phone || ''}\t${item.username || ''}\t${item.discordId || ''}`),
          ...(data.presentStudents || []).map(item =>
            `PRESENT (${item.source || 'MATCHED'})\t${item.name || ''}\t${item.email || ''}\t${item.phone || ''}\t${item.username || ''}\t${item.discordId || ''}`),
          ...(data.leaveStudents || []).map(item =>
            `APPROVED LEAVE\t${item.name || ''}\t${item.email || ''}\t${item.phone || ''}\t${item.username || ''}\t${item.discordId || ''}`),
          ...incompleteProfiles.map(item =>
            `PROFILE INCOMPLETE\t${item.displayName || item.username || item.discordId}\t\t\t${item.username || ''}\t${item.discordId || ''} ${item.reason || ''}`),
          ...(data.inactiveRosterStudents || []).map(item =>
            `INACTIVE COLOR\t${item.name || ''}\t${item.email || ''}\t\t${item.username || ''}\t${(item.reasons || []).join('; ') || 'non-neutral identity color'}`),
          ...(data.missingAttendanceRows || []).map(item =>
            `MISSING ROW\t${item.name || ''}\t${item.email || ''}\t${item.phone || ''}\t${item.username || ''}\t${item.discordId || ''}`),
          ...(data.duplicateAttendanceEmails || []).map(item =>
            `DUPLICATE EMAIL\t${item.email}\trows ${(item.rows || []).join(',')}`),
          ...(data.orphanAttendanceRows || []).map(row =>
            `BLANK EMAIL\tAttendance row ${row}`),
          ...(data.identityIssues || []).map(item =>
            `UNMATCHED RESPONSE\trow ${item.row}\t${item.reason || ''}\t${item.submitted || ''}`),
          ...(data.invalidDateRows || []).map(item =>
            `INVALID DATE\trow ${item.row}\t${item.submitted || ''}`),
          ...(data.correctedDateRows || []).map(item =>
            `DATE AUTO-CORRECTED\trow ${item.row}\tselected ${item.selected || ''}\tcounted as ${item.countedAs || ''}`),
          ...(data.duplicateSubmissionRows || []).map(item =>
            `DUPLICATE SUBMISSION\trow ${item.row}\t${item.email || ''}\tfirst response row ${item.firstRow || ''}`),
          ...(data.interviewConflictRows || []).map(item =>
            `INTERVIEW ANSWER CONFLICT\trow ${item.row}\t${item.email || ''}\t\t\tYes + explicit no-interview confirmation`),
        ];
        for (const block of copyableCodeBlocks(reviewLines, 1900)) {
          await msg.channel.send({ content: block, allowedMentions: { parse: [] } });
        }
      } catch (err) {
        await msg.reply(`❌ Attendance audit failed: ${err.message.slice(0, 300)}`);
      }
      return;
    }

    if (command === '!repairattendance') {
      await msg.reply('🛠️ Adding/updating every active Discord-linked student in Attendance. Existing dates and marks will be preserved...');
      try {
        const data = await backendPost(cohort, {
          action: 'repairAttendanceRoster',
          guildId: cohort.guildId,
        });
        await msg.channel.send({
          content: [
            `✅ **Attendance roster repaired — ${cohort.name}**`,
            `• Active linked students: ${data.activeStudents}`,
            `• Rows added: ${data.added} · identity cells updated: ${data.updated}`,
            `• Still missing: ${(data.missingAttendanceRows || []).length}`,
            `• Duplicate emails needing manual review: ${(data.duplicateAttendanceEmails || []).length}`,
            `• Blank-email rows needing manual review: ${(data.orphanAttendanceRows || []).length}`,
            'Next: run `!checkattendance` before closing the Form.',
          ].join('\n'),
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        await msg.reply(`❌ Attendance repair failed: ${err.message.slice(0, 300)}`);
      }
      return;
    }

    if (command === '!checkpipelines') {
      const args = content.split(/\s+/).slice(1);
      const requestedDate = args.find(value => /^\d{4}-\d{2}-\d{2}$/.test(value)) || '';
      const invalidArg = args.find(value => value.toLowerCase() !== 'all' &&
        !/^\d{4}-\d{2}-\d{2}$/.test(value));
      if (invalidArg) {
        await msg.reply('Use `!checkpipelines [YYYY-MM-DD] [all]`.');
        return;
      }
      const showAll = args.some(value => value.toLowerCase() === 'all');
      await msg.reply(`🔎 Auditing Attendance, job trackers, interviews, and outreach${requestedDate ? ` for ${requestedDate}` : ''}...`);
      try {
        const data = await backendGet(cohort, {
          action: 'pipelineaudit',
          date: requestedDate,
          guildId: cohort.guildId,
        });
        const attendanceProblems =
          (data.attendance.error ? 1 : 0) +
          (data.attendance.missingRows || []).length +
          (data.attendance.duplicateEmails || []).length +
          (data.attendance.orphanRows || []).length +
          (data.attendance.identityIssues || []).length +
          (data.attendance.invalidDateRows || []).length;
        const problemCount =
          attendanceProblems +
          (data.jobs.missing || []).length +
          (data.unlinkedDiscordStudents || []).length +
          (data.inactiveColorStudents || []).length;
        await msg.channel.send({
          embeds: [{
            title: `${problemCount ? '⚠️' : '✅'} Activity Pipeline Audit — ${cohort.name}`,
            color: problemCount ? 0xe67e22 : 0x2ecc71,
            description: [
              `Date: **${data.date}**`,
              `Discord students: **${data.currentDiscordStudents}** · profiles complete: **${data.identityLinkedStudents}** · active after status/color rules: **${data.activeStudents}**`,
              `Color-inactive: **${(data.inactiveColorStudents || []).length}** · hired/left: **${data.hiredOrLeftStudents}**`,
              data.attendance.error
                ? `Attendance: **ERROR** · ${String(data.attendance.error).slice(0, 180)}`
                : `Attendance present: **${data.attendance.present}** · structural/identity issues: **${attendanceProblems}**`,
              `Job trackers linked: **${data.jobs.linked}/${data.activeStudents}** · daily counts saved: **${data.jobs.savedForDate}**`,
              `Outreach events: **${data.outreachEvents}** · interviews logged: **${data.interviews}**`,
            ].join('\n'),
            footer: {
              text: showAll
                ? 'Private all-student report.'
                : 'Private problems-only report. Add "all" to list every active student.',
            },
            timestamp: new Date().toISOString(),
          }],
          allowedMentions: { parse: [] },
        });

        const lines = [
          'STATUS\tNAME\tEMAIL\tPHONE\tDISCORD USERNAME\tDISCORD ID / DETAILS',
          ...(data.unlinkedDiscordStudents || []).map(item =>
            `PROFILE INCOMPLETE\t${item.displayName || ''}\t\t\t${item.username || ''}\t${item.discordId || ''} ${item.reason || ''}`),
          ...(data.attendance.error
            ? [`ATTENDANCE ERROR\t\t\t\t\t${data.attendance.error}`]
            : []),
          ...(data.inactiveColorStudents || []).map(item =>
            `INACTIVE COLOR\t${item.name || ''}\t${item.email || ''}\t\t${item.username || ''}\t${item.discordId || ''} ${(item.reasons || []).join('; ')}`),
          ...(data.jobs.missing || []).map(item =>
            `MISSING TRACKER\t${item.name || ''}\t${item.email || ''}\t\t${item.username || ''}\t${item.discordId || ''}`),
          ...(data.attendance.missingRows || []).map(item =>
            `MISSING ATTENDANCE ROW\t${item.name || ''}\t${item.email || ''}\t${item.phone || ''}\t${item.username || ''}\t${item.discordId || ''}`),
          ...(data.attendance.duplicateEmails || []).map(item =>
            `DUPLICATE ATTENDANCE\t\t${item.email || ''}\t\t\trows ${(item.rows || []).join(',')}`),
          ...(data.attendance.identityIssues || []).map(item =>
            `UNMATCHED ATTENDANCE RESPONSE\trow ${item.row}\t\t\t\t${item.reason || ''} ${item.submitted || ''}`),
          ...(data.attendance.invalidDateRows || []).map(item =>
            `INVALID ATTENDANCE DATE\trow ${item.row}\t\t\t\t${item.submitted || ''}`),
          ...(showAll ? (data.students || []).map(item =>
            `ACTIVE\t${item.name || ''}\t${item.email || ''}\t${item.phone || ''}\t${item.username || ''}\tattendance=${item.attendance}; tracker=${item.tracker}; jobs=${item.jobs === null ? 'not saved' : item.jobs}; outreach=${item.outreach}; interviews=${item.interviews}`) : []),
        ];
        for (const block of copyableCodeBlocks(lines, 1900)) {
          await msg.channel.send({ content: block, allowedMentions: { parse: [] } });
        }
      } catch (err) {
        await msg.reply(`❌ Pipeline audit failed: ${err.message.slice(0, 300)}`);
      }
      return;
    }

    if (command === '!repairpipelines') {
      await msg.reply('🛠️ Repairing identity rows and schemas for Attendance, Jobs Applied, Outreach Update, Interview Updates, and Interview Log. Existing activity history and manual Attendance remarks are preserved...');
      try {
        const data = await backendPost(cohort, {
          action: 'repairActivityPipelines',
          guildId: cohort.guildId,
        });
        await msg.channel.send({
          content: [
            `✅ **Activity pipelines repaired — ${cohort.name}**`,
            `• Active students: ${data.activeStudents}`,
            `• Attendance rows added: ${data.attendance.added} · identities updated: ${data.attendance.updated}`,
            `• Jobs Applied rows added: ${data.jobs.added || 0} · updated: ${data.jobs.updated || 0}`,
            `• Outreach Update rows added: ${data.outreach.added || 0} · updated: ${data.outreach.updated || 0}`,
            `• Interview Updates rows added: ${data.interviews?.added || 0} · updated: ${data.interviews?.updated || 0}`,
            `• Outreach summaries reconciled: ${data.outreachSummaries?.reconciledStudents || 0} student(s) from ${data.outreachSummaries?.durableEvents || 0} durable event(s)`,
            `• Inactive rows styled: Attendance ${data.statusStyles?.attendance?.inactive || 0} · Jobs ${data.statusStyles?.jobs?.inactive || 0} · Outreach ${data.statusStyles?.outreach?.inactive || 0} · Interviews ${data.statusStyles?.interviews?.inactive || 0}`,
            '• Job_Sheets, Jobs_Daily, Interview_Log, Outreach_Log, and Outreach_Daily schemas verified.',
            'Next: `!checkpipelines` and, when needed, `!backfilljobsheets [N days]` / `!backfilloutreach [N days]` (default 3).',
          ].join('\n'),
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        await msg.reply(`❌ Pipeline repair failed: ${err.message.slice(0, 300)}`);
      }
      return;
    }

    if (command === '!arrangesheets') {
      await msg.reply('🗂️ Arranging Sheet tabs without deleting or hiding anything...');
      try {
        const data = await backendPost(cohort, { action: 'arrangeSheetTabs' });
        const lines = (data.groups || []).map(group =>
          `• ${group.label}: ${group.tabs.length ? group.tabs.join(', ') : 'no existing tabs'}`
        );
        const renamed = (data.responseTabsRenamed || []).map(item =>
          `• Renamed \`${item.from}\` → \`${item.to}\``
        );
        const conflicts = (data.responseTabConflicts || []).map(item => `⚠️ ${item}`);
        await msg.channel.send({
          content: [
            `✅ **Sheet tabs arranged — ${cohort.name}**`,
            ...renamed,
            ...lines,
            ...conflicts,
            `• Unknown/custom tabs preserved: ${data.preservedUnknown || 0}`,
            'Blue = manual review · Green = active forms/reference · Yellow = other Form tabs to review · Gray = bot-maintained data.',
          ].join('\n'),
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        await msg.reply(`❌ Sheet tab arrangement failed: ${err.message.slice(0, 300)}`);
      }
      return;
    }

    if (command === '!setupsheets') {
      const parts = lower.split(/\s+/);
      const mode = parts[1] || '';
      if (!['existing', 'empty'].includes(mode)) {
        await msg.reply(
          'Use `!setupsheets existing` to rebuild from durable history, or ' +
          '`!setupsheets empty confirm` to create a clean student template. Raw logs are preserved.',
        );
        return;
      }
      if (mode === 'empty' && parts[2] !== 'confirm') {
        await msg.reply(
          'This clears only the three matrix views, not raw history. Confirm with `!setupsheets empty confirm`.',
        );
        return;
      }
      await msg.reply(
        mode === 'existing'
          ? 'Rebuilding Jobs Applied, Outreach Update, and Interview Updates from existing durable history...'
          : 'Creating empty tracking matrices with the current student roster...',
      );
      try {
        const data = await backendPost(cohort, {
          action: 'setupTrackingSheets',
          mode,
          guildId: cohort.guildId,
        });
        await msg.channel.send({
          content: [
            `✅ **Tracking Sheets ready — ${mode === 'existing' ? 'existing data restored' : 'empty template'}**`,
            `• ${data.jobs.sheet}: ${data.jobs.students} students · ${data.jobs.dateColumns} date columns · ${data.jobs.filledCells} recorded cells`,
            `• ${data.outreach.sheet}: ${data.outreach.students} students · ${data.outreach.dateColumns} date columns · ${data.outreach.filledCells} recorded cells`,
            `• ${data.interviews.sheet}: ${data.interviews.students} students · ${data.interviews.dateColumns} date columns · ${data.interviews.filledCells} recorded cells`,
            `• Three-date alerts: Jobs ${data.jobs.alerts?.flagged || 0} · Outreach ${data.outreach.alerts?.flagged || 0} row(s) below 10 total`,
            `• Attendance alerts: ${data.attendanceFlags.flaggedStudents || 0} student(s) with 3+ consecutive recorded-session absences`,
            '• Tabs arranged: blue manual review, green forms/reference, gray bot data.',
            '• Jobs_Daily and Outreach_Daily raw history was preserved.',
          ].join('\n'),
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        await msg.reply(`❌ Tracking Sheet setup failed: ${err.message.slice(0, 300)}`);
      }
      return;
    }

    const query = absenceCommandQuery(content);
    let period;
    try {
      period = parseAbsencePeriod(query, { timezone: cohort.timezone });
    } catch (err) {
      await msg.reply(`❌ ${err.message}`);
      return;
    }

    await msg.reply(`🔎 Checking recorded attendance for **${period.label}**...`);
    try {
      const data = await backendGet(cohort, {
        action: 'absences',
        start: period.start,
        end: period.end,
        guildId: cohort.guildId,
      });
      const students = (data.students || []).filter(
        student => !cohort.supervisorIds.includes(String(student.discordId || '')),
      );
      const sessions = data.recordedSessions || [];
      if (!sessions.length) {
        await msg.channel.send({
          content: `ℹ️ No recorded Attendance date columns were found for **${period.label}**.`,
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (!students.length) {
        await msg.channel.send({
          content: `✅ No active student was absent across the **${sessions.length} recorded session(s)** in ${period.label}.`,
          allowedMentions: { parse: [] },
        });
        return;
      }

      const flagged = students.filter(student => Number(student.longestStreak) >= 3).length;
      await msg.channel.send({
        embeds: [{
          title: `📋 Private Absence Report — ${cohort.name}`,
          color: flagged ? 0xe74c3c : 0xe67e22,
          description: `${period.label}\nRecorded sessions: **${sessions.length}** · Students absent at least once: **${students.length}** · 3+ consecutive: **${flagged}**`,
          footer: { text: 'Private bot-admin contact report. Counts use recorded Attendance session columns only.' },
          timestamp: new Date().toISOString(),
        }],
      });

      const lines = absenceTsvLines(students);
      for (const block of copyableCodeBlocks(lines, 1900)) {
        await msg.channel.send({ content: block, allowedMentions: { parse: [] } });
      }
    } catch (err) {
      await msg.reply(`❌ Absence report failed: ${err.message.slice(0, 300)}`);
    }
  });
}

async function postAttendance(client, cohort, requestedDate = '') {
  try {
    // Attendance must use the current Discord membership, not yesterday's
    // Bot_Map. v34+ preserves manual review edits and provisions unmatched
    // members before the report is calculated.
    await syncMembers(client, cohort);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: cohort.timezone });
    const historic = requestedDate && requestedDate !== today;
    const raw = await appsScriptGet(cohort, historic ? {
      action: 'attendanceaudit', date: requestedDate, guildId: cohort.guildId,
    } : {
      action: 'attendance', guildId: cohort.guildId,
    }, { label: 'Attendance report', timeoutMs: 180000 });
    const data = historic ? {
      ...raw,
      present: raw.presentStudents || [],
      leave: raw.leaveStudents || [],
      absent: raw.notPresentStudents || [],
      avgMood: null,
      interviewsToday: [],
    } : raw;

    const channel = await client.channels.fetch(await resolveChannel(cohort, 'channel_attendance', cohort.channels.discussion));

    if (data.identityIssues?.length) {
      const admin = await client.channels.fetch(cohort.channels.supervisor);
      const issueLines = data.identityIssues.map(issue =>
        `• response row ${issue.row}: ${issue.reason}${issue.submitted ? ` — submitted: \`${String(issue.submitted).replace(/`/g, '')}\`` : ''}`
      );
      for (const chunk of chunkLines([
        `⚠️ **Attendance identity review — ${data.date}**`,
        'These submissions were rejected because they did not match one active roster identity. No student was guessed; the affected student remains absent unless another valid response or manual P/L mark exists.',
        ...issueLines,
      ], 1900)) {
        await admin.send({ content: chunk, allowedMentions: { parse: [] } });
      }
    }
    if (data.invalidDateRows?.length) {
      const admin = await client.channels.fetch(cohort.channels.supervisor);
      const dateLines = data.invalidDateRows.slice(0, 50).map(issue =>
        `• response row ${issue.row}: unrecognized date \`${String(issue.submitted || '').replace(/`/g, '')}\``
      );
      for (const chunk of chunkLines([
        `⚠️ **Attendance date review — ${data.date}**`,
        'These rows have missing/corrupt immutable Google Form Timestamps, so their calendar day cannot be proven. Editable student-selected dates never override the Timestamp.',
        ...dateLines,
        ...(data.invalidDateRows.length > dateLines.length
          ? [`…and ${data.invalidDateRows.length - dateLines.length} more`] : []),
      ], 1900)) {
        await admin.send({ content: chunk, allowedMentions: { parse: [] } });
      }
    }

    if (data.correctedDateRows?.length || data.duplicateSubmissionRows?.length || data.interviewConflictRows?.length) {
      const admin = await client.channels.fetch(cohort.channels.supervisor);
      const lines = [
        `ℹ️ **Attendance reconciliation — ${data.date}**`,
        data.correctedDateRows?.length
          ? `• ${data.correctedDateRows.length} student-entered date(s) differed from the immutable Form Timestamp and were counted by Timestamp.`
          : '',
        data.duplicateSubmissionRows?.length
          ? `• ${data.duplicateSubmissionRows.length} duplicate submission(s) were safely counted once per student; the latest answers control the summary.`
          : '',
        data.interviewConflictRows?.length
          ? `• ${data.interviewConflictRows.length} contradictory interview answer(s) were suppressed because the confirmation says no interview occurred.`
          : '',
      ].filter(Boolean);
      await admin.send({ content: lines.join('\n'), allowedMentions: { parse: [] } });
    }

    const responsePolicy = attendanceResponsePolicy(data);
    // Never interpret a backend's deliberately empty blocked lists as everyone
    // present. v55 blocks only missing/corrupt immutable timestamps; an older
    // backend may also block an unmatched email and must be upgraded first.
    if (responsePolicy.backendBlocked) {
      const admin = await client.channels.fetch(cohort.channels.supervisor);
      const reason = responsePolicy.blockReason === 'invalid-timestamps'
        ? 'One or more immutable Google Form Timestamps are missing or corrupt. Correct the response-sheet Timestamp evidence, then rerun `!attendance`.'
        : 'This Apps Script deployment still uses the older all-or-nothing email policy. Deploy backend v55, then run `!attendance` again.';
      await admin.send({
        content: `⛔ **Public attendance report stopped.** ${reason} No student was pinged as absent.`,
        allowedMentions: { parse: [] },
      });
      return { posted: false, date: data.date, reason: responsePolicy.blockReason || 'legacy-backend-blocked' };
    }

    const currentRoster = await getRoster(cohort);
    const reconciled = reconcileAttendanceRoster(data, cohort, currentRoster);
    const { absent, present, leave } = reconciled;
    data.interviewsToday = reconciled.interviewsToday;
    if (reconciled.excludedCount) {
      const admin = await client.channels.fetch(cohort.channels.supervisor);
      await admin.send({
        content: `ℹ️ Attendance excluded **${reconciled.excludedCount}** already-inactive, hired, left, protected, or supervisor record(s) before publishing.`,
        allowedMentions: { parse: [] },
      });
    }

    const collisions = conflictingAttendanceIdentities({ absent, present, leave });
    if (collisions.length) {
      const admin = await client.channels.fetch(cohort.channels.supervisor);
      const lines = [
        '⛔ **Public attendance update stopped — duplicate identity review required.**',
        'A present/approved-leave account and an absent account have the same normalized name. The bot did not guess or ping either account. Mark the duplicate account inactive, then run `!attendance` to edit the existing report.',
        ...collisions.map(item =>
          `• ${item.present.name}: present/leave ID \`${item.present.discordId || 'missing'}\` · absent ID \`${item.absent.discordId || 'missing'}\``),
      ];
      await admin.send({ content: lines.join('\n').slice(0, 1900), allowedMentions: { parse: [] } });
      return { posted: false, date: data.date, reason: 'duplicate-identity-review' };
    }

    // ---------- 1) SUMMARY EMBED ----------
    const presentNames = present.length
      ? present.map(s => s.name).join(', ')
      : '—';

    const embed = {
      title: `📋 ${cohort.name} Daily Attendance — ${data.date}`,
      color: absent.length ? 0xe67e22 : 0x2ecc71,
      fields: [
        { name: '✅ Present', value: String(present.length), inline: true },
        { name: '🟦 Approved leave', value: String(leave.length), inline: true },
        { name: '❌ Absent', value: String(absent.length), inline: true },
        ...(data.avgMood
          ? [{ name: '🙂 Avg mood', value: `${data.avgMood}/5`, inline: true }]
          : []),
        ...splitField('Present today', presentNames),
        ...(data.interviewsToday && data.interviewsToday.length
          ? splitField('🎯 Faced interviews today', data.interviewsToday.map(n => `• ${n}`).join('\n'))
          : []),
      ],
      timestamp: new Date().toISOString(),
    };
    const publication = await publishAttendance(client, cohort, channel, {
      date: data.date,
      title: embed.title,
      payload: embed,
    }, attendanceSegments(absent, data.date));

    console.log(`[attendance] ${cohort.name} ${publication.updated ? 'updated' : 'posted'} for ${data.date} (${absent.length} absent)`);
    return {
      posted: true,
      updated: publication.updated,
      date: data.date,
      absent: absent.length,
    };
  } catch (err) {
    console.error(`[attendance] ${cohort.name} failed:`, err.message);
    const admin = await client.channels.fetch(cohort.channels.supervisor).catch(() => null);
    if (admin?.isTextBased()) {
      await admin.send({
        content: `❌ **Attendance report stopped for ${cohort.name}:** ${String(err.message).slice(0, 300)}\nThe current Discord roster was not safely confirmed, so no student was silently omitted.`,
        allowedMentions: { parse: [] },
      }).catch(() => {});
    }
    return { posted: false, reason: String(err.message || err).slice(0, 300) };
  }
}

// group lines into messages under maxLen characters
function chunkLines(lines, maxLen) {
  const chunks = [];
  let cur = '';
  for (const line of lines) {
    if (cur.length + line.length + 1 > maxLen) {
      chunks.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// embed fields max 1024 chars - split long text across continuation fields
function splitField(name, text) {
  if (text.length <= 1024) return [{ name, value: text }];
  const fields = [];
  let chunk = '';
  for (const part of text.split(/(?<=, )|\n/)) {
    if (chunk.length + part.length > 1024) {
      fields.push({ name: fields.length ? `${name} (cont.)` : name, value: chunk });
      chunk = '';
    }
    chunk += part;
  }
  if (chunk) fields.push({ name: fields.length ? `${name} (cont.)` : name, value: chunk });
  return fields;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = {
  setupAttendance,
  postAttendance,
  markPosted,
  attendanceIdentityKey,
  attendanceNameKey,
  conflictingAttendanceIdentities,
  attendanceResponsePolicy,
  attendanceSegments,
  parseAttendancePublication,
  reconcileAttendanceRoster,
};
