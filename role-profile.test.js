'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  englishLevel,
  expectedRoleNames,
  isManagedProfileRoleName,
  missingRoleProfileFields,
  normalizeSkills,
  profileFromRoleNames,
  roleProfile,
} = require('./role-profile');

test('role profile makes Dhaka area conditional and normalizes intake vocabulary', () => {
  assert.deepEqual(roleProfile({
    region: 'Dhaka', subregion: 'mirpur', availability: 'Full-time job ready now',
    jobFocus: 'Hybrid (interested in Remote and Onsite)', englishCommunication: '4',
    technologies: 'Laravel, Python, React Native',
  }), {
    division: 'Dhaka', subregion: 'Mirpur', availability: 'full_time',
    jobFocus: 'hybrid', englishLevel: 'advanced',
    skills: ['Laravel', 'Python', 'React Native'],
  });
  assert.equal(roleProfile({ region: 'Sylhet', subregion: 'Beanibazar' }).subregion, '');
});

test('complete managed Discord roles can recover a missing intake state record', () => {
  assert.deepEqual(profileFromRoleNames([
    '@everyone', 'Active Student', 'Division · Dhaka', 'Dhaka Area · Savar',
    'Availability · Full-Time Ready', 'Work Mode · Onsite', 'English · Basic',
    'Skill · JavaScript', 'Skill · PostgreSQL',
  ]), {
    division: 'Dhaka', subregion: 'Savar', availability: 'full_time',
    jobFocus: 'onsite', englishLevel: 'basic', skills: ['JavaScript', 'PostgreSQL'],
  });
});

test('role names are independent categories and never fruit teams', () => {
  const roles = expectedRoleNames({
    division: 'Dhaka', subregion: 'Uttara', availability: 'limited',
    jobFocus: 'remote', englishLevel: 'expert', skills: ['Django', 'n8n'],
  });
  assert.deepEqual(roles, [
    'Division · Dhaka', 'Dhaka Area · Uttara', 'Availability · Limited',
    'Work Mode · Remote', 'English · Expert', 'Skill · Django', 'Skill · n8n',
  ]);
  assert.equal(roles.some(name => /mango|jackfruit/i.test(name)), false);
  assert.equal(roles.every(isManagedProfileRoleName), true);
});

test('truthful still-learning choice satisfies collection without claiming a skill role', () => {
  assert.deepEqual(normalizeSkills('Still learning / no production-ready skill yet'),
    ['Still learning / no production-ready skill yet']);
  assert.deepEqual(expectedRoleNames({ skills: ['Still learning / no production-ready skill yet'] }), []);
});

test('missing-role audit requires Dhaka area only for Dhaka', () => {
  const common = { availability: 'limited', jobFocus: 'remote', englishLevel: 'basic', skills: ['Linux'] };
  assert.deepEqual(missingRoleProfileFields({ ...common, division: 'Sylhet' }), []);
  assert.deepEqual(missingRoleProfileFields({ ...common, division: 'Dhaka' }), ['Dhaka area']);
  assert.equal(englishLevel(5), 'expert');
  assert.equal(englishLevel(3), 'advanced');
  assert.equal(englishLevel(1), 'basic');
});
