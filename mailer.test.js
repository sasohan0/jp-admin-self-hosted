'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  batchesFor,
  mailerAudienceSummary,
  mailerDeliverySummary,
  mailerBatchKey,
  mailerRecipientAudit,
  selectedMailTypes,
} = require('./mailer');
const { normalizeMailerConfig } = require('./mailer-rules');

test('mailer selection expands warnings and all without mixing ordinary absence', () => {
  assert.deepEqual(selectedMailTypes('warnings'), ['warning1', 'warning2', 'inactive']);
  assert.deepEqual(selectedMailTypes('absent'), ['absent']);
  assert.deepEqual(selectedMailTypes('bad'), []);
});

test('mailer delivery summary distinguishes new sends from prior idempotent batches', () => {
  const summary = mailerDeliverySummary([
    { status: 'sent', duplicate: false, count: 11, recipients: 11 },
    { status: 'sent', duplicate: true, count: 2, recipients: 2 },
    { status: 'sent', duplicate: true, count: 2, recipients: 2 },
  ]);
  assert.deepEqual(summary, {
    sentRecipients: 11,
    sentBatches: 1,
    previouslySentRecipients: 4,
    previouslySentBatches: 2,
  });
});

test('large BCC groups reserve Google recipient slots for To, CC, and additional BCC', () => {
  const config = normalizeMailerConfig({
    to: ['mentor@example.com'], cc: ['audit@example.com'], bcc: ['archive@example.com'],
  }, 'SCPC-13');
  const students = Array.from({ length: 48 }, (_, index) => ({ email: `s${index}@example.com` }));
  const batches = batchesFor({
    config, cohort: { name: 'SCPC-13' }, date: '2026-08-21',
    groups: { absent: students, warning1: [], warning2: [], inactive: [] },
  }, ['absent']);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].studentBcc.length, 46);
  assert.equal(batches[1].studentBcc.length, 2);
  assert.equal(batches[0].type, 'absent');
});

test('administrative recipients cannot consume all Google recipient slots', () => {
  const config = normalizeMailerConfig({
    to: Array.from({ length: 50 }, (_, index) => `admin${index}@example.com`),
  }, 'SCPC-13');
  assert.throws(() => batchesFor({
    config, cohort: { name: 'SCPC-13' }, date: '2026-08-21',
    groups: { absent: [{ email: 'student@example.com' }] },
  }, ['absent']), /leave at least one/);
});

test('direct inactive mail has a separate idempotent batch namespace', () => {
  const cohort = { guildId: '1534781682920456192' };
  const batch = { type: 'inactive', part: 1 };
  assert.equal(mailerBatchKey(cohort, {
    date: '2026-08-23', batchScope: 'inactive-roster',
  }, batch), '1534781682920456192:2026-08-23:inactive:inactive-roster:1');
  assert.equal(mailerBatchKey(cohort, { date: '2026-08-23' }, batch),
    '1534781682920456192:2026-08-23:inactive:1');
});

test('private recipient audit lists exact mutually exclusive mail groups', () => {
  const audit = mailerRecipientAudit({
    absent: [{ name: 'Absent Student', email: 'absent@example.com', discordId: '1' }],
    warning1: [{ name: 'Warned Student', email: 'warned@example.com', discordId: '2' }],
    excludedBeforeReport: [{ name: 'Pre-excluded Student', email: 'excluded@example.com', discordId: '5' }],
    skippedInactive: [{ name: 'Inactive Student', email: 'inactive@example.com', discordId: '3' }],
    skippedNoEmail: [{ name: 'Missing Email', email: '', discordId: '4', mailType: 'absent' }],
  }, ['absent', 'warning1']);
  assert.match(audit, /^RESULT\tMAIL TYPE\tNAME\tEMAIL\tDISCORD ID\tREASON/m);
  assert.match(audit, /ELIGIBLE\tabsent\tAbsent Student\tabsent@example.com\t1/);
  assert.match(audit, /ELIGIBLE\twarning1\tWarned Student\twarned@example.com\t2/);
  assert.match(audit, /NOT IN ATTENDANCE REPORT\texcluded\tPre-excluded Student\texcluded@example.com\t5\tExcluded from attendance tracking/);
  assert.match(audit, /SKIPPED\tinactive\tInactive Student\tinactive@example.com\t3\tAlready inactive/);
  assert.match(audit, /SKIPPED\tabsent\tMissing Email\tNO VALID EMAIL\t4\tNo valid student email/);
});

test('mailer audience summary keeps pre-report exclusions outside the attendance total', () => {
  const summary = mailerAudienceSummary({
    absent: Array.from({ length: 11 }, () => ({})),
    warning1: Array.from({ length: 2 }, () => ({})),
    warning2: Array.from({ length: 2 }, () => ({})),
    inactive: [],
    excludedBeforeReport: Array.from({ length: 6 }, () => ({})),
    skippedInactive: [],
    skippedNoEmail: [],
    skippedDuplicateEmail: [],
  }, 15);
  assert.equal(summary.recordedAbsent, 15);
  assert.equal(summary.eligible, 15);
  assert.equal(summary.alreadyInactive, 0);
  assert.equal(summary.excludedBeforeReport, 6);
  assert.equal(summary.unreconciled, 0);
});
