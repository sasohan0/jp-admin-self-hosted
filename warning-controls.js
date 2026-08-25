'use strict';

const { cohorts } = require('./config');
const { appsScriptGet, appsScriptPost } = require('./apps-script-api');
const { isOn } = require('./automations');
const { getRoster, isExcluded, syncMembers } = require('./roster');
const { isScheduledToday } = require('./scheduler');
const { scheduleAtSetting } = require('./runtime-schedule');
const { isWarmup } = require('./state');
const { chunkLines } = require('./message-chunks');
const { dateKeyInZone, shiftDateKey, validDateKey } = require('./work-calendar');
const { getSetting, setSetting } = require('./settings');
const { rebaseWarningState, undoLatestWarningIncident } = require('./followup-rules');
const {
  getAttendanceWarningState,
  resetAttendanceWarnings,
  saveAttendanceWarningState,
  setStudentsActive,
} = require('./exclude');

function weekStart(dateKey) {
  const day = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return shiftDateKey(dateKey, -day);
}

function parseWarningCommand(content) {
  const text = String(content || '').trim();
  if (/^!warningreport$/i.test(text)) return { action: 'report' };
  if (!/^!warnings?(?:\s|$)/i.test(text)) return null;
  if (/^!warnings?\s+(?:start|rebase)$/i.test(text)) return { action: 'start-status' };
  const start = text.match(/^!warnings?\s+(?:start|rebase)\s+(\d{4}-\d{2}-\d{2})$/i);
  if (start) return { action: 'start', date: start[1] };
  const reset = text.match(/^!warnings?\s+reset\s+(?:<@!?(\d{15,22})>|(\d{15,22}))$/i);
  if (reset) return { action: 'reset', discordId: reset[1] || reset[2] };
  const undo = text.match(/^!warnings?\s+undo\s+(?:<@!?(\d{15,22})>|(\d{15,22}))$/i);
  if (undo) return { action: 'undo', discordId: undo[1] || undo[2] };
  const inspect = text.match(/^!warnings?\s+(?:<@!?(\d{15,22})>|(\d{15,22}))$/i);
  if (inspect) return { action: 'inspect', discordId: inspect[1] || inspect[2] };
  return { action: 'help' };
}

async function rebaseAttendanceWarnings(client, cohort, startDate) {
  if (!validDateKey(startDate)) throw new Error('Use a real YYYY-MM-DD warning start date');
  const end = shiftDateKey(dateKeyInZone(cohort.timezone), -1);
  if (startDate > end) throw new Error(`Warning start cannot be later than ${end}`);
  const [warningState, absences] = await Promise.all([
    getAttendanceWarningState(cohort),
    appsScriptGet(cohort, {
      action: 'absences', start: startDate, end,
      guildId: cohort.guildId, includeExcluded: 1,
    }, { label: 'Attendance-warning rebase evidence' }),
  ]);
  const absenceById = Object.fromEntries((absences.students || [])
    .filter(student => student.discordId)
    .map(student => [String(student.discordId), student.absentDates || []]));
  const rebased = rebaseWarningState(
    warningState, startDate, absenceById, absences.recordedSessions || []);
  await setSetting(cohort, 'attendancewarningstart', startDate);
  await saveAttendanceWarningState(cohort, rebased.state);

  const reactivated = [];
  const failures = [];
  if (rebased.reactivateIds.length) {
    const activation = await setStudentsActive(client, cohort, rebased.reactivateIds);
    reactivated.push(...activation.activated.map(result => ({
      discordId: String(result.student?.discordId || result.discordId || ''),
      name: result.student?.name || result.name || result.discordId,
    })));
    failures.push(...activation.failures);
    // activateStudent clears warning records. Restore the one fully rebased
    // state after the verified batch so valid counters remain durable.
    await saveAttendanceWarningState(cohort, rebased.state);
  }
  return {
    ...rebased,
    startDate,
    end,
    recordedSessions: absences.recordedSessions || [],
    reactivated,
    failures,
  };
}

function tsvCell(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[\t\r\n]+/g, ' ').trim();
}

function warningReportRows(roster, inactiveIds, warningState, absenceStudents) {
  const inactive = inactiveIds instanceof Set ? inactiveIds : new Set(inactiveIds || []);
  const absenceById = new Map((absenceStudents || []).map(student => [String(student.discordId || ''), student]));
  return (roster || []).map(student => {
    const id = String(student.discordId || '');
    const warning = warningState?.[id] || {};
    const absence = absenceById.get(id) || {};
    return {
      ...student,
      inactive: inactive.has(id),
      warningCount: Math.max(0, Number(warning.count || 0)),
      absentDays: Math.max(0, Number(absence.absentDays || 0)),
      longestStreak: Math.max(0, Number(absence.longestStreak || 0)),
      absentDates: Array.isArray(absence.absentDates) ? absence.absentDates : [],
    };
  }).filter(student => student.inactive || student.warningCount > 0 || student.absentDays > 0)
    .sort((a, b) => Number(b.inactive) - Number(a.inactive) ||
      b.warningCount - a.warningCount || b.absentDays - a.absentDays ||
      String(a.name || '').localeCompare(String(b.name || '')));
}

async function runWarningReport(client, cohort) {
  await syncMembers(client, cohort);
  const guild = await client.guilds.fetch(cohort.guildId);
  const memberIds = new Set(guild.members.cache.keys());
  const roster = (await getRoster(cohort, true)).filter(student =>
    student.discordId && memberIds.has(String(student.discordId)) &&
    student.status !== 'hired' && student.status !== 'left');
  const today = dateKeyInZone(cohort.timezone);
  const start = weekStart(today);
  const [warningState, absences] = await Promise.all([
    getAttendanceWarningState(cohort),
    appsScriptGet(cohort, {
      action: 'absences', start, end: today, guildId: cohort.guildId, includeExcluded: 1,
    }, { label: 'Weekly warning and absence report' }),
  ]);
  const inactiveIds = new Set(roster.filter(student => isExcluded(cohort, student))
    .map(student => String(student.discordId || '')).filter(Boolean));
  const rows = warningReportRows(
    roster, inactiveIds, warningState, absences.students || []);
  const inactiveCount = rows.filter(row => row.inactive).length;
  const warnedCount = rows.filter(row => row.warningCount > 0).length;
  const absentCount = rows.filter(row => row.absentDays > 0).length;
  const channel = await client.channels.fetch(cohort.channels.supervisor);
  await channel.send({
    content: [
      `## Weekly inactive, warning and attendance report — ${cohort.name}`,
      `Period: **${start} through ${today}** · recorded sessions: **${(absences.recordedSessions || []).length}**`,
      `Inactive: **${inactiveCount}** · warning count above zero: **${warnedCount}** · absent at least once: **${absentCount}**`,
      rows.length ? 'Private contact table follows.' : 'No current student matches this report.',
    ].join('\n'),
    allowedMentions: { parse: [] },
  });
  if (rows.length) {
    const lines = [
      'STATUS\tWARNING\tABSENT\tSTREAK\tNAME\tEMAIL\tPHONE\tABSENT DATES\tDISCORD ID',
      ...rows.map(row => [
        row.inactive ? 'INACTIVE' : 'ACTIVE',
        `${row.warningCount}/3`, row.absentDays, row.longestStreak,
        row.name || row.displayName || 'Unknown', row.email || 'NO EMAIL',
        row.phone || 'NO PHONE', row.absentDates.join(',') || '—', row.discordId,
      ].map(tsvCell).join('\t')),
    ];
    for (const chunk of chunkLines(lines, 1700)) {
      await channel.send({ content: `\`\`\`tsv\n${chunk}\n\`\`\``, allowedMentions: { parse: [] } });
    }
  }
  return { rows, inactiveCount, warnedCount, absentCount, start, today };
}

function warningReportRunKey(cohort) {
  return `warning_report_last_v1_${cohort.guildId}`;
}

async function runScheduledWarningReport(client, cohort) {
  const today = dateKeyInZone(cohort.timezone);
  const key = warningReportRunKey(cohort);
  const prior = await appsScriptGet(cohort, { action: 'getstate', k: key }, {
    label: 'Warning-report completion state read',
  });
  if (String(prior.value || '') === today) {
    console.log(`[warning-report] ${cohort.name}: ${today} already posted; duplicate schedule skipped`);
    return { skipped: true, today };
  }
  const result = await runWarningReport(client, cohort);
  await appsScriptPost(cohort, { action: 'setState', k: key, v: today }, {
    idempotent: true, label: 'Warning-report completion state write',
  });
  console.log(`[warning-report] ${cohort.name}: ${today} posted (${result.rows.length} attention rows)`);
  return { ...result, skipped: false };
}

module.exports = function registerWarningControls(client) {
  for (const cohort of cohorts) {
    scheduleAtSetting(cohort, 'warningreport', 'warningreporttime', async () => {
      if ((await isOn(cohort, 'warningreport')) &&
          (await isScheduledToday(cohort, 'warningreport')) &&
          !(await isWarmup(cohort))) {
        await runScheduledWarningReport(client, cohort);
      }
    }, { graceMinutes: 30 });
  }

  client.on('messageCreate', async message => {
    if (message.author.bot || !message.guildId) return;
    const command = parseWarningCommand(message.content);
    if (!command) return;
    const cohort = cohorts.find(item => item.guildId === message.guildId);
    if (!cohort || !cohort.supervisorIds.includes(message.author.id)) return;
    if (message.channelId !== cohort.channels.supervisor) {
      return message.reply(`Run warning controls in <#${cohort.channels.supervisor}>.`);
    }
    try {
      if (command.action === 'report') {
        await message.reply('Building the private weekly warning and attendance report...');
        return runWarningReport(client, cohort);
      }
      if (command.action === 'start-status') {
        const start = await getSetting(cohort, 'attendancewarningstart');
        return message.reply(start
          ? `Attendance warnings use the same cohort baseline for everyone: **${start}**.`
          : 'No fixed attendance-warning baseline is set. Use `!warnings start YYYY-MM-DD` before the first warning run.');
      }
      if (command.action === 'start') {
        await message.reply(`Rebasing every attendance warning from **${command.date}** and repairing only students whose warning-based inactivity becomes invalid...`);
        const result = await rebaseAttendanceWarnings(client, cohort, command.date);
        const currentWarnings = Object.entries(result.state)
          .filter(([, record]) => Number(record.count || 0) > 0)
          .map(([discordId, record]) => ({ discordId, record }));
        if (result.changedIds.length || result.reactivated.length) {
          const warningChannel = await client.channels.fetch(cohort.channels.warning);
          const reactivatedIds = new Set(result.reactivated.map(item => item.discordId));
          const correctionLines = [
              `## ✅ Attendance warning correction — shared baseline ${result.startDate}`,
              `Attendance dates before **${result.startDate}** are cancelled for warning purposes. Earlier unfair **3/3 inactive** results have been corrected. Every student now uses the same start date, and one warning run can add only one warning.`,
              result.reactivated.length
                ? `**Reactivated now:** ${result.reactivated.map(item => `<@${item.discordId}>`).join(' ')}\nTheir attendance/activity tracking and points resume immediately.`
                : '**Reactivated now:** nobody required status repair.',
              currentWarnings.length ? '**Current valid warning status:**' : '**Current valid warning status:** no warning remains.',
              ...currentWarnings.map(({ discordId, record }) =>
                `• <@${discordId}> — **${record.count}/3** · counted dates: **${(record.usedDates || []).join(', ') || 'none'}**${reactivatedIds.has(discordId) ? ' · corrected from unfair inactivity' : ''}`),
              'If your status is 1/3 or 2/3, you remain active. At 3/3 you become inactive and receive no attendance/activity points until mentor reactivation. Contact your mentor for any medical emergency, final examination, death/bereavement, or other serious unavoidable cause.',
            ];
          const mentionIds = [...new Set([
              ...result.reactivated.map(item => item.discordId),
              ...currentWarnings.map(item => item.discordId),
            ])];
          for (const chunk of chunkLines(correctionLines, 1900)) {
            await warningChannel.send({ content: chunk, allowedMentions: { users: mentionIds } });
          }
        }
        const lines = [
          `✅ Shared attendance-warning baseline: **${result.startDate}**`,
          `Recorded sessions considered: **${result.recordedSessions.length}** · warning records corrected: **${result.changedIds.length}**`,
          `Unfair warning-based inactive states repaired: **${result.reactivated.length}**`,
        ];
        if (result.reactivated.length) lines.push(`Reactivated: ${result.reactivated.map(item => item.name).join(', ')}`);
        if (result.failures.length) lines.push(`⚠️ Could not reactivate: ${result.failures.map(item => `${item.discordId} (${item.error})`).join('; ')}`);
        return message.reply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
      }
      if (command.action === 'help') {
        return message.reply('Use `!warnings @student`, `!warnings undo @student`, `!warnings reset @student`, `!warnings start YYYY-MM-DD`, or `!warningreport`.');
      }
      const member = await message.guild.members.fetch(command.discordId).catch(() => null);
      if (!member || member.user.bot || cohort.supervisorIds.includes(member.id)) {
        throw new Error('Choose a current non-bot student in this cohort');
      }
      if (command.action === 'reset') {
        const reset = await resetAttendanceWarnings(cohort, member.id);
        return message.reply(`✅ Attendance warnings for **${member.displayName}** are now **0/3**${reset.hadRecord ? ` (reset from ${reset.previousCount}/3)` : ''}. Their active/inactive status was not changed.`);
      }
      if (command.action === 'undo') {
        const state = await getAttendanceWarningState(cohort);
        const outcome = undoLatestWarningIncident(state, member.id);
        if (!outcome.changed) return message.reply(`No attendance warning exists for **${member.displayName}** to undo.`);
        const roster = await getRoster(cohort, true);
        const student = roster.find(entry => String(entry.discordId || '') === member.id);
        if (outcome.wasInactive && student && isExcluded(cohort, student)) {
          const activation = await setStudentsActive(client, cohort, [member.id]);
          if (activation.failures.length) throw new Error(activation.failures[0].error);
        }
        // Activation clears the whole warning record; restore the corrected
        // counter so earlier valid warnings remain intact.
        await saveAttendanceWarningState(cohort, outcome.state);
        let correctionPosted = false;
        try {
          const warningChannel = await client.channels.fetch(cohort.channels.warning);
          await warningChannel.send({
            content: [
              '## ✅ Attendance warning corrected by mentor',
              `<@${member.id}> — the latest warning${outcome.removedDates.length ? ` for **${outcome.removedDates.join(', ')}**` : ''} has been cancelled.`,
              `Current warning count: **${outcome.count}/3**.${outcome.wasInactive ? ' Warning-based inactivity was removed and tracking resumes immediately.' : ' Earlier valid warnings, if any, remain unchanged.'}`,
            ].join('\n'),
            allowedMentions: { users: [member.id] },
          });
          correctionPosted = true;
        } catch (error) {
          console.error(`[warnings] ${cohort.name}: saved undo but could not post correction:`, error.message);
        }
        return message.reply({
          content: `✅ Undid only the latest attendance warning for **${member.displayName}**: **${outcome.previousCount}/3 → ${outcome.count}/3**${outcome.removedDates.length ? ` · removed pair: **${outcome.removedDates.join(', ')}**` : ''}.${outcome.wasInactive ? ' Warning-based inactivity was also cleared when applicable.' : ''}${correctionPosted ? ' A correction was posted in the warning channel.' : ' ⚠️ The state was corrected, but the public correction could not be posted.'}`,
          allowedMentions: { parse: [] },
        });
      }
      const state = await getAttendanceWarningState(cohort);
      const record = state[member.id] || {};
      const roster = await getRoster(cohort, true);
      const student = roster.find(entry => String(entry.discordId || '') === member.id);
      const inactive = !student || isExcluded(cohort, student);
      const statusReason = !student
        ? 'not linked in Bot_Map'
        : student.status === 'hired' || student.status === 'left'
          ? `status: ${student.status}`
          : (student.inactiveReasons || []).join('; ') || (inactive ? 'manually inactive' : 'tracked');
      return message.reply({
        content: `**${member.displayName}** · status: **${inactive ? 'inactive' : 'active'}** (${statusReason}) · attendance warnings: **${Number(record.count || 0)}/3** · latest counted pair: **${record.lastIncident || '—'}**`,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      return message.reply(`❌ Warning control failed: ${String(error.message).slice(0, 300)}`);
    }
  });
};

module.exports.parseWarningCommand = parseWarningCommand;
module.exports.runWarningReport = runWarningReport;
module.exports.runScheduledWarningReport = runScheduledWarningReport;
module.exports.rebaseAttendanceWarnings = rebaseAttendanceWarnings;
module.exports.tsvCell = tsvCell;
module.exports.warningReportRunKey = warningReportRunKey;
module.exports.warningReportRows = warningReportRows;
