const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFinalGroups, chooseProvisionalGroup } = require('./onboarding-groups');

const records = (gender, count, division = 'Dhaka', offset = 0) =>
  Array.from({ length: count }, (_, i) => ({ userId: String(offset + i + 1), gender, division }));

test('final groups never exceed six members', () => {
  const groups = buildFinalGroups([...records('female', 13), ...records('male', 8, 'Dhaka', 20)]);
  assert.ok(groups.length > 1);
  assert.ok(groups.every(g => g.members.length <= 6));
});

test('female and male members are separated when possible', () => {
  const groups = buildFinalGroups([...records('female', 5), ...records('male', 5, 'Dhaka', 10)]);
  for (const group of groups) {
    const genders = new Set(group.members.map(m => m.gender).filter(g => g !== 'private'));
    assert.ok(genders.size <= 1);
  }
});

test('members are never grouped across divisions', () => {
  const groups = buildFinalGroups([...records('female', 3, 'Dhaka'), ...records('female', 3, 'Sylhet', 10)]);
  assert.ok(groups.every(g => g.members.every(m => m.division === g.division)));
});

test('provisional assignment avoids an opposite-gender group', () => {
  const maleGroup = { division: 'Dhaka', roleName: 'Male group', genders: new Set(['male']), members: [{}, {}] };
  const femaleGroup = { division: 'Dhaka', roleName: 'Female group', genders: new Set(['female']), members: [{}, {}, {}] };
  const selected = chooseProvisionalGroup([maleGroup, femaleGroup], { division: 'Dhaka', gender: 'female' });
  assert.equal(selected.roleName, 'Female group');
});
