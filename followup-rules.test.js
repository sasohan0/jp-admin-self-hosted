'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  consecutiveAbsencePairDates,
  currentGuildStudents,
  newWarningIncident,
  undoLatestWarningIncident,
  parseFollowupCommand,
  quotaGapStudents,
  workingDatesBetween,
} = require('./followup-rules');

test('currentGuildStudents excludes stale Sheet IDs that are no longer in the cohort guild', () => {
  const roster = [
    { discordId: '100', name: 'Current' },
    { discordId: '200', name: 'Left server' },
    { discordId: '', name: 'Unmapped' },
  ];
  assert.deepEqual(currentGuildStudents(roster, new Set(['100'])), [roster[0]]);
});

test('manual follow-up command accepts threshold and optional destination channel', () => {
  assert.deepEqual(parseFollowupCommand('!followup jobs days 2 <#1534781683524571235>'), {
    action: 'preview', kind: 'jobs', threshold: 2, channelId: '1534781683524571235',
  });
  assert.equal(parseFollowupCommand('!followup attendance 0').action, 'invalid-threshold');
  assert.equal(parseFollowupCommand('hello'), null);
});

test('working-date enumeration respects weekly days and exact holiday overrides', () => {
  const calendar = {
    workdays: [0, 1, 2, 3, 4],
    overrides: {
      '2026-08-17': { type: 'holiday' },
      '2026-08-21': { type: 'working' },
    },
  };
  assert.deepEqual(workingDatesBetween(calendar, '2026-08-16', '2026-08-22'), [
    '2026-08-16', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21',
  ]);
});

test('quota gaps exclude approved leave dates and report today/week shortages', () => {
  const result = quotaGapStudents({
    students: [{
      email: 'a@example.com',
      jobDays: { '2026-08-16': 3, '2026-08-17': 7, '2026-08-18': 2 },
      leaveDays: { '2026-08-17': true },
    }],
    roster: [{ email: 'a@example.com', discordId: '1', name: 'A' }],
    dates: ['2026-08-16', '2026-08-17', '2026-08-18'],
    target: 10,
    daysKey: 'jobDays',
    minMissedDays: 2,
  });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].missedDates, ['2026-08-16', '2026-08-18']);
  assert.equal(result[0].goal, 20);
  assert.equal(result[0].weekGap, 15);
  assert.equal(result[0].todayGap, 8);
});

test('attendance warning consumes two new absence dates per warning and marks inactive after six', () => {
  let state = {};
  let result = newWarningIncident(state, '123', ['2026-08-10', '2026-08-11']);
  state = result.state;
  assert.equal(result.record.count, 1);
  assert.deepEqual(result.incidentDates, ['2026-08-10', '2026-08-11']);
  assert.equal(result.remaining, 2);
  result = newWarningIncident(state, '123', ['2026-08-10', '2026-08-11']);
  state = result.state;
  assert.equal(result.duplicate, true);
  assert.equal(result.record.count, 1);
  result = newWarningIncident(state, '123', [
    '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13',
  ]);
  state = result.state;
  assert.equal(result.record.count, 2);
  result = newWarningIncident(state, '123', [
    '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13',
    '2026-08-16', '2026-08-17',
  ]);
  assert.equal(result.record.count, 3);
  assert.equal(result.record.inactive, true);
  assert.equal(result.remaining, 0);
  assert.equal(result.record.usedDates.length, 6);
});

test('one warning run never consumes multiple historical pairs', () => {
  const result = newWarningIncident({}, '123', [
    '2026-08-06', '2026-08-09', '2026-08-10',
    '2026-08-11', '2026-08-12', '2026-08-13',
  ]);
  assert.equal(result.added, 1);
  assert.equal(result.record.count, 1);
  assert.deepEqual(result.incidentDates, ['2026-08-06', '2026-08-09']);
  assert.equal(result.record.inactive, false);
});

test('rerunning the same attendance date cannot consume another historical pair', () => {
  const dates = ['2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16'];
  const first = newWarningIncident({}, '123', dates, 3, '2026-08-16');
  assert.equal(first.record.count, 1);

  const second = newWarningIncident(first.state, '123', dates, 3, '2026-08-16');
  assert.equal(second.duplicate, true);
  assert.equal(second.record.count, 1);
  assert.deepEqual(second.record.usedDates, ['2026-08-13', '2026-08-14']);
});

test('warning state separates evaluated attendance date from email issue date', () => {
  const result = newWarningIncident({}, '123', ['2026-08-19', '2026-08-20'], 3,
    '2026-08-22', '2026-08-23');
  assert.equal(result.record.lastEvaluatedDate, '2026-08-22');
  assert.equal(result.record.lastWarningDate, '2026-08-23');
});

test('undoing the latest warning preserves earlier valid warning history', () => {
  const result = undoLatestWarningIncident({
    123: {
      count: 2,
      usedDates: ['2026-08-13', '2026-08-14', '2026-08-19', '2026-08-20'],
      lastIncident: '2026-08-19,2026-08-20',
      inactive: false,
    },
  }, '123');
  assert.equal(result.changed, true);
  assert.equal(result.count, 1);
  assert.deepEqual(result.removedDates, ['2026-08-19', '2026-08-20']);
  assert.deepEqual(result.state['123'].usedDates, ['2026-08-13', '2026-08-14']);
  assert.equal(result.state['123'].lastIncident, '2026-08-13,2026-08-14');
});

test('undo never reactivates an unrelated manual inactive status', () => {
  const result = undoLatestWarningIncident({
    123: { count: 3, usedDates: ['2026-08-19', '2026-08-20'], lastIncident: '2026-08-19,2026-08-20', inactive: true, inactiveSource: 'manual' },
  }, '123');
  assert.equal(result.wasInactive, false);
  assert.equal(result.count, 2);
});

test('warning rebase uses one shared start date and repairs unfair inactivity', () => {
  const { rebaseWarningState } = require('./followup-rules');
  const result = rebaseWarningState({
    unfair: {
      count: 3, inactive: true,
      usedDates: ['2026-08-06', '2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13'],
    },
    fair: { count: 1, inactive: false, usedDates: ['2026-08-13', '2026-08-16'] },
  }, '2026-08-13', {
    unfair: ['2026-08-13', '2026-08-16'],
    fair: ['2026-08-13', '2026-08-16'],
  }, ['2026-08-13', '2026-08-16']);
  assert.equal(result.state.unfair.count, 1);
  assert.equal(result.state.unfair.inactive, false);
  assert.deepEqual(result.state.unfair.usedDates, ['2026-08-13', '2026-08-16']);
  assert.deepEqual(result.reactivateIds, ['unfair']);
  assert.equal(result.state.fair.count, 1);
});

test('attendance warning pairs require consecutive recorded sessions', () => {
  const sessions = ['2026-08-13', '2026-08-14', '2026-08-16', '2026-08-17'];
  assert.deepEqual(consecutiveAbsencePairDates(
    ['2026-08-13', '2026-08-16'], sessions, '2026-08-13'), []);
  assert.deepEqual(consecutiveAbsencePairDates(
    ['2026-08-13', '2026-08-14', '2026-08-16'], sessions, '2026-08-13'),
  ['2026-08-13', '2026-08-14']);
  assert.deepEqual(consecutiveAbsencePairDates(
    ['2026-08-13', '2026-08-14', '2026-08-16', '2026-08-17'], sessions, '2026-08-13'),
  ['2026-08-13', '2026-08-14', '2026-08-16', '2026-08-17']);
});
