// ============================================================
// formcontrol.js - !openform / !closeform [silent] / !formstatus
// Supervisor-only. Normal close posts attendance after 30 seconds;
// silent close changes only the Form state.
// ============================================================

const { findCohort } = require('./config');
const { postAttendance, markPosted } = require('./attendance');
const { scheduleAttendanceWarningAfterReport } = require('./activity-automation');
const { appsScriptGet } = require('./apps-script-api');

async function callApi(cohort, action) {
  return appsScriptGet(cohort, { action }, { label: `Attendance form ${action}` });
}

function parseFormCommand(content) {
  const parts = String(content || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length === 1 && ['!openform', '!formstatus'].includes(parts[0])) {
    return { command: parts[0].slice(1), silent: false };
  }
  if (parts[0] !== '!closeform' || parts.length > 2) return null;
  if (parts.length === 1) return { command: 'closeform', silent: false };
  if (['silent', '--silent'].includes(parts[1])) {
    return { command: 'closeform', silent: true };
  }
  return null;
}

module.exports = function registerFormControl(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const parsed = parseFormCommand(msg.content);
    if (!parsed) return;

    // The command always resolves the cohort from the server where it was
    // issued; one cohort can never open or close another cohort's Form.
    const cohort = findCohort(msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;

    try {
      if (parsed.command === 'openform') {
        const status = await callApi(cohort, 'openform');
        await msg.reply(status.accepting
          ? '🟢 Attendance form is now **OPEN**.'
          : '⚠️ Tried to open, but the form reports closed — check Apps Script.');
        return;
      }

      if (parsed.command === 'closeform') {
        const status = await callApi(cohort, 'closeform');
        if (status.accepting) {
          await msg.reply('⚠️ Tried to close, but the form still reports open — check Apps Script.');
          return;
        }
        if (parsed.silent) {
          await msg.reply({
            content: '🔴 Form **CLOSED silently**. No attendance report was posted.',
            allowedMentions: { parse: [] },
          });
          return;
        }
        await msg.reply('🔴 Form **CLOSED**. Posting or updating today\'s attendance report in 30 seconds...');
        setTimeout(async () => {
          try {
            const report = await postAttendance(client, cohort);
            if (!report?.posted) return;
            markPosted(cohort);
            const warning = await scheduleAttendanceWarningAfterReport(
              client, cohort, report.date, 10 * 60 * 1000);
            const confirmation = {
              content: warning.duplicate
                ? `ℹ️ Attendance report ${report.updated ? 'updated' : 'posted'} for **${report.date}**; its warning/mail follow-up was already processed or queued.`
                : `⏱️ Attendance report ${report.updated ? 'updated' : 'posted'} for **${report.date}**. The consecutive-absence warning and enabled private BCC mail follow-up will run in **10 minutes**. The durable queue recovers it after a Render restart. Present and approved-leave marks break the streak.`,
              allowedMentions: { parse: [] },
            };
            await msg.channel.send(confirmation).catch(async error => {
              console.error(`[formcontrol] ${cohort.name} queue confirmation send failed:`, error.message);
              await msg.reply(confirmation).catch(replyError => {
                console.error(`[formcontrol] ${cohort.name} queue confirmation retry failed:`, replyError.message);
              });
            });
          } catch (error) {
            console.error(`[formcontrol] delayed attendance processing failed for ${cohort.name}:`, error.message);
            await msg.channel.send({
              content: `❌ Attendance posted, but its warning/mail follow-up could not be queued: ${String(error.message).slice(0, 250)}`,
              allowedMentions: { parse: [] },
            }).catch(() => {});
          }
        }, 30 * 1000);
        return;
      }

      const status = await callApi(cohort, 'formstatus');
      await msg.reply(`📋 Form is **${status.accepting ? 'OPEN 🟢' : 'CLOSED 🔴'}**`);
    } catch (err) {
      console.error('[formcontrol] failed:', err.message);
      await msg.reply({
        content: `❌ ${err.message.slice(0, 300)}`,
        allowedMentions: { parse: [] },
      });
    }
  });
};

module.exports.parseFormCommand = parseFormCommand;
