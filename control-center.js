// Cohort-local supervisor control overview. This does not own state; it
// presents the existing switch, target, clock, day, student, and cohort
// commands in one private place.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { cohorts } = require('./config');
const { isOn, KEYS } = require('./automations');
const { DEFAULT_DAYS, SCHEDULE_KEYS, formatDays, getScheduleRaw } = require('./scheduler');
const { TIMES, getSetting, targetSummary } = require('./settings');
const { formatDays: formatCalendarDays, getCalendarDay, loadWorkCalendar } = require('./work-calendar');

function fieldChunks(name, lines, limit = 1024) {
  const fields = [];
  let current = '';
  for (const line of lines) {
    if (current && current.length + line.length + 1 > limit) {
      fields.push({ name: fields.length ? `${name} (continued)` : name, value: current });
      current = '';
    }
    current += `${current ? '\n' : ''}${line}`;
  }
  if (current) fields.push({ name: fields.length ? `${name} (continued)` : name, value: current });
  return fields;
}

async function controlSnapshot(cohort) {
  const switches = [];
  for (const [key, label] of Object.entries(KEYS)) {
    switches.push({ key, label, on: await isOn(cohort, key) });
  }
  const times = [];
  for (const [name, item] of Object.entries(TIMES)) {
    times.push({ name, label: item.label, value: await getSetting(cohort, item.key) });
  }
  const schedules = [];
  for (const key of SCHEDULE_KEYS) {
    const raw = await getScheduleRaw(cohort, key);
    const shown = raw || (DEFAULT_DAYS[key] ? JSON.stringify(DEFAULT_DAYS[key]) : '');
    schedules.push({ key, days: formatDays(shown) });
  }
  const [calendar, calendarToday, targets] = await Promise.all([
    loadWorkCalendar(cohort), getCalendarDay(cohort), targetSummary(cohort),
  ]);
  return { switches, times, schedules, targets, calendar, calendarToday };
}

module.exports = function registerControlCenter(client) {
  client.on('messageCreate', async msg => {
    if (msg.author.bot || !['!control', '!automationconfig'].includes(msg.content.trim().toLowerCase())) return;
    const cohort = cohorts.find(item => item.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;
    if (msg.channelId !== cohort.channels.supervisor) {
      await msg.reply(`Run the control center in <#${cohort.channels.supervisor}>.`);
      return;
    }
    try {
      const snapshot = await controlSnapshot(cohort);
      const fields = [
        { name: 'Working calendar', value: `Regular: **${formatCalendarDays(snapshot.calendar.workdays)}** · Today: **${snapshot.calendarToday.working ? 'working day' : 'holiday'}** (${snapshot.calendarToday.source})` },
        ...fieldChunks('Switches', snapshot.switches.map(item =>
          `${item.on ? '🟢' : '🔴'} \`${item.key}\` — ${item.label}`)),
        ...fieldChunks('Performance targets', snapshot.targets.map(item =>
          `\`${item.name}\` **${item.value}** ${item.cadence}`)),
        ...fieldChunks('Clock times', snapshot.times.map(item =>
          `\`${item.name}\` **${item.value}** — ${item.label}`)),
        ...fieldChunks('Scheduled days', snapshot.schedules.map(item =>
          `\`${item.key}\` **${item.days}**`)),
      ];
      await msg.channel.send({
        embeds: [{
          title: `🎛 ${cohort.name} — Automation Control Center`,
          color: 0x5865f2,
          fields,
          footer: { text: `All values belong only to ${cohort.name} · ${cohort.timezone}` },
        }],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('qctl:open').setLabel('Question Schedule').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('wctl:open').setLabel('Workshop Control').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`cal:open:${cohort.guildId}`).setLabel('Calendar & Holidays').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`cmdcenter:open:${cohort.guildId}`).setLabel('Command Center').setStyle(ButtonStyle.Secondary),
        )],
        allowedMentions: { parse: [] },
      });
      await msg.channel.send({
        embeds: [{
          title: 'Command shortcuts',
          color: 0x2ecc71,
          fields: [
            {
              name: 'Automations and goals',
              value: [
                '`!automation start|stop <key|all>`',
                '`!target applications 10` · `!target outreach 3`',
                '`!time jobs 22:30` · `!time outreach 20:00`',
                '`!time outreachprompt 06:00` · `!time interviewprompt 06:00`',
                '`!schedule jobs sun-thu` · `!schedule workshop everyday`',
                '`!questions` · `!workshop` — clickable schedule controls',
                '`!set rtbrdays 7` · `!set rtbrtop 10`',
              ].join('\n'),
            },
            {
              name: 'Students',
              value: [
                '`!syncmembers` · `!addstudent email@example.com @student` · `!calendar`',
                '`!studentstatus @student active|inactive` · `!inactivestudents`',
                '`!active top 15` · `!inactive days 5` · `!calllist`',
                '`!studentsurvey incomplete` — private missing-data dashboard',
                '`!studentsurvey attention 3` — preview incomplete students with no job activity',
                '`!studentsurvey attention 3 send` — send their private profile surveys',
                '`!profilesurvey #channel` — public mention, private answers',
              ].join('\n'),
            },
            {
              name: 'Cohort lifecycle',
              value: '`!cohorts` opens the private Add / Update / Retire manager. `!supervisor list|add @user|remove @user` manages this server only. Each cohort keeps independent Sheet credentials, settings, channels, students, and reports.',
            },
          ],
        }],
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      await msg.reply(`Control center failed: ${error.message.slice(0, 300)}`);
    }
  });
};

module.exports.controlSnapshot = controlSnapshot;
module.exports.fieldChunks = fieldChunks;
