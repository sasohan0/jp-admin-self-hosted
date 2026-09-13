const test = require('node:test');
const assert = require('node:assert/strict');

const {
  attendanceSegments,
  attendanceResponsePolicy,
  conflictingAttendanceIdentities,
  parseAttendancePublication,
  reconcileAttendanceRoster,
  rosterIdentityCoverage,
} = require('./attendance');

test('attendance fails closed while any current Discord student lacks verified identity data', () => {
  assert.deepEqual(rosterIdentityCoverage({ unmatched: [] }), {
    ready: true, pendingCount: 0,
  });
  assert.deepEqual(rosterIdentityCoverage({ unmatched: [{ discordId: '1' }] }), {
    ready: false, pendingCount: 1,
  });
});

test('unmatched identities are rejected without blocking attendance', () => {
  assert.deepEqual(attendanceResponsePolicy({
    identityIssues: [{ row: 10 }],
  }), {
    backendBlocked: false,
    blockReason: '',
    rejectedIdentityResponses: 1,
    invalidTimestampRows: 0,
  });
});

test('a backend-blocked invalid Timestamp cannot be published as everyone present', () => {
  assert.deepEqual(attendanceResponsePolicy({
    blocked: true,
    blockReason: 'invalid-timestamps',
    invalidDateRows: [{ row: 11 }],
  }), {
    backendBlocked: true,
    blockReason: 'invalid-timestamps',
    rejectedIdentityResponses: 0,
    invalidTimestampRows: 1,
  });
});

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

test('same-name present and absent Discord accounts stop unsafe public attendance', () => {
  const conflicts = conflictingAttendanceIdentities({
    present: [{ name: 'Khalid Sifullah Siam', discordId: '111' }],
    leave: [],
    absent: [{ name: '  Khalid—Sifullah  Siam ', discordId: '222' }],
  });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].present.discordId, '111');
  assert.equal(conflicts[0].absent.discordId, '222');
});

test('attendance segments carry a stable date marker and only the first part uses everyone', () => {
  const absent = Array.from({ length: 70 }, (_, index) => ({
    name: `Student ${index}`,
    discordId: String(100000000000000000n + BigInt(index)),
    history: { total: 5, missed: 2, streak: 2 },
  }));
  const segments = attendanceSegments(absent, '2026-08-31');
  assert.ok(segments.length > 1);
  assert.match(segments[0].content, /^@everyone/);
  assert.ok(segments.every(segment => segment.content.includes('Attendance 2026-08-31')));
  assert.ok(segments.slice(1).every(segment => !segment.content.includes('@everyone')));
});

test('durable attendance publication state is scoped to date and channel', () => {
  const value = JSON.stringify({
    date: '2026-08-31', channelId: 'channel-1', summaryId: 'summary',
    segmentIds: ['one', 'two'],
  });
  assert.deepEqual(parseAttendancePublication(value, '2026-08-31', 'channel-1'), {
    date: '2026-08-31', channelId: 'channel-1', summaryId: 'summary',
    segmentIds: ['one', 'two'],
  });
  assert.equal(parseAttendancePublication(value, '2026-09-01', 'channel-1'), null);
});
