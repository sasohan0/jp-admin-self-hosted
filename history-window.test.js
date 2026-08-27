'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_HISTORY_DAYS,
  historyWindow,
  historyWindowLabel,
  messageWindowPosition,
  parseHistoryCommand,
} = require('./history-window');

test('history backfill commands default to three days and accept explicit day counts', () => {
  assert.deepEqual(parseHistoryCommand('!backfilloutreach', '!backfilloutreach'), {
    days: DEFAULT_HISTORY_DAYS,
  });
  assert.deepEqual(parseHistoryCommand(' !BACKFILLINTERVIEWS  7 days ', '!backfillinterviews'), { days: 7 });
  assert.deepEqual(parseHistoryCommand('!backfilljobsheets 14d', '!backfilljobsheets'), { days: 14 });
  assert.deepEqual(parseHistoryCommand('!backfilljobsheets 1 day', '!backfilljobsheets'), { days: 1 });
  assert.equal(parseHistoryCommand('!jobscheck', '!backfilljobsheets'), null);
});

test('history backfill commands reject unclear or excessive ranges', () => {
  assert.match(parseHistoryCommand('!backfilloutreach forever', '!backfilloutreach').error, /Usage/);
  assert.match(parseHistoryCommand('!backfilloutreach 0 days', '!backfilloutreach').error, /Usage/);
  assert.match(parseHistoryCommand('!backfilloutreach 31 days', '!backfilloutreach').error, /Usage/);
});

test('calendar-day windows include today and the requested preceding local dates', () => {
  const now = Date.parse('2026-08-27T06:00:00.000Z');
  const window = historyWindow(3, 'Asia/Dhaka', now);
  assert.deepEqual(window, {
    days: 3,
    timezone: 'Asia/Dhaka',
    startDate: '2026-08-25',
    endDate: '2026-08-27',
    nowMs: now,
  });
  assert.equal(messageWindowPosition({ createdTimestamp: Date.parse('2026-08-24T17:59:59.000Z') }, window), -1);
  assert.equal(messageWindowPosition({ createdTimestamp: Date.parse('2026-08-24T18:00:00.000Z') }, window), 0);
  assert.equal(messageWindowPosition({ createdTimestamp: Date.parse('2026-08-27T17:59:59.000Z') }, window), 0);
  assert.equal(historyWindowLabel(window), '3 calendar days (2026-08-25 through 2026-08-27)');
});
