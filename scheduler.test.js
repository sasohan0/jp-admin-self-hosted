const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_DAYS, FIXED_WEEKDAY_KEYS, SCHEDULE_KEYS, formatDays, parseDays, scheduleAllowsCalendarDay } = require('./scheduler');

test('automation day schedules support ranges, lists, and explicit everyday', () => {
  assert.deepEqual(parseDays('sun-thu'), [0, 1, 2, 3, 4]);
  assert.deepEqual(parseDays('mon,wed,fri'), [1, 3, 5]);
  assert.equal(parseDays('everyday'), null);
  assert.equal(parseDays('not-a-day'), null);
});

test('fixed weekly reports retain weekdays while daily automation follows the work calendar', () => {
  assert.deepEqual(DEFAULT_DAYS.weeklyreport, [4]);
  assert.deepEqual(DEFAULT_DAYS.rtbr, [4]);
  assert.deepEqual(DEFAULT_DAYS.interviewfollowup, [4]);
  assert.deepEqual(DEFAULT_DAYS.warningreport, [4]);
  assert.equal(formatDays(JSON.stringify(DEFAULT_DAYS.weeklyreport)), 'Thu');
  assert.ok(SCHEDULE_KEYS.includes('jobs'));
  assert.ok(SCHEDULE_KEYS.includes('weeklyreport'));
  assert.equal(DEFAULT_DAYS.outreachprompt, undefined);
  assert.ok(FIXED_WEEKDAY_KEYS.has('weeklyreport'));
  assert.ok(FIXED_WEEKDAY_KEYS.has('warningreport'));
  assert.ok(!FIXED_WEEKDAY_KEYS.has('jobs'));
});

test('attendance warning and job emergency follow every configured workday', () => {
  assert.equal(DEFAULT_DAYS.attendancewarning, undefined);
  assert.equal(SCHEDULE_KEYS.includes('attendancewarning'), false);
  assert.equal(DEFAULT_DAYS.jobemergency, undefined);
  assert.equal(SCHEDULE_KEYS.includes('jobemergency'), false);
  assert.equal(FIXED_WEEKDAY_KEYS.has('attendancewarning'), false);
  assert.equal(FIXED_WEEKDAY_KEYS.has('jobemergency'), false);
  const workingOverride = { working: true, source: 'override' };
  assert.equal(scheduleAllowsCalendarDay(workingOverride, 'attendancewarning', '', 2), true);
  assert.equal(scheduleAllowsCalendarDay(workingOverride, 'attendancewarning', '', 3), true);
  assert.equal(scheduleAllowsCalendarDay(workingOverride, 'jobemergency', '', 4), true);
  assert.equal(scheduleAllowsCalendarDay(workingOverride, 'jobemergency', '', 1), true);
});

test('day schedules reject partially valid input instead of silently dropping mistakes', () => {
  assert.equal(parseDays('mon,notaday,fri'), null);
  assert.equal(parseDays('notaday'), null);
});

test('holiday blocks every schedule and working overrides resume daily but not fixed weekly output', () => {
  assert.equal(scheduleAllowsCalendarDay({ working: false, source: 'override' }, 'jobs', '[]', 5), false);
  assert.equal(scheduleAllowsCalendarDay({ working: true, source: 'override' }, 'jobs', '[0,1,2,3,4]', 5), true);
  assert.equal(scheduleAllowsCalendarDay({ working: true, source: 'override' }, 'weeklyreport', '[4]', 5), false);
  assert.equal(scheduleAllowsCalendarDay({ working: true, source: 'weekly' }, 'jobs', '[0,1,2,3,4]', 5), false);
});
