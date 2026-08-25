const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applySupervisorChange,
  deriveRegistryKey,
  parseSupervisorCommand,
  parseSupervisorIds,
  supervisorListPayload,
  validateDeployHookUrl,
} = require('./cohort-manager');

test('cohort manager derives stable registry keys from display names', () => {
  assert.equal(deriveRegistryKey(' EJP-14 / Evening '), 'ejp_14_evening');
  assert.throws(() => deriveRegistryKey('---'), /letters or numbers/);
});

test('cohort manager parses and deduplicates supervisor IDs', () => {
  assert.deepEqual(
    parseSupervisorIds('111111111111111111, 222222222222222222 111111111111111111'),
    ['111111111111111111', '222222222222222222'],
  );
  assert.throws(() => parseSupervisorIds('someone'), /Discord user IDs/);
});

test('server-local supervisor commands accept mentions and raw Discord IDs', () => {
  assert.deepEqual(parseSupervisorCommand('!supervisor'), { action: 'list', userId: '' });
  assert.deepEqual(parseSupervisorCommand('!supervisors list'), { action: 'list', userId: '' });
  assert.deepEqual(parseSupervisorCommand('!supervisor add <@!111111111111111111>'), {
    action: 'add',
    userId: '111111111111111111',
  });
  assert.deepEqual(parseSupervisorCommand('!supervisor remove 222222222222222222'), {
    action: 'remove',
    userId: '222222222222222222',
  });
  assert.equal(parseSupervisorCommand('!students'), null);
  assert.throws(() => parseSupervisorCommand('!supervisor add somebody'), /Discord ID/);
});

test('supervisor changes are idempotent and prevent self-lockout', () => {
  const current = ['111111111111111111', '222222222222222222'];
  assert.deepEqual(
    applySupervisorChange(current, 'add', '333333333333333333', '111111111111111111'),
    { ids: [...current, '333333333333333333'], changed: true },
  );
  assert.deepEqual(
    applySupervisorChange(current, 'add', current[1], current[0]),
    { ids: current, changed: false },
  );
  assert.deepEqual(
    applySupervisorChange(current, 'remove', current[1], current[0]),
    { ids: [current[0]], changed: true },
  );
  assert.throws(
    () => applySupervisorChange(current, 'remove', current[0], current[0]),
    /cannot remove yourself/,
  );
});

test('supervisor list is private and never creates a live mention', () => {
  const payload = supervisorListPayload({
    name: 'TEST',
    supervisorIds: ['111111111111111111'],
  });
  assert.match(payload.embeds[0].description, /111111111111111111/);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
});

test('cohort manager accepts only a service-specific Render deploy hook', () => {
  const hook = validateDeployHookUrl(
    'https://api.render.com/deploy/srv-abc123?key=private',
    'srv-abc123',
  );
  assert.equal(hook.hostname, 'api.render.com');
  assert.throws(
    () => validateDeployHookUrl('https://example.com/deploy/srv-abc123?key=private'),
    /Render deploy hook/,
  );
  assert.throws(
    () => validateDeployHookUrl(
      'https://api.render.com/deploy/srv-other?key=private',
      'srv-abc123',
    ),
    /different Render service/,
  );
  assert.throws(
    () => validateDeployHookUrl('https://api.render.com/deploy/srv-abc123'),
    /Render deploy hook/,
  );
});
