const test = require('node:test');
const assert = require('node:assert/strict');
const { currentWorkWeek, rankWeeklyStudents, weeklyLine } = require('./weekly-ranking');

test('currentWorkWeek starts Sunday and includes the current cohort date', () => {
  const range = currentWorkWeek(new Date('2026-07-16T12:00:00Z'), 'Asia/Dhaka');
  assert.deepEqual(range, {
    start: '2026-07-12',
    end: '2026-07-16',
    keys: ['2026-07-12', '2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16'],
  });
});

test('ranking uses applications and attendance as the two primary metrics', () => {
  const ranked = rankWeeklyStudents([
    { name: 'Attendance wins tie', jobs: 20, attendance: 5, interviews: 0 },
    { name: 'More interviews', jobs: 20, attendance: 4, interviews: 10 },
    { name: 'Most applications', jobs: 21, attendance: 0, interviews: 0 },
  ]);
  assert.deepEqual(ranked.map(s => s.name), ['Most applications', 'Attendance wins tie', 'More interviews']);
});

test('public weekly line contains performance but no private contact field', () => {
  const line = weeklyLine(
    { name: 'Student', jobs: 9, attendance: 4, interviews: 3, rtbrRank: 2, rtbrPoints: 31, phone: '01700000000' },
    1,
    { jobs: 50, attendance: 5 }
  );
  assert.match(line, /Apps \*\*9\/50\*\*/);
  assert.match(line, /Attendance \*\*4\/5\*\*/);
  assert.match(line, /Total interviews \*\*3\*\*/);
  assert.match(line, /RTBR \*\*#2 · 31 pts\*\*/);
  assert.doesNotMatch(line, /01700000000|phone|whatsapp/i);
});
