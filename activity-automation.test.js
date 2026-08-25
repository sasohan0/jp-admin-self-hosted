const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PROMPTS,
  attendanceFollowupPlan,
  belowJobTarget,
  consecutiveAbsenceTail,
  currentSunday,
  privateContactLines,
  previousWorkdays,
  parseActivityCommand,
  parseAttendanceFollowup,
  withoutInterviews,
} = require('./activity-automation');

test('previous workdays exclude Friday and Saturday in Asia/Dhaka', () => {
  const sundayMorning = new Date('2026-08-09T02:00:00.000Z');
  assert.deepEqual(previousWorkdays('Asia/Dhaka', 2, sundayMorning), ['2026-08-05', '2026-08-06']);
  assert.equal(currentSunday('2026-08-13'), '2026-08-09');
});

test('manual attendance warning checks accept an explicit report date', () => {
  assert.deepEqual(parseActivityCommand('!activitycheck attendance 2026-08-23'), {
    action: 'check', kind: 'attendance', date: '2026-08-23',
  });
  assert.deepEqual(parseActivityCommand('!activitycheck attendance'), {
    action: 'check', kind: 'attendance', date: '',
  });
  assert.equal(parseActivityCommand('!activitycheck jobs tomorrow'), null);
});

test('attendance warning requires the latest two recorded sessions to be absent', () => {
  const sessions = ['2026-08-09', '2026-08-10', '2026-08-11'];
  assert.equal(consecutiveAbsenceTail(['2026-08-09', '2026-08-10'], sessions), 0);
  assert.equal(consecutiveAbsenceTail(['2026-08-10', '2026-08-11'], sessions), 2);
  assert.equal(consecutiveAbsenceTail(['2026-08-09', '2026-08-10', '2026-08-11'], sessions), 3);
});

test('post-attendance mail is independent of the warning switch and survives durable parsing', () => {
  assert.deepEqual(attendanceFollowupPlan({
    working: true, warmup: false, warningEnabled: false, mailerEnabled: true,
  }), { warning: false, mailer: true, terminalSkip: false });
  assert.deepEqual(attendanceFollowupPlan({
    working: false, warmup: false, warningEnabled: true, mailerEnabled: true,
  }), { warning: false, mailer: false, terminalSkip: true });
  assert.deepEqual(parseAttendanceFollowup(JSON.stringify({
    reportDate: '2026-08-23', status: 'pending', dueAt: 123, attempts: 1,
    warningDone: true, mailerDone: false,
  })), {
    reportDate: '2026-08-23', status: 'pending', dueAt: 123, attempts: 1,
    warningDone: true, mailerDone: false,
  });
  assert.equal(parseAttendanceFollowup('{"reportDate":"bad"}'), null);
});

test('two-day application emergency requires both days below the configured target', () => {
  const roster = [
    { email: 'a@example.com', discordId: '1' },
    { email: 'b@example.com', discordId: '2' },
  ];
  const rows = [
    { email: 'a@example.com', jobDays: { '2026-08-10': 9, '2026-08-11': 8 } },
    { email: 'b@example.com', jobDays: { '2026-08-10': 9, '2026-08-11': 10 } },
  ];
  const result = belowJobTarget(rows, roster, ['2026-08-10', '2026-08-11'], 10);
  assert.deepEqual(result.map(item => item.discordId), ['1']);
  assert.deepEqual(result[0].counts, [9, 8]);
  const excused = belowJobTarget([{
    email: 'a@example.com', jobDays: { '2026-08-10': 0, '2026-08-11': 0 },
    leaveDays: { '2026-08-10': true },
  }], roster.slice(0, 1), ['2026-08-10', '2026-08-11'], 10);
  assert.deepEqual(excused, []);
});

test('private escalation contacts are copyable and contain no Discord mention', () => {
  const lines = privateContactLines([{
    name: 'Student\nOne', email: 'one@example.com', phone: '01700000000',
    discordId: '123', counts: [4, 5],
  }], student => `${student.counts[0]}/10, then ${student.counts[1]}/10`);
  assert.equal(lines[0], 'NAME\tEMAIL\tPHONE\tREASON');
  assert.equal(lines[1], 'Student One\tone@example.com\t01700000000\t4/10, then 5/10');
  assert.doesNotMatch(lines.join('\n'), /<@|123/);
});

test('weekly interview reminder finds active students with no recorded update', () => {
  const roster = [{ email: 'a@example.com' }, { email: 'b@example.com' }];
  const rows = [{ email: 'a@example.com', interviews: 1 }, { email: 'b@example.com', interviews: 0 }];
  assert.deepEqual(withoutInterviews(rows, roster).map(item => item.email), ['b@example.com']);
  assert.match(PROMPTS.outreach, /4:50 AM–11:30 PM/);
  assert.match(PROMPTS.interview, /@everyone/);
  assert.match(PROMPTS.communication, /@everyone/);
});
