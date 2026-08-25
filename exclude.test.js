const test = require('node:test');
const assert = require('node:assert/strict');

const { commandTargetId } = require('./exclude');

test('student status commands accept a mention or raw Discord ID', () => {
  const mentioned = { mentions: { users: { first: () => ({ id: '123456789012345678' }) } }, content: '' };
  const raw = { mentions: { users: { first: () => null } }, content: '!studentstatus 123456789012345678 inactive' };
  assert.equal(commandTargetId(mentioned), '123456789012345678');
  assert.equal(commandTargetId(raw), '123456789012345678');
});
