'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isIdentityRoleName } = require('./group-activities');

test('group activities selects division roles, not legacy fruit or profile roles', () => {
  assert.equal(isIdentityRoleName('Division · Dhaka'), true);
  assert.equal(isIdentityRoleName('Division · Abroad'), true);
  assert.equal(isIdentityRoleName('Bootcamp · Dhaka · Mango'), false);
  assert.equal(isIdentityRoleName('Availability · Full-Time Ready'), false);
  assert.equal(isIdentityRoleName('Skill · Python'), false);
});
