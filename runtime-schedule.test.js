const test = require('node:test');
const assert = require('node:assert/strict');

const { dueToken, localClock, normalizeTime, runIfDue } = require('./runtime-schedule');

test('runtime schedule validates and normalizes 24-hour clock values', () => {
  assert.equal(normalizeTime('9:05'), '09:05');
  assert.equal(normalizeTime('23:59'), '23:59');
  assert.equal(normalizeTime('24:00'), '');
  assert.equal(normalizeTime('9pm'), '');
});

test('runtime schedule compares against the cohort timezone', () => {
  const cohort = { guildId: '123', timezone: 'Asia/Dhaka' };
  const now = new Date('2026-08-06T17:00:00.000Z');
  assert.deepEqual(localClock(cohort.timezone, now), {
    date: '2026-08-06', time: '23:00', dayOfMonth: 6,
  });
  assert.equal(dueToken(cohort, 'jobs', '23:00', now), '123:jobs:2026-08-06:23:00');
  assert.equal(dueToken(cohort, 'jobs', '22:00', now), '');
});

test('runtime schedule can recover a missed minute within a bounded grace window', () => {
  const cohort = { guildId: '123', timezone: 'Asia/Dhaka' };
  const withinGrace = new Date('2026-08-06T17:19:00.000Z'); // 23:19 Dhaka
  const afterGrace = new Date('2026-08-06T17:31:00.000Z'); // 23:31 Dhaka
  assert.equal(
    dueToken(cohort, 'warningreport', '23:00', withinGrace, { graceMinutes: 30 }),
    '123:warningreport:2026-08-06:23:00');
  assert.equal(dueToken(cohort, 'warningreport', '23:00', afterGrace, { graceMinutes: 30 }), '');
  assert.equal(dueToken(cohort, 'warningreport', '23:00', withinGrace), '');
});

test('runtime schedule fires one task only once per cohort-local day', async () => {
  const cohort = { guildId: `test-${Date.now()}`, timezone: 'Asia/Dhaka' };
  const now = new Date('2026-08-06T14:00:00.000Z');
  let calls = 0;
  assert.equal(await runIfDue(cohort, 'outreach', '20:00', async () => { calls++; }, now), true);
  assert.equal(await runIfDue(cohort, 'outreach', '20:00', async () => { calls++; }, now), false);
  assert.equal(calls, 1);
});
