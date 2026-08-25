'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { engagementCommandName } = require('./engagement');

test('engagement commands require an exact first token', () => {
  assert.equal(engagementCommandName('!inactive days 5'), '!inactive');
  assert.equal(engagementCommandName('!active top 10'), '!active');
  assert.equal(engagementCommandName('!notapplying days 3'), '!notapplying');
  assert.equal(engagementCommandName('!calllist'), '!calllist');
  assert.equal(engagementCommandName('!inactivestudents'), '');
  assert.equal(engagementCommandName('!inactivepanel'), '');
});
