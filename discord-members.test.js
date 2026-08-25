const test = require('node:test');
const assert = require('node:assert/strict');
const { gatewayRetryDelayMs, isGatewayMemberRateLimit } = require('./discord-members');

test('recognizes Discord opcode 8 gateway member rate limits', () => {
  assert.equal(isGatewayMemberRateLimit({ name: 'GatewayRateLimitError' }), true);
  assert.equal(isGatewayMemberRateLimit({ message: 'Request with opcode 8 was rate limited.' }), true);
  assert.equal(isGatewayMemberRateLimit(new Error('HTTP 500')), false);
});

test('extracts and bounds Discord retry delays', () => {
  assert.equal(gatewayRetryDelayMs({ retryAfter: 27.94 }), 27940);
  assert.equal(gatewayRetryDelayMs({ message: 'Retry after 4.5 seconds.' }), 4500);
  assert.equal(gatewayRetryDelayMs({ retry_after: 90000 }), 60000);
  assert.equal(gatewayRetryDelayMs({}, 12345), 12345);
});
