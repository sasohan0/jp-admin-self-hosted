'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('./onboarding'), 'utf8');
const { onboardingRoleNeeds } = require('./onboarding');

test('combined completion reminder targets only the incomplete union', () => {
  assert.match(source, /!completioncheck/);
  assert.match(source, /!completionreminder/);
  assert.match(source, /needsOnboarding \|\| item\.needsProfile/);
  assert.match(source, /allowedMentions: \{ users: ids \}/);
  assert.match(source, /components: publicComponents\(rulesMessage\.url, cohort\)/);
});

test('targeted onboarding reminder and role repair stay separate from profile reminders', () => {
  assert.match(source, /!onboardingreminder/);
  assert.match(source, /!onboardingrepair/);
  assert.match(source, /components: onboardingOnlyComponents\(rulesMessage\.url\)/);
  assert.match(source, /Your gender and study-stage answers are not posted publicly/);
});

test('role audit identifies only roles supported by saved onboarding answers', () => {
  const record = { gender: 'female', division: 'Dhaka', availability: 'full_time' };
  assert.deepEqual(onboardingRoleNeeds(record, []), { identity: true, readiness: true });
  assert.deepEqual(onboardingRoleNeeds(record, ['Bootcamp · Mango · Dhaka', 'Job Ready · Full-Time']), {
    identity: false,
    readiness: false,
  });
  assert.deepEqual(onboardingRoleNeeds({}, []), { identity: false, readiness: false });
});
