const { runQuotaTask } = require('./quota-queue');
const { cohorts } = require('./config');
const { isOn } = require('./automations');
const { readTracker } = require('./job-tracker');
const { chunkLines } = require('./message-chunks');
const { getRoster, isExcluded } = require('./roster');
const { getNumber, resolveChannel } = require('./settings');
const { isScheduledToday } = require('./scheduler');
const { scheduleAtSetting } = require('./runtime-schedule');
const { isWarmup } = require('./state');
const { currentWorkWeek, rankWeeklyStudents, weeklyLine } = require('./weekly-ranking');
const { getWeeklyTargets, targetSummaryLine } = require('./weekly-targets');
const { appsScriptGet } = require('./apps-script-api');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function api(cohort, params) {
  return appsScriptGet(cohort, params, { label: 'Weekly report read' });
}

async function collectWeeklyPerformance(cohort, now = new Date()) {
  const range = currentWorkWeek(now, cohort.timezone);
  const [roster, performance, sheets, targets] = await Promise.all([
    getRoster(cohort, true),
    api(cohort, { action: 'performance', start: range.start, end: range.end }),
    api(cohort, { action: 'jobsheets' }),
    getWeeklyTargets(cohort, range),
  ]);
  const rtbr = await api(cohort, {
    action: 'rtbr',
    days: range.keys.length,
    jobTarget: targets.dailyApplications,
  });
  const active = roster.filter(student => !isExcluded(cohort, student));
  const performanceByEmail = new Map((performance.students || []).map(student => [student.email, student]));
  const trackerByEmail = new Map((sheets.sheets || []).map(sheet => [sheet.email, sheet]));
  const scoredRtbr = (rtbr.students || []).filter(student => Number(student.total) > 0);
  const rtbrByEmail = new Map(scoredRtbr.map((student, index) => [student.email, {
    points: Number(student.total) || 0,
    rank: index + 1,
  }]));
  const students = [];
  let liveTrackers = 0;
  let fallbackTrackers = 0;

  for (const rosterStudent of active) {
    const saved = performanceByEmail.get(rosterStudent.email) || {};
    const student = Object.assign({
      email: rosterStudent.email,
      name: rosterStudent.name,
      jobs: 0,
      attendance: 0,
      interviews: 0,
      outreach: 0,
      communicationPractices: 0,
      workshops: 0,
      questionAnswers: 0,
    }, saved, { name: rosterStudent.name || saved.name });
    const referral = rtbrByEmail.get(rosterStudent.email) || { points: 0, rank: 0 };
    student.rtbrPoints = referral.points;
    student.rtbrRank = referral.rank;
    const tracker = trackerByEmail.get(rosterStudent.email);
    if (tracker?.sheetId) {
      const parsed = await readTracker(tracker, {
        timezone: cohort.timezone,
        targetDates: range.keys,
        exhaustive: true,
        maxTabs: 20,
        tabPaceMs: 150,
        timeoutMs: 30000,
        csvTimeoutMs: 20000,
        tabTimeoutMs: 20000,
      });
      if (!parsed.error && !parsed.dateUnavailable) {
        student.jobs = range.keys.reduce((sum, key) => sum + (Number(parsed.counts[key]) || 0), 0);
        liveTrackers++;
      } else {
        fallbackTrackers++;
      }
      await sleep(250);
    } else {
      fallbackTrackers++;
    }
    students.push(student);
  }

  return {
    range,
    students: rankWeeklyStudents(students),
    targets,
    liveTrackers,
    fallbackTrackers,
  };
}

async function postWeeklyReport(client, cohort) {
  const report = await collectWeeklyPerformance(cohort);
  const channelId = await resolveChannel(cohort, 'channel_discussion', cohort.channels.discussion);
  const channel = await client.channels.fetch(channelId);
  if (!report.students.length) {
    await channel.send('📊 **Weekly performance report:** no active students were found.');
    return report;
  }

  const lineTargets = { ...report.targets, jobs: report.targets.applications };
  const topCount = await getNumber(cohort, 'weeklytop');
  const totalInterviews = report.students.reduce((sum, student) => sum + (Number(student.interviews) || 0), 0);
  const top = report.students.slice(0, topCount).map((student, index) => weeklyLine(student, index + 1, lineTargets));
  const referralLeaders = [...report.students]
    .filter(student => Number(student.rtbrRank) > 0)
    .sort((a, b) => (Number(a.rtbrRank) || Number.MAX_SAFE_INTEGER) - (Number(b.rtbrRank) || Number.MAX_SAFE_INTEGER))
    .slice(0, Math.min(5, report.students.length))
    .map(student => `#${student.rtbrRank || '—'} ${student.name} — ${Number(student.rtbrPoints) || 0} pts`)
    .join('\n') || 'No scored RTBR activity in this week yet.';
  await channel.send({
    content: '@everyone',
    allowedMentions: { parse: ['everyone'] },
    embeds: [{
      title: `🏆 Weekly Performance Leaderboard — ${cohort.name}`,
      description: top.join('\n').slice(0, 4096),
      color: 0xf1c40f,
      fields: [
        { name: 'Week', value: `${report.range.start} to ${report.range.end}`, inline: true },
        { name: 'Primary ranking', value: 'Applications, then attendance', inline: true },
        { name: 'Tracker coverage', value: `${report.liveTrackers} live · ${report.fallbackTrackers} saved fallback`, inline: true },
        { name: 'Total interviews this week', value: String(totalInterviews), inline: true },
        { name: 'Priority for Referral (RTBR)', value: referralLeaders.slice(0, 1024), inline: false },
        { name: 'Cohort targets', value: targetSummaryLine(report.targets).slice(0, 1024), inline: false },
      ],
      footer: { text: 'Secondary context: interviews, outreach, communication practice, and workshops.' },
      timestamp: new Date().toISOString(),
    }],
  });

  const remaining = report.students.slice(topCount).map((student, index) => weeklyLine(student, index + topCount + 1, lineTargets));
  if (remaining.length) {
    await channel.send({ content: '**Remaining students**', allowedMentions: { parse: [] } });
    for (const chunk of chunkLines(remaining, 1900)) {
      await channel.send({ content: chunk, allowedMentions: { parse: [] } });
      await sleep(800);
    }
  }
  return report;
}

module.exports = function registerWeeklyReport(client) {
  for (const cohort of cohorts) {
    scheduleAtSetting(cohort, 'weeklyreport', 'weeklyreporttime', async () => {
      try {
        if (!(await isOn(cohort, 'weeklyreport')) ||
            !(await isScheduledToday(cohort, 'weeklyreport')) || (await isWarmup(cohort))) return;
        await runQuotaTask(`weekly:${cohort.guildId}`, () => postWeeklyReport(client, cohort));
      } catch (err) {
        console.error(`[weekly-report] ${cohort.name} scheduled report failed:`, err.message);
      }
    });
    console.log(`[weekly-report] ${cohort.name}: runtime-configurable schedule active`);
  }

  client.on('messageCreate', async msg => {
    if (msg.author.bot || msg.content.trim().toLowerCase() !== '!weeklyreport') return;
    const cohort = cohorts.find(candidate => candidate.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;
    if (msg.channelId !== cohort.channels.supervisor) {
      await msg.reply(`Run this supervisor command in <#${cohort.channels.supervisor}>.`);
      return;
    }
    await msg.reply(`📊 Building the Sunday-to-today leaderboard from live trackers. It will be posted in <#${cohort.channels.discussion}>; this may take about a minute.`);
    try {
      await postWeeklyReport(client, cohort);
      await msg.reply('✅ Weekly leaderboard posted.');
    } catch (err) {
      console.error(`[weekly-report] ${cohort.name} manual report failed:`, err.message);
      await msg.reply(`❌ Weekly report failed: ${err.message.slice(0, 300)}`);
    }
  });
};

module.exports.collectWeeklyPerformance = collectWeeklyPerformance;
module.exports.postWeeklyReport = postWeeklyReport;
