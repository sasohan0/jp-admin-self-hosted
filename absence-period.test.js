const test = require('node:test');
const assert = require('node:assert/strict');

const {
  absenceCommandQuery,
  absenceTsvLines,
  copyableCodeBlocks,
  parseAbsencePeriod,
} = require('./absence-period');

const now = new Date('2026-07-23T10:00:00.000Z');

test('absence command extraction accepts both supported command spellings', () => {
  assert.equal(absenceCommandQuery('!absent current'), 'current');
  assert.equal(absenceCommandQuery('  !ABSENCES july week 1  '), 'july week 1');
  assert.equal(absenceCommandQuery('!absence current'), null);
});

test('absence periods resolve current and previous Sunday-based weeks', () => {
  assert.deepEqual(
    parseAbsencePeriod('current', { now, timezone: 'Asia/Dhaka' }),
    {
      kind: 'current',
      start: '2026-07-19',
      end: '2026-07-23',
      label: 'Current week (2026-07-19 to 2026-07-23)',
    },
  );
  assert.deepEqual(
    parseAbsencePeriod('previous', { now, timezone: 'Asia/Dhaka' }),
    {
      kind: 'previous',
      start: '2026-07-12',
      end: '2026-07-18',
      label: 'Previous week (2026-07-12 to 2026-07-18)',
    },
  );
});

test('absence periods understand month week numbers as days 1-7, 8-14, and so on', () => {
  assert.deepEqual(
    parseAbsencePeriod('july week 1', { now, timezone: 'Asia/Dhaka' }),
    {
      kind: 'month-week',
      start: '2026-07-01',
      end: '2026-07-07',
      label: 'July 2026 week 1 (2026-07-01 to 2026-07-07)',
    },
  );
  assert.equal(
    parseAbsencePeriod('february week 5 2024', { now, timezone: 'Asia/Dhaka' }).end,
    '2024-02-29',
  );
});

test('absence period accepts a date and rejects unclear input', () => {
  const period = parseAbsencePeriod('2026-07-16', { now, timezone: 'Asia/Dhaka' });
  assert.equal(period.start, '2026-07-12');
  assert.equal(period.end, '2026-07-18');
  assert.throws(() => parseAbsencePeriod('july first week', { now }), /Use `current`/);
});

test('private absence output is tab-separated and safely chunked for one-click copying', () => {
  const lines = absenceTsvLines([{
    name: 'Student\nOne',
    email: 'student@example.com',
    phone: '+8801000000000',
    username: 'student.one',
    absentDays: 3,
    longestStreak: 3,
    absentDates: ['2026-07-19', '2026-07-20', '2026-07-21'],
  }]);
  assert.match(lines[0], /Name\tEmail\tPhone/);
  assert.doesNotMatch(lines[1], /\n/);
  const blocks = copyableCodeBlocks(lines, 120);
  assert.ok(blocks.length >= 1);
  assert.ok(blocks.every(block => block.length <= 120));
  assert.ok(blocks.every(block => block.startsWith('```text\n') && block.endsWith('\n```')));
});
