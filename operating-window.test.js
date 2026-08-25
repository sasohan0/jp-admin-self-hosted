const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { isWithinWindow, localMinutes, parseWindow, startOperatingWindow } = require('./operating-window');

test('cross-midnight operating window includes 10 AM through before 1 AM', () => {
  const window = parseWindow('10:00-01:00');
  assert.equal(isWithinWindow(10 * 60, window), true);
  assert.equal(isWithinWindow(23 * 60 + 59, window), true);
  assert.equal(isWithinWindow(30, window), true);
  assert.equal(isWithinWindow(60, window), false);
  assert.equal(isWithinWindow(9 * 60 + 59, window), false);
});

test('localMinutes respects the configured cohort timezone', () => {
  assert.equal(localMinutes(new Date('2026-07-23T04:00:00.000Z'), 'Asia/Dhaka'), 10 * 60);
});

test('invalid or zero-length windows fail fast', () => {
  assert.throws(() => parseWindow('10-1'), /must look like/);
  assert.throws(() => parseWindow('10:00-10:00'), /cannot be equal/);
});

test('operating controller connects inside the window and disconnects at the end', async () => {
  const client = new EventEmitter();
  let ready = false;
  let logins = 0;
  let destroys = 0;
  client.isReady = () => ready;
  client.login = async () => { logins++; ready = true; };
  client.destroy = () => { destroys++; ready = false; };
  let current = new Date('2026-07-23T04:00:00.000Z'); // 10:00 Dhaka
  const controller = startOperatingWindow(client, 'test-token', {
    window: '10:00-01:00',
    timezone: 'Asia/Dhaka',
    now: () => current,
    setInterval: () => ({ unref() {} }),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(logins, 1);
  current = new Date('2026-07-23T19:00:00.000Z'); // 01:00 Dhaka next day
  await controller.reconcile();
  assert.equal(destroys, 1);
});

test('operating controller applies a split-window schedule immediately', async () => {
  const client = new EventEmitter();
  let ready = false;
  let logins = 0;
  let destroys = 0;
  client.isReady = () => ready;
  client.login = async () => { logins++; ready = true; };
  client.destroy = () => { destroys++; ready = false; };
  const current = new Date('2026-08-13T09:00:00.000Z'); // Thu 15:00 Dhaka
  const controller = startOperatingWindow(client, 'test-token', {
    schedule: {
      timezone: 'Asia/Dhaka', windows: [{ start: '04:00', end: '14:00' }],
      days: [0, 1, 2, 3, 4, 5, 6], dates: [], overrides: {},
    },
    now: () => current,
    setInterval: () => ({ unref() {} }),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(logins, 0);
  await controller.setSchedule({
    timezone: 'Asia/Dhaka',
    windows: [{ start: '04:00', end: '14:00' }, { start: '15:00', end: '23:00' }],
    days: [0, 1, 2, 3, 4, 5, 6], dates: [], overrides: {},
  });
  assert.equal(logins, 1);
  assert.equal(destroys, 0);
});
