'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMailerAudience,
  normalizeEmailList,
  normalizeMailerConfig,
  renderTemplate,
} = require('./mailer-rules');

test('mailer address lists are normalized, deduplicated, and invalid addresses are removed', () => {
  assert.deepEqual(normalizeEmailList('A@Example.com, a@example.com; bad, b@example.com'), [
    'a@example.com', 'b@example.com',
  ]);
  const config = normalizeMailerConfig({ enabled: true, to: ['owner@example.com'] }, 'SCPC-13');
  assert.equal(config.enabled, true);
  assert.equal(config.senderName, 'Job Placement — Programming Hero');
  assert.deepEqual(config.cc, ['solih@programming-hero.com']);
});

test('legacy cohort sender migrates and mandatory Programming Hero CC cannot be removed', () => {
  const config = normalizeMailerConfig({
    senderName: 'SCPC-13 Job Placement',
    cc: [],
  }, 'SCPC-13');
  assert.equal(config.senderName, 'Job Placement — Programming Hero');
  assert.deepEqual(config.cc, ['solih@programming-hero.com']);

  const customized = normalizeMailerConfig({
    senderName: 'Custom Placement Desk',
    cc: ['extra@example.com', 'solih@programming-hero.com'],
  }, 'NEW-COHORT');
  assert.equal(customized.senderName, 'Custom Placement Desk');
  assert.deepEqual(customized.cc, ['solih@programming-hero.com', 'extra@example.com']);
});

test('warning recipients are excluded from the same-day absence email', () => {
  const roster = [
    { discordId: '1', email: 'warning@example.com', status: '' },
    { discordId: '2', email: 'absent@example.com', status: '' },
    { discordId: '3', email: 'inactive@example.com', status: '' },
  ];
  const audience = buildMailerAudience({
    roster,
    absentStudents: roster,
    date: '2026-08-21',
    warningState: {
      1: { count: 1, lastEvaluatedDate: '2026-08-21' },
      3: { count: 3, lastEvaluatedDate: '2026-08-20' },
    },
    isInactive: student => student.discordId === '3',
  });
  assert.deepEqual(audience.warning1.map(item => item.discordId), ['1']);
  assert.deepEqual(audience.absent.map(item => item.discordId), ['2']);
  assert.deepEqual(audience.inactive, []);
});

test('third-warning mail is generated only on its incident date', () => {
  const roster = [{ discordId: '1', email: 'one@example.com', status: '' }];
  const state = { 1: { count: 3, lastEvaluatedDate: '2026-08-21' } };
  assert.equal(buildMailerAudience({
    roster, absentStudents: roster, warningState: state, date: '2026-08-21',
  }).inactive.length, 1);
  assert.equal(buildMailerAudience({
    roster, absentStudents: roster, warningState: state, date: '2026-08-22',
  }).inactive.length, 0);
});

test('same-day manual warnings use their issued timestamp when an older attendance date was evaluated', () => {
  const roster = [
    { discordId: '1', email: 'warning@example.com', status: '' },
    { discordId: '2', email: 'inactive@example.com', status: '' },
  ];
  const warningState = {
    1: { count: 2, lastEvaluatedDate: '2026-08-22', updatedAt: '2026-08-23T03:00:00.000Z' },
    2: { count: 3, lastEvaluatedDate: '2026-08-22', lastWarningDate: '2026-08-23', inactive: true },
  };
  const audience = buildMailerAudience({
    roster, absentStudents: roster, warningState, date: '2026-08-23',
    isInactive: student => student.discordId === '2',
  });
  assert.deepEqual(audience.warning2.map(item => item.discordId), ['1']);
  assert.deepEqual(audience.inactive.map(item => item.discordId), ['2']);
});

test('presence today suppresses warning mail from an older absence pair', () => {
  const present = { discordId: '1', email: 'present@example.com', status: '' };
  const absent = { discordId: '2', email: 'absent@example.com', status: '' };
  const warningState = {
    1: { count: 2, lastWarningDate: '2026-08-23' },
    2: { count: 2, lastWarningDate: '2026-08-23' },
  };
  const audience = buildMailerAudience({
    roster: [present, absent], absentStudents: [absent], warningState, date: '2026-08-23',
  });
  assert.deepEqual(audience.warning2.map(item => item.discordId), ['2']);
  assert.equal(audience.warning2.some(item => item.discordId === '1'), false);
});

test('already inactive and duplicate-email absences remain visible as skipped audit groups', () => {
  const roster = [
    { discordId: '1', email: 'inactive@example.com', status: '', active: false },
    { discordId: '2', email: 'same@example.com', status: '' },
    { discordId: '3', email: 'same@example.com', status: '' },
  ];
  const audience = buildMailerAudience({
    roster,
    absentStudents: roster,
    date: '2026-08-23',
    isInactive: student => student.active === false,
  });
  assert.deepEqual(audience.absent.map(item => item.discordId), ['2']);
  assert.deepEqual(audience.skippedInactive.map(item => item.discordId), ['1']);
  assert.deepEqual(audience.skippedDuplicateEmail.map(item => item.discordId), ['3']);
});

test('templates replace supported variables while leaving unknown placeholders visible', () => {
  assert.equal(renderTemplate('{{cohort}} {{date}} {{unknown}}', {
    cohort: 'SCPC-13', date: '2026-08-21',
  }), 'SCPC-13 2026-08-21 {{unknown}}');
});
