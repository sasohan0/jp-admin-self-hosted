'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseAppealCommand,
  sanitizeAppealText,
  validAppealCause,
} = require('./appeal-rules');

test('appeal administration commands are explicit and note-aware', () => {
  assert.deepEqual(parseAppealCommand('!appeals'), { action: 'list', status: 'pending' });
  assert.deepEqual(parseAppealCommand('!appeals all'), { action: 'list', status: '' });
  assert.deepEqual(parseAppealCommand('!appeal approve abc-123 | Return from Monday'), {
    action: 'approved', requestId: 'abc-123', note: 'Return from Monday',
  });
  assert.deepEqual(parseAppealCommand('!appeal decline abc-123 | Insufficient details'), {
    action: 'declined', requestId: 'abc-123', note: 'Insufficient details',
  });
  assert.equal(parseAppealCommand('hello'), null);
});

test('appeal causes are allow-listed and explanations are bounded', () => {
  assert.equal(validAppealCause('medical'), true);
  assert.equal(validAppealCause('anything'), false);
  assert.equal(sanitizeAppealText('  date\nreason  ', 20), 'date\nreason');
  assert.equal(sanitizeAppealText('x'.repeat(30), 10).length, 10);
});
