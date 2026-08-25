const test = require('node:test');
const assert = require('node:assert/strict');
const { createJoinRosterSyncQueue } = require('./join-roster-sync');

function manualTimers() {
  const queue = [];
  return {
    setTimer(fn, delay) {
      const timer = { fn, delay, cancelled: false };
      queue.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cancelled = true; },
    queue,
    async runNext() {
      const timer = queue.shift();
      if (timer && !timer.cancelled) await timer.fn();
    },
  };
}

test('join bursts create one full roster reconciliation without postponing the first timer', async () => {
  const timers = manualTimers();
  const calls = [];
  const queue = createJoinRosterSyncQueue({
    sync: async (client, cohort) => calls.push([client, cohort.guildId]),
    delayMs: 30000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const cohort = { guildId: '1534781682920456192' };
  queue.schedule('client', cohort);
  queue.schedule('client', cohort);
  queue.schedule('client', cohort);
  assert.equal(timers.queue.length, 1);
  assert.equal(timers.queue[0].delay, 30000);
  await timers.runNext();
  assert.deepEqual(calls, [['client', cohort.guildId]]);
});

test('a failed join reconciliation retries with bounded delays', async () => {
  const timers = manualTimers();
  let attempts = 0;
  const errors = [];
  const queue = createJoinRosterSyncQueue({
    sync: async () => {
      attempts++;
      if (attempts < 3) throw new Error('temporary backend error');
    },
    delayMs: 10,
    retryDelays: [20, 40],
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onError: (cohort, error, attempt) => errors.push([cohort.guildId, error.message, attempt]),
  });
  queue.schedule({}, { guildId: '1534781682920456192' });
  await timers.runNext();
  assert.equal(timers.queue[0].delay, 20);
  await timers.runNext();
  assert.equal(timers.queue[0].delay, 40);
  await timers.runNext();
  assert.equal(attempts, 3);
  assert.deepEqual(errors.map(item => item[2]), [1, 2]);
  assert.equal(timers.queue.length, 0);
});

