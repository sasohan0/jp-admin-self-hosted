const test = require('node:test');
const assert = require('node:assert/strict');

const { isAutomationCommand, KEYS, PARENTS } = require('./automations');

test('automation switch command does not collide with the control-center alias', () => {
  assert.equal(isAutomationCommand('!automation'), true);
  assert.equal(isAutomationCommand('!automation stop jobs'), true);
  assert.equal(isAutomationCommand('!automationconfig'), false);
});

test('activity prompts and escalations have individually controllable child switches', () => {
  for (const key of [
    'outreachprompt', 'interviewprompt', 'communicationprompt',
    'attendancewarning', 'jobemergency', 'interviewfollowup',
  ]) assert.ok(KEYS[key]);
  assert.equal(PARENTS.outreachprompt, 'activityprompts');
  assert.equal(PARENTS.jobemergency, 'escalations');
});

test('Dawn special workshops have an independent opt-in switch', () => {
  assert.match(KEYS.specialworkshop, /Dawn Focus/);
});
