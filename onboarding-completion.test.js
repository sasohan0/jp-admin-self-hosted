'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('./onboarding'), 'utf8');
const {
  categorizeOnboarding, isRoleProfileComplete, onboardingRoleNeeds,
  recordWithAssignedRoleNames, recordWithAssignedRoles, waitForRoleProfile,
} = require('./onboarding');

test('combined completion reminder targets only the incomplete union', () => {
  assert.match(source, /!completioncheck/);
  assert.match(source, /!completionreminder/);
  assert.match(source, /needsOnboarding \|\| item\.needsProfile/);
  assert.match(source, /allowedMentions: \{ users: ids \}/);
  assert.match(source, /components: publicComponents\(rulesMessage\.url, cohort\)/);
});

test('complete intake role data skips the fallback questionnaire before rules acceptance', () => {
  const intakeRecord = {
    division: 'Sylhet', availability: 'limited', jobFocus: 'hybrid',
    englishLevel: 'advanced', skills: ['Laravel'], rulesAccepted: false,
  };
  assert.equal(isRoleProfileComplete(intakeRecord), true);
  assert.match(source, /accept_rules_public/);
  assert.match(source, /no second private profile is required/);
});

test('join onboarding waits through a slow intake write before choosing fallback', async () => {
  let reads = 0;
  let waits = 0;
  const record = await waitForRoleProfile({}, '123', {
    intervalMs: 1,
    wait: async () => { waits += 1; },
    loader: async () => {
      reads += 1;
      if (reads < 3) return {};
      return {
        division: 'Dhaka', subregion: 'Mirpur', availability: 'full_time',
        jobFocus: 'remote', englishLevel: 'advanced', skills: ['React'],
      };
    },
  });
  assert.equal(reads, 3);
  assert.equal(waits, 2);
  assert.equal(isRoleProfileComplete(record), true);
});

test('status separates ready role profiles from rules-only completion', () => {
  const eligible = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const base = {
    division: 'Khulna', availability: 'limited', jobFocus: 'remote',
    englishLevel: 'advanced', skills: ['JavaScript'],
  };
  const result = categorizeOnboarding(eligible, [
    { userId: 'a', ...base, rulesAccepted: true },
    { userId: 'b', ...base, rulesAccepted: false },
    { userId: 'c', division: 'Khulna' },
  ]);
  assert.deepEqual(result.completed.map(member => member.id), ['a']);
  assert.deepEqual(result.rulesPending.map(member => member.id), ['b']);
  assert.deepEqual(result.missingProfile.map(member => member.id), ['c']);
});

test('status trusts complete bot-managed roles when an older backend omitted onboarding state', () => {
  const roles = [
    'Division · Khulna', 'Availability · Full-Time Ready', 'Work Mode · Remote',
    'English · Advanced', 'Skill · JavaScript',
  ].map(name => ({ name }));
  const member = { id: '123', roles: { cache: new Map(roles.map((role, index) => [index, role])) } };
  const recovered = recordWithAssignedRoles({ userId: '123' }, member);
  assert.equal(isRoleProfileComplete(recovered), true);
  assert.equal(recovered.division, 'Khulna');
  assert.deepEqual(recovered.skills, ['JavaScript']);
});

test('a partial legacy answer preserves role categories it did not explicitly replace', () => {
  const effective = recordWithAssignedRoleNames({
    userId: '123', division: 'Mymensingh', availability: 'limited',
  }, [
    'Division · Mymensingh', 'Availability · Limited', 'Work Mode · Hybrid',
    'English · Basic', 'Skill · Laravel', 'Skill · Node.js',
  ]);
  assert.equal(effective.jobFocus, 'hybrid');
  assert.equal(effective.englishLevel, 'basic');
  assert.deepEqual(effective.skills, ['Laravel', 'Node.js']);
  assert.deepEqual(onboardingRoleNeeds(effective, [
    'Division · Mymensingh', 'Availability · Limited', 'Work Mode · Hybrid',
    'English · Basic', 'Skill · Laravel', 'Skill · Node.js',
  ]).stale, []);
});

test('supervisors can restore one or all current role profiles from structured intake', () => {
  assert.match(source, /!restorerolesfromintake/);
  assert.match(source, /action: 'getIntakeRoleProfiles'/);
  assert.match(source, /onboardingAnswers\(source\.answers/);
  assert.match(source, /allowedMentions: \{ parse: \[\] \}/);
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
