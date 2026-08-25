const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRoleName, findHiredRole } = require('./hired-role');

test('normalizes hired role names without depending on capitalization or separators', () => {
  assert.equal(normalizeRoleName(' Successfully_Hired '), 'successfully hired');
});

test('reuses a recognized hired role and ignores unrelated roles', () => {
  const roles = [{ id: '1', name: 'Student' }, { id: '2', name: 'Hired' }];
  assert.equal(findHiredRole(roles)?.id, '2');
  assert.equal(findHiredRole([{ id: '3', name: 'Alumni' }]), null);
});
