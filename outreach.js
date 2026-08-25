// ============================================================
//  outreach.js - outreach channel monitor
//   • logs every student message in #outreach to the Sheet
//   • !backfilloutreach  - one-time: read channel history into Sheet
//   • !outreachcheck     - run the silent-students ping now
//   • daily cron         - same check automatically
//  In index.js:  require('./outreach')(client);
// ============================================================

const { cohorts } = require('./config');
const { getRoster, isExcluded, mention, rosterForBackfill, syncMembers } = require('./roster');
const { isOn } = require('./automations');
const { getNumber, resolveChannel } = require('./settings');
const { isScheduledToday } = require('./scheduler');
const { runQuotaTask } = require('./quota-queue');
const { scheduleAtSetting } = require('./runtime-schedule');
const { appsScriptGet, appsScriptPost } = require('./apps-script-api');

function dhakaDate(ts, timezone) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: timezone }); // yyyy-mm-dd
}

async function post(cohort, body, tries = 5) {
  return appsScriptPost(cohort, body, {
    attempts: tries,
    idempotent: true,
    label: 'Outreach write',
    timeoutMs: 180000,
  });
}

async function get(cohort, params) {
  return appsScriptGet(cohort, params, { label: 'Outreach read' });
}

async function notifyAdmin(client, cohort, text) {
  const admin = await client.channels.fetch(cohort.channels.supervisor).catch(() => null);
  if (!admin?.isTextBased()) return;
  await admin.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
}

module.exports = function registerOutreach(client) {
  // ---------- daily check scheduling ----------
  for (const cohort of cohorts) {
    if (!cohort.channels.outreach) continue;
    scheduleAtSetting(cohort, 'outreach', 'outreachtime',
      () => runQuotaTask(`outreach:${cohort.guildId}`, () => runOutreachCheck(client, cohort)));
    console.log(`[outreach] ${cohort.name}: runtime-configurable daily check active`);
  }

  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.channels.outreach) return;

    const cmd = msg.content.trim().toLowerCase();
    const outreachChannelId = await resolveChannel(
      cohort, 'channel_outreach', cohort.channels.outreach);

    // ---------- live logging ----------
    if (msg.channelId === outreachChannelId && !cmd.startsWith('!')) {
      try {
        let roster = await getRoster(cohort);
        let s = roster.find(r => r.discordId === msg.author.id);
        if (!s && !cohort.supervisorIds.includes(msg.author.id)) {
          await syncMembers(client, cohort);
          roster = await getRoster(cohort, true);
          s = roster.find(r => r.discordId === msg.author.id);
        }
        if (!s || isExcluded(cohort, s)) return; // non-students / supervisors / hired
        await post(cohort, {
          action: 'logOutreach',
          email: s.email,
          date: dhakaDate(msg.createdTimestamp, cohort.timezone),
          guildId: cohort.guildId,
          messageId: msg.id,
          messageUrl: msg.url || '',
        });
        await msg.react('✅').catch(() => {});
      } catch (err) {
        console.error('[outreach] log failed:', err.message);
        await notifyAdmin(
          client,
          cohort,
          `❌ **Outreach event was not saved:** ${msg.url || `message ${msg.id}`} · member ID \`${msg.author.id}\` · ${String(err.message).slice(0, 250)}`,
        );
      }
      return;
    }

    // ---------- supervisor commands ----------
    if (!['!backfilloutreach', '!outreachcheck'].includes(cmd)) return;
    if (!cohort.supervisorIds.includes(msg.author.id)) return;

    if (cmd === '!backfilloutreach') {
      await msg.reply('⏳ Reading the full outreach channel history... this can take a minute.');
      try {
        const stats = await backfillHistory(client, cohort);
        await msg.reply(
          `✅ Backfill done: **${stats.messages}** messages scanned, ` +
          `**${stats.students}** students written to the Sheet, ` +
          `**${stats.dailyEvents}** dated events reconciled, ` +
          `${stats.skipped} messages from non-students skipped.` +
          (stats.rosterRefreshed ? '' : '\n⚠️ The live roster refresh was temporarily unavailable, so the last durable roster was used. Rerun later for any brand-new unmatched member.')
        );
      } catch (err) {
        console.error('[outreach] backfill failed:', err);
        await msg.reply('❌ Backfill failed: ' + err.message);
      }
    }

    if (cmd === '!outreachcheck') {
      await msg.reply('🔎 Running outreach check...');
      await runOutreachCheck(client, cohort, true);
    }
  });
};

// ============================================================
//  Backfill: paginate the whole channel history (100 per fetch)
// ============================================================
async function backfillHistory(client, cohort, options = {}) {
  const maxMessages = Math.min(10000, Math.max(1, Number(options.maxMessages) || 10000));
  const writeHistoricalSummary = options.writeHistoricalSummary !== false;
  const channelId = await resolveChannel(cohort, 'channel_outreach', cohort.channels.outreach);
  const channel = await client.channels.fetch(channelId);
  const rosterState = options.rosterState || await rosterForBackfill(client, cohort);
  const roster = rosterState.roster;
  const byId = new Map(roster.map(s => [s.discordId, s]));

  const stats = {}; // email -> { first, last, count }
  const events = [];
  let before, messages = 0, skipped = 0, loops = 0;

  while (loops < 100 && messages < maxMessages) { // safety cap: 10,000 messages
    const limit = Math.min(100, maxMessages - messages);
    const batch = await channel.messages.fetch({ limit, before });
    if (batch.size === 0) break;
    for (const m of batch.values()) {
      if (m.author.bot) continue;
      const s = byId.get(m.author.id);
      if (!s || isExcluded(cohort, s)) { skipped++; continue; }
      const d = dhakaDate(m.createdTimestamp, cohort.timezone);
      const e = stats[s.email] || (stats[s.email] = { first: d, last: d, count: 0 });
      e.count++;
      if (d < e.first) e.first = d;
      if (d > e.last) e.last = d;
      events.push({
        email: s.email,
        date: d,
        messageId: m.id,
        messageUrl: m.url || '',
      });
    }
    messages += batch.size;
    before = batch.last().id;
    loops++;
    await sleep(400); // gentle on Discord's API
  }

  const entries = Object.entries(stats).map(([email, e]) =>
    ({ email, first: e.first, last: e.last, count: e.count }));

  // send in chunks of 30 to keep Apps Script happy
  if (writeHistoricalSummary) {
    for (let i = 0; i < entries.length; i += 30) {
      await post(cohort, { action: 'backfillOutreach', entries: entries.slice(i, i + 30) });
    }
  }
  let dailyEvents = 0;
  for (let i = 0; i < events.length; i += 100) {
    const data = await post(cohort, {
      action: 'backfillOutreachDaily',
      entries: events.slice(i, i + 100),
      guildId: cohort.guildId,
    });
    dailyEvents += Number(data.reconciled ?? data.saved) || 0;
  }
  return { messages, students: entries.length, dailyEvents, skipped, rosterRefreshed: rosterState.refreshed };
}

// ============================================================
//  Daily check: ping never-posted + gone-quiet students
// ============================================================
async function runOutreachCheck(client, cohort, manual = false) {
  try {
    if (!manual && !(await isOn(cohort, 'outreach'))) { console.log(`[outreach] ${cohort.name}: automation OFF`); return; }
    if (!manual && !(await isScheduledToday(cohort, 'outreach'))) { console.log(`[outreach] ${cohort.name}: not scheduled today`); return; }
    await syncMembers(client, cohort);
    const staleDays = await getNumber(cohort, 'outreachstale');
    const dailyTarget = await getNumber(cohort, 'outreachdaily');
    const [status, performance, roster] = await Promise.all([
      get(cohort, { action: 'outreachstatus', staleDays }),
      get(cohort, { action: 'performance', days: 1 }),
      getRoster(cohort),
    ]);

    const channel = await client.channels.fetch(await resolveChannel(cohort, 'channel_outreach', cohort.channels.outreach));
    const active = roster.filter(student => !isExcluded(cohort, student));
    const emailKey = value => String(value || '').trim().toLowerCase();
    const counts = new Map((performance.students || []).map(student => [emailKey(student.email), Number(student.outreach) || 0]));
    const neverEmails = new Set((status.never || []).map(student => emailKey(student.email)));
    const staleByEmail = new Map((status.stale || []).map(student => [emailKey(student.email), student]));
    const belowTarget = active.map(student => ({
      ...student,
      todayCount: counts.get(emailKey(student.email)) || 0,
      never: neverEmails.has(emailKey(student.email)),
      stale: staleByEmail.get(emailKey(student.email)),
    })).filter(student => student.todayCount < dailyTarget)
      .sort((a, b) => a.todayCount - b.todayCount || String(a.name).localeCompare(String(b.name)));

    if (!belowTarget.length) {
      await channel.send(`🌟 **Outreach check:** every active student reached today's **${dailyTarget} outreach update** target. Excellent consistency!`);
      return;
    }

    const lines = [`@everyone\n📣 **Outreach follow-up check** — target: **${dailyTarget} outreach updates/day** (company names, prospect profiles, response updates):`];
    for (const student of belowTarget) {
      let context = '';
      if (student.never) context = ' · no outreach has been recorded yet';
      else if (student.stale) context = ` · last update ${student.stale.daysSince} day(s) ago`;
      lines.push(`❗ ${mention(student)} — today **${student.todayCount}/${dailyTarget}**${context}. Please complete the remaining **${dailyTarget - student.todayCount}** update(s).`);
    }

    for (const chunk of chunkLines(lines, 1900)) {
      await channel.send({ content: chunk, allowedMentions: { parse: ['users', 'everyone'] } });
      await sleep(1200);
    }
    console.log(`[outreach] ${cohort.name}: check posted (${belowTarget.length} below target ${dailyTarget})`);
  } catch (err) {
    console.error(`[outreach] ${cohort.name} check failed:`, err.message);
    await notifyAdmin(
      client,
      cohort,
      `❌ **Outreach report stopped for ${cohort.name}:** ${String(err.message).slice(0, 300)}\nThe current Discord roster was not safely confirmed, so no partial report was posted.`,
    );
  }
}

function chunkLines(lines, maxLen) {
  const chunks = [];
  let cur = '';
  for (const line of lines) {
    if (cur.length + line.length + 1 > maxLen) { chunks.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports.backfillHistory = backfillHistory;
module.exports.runOutreachCheck = runOutreachCheck;
