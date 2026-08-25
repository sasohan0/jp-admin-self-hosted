const test = require('node:test');
const assert = require('node:assert/strict');

const { reconcileAttendanceRoster } = require('./attendance');

test('attendance excludes students already inactive while retaining today active students', () => {
  const cohort = { guildId: 'guild', supervisorIds: ['900'] };
  const roster = [
    { name: 'Active', email: 'active@example.com', discordId: '1', active: true },
    { name: 'Inactive', email: 'inactive@example.com', discordId: '2', active: false },
    { name: 'Manual exclusion', email: 'manual@example.com', discordId: '3', active: true },
    { name: 'Mentor', email: 'mentor@example.com', discordId: '900', active: true },
  ];
  const excluded = new Set(['2', '3', '900']);
  const result = reconcileAttendanceRoster({
    present: [],
    leave: [],
    absent: roster,
    interviewsToday: ['Active', 'Inactive'],
  }, cohort, roster, (_cohort, student) => excluded.has(student.discordId));

  assert.deepEqual(result.absent.map(student => student.name), ['Active']);
  assert.deepEqual(result.interviewsToday, ['Active']);
  assert.equal(result.excludedCount, 3);
});

test('warning-three student remains reportable until the status transition occurs', () => {
  const cohort = { guildId: 'guild', supervisorIds: [] };
  const student = {
    name: 'Third warning today',
    email: 'warning3@example.com',
    discordId: '4',
    active: true,
  };
  const before = reconcileAttendanceRoster({ absent: [student] }, cohort, [student], () => false);
  const after = reconcileAttendanceRoster({ absent: [student] }, cohort,
    [{ ...student, active: false }], (_cohort, entry) => entry.active === false);

  assert.equal(before.absent.length, 1);
  assert.equal(after.absent.length, 0);
});
