const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSetupCohortSheetCommand,
  formatSetupError,
} = require('./cohort-sheet-command');

test('cohort workbook command defaults to non-destructive repair', () => {
  assert.deepEqual(parseSetupCohortSheetCommand('!setupcohortsheet'), {
    mode: 'repair',
    confirmed: false,
    spreadsheetReference: '',
  });
  assert.deepEqual(
    parseSetupCohortSheetCommand(
      '!setupcohortsheet https://docs.google.com/spreadsheets/d/example-sheet-id-1234567890/edit'),
    {
      mode: 'repair',
      confirmed: false,
      spreadsheetReference:
        'https://docs.google.com/spreadsheets/d/example-sheet-id-1234567890/edit',
    },
  );
});

test('cleanup and fresh workbook modes require an explicit confirm token', () => {
  assert.deepEqual(parseSetupCohortSheetCommand('!setupcohortsheet cleanup confirm'), {
    mode: 'cleanup',
    confirmed: true,
    spreadsheetReference: '',
  });
  assert.deepEqual(parseSetupCohortSheetCommand(
    '!setupcohortsheet fresh confirm example-sheet-id-1234567890'), {
    mode: 'fresh',
    confirmed: true,
    spreadsheetReference: 'example-sheet-id-1234567890',
  });
});

test('unrelated messages are ignored by cohort workbook parser', () => {
  assert.equal(parseSetupCohortSheetCommand('!setupsheets existing'), null);
});

test('Drive authorization failures return a concise recovery instruction', () => {
  assert.equal(
    formatSetupError(new Error(
      'Exception: You do not have permission to call DriveApp.getFileById. Required permissions: drive')),
    'This cohort is still running the old Drive-permission backup method. Deploy the current Apps Script source on the existing `/exec` URL, then retry this command.',
  );
  assert.equal(
    formatSetupError(new Error('Apps Script returned non-JSON (HTTP 500)')),
    'Apps Script returned non-JSON (HTTP 500)',
  );
});

