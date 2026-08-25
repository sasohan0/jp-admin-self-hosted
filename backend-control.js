'use strict';

const { cohorts } = require('./config');
const { appsScriptGet, appsScriptPost } = require('./apps-script-api');
const { controlCohort } = require('./managed-cohorts');
const {
  formatSchedule, normalizeSchedule, parseBackendCommand,
} = require('./backend-schedule');

let operatingController = null;

function setOperatingController(controller) {
  operatingController = controller || null;
}

function backendControlCohort() {
  return controlCohort();
}

function isGlobalBackendSupervisor(userId) {
  return cohorts.length > 0 && cohorts.every(cohort => cohort.supervisorIds.includes(String(userId)));
}

function isBackendControlContext(msg) {
  const control = backendControlCohort();
  return Boolean(control
    && msg.guildId === control.guildId
    && msg.channelId === control.channels.supervisor
    && isGlobalBackendSupervisor(msg.author.id));
}

async function readBackendSchedule() {
  const control = backendControlCohort();
  if (!control) throw new Error('COHORT_CONTROL_KEY is required for the global backend schedule');
  const data = await appsScriptGet(control, { action: 'renderUptimeSchedule' }, {
    label: 'Backend uptime schedule read', timeoutMs: 15000,
  });
  return normalizeSchedule(data.schedule || {});
}

async function writeBackendSchedule(scheduleValue) {
  const control = backendControlCohort();
  if (!control) throw new Error('COHORT_CONTROL_KEY is required for the global backend schedule');
  const schedule = normalizeSchedule({ ...scheduleValue, timezone: control.timezone });
  const data = await appsScriptPost(control, {
    action: 'setRenderUptimeSchedule', schedule,
  }, {
    idempotent: true, label: 'Backend uptime schedule write', timeoutMs: 20000,
  });
  return {
    schedule: normalizeSchedule(data.schedule || schedule),
    triggerCount: Number(data.triggerCount || 0),
  };
}

function applyScheduleCommand(scheduleValue, command, timezone) {
  const schedule = normalizeSchedule({ ...scheduleValue, timezone });
  if (command.action === 'windows') schedule.windows = command.windows;
  if (command.action === 'days') {
    schedule.days = command.days;
    schedule.dates = [];
  }
  if (command.action === 'dates') schedule.dates = command.dates;
  if (command.action === 'date') {
    const overrides = { ...schedule.overrides };
    if (command.state === 'clear') delete overrides[command.date];
    else overrides[command.date] = command.state;
    schedule.overrides = overrides;
  }
  return normalizeSchedule(schedule);
}

function schedulePayload(scheduleValue, triggerCount) {
  const schedule = normalizeSchedule(scheduleValue);
  const shown = formatSchedule(schedule);
  const trigger = triggerCount === undefined
    ? ''
    : `\nMonitor trigger: **${triggerCount === 1 ? 'ready (one trigger)' : `${triggerCount} found`}**`;
  return {
    embeds: [{
      title: 'Unified backend active schedule',
      color: 0x2f80ed,
      description: [
        `Timezone: **${schedule.timezone}**`,
        `Active window${schedule.windows.length === 1 ? '' : 's'}: **${shown.windows}**`,
        `Regular days: **${shown.days}**`,
        `Exact-date mode: **${shown.dates}**`,
        `Date overrides: **${shown.overrides}**${trigger}`,
        '',
        'The Apps Script monitor wakes Render 10 minutes before each window. The HTTP health page stays available; Discord connects only inside the configured schedule.',
      ].join('\n'),
      footer: { text: 'Global setting — it affects every active cohort on this one Render service.' },
    }],
    allowedMentions: { parse: [] },
  };
}

function helpPayload() {
  return {
    embeds: [{
      title: 'Backend schedule commands',
      color: 0x5865f2,
      description: [
        '`!backend` — show the current global schedule',
        '`!backend windows 04:00-23:00` — one daily window',
        '`!backend windows 04:00-14:00,17:00-23:00` — split daily windows',
        '`!backend days everyday` — Sunday through Saturday',
        '`!backend days weekdays` — Sunday through Thursday',
        '`!backend days mon,wed,fri` — custom repeating weekdays',
        '`!backend dates 2026-08-15,2026-08-20` — run only on exact dates',
        '`!backend dates clear` — return to the saved repeating weekdays',
        '`!backend date 2026-08-15 on` — force one date on',
        '`!backend date 2026-08-15 off` — force one date off',
        '`!backend date 2026-08-15 clear` — remove that override',
      ].join('\n'),
      footer: { text: 'Use only in the protected control cohort’s private #bot-admin.' },
    }],
    allowedMentions: { parse: [] },
  };
}

module.exports = function registerBackendControl(client) {
  client.on('messageCreate', async msg => {
    if (msg.author.bot || !/^!backend(?:\s|$)/i.test(msg.content.trim())) return;
    if (!isBackendControlContext(msg)) return;

    let command;
    try { command = parseBackendCommand(msg.content); }
    catch (err) {
      await msg.reply({ content: `❌ ${err.message}`, allowedMentions: { parse: [] } });
      return;
    }

    try {
      if (command.action === 'help') {
        await msg.channel.send(helpPayload());
        return;
      }
      const current = await readBackendSchedule();
      if (command.action === 'status') {
        await msg.channel.send(schedulePayload(current));
        return;
      }
      const control = backendControlCohort();
      const next = applyScheduleCommand(current, command, control.timezone);
      const saved = await writeBackendSchedule(next);
      await msg.channel.send(schedulePayload(saved.schedule, saved.triggerCount));
      if (operatingController?.setSchedule) await operatingController.setSchedule(saved.schedule);
    } catch (err) {
      await msg.reply({
        content: `❌ Could not update the backend schedule: ${String(err.message || err).slice(0, 300)}`,
        allowedMentions: { parse: [] },
      });
    }
  });
};

module.exports.applyScheduleCommand = applyScheduleCommand;
module.exports.backendControlCohort = backendControlCohort;
module.exports.helpPayload = helpPayload;
module.exports.isBackendControlContext = isBackendControlContext;
module.exports.isGlobalBackendSupervisor = isGlobalBackendSupervisor;
module.exports.readBackendSchedule = readBackendSchedule;
module.exports.schedulePayload = schedulePayload;
module.exports.setOperatingController = setOperatingController;
module.exports.writeBackendSchedule = writeBackendSchedule;
