// ============================================================
//  jobs.js - daily 15-applications accountability
//   • students post their tracker Sheet link in #job-tracking-sheet
//     -> bot saves it (latest link wins)
//   • !backfilljobsheets [N days] - scan recent history for links (default 3)
//   • 10:30 PM daily (+ !jobscheck) - read every non-hired
//     student's public sheet, count today's applications,
//     mention everyone below the daily target with today's
//     count and the last 3 days
//  In index.js:  require('./jobs')(client);
// ============================================================

const { runQuotaTask } = require('./quota-queue');
const { MessageFlags } = require('discord.js');
const { cohorts } = require('./config');
const { getRoster, isExcluded, mention, requireCompleteIdentityCoverage, rosterForBackfill, setRosterSnapshot, syncMembers } = require('./roster');
const { isWarmup } = require('./state');
const { isScheduledToday } = require('./scheduler');
const { isOn } = require('./automations');
const { getNumber, getSetting, resolveChannel } = require('./settings');
const { scheduleAtSetting } = require('./runtime-schedule');
const { parseDateValue, parseSheetLink, readTracker } = require('./job-tracker');
const { chunkLines } = require('./message-chunks');
const { contactMarkdown } = require('./contact');
const { appsScriptGet, appsScriptPost } = require('./apps-script-api');
const {
  historyWindow,
  historyWindowLabel,
  messageWindowPosition,
  parseHistoryCommand,
} = require('./history-window');

async function post(cohort, body, tries = 5) {
  return appsScriptPost(cohort, body, {
    attempts: tries,
    idempotent: true,
    label: 'Job tracker write',
    timeoutMs: 180000,
  });
}
async function api(cohort, params) {
  return appsScriptGet(cohort, params, { label: 'Job tracker read' });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function backfillJobSheetLinks(client, cohort, options = {}) {
  const maxPages = Math.max(1, Math.min(100, Number(options.maxPages || 100)));
  const window = historyWindow(options.days, cohort.timezone, options.nowMs);
  const write = options.post || post;
  const pace = options.sleep || sleep;
  const parseLink = options.parseLink || parseSheetLink;
  const rosterState = options.roster
    ? { roster: options.roster, refreshed: true, refreshWarning: '' }
    : await rosterForBackfill(client, cohort);
  const byId = new Map(rosterState.roster.map(student => [student.discordId, student]));
  const channelId = options.channel ? '' : await resolveChannel(cohort, 'channel_jobs', cohort.channels.jobTracking);
  const channel = options.channel || await client.channels.fetch(channelId);
  const latest = new Map();
  let before;
  let loops = 0;
  let messages = 0;
  let reachedBeforeWindow = false;

  while (loops < maxPages) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;
    for (const message of batch.values()) {
      const position = messageWindowPosition(message, window);
      if (position < 0) { reachedBeforeWindow = true; continue; }
      if (position > 0) continue;
      messages++;
      if (message.author.bot) continue;
      const tracker = parseLink(message.content);
      const student = byId.get(message.author.id);
      if (!tracker || !student) continue;
      if (!latest.has(student.email)) latest.set(student.email, tracker);
    }
    before = batch.last().id;
    loops++;
    if (reachedBeforeWindow || batch.size < 100) break;
    await pace(400);
  }

  const items = [...latest].map(([email, tracker]) => ({ email, ...tracker }));
  const result = items.length
    ? await write(cohort, { action: 'saveJobSheets', items })
    : { saved: 0 };
  return {
    saved: Number(result.saved) || 0,
    candidates: items.length,
    messages,
    rosterRefreshed: rosterState.refreshed,
    window,
  };
}

function dhakaDateStr(d, tz) {
  return d.toLocaleDateString('en-CA', { timeZone: tz }); // yyyy-mm-dd
}

function jobCheckDateKeys(targetDate, historyDays, timezone, now = new Date()) {
  const requested = String(targetDate || '').trim();
  const base = requested
    ? new Date(`${requested}T12:00:00.000Z`)
    : new Date(now);
  if (Number.isNaN(base.getTime()) || (requested && base.toISOString().slice(0, 10) !== requested)) {
    throw new Error('Job check date must be YYYY-MM-DD');
  }
  const keys = [];
  for (let i = 0; i <= historyDays; i++) {
    const date = new Date(base.getTime() - i * 86400000);
    keys.push(requested ? date.toISOString().slice(0, 10) : dhakaDateStr(date, timezone));
  }
  return keys;
}

function formatDailyTrackerLine(result, dailyTarget, historyDays) {
  const icon = result.todayCount >= dailyTarget ? '✅' : '📉';
  const todayLabel = result.dateUnavailable ? 'estimated today' : 'dated today';
  const rowChange = result.baseline
    ? 'new-row baseline created'
    : result.newRows === null
      ? 'new rows unavailable'
      : `new rows: **${result.newRows}**`;
  const mismatch = !result.dateUnavailable && Number(result.newRows) > Number(result.todayCount)
    ? ' · ⚠️ new-row count is higher than dated-today; check recent date cells'
    : '';
  return `${icon} ${mention(result.s)} — ${todayLabel}: **${result.todayCount}** · ` +
    `total tracker rows: **${result.totalRows}** · ${rowChange} · ` +
    `previous ${historyDays} days: ${(result.prev || []).join(', ')}${mismatch}`;
}

// ============================================================
//  Daily check
// ============================================================
async function runJobsCheck(client, cohort, manual = false, targetDate = '') {
  if (!manual && !(await isOn(cohort, 'jobs'))) { console.log(`[jobs] ${cohort.name}: automation OFF`); return; }
  if (!manual && !(await isScheduledToday(cohort, 'jobs'))) { console.log(`[jobs] ${cohort.name}: not scheduled today`); return; }
  if (await isWarmup(cohort)) { console.log(`[jobs] ${cohort.name}: warm-up - check skipped`); return; }
  const cfg = Object.assign({ historyDays: 3 }, cohort.jobs || {});
  cfg.dailyTarget = await getNumber(cohort, 'jobstarget'); // runtime-adjustable via !set
  cfg.historyDays = await getNumber(cohort, 'jobshistory');
  try {
    // The nightly public report must represent the Discord server as it exists
    // now, not a stale Bot_Map snapshot. Unmatched members stay visible in
    // Roster Review, but cannot be omitted from a public report or admitted
    // under fabricated contact details.
    requireCompleteIdentityCoverage(
      await syncMembers(client, cohort, { force: true }),
      'Nightly job check',
    );
    // Reconcile recent durable Discord history before reading Job_Sheets. This
    // automatically recovers a tracker link whose real-time save met a
    // temporary Google Web App outage, without asking the student to repost.
    try {
      const currentRoster = await getRoster(cohort, true);
      const recovered = await backfillJobSheetLinks(client, cohort, {
        maxPages: 10,
        roster: currentRoster,
      });
      if (recovered.saved) {
        console.log(`[jobs] ${cohort.name}: reconciled ${recovered.saved} tracker link(s) from recent Discord history`);
      }
    } catch (error) {
      console.error(`[jobs] ${cohort.name}: recent tracker-link reconciliation failed:`, error.message);
    }
    // day keys: today + previous N days (Dhaka)
    const dayKeys = jobCheckDateKeys(targetDate, cfg.historyDays, cohort.timezone);
    const [today, ...prevDays] = dayKeys;
    const bundle = await api(cohort, { action: 'jobaudit', date: today, guildId: cohort.guildId });
    if (bundle.error) throw new Error(bundle.error);
    const roster = setRosterSnapshot(cohort, bundle.roster || [], bundle.excludedIds || []);
    const sheetByEmail = new Map((bundle.sheets || []).map(s => [s.email, {
      sheetId: s.sheetId,
      gid: s.gid || '',
    }]));
    const channel = await client.channels.fetch(await resolveChannel(cohort, 'channel_jobs', cohort.channels.jobTracking));

    const below = [], noSheet = [], unreadable = [], dateIssues = [], allCounts = [], duplicates = [];
    const dailyResults = [];
    const snapshotEstimates = [], snapshotBaselines = [], parsedStudents = [];
    let hitTarget = 0;

    for (const s of roster) {
      if (isExcluded(cohort, s)) continue;
      const tracker = sheetByEmail.get(s.email);
      if (!tracker?.sheetId) { noSheet.push(s); continue; }

      const r = await readTracker(tracker, {
        timezone: cohort.timezone,
        targetDate: today,
        exhaustive: true,
        discoverWhenTargetMissing: true,
        maxTabs: 30,
        tabPaceMs: 250,
        timeoutMs: 30000,
        csvTimeoutMs: 20000,
        tabTimeoutMs: 20000,
      });
      await sleep(400); // gentle pacing across ~60 sheets
      if (r.error) { unreadable.push({ s, error: r.error }); continue; }
      parsedStudents.push({ s, tracker, parsed: r });
    }

    const discoveredTabs = parsedStudents.filter(item =>
      item.parsed.tabDiscovered && item.parsed.shouldPersistResolvedGid && item.parsed.resolvedGid &&
      item.parsed.resolvedGid !== item.tracker.gid
    ).map(item => ({
      email: item.s.email,
      sheetId: item.tracker.sheetId,
      gid: item.parsed.resolvedGid,
    }));
    if (discoveredTabs.length) {
      try {
        const savedTabs = await post(cohort, {
          action: 'saveJobSheets',
          items: discoveredTabs,
        });
        if (savedTabs.error) throw new Error(savedTabs.error);
        console.log(`[jobs] ${cohort.name}: saved ${savedTabs.saved} automatically discovered tracker tab GID(s)`);
      } catch (err) {
        console.error(`[jobs] ${cohort.name}: discovered-tab save failed:`, err.message);
      }
    }

    let snapshotByEmail = new Map();
    const snapshotEntries = parsedStudents
      .filter(item => Number.isFinite(item.parsed.totalApplicationRows))
      .map(item => ({
        email: item.s.email, sheetId: item.tracker.sheetId,
        gid: item.parsed.resolvedGid || item.tracker.gid,
        rowCount: item.parsed.totalApplicationRows,
      }));
    if (snapshotEntries.length) {
      try {
        const saved = await post(cohort, { action: 'saveJobSnapshots', date: today, entries: snapshotEntries });
        if (saved.error) throw new Error(saved.error);
        snapshotByEmail = new Map((saved.results || []).map(item => [item.email, item]));
      } catch (err) {
        console.error(`[jobs] ${cohort.name}: snapshot update failed:`, err.message);
      }
    }

    for (const { s, parsed: r } of parsedStudents) {
      let todayCount;
      const snapshot = snapshotByEmail.get(s.email);
      if (r.dateUnavailable) {
        if (!snapshot) {
          unreadable.push({ s, error: 'no date column; row-snapshot service unavailable' });
          continue;
        }
        todayCount = Number(snapshot.count) || 0;
        if (snapshot.baseline) snapshotBaselines.push(s);
        else snapshotEstimates.push({ s, count: todayCount });
      } else {
        todayCount = r.counts[today] || 0;
        if (r.invalidDateRows) {
          dateIssues.push({ s, count: r.invalidDateRows, column: r.dateColumn });
        }
      }
      allCounts.push({ email: s.email, count: todayCount });
      dailyResults.push({
        s,
        todayCount,
        totalRows: Number(r.totalApplicationRows) || 0,
        newRows: snapshot && !snapshot.baseline ? Number(snapshot.count) || 0 : null,
        baseline: Boolean(snapshot && snapshot.baseline),
        dateUnavailable: Boolean(r.dateUnavailable),
        prev: prevDays.map(k => r.counts[k] || 0),
      });
      // duplicate companies today (same company applied 2+ times)
      const comps = (r.companiesByDay && r.companiesByDay[today]) || [];
      const seen = {}, dups = new Set();
      for (const c of comps) { if (seen[c]) dups.add(c); seen[c] = true; }
      if (dups.size) duplicates.push({ s, dups: [...dups] });
      if (todayCount >= cfg.dailyTarget) { hitTarget++; continue; }
      below.push({
        s, todayCount,
        prev: prevDays.map(k => r.counts[k] || 0),
      });
    }

    below.sort((a, b) => a.todayCount - b.todayCount);

    // persist today's REAL counts -> Jobs_Daily (feeds RTBR points + streaks)
    await post(cohort, {
      action: 'saveJobCounts',
      date: today,
      entries: allCounts,
      guildId: cohort.guildId,
    })
      .catch(e => console.error('[jobs] saveJobCounts failed:', e.message));

    const lines = [
      `📋 **Daily job application check** — target: **${cfg.dailyTarget}/day** (${hitTarget} students hit it today)`,
      '**Every active student is listed below.** “Today” uses the application-date column; “new rows” independently compares the tracker with its previous successful check.',
    ];
    for (const result of dailyResults) {
      lines.push(formatDailyTrackerLine(result, cfg.dailyTarget, cfg.historyDays));
    }
    if (noSheet.length) {
      lines.push(`\n🔗 **No tracker linked yet** — these active students must post their Google Sheet link:`);
      for (const s of noSheet) lines.push(`• ${mention(s)} — total rows: unavailable · today: unavailable`);
    }
    if (duplicates.length) {
      lines.push(`\n🔁 **Duplicate applications today** (same company twice — check your tracker):`);
      for (const d of duplicates) {
        lines.push(`• **${d.s.name}** — ${d.dups.slice(0, 5).join(', ')}`);
      }
    }
    if (unreadable.length) {
      lines.push(`\n⚠️ **Could not read these trackers** (make sure sharing = "Anyone with the link → Viewer"):`);
      for (const u of unreadable) lines.push(`• ${mention(u.s)} — total rows: unavailable · today: unavailable (${u.error})`);
    }
    if (dateIssues.length) {
      lines.push(`\n📅 **Some tracker rows have dates I could not understand** (fix these so they are not missed):`);
      for (const issue of dateIssues) {
        lines.push(`• **${issue.s.name}** — ${issue.count} row(s) in **${issue.column}**`);
      }
    }
    if (snapshotEstimates.length) {
      lines.push(`\n🧮 **Estimated from new tracker rows** (these sheets have no usable application-date column):`);
      for (const item of snapshotEstimates) lines.push(`• **${item.s.name}** — **${item.count}** new row(s) since the previous successful check`);
    }
    if (snapshotBaselines.length) {
      lines.push(`\n📐 **Tracker baseline created** — counting starts from the next successful check unless a date column is added:`);
      for (const s of snapshotBaselines) lines.push(`• **${s.name}**`);
    }
    if (!below.length && !noSheet.length && !unreadable.length && !dateIssues.length) {
      lines.push('🌟 Every single student hit the target today. Phenomenal!');
    }

    for (const chunk of chunkLines(lines, 1900)) {
      await channel.send({ content: chunk, allowedMentions: { parse: ['users'] } });
      await sleep(1200);
    }
    console.log(`[jobs] ${cohort.name}: check done — ${below.length} below target, ${noSheet.length} unlinked, ${unreadable.length} unreadable`);
  } catch (err) {
    console.error(`[jobs] ${cohort.name} check failed:`, err.message);
    const admin = await client.channels.fetch(cohort.channels.supervisor).catch(() => null);
    if (admin?.isTextBased()) {
      await admin.send({
        content: `❌ **Nightly job check stopped for ${cohort.name}:** ${String(err.message).slice(0, 300)}\nThe run was not declared complete; rerun \`!profilecheck\`, then \`!jobscheck${targetDate ? ` ${targetDate}` : ''}\` after correcting the problem.`,
        allowedMentions: { parse: [] },
      }).catch(() => {});
    }
  }
}

// ============================================================
//  Bot-admin audit: check every tracker without pinging students
// ============================================================
async function runJobSheetAudit(client, cohort, dateKey) {
  const admin = await client.channels.fetch(cohort.channels.supervisor);
  const target = await getNumber(cohort, 'jobstarget');
  try {
    const bundle = await api(cohort, { action: 'jobaudit', date: dateKey, guildId: cohort.guildId });
    if (bundle.error) throw new Error(bundle.error);
    const roster = setRosterSnapshot(cohort, bundle.roster || [], bundle.excludedIds || []);
    const activeStudents = roster.filter(s => !isExcluded(cohort, s));
    const phoneByEmail = new Map((bundle.contacts || []).map(s => [s.email, s.phone || '']));
    const savedByEmail = new Map((bundle.saved || []).map(s => [s.email, {
      count: Number(s.count) || 0,
      present: true,
    }]));
    const sheetByEmail = new Map((bundle.sheets || []).map(s => [s.email, {
      sheetId: s.sheetId,
      gid: s.gid || '',
    }]));
    const results = [];

    for (const s of activeStudents) {
      const tracker = sheetByEmail.get(s.email);
      if (!tracker?.sheetId) {
        results.push({ s, status: 'missing', count: 0 });
        continue;
      }

      const parsed = await readTracker(tracker, {
        timezone: cohort.timezone,
        targetDate: dateKey,
        exhaustive: true,
        maxTabs: 30,
        tabPaceMs: 200,
        timeoutMs: 30000,
        csvTimeoutMs: 20000,
        tabTimeoutMs: 20000,
      });
      await sleep(400);
      if (parsed.error) {
        const saved = savedByEmail.get(s.email);
        results.push(saved?.present
          ? { s, status: 'saved', count: saved.count, error: parsed.error }
          : { s, status: 'unreadable', count: 0, error: parsed.error });
        continue;
      }
      if (parsed.dateUnavailable) {
        const saved = savedByEmail.get(s.email);
        results.push(saved?.present
          ? { s, status: 'estimated', count: saved.count, totalRows: Number(parsed.totalApplicationRows) || 0 }
          : { s, status: 'snapshot', count: 0, totalRows: Number(parsed.totalApplicationRows) || 0 });
        continue;
      }

      const companies = parsed.companiesByDay?.[dateKey] || [];
      const seen = new Set(), duplicateCompanies = new Set();
      for (const company of companies) {
        if (seen.has(company)) duplicateCompanies.add(company);
        seen.add(company);
      }
      results.push({
        s,
        status: parsed.invalidDateRows ? 'warning' : 'readable',
        count: parsed.counts[dateKey] || 0,
        dateColumn: parsed.dateColumn,
        resolvedTabName: parsed.resolvedTabName || '',
        tabDiscovered: Boolean(parsed.tabDiscovered),
        inspectedTabs: Number(parsed.inspectedTabs || 1),
        invalidDateRows: parsed.invalidDateRows || 0,
        invalidDateSamples: parsed.invalidDateSamples || [],
        duplicateCompanies: [...duplicateCompanies],
        totalRows: Number(parsed.totalApplicationRows) || 0,
      });
    }

    const readable = results.filter(r => r.status === 'readable' || r.status === 'warning');
    const fallbacks = results.filter(r => r.status === 'saved' || r.status === 'estimated');
    const baselines = results.filter(r => r.status === 'snapshot');
    const missing = results.filter(r => r.status === 'missing');
    const unreadable = results.filter(r => r.status === 'unreadable');
    const warnings = results.filter(r => r.status === 'warning');
    const counted = readable.concat(fallbacks);
    const hitTarget = counted.filter(r => r.count >= target);
    const totalApplications = counted.reduce((sum, r) => sum + r.count, 0);
    const totalTrackerRows = results.reduce((sum, r) => sum + Number(r.totalRows || 0), 0);
    const invalidRows = warnings.reduce((sum, r) => sum + r.invalidDateRows, 0);

    await admin.send({
      embeds: [{
        title: `🔎 Job Sheet Audit — ${dateKey}`,
        color: missing.length || unreadable.length || warnings.length ? 0xe67e22 : 0x2ecc71,
        fields: [
          { name: 'Active students', value: String(activeStudents.length), inline: true },
          { name: 'Date-counted trackers', value: String(readable.length), inline: true },
          { name: 'Saved/snapshot fallback', value: String(fallbacks.length), inline: true },
          { name: 'Baseline needed', value: String(baselines.length), inline: true },
          { name: `Hit ${target}+ jobs`, value: String(hitTarget.length), inline: true },
          { name: 'Applications found', value: String(totalApplications), inline: true },
          { name: 'Total tracker rows', value: String(totalTrackerRows), inline: true },
          { name: 'Missing links', value: String(missing.length), inline: true },
          { name: 'Unreadable trackers', value: String(unreadable.length), inline: true },
          { name: 'Unrecognized date rows', value: String(invalidRows), inline: true },
        ],
        footer: { text: 'Private bot-admin audit — no students were pinged and no scores were changed.' },
        timestamp: new Date().toISOString(),
      }],
    });

    const rank = { unreadable: 0, missing: 1, snapshot: 2, saved: 3, estimated: 4, warning: 5, readable: 6 };
    results.sort((a, b) => rank[a.status] - rank[b.status] || a.count - b.count || a.s.name.localeCompare(b.s.name));
    const lines = results.map(r => {
      if (r.status === 'missing') return `⚪ **${r.s.name}** — no tracker linked`;
      if (r.status === 'unreadable') return `🔴 **${r.s.name}** — unreadable: ${r.error}`;
      if (r.status === 'snapshot') return `🟠 **${r.s.name}** — ${r.totalRows} total tracker row(s) · no date column and no earlier nightly snapshot; the next student-facing job check will create its baseline`;
      if (r.status === 'saved') return `🟣 **${r.s.name}** — ${r.count} saved application${r.count === 1 ? '' : 's'} · live tracker unavailable: ${r.error}`;
      if (r.status === 'estimated') return `🟣 **${r.s.name}** — ${r.count} application${r.count === 1 ? '' : 's'} estimated from new rows · ${r.totalRows} total tracker row(s)`;
      const icon = r.status === 'warning' ? '🟡' : r.count >= target ? '🟢' : '🔵';
      const notes = [
        `${r.count} application${r.count === 1 ? '' : 's'}`,
        `${r.totalRows} total tracker row(s)`,
        `date column: ${r.dateColumn}`,
        r.tabDiscovered ? `used matching tab: ${r.resolvedTabName || r.resolvedGid}` : '',
        r.inspectedTabs > 1 ? `${r.inspectedTabs} public tabs inspected` : '',
        r.invalidDateRows ? `${r.invalidDateRows} invalid date row(s)` : '',
        r.invalidDateSamples.length ? `samples: ${r.invalidDateSamples.join(', ')}` : '',
        r.duplicateCompanies.length ? `duplicates: ${r.duplicateCompanies.slice(0, 5).join(', ')}` : '',
      ].filter(Boolean);
      return `${icon} **${r.s.name}** — ${notes.join(' · ')}`;
    });

    for (let i = 0; i < lines.length; i++) {
      lines[i] += ` | contact: ${contactMarkdown(phoneByEmail.get(results[i].s.email))}`;
    }

    for (const chunk of chunkLines(lines, 1900)) {
      await admin.send({
        content: chunk,
        allowedMentions: { parse: [] },
        flags: MessageFlags.SuppressEmbeds,
      });
      await sleep(800);
    }
    console.log(`[jobs] ${cohort.name}: bot-admin audit for ${dateKey} — ${readable.length} dated, ${fallbacks.length} fallback, ${missing.length} missing, ${unreadable.length} unreadable`);
    return {
      date: dateKey,
      target,
      activeStudents: activeStudents.length,
      results,
      counts: {
        readable: readable.length,
        fallbacks: fallbacks.length,
        baselines: baselines.length,
        missing: missing.length,
        unreadable: unreadable.length,
        warnings: warnings.length,
      },
    };
  } catch (err) {
    console.error(`[jobs] ${cohort.name} audit failed:`, err.message);
    await admin.send(`❌ **Job Sheet Audit failed:** ${err.message.slice(0, 300)}`);
    return { error: err.message, date: dateKey, results: [] };
  }
}

// ============================================================
//  Register
// ============================================================
module.exports = function registerJobs(client) {
  for (const cohort of cohorts) {
    if (!cohort.channels.jobTracking || String(cohort.channels.jobTracking).startsWith('PASTE')) continue;
    scheduleAtSetting(cohort, 'jobs', 'jobschecktime',
      () => runQuotaTask(`jobs:${cohort.guildId}`, () => runJobsCheck(client, cohort)));
    console.log(`[jobs] ${cohort.name}: runtime-configurable daily check active`);
  }

  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.channels.jobTracking) return;

    const content = msg.content.trim();
    const lower = content.toLowerCase();

    // ---- supervisor commands ----
    const isSheetAudit = lower === '!checkjobsheets' || lower.startsWith('!checkjobsheets ');
    const backfillCommand = parseHistoryCommand(lower, '!backfilljobsheets');
    const isJobsCheck = lower === '!jobscheck' || lower.startsWith('!jobscheck ');
    const jobsCheckMatch = lower.match(/^!jobscheck(?:\s+(\d{4}-\d{2}-\d{2}))?$/);
    if (isJobsCheck || backfillCommand || isSheetAudit) {
      if (!cohort.supervisorIds.includes(msg.author.id)) return;

      if (isSheetAudit) {
        if (msg.channelId !== cohort.channels.supervisor) {
          return msg.reply(`Run this private audit in <#${cohort.channels.supervisor}>.`);
        }
        const rawDate = content.split(/\s+/)[1] || 'today';
        const dateKey = rawDate.toLowerCase() === 'today'
          ? dhakaDateStr(new Date(), cohort.timezone)
          : parseDateValue(rawDate, 'yyyy-mm-dd', cohort.timezone);
        if (!dateKey) return msg.reply('Usage: `!checkjobsheets [YYYY-MM-DD]` — omit the date to check today.');
        await msg.reply(`🔎 Deep-checking every active student's tracker for **${dateKey}**. Alternate public tabs are inspected when available; this can take several minutes.`);
        await runJobSheetAudit(client, cohort, dateKey);
        return;
      }

      if (isJobsCheck) {
        if (!jobsCheckMatch) return msg.reply('Usage: `!jobscheck [YYYY-MM-DD]`.');
        const requestedDate = jobsCheckMatch[1] || '';
        let targetDate = '';
        if (requestedDate) {
          targetDate = parseDateValue(requestedDate, 'yyyy-mm-dd', cohort.timezone);
          const today = dhakaDateStr(new Date(), cohort.timezone);
          if (!targetDate || targetDate > today) {
            return msg.reply('Usage: `!jobscheck [YYYY-MM-DD]` — the optional date cannot be in the future.');
          }
        }
        await msg.reply(`🔎 Reading every student tracker for **${targetDate || 'today'}** — this takes a minute for the whole cohort...`);
        await runJobsCheck(client, cohort, true, targetDate);
        return;
      }

      if (backfillCommand.error) return msg.reply(backfillCommand.error);
      const window = historyWindow(backfillCommand.days, cohort.timezone);
      // backfill: scan only the selected recent history for the latest link per student
      await msg.reply(`⏳ Scanning tracker-link messages from the last **${historyWindowLabel(window)}**...`);
      try {
        const result = await backfillJobSheetLinks(client, cohort, { days: backfillCommand.days });
        const refreshNote = result.rosterRefreshed
          ? ''
          : '\n⚠️ The live roster refresh hit a temporary backend error, so this run used the last durable roster. Existing students were imported safely; rerun later to capture any brand-new unmatched member.';
        await msg.reply(`✅ Backfill done for **${historyWindowLabel(result.window)}**: **${result.saved}** student trackers saved from **${result.messages}** channel messages to Job_Sheets (one bulk request).${refreshNote}`);
      } catch (err) {
        await msg.reply('❌ ' + err.message);
      }
      return;
    }

    // ---- student posts a tracker link ----
    if (msg.channelId !== cohort.channels.jobTracking) return;
    const tracker = parseSheetLink(content);
    if (!tracker) return;
    try {
      let roster = await getRoster(cohort);
      let s = roster.find(r => r.discordId === msg.author.id);
      if (!s && !cohort.supervisorIds.includes(msg.author.id)) {
        await syncMembers(client, cohort);
        roster = await getRoster(cohort, true);
        s = roster.find(r => r.discordId === msg.author.id);
      }
      if (!s || isExcluded(cohort, s)) return;
      const r = await post(cohort, { action: 'saveJobSheet', email: s.email, ...tracker });
      if (r.error) throw new Error(r.error);
      await msg.react('✅').catch(() => {});
      const tabSelection = tracker.gid
        ? `selected tab GID **${tracker.gid}**`
        : 'the **default/first visible tab** because this link had no GID';
      const checkTime = await getSetting(cohort, 'jobschecktime');
      await msg.reply({
        content: `🔗 Tracker linked, ${msg.author}! I'll check ${tabSelection} on scheduled days at **${checkTime}** (${cohort.timezone}). Make sure sharing is set to **"Anyone with the link → Viewer"**.`,
        allowedMentions: { users: [msg.author.id] },
      });
    } catch (err) {
      console.error('[jobs] link save failed:', err.message);
      await msg.reply({
        content: `⚠️ I could not save this tracker link immediately: ${String(err.message).slice(0, 220)}. The link remains in this channel and will be recovered automatically at the next job check; a mentor can run \`!backfilljobsheets\` sooner. You do not need to repost it.`,
        allowedMentions: { parse: [] },
      }).catch(() => {});
    }
  });
};

module.exports.formatDailyTrackerLine = formatDailyTrackerLine;
module.exports.backfillJobSheetLinks = backfillJobSheetLinks;
module.exports.runJobSheetAudit = runJobSheetAudit;
module.exports.runJobsCheck = runJobsCheck;
module.exports.jobCheckDateKeys = jobCheckDateKeys;
