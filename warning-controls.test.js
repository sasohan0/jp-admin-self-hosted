'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWarningCommand, tsvCell, warningReportRows } = require('./warning-controls');

test('warning commands support inspect, reset, shared baseline, and private weekly report', () => {
  assert.deepEqual(parseWarningCommand('!warningreport'), { action: 'report' });
  assert.deepEqual(parseWarningCommand('!warnings <@123456789012345678>'), {
    action: 'inspect', discordId: '123456789012345678',
  });
  assert.deepEqual(parseWarningCommand('!warnings reset 123456789012345678'), {
    action: 'reset', discordId: '123456789012345678',
  });
  assert.deepEqual(parseWarningCommand('!warnings undo <@123456789012345678>'), {
    action: 'undo', discordId: '123456789012345678',
  });
  assert.deepEqual(parseWarningCommand('!warnings start 2026-08-13'), {
    action: 'start', date: '2026-08-13',
  });
  assert.deepEqual(parseWarningCommand('!warning rebase 2026-08-13'), {
    action: 'start', date: '2026-08-13',
  });
  assert.deepEqual(parseWarningCommand('!warnings start'), { action: 'start-status' });
  assert.equal(parseWarningCommand('hello'), null);
});

test('warning report merges inactive state, warning counts, and absences', () => {
  const rows = warningReportRows([
    { discordId: '1', name: 'Inactive', email: 'a@example.com' },
    { discordId: '2', name: 'Absent', email: 'b@example.com' },
    { discordId: '3', name: 'Clear', email: 'c@example.com' },
  ], new Set(['1']), {
    1: { count: 3 }, 2: { count: 1 },
  }, [{ discordId: '2', absentDays: 2, longestStreak: 2, absentDates: ['2026-08-10', '2026-08-11'] }]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].inactive, true);
  assert.equal(rows[1].warningCount, 1);
  assert.equal(rows[1].absentDays, 2);
});

test('warning report TSV preserves numeric zero values', () => {
  assert.equal(tsvCell(0), '0');
  assert.equal(tsvCell(null), '');
});
