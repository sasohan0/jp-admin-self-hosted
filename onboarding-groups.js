// Pure grouping helpers kept separate so the role distribution can be tested
// without connecting to Discord.

const MAX_GROUP_SIZE = 6;
const FRUITS = [
  'Mango', 'Jackfruit', 'Lychee', 'Guava', 'Coconut', 'Pineapple',
  'Starfruit', 'Jamun', 'Papaya', 'Watermelon', 'Orange', 'Banana',
  'Dragon Fruit', 'Pomegranate', 'Olive', 'Tamarind',
];

function chunks(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

function safeDivision(division) {
  return String(division || 'Other').replace(/[\r\n@]/g, '').trim().slice(0, 35) || 'Other';
}

function identityRoleName(division, index) {
  const fruit = FRUITS[index % FRUITS.length];
  const cycle = Math.floor(index / FRUITS.length);
  return `Bootcamp · ${safeDivision(division)} · ${fruit}${cycle ? ` ${cycle + 1}` : ''}`;
}

// Build stable final groups. Female and male members are partitioned
// separately; people who prefer not to say are placed in the smallest group
// with capacity, or in their own group when needed.
function buildFinalGroups(records, maxSize = MAX_GROUP_SIZE) {
  const byDivision = new Map();
  for (const record of records) {
    if (!record?.userId || !record.division || !record.gender) continue;
    const list = byDivision.get(record.division) || [];
    list.push(record);
    byDivision.set(record.division, list);
  }

  const result = [];
  for (const division of [...byDivision.keys()].sort()) {
    const people = byDivision.get(division).sort((a, b) => String(a.userId).localeCompare(String(b.userId)));
    const female = people.filter(r => r.gender === 'female');
    const male = people.filter(r => r.gender === 'male');
    const privateGender = people.filter(r => !['female', 'male'].includes(r.gender));
    const divisionGroups = [
      ...chunks(female, maxSize).map(members => ({ members, genderMode: 'female' })),
      ...chunks(male, maxSize).map(members => ({ members, genderMode: 'male' })),
    ];

    for (const person of privateGender) {
      const available = divisionGroups
        .filter(g => g.members.length < maxSize)
        .sort((a, b) => a.members.length - b.members.length)[0];
      if (available) available.members.push(person);
      else divisionGroups.push({ members: [person], genderMode: 'private' });
    }

    divisionGroups.forEach((group, index) => result.push({
      division,
      genderMode: group.genderMode,
      members: group.members,
      roleName: identityRoleName(division, index),
    }));
  }
  return result;
}

// Choose an existing provisional group in the same division. A declared
// female/male member is never placed with the opposite declared gender when a
// new group can be created instead.
function chooseProvisionalGroup(groups, record, maxSize = MAX_GROUP_SIZE) {
  const sameDivision = groups.filter(g => g.division === record.division && g.members.length < maxSize);
  let compatible = sameDivision;
  if (record.gender === 'female') compatible = sameDivision.filter(g => !g.genders.has('male'));
  if (record.gender === 'male') compatible = sameDivision.filter(g => !g.genders.has('female'));
  return compatible.sort((a, b) => {
    const aSame = a.genders.has(record.gender) ? 1 : 0;
    const bSame = b.genders.has(record.gender) ? 1 : 0;
    return bSame - aSame || a.members.length - b.members.length || a.roleName.localeCompare(b.roleName);
  })[0] || null;
}

module.exports = {
  FRUITS,
  MAX_GROUP_SIZE,
  buildFinalGroups,
  chooseProvisionalGroup,
  identityRoleName,
};
