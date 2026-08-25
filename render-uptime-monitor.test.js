'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'Render-Uptime-Monitor.gs'), 'utf8');
const context = {
  Utilities: {
    formatDate(date, timezone, format) {
      const options = { timeZone: timezone };
      if (format === 'yyyy-MM-dd') Object.assign(options, { year: 'numeric', month: '2-digit', day: '2-digit' });
      if (format === 'EEE') options.weekday = 'short';
      if (format === 'HH:mm') Object.assign(options, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      const parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(date);
      const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
      if (format === 'yyyy-MM-dd') return `${values.year}-${values.month}-${values.day}`;
      if (format === 'EEE') return values.weekday;
      if (format === 'HH:mm') return `${values.hour}:${values.minute}`;
      throw new Error(`Unsupported test format ${format}`);
    },
  },
};
vm.runInNewContext(
  `${source}\nthis.__uptimeTest = { RENDER_UPTIME_CONFIG, isRenderScheduleActive_, normalizeRenderMonitorSchedule_ };`,
  context,
  { filename: 'Render-Uptime-Monitor.gs' },
);

const {
  RENDER_UPTIME_CONFIG, isRenderScheduleActive_, normalizeRenderMonitorSchedule_,
} = context.__uptimeTest;

test('scheduled uptime uses only the unified Render service every five minutes', () => {
  assert.equal(RENDER_UPTIME_CONFIG.version, 'v4');
  assert.equal(RENDER_UPTIME_CONFIG.intervalMinutes, 5);
  assert.equal(RENDER_UPTIME_CONFIG.timeZone, 'Asia/Dhaka');
  assert.deepEqual(Array.from(RENDER_UPTIME_CONFIG.urls), [
    'https://jp-admin-stride.onrender.com/',
  ]);
});

test('monitor follows split windows, weekdays, dates, and overrides', () => {
  const schedule = normalizeRenderMonitorSchedule_({
    timezone: 'Asia/Dhaka',
    windows: [{ start: '04:00', end: '14:00' }, { start: '17:00', end: '23:00' }],
    days: [0, 1, 2, 3, 4], dates: [], overrides: { '2026-08-14': 'on' },
  });
  assert.equal(isRenderScheduleActive_(new Date('2026-08-13T04:00:00Z'), schedule, 0), true);
  assert.equal(isRenderScheduleActive_(new Date('2026-08-13T09:00:00Z'), schedule, 0), false);
  assert.equal(isRenderScheduleActive_(new Date('2026-08-14T04:00:00Z'), schedule, 0), true);
  const exact = { ...schedule, dates: ['2026-08-20'], overrides: {} };
  assert.equal(isRenderScheduleActive_(new Date('2026-08-13T04:00:00Z'), exact, 0), false);
  assert.equal(isRenderScheduleActive_(new Date('2026-08-20T04:00:00Z'), exact, 0), true);
});

test('monitor can wake Render ten minutes before a window without stopping early', () => {
  const schedule = normalizeRenderMonitorSchedule_({
    timezone: 'Asia/Dhaka', windows: [{ start: '04:00', end: '14:00' }],
    days: [0, 1, 2, 3, 4, 5, 6], dates: [], overrides: {},
  });
  const before = new Date('2026-08-12T21:50:00Z'); // 03:50 Dhaka
  assert.equal(isRenderScheduleActive_(before, schedule, 0), false);
  assert.equal(isRenderScheduleActive_(before, schedule, 10), true);
  const nearEnd = new Date('2026-08-13T07:55:00Z'); // 13:55 Dhaka
  assert.equal(isRenderScheduleActive_(nearEnd, schedule, 0), true);
});
