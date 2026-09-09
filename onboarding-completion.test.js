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
  const record = {
    division: 'Dhaka', subregion: 'Mirpur', availability: 'full_time',
    jobFocus: 'remote', englishLevel: 'advanced', skills: ['Python'],
  };
  const expected = [
    'Division · Dhaka', 'Dhaka Area · Mirpur', 'Availability · Full-Time Ready',
    'Work Mode · Remote', 'English · Advanced', 'Skill · Python',
  ];
  assert.deepEqual(onboardingRoleNeeds(record, []), {
    missing: expected, stale: [], profileFields: [],
  });
  assert.deepEqual(onboardingRoleNeeds(record, [...expected, 'Bootcamp · Dhaka · Mango']), {
    missing: [], stale: ['Bootcamp · Dhaka · Mango'], profileFields: [],
  });
  assert.deepEqual(onboardingRoleNeeds({}, []), {
    missing: [], stale: [],
    profileFields: ['division', 'availability', 'job preference', 'English level', 'skills'],
  });
});
