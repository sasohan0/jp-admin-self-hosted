const test = require('node:test');
const assert = require('node:assert/strict');

const { isFormsCommand } = require('./forms');

test('forms manager does not collide with form status', () => {
  assert.equal(isFormsCommand('!forms'), true);
  assert.equal(isFormsCommand('!forms use 2'), true);
  assert.equal(isFormsCommand('!forms link abc'), true);
  assert.equal(isFormsCommand('!formstatus'), false);
});
