const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_COHORTS,
  buildManagedCohorts,
  loadManagedCohortsWithRetry,
  normalizeManagedEntries,
  serializeCohort,
  stateKey,
  validateAppsScriptUrl,
} = require('./managed-cohorts');

function entry(index = 1) {
  return {
    registryKey: `cohort_${index}`,
    name: `Cohort ${index}`,
    guildId: `${index}`.repeat(18),
    supervisorIds: ['111111111111111111'],
    appsScriptUrl: `https://script.google.com/macros/s/cohort-${index}/exec`,
    apiKey: `private-${index}`,
    timezone: 'Asia/Dhaka',
    channels: {},
    formOpenReminder: '0 21 * * *',
    formCloseReminder: '15 22 * * *',
    outreachCheckCron: '0 20 * * *',
    jobsCheckCron: '30 22 * * *',
    workshopMeetUrl: 'https://meet.google.com/rvp-cihj-txb',
    workshopGptUrl: 'https://chatgpt.com/g/g-6a001f14177c8191a786e3037582ad33-speak-more',
  };
}

test('managed cohort registry builds normal runtime defaults', () => {
  const [cohort] = buildManagedCohorts([entry()]);
  assert.equal(cohort.name, 'Cohort 1');
  assert.equal(cohort.jobs.dailyTarget, 15);
  assert.equal(cohort.questions.weeklyReportCron, '0 18 * * 4');
  assert.deepEqual(serializeCohort(cohort), entry());
});

test('managed cohort registry preserves bootstrap schedule and workshop overrides', () => {
  const custom = {
    ...entry(),
    formOpenReminder: '5 20 * * *',
    formCloseReminder: '5 22 * * *',
    outreachCheckCron: '30 19 * * *',
    jobsCheckCron: '30 23 * * *',
    workshopMeetUrl: 'https://meet.google.com/example',
    workshopGptUrl: 'https://chatgpt.com/g/example',
  };
  assert.deepEqual(serializeCohort(buildManagedCohorts([custom])[0]), custom);
});

test('managed cohort registry migrates historical nightly defaults to 10:30 PM', () => {
  const oldDefault = { ...entry(), jobsCheckCron: '59 23 * * *' };
  const priorDefault = { ...entry(), jobsCheckCron: '0 23 * * *' };
  const custom = { ...entry(), jobsCheckCron: '30 23 * * *' };
  assert.equal(buildManagedCohorts([oldDefault])[0].jobs.checkCron, '30 22 * * *');
  assert.equal(buildManagedCohorts([priorDefault])[0].jobs.checkCron, '30 22 * * *');
  assert.equal(buildManagedCohorts([custom])[0].jobs.checkCron, '30 23 * * *');
});

test('managed cohort registry validates deployed Apps Script URLs', () => {
  assert.equal(
    validateAppsScriptUrl('https://script.google.com/macros/s/example/exec?unused=1#x', 'test'),
    'https://script.google.com/macros/s/example/exec',
  );
  assert.throws(
    () => validateAppsScriptUrl('https://example.com/macros/s/example/exec', 'test'),
    /Google Apps Script/,
  );
  assert.throws(
    () => validateAppsScriptUrl('https://script.google.com/macros/s/example/dev', 'test'),
    /\/exec URL/,
  );
});

test('managed cohort registry rejects duplicates and more than three cohorts', () => {
  assert.equal(MAX_COHORTS, 3);
  assert.throws(
    () => normalizeManagedEntries([entry(1), { ...entry(2), guildId: entry(1).guildId }]),
    /Duplicate managed Discord server ID/,
  );
  assert.throws(
    () => normalizeManagedEntries([entry(1), entry(2), entry(3), entry(4)]),
    /at most 3 cohorts/,
  );
});

test('managed cohort registry requires valid supervisors and never silently truncates secrets', () => {
  assert.throws(
    () => normalizeManagedEntries([{ ...entry(), supervisorIds: ['not-an-id'] }]),
    /Discord user IDs/,
  );
  assert.throws(
    () => normalizeManagedEntries([{ ...entry(), apiKey: 'x'.repeat(1001) }]),
    /1000 characters or fewer/,
  );
});

test('managed registry state key is namespaced to the control guild', () => {
  assert.equal(
    stateKey({ guildId: '123456789012345678' }),
    'managed_cohort_registry_v1_123456789012345678',
  );
});

test('managed registry startup retries transient reads without using stale configuration', async () => {
  let calls = 0;
  const waits = [];
  const retries = [];
  const result = await loadManagedCohortsWithRetry({
    load: async () => {
      calls++;
      if (calls < 3) {
        const error = new Error('temporary timeout');
        error.transient = true;
        throw error;
      }
      return { enabled: true, source: 'stored', count: 1 };
    },
    wait: async delay => waits.push(delay),
    retryDelayMs: 25,
    onRetry: (error, state) => retries.push({ message: error.message, ...state }),
  });

  assert.deepEqual(result, { enabled: true, source: 'stored', count: 1 });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [25, 25]);
  assert.deepEqual(retries.map(item => item.attempt), [1, 2]);
});

test('managed registry startup does not retry invalid durable state', async () => {
  let waited = false;
  await assert.rejects(
    loadManagedCohortsWithRetry({
      load: async () => { throw new Error('Managed registry state is invalid JSON'); },
      wait: async () => { waited = true; },
      maxAttempts: 3,
    }),
    /invalid JSON/,
  );
  assert.equal(waited, false);
});
