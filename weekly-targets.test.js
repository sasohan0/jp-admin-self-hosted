const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildWeeklyTargets,
  parseSchedule,
  progress,
  scheduledDayCount,
} = require('./weekly-targets');

test('scheduledDayCount respects configured automation days', () => {
  assert.equal(scheduledDayCount('2026-07-12', '2026-07-16', '[0,1,2,3,4]'), 5);
  assert.equal(scheduledDayCount('2026-07-12', '2026-07-16', '[1,3]'), 2);
  assert.equal(scheduledDayCount('2026-07-12', '2026-07-16', '[5,6]'), 0);
});

test('missing or invalid schedules mean every day', () => {
  assert.equal(parseSchedule(''), null);
  assert.equal(parseSchedule('bad json'), null);
  assert.equal(scheduledDayCount('2026-07-12', '2026-07-16', ''), 5);
});

test('weekly targets exclude holidays and include working-day overrides', () => {
  const calendar = {
    workdays: [0, 1, 2, 3, 4],
    overrides: {
      '2026-07-14': { type: 'holiday', context: '' },
      '2026-07-17': { type: 'working', context: '' },
    },
  };
  assert.equal(scheduledDayCount('2026-07-12', '2026-07-18', '', calendar), 5);
  assert.equal(scheduledDayCount('2026-07-12', '2026-07-18', '[0,1,2,3,4]', calendar), 5);
});

test('buildWeeklyTargets derives weekly application and outreach goals', () => {
  assert.deepEqual(buildWeeklyTargets({
    dailyApplications: 10,
    dailyOutreach: 3,
    weeklyAttendance: 5,
    weeklyInterviews: 1,
    weeklyCommunication: 3,
    weeklyWorkshops: 3,
    jobDays: 5,
    outreachDays: 4,
  }), {
    applications: 50,
    attendance: 5,
    interviews: 1,
    outreach: 12,
    communicationPractices: 3,
    workshops: 3,
    dailyApplications: 10,
    dailyOutreach: 3,
    jobDays: 5,
    outreachDays: 4,
  });
});

test('progress omits a disabled zero target', () => {
  assert.equal(progress(7, 10), '7/10');
  assert.equal(progress(7, 0), '7');
});
