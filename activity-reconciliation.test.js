'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('daily activity reconciliation is calendar-day, bounded, silent, and idempotent', () => {
  const source = fs.readFileSync(require.resolve('./activity-reconciliation'), 'utf8');
  assert.match(source, /scheduleAtSettingEveryDay/);
  assert.match(source, /activityreconciletime/);
  assert.match(source, /maxMessages: 1000/);
  assert.match(source, /writeHistoricalSummary: false/);
  assert.match(source, /backfillInterviewHistory/);
  assert.match(source, /backfillOutreachHistory/);
  assert.match(source, /rosterState = await rosterForBackfill/);
  assert.equal((source.match(/rosterState,/g) || []).length >= 2, true);
});

test('calendar-day scheduler does not consult the work calendar', () => {
  const source = fs.readFileSync(require.resolve('./runtime-schedule'), 'utf8');
  const start = source.indexOf('function scheduleAtSettingEveryDay');
  const end = source.indexOf('function scheduleEveryMinute', start);
  const helper = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(helper, /getCalendarDay/);
  assert.match(helper, /runIfDue/);
});
