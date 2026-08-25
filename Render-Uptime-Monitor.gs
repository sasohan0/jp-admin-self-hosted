/**
 * Scheduled Render wake-up monitor for the unified JP ADMIN web service.
 *
 * Install this file only in the protected control cohort's Apps Script
 * project. `!backend ...` stores the schedule in ScriptProperties and ensures
 * exactly one five-minute trigger exists. The monitor begins pinging ten
 * minutes before an active window so Render can wake before Discord login.
 *
 * This file contains public health URLs only. Never add tokens or API keys.
 */

const RENDER_UPTIME_CONFIG = Object.freeze({
  version: 'v4',
  timeZone: 'Asia/Dhaka',
  intervalMinutes: 5,
  wakeLeadMinutes: 10,
  fallbackWindows: Object.freeze([{ start: '04:50', end: '23:30' }]),
  urls: Object.freeze([
    'https://jp-admin-stride.onrender.com/',
  ]),
});

const RENDER_UPTIME_HANDLER = 'pingRenderServicesOnSchedule_';
const RENDER_UPTIME_SCHEDULE_PROPERTY = 'JP_RENDER_UPTIME_SCHEDULE_V1';
const RENDER_UPTIME_DAY_NAMES = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);

function installRenderUptimeMonitor() {
  validateRenderUptimeConfig_();
  removeRenderUptimeMonitor();
  ScriptApp.newTrigger(RENDER_UPTIME_HANDLER)
    .timeBased()
    .everyMinutes(RENDER_UPTIME_CONFIG.intervalMinutes)
    .create();
  const result = {
    installed: true,
    status: getRenderUptimeStatus(),
    immediateTest: testRenderUptimeNow(),
  };
  console.log(JSON.stringify(result));
  return result;
}

function removeRenderUptimeMonitor() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === RENDER_UPTIME_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
      removed += 1;
    }
  });
  return { removed: removed };
}

function defaultRenderMonitorSchedule_() {
  return {
    version: 1,
    timezone: RENDER_UPTIME_CONFIG.timeZone,
    windows: RENDER_UPTIME_CONFIG.fallbackWindows.slice(),
    days: [0, 1, 2, 3, 4, 5, 6],
    dates: [],
    overrides: {},
    wakeLeadMinutes: RENDER_UPTIME_CONFIG.wakeLeadMinutes,
  };
}

function renderMonitorClockMinutes_(value) {
  const match = String(value || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) throw new Error('Invalid backend uptime clock: ' + value);
  return Number(match[1]) * 60 + Number(match[2]);
}

function normalizeRenderMonitorSchedule_(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const fallback = defaultRenderMonitorSchedule_();
  const windows = Array.isArray(source.windows) && source.windows.length
    ? source.windows.slice(0, 4).map(function (item) {
        const start = String(item && item.start || '');
        const end = String(item && item.end || '');
        renderMonitorClockMinutes_(start);
        renderMonitorClockMinutes_(end);
        if (start === end) throw new Error('Backend uptime window start and end cannot match');
        return { start: start, end: end };
      })
    : fallback.windows;
  const days = Array.isArray(source.days) && source.days.length
    ? source.days.filter(function (day, index, all) {
        return Number.isInteger(day) && day >= 0 && day <= 6 && all.indexOf(day) === index;
      }).sort()
    : fallback.days;
  const dates = Array.isArray(source.dates)
    ? source.dates.map(String).filter(renderMonitorValidDate_).filter(function (date, index, all) {
        return all.indexOf(date) === index;
      }).sort()
    : [];
  const overrides = {};
  if (source.overrides && typeof source.overrides === 'object' && !Array.isArray(source.overrides)) {
    Object.keys(source.overrides).forEach(function (date) {
      const state = String(source.overrides[date]);
      if (renderMonitorValidDate_(date) && (state === 'on' || state === 'off')) overrides[date] = state;
    });
  }
  return {
    version: 1,
    timezone: String(source.timezone || fallback.timezone),
    windows: windows,
    days: days,
    dates: dates,
    overrides: overrides,
    wakeLeadMinutes: RENDER_UPTIME_CONFIG.wakeLeadMinutes,
  };
}

function renderMonitorValidDate_(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(text + 'T00:00:00Z');
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function getRenderMonitorSchedule_() {
  const raw = PropertiesService.getScriptProperties().getProperty(RENDER_UPTIME_SCHEDULE_PROPERTY);
  if (!raw) return defaultRenderMonitorSchedule_();
  return normalizeRenderMonitorSchedule_(JSON.parse(raw));
}

function renderMonitorLocalParts_(date, timezone) {
  const dateKey = Utilities.formatDate(date, timezone, 'yyyy-MM-dd');
  const dayName = Utilities.formatDate(date, timezone, 'EEE');
  const time = Utilities.formatDate(date, timezone, 'HH:mm');
  return {
    date: dateKey,
    day: RENDER_UPTIME_DAY_NAMES.indexOf(dayName),
    minutes: renderMonitorClockMinutes_(time),
  };
}

function renderMonitorMinuteInWindow_(minutes, window) {
  const start = renderMonitorClockMinutes_(window.start);
  const end = renderMonitorClockMinutes_(window.end);
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function isRenderScheduleActive_(date, scheduleValue, leadMinutes) {
  const schedule = normalizeRenderMonitorSchedule_(scheduleValue);
  const shifted = new Date(date.getTime() + Number(leadMinutes || 0) * 60000);
  const local = renderMonitorLocalParts_(shifted, schedule.timezone);
  const override = schedule.overrides[local.date];
  const dateAllowed = override === 'on' || (override !== 'off' && (
    schedule.dates.length ? schedule.dates.indexOf(local.date) !== -1 : schedule.days.indexOf(local.day) !== -1
  ));
  return dateAllowed && schedule.windows.some(function (window) {
    return renderMonitorMinuteInWindow_(local.minutes, window);
  });
}

function getRenderUptimeStatus() {
  const now = new Date();
  const schedule = getRenderMonitorSchedule_();
  const triggerCount = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === RENDER_UPTIME_HANDLER;
  }).length;
  return {
    version: RENDER_UPTIME_CONFIG.version,
    timeZone: schedule.timezone,
    windows: schedule.windows,
    days: schedule.days,
    dates: schedule.dates,
    overrides: schedule.overrides,
    wakeLeadMinutes: schedule.wakeLeadMinutes,
    intervalMinutes: RENDER_UPTIME_CONFIG.intervalMinutes,
    urls: RENDER_UPTIME_CONFIG.urls.slice(),
    triggerCount: triggerCount,
    activeNow: isRenderScheduleActive_(now, schedule, 0),
    wakeActiveNow: isRenderScheduleActive_(now, schedule, 0) ||
      isRenderScheduleActive_(now, schedule, schedule.wakeLeadMinutes),
    checkedAt: Utilities.formatDate(now, schedule.timezone, "yyyy-MM-dd'T'HH:mm:ssXXX"),
  };
}

function pingRenderServicesOnSchedule_() {
  const now = new Date();
  const schedule = getRenderMonitorSchedule_();
  const shouldPing = isRenderScheduleActive_(now, schedule, 0) ||
    isRenderScheduleActive_(now, schedule, schedule.wakeLeadMinutes);
  if (!shouldPing) return { skipped: true };
  return fetchRenderHealthUrls_(now, schedule.timezone);
}

function testRenderUptimeNow() {
  validateRenderUptimeConfig_();
  return fetchRenderHealthUrls_(new Date(), getRenderMonitorSchedule_().timezone);
}

function fetchRenderHealthUrls_(now, timezone) {
  const stamp = now.getTime();
  const requests = RENDER_UPTIME_CONFIG.urls.map(function (url) {
    return {
      url: url + (url.indexOf('?') !== -1 ? '&' : '?') + 'uptime=apps-script&ts=' + stamp,
      method: 'get', followRedirects: true, muteHttpExceptions: true,
    };
  });
  const responses = UrlFetchApp.fetchAll(requests);
  const results = responses.map(function (response, index) {
    const status = response.getResponseCode();
    return { url: RENDER_UPTIME_CONFIG.urls[index], status: status, ok: status >= 200 && status < 300 };
  });
  const report = {
    checkedAt: Utilities.formatDate(now, timezone, "yyyy-MM-dd'T'HH:mm:ssXXX"),
    results: results,
  };
  console.log(JSON.stringify(report));
  return report;
}

function validateRenderUptimeConfig_() {
  if ([1, 5, 10, 15, 30].indexOf(RENDER_UPTIME_CONFIG.intervalMinutes) === -1) {
    throw new Error('Apps Script only supports 1, 5, 10, 15, or 30 minute trigger intervals.');
  }
  if (!RENDER_UPTIME_CONFIG.urls.length) throw new Error('At least one Render health URL is required.');
  RENDER_UPTIME_CONFIG.urls.forEach(function (url) {
    if (!/^https:\/\/[a-z0-9.-]+\.onrender\.com\/?(?:\?.*)?$/i.test(url)) {
      throw new Error('Invalid Render health URL: ' + url);
    }
  });
}
