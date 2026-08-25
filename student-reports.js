const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  UserSelectMenuBuilder,
} = require('discord.js');
const { cohorts } = require('./config');
const { contactMarkdown } = require('./contact');
const { chunkLines } = require('./message-chunks');
const { getRoster, isExcluded } = require('./roster');
const { rankWeeklyStudents } = require('./weekly-ranking');
const { getWeeklyTargets, progress, targetSummaryLine } = require('./weekly-targets');
const { appsScriptGet } = require('./apps-script-api');

async function api(cohort, params) {
  return appsScriptGet(cohort, params, { label: 'Student report read' });
}

function metricLine(student, position, targets = {}) {
  const review = student.attentionReasons?.length ? ` | **Review:** ${student.attentionReasons.join('; ')}` : '';
  return `**${position}. ${student.name}** — Apps ${progress(student.jobs, targets.applications)} | Attendance ${progress(student.attendance, targets.attendance)} | Interviews ${progress(student.interviews, targets.interviews)} | Outreach ${progress(student.outreach, targets.outreach)} | Communication ${progress(student.communicationPractices, targets.communicationPractices)} | Workshops ${progress(student.workshops, targets.workshops)}${review} | ${contactMarkdown(student.phone)}`;
}

function attentionReasons(student, targets) {
  const jobs = Number(student.jobs) || 0;
  const attendance = Number(student.attendance) || 0;
  const expectedJobs = Math.max(0, Number(targets?.applications) || 0);
  const expectedAttendance = Math.max(0, Number(targets?.attendance) || 0);
  const reasons = [];
  if (expectedJobs && jobs === 0) reasons.push('no applications recorded');
  else if (expectedJobs && jobs < Math.ceil(expectedJobs * 0.5)) reasons.push(`applications below 50% of the ${expectedJobs} scheduled target`);
  if (expectedAttendance && attendance === 0) reasons.push('no attendance recorded');
  else if (expectedAttendance && attendance < Math.ceil(expectedAttendance * 0.5)) reasons.push(`attendance below 50% of the ${expectedAttendance} weekly target`);
  return reasons;
}

function filterStudentsNeedingAttention(students, targets) {
  return students.map(student => ({
    ...student,
    attentionReasons: attentionReasons(student, targets),
  })).filter(student => student.attentionReasons.length > 0);
}

async function sendAllReport(channel, cohort, needsAttention = false) {
  const [data, roster] = await Promise.all([
    api(cohort, { action: 'performance', days: 7 }),
    getRoster(cohort, true),
  ]);
  const targets = await getWeeklyTargets(cohort, { start: data.start, end: data.end });
  const activeEmails = new Set(roster.filter(student => !isExcluded(cohort, student)).map(student => student.email));
  let students = rankWeeklyStudents((data.students || []).filter(student => activeEmails.has(student.email)));
  if (needsAttention) {
    students = filterStudentsNeedingAttention(students, targets);
  }
  const title = needsAttention ? '⚠️ Students needing supervisor review' : '📋 All-student private performance report';
  await channel.send({
    embeds: [{
      title,
      description: `Period: **${data.start} to ${data.end}** · ${students.length} active student(s)${needsAttention ? ' · review rule: applications or attendance below 50% of their configured primary target' : ''}\n${targetSummaryLine(targets)}`,
      color: needsAttention ? 0xe67e22 : 0x3498db,
      footer: { text: 'Private bot-admin report. Contact information must not be reposted publicly.' },
    }],
  });
  const lines = students.map((student, index) => metricLine(student, index + 1, targets));
  if (!lines.length) {
    await channel.send({ content: 'No students matched this report.', allowedMentions: { parse: [] } });
    return;
  }
  for (const chunk of chunkLines(lines, 1900)) {
    await channel.send({
      content: chunk,
      allowedMentions: { parse: [] },
      flags: MessageFlags.SuppressEmbeds,
    });
  }
}

async function sendOneReport(channel, cohort, discordId) {
  const roster = await getRoster(cohort, true);
  const rosterStudent = roster.find(student => student.discordId === discordId);
  if (!rosterStudent) {
    await channel.send({ content: `No roster student is linked to <@${discordId}>. Run \`!syncmembers\` or \`!addstudent\` first.`, allowedMentions: { parse: [] } });
    return;
  }
  const data = await api(cohort, { action: 'performance', days: 7, email: rosterStudent.email, includeHistory: 1 });
  const targets = await getWeeklyTargets(cohort, { start: data.start, end: data.end });
  const student = data.students?.[0];
  if (!student) {
    await channel.send(`No performance record was found for **${rosterStudent.name}**.`);
    return;
  }
  const history = (student.interviewHistory || []).map(interview => {
    const date = interview.interviewDate || interview.loggedDate || 'date not supplied';
    const company = interview.company || 'company not supplied';
    const role = interview.role ? ` · ${interview.role}` : '';
    const details = interview.details ? ` · ${interview.details}` : '';
    const link = interview.messageUrl ? ` · [Discord message](${interview.messageUrl})` : '';
    return `#${interview.serial} · ${date} · **${company}**${role}${details}${link}`;
  });
  await channel.send({
    embeds: [{
      title: `👤 Student Performance — ${student.name}`,
      color: 0x5865f2,
      fields: [
        { name: 'Period', value: `${data.start} to ${data.end}`, inline: true },
        { name: 'Applications', value: progress(student.jobs, targets.applications), inline: true },
        { name: 'Attendance', value: progress(student.attendance, targets.attendance), inline: true },
        { name: 'Interviews', value: progress(student.interviews, targets.interviews), inline: true },
        { name: 'Outreach', value: progress(student.outreach, targets.outreach), inline: true },
        { name: 'Communication', value: progress(student.communicationPractices, targets.communicationPractices), inline: true },
        { name: 'Workshops', value: progress(student.workshops, targets.workshops), inline: true },
        { name: 'Contact', value: contactMarkdown(student.phone), inline: false },
      ],
      footer: { text: 'Private bot-admin report. Interview count above covers the selected seven-day period.' },
    }],
  });
  if (history.length) {
    await channel.send({ content: '**Complete interview history**', allowedMentions: { parse: [] } });
    for (const chunk of chunkLines(history, 1900)) {
      await channel.send({ content: chunk, allowedMentions: { parse: [] } });
    }
  } else {
    await channel.send({ content: 'No interview history is recorded for this student yet.', allowedMentions: { parse: [] } });
  }
}

function reportPanel() {
  return {
    embeds: [{
      title: '📊 Supervisor Performance Reports',
      description: 'Select one student below, or request the complete cohort / needs-attention report. Contact details stay in this private channel.',
      color: 0x5865f2,
    }],
    components: [
      new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId('student_report_one')
          .setPlaceholder('Choose one student')
          .setMinValues(1)
          .setMaxValues(1)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('student_report_all').setLabel('All students').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('student_report_attention').setLabel('Needs attention').setStyle(ButtonStyle.Danger)
      ),
    ],
  };
}

module.exports = function registerStudentReports(client) {
  client.on('messageCreate', async msg => {
    if (msg.author.bot || msg.content.trim().toLowerCase() !== '!studentreport') return;
    const cohort = cohorts.find(candidate => candidate.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;
    if (msg.channelId !== cohort.channels.supervisor) {
      await msg.reply(`Run this private command in <#${cohort.channels.supervisor}>.`);
      return;
    }
    await msg.channel.send(reportPanel());
  });

  client.on('interactionCreate', async interaction => {
    const valid = interaction.isButton() || interaction.isUserSelectMenu();
    if (!valid || !interaction.customId.startsWith('student_report_')) return;
    const cohort = cohorts.find(candidate => candidate.guildId === interaction.guildId);
    if (!cohort || !cohort.supervisorIds.includes(interaction.user.id) || interaction.channelId !== cohort.channels.supervisor) {
      await interaction.reply({ content: 'This private report is available only to configured supervisors in #bot-admin.', ephemeral: true }).catch(() => {});
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      if (interaction.customId === 'student_report_one') {
        await sendOneReport(interaction.channel, cohort, interaction.values[0]);
      } else {
        await sendAllReport(interaction.channel, cohort, interaction.customId === 'student_report_attention');
      }
      await interaction.editReply('✅ Private report posted in #bot-admin.');
    } catch (err) {
      console.error(`[student-reports] ${cohort.name} failed:`, err.message);
      await interaction.editReply(`❌ Report failed: ${err.message.slice(0, 300)}`);
    }
  });
};

module.exports.metricLine = metricLine;
module.exports.attentionReasons = attentionReasons;
module.exports.filterStudentsNeedingAttention = filterStudentsNeedingAttention;
module.exports.reportPanel = reportPanel;
