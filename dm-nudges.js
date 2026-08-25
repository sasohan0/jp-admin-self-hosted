// ============================================================
//  dm-nudges.js - personal DM to lagging students
//  IMPORTANT: Discord bots can NEVER send messages from YOUR
//  account. These DMs come from JP ADMIN, written in first
//  person and signed "— Solih (via JP ADMIN)".
//  Runs at 11:45 PM if the 'dmnudges' automation is ON.
//  Triggers: outreach silent 2+ days, missed all workshop
//  sessions today, job count below target (yesterday's data).
// ============================================================
const { cohorts } = require('./config');
const { getRoster, isExcluded } = require('./roster');
const { isOn } = require('./automations');
const { getNumber } = require('./settings');
const { getTodayWorkshopMisses } = require('./workshop');
const { report, reportError } = require('./reporter');
const { isScheduledToday } = require('./scheduler');
const { scheduleAtSetting } = require('./runtime-schedule');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(cohort, params) {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const res = await fetch(`${cohort.appsScriptUrl}?key=${encodeURIComponent(cohort.apiKey)}&${qs}`, { redirect: 'follow' });
  return res.json();
}

module.exports = function registerDmNudges(client) {
  for (const cohort of cohorts) {
    scheduleAtSetting(cohort, 'dmnudges', 'dmnudgestime', async () => {
      if (await isOn(cohort, 'dmnudges') && await isScheduledToday(cohort, 'dmnudges')) {
        await runNudges(client, cohort);
      }
    });
  }
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot || msg.content.trim().toLowerCase() !== '!dmnudges') return;
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;
    await msg.reply('📨 Sending nudge DMs to lagging students...');
    await runNudges(client, cohort);
  });
};

async function runNudges(client, cohort) {
  try {
    const roster = await getRoster(cohort, true);
    const target = await getNumber(cohort, 'jobstarget');

    // gather per-student issues
    const issues = new Map(); // email -> [strings]
    const add = (email, text) => {
      if (!issues.has(email)) issues.set(email, []);
      issues.get(email).push(text);
    };

    const outreach = await api(cohort, { action: 'outreachstatus', staleDays: await getNumber(cohort, 'outreachstale') });
    for (const s of [...(outreach.stale || []), ...(outreach.never || [])]) {
      add(s.email, 'no outreach update recently — follow up with companies that have not replied, and send new outreach');
    }

    const rec = getTodayWorkshopMisses(cohort);
    const attended = rec ? rec.emails : new Set();
    for (const s of roster) {
      if (!isExcluded(cohort, s) && !attended.has(s.email)) {
        add(s.email, 'missed all communication workshop sessions today — join at least one slot tomorrow');
      }
    }

    // job counts: use the most recent Jobs_Daily data via rtbr window of 1 day is not exposed;
    // simplest reliable signal: yesterday's saved counts
    const scores = await api(cohort, { action: 'rtbr', days: 1, jobTarget: target });
    for (const s of (scores.students || [])) {
      if (s.jobPts < 10) add(s.email, `below the ${target}/day application target — push your applications up tomorrow`);
    }

    const byEmail = new Map(roster.map(s => [s.email, s]));
    let sent = 0; const failed = [];
    for (const [email, list] of issues) {
      const s = byEmail.get(email);
      if (!s || isExcluded(cohort, s) || !s.discordId) continue;
      try {
        const user = await client.users.fetch(s.discordId);
        await user.send(
          `Assalamu alaikum ${s.name.split(' ')[0]}! 👋\n\n` +
          `I noticed today:\n${list.map(i => `• ${i}`).join('\n')}\n\n` +
          `You have real potential — consistency is what turns it into a job offer. Let's fix these tomorrow. If anything is blocking you, reply in the server and we'll solve it together. 💪\n\n` +
          `— Solih (via JP ADMIN)`
        );
        sent++;
        await sleep(2000); // gentle DM pacing
      } catch {
        failed.push(s.name); // DMs closed
      }
    }

    const admin = await client.channels.fetch(cohort.channels.supervisor);
    await admin.send(
      `📨 **DM nudges:** sent ${sent}` +
      (failed.length ? `\n⚠️ DMs closed (reach manually): ${failed.join(', ')}`.slice(0, 1800) : '')
    );
    report(cohort.name, `DM nudges sent: ${sent}, closed DMs: ${failed.length}`);
  } catch (err) { reportError(cohort.name, 'DM nudges failed: ' + err.message); }
}
