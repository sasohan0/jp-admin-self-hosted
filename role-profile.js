'use strict';

const DIVISIONS = Object.freeze([
  'Barishal', 'Chattogram', 'Dhaka', 'Khulna', 'Mymensingh',
  'Rajshahi', 'Rangpur', 'Sylhet', 'Abroad', 'Other',
]);

const DHAKA_SUBREGIONS = Object.freeze([
  'Mirpur', 'Mohammadpur', 'Gazipur', 'Savar', 'Uttara', 'Khilgaon',
  'Banasree', 'Rampura', 'Jatrabari', 'Dhanmondi', 'Gulshan', 'Banani',
  'Motijheel', 'Old Dhaka', 'Other Dhaka',
]);

// Discord select menus allow at most 25 options. This list deliberately keeps
// the mentor-requested specialisms plus the most common web-stack skills and a
// truthful no-production-skill choice.
const SKILLS = Object.freeze([
  'Laravel', 'Shopify', 'React Native', 'WordPress / Elementor', 'UI / UX',
  'Flutter', 'PostgreSQL', 'Prisma', 'Django', 'Python', 'C++', 'Linux',
  'DevOps', 'n8n', 'AI Engineering', 'AI Agents', 'Machine Learning',
  'Data Science', 'Data Analytics', 'Networking', 'JavaScript', 'TypeScript',
  'React.js', 'Node.js', 'Still learning / no production-ready skill yet',
]);

const READINESS_ROLES = Object.freeze({
  full_time: 'Availability · Full-Time Ready',
  limited: 'Availability · Limited',
  study: 'Availability · Study First',
});

const WORK_MODE_ROLES = Object.freeze({
  remote: 'Work Mode · Remote',
  onsite: 'Work Mode · Onsite',
  hybrid: 'Work Mode · Hybrid',
});

const ENGLISH_ROLES = Object.freeze({
  basic: 'English · Basic',
  advanced: 'English · Advanced',
  expert: 'English · Expert',
});

const LEGACY_IDENTITY_PREFIX = 'Bootcamp · ';
const DIVISION_PREFIX = 'Division · ';
const SUBREGION_PREFIX = 'Dhaka Area · ';
const SKILL_PREFIX = 'Skill · ';

function clean(value) {
  return String(value || '').replace(/[\r\n@]/g, ' ').replace(/\s+/g, ' ').trim();
}

function canonicalFromList(value, values) {
  const normalized = clean(value).toLowerCase();
  return values.find(item => item.toLowerCase() === normalized) || '';
}

function normalizeDivision(value) {
  const raw = clean(value);
  if (!raw) return '';
  const aliases = {
    'outside bangladesh': 'Abroad', overseas: 'Abroad', foreign: 'Abroad',
    dhaka: 'Dhaka', chittagong: 'Chattogram', chattogram: 'Chattogram',
  };
  return aliases[raw.toLowerCase()] || canonicalFromList(raw, DIVISIONS) || 'Other';
}

function normalizeSubregion(value, division) {
  if (normalizeDivision(division) !== 'Dhaka') return '';
  const raw = clean(value);
  if (!raw) return '';
  return canonicalFromList(raw, DHAKA_SUBREGIONS) || 'Other Dhaka';
}

function normalizeAvailability(value) {
  const raw = clean(value).toLowerCase();
  if (!raw) return '';
  if (raw === 'full_time' || raw.includes('full-time') || raw.includes('full time')) return 'full_time';
  if (raw === 'limited' || raw.includes('limited')) return 'limited';
  if (raw === 'study' || raw.includes('study first') || raw.includes('not job searching')) return 'study';
  return '';
}

function normalizeWorkMode(value) {
  const raw = clean(value).toLowerCase();
  if (raw.includes('hybrid') || (raw.includes('remote') && raw.includes('onsite'))) return 'hybrid';
  if (raw.includes('remote')) return 'remote';
  if (raw.includes('onsite') || raw.includes('on-site')) return 'onsite';
  return '';
}

function englishLevel(value) {
  const raw = clean(value).toLowerCase();
  if (ENGLISH_ROLES[raw]) return raw;
  const score = Number(raw);
  if (Number.isFinite(score)) {
    if (score >= 5) return 'expert';
    if (score >= 3) return 'advanced';
    if (score >= 1) return 'basic';
  }
  if (raw.includes('expert') || raw.includes('fluent')) return 'expert';
  if (raw.includes('advanced') || raw.includes('intermediate')) return 'advanced';
  if (raw.includes('basic') || raw.includes('beginner')) return 'basic';
  return '';
}

const SKILL_ALIASES = Object.freeze({
  wordpress: 'WordPress / Elementor', elementor: 'WordPress / Elementor',
  'wordpress/elementor': 'WordPress / Elementor', uiux: 'UI / UX', 'ui/ux': 'UI / UX',
  devops: 'DevOps', 'ai agent': 'AI Agents', 'ai agents': 'AI Agents',
  'react native': 'React Native', react: 'React.js', node: 'Node.js',
  cpp: 'C++', 'c / c++': 'C++', cplusplus: 'C++',
});

function normalizeSkills(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[,;\n]+/);
  const result = [];
  for (const item of values) {
    const raw = clean(item);
    if (!raw) continue;
    const canonical = canonicalFromList(raw, SKILLS) || SKILL_ALIASES[raw.toLowerCase()] || '';
    if (canonical && !result.includes(canonical)) result.push(canonical);
  }
  return result;
}

function roleProfile(input = {}) {
  const division = normalizeDivision(input.division || input.region);
  return {
    division,
    subregion: normalizeSubregion(input.subregion, division),
    availability: normalizeAvailability(input.availability),
    jobFocus: normalizeWorkMode(input.jobFocus),
    englishLevel: englishLevel(input.englishLevel || input.englishCommunication),
    skills: normalizeSkills(input.skills || input.technologies),
  };
}

function missingRoleProfileFields(input = {}) {
  const profile = roleProfile(input);
  const missing = [];
  if (!profile.division) missing.push('division');
  if (profile.division === 'Dhaka' && !profile.subregion) missing.push('Dhaka area');
  if (!profile.availability) missing.push('availability');
  if (!profile.jobFocus) missing.push('job preference');
  if (!profile.englishLevel) missing.push('English level');
  if (!profile.skills.length) missing.push('skills');
  return missing;
}

function expectedRoleNames(input = {}) {
  const profile = roleProfile(input);
  const roles = [];
  if (profile.division) roles.push(`${DIVISION_PREFIX}${profile.division}`);
  if (profile.subregion) roles.push(`${SUBREGION_PREFIX}${profile.subregion}`);
  if (READINESS_ROLES[profile.availability]) roles.push(READINESS_ROLES[profile.availability]);
  if (WORK_MODE_ROLES[profile.jobFocus]) roles.push(WORK_MODE_ROLES[profile.jobFocus]);
  if (ENGLISH_ROLES[profile.englishLevel]) roles.push(ENGLISH_ROLES[profile.englishLevel]);
  for (const skill of profile.skills) {
    if (!skill.startsWith('Still learning')) roles.push(`${SKILL_PREFIX}${skill}`);
  }
  return roles;
}

function profileFromRoleNames(roleNames = []) {
  const names = [...new Set(roleNames.map(clean).filter(Boolean))];
  const divisionName = names.find(name => name.startsWith(DIVISION_PREFIX)) || '';
  const subregionName = names.find(name => name.startsWith(SUBREGION_PREFIX)) || '';
  const reverse = values => Object.entries(values)
    .find(([, roleName]) => names.includes(roleName))?.[0] || '';
  return {
    division: canonicalFromList(divisionName.slice(DIVISION_PREFIX.length), DIVISIONS),
    subregion: canonicalFromList(subregionName.slice(SUBREGION_PREFIX.length), DHAKA_SUBREGIONS),
    availability: reverse(READINESS_ROLES),
    jobFocus: reverse(WORK_MODE_ROLES),
    englishLevel: reverse(ENGLISH_ROLES),
    skills: normalizeSkills(names
      .filter(name => name.startsWith(SKILL_PREFIX))
      .map(name => name.slice(SKILL_PREFIX.length))),
  };
}

function isManagedProfileRoleName(name) {
  const value = String(name || '');
  return value.startsWith(DIVISION_PREFIX) || value.startsWith(SUBREGION_PREFIX) ||
    value.startsWith(SKILL_PREFIX) || Object.values(READINESS_ROLES).includes(value) ||
    Object.values(WORK_MODE_ROLES).includes(value) || Object.values(ENGLISH_ROLES).includes(value);
}

module.exports = {
  DHAKA_SUBREGIONS,
  DIVISIONS,
  DIVISION_PREFIX,
  ENGLISH_ROLES,
  LEGACY_IDENTITY_PREFIX,
  READINESS_ROLES,
  SKILLS,
  SKILL_PREFIX,
  SUBREGION_PREFIX,
  WORK_MODE_ROLES,
  englishLevel,
  expectedRoleNames,
  isManagedProfileRoleName,
  missingRoleProfileFields,
  normalizeAvailability,
  normalizeDivision,
  normalizeSkills,
  normalizeSubregion,
  normalizeWorkMode,
  profileFromRoleNames,
  roleProfile,
};
