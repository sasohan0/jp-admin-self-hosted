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
const { getNumber, resolveChannel, setSetting } = require('./settings');
const { runQuotaTask } = require('./quota-queue');
const { normalizeTime, scheduleAtSetting } = require('./runtime-schedule');

const RTBR_ROLE_NAME = 'Right to Be Referred';

function rankRtbrStudents(students, topCount = 10) {
  return [...(students || [])]
    .filter(student => student && Number.isFinite(Number(student.total)) && Number(student.total) > 0)
    .sort((a, b) => Number(b.total) - Number(a.total) ||
      String(a.discordId || a.email || '').localeCompare(String(b.discordId || b.email || '')))
    .slice(0, Math.min(25, Math.max(1, Number(topCount) || 10)));
}

function buildRtbrPayload(students, options = {}) {
  const days = Math.max(1, Number(options.days) || 7);
  const topCount = Math.min(25, Math.max(1, Number(options.topCount) || 10));
  const jobTarget = Math.max(1, Number(options.jobTarget) || 15);
  const ranked = rankRtbrStudents(students, topCount);
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

async function ensureRtbrRole(guild) {
  await guild.roles.fetch();
  return guild.roles.cache.find(role => role.name === RTBR_ROLE_NAME) || guild.roles.create({
    name: RTBR_ROLE_NAME,
    colors: { primaryColor: 0xe91e63 },
    hoist: false,
    mentionable: false,
    reason: 'JP ADMIN weekly RTBR qualification role',
  });
}

async function syncRtbrRole(guild, rankedStudents) {
  const missingIds = rankedStudents.filter(student => !/^\d{15,22}$/.test(String(student.discordId || '')));
  if (missingIds.length) {
    throw new Error(`${missingIds.length} ranked student(s) have no verified Discord ID; RTBR roles were left unchanged`);
  }
  const role = await ensureRtbrRole(guild);
  await guild.members.fetch();
  const desired = new Set(rankedStudents.map(student => String(student.discordId)));
  for (const memberId of desired) {
    if (!guild.members.cache.has(memberId)) {
      throw new Error(`Ranked Discord member ${memberId} is not currently in this server; RTBR roles were left unchanged`);
    }
  }
  const remove = role.members.filter(member => !desired.has(member.id));
  let added = 0;
  for (const memberId of desired) {
    const member = guild.members.cache.get(memberId);
    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role, 'JP ADMIN weekly RTBR qualification');
      added++;
    }
  }
  for (const member of remove.values()) {
    await member.roles.remove(role, 'JP ADMIN weekly RTBR recalculation');
  }
  return { roleId: role.id, added, removed: remove.size, qualified: desired.size };
}

async function postRtbr(client, cohort) {
  const days = await getNumber(cohort, 'rtbrdays');
  const topCount = await getNumber(cohort, 'rtbrtop');
  const jobTarget = await getNumber(cohort, 'jobstarget');
  const data = await appsScriptGet(cohort, { action: 'rtbr', days, jobTarget }, {
    label: 'RTBR leaderboard',
    timeoutMs: 120000,
  });
  const ranked = rankRtbrStudents(data.students, topCount);
  const guild = await client.guilds.fetch(cohort.guildId);
  const roleResult = await syncRtbrRole(guild, ranked);
  const channelId = await resolveChannel(cohort, 'channel_rtbr', cohort.channels.rtbr);
  const channel = await client.channels.fetch(channelId);
  const payload = buildRtbrPayload(data.students, { days, topCount, jobTarget });
  if (!payload) {
    await channel.send('📊 No Priority for Referral activity exists in this window yet. Scores come from questions, interviews, job applications, and workshop attendance.');
    report(cohort.name, 'RTBR checked: no activity in the configured window');
    return { students: 0, channelId, roleResult };
  }
  await channel.send(payload);
  const announced = ranked.length;
  report(cohort.name, `RTBR announced (${announced} ranked students)`);
  return { students: announced, channelId, roleResult };
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
    if (msg.author.bot || !/^!rtbr(?:\s|$)/i.test(msg.content.trim())) return;
    const cohort = cohorts.find(item => item.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;
    if (msg.channelId !== cohort.channels.supervisor) {
      return msg.reply(`Run this command in <#${cohort.channels.supervisor}>.`);
    }
    const command = msg.content.trim().match(/^!rtbr(?:\s+(top|days|time)\s+(\S+))?$/i);
    if (!command) return msg.reply('Usage: `!rtbr`, `!rtbr top 10`, `!rtbr days 7`, or `!rtbr time 20:00`.');
    if (command[1]) {
      const action = command[1].toLowerCase();
      const value = command[2];
      if (action === 'time') {
        const time = normalizeTime(value);
        if (!time) return msg.reply('RTBR time must use 24-hour `HH:MM`.');
        try { await setSetting(cohort, 'rtbrtime', time); }
        catch (error) { return msg.reply(`❌ RTBR time update failed: ${String(error.message).slice(0, 240)}`); }
        return msg.reply(`✅ Weekly RTBR time is now **${time}** (${cohort.timezone}).`);
      }
      const number = Number(value);
      const max = action === 'top' ? 25 : 90;
      if (!Number.isInteger(number) || number < 1 || number > max) {
        return msg.reply(`RTBR ${action} must be a whole number from 1 to ${max}.`);
      }
      try { await setSetting(cohort, action === 'top' ? 'rtbrtop' : 'rtbrdays', number); }
      catch (error) { return msg.reply(`❌ RTBR setting update failed: ${String(error.message).slice(0, 240)}`); }
      return msg.reply(`✅ RTBR ${action === 'top' ? 'qualified-role quantity' : 'counting window'} is now **${number}**.`);
    }
    await msg.reply({ content: '⏳ Calculating the Priority for Referral leaderboard and reconciling the qualification role...', allowedMentions: { parse: [] } });
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
module.exports.rankRtbrStudents = rankRtbrStudents;
module.exports.syncRtbrRole = syncRtbrRole;
module.exports.RTBR_ROLE_NAME = RTBR_ROLE_NAME;
