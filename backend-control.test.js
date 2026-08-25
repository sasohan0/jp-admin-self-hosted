'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyScheduleCommand } = require('./backend-control');
const { DEFAULT_SCHEDULE, parseBackendCommand } = require('./backend-schedule');

test('backend day command returns to recurring mode after exact dates', () => {
  const current = { ...DEFAULT_SCHEDULE, dates: ['2026-08-20'] };
  const next = applyScheduleCommand(current, parseBackendCommand('!backend days mon,wed'), 'Asia/Dhaka');
  assert.deepEqual(next.days, [1, 3]);
  assert.deepEqual(next.dates, []);
});

test('backend date overrides can be set and cleared without changing windows', () => {
  const withOverride = applyScheduleCommand(
    DEFAULT_SCHEDULE, parseBackendCommand('!backend date 2026-08-21 off'), 'Asia/Dhaka',
  );
  assert.equal(withOverride.overrides['2026-08-21'], 'off');
  const cleared = applyScheduleCommand(
    withOverride, parseBackendCommand('!backend date 2026-08-21 clear'), 'Asia/Dhaka',
  );
  assert.equal(cleared.overrides['2026-08-21'], undefined);
  assert.deepEqual(cleared.windows, [{ start: '04:50', end: '23:30' }]);
});
