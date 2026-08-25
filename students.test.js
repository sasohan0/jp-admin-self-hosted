const test = require('node:test');
const assert = require('node:assert/strict');

const { isStudentsCommand } = require('./students');

test('student directory does not collide with student status or report commands', () => {
  assert.equal(isStudentsCommand('!students'), true);
  assert.equal(isStudentsCommand('!students dhaka'), true);
  assert.equal(isStudentsCommand('!studentstatus list'), false);
  assert.equal(isStudentsCommand('!studentreport'), false);
  assert.equal(isStudentsCommand('!studentsurvey attention 3'), false);
});
