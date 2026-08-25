// ============================================================
//  reporter.js - daily activity report in #bot-admin
//  Modules call report(cohortName, text) / reportError(...).
//  Supervisors can request the in-memory summary with !dailyreport.
// ============================================================
const { cohorts } = require('./config');

const logs = {}; // guildId -> [{time, text, error}]
const logKey = (cohortName) =>
  cohorts.find(cohort => cohort.name === cohortName)?.guildId ||
  String(cohortName);

function report(cohortName, text, error = false) {
  const key = logKey(cohortName);
  (logs[key] = logs[key] || []).push({
    time: new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit' }),
    text: String(text).slice(0, 300), error,
  });
  if (logs[key].length > 300) logs[key].shift();
  console.log(`[report] ${cohortName}: ${text}`);
}
const reportError = (c, t) => report(c, t, true);

function registerReporter(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot || msg.content.trim().toLowerCase() !== '!dailyreport') return;
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;
    await postDaily(client, cohort);
  });
}

async function postDaily(client, cohort) {
  try {
    const entries = logs[cohort.guildId] || [];
    const ok = entries.filter(e => !e.error);
    const bad = entries.filter(e => e.error);
    const fmt = arr => arr.length ? arr.slice(-20).map(e => `\`${e.time}\` ${e.text}`).join('\n') : '— nothing recorded';

    // pull live daily stats from the sheet so the report always has data
    let stats = '';
    try {
      const api = (p) => fetch(`${cohort.appsScriptUrl}?key=${encodeURIComponent(cohort.apiKey)}&${p}`, { redirect: 'follow' }).then(r => r.json());
      const { getNumber } = require('./settings');
      const jobTarget = await getNumber(cohort, 'jobstarget');
      const [att, rtbr] = await Promise.all([
        api('action=attendance'),
        api(`action=rtbr&days=1&jobTarget=${encodeURIComponent(jobTarget)}`),
      ]);
      const active = (rtbr.students || []).length;
      stats =
        `• Attendance: ${att.presentCount || 0} present, ${att.absentCount || 0} absent\n` +
        `• Interviews today: ${(att.interviewsToday || []).length}\n` +
        `• Students scoring today: ${active}`;
    } catch (e) {
      const stale = /Unexpected token|DOCTYPE|not valid JSON/.test(e.message);
      stats = stale
        ? '⚠️ _Apps Script needs redeploying (Manage deployments → New version). Switches below are live._'
        : '_(live stats unavailable)_';
    }

    const { isOn } = require('./automations');
    const switches = [];
    for (const k of ['questions','jobs','outreach','workshop','rtbr','dmnudges']) {
      switches.push(`${(await isOn(cohort, k)) ? '🟢' : '🔴'}${k}`);
    }

    const channel = await client.channels.fetch(cohort.channels.supervisor);
    await channel.send({
      embeds: [{
        title: `🗞 JP ADMIN Daily Report — ${cohort.name}`,
        color: bad.length ? 0xe67e22 : 0x2ecc71,
        fields: [
          { name: '📊 Today at a glance', value: stats },
          { name: `✅ Actions logged (${ok.length})`, value: fmt(ok).slice(0, 1024) },
          { name: `❌ Failures (${bad.length})`, value: fmt(bad).slice(0, 1024) },
          { name: '🎛 Automation switches', value: switches.join('  ') },
        ],
        footer: { text: 'Full detail in Render logs. !dailyreport shows this anytime.' },
        timestamp: new Date().toISOString(),
      }],
    });
    logs[cohort.guildId] = [];
  } catch (err) { console.error('[report] daily post failed:', err.message); }
}

module.exports = { registerReporter, report, reportError };
