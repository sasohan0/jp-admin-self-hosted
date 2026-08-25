const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { formatCohortLine } = require('./cohort-status');

test('server-specific cohort status contains health but no backend credentials', () => {
  const line = formatCohortLine({
    cohort: {
      name: 'STRIDE',
      appsScriptUrl: 'https://secret.example/exec',
      apiKey: 'never-print-this',
    },
    guildOk: true,
    backend: 'v25 · STRIDE',
    channelCount: 14,
  });
  assert.match(line, /STRIDE/);
  assert.match(line, /v25/);
  assert.doesNotMatch(line, /secret\.example|never-print-this/);
});

test('cohort status resolves and checks only the command guild', () => {
  const source = fs.readFileSync(require.resolve('./cohort-status'), 'utf8');
  assert.match(source, /findCohort\(msg\.guildId\)/);
  assert.match(source, /current\.supervisorIds\.includes\(msg\.author\.id\)/);
  assert.doesNotMatch(source, /cohorts\.every|for\s*\(\s*const cohort of cohorts/);
});
