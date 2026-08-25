const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeChannelName } = require('./channel-names');

test('normalizes emoji and decorative template channel separators', () => {
  assert.equal(normalizeChannelName('👋・welcome-to-the-bootcamp'), 'welcome-to-the-bootcamp');
  assert.equal(normalizeChannelName('📜︱rules-and-regulations'), 'rules-and-regulations');
});

test('normalizes numbered template channel prefixes', () => {
  assert.equal(normalizeChannelName('01-rules-and-regulations'), 'rules-and-regulations');
  assert.equal(normalizeChannelName('2・bot-admin'), 'bot-admin');
});

test('preserves the canonical outreach-update channel name', () => {
  assert.equal(normalizeChannelName('03-outreach-update'), 'outreach-update');
  assert.equal(normalizeChannelName('03-outreach-updates'), 'outreach-updates');
  assert.equal(normalizeChannelName('outreach'), 'outreach');
});
