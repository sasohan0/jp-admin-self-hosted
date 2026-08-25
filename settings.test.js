const test = require('node:test');
const assert = require('node:assert/strict');
const { TARGETS, TIMES, cronTime, parseSlots, validateNumericSetting } = require('./settings');

test('all configurable performance targets have validation rules', () => {
  assert.deepEqual(Object.keys(TARGETS), [
    'applications', 'outreach', 'attendance', 'interviews', 'communication', 'workshops',
  ]);
});

test('target validation accepts bounded whole numbers', () => {
  assert.equal(validateNumericSetting('jobstarget', '10'), null);
  assert.equal(validateNumericSetting('weeklyattendance', '0'), null);
  assert.match(validateNumericSetting('jobstarget', '0'), /from 1 to 100/);
  assert.match(validateNumericSetting('weeklyattendance', '2.5'), /whole number/);
  assert.match(validateNumericSetting('weeklyworkshops', '-1'), /whole number/);
  assert.equal(validateNumericSetting('workshoptech', '0'), null);
  assert.equal(validateNumericSetting('qmorningcount', '2'), null);
  assert.match(validateNumericSetting('qeveningcount', '11'), /from 0 to 10/);
  assert.match(validateNumericSetting('rtbrtop', '30'), /from 1 to 25/);
  assert.match(validateNumericSetting('leaderboardinterval', '0'), /from 1 to 31/);
});

test('every runtime automation clock has a friendly command alias', () => {
  assert.deepEqual(Object.keys(TIMES), [
    'formopen', 'formclose', 'outreach', 'jobs', 'activityreconcile', 'questionplan', 'leaderboard',
    'workshopannounce', 'workshopnoshow', 'weeklyreport', 'rtbr', 'resources',
    'dmnudges', 'suggestions', 'outreachprompt', 'interviewprompt',
    'communicationprompt', 'attendancewarning', 'warningreport', 'jobemergency',
    'interviewmorning', 'interviewreview', 'contentsync',
    'dawnreset', 'dawnprompt', 'dawncheck',
  ]);
});

test('workshop slots reject invalid or backwards times', () => {
  assert.equal(parseSlots('11:30-13:00,15:00-17:00').length, 2);
  assert.equal(parseSlots('25:00-26:00').length, 0);
  assert.equal(parseSlots('17:00-15:00').length, 0);
});

test('legacy cohort cron settings retain their clock time as runtime defaults', () => {
  assert.equal(cronTime('30 22 * * *', '23:00'), '22:30');
  assert.equal(cronTime('invalid', '23:00'), '23:00');
});

test('question planning runs before the default 07:00 morning block', () => {
  const { DEFAULTS } = require('./settings');
  assert.equal(DEFAULTS.questionplantime, '06:30');
  assert.equal(DEFAULTS.qmorningtime, '07:00');
  assert.equal(DEFAULTS.qmorningcount, '2');
});

test('Dawn defaults prompt at window start and review after it closes', () => {
  const { DEFAULTS } = require('./settings');
  assert.equal(DEFAULTS.dawnattendancewindow, '05:00-07:00');
  assert.equal(DEFAULTS.dawnprompttime, '05:00');
  assert.equal(DEFAULTS.dawnchecktime, '07:10');
});
