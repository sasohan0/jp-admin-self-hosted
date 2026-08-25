const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFormCommand } = require('./formcontrol');

test('form command parser supports a silent close without changing normal close', () => {
  assert.deepEqual(parseFormCommand('!closeform'), {
    command: 'closeform',
    silent: false,
  });
  assert.deepEqual(parseFormCommand(' !CLOSEFORM silent '), {
    command: 'closeform',
    silent: true,
  });
  assert.deepEqual(parseFormCommand('!closeform --silent'), {
    command: 'closeform',
    silent: true,
  });
});

test('form command parser rejects unknown close arguments', () => {
  assert.equal(parseFormCommand('!closeform now'), null);
  assert.equal(parseFormCommand('!openform silent'), null);
  assert.equal(parseFormCommand('hello'), null);
});
