'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeAccessRules,
  normalizeAccessAction,
  removeAccessRule,
  setMemberStatusRole,
  upsertAccessRule,
  defaultJobPostRules,
} = require('./student-access');

test('plain-language block aliases map to durable access actions', () => {
  assert.equal(normalizeAccessAction('block'), 'deny');
  assert.equal(normalizeAccessAction('unblock'), 'remove');
  assert.equal(normalizeAccessAction('allow'), 'allow');
});

test('access rules reject malformed IDs/actions and keep one rule per role/channel pair', () => {
  const first = { roleId: '123456789012345', channelId: '223456789012345', view: 'deny' };
  const rules = normalizeAccessRules([
    first, { ...first, view: 'allow' },
    { roleId: 'bad', channelId: first.channelId, view: 'deny' },
  ]);
  assert.deepEqual(rules, [{ ...first, view: 'allow' }]);
  assert.deepEqual(upsertAccessRule(rules, first), [first]);
  assert.deepEqual(removeAccessRule([first], first.roleId, first.channelId), []);
});

test('default job-post visibility blocks only the inactive role', async () => {
  const active = { id: '123456789012345', name: 'Active Student', position: 1 };
  const inactive = { id: '223456789012345', name: 'Inactive Student', position: 1 };
  const guild = {
    roles: { fetch: async () => new Map([[active.id, active], [inactive.id, inactive]]) },
    members: { me: { roles: { highest: { position: 10 } } } },
  };
  assert.deepEqual(await defaultJobPostRules(guild, {
    channels: { jobPosts: '323456789012345' },
  }), [{ roleId: inactive.id, channelId: '323456789012345', view: 'deny' }]);
});

test('status-role change removes the opposite role before assigning the target', async () => {
  const calls = [];
  const member = {
    roles: {
      cache: new Map([['inactive-id', {}]]),
      remove: async role => calls.push(`remove:${role.id}`),
      add: async role => calls.push(`add:${role.id}`),
    },
  };
  const roles = { active: { id: 'active-id' }, inactive: { id: 'inactive-id' } };
  await setMemberStatusRole(member, 'active', roles);
  assert.deepEqual(calls, ['remove:inactive-id', 'add:active-id']);
});

test('hired/left status clears both student status roles', async () => {
  const calls = [];
  const member = {
    roles: {
      cache: new Map([['active-id', {}], ['inactive-id', {}]]),
      remove: async role => calls.push(role.id),
      add: async () => assert.fail('clear must not add a role'),
    },
  };
  const roles = { active: { id: 'active-id' }, inactive: { id: 'inactive-id' } };
  await setMemberStatusRole(member, 'cleared', roles);
  assert.deepEqual(calls, ['active-id', 'inactive-id']);
});
