const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { messageSignature } = require('./interview');

test('interview in-process identity is bound to guild, channel, message, and text', () => {
  const base = { guildId: '1', channelId: '2', id: '3', content: 'Interview at Acme' };
  assert.equal(messageSignature(base), '1:2:3:Interview at Acme');
  assert.notEqual(messageSignature(base), messageSignature({ ...base, content: 'Interview at Beta' }));
});

test('interview handler ignores embed-only updates and bulk-writes stable message event IDs', () => {
  const source = fs.readFileSync(require.resolve('./interview'), 'utf8');
  assert.match(source, /oldMessage\.content === newMessage\.content/);
  assert.match(source, /action: 'logInterviews'/);
  assert.match(source, /messageId: msg\.id/);
  assert.match(source, /eventIndex/);
  assert.match(source, /saved\.messagePreviouslySeen/);
  assert.match(source, /const interviews = deterministic\.length/);
  assert.match(source, /resolveChannel\(\s*cohort, 'channel_interview'/);
  assert.match(source, /action: 'backfillInterviews'/);
  assert.match(source, /Interview update recorded in \*\*Interview_Log\*\*/);
});
