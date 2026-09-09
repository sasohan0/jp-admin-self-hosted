'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isScheduleActive, normalizeSchedule, parseBackendCommand, parseDays, parseWindows,
} = require('./backend-schedule');

test('backend schedule accepts one or multiple daily windows', () => {
  assert.deepEqual(parseWindows('4:00-14:00,17:00-23:00'), [
    { start: '04:00', end: '14:00' }, { start: '17:00', end: '23:00' },
  ]);
  assert.throws(() => parseWindows('04:00-04:00'), /zero hours/);
});

test('backend schedule accepts everyday, weekdays, and custom weekday lists', () => {
  assert.deepEqual(parseDays('everyday'), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(parseDays('weekdays'), [0, 1, 2, 3, 4]);
  assert.deepEqual(parseDays('mon,wed,fri'), [1, 3, 5]);
});

test('backend schedule handles split windows, exact dates, and date overrides', () => {
  const schedule = normalizeSchedule({
    timezone: 'Asia/Dhaka', windows: parseWindows('04:00-14:00,17:00-23:00'),
    days: [0, 1, 2, 3, 4], dates: [], overrides: { '2026-08-14': 'on' },
  });
  assert.equal(isScheduleActive(schedule, new Date('2026-08-13T04:00:00Z')), true); // Thu 10:00
  assert.equal(isScheduleActive(schedule, new Date('2026-08-13T09:00:00Z')), false); // Thu 15:00
  assert.equal(isScheduleActive(schedule, new Date('2026-08-14T04:00:00Z')), true); // Fri override
  const exact = { ...schedule, dates: ['2026-08-20'], overrides: {} };
  assert.equal(isScheduleActive(exact, new Date('2026-08-13T04:00:00Z')), false);
  assert.equal(isScheduleActive(exact, new Date('2026-08-20T04:00:00Z')), true);
});

test('backend commands parse schedule edits', () => {
  assert.deepEqual(parseBackendCommand('!backend windows 04:00-14:00,17:00-23:00').windows.length, 2);
  assert.deepEqual(parseBackendCommand('!backend days weekdays').days, [0, 1, 2, 3, 4]);
  assert.deepEqual(parseBackendCommand('!backend dates 2026-08-20,2026-08-22').dates,
    ['2026-08-20', '2026-08-22']);
  assert.deepEqual(parseBackendCommand('!backend date 2026-08-21 off'),
    { action: 'date', date: '2026-08-21', state: 'off' });
  assert.deepEqual(parseBackendCommand('!backend override 2026-09-09,2026-09-10 always'), {
    action: 'override', dates: ['2026-09-09', '2026-09-10'], override: 'always',
  });
  assert.deepEqual(parseBackendCommand('!backend override 2026-09-11 00:00-02:00'), {
    action: 'override', dates: ['2026-09-11'], override: { windows: [{ start: '00:00', end: '02:00' }] },
  });
});

test('date overrides can run all day or use their own windows without changing the regular schedule', () => {
  const schedule = normalizeSchedule({
    timezone: 'Asia/Dhaka', windows: [{ start: '04:50', end: '23:30' }],
    days: [0, 1, 2, 3, 4, 5, 6], overrides: {
      '2026-09-09': 'always',
      '2026-09-10': { windows: [{ start: '00:00', end: '02:00' }] },
    },
  });
  assert.equal(isScheduleActive(schedule, new Date('2026-09-08T18:30:00Z')), true); // Sep 9 00:30
  assert.equal(isScheduleActive(schedule, new Date('2026-09-09T17:30:00Z')), true); // Sep 9 23:30, all day
  assert.equal(isScheduleActive(schedule, new Date('2026-09-09T19:00:00Z')), true); // Sep 10 01:00
  assert.equal(isScheduleActive(schedule, new Date('2026-09-09T21:00:00Z')), false); // Sep 10 03:00
});
