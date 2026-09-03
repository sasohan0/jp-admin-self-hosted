'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntimeHealth } = require('./runtime-health');

test('runtime health distinguishes ready, scheduled offline, and failed readiness', () => {
  const health = createRuntimeHealth({
    startedAt: new Date('2026-08-31T00:00:00.000Z'), revision: 'abcdef1234567890',
  });
  assert.equal(health.snapshot(new Date('2026-08-31T00:00:01.000Z')).ok, false);

  health.update({ phase: 'running', expectedOnline: false });
  assert.deepEqual(
    { ok: health.snapshot().ok, status: health.snapshot().status },
    { ok: true, status: 'scheduled_offline' },
  );

  health.update({ expectedOnline: true });
  health.markFailure('discord_login_failed');
  assert.equal(health.snapshot().ok, false);
  assert.equal(health.snapshot().discord.consecutiveFailures, 1);

  health.markReady(new Date('2026-08-31T00:01:00.000Z'));
  assert.equal(health.snapshot().ok, true);
  assert.equal(health.snapshot().status, 'ready');
  assert.equal(health.snapshot().revision, 'abcdef123456');
});
