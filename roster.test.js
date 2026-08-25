const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDiscordSyncPeople,
  createRosterSyncCoordinator,
  isExcluded,
  rosterForBackfill,
  setRosterSnapshot,
} = require('./roster');

const cohort = { name: 'TEST', guildId: 'guild-1', supervisorIds: ['supervisor-1'] };

test('excludes non-white Sheet rows from every active-student workflow', () => {
  setRosterSnapshot(cohort, [], []);
  assert.equal(isExcluded(cohort, { discordId: 'student-1', status: '', active: false }), true);
  assert.equal(isExcluded(cohort, { discordId: 'student-2', status: '', active: true }), false);
});

test('keeps explicit hired, left, supervisor, and manual exclusions inactive', () => {
  setRosterSnapshot(cohort, [], ['manual-1']);
  assert.equal(isExcluded(cohort, { discordId: 'supervisor-1', status: '', active: true }), true);
  assert.equal(isExcluded(cohort, { discordId: 'student-1', status: 'hired', active: true }), true);
  assert.equal(isExcluded(cohort, { discordId: 'student-2', status: 'left', active: true }), true);
  assert.equal(isExcluded(cohort, { discordId: 'manual-1', status: '', active: true }), true);
});

test('Discord-primary sync payload contains only current non-bot, non-supervisor students', () => {
  const members = new Map([
    ['student-1', {
      id: 'student-1',
      nickname: 'Student Nickname',
      user: { bot: false, username: 'student.user', globalName: 'Student Name' },
    }],
    ['supervisor-1', {
      id: 'supervisor-1',
      nickname: null,
      user: { bot: false, username: 'supervisor', globalName: null },
    }],
    ['bot-1', {
      id: 'bot-1',
      nickname: null,
      user: { bot: true, username: 'bot', globalName: null },
    }],
  ]);

  assert.deepEqual(buildDiscordSyncPeople(members, ['supervisor-1']), [{
    discordId: 'student-1',
    username: 'student.user',
    globalName: 'Student Name',
    nickname: 'Student Nickname',
    displayName: 'Student Nickname',
  }]);
});

test('coalesces concurrent roster refreshes and reuses a recent successful write', async () => {
  let now = 1000;
  let runs = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const coordinator = createRosterSyncCoordinator({
    reuseMs: 60000,
    now: () => now,
    run: async () => {
      runs++;
      await gate;
      return { activeRows: 4 };
    },
  });
  const current = { guildId: 'guild-sync' };

  const first = coordinator.sync({}, current);
  const second = coordinator.sync({}, current);
  release();
  assert.deepEqual(await first, { activeRows: 4 });
  assert.deepEqual(await second, { activeRows: 4 });
  assert.equal(runs, 1);

  assert.deepEqual(await coordinator.sync({}, current), { activeRows: 4 });
  assert.equal(runs, 1);
  now += 60001;
  assert.deepEqual(await coordinator.sync({}, current), { activeRows: 4 });
  assert.equal(runs, 2);
});

test('manual forced roster refresh bypasses only the recent-success cache', async () => {
  let runs = 0;
  const coordinator = createRosterSyncCoordinator({
    reuseMs: 60000,
    run: async () => ({ run: ++runs }),
  });
  const current = { guildId: 'guild-force' };
  assert.deepEqual(await coordinator.sync({}, current), { run: 1 });
  assert.deepEqual(await coordinator.sync({}, current, { force: true }), { run: 2 });
});

test('historical backfills fall back to the last durable roster after a transient refresh failure', async () => {
  const existing = [{ discordId: 'student-1', email: 'student@example.com' }];
  const result = await rosterForBackfill({}, cohort, {
    sync: async () => { throw new Error('Roster write returned HTTP 404'); },
    read: async (requestedCohort, force) => {
      assert.equal(requestedCohort, cohort);
      assert.equal(force, true);
      return existing;
    },
  });
  assert.equal(result.refreshed, false);
  assert.deepEqual(result.roster, existing);
  assert.match(result.refreshWarning, /HTTP 404/);
});
