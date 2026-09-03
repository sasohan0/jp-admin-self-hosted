'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSerialQueue, managerPayload, parseDateRange, requestButtons, selectManagerIndex,
} = require('./leave');

test('leave date range accepts relative dates and rejects backwards or long ranges', () => {
  const now = new Date('2026-08-14T06:00:00.000Z');
  assert.deepEqual(parseDateRange('today', 'tomorrow', 'Asia/Dhaka', now), {
    start: '2026-08-14', end: '2026-08-15',
  });
  assert.throws(() => parseDateRange('2026-08-20', '2026-08-19', 'Asia/Dhaka', now), /cannot be after/);
  assert.throws(() => parseDateRange('2026-08-01', '2026-11-01', 'Asia/Dhaka', now), /cannot exceed/);
});

test('leave operations execute one at a time per cohort and continue after failure', async () => {
  const queue = createSerialQueue();
  const events = [];
  const first = queue.run('guild-1', async () => {
    events.push('first-start');
    await new Promise(resolve => setTimeout(resolve, 10));
    events.push('first-end');
  });
  const second = queue.run('guild-1', async () => {
    events.push('second');
    throw new Error('expected');
  });
  const third = queue.run('guild-1', async () => events.push('third'));
  await first;
  await assert.rejects(second, /expected/);
  await third;
  assert.deepEqual(events, ['first-start', 'first-end', 'second', 'third']);
});

test('leave approval controls are cohort and request bound', () => {
  const rows = requestButtons({ guildId: '1534781682920456192' }, 'request-123');
  const ids = rows[0].components.map(component => component.data.custom_id);
  assert.deepEqual(ids, [
    'leave:approve:1534781682920456192:request-123',
    'leave:adjust:1534781682920456192:request-123',
    'leave:reject:1534781682920456192:request-123',
  ]);
});

test('open leave manager pages pending requests without duplicating cards', () => {
  const cohort = { guildId: '123', name: 'SCPC-13' };
  const requests = [
    { requestId: 'old', reason: 'one', name: 'A', discordId: '1', requestedStart: '2026-09-01', requestedEnd: '2026-09-01' },
    { requestId: 'new', reason: 'two', name: 'B', discordId: '2', requestedStart: '2026-09-02', requestedEnd: '2026-09-02' },
  ];
  assert.equal(selectManagerIndex(requests, 'old', 'next'), 1);
  assert.equal(selectManagerIndex(requests, 'new', 'previous'), 0);
  const payload = managerPayload(cohort, requests, 0);
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.components.length, 2);
  assert.match(payload.components[1].components[2].data.custom_id, /:next$/);
  assert.equal(payload.components[1].components[0].data.disabled, true);
});
