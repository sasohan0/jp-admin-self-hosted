'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isIdentityRoleName } = require('./group-activities');

test('group activities selects identity-region roles, not readiness roles', () => {
  assert.equal(isIdentityRoleName('Bootcamp · Dhaka · Mango'), true);
  assert.equal(isIdentityRoleName('Bootcamp · Abroad · Lychee'), true);
  assert.equal(isIdentityRoleName('Job Ready · Full-Time'), false);
  assert.equal(isIdentityRoleName('Study First · Not Job Ready'), false);
});
