'use strict';

const { randomBytes } = require('crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { cohorts } = require('./config');
const { appsScriptGet } = require('./apps-script-api');
const { getRoster, isExcluded, syncMembers } = require('./roster');
const { getNumber } = require('./settings');
const { isOn } = require('./automations');
const { chunkLines } = require('./message-chunks');
const {
  dateKeyInZone, loadWorkCalendar, shiftDateKey,
} = require('./work-calendar');
const {
  parseFollowupCommand,
  currentGuildStudents,
  quotaGapStudents,
  targetGapStudents,
  workingDatesBetween,
  zeroActivityStudents,
} = require('./followup-rules');
const { sendPrivateContactReport } = require('./activity-automation');
const { ROLE_NAME, enrollmentPayload } = require('./dawn-discipline');
const { completionSnapshot, ensureRulesMessage, publicComponents } = require('./onboarding');
const { runJobSheetAudit } = require('./jobs');

const previews = new Map();
const PREVIEW_TTL = 15 * 60 * 1000;

function sundayOf(dateKey) {
  const day = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return shiftDateKey(dateKey, -day);
}

async function activeRoster(client, cohort, guild) {
  await syncMembers(client, cohort);
  return currentGuildStudents(
    (await getRoster(cohort, true)).filter(student => !isExcluded(cohort, student)),
    new Set(guild.members.cache.keys()),
  );
}

function defaultChannel(cohort, kind) {
  const channels = cohort.channels || {};
  return {
    dawnjoin: channels.discussion,
    jobsheet: channels.jobTracking,
    profile: channels.discussion,
    attendance: channels.warning || channels.discussion,
    interview: channels.interviewUpdates,
    jobs: channels.emergency || channels.jobTracking,
    outreach: channels.outreach,
    dawn: channels.discipline,
    communication: channels.workshop,
    workshop: channels.workshop,
  }[kind] || channels.discussion;
}

async function recentPeriod(cohort, minimumDays) {
  const calendar = await loadWorkCalendar(cohort);
  const today = dateKeyInZone(cohort.timezone);
  let dates = workingDatesBetween(calendar, sundayOf(today), today);
  if (dates.length < minimumDays) {
    let start = shiftDateKey(sundayOf(today), -14);
    dates = workingDatesBetween(calendar, start, today).slice(-Math.max(minimumDays, 1));
  }
  return { calendar, today, dates, start: dates[0] || today, end: dates.at(-1) || today };
}

function mentionLines(students, formatter) {
  return students.map(student => `• <@${student.discordId}>${formatter ? ` — ${formatter(student)}` : ''}`);
}

function previewLines(students, formatter) {
  return students.map(student => {
    const name = String(student.name || student.displayName || student.username || 'Unnamed student')
      .replace(/[\r\n*_~|]+/g, ' ').trim();
    return `• **${name}**${formatter ? ` — ${formatter(student)}` : ''}`;
  });
}

async function buildFollowup(client, cohort, request, guild) {
  const roster = await activeRoster(client, cohort, guild);
  const period = await recentPeriod(cohort, request.threshold);
  let students = [];
  let title = '';
  let intro = '';
  let formatter = null;
  let components = [];
  let privateReason = () => request.kind;

  if (request.kind === 'dawnjoin') {
    const role = guild.roles.cache.find(item => item.name.toLowerCase() === ROLE_NAME.toLowerCase());
    const members = new Set(role ? [...role.members.keys()] : []);
    students = roster.filter(student => !members.has(student.discordId));
    title = 'Join Dawn Focus Circle';
    intro = 'These students have not joined Dawn Focus Circle yet. Use the button below to review the benefits and apply privately.';
    components = enrollmentPayload(cohort).components || [];
    privateReason = () => 'Dawn Focus Circle role not assigned';
  } else if (request.kind === 'profile') {
    const snapshot = await completionSnapshot(client, cohort, guild);
    const incomplete = new Map(snapshot.incomplete.map(item => [item.member.id, item]));
    students = roster.filter(student => incomplete.has(student.discordId)).map(student => ({
      ...student, completion: incomplete.get(student.discordId),
    }));
    const rules = await ensureRulesMessage(client, cohort);
    components = publicComponents(rules.url, cohort);
    title = 'Complete private onboarding and profile';
    intro = 'Use the private buttons below. Contact details and onboarding answers are never posted publicly.';
    formatter = student => [
      student.completion.needsOnboarding ? 'onboarding incomplete' : '',
      student.completion.needsProfile ? `profile: ${student.completion.missingProfileFields.join(', ')}` : '',
    ].filter(Boolean).join(' · ');
    privateReason = formatter;
  } else if (request.kind === 'jobsheet') {
    const audit = await runJobSheetAudit(client, cohort, period.today);
    if (audit.error) throw new Error(audit.error);
    students = audit.results.filter(result => result.status !== 'readable').map(result => ({
      ...result.s, trackerStatus: result.status, trackerError: result.error || '', invalidDateRows: result.invalidDateRows || 0,
    }));
    title = 'Fix or submit your job tracking sheet';
    intro = `Post one public Google Sheet link in <#${cohort.channels.jobTracking}>. Keep a clear Date Applied column; sharing must be Anyone with the link → Viewer.`;
    formatter = student => student.trackerStatus === 'warning'
      ? `${student.invalidDateRows} unrecognized date row(s)`
      : student.trackerStatus;
    privateReason = student => `tracker ${formatter(student)}${student.trackerError ? `: ${student.trackerError}` : ''}`;
  } else if (request.kind === 'attendance') {
    const data = await appsScriptGet(cohort, {
      action: 'absences', start: period.start, end: period.end, guildId: cohort.guildId,
    }, { label: 'Manual attendance follow-up' });
    const byId = new Map(roster.map(student => [student.discordId, student]));
    students = (data.students || []).filter(student =>
      byId.has(String(student.discordId || '')) && Number(student.absentDays || 0) >= request.threshold)
      .map(student => ({ ...byId.get(String(student.discordId)), absentDays: Number(student.absentDays || 0) }));
    title = 'Attendance follow-up';
    intro = `Approved leave (L) is excluded. These students have ${request.threshold}+ blank/absent working day(s) in ${period.start} through ${period.end}.`;
    formatter = student => `${student.absentDays} absent day(s)`;
    privateReason = formatter;
  } else if (request.kind === 'dawn') {
    const data = await appsScriptGet(cohort, {
      action: 'dawnabsences', start: period.start, end: period.end, guildId: cohort.guildId,
    }, { label: 'Manual Dawn follow-up' });
    const byId = new Map(roster.map(student => [student.discordId, student]));
    students = (data.students || []).filter(student =>
      byId.has(String(student.discordId || '')) && Number(student.absentDays || 0) >= request.threshold)
      .map(student => ({ ...byId.get(String(student.discordId)), absentDays: Number(student.absentDays || 0) }));
    title = 'Dawn Focus attendance follow-up';
    intro = `Approved leave is excluded. These Dawn members missed ${request.threshold}+ recorded check-in day(s).`;
    formatter = student => `${student.absentDays} missed Dawn day(s)`;
    privateReason = formatter;
  } else {
    const performance = await appsScriptGet(cohort, {
      action: 'performance', start: period.start, end: period.end,
    }, { label: 'Manual performance follow-up' });
    if (request.kind === 'interview') {
      students = zeroActivityStudents(performance.students, roster, 'interviews');
      title = 'Interview update follow-up';
      intro = `No interview update is recorded for these students from ${period.start} through ${period.end}. Share any received, scheduled, completed, or failed interview update.`;
      privateReason = () => `0 interview updates (${period.start} through ${period.end})`;
    } else if (request.kind === 'jobs' || request.kind === 'outreach') {
      const target = await getNumber(cohort, request.kind === 'jobs' ? 'jobstarget' : 'outreachdaily');
      students = quotaGapStudents({
        students: performance.students, roster, dates: period.dates, target,
        daysKey: request.kind === 'jobs' ? 'jobDays' : 'outreachDays', minMissedDays: request.threshold,
      });
      title = request.kind === 'jobs' ? 'Daily application target follow-up' : 'Daily outreach target follow-up';
      intro = `Target: ${target} per working day. Approved leave dates are excluded. The list shows today’s gap and the remaining gap for the checked period.`;
      formatter = student => `${student.missedDays} day(s) below target · ${student.todayGap} needed today · ${student.weekGap} remaining for period`;
      privateReason = formatter;
    } else if (request.kind === 'communication' || request.kind === 'workshop') {
      const switchName = request.kind === 'communication' ? 'questions' : 'workshop';
      if (!await isOn(cohort, switchName)) throw new Error(`${request.kind} automation is disabled; enable it before checking its participation target`);
      const key = request.kind === 'communication' ? 'weeklycommunication' : 'weeklyworkshops';
      const field = request.kind === 'communication' ? 'communicationPractices' : 'workshops';
      const daysKey = request.kind === 'communication' ? 'communicationDays' : 'workshopDays';
      const target = await getNumber(cohort, key);
      const dailyGaps = quotaGapStudents({
        students: performance.students, roster, dates: period.dates, target: 1,
        daysKey, minMissedDays: request.threshold,
      });
      const weeklyGaps = new Map(targetGapStudents(performance.students, roster, field, target)
        .map(student => [student.discordId, student]));
      students = dailyGaps.map(student => ({
        ...student,
        count: weeklyGaps.get(student.discordId)?.count || 0,
        weeklyTarget: target,
        weeklyGap: weeklyGaps.get(student.discordId)?.gap || 0,
      }));
      title = `${request.kind === 'communication' ? 'Communication practice' : 'Workshop'} follow-up`;
      intro = `Configured weekly target: ${target}. These students have ${request.threshold}+ working day(s) without a recorded activity in ${period.start} through ${period.end}.`;
      formatter = student => `${student.missedDays} no-activity day(s) · weekly ${student.count}/${student.weeklyTarget} · ${student.weeklyGap} remaining`;
      privateReason = formatter;
    }
  }

  return {
    students, title, intro, formatter, components, privateReason,
    period, channelId: request.channelId || defaultChannel(cohort, request.kind),
  };
}

async function sendAnnouncement(client, cohort, built) {
  const channel = await client.channels.fetch(built.channelId);
  if (!channel?.isTextBased() || channel.guildId !== cohort.guildId) throw new Error('Destination must be a text channel in this cohort');
  const head = [`## ${built.title}`, built.intro];
  const lines = mentionLines(built.students, built.formatter);
  const chunks = chunkLines([...head, ...lines], 1850);
  for (let index = 0; index < chunks.length; index++) {
    await channel.send({
      content: chunks[index],
      components: index === chunks.length - 1 ? built.components : [],
      allowedMentions: { users: built.students.map(student => student.discordId) },
    });
  }
  await sendPrivateContactReport(client, cohort, `Private contacts · ${built.title}`, built.students, built.privateReason);
  return channel.id;
}

module.exports = function registerFollowups(client) {
  client.on('messageCreate', async message => {
    if (message.author.bot) return;
    const parsed = parseFollowupCommand(message.content);
    if (!parsed) return;
    const cohort = cohorts.find(item => item.guildId === message.guildId);
    if (!cohort || !cohort.supervisorIds.includes(message.author.id)) return;
    if (message.channelId !== cohort.channels.supervisor) return message.reply(`Run manual follow-ups in <#${cohort.channels.supervisor}>.`);
    if (parsed.action === 'help' || parsed.action.startsWith('invalid')) {
      return message.reply([
        '**Manual follow-up (preview → confirm; scheduled automation is unchanged)**',
        '`!followup <type> [days N] [#channel]`',
        'Types: `dawnjoin`, `jobsheet`, `profile`, `attendance`, `interview`, `jobs`, `outreach`, `dawn`, `communication`, `workshop`.',
        'Examples: `!followup attendance days 2 #warning` · `!followup jobs 3 #emergency`.',
      ].join('\n'));
    }
    try {
      await message.reply('⏳ Building a private preview. No student is being pinged yet.');
      const built = await buildFollowup(client, cohort, parsed, message.guild);
      if (!built.students.length) return message.channel.send('✅ Nobody matches this follow-up filter; nothing was posted.');
      const token = randomBytes(8).toString('hex');
      previews.set(token, {
        ownerId: message.author.id, guildId: cohort.guildId, built, expires: Date.now() + PREVIEW_TTL,
      });
      await message.channel.send({
        content: [
          `**Manual announcement preview · ${built.title}**`,
          `Destination: <#${built.channelId}> · students: **${built.students.length}**`,
          ...previewLines(built.students.slice(0, 30), built.formatter),
          built.students.length > 30 ? `…and ${built.students.length - 30} more` : '',
          '',
          'Confirm sends this once. It does not enable, disable, replace, or reschedule any automation.',
        ].filter(Boolean).join('\n').slice(0, 1950),
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`followup:send:${token}`).setLabel('Send announcement').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`followup:cancel:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        )],
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      await message.reply(`❌ Follow-up preview failed: ${String(error.message).slice(0, 300)}`);
    }
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.isButton() || !interaction.customId.startsWith('followup:')) return;
    const [, action, token] = interaction.customId.split(':');
    const preview = previews.get(token);
    if (!preview || preview.expires < Date.now()) return interaction.reply({ content: 'This preview expired. Run the command again.', ephemeral: true });
    if (preview.ownerId !== interaction.user.id || preview.guildId !== interaction.guildId) {
      return interaction.reply({ content: 'Only the supervisor who created this preview can confirm it.', ephemeral: true });
    }
    previews.delete(token);
    if (action === 'cancel') return interaction.update({ content: 'Cancelled. Nothing was posted.', components: [], allowedMentions: { parse: [] } });
    const cohort = cohorts.find(item => item.guildId === interaction.guildId);
    await interaction.deferReply({ ephemeral: true });
    try {
      const channelId = await sendAnnouncement(client, cohort, preview.built);
      await interaction.editReply(`✅ Manual announcement sent once in <#${channelId}>. Scheduled automation was not changed.`);
    } catch (error) {
      await interaction.editReply(`❌ Announcement failed: ${String(error.message).slice(0, 300)}`);
    }
  });
};

module.exports.buildFollowup = buildFollowup;
module.exports.defaultChannel = defaultChannel;
