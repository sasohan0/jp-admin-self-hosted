'use strict';

// Cohort-local working calendar. Weekly days and date overrides are stored via
// settings.js, so changes are durable and isolated by guild. This gates only
// scheduled automation; manual supervisor commands and live outreach/interview
// message collection remain available on holidays.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { cohorts } = require('./config');
const { getSetting, resolveChannel, setSetting } = require('./settings');

const DAY_MAP = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2,
  wed: 3, wednesday: 3, thu: 4, thursday: 4, fri: 5, friday: 5,
  sat: 6, saturday: 6,
};
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULT_WORKDAYS = Object.freeze([0, 1, 2, 3, 4]);
const WORKDAYS_KEY = 'calendar_workdays';
const OVERRIDES_KEY = 'calendar_overrides';
const MAX_OVERRIDES = 180;
const MAX_CONTEXT = 1200;

function parseCalendarDays(value) {
  const text = String(value || '').toLowerCase().trim();
  if (!text) return null;
  if (/^(every\s*day|all|sun-sat|sunday-saturday)$/i.test(text)) return [...DAY_NAMES.keys()];
  const range = text.match(/^(\w+)\s*[-–]\s*(\w+)$/u);
  if (range) {
    const start = DAY_MAP[range[1]], end = DAY_MAP[range[2]];
    if (start === undefined || end === undefined) return null;
    const days = [];
    let current = start;
    for (;;) {
      days.push(current);
      if (current === end) break;
      current = (current + 1) % 7;
    }
    return [...new Set(days)].sort((a, b) => a - b);
  }
  const parts = text.split(/[,\s]+/).filter(Boolean);
  if (!parts.length || parts.some(part => DAY_MAP[part] === undefined)) return null;
  return [...new Set(parts.map(part => DAY_MAP[part]))].sort((a, b) => a - b);
}

function dateKeyInZone(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDateKey(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function validDateKey(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function resolveDateArgument(value, timeZone, now = new Date()) {
  const text = String(value || '').trim().toLowerCase();
  const today = dateKeyInZone(timeZone, now);
  if (text === 'today') return today;
  if (text === 'tomorrow') return shiftDateKey(today, 1);
  return validDateKey(text) ? text : '';
}

function parseStoredDays(raw) {
  try {
    const parsed = JSON.parse(String(raw || ''));
    if (Array.isArray(parsed) && parsed.length && parsed.every(day => Number.isInteger(day) && day >= 0 && day <= 6)) {
      return [...new Set(parsed)].sort((a, b) => a - b);
    }
  } catch {}
  return [...DEFAULT_WORKDAYS];
}

function parseStoredOverrides(raw) {
  try {
    const parsed = JSON.parse(String(raw || ''));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return {};
    const result = {};
    for (const [date, item] of Object.entries(parsed)) {
      if (!validDateKey(date) || !['holiday', 'working'].includes(item?.type)) continue;
      result[date] = { type: item.type, context: String(item.context || '').trim().slice(0, MAX_CONTEXT) };
    }
    return result;
  } catch { return {}; }
}

function calendarDecision(calendar, dateKey) {
  if (!validDateKey(dateKey)) throw new Error('Calendar date must use YYYY-MM-DD');
  const override = calendar.overrides?.[dateKey];
  if (override) return {
    date: dateKey,
    working: override.type === 'working',
    source: 'override',
    context: override.context || '',
  };
  const weekday = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return { date: dateKey, working: calendar.workdays.includes(weekday), source: 'weekly', context: '' };
}

function pruneOverrides(overrides, today) {
  const oldest = shiftDateKey(today, -35);
  return Object.fromEntries(Object.entries(overrides)
    .filter(([date]) => date >= oldest)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-MAX_OVERRIDES));
}

function previousWorkingDates(calendar, beforeDate, count) {
  const result = [];
  let date = shiftDateKey(beforeDate, -1);
  let scanned = 0;
  while (result.length < count && scanned < 370) {
    if (calendarDecision(calendar, date).working) result.unshift(date);
    date = shiftDateKey(date, -1);
    scanned++;
  }
  return result;
}

async function loadWorkCalendar(cohort) {
  const [workdaysRaw, overridesRaw] = await Promise.all([
    getSetting(cohort, WORKDAYS_KEY), getSetting(cohort, OVERRIDES_KEY),
  ]);
  return { workdays: parseStoredDays(workdaysRaw), overrides: parseStoredOverrides(overridesRaw) };
}

async function getCalendarDay(cohort, now = new Date()) {
  return calendarDecision(await loadWorkCalendar(cohort), dateKeyInZone(cohort.timezone, now));
}

function parseContext(value) {
  const [head, ...rest] = String(value || '').split('|');
  return { head: head.trim(), context: rest.join('|').trim().slice(0, MAX_CONTEXT) };
}

function parseCalendarCommand(value) {
  const text = String(value || '').trim();
  const lower = text.toLowerCase();
  if (lower === '!calendar' || lower === '!calendar status') return { action: 'status' };
  if (lower === '!calendar help') return { action: 'help' };
  for (const [pattern, action] of [
    [/^!holiday\s+(.+)$/i, 'holiday'],
    [/^!workingday\s+(.+)$/i, 'working'],
    [/^!workweek\s+(.+)$/i, 'week'],
  ]) {
    const match = text.match(pattern);
    if (match) return { action, ...parseContext(match[1]) };
  }
  const match = text.match(/^!calendar\s+(week|holiday|working|clear)\s+(.+)$/i);
  if (match) return { action: match[1].toLowerCase(), ...parseContext(match[2]) };
  if (/^!(calendar|holiday|workingday|workweek)(?:\s|$)/i.test(text)) return { action: 'invalid' };
  return null;
}

function formatDays(days) { return days.map(day => DAY_NAMES[day]).join(', '); }
function holidayDays(workdays) { return DAY_NAMES.filter((_, day) => !workdays.includes(day)); }

async function sendCalendarAnnouncement(client, cohort, payload) {
  const channelId = await resolveChannel(cohort, 'channel_discussion', cohort.channels.discussion);
  if (!channelId) throw new Error('Discussion/announcement channel is not configured');
  const channel = await client.channels.fetch(channelId);
  const lines = ['@everyone'];
  if (payload.action === 'week') {
    lines.push(
      `📅 **Regular bootcamp calendar updated — ${cohort.name}**`,
      `Working days: **${formatDays(payload.workdays)}**`,
      `Regular holidays: **${holidayDays(payload.workdays).join(', ') || 'none'}**`,
      'On regular holidays, scheduled reminders and reports stay paused. Outreach, interview, and successfully-hired updates are still recorded when posted.',
    );
  } else if (payload.working) {
    lines.push(
      `✅ **Working day announcement — ${payload.date}**`,
      'This date is a working-day override. Enabled automations still follow their configured switches, times, and feature schedules.',
    );
  } else {
    lines.push(
      `🏖️ **Holiday announcement — ${payload.date}**`,
      'Scheduled reminders, questions, workshops, warnings, leaderboards, and reports are paused for this date.',
      'Students may still post outreach and interview updates, and mentors may post successfully-hired updates. JP ADMIN records them without sending scheduled reports.',
    );
  }
  if (payload.context) lines.push('', `**Details:** ${payload.context}`);
  await channel.send({ content: lines.join('\n').slice(0, 1990), allowedMentions: { parse: ['everyone'] } });
  return channelId;
}

function statusPayload(cohort, calendar, today) {
  const decision = calendarDecision(calendar, today);
  const future = Object.entries(calendar.overrides).filter(([date]) => date >= today)
    .sort(([a], [b]) => a.localeCompare(b)).slice(0, 12)
    .map(([date, item]) => `• **${date}** — ${item.type}${item.context ? ` · ${item.context}` : ''}`);
  return {
    embeds: [{
      title: `📅 Working Calendar — ${cohort.name}`,
      color: decision.working ? 0x2ecc71 : 0xe67e22,
      fields: [
        { name: 'Regular working days', value: formatDays(calendar.workdays), inline: true },
        { name: 'Regular holidays', value: holidayDays(calendar.workdays).join(', ') || 'none', inline: true },
        { name: `Today · ${today}`, value: `${decision.working ? 'Working day' : 'Holiday'} (${decision.source})`, inline: false },
        { name: 'Upcoming overrides', value: future.join('\n').slice(0, 1024) || '— none' },
      ],
      footer: { text: 'Use !calendar help. Manual supervisor commands remain available on holidays.' },
    }],
    allowedMentions: { parse: [] },
  };
}

function calendarDateOptions(calendar, today, count = 25) {
  return Array.from({ length: Math.max(1, Math.min(25, Number(count) || 25)) }, (_, index) => {
    const date = shiftDateKey(today, index);
    const decision = calendarDecision(calendar, date);
    const label = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    }).format(new Date(`${date}T12:00:00Z`));
    return {
      label: index === 0 ? `Today — ${label}` : label,
      value: date,
      description: `${decision.working ? 'Working day' : 'Holiday'} · ${decision.source}`,
    };
  });
}

function calendarPanelPayload(cohort, calendar, today) {
  return {
    ...statusPayload(cohort, calendar, today),
    components: [new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`cal:date:${cohort.guildId}`)
        .setPlaceholder('Select a date to mark holiday or working')
        .addOptions(calendarDateOptions(calendar, today)),
    )],
  };
}

async function applyDateOverride(client, cohort, action, date, context = '') {
  const calendar = await loadWorkCalendar(cohort);
  const today = dateKeyInZone(cohort.timezone);
  const overrides = { ...calendar.overrides };
  if (action === 'clear') delete overrides[date];
  else overrides[date] = { type: action, context: String(context || '').trim().slice(0, MAX_CONTEXT) };
  const cleaned = pruneOverrides(overrides, today);
  await setSetting(cohort, OVERRIDES_KEY, JSON.stringify(cleaned));
  const effective = calendarDecision({ ...calendar, overrides: cleaned }, date);
  const announcementContext = String(context || '').trim() ||
    (action === 'clear' ? 'The date override was removed; the regular weekly calendar applies.' : '');
  const channelId = await sendCalendarAnnouncement(client, cohort, {
    action, date, working: effective.working, context: announcementContext,
  });
  return { effective, channelId };
}

function dateActionPayload(cohort, calendar, date) {
  const decision = calendarDecision(calendar, date);
  return {
    content: `Selected **${date}** — currently **${decision.working ? 'working day' : 'holiday'}** (${decision.source}). Holiday changes pause every scheduled automation/report for that date; live outreach, interview, and hired updates still record.`,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cal:set:holiday:${cohort.guildId}:${date}`)
        .setLabel('Set Holiday').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`cal:set:working:${cohort.guildId}:${date}`)
        .setLabel('Set Working').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`cal:set:clear:${cohort.guildId}:${date}`)
        .setLabel('Clear Override').setStyle(ButtonStyle.Secondary),
    )],
    ephemeral: true,
    allowedMentions: { parse: [] },
  };
}

function calendarContextModal(cohort, action, date) {
  return new ModalBuilder()
    .setCustomId(`cal:modal:${action}:${cohort.guildId}:${date}`)
    .setTitle(`${action === 'holiday' ? 'Holiday' : 'Working day'} · ${date}`)
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('context')
        .setLabel('Announcement details (optional)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(MAX_CONTEXT)
        .setPlaceholder('Reason, session changes, or instructions for students'),
    ));
}

async function handleCalendarCommand(client, message, cohort, command) {
  if (command.action === 'invalid') {
    throw new Error('Use `!calendar help` to see valid calendar commands.');
  }
  if (command.action === 'help') {
    await message.reply({ content: [
      '`!calendar` — show calendar',
      '`!calendar week sun-thu | optional announcement context`',
      '`!calendar holiday YYYY-MM-DD | optional context`',
      '`!calendar working YYYY-MM-DD | optional context`',
      '`!calendar clear YYYY-MM-DD | optional context`',
      'Aliases: `!workweek`, `!holiday`, `!workingday`. Dates may be `today` or `tomorrow`.',
    ].join('\n'), allowedMentions: { parse: [] } });
    return;
  }
  const calendar = await loadWorkCalendar(cohort);
  const today = dateKeyInZone(cohort.timezone);
  if (command.action === 'status') {
    await message.channel.send(calendarPanelPayload(cohort, calendar, today));
    return;
  }
  if (command.action === 'week') {
    const workdays = parseCalendarDays(command.head);
    if (!workdays?.length) throw new Error('Working days must be like `sun-thu`, `mon,wed,fri`, or `everyday`.');
    await setSetting(cohort, WORKDAYS_KEY, JSON.stringify(workdays));
    const channelId = await sendCalendarAnnouncement(client, cohort, { action: 'week', workdays, context: command.context });
    await message.reply({ content: `✅ Calendar saved and announced in <#${channelId}>. Working days: **${formatDays(workdays)}**.`, allowedMentions: { parse: [] } });
    return;
  }
  const date = resolveDateArgument(command.head, cohort.timezone);
  if (!date) throw new Error('Use a real `YYYY-MM-DD` date, `today`, or `tomorrow`.');
  const result = await applyDateOverride(client, cohort, command.action, date, command.context);
  await message.reply({ content: `✅ **${date}** is now ${result.effective.working ? 'a working day' : 'a holiday'} and was announced in <#${result.channelId}>.`, allowedMentions: { parse: [] } });
}

module.exports = function registerWorkCalendar(client) {
  client.on('messageCreate', async message => {
    if (message.author.bot) return;
    const command = parseCalendarCommand(message.content);
    if (!command) return;
    const cohort = cohorts.find(item => item.guildId === message.guildId);
    if (!cohort?.supervisorIds?.includes(message.author.id)) return;
    if (message.channelId !== cohort.channels.supervisor) {
      await message.reply({ content: `Run calendar commands in <#${cohort.channels.supervisor}>.`, allowedMentions: { parse: [] } });
      return;
    }
    try { await handleCalendarCommand(client, message, cohort, command); }
    catch (err) { await message.reply({ content: `❌ Calendar update failed: ${String(err.message).slice(0, 500)}`, allowedMentions: { parse: [] } }); }
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.customId?.startsWith('cal:')) return;
    const parts = interaction.customId.split(':');
    const guildId = ['open', 'date'].includes(parts[1]) ? parts[2]
      : ['set', 'modal'].includes(parts[1]) ? parts[3]
        : '';
    const cohort = cohorts.find(item => item.guildId === guildId);
    if (!cohort || interaction.guildId !== guildId ||
        !cohort.supervisorIds.includes(interaction.user.id) ||
        interaction.channelId !== cohort.channels.supervisor) {
      await interaction.reply({
        content: 'Calendar controls are private to configured supervisors in #bot-admin.',
        ephemeral: true,
      }).catch(() => {});
      return;
    }
    try {
      if (parts[1] === 'open' && interaction.isButton()) {
        const today = dateKeyInZone(cohort.timezone);
        await interaction.reply({
          ...(calendarPanelPayload(cohort, await loadWorkCalendar(cohort), today)),
          ephemeral: true,
        });
        return;
      }
      if (parts[1] === 'date' && interaction.isStringSelectMenu()) {
        const date = interaction.values[0];
        if (!validDateKey(date)) throw new Error('The selected date is invalid.');
        await interaction.reply(dateActionPayload(cohort, await loadWorkCalendar(cohort), date));
        return;
      }
      if (parts[1] === 'set' && interaction.isButton()) {
        const action = parts[2];
        const date = parts[4];
        if (!['holiday', 'working', 'clear'].includes(action) || !validDateKey(date)) {
          throw new Error('That calendar action is invalid or expired.');
        }
        if (action !== 'clear') {
          await interaction.showModal(calendarContextModal(cohort, action, date));
          return;
        }
        await interaction.deferUpdate();
        const result = await applyDateOverride(client, cohort, action, date, '');
        await interaction.editReply({
          content: `**${date}** now follows the regular calendar: **${result.effective.working ? 'working day' : 'holiday'}**. Announcement sent in <#${result.channelId}>.`,
          components: [],
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (parts[1] === 'modal' && interaction.isModalSubmit()) {
        const action = parts[2];
        const date = parts[4];
        if (!['holiday', 'working'].includes(action) || !validDateKey(date)) {
          throw new Error('That calendar action is invalid or expired.');
        }
        await interaction.deferReply({ ephemeral: true });
        const context = interaction.fields.getTextInputValue('context');
        const result = await applyDateOverride(client, cohort, action, date, context);
        await interaction.editReply({
          content: `**${date}** is now **${result.effective.working ? 'a working day' : 'a holiday'}**. Announcement sent in <#${result.channelId}>.`,
          allowedMentions: { parse: [] },
        });
      }
    } catch (error) {
      const payload = {
        content: `Calendar control failed: ${String(error.message).slice(0, 300)}`,
        ephemeral: true,
      };
      if (interaction.replied || interaction.deferred) await interaction.editReply(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  });
};

module.exports.DEFAULT_WORKDAYS = DEFAULT_WORKDAYS;
module.exports.OVERRIDES_KEY = OVERRIDES_KEY;
module.exports.WORKDAYS_KEY = WORKDAYS_KEY;
module.exports.calendarDecision = calendarDecision;
module.exports.calendarDateOptions = calendarDateOptions;
module.exports.calendarPanelPayload = calendarPanelPayload;
module.exports.dateKeyInZone = dateKeyInZone;
module.exports.formatDays = formatDays;
module.exports.getCalendarDay = getCalendarDay;
module.exports.loadWorkCalendar = loadWorkCalendar;
module.exports.parseCalendarCommand = parseCalendarCommand;
module.exports.parseCalendarDays = parseCalendarDays;
module.exports.parseStoredDays = parseStoredDays;
module.exports.parseStoredOverrides = parseStoredOverrides;
module.exports.pruneOverrides = pruneOverrides;
module.exports.previousWorkingDates = previousWorkingDates;
module.exports.resolveDateArgument = resolveDateArgument;
module.exports.shiftDateKey = shiftDateKey;
module.exports.statusPayload = statusPayload;
module.exports.validDateKey = validDateKey;
