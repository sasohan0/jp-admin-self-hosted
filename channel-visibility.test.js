'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { visibilityPlan } = require('./channel-visibility');

test('held starter programmes hide only their dedicated student channels', () => {
  const plan = visibilityPlan({
    outreach: false, outreachprompt: false,
    interviewprompt: false, interviewfollowup: false,
    workshop: false, communicationprompt: false,
    rtbr: false, discipline: false, specialworkshop: false,
  });
  assert.ok(plan.every(item => item.visible === false));
  assert.deepEqual(plan.flatMap(item => item.channelKeys).sort(),
    ['discipline', 'groupActivities', 'interviewUpdates', 'outreach', 'rtbr', 'workshop'].sort());
});

test('starting either related automation reveals its workflow channel', () => {
  const plan = visibilityPlan({ outreach: false, outreachprompt: true });
  assert.equal(plan.find(item => item.label === 'outreach').visible, true);
  assert.equal(plan.find(item => item.label === 'communication').visible, false);
});
