// ============================================================
//  rtbr.js - Priority for Referral / Right-To-Be-Referred board
//  Weekly announcement (Thursday 8 PM by default) + !rtbr anytime.
// ============================================================
'use strict';

const { cohorts } = require('./config');
const { appsScriptGet } = require('./apps-script-api');
const { report, reportError } = require('./reporter');
const { isOn } = require('./automations');
const { isScheduledToday } = require('./scheduler');
const { getNumber, resolveChannel } = require('./settings');
const { runQuotaTask } = require('./quota-queue');
const { scheduleAtSetting } = require('./runtime-schedule');

function buildRtbrPayload(students, options = {}) {
  const days = Math.max(1, Number(options.days) || 7);
  const topCount = Math.min(25, Math.max(1, Number(options.topCount) || 10));
  const jobTarget = Math.max(1, Number(options.jobTarget) || 15);
  const ranked = [...(students || [])]
    .filter(student => student && Number.isFinite(Number(student.total)) && Number(student.total) > 0)
    .sort((a, b) => Number(b.total) - Number(a.total))
    .slice(0, topCount);
  if (!ranked.length) return null;

  const medals = ['🥇', '🥈', '🥉'];
  const lines = ranked.map((student, index) =>
    `${medals[index] || `**${index + 1}.**`} **${student.name || student.email || 'Student'}** — **${Number(student.total)}** ` +
    `(❓${Math.round(Number(student.questions) || 0)} · 🎯${Number(student.interviewCount) || 0} interviews/${Number(student.interviews) || 0} pts · ` +
    `💼${Number(student.jobApplications) || 0} apps/${Number(student.jobPts) || 0} pts${student.streak ? ` · 🔥${Number(student.streak)}` : ''} · ` +
    `🎤${Number(student.workshopCount) || 0} sessions/${Number(student.workshop) || 0} pts)`);

  return {
    content: '@everyone',
    allowedMentions: { parse: ['everyone'] },
    embeds: [{
      title: `🎯 Priority for Referral — last ${days} days`,
      description:
        `This **Right-To-Be-Referred** leaderboard determines priority for mentor-special job referrals. Score = question points ❓ + interviews 🎯 (15 each) + job applications 💼 (${jobTarget}/day = full marks, bonus above) + streak 🔥 + workshop sessions 🎤 (4 each).\n\n` +
        lines.join('\n'),
      color: 0xe91e63,
      footer: { text: 'Published every Thursday by default. Activity is calculated from the cohort Sheet.' },
    }],
  };
}

async function postRtbr(client, cohort) {
  const days = await getNumber(cohort, 'rtbrdays');
  const topCount = await getNumber(cohort, 'rtbrtop');
  const jobTarget = await getNumber(cohort, 'jobstarget');
  const data = await appsScriptGet(cohort, { action: 'rtbr', days, jobTarget }, {
    label: 'RTBR leaderboard',
    timeoutMs: 120000,
  });
  const channelId = await resolveChannel(cohort, 'channel_rtbr', cohort.channels.rtbr);
  const channel = await client.channels.fetch(channelId);
  const payload = buildRtbrPayload(data.students, { days, topCount, jobTarget });
  if (!payload) {
    await channel.send('📊 No Priority for Referral activity exists in this window yet. Scores come from questions, interviews, job applications, and workshop attendance.');
    report(cohort.name, 'RTBR checked: no activity in the configured window');
    return { students: 0, channelId };
  }
  await channel.send(payload);
  const announced = Math.min(topCount, data.students.length);
  report(cohort.name, `RTBR announced (${announced} ranked students)`);
  return { students: announced, channelId };
}

module.exports = function registerRtbr(client) {
  for (const cohort of cohorts) {
    scheduleAtSetting(cohort, 'rtbr', 'rtbrtime', async () => {
      if (!(await isOn(cohort, 'rtbr')) || !(await isScheduledToday(cohort, 'rtbr'))) return;
      try {
        await runQuotaTask(`rtbr:${cohort.guildId}`, () => postRtbr(client, cohort));
      } catch (error) {
        reportError(cohort.name, `RTBR failed: ${error.message}`);
        throw error;
      }
    });
    console.log(`[rtbr] ${cohort.name}: runtime-configurable Thursday schedule active`);
  }

  client.on('messageCreate', async msg => {
    if (msg.author.bot || msg.content.trim().toLowerCase() !== '!rtbr') return;
    const cohort = cohorts.find(item => item.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;
    if (msg.channelId !== cohort.channels.supervisor) {
      return msg.reply(`Run this command in <#${cohort.channels.supervisor}>.`);
    }
    await msg.reply({ content: '⏳ Calculating the Priority for Referral leaderboard from the cohort Sheet...', allowedMentions: { parse: [] } });
    try {
      const result = await runQuotaTask(`rtbr-manual:${cohort.guildId}`, () => postRtbr(client, cohort));
      return msg.channel.send({
        content: `✅ Priority for Referral posted in <#${result.channelId}> with **${result.students}** ranked student(s).`,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      reportError(cohort.name, `Manual RTBR failed: ${error.message}`);
      return msg.channel.send(`❌ Priority for Referral failed: ${String(error.message).slice(0, 300)}`);
    }
  });
};

module.exports.buildRtbrPayload = buildRtbrPayload;
module.exports.postRtbr = postRtbr;
