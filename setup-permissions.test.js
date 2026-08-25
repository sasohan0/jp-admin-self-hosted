const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, OverwriteType } = require('discord.js');

const registerSetup = require('./setup-command');

function fixtures() {
  const everyone = { id: 'everyone-role', kind: 'role' };
  const supervisorA = { id: 'supervisor-a', user: { id: 'supervisor-a', kind: 'user' } };
  const guild = {
    roles: {
      everyone,
      resolve: id => id === everyone.id ? everyone : null,
    },
    members: {
      resolve: id => id === supervisorA.id ? supervisorA : null,
      fetch: async id => {
        if (id === supervisorA.id) return supervisorA;
        throw Object.assign(new Error('Unknown Member'), { code: 10007, status: 404 });
      },
    },
  };
  const client = { user: { id: 'bot-user', kind: 'user' } };
  const cohort = { supervisorIds: ['supervisor-a', 'supervisor-b'] };
  return { guild, client, cohort };
}

test('permission overwrite data explicitly identifies roles and members', () => {
  const { guild, client, cohort } = fixtures();
  const overwrites = registerSetup.permissionOverwrites(
    { private: true },
    guild,
    client,
    cohort,
  );

  assert.equal(overwrites[0].id, 'everyone-role');
  assert.equal(overwrites[0].type, OverwriteType.Role);
  assert.deepEqual(overwrites.slice(1).map(item => item.type), [
    OverwriteType.Member,
    OverwriteType.Member,
    OverwriteType.Member,
  ]);
});

test('permission repair resolves real targets, skips absent supervisors, and continues', async () => {
  const { guild, client, cohort } = fixtures();
  const calls = [];
  const channel = {
    permissionOverwrites: {
      edit: async (...args) => { calls.push(args); },
    },
  };

  const result = await registerSetup.repairPermissions(
    channel,
    { lockedPosting: true },
    guild,
    client,
    cohort,
  );

  assert.equal(calls.length, 3);
  assert.equal(calls[0][0].id, 'everyone-role');
  assert.equal(calls[0][2].type, OverwriteType.Role);
  assert.equal(calls[1][0].id, 'supervisor-a');
  assert.equal(calls[1][2].type, OverwriteType.Member);
  assert.equal(calls[2][0].id, 'bot-user');
  assert.equal(calls[2][2].type, OverwriteType.Member);
  assert.equal(calls[2][2].reason, 'JP ADMIN standard channel permissions');
  assert.deepEqual(result.warnings, [
    'configured supervisor `supervisor-b` is not currently in this server',
  ]);
});

test('removing a supervisor revokes their existing standard private overwrite', async () => {
  const removed = [];
  const channel = {
    id: 'bot-admin-channel',
    name: 'bot-admin',
    type: 0,
    permissionOverwrites: {
      cache: new Map([['former-supervisor', {}]]),
      delete: async (id, reason) => { removed.push({ id, reason }); },
    },
  };
  const guild = {
    channels: {
      fetch: async () => new Collection([[channel.id, channel]]),
    },
  };
  const cohort = {
    channels: { supervisor: channel.id },
  };

  const result = await registerSetup.removeStandardSupervisorPermissions(
    guild,
    cohort,
    'former-supervisor',
  );

  assert.deepEqual(removed, [{
    id: 'former-supervisor',
    reason: 'JP ADMIN supervisor access removed',
  }]);
  assert.deepEqual(result, { removed: ['#bot-admin'], failed: [] });
});
