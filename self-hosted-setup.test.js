const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CAPSULE_PREFIX,
  parseSetupCapsule,
  signSetupPayload,
} = require('./self-hosted-setup');

const secret = 's'.repeat(64);
const payload = {
  version: 1,
  name: 'Mentor Cohort',
  guildId: '123456789012345678',
  supervisorIds: ['111111111111111111'],
  timezone: 'Asia/Dhaka',
  channels: { supervisor: '222222222222222222' },
};

test('self-hosted setup capsule round-trips non-secret Discord settings', () => {
  const capsule = signSetupPayload(payload, secret);
  assert.match(capsule, new RegExp(`^${CAPSULE_PREFIX}`));
  assert.doesNotMatch(capsule, new RegExp(secret));
  assert.deepEqual(parseSetupCapsule(capsule, secret), payload);
});

test('self-hosted setup capsule rejects tampering and wrong secrets', () => {
  const capsule = signSetupPayload(payload, secret);
  assert.throws(() => parseSetupCapsule(`${capsule}x`, secret), /signature is invalid/);
  assert.throws(() => parseSetupCapsule(capsule, 'w'.repeat(64)), /signature is invalid/);
});

test('self-hosted setup capsule rejects invalid identity data even when correctly signed', () => {
  const invalid = { ...payload, supervisorIds: [] };
  assert.throws(() => parseSetupCapsule(signSetupPayload(invalid, secret), secret), /invalid supervisor IDs/);
});
