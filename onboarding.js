// ============================================================
//  onboarding.js - private bootcamp onboarding + role grouping
//
//  Public: welcome greeting, exact rules-message link, Start button.
//  Private: ephemeral selects for division, Dhaka area, availability,
//  work mode, English level, and honest skills. Answers persist through the
//  existing Sheet state API and project to independent Discord roles.
// ============================================================
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
} = require('discord.js');
const { cohorts } = require('./config');
const { fetchGuildMembers } = require('./discord-members');
const { appsScriptGet } = require('./apps-script-api');
const { syncMembers } = require('./roster');
const { channelSurveyButton } = require('./student-data-survey');
const {
  MAX_GROUP_SIZE,
  buildFinalGroups,
  chooseProvisionalGroup,
  identityRoleName,
} = require('./onboarding-groups');
const {
  DHAKA_SUBREGIONS,
  DIVISIONS,
  ENGLISH_ROLES,
  LEGACY_IDENTITY_PREFIX,
  READINESS_ROLES,
  SKILLS,
  WORK_MODE_ROLES,
  expectedRoleNames,
  isManagedProfileRoleName,
  missingRoleProfileFields,
  roleProfile,
} = require('./role-profile');

const IDENTITY_PREFIX = LEGACY_IDENTITY_PREFIX;
const ROLE_COLORS = [0x2ecc71, 0x3498db, 0x9b59b6, 0xe67e22, 0xe91e63, 0x1abc9c, 0xf1c40f];

const QUESTIONS = {
  division: {
    placeholder: '1/5 — Current division / location',
    options: DIVISIONS.map(value => [value === 'Abroad' ? 'Outside Bangladesh' : value, value]),
  },
  subregion: {
    placeholder: '2/5 — Current Dhaka area',
    options: DHAKA_SUBREGIONS.map(value => [value, value]),
  },
  availability: {
    placeholder: '3/5 — Current job-search availability',
    options: [
      ['Full-time job ready now', 'full_time', 'Actively searching and available for full-time work'],
      ['Searching, but limited availability', 'limited', 'Study or other commitments limit full-time availability'],
      ['Not job searching — study first', 'study', 'School/college/early university study should be the priority'],
    ],
  },
  jobFocus: {
    placeholder: '4/5 — Job preference',
    options: [
      ['Remote', 'remote'], ['Onsite', 'onsite'], ['Hybrid', 'hybrid'],
    ],
  },
  englishLevel: {
    placeholder: '5/5 — English communication',
    options: [
      ['Basic', 'basic'], ['Advanced', 'advanced'], ['Expert', 'expert'],
    ],
  },
  skills: {
    placeholder: 'Select every true skill (multiple allowed)',
    options: SKILLS.map(value => [value, value]),
    multiple: true,
  },
};

const DEFAULT_RULES = `# 📜 Bootcamp Rules & Regulations

1. **Respect everyone.** No harassment, discrimination, bullying, personal attacks, or inappropriate content.
2. **Keep communication professional.** Use the correct channels, avoid spam, and give constructive feedback.
3. **Protect privacy.** Do not share another member's phone number, resume, interview details, or private messages without permission.
4. **Be honest.** Never fake attendance, applications, outreach, interviews, projects, or AI-assisted work.
5. **Participate consistently.** Follow the attendance, workshop, outreach, and job-tracking expectations that apply to you.
6. **Share safe opportunities.** Do not post scams, paid-job promises, unverified links, or misleading recruitment information.
7. **Use AI responsibly.** Learn from it; do not submit copied answers or claim generated work as your own.
8. **Follow Discord's rules and applicable law.** Mentors may warn, restrict, or remove members when needed.
9. **Ask for help early.** Contact your mentor if study, health, safety, or personal circumstances affect participation.

By accepting these rules during onboarding, you agree to follow them while participating in the bootcamp.`;

const queues = new Map();
const recordKey = (cohort, userId) => `ob_${cohort.guildId}_user_${userId}`;
const userPrefix = (cohort) => `ob_${cohort.guildId}_user_`;
const rulesKey = (cohort) => `ob_${cohort.guildId}_rules_message`;
const panelKey = (cohort) => `ob_${cohort.guildId}_panel_message`;
const finalizedKey = (cohort) => `ob_${cohort.guildId}_finalized`;
const roleReminderKey = (cohort) => `ob_${cohort.guildId}_role_reminder_v1`;
const roleReminderTimers = new Map();
const ROLE_REMINDER_DELAY_MS = 2 * 60 * 60 * 1000;

async function getState(cohort, key) {
  const url = `${cohort.appsScriptUrl}?action=getstate&k=${encodeURIComponent(key)}&key=${encodeURIComponent(cohort.apiKey)}`;
  const res = await fetch(url, { redirect: 'follow' });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.value || '';
}

async function setState(cohort, key, value) {
  const res = await fetch(cohort.appsScriptUrl, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: cohort.apiKey, action: 'setState', k: key, v: String(value || '') }),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Sheet state API returned non-JSON'); }
  if (data.error) throw new Error(data.error);
  return data;
}

function parseRecord(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

async function loadRecord(cohort, userId) {
  return parseRecord(await getState(cohort, recordKey(cohort, userId))) || { userId };
}

async function saveRecord(cohort, record) {
  record.updatedAt = new Date().toISOString();
  await setState(cohort, recordKey(cohort, record.userId), JSON.stringify(record));
  return record;
}

async function loadAllRecords(cohort) {
  const prefix = userPrefix(cohort);
  const url = `${cohort.appsScriptUrl}?action=getstates&prefix=${encodeURIComponent(prefix)}&key=${encodeURIComponent(cohort.apiKey)}`;
  const res = await fetch(url, { redirect: 'follow' });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return Object.entries(data.states || {}).map(([key, value]) => {
    const record = parseRecord(value);
    if (!record) return null;
    record.userId = record.userId || key.slice(prefix.length);
    return record;
  }).filter(Boolean);
}

function isComplete(record) {
  return missingRoleProfileFields(record).length === 0 && Boolean(record.rulesAccepted);
}

function isRoleProfileComplete(record) {
  return missingRoleProfileFields(record).length === 0;
}

function categorizeOnboarding(eligible, records) {
  const recordsById = new Map(records.map(record => [String(record.userId), record]));
  const roleComplete = eligible.filter(member =>
    isRoleProfileComplete(recordsById.get(member.id) || {}));
  const completed = roleComplete.filter(member =>
    Boolean(recordsById.get(member.id)?.rulesAccepted));
  const roleCompleteIds = new Set(roleComplete.map(member => member.id));
  const completedIds = new Set(completed.map(member => member.id));
  return {
    recordsById,
    roleComplete,
    completed,
    missingProfile: eligible.filter(member => !roleCompleteIds.has(member.id)),
    rulesPending: eligible.filter(member => roleCompleteIds.has(member.id) && !completedIds.has(member.id)),
  };
}

async function waitForRoleProfile(cohort, userId, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 5);
  const intervalMs = Math.max(0, Number(options.intervalMs) || 6000);
  const loader = options.loader || loadRecord;
  const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let record = {};
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      record = await loader(cohort, userId);
      lastError = null;
      if (isRoleProfileComplete(record)) return record;
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < attempts) await wait(intervalMs);
  }

  if (lastError) throw lastError;
  return record;
}

function needsAvailabilityReview(record) {
  return record.availability === 'full_time' && ['school', 'college', 'university_early'].includes(record.studyStage);
}

function progress(record) {
  const profile = roleProfile(record);
  return [
    profile.division,
    profile.division === 'Dhaka' ? profile.subregion : 'not-required',
    profile.availability,
    profile.jobFocus,
    profile.englishLevel,
    profile.skills.length ? 'skills' : '',
    record.rulesAccepted,
  ].filter(Boolean).length;
}

function roleColor(name) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return ROLE_COLORS[hash % ROLE_COLORS.length];
}

async function ensureRole(guild, name) {
  let role = guild.roles.cache.find(r => r.name === name);
  if (role) return role;
  role = await guild.roles.create({
    name,
    colors: { primaryColor: roleColor(name) },
    hoist: false,
    mentionable: false,
    reason: 'JP ADMIN bootcamp onboarding',
  });
  return role;
}

async function replaceRoles(member, predicate, keepRole) {
  const remove = member.roles.cache.filter(r => predicate(r) && (!keepRole || r.id !== keepRole.id)).map(r => r.id);
  if (remove.length) await member.roles.remove(remove, 'JP ADMIN onboarding role update');
  if (keepRole && !member.roles.cache.has(keepRole.id)) await member.roles.add(keepRole, 'JP ADMIN onboarding role update');
}

async function applyReadinessRole(member, availability) {
  const name = READINESS_ROLES[availability];
  if (!name) return null;
  const role = await ensureRole(member.guild, name);
  await replaceRoles(member, r => Object.values(READINESS_ROLES).includes(r.name), role);
  return role;
}

async function applyProfileRoles(member, input) {
  await member.guild.roles.fetch();
  const profile = roleProfile(input);
  const names = expectedRoleNames(profile);
  const roles = [];
  for (const name of names) roles.push(await ensureRole(member.guild, name));
  const desiredIds = new Set(roles.map(role => role.id));
  const remove = member.roles.cache.filter(role =>
    (isManagedProfileRoleName(role.name) || role.name.startsWith(LEGACY_IDENTITY_PREFIX)) &&
    !desiredIds.has(role.id)).map(role => role.id);
  if (remove.length) await member.roles.remove(remove, 'JP ADMIN role-profile reconciliation');
  const add = roles.filter(role => !member.roles.cache.has(role.id));
  if (add.length) await member.roles.add(add, 'JP ADMIN role-profile reconciliation');
  return { profile, roles: names, removedLegacy: remove.filter(id =>
    member.guild.roles.cache.get(id)?.name.startsWith(LEGACY_IDENTITY_PREFIX)).length };
}

function reconcileProfileRoles(cohort, member, input) {
  return enqueue(`roles:${cohort.guildId}`, () => applyProfileRoles(member, input));
}

function groupsFromRecords(records, memberIds, excludeUserId) {
  const map = new Map();
  for (const record of records) {
    if (record.userId === excludeUserId || !memberIds.has(record.userId) || !record.groupRoleId || !record.division) continue;
    let group = map.get(record.groupRoleId);
    if (!group) {
      group = {
        roleId: record.groupRoleId,
        roleName: record.groupName || identityRoleName(record.division, map.size),
        division: record.division,
        genders: new Set(),
        members: [],
      };
      map.set(record.groupRoleId, group);
    }
    group.members.push(record);
    if (record.gender) group.genders.add(record.gender);
  }
  return [...map.values()];
}

async function assignProvisionalGroup(cohort, member, record) {
  if (!record.gender || !record.division) return record;
  const [records, members] = await Promise.all([loadAllRecords(cohort), fetchGuildMembers(member.guild)]);
  const groups = groupsFromRecords(records, new Set(members.keys()), record.userId);
  let selected = chooseProvisionalGroup(groups, record, MAX_GROUP_SIZE);
  let role;
  if (selected) {
    role = member.guild.roles.cache.get(selected.roleId) || await ensureRole(member.guild, selected.roleName);
  } else {
    const divisionGroupCount = groups.filter(g => g.division === record.division).length;
    role = await ensureRole(member.guild, identityRoleName(record.division, divisionGroupCount));
  }

  await replaceRoles(member, r => r.name.startsWith(IDENTITY_PREFIX), role);
  record.groupRoleId = role.id;
  record.groupName = role.name;
  record.groupProvisional = true;
  await saveRecord(cohort, record);
  return record;
}

async function finalizeGroups(cohort, guild, snapshot = {}) {
  const [records, members] = snapshot.records && snapshot.members
    ? [snapshot.records, snapshot.members]
    : await Promise.all([loadAllRecords(cohort), fetchGuildMembers(guild)]);
  const eligible = records.filter(r => isComplete(r) && members.has(r.userId));
  const groups = buildFinalGroups(eligible, MAX_GROUP_SIZE);
  const failures = [];

  for (const group of groups) {
    const role = await ensureRole(guild, group.roleName);
    for (const record of group.members) {
      const member = members.get(record.userId);
      if (!member) continue;
      try {
        await replaceRoles(member, r => r.name.startsWith(IDENTITY_PREFIX), role);
        record.groupRoleId = role.id;
        record.groupName = role.name;
        record.groupProvisional = false;
        await saveRecord(cohort, record);
      } catch (err) {
        failures.push(`${member.user.username}: ${err.message}`);
      }
    }
  }
  if (!failures.length) await setState(cohort, finalizedKey(cohort), '1');
  return { participants: eligible.length, groups: groups.length, failures };
}

async function maybeFinalizeGroups(cohort, guild) {
  const [records, members, alreadyFinalized] = await Promise.all([
    loadAllRecords(cohort), fetchGuildMembers(guild), getState(cohort, finalizedKey(cohort)),
  ]);
  const eligible = [...members.values()].filter(m => !m.user.bot && !cohort.supervisorIds.includes(m.id));
  const eligibleIds = new Set(eligible.map(m => m.id));
  const completed = records.filter(r => eligibleIds.has(r.userId) && isComplete(r));
  const majority = Math.floor(eligible.length / 2) + 1;
  // Once the majority threshold is reached, rerun the distribution whenever a
  // completed member changes an answer or a late member finishes. This prevents
  // anyone who votes after the first finalization from remaining provisional.
  if (alreadyFinalized === '1' || completed.length >= Math.max(2, majority)) {
    return finalizeGroups(cohort, guild);
  }
  return null;
}

function selectRow(field, record) {
  const question = QUESTIONS[field];
  const selected = question.multiple
    ? new Set(Array.isArray(record[field]) ? record[field] : [])
    : record[field];
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`onboard:${field}`)
    .setPlaceholder(question.placeholder)
    .setMinValues(1)
    .setMaxValues(question.multiple ? question.options.length : 1)
    .addOptions(question.options.map(([label, value, description]) => ({
      label, value,
      ...(description ? { description } : {}),
      default: question.multiple ? selected.has(value) : selected === value,
    })));
  return new ActionRowBuilder().addComponents(menu);
}

function pageButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('onboard:page_core').setLabel('Location & availability').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('onboard:page_skills').setLabel('Skills & rules').setStyle(ButtonStyle.Secondary),
  );
}

function questionnaireRows(record, rulesUrl, page = '') {
  const profile = roleProfile(record);
  const coreComplete = Boolean(profile.division &&
    (profile.division !== 'Dhaka' || profile.subregion) && profile.availability &&
    profile.jobFocus && profile.englishLevel);
  const activePage = page || (coreComplete ? 'skills' : 'core');
  const accept = new ButtonBuilder()
    .setCustomId('onboard:accept_rules')
    .setLabel(record.rulesAccepted ? 'Rules accepted ✓' : 'I read and accept the rules')
    .setStyle(record.rulesAccepted ? ButtonStyle.Success : ButtonStyle.Primary)
    .setDisabled(Boolean(record.rulesAccepted));
  const rules = new ButtonBuilder().setLabel('Open rules').setStyle(ButtonStyle.Link).setURL(rulesUrl);
  if (activePage === 'skills') {
    return [
      selectRow('skills', record),
      new ActionRowBuilder().addComponents(rules, accept),
      pageButtons(),
    ];
  }
  return [
    selectRow('division', record),
    ...(profile.division === 'Dhaka' ? [selectRow('subregion', record)] : []),
    selectRow('availability', record),
    selectRow('jobFocus', record),
    selectRow('englishLevel', record),
  ];
}

function questionnaireContent(record) {
  const done = progress(record);
  const profile = roleProfile(record);
  const missing = missingRoleProfileFields(record);
  const lines = [
    `**Bootcamp role profile — ${done}/7 complete**`,
    'Choose accurate answers only. These selections create visible Discord roles; contact details and private study information are not posted.',
  ];
  if (profile.division) lines.push(`📍 **Location:** ${profile.division}${profile.subregion ? ` · ${profile.subregion}` : ''}`);
  if (profile.availability && READINESS_ROLES[profile.availability]) lines.push(`🎯 **Availability:** ${READINESS_ROLES[profile.availability]}`);
  if (profile.jobFocus && WORK_MODE_ROLES[profile.jobFocus]) lines.push(`💼 **Work mode:** ${WORK_MODE_ROLES[profile.jobFocus]}`);
  if (profile.englishLevel && ENGLISH_ROLES[profile.englishLevel]) lines.push(`🗣️ **Communication:** ${ENGLISH_ROLES[profile.englishLevel]}`);
  if (profile.skills.length) lines.push(`🧰 **Skills:** ${profile.skills.join(', ')}`);
  if (needsAvailabilityReview(record)) {
    lines.push('⚠️ **Please review your availability:** full-time job readiness may conflict with your current study stage. Choose “limited” or “study first” if full-time work would interrupt your education.');
  }
  if (isComplete(record)) lines.push('\n✅ **Role profile complete.** Reopen either page whenever your information changes.');
  else lines.push(`\nStill required: **${[...missing, ...(!record.rulesAccepted ? ['rules acceptance'] : [])].join(', ')}**. Every answer is saved and roles are reconciled immediately.`);
  return lines.join('\n');
}

function publicComponents(rulesUrl, cohort, record = null) {
  const buttons = [
    new ButtonBuilder().setLabel('Read rules & regulations').setStyle(ButtonStyle.Link).setURL(rulesUrl),
  ];
  const profileComplete = record && isRoleProfileComplete(record);
  if (profileComplete && !record.rulesAccepted) {
    buttons.push(new ButtonBuilder().setCustomId('onboard:accept_rules_public')
      .setLabel('I read and accept the rules').setStyle(ButtonStyle.Primary));
  } else if (!profileComplete) {
    buttons.push(new ButtonBuilder().setCustomId('onboard:start')
      .setLabel('Complete missing role profile').setStyle(ButtonStyle.Success));
  }
  const rows = [new ActionRowBuilder().addComponents(...buttons)];
  // The contact survey is fallback-only. An authenticated intake submission
  // already saved the private profile and should not ask the student again.
  if (!profileComplete) rows.push(channelSurveyButton(cohort));
  return rows;
}

function onboardingOnlyComponents(rulesUrl) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Read rules & regulations').setStyle(ButtonStyle.Link).setURL(rulesUrl),
    new ButtonBuilder().setCustomId('onboard:start').setLabel('Complete private onboarding').setStyle(ButtonStyle.Success),
  )];
}

function rulesOnlyComponents(rulesUrl) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Read rules & regulations').setStyle(ButtonStyle.Link).setURL(rulesUrl),
    new ButtonBuilder().setCustomId('onboard:accept_rules_public')
      .setLabel('I read and accept the rules').setStyle(ButtonStyle.Primary),
  )];
}

function onboardingRoleNeeds(record, roleNames = []) {
  const names = new Set(roleNames);
  const expected = expectedRoleNames(record);
  return {
    missing: expected.filter(name => !names.has(name)),
    stale: [...names].filter(name =>
      (isManagedProfileRoleName(name) || String(name).startsWith(LEGACY_IDENTITY_PREFIX)) &&
      !expected.includes(name)),
    profileFields: missingRoleProfileFields(record),
  };
}

async function rulesMessageUrl(client, cohort) {
  let id = await getState(cohort, rulesKey(cohort));
  if (!id) id = (await ensureRulesMessage(client, cohort)).id;
  return `https://discord.com/channels/${cohort.guildId}/${cohort.channels.rules}/${id}`;
}

async function ensureRulesMessage(client, cohort) {
  if (!cohort.channels.rules) throw new Error('rules-and-regulations channel not configured');
  const channel = await client.channels.fetch(cohort.channels.rules);
  const savedId = await getState(cohort, rulesKey(cohort));
  if (savedId) {
    const saved = await channel.messages.fetch(savedId).catch(() => null);
    if (saved) return saved;
  }

  const recent = await channel.messages.fetch({ limit: 50 });
  let message = recent.find(m => m.pinned && m.content.length >= 50) ||
    recent.find(m => !m.author.bot && m.content.length >= 80) ||
    recent.find(m => m.content.length >= 80);
  if (!message) message = await channel.send(DEFAULT_RULES);
  if (!message.pinned) await message.pin().catch(() => {});
  await setState(cohort, rulesKey(cohort), message.id);
  return message;
}

async function ensureOnboardingPanel(client, cohort, rulesMessage) {
  if (!cohort.channels.welcome) throw new Error('welcome-to-the-bootcamp channel not configured');
  const channel = await client.channels.fetch(cohort.channels.welcome);
  const rulesUrl = rulesMessage.url || `https://discord.com/channels/${cohort.guildId}/${cohort.channels.rules}/${rulesMessage.id}`;
  const payload = {
    content: '## 👋 Welcome to the Bootcamp\nRead the rules, complete your private contact profile, then finish the role-profile questions. Email and phone stay private. Location, availability, work mode, English level and honestly selected skills become separate Discord roles. Existing and new members can update their answers safely.',
    components: publicComponents(rulesUrl, cohort),
    allowedMentions: { parse: [] },
  };
  const savedId = await getState(cohort, panelKey(cohort));
  if (savedId) {
    const saved = await channel.messages.fetch(savedId).catch(() => null);
    if (saved) { await saved.edit(payload); return saved; }
  }
  const panel = await channel.send(payload);
  await panel.pin().catch(() => {});
  await setState(cohort, panelKey(cohort), panel.id);
  return panel;
}

async function ensureOnboardingSetup(client, cohort) {
  const rulesMessage = await ensureRulesMessage(client, cohort);
  const panel = await ensureOnboardingPanel(client, cohort, rulesMessage);
  return { rulesMessage, panel };
}

function enqueue(key, task) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  queues.set(key, next);
  // Attach cleanup to both outcomes. Calling `.finally()` here without
  // consuming its returned promise creates a second rejected promise when a
  // Discord gateway request fails, which can terminate Node as an unhandled
  // rejection even though the command itself catches `next`.
  next.then(
    () => { if (queues.get(key) === next) queues.delete(key); },
    () => { if (queues.get(key) === next) queues.delete(key); },
  );
  return next;
}

async function processOnboardingAnswer(client, interaction, cohort, field, value) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  let record = await loadRecord(cohort, interaction.user.id);
  if (field === 'rulesAccepted') record.rulesAccepted = true;
  else record[field] = field === 'skills' ? [...new Set(value)] : value;
  if (field === 'division' && value !== 'Dhaka') record.subregion = '';
  if (isComplete(record) && !record.completedAt) record.completedAt = new Date().toISOString();
  await saveRecord(cohort, record);

  await reconcileProfileRoles(cohort, member, record);

  record = await loadRecord(cohort, interaction.user.id);
  const rulesUrl = await rulesMessageUrl(client, cohort);
  await interaction.editReply({ content: questionnaireContent(record), components: questionnaireRows(record, rulesUrl) });
}

async function postOnboardingStatus(msg, cohort) {
  const [records, members] = await Promise.all([
    loadAllRecords(cohort), fetchGuildMembers(msg.guild),
  ]);
  const eligible = [...members.values()].filter(m => !m.user.bot && !cohort.supervisorIds.includes(m.id));
  const eligibleIds = new Set(eligible.map(m => m.id));
  const eligibleRecords = records.filter(record => eligibleIds.has(String(record.userId)));
  const categories = categorizeOnboarding(eligible, eligibleRecords);
  const completedRecords = categories.completed.map(member => categories.recordsById.get(member.id));
  const roleRecords = categories.roleComplete.map(member => categories.recordsById.get(member.id));
  const byDivision = {};
  const byAvailability = {};
  for (const r of roleRecords) {
    byDivision[r.division] = (byDivision[r.division] || 0) + 1;
    byAvailability[r.availability] = (byAvailability[r.availability] || 0) + 1;
  }
  const majority = Math.floor(eligible.length / 2) + 1;
  const reviewRecords = completedRecords.filter(needsAvailabilityReview);
  const reviewCount = reviewRecords.length;
  const fmt = (obj, labels = {}) => Object.entries(obj).map(([k, v]) => `• ${labels[k] || k}: **${v}**`).join('\n') || '—';

  await msg.channel.send({
    embeds: [{
      title: `👋 Onboarding Status — ${cohort.name}`,
      color: categories.completed.length >= majority ? 0x2ecc71 : 0xe67e22,
      fields: [
        { name: 'Complete including rules', value: `${categories.completed.length} / ${eligible.length}`, inline: true },
        { name: 'Role profiles ready', value: `${categories.roleComplete.length} / ${eligible.length}`, inline: true },
        { name: 'Rules acceptance pending', value: String(categories.rulesPending.length), inline: true },
        { name: 'Finalization threshold', value: `${categories.completed.length >= majority ? 'Majority reached' : `${majority - categories.completed.length} to majority`}`, inline: true },
        { name: 'Availability review', value: String(reviewCount), inline: true },
        { name: 'By division/location', value: fmt(byDivision).slice(0, 1024) },
        { name: 'Job availability', value: fmt(byAvailability, {
          full_time: 'Full-time ready', limited: 'Limited availability', study: 'Study first',
        }).slice(0, 1024) },
      ],
      footer: { text: 'Private gender and study-stage answers are never listed and never become Discord roles.' },
    }],
  });
  if (categories.missingProfile.length) {
    const lines = categories.missingProfile.map(m => `• ${m.user.username}`);
    for (let i = 0; i < lines.length; i += 40) {
      await msg.channel.send({ content: `**Missing role-profile data:**\n${lines.slice(i, i + 40).join('\n')}`, allowedMentions: { parse: [] } });
    }
  }
  if (categories.rulesPending.length) {
    const lines = categories.rulesPending.map(m => `• ${m.user.username}`);
    for (let i = 0; i < lines.length; i += 40) {
      await msg.channel.send({ content: `**Role profile ready; rules acceptance pending:**\n${lines.slice(i, i + 40).join('\n')}`, allowedMentions: { parse: [] } });
    }
  }
  if (reviewRecords.length) {
    const names = reviewRecords.map(r => members.get(r.userId)?.user.username || r.userId);
    await msg.channel.send({
      content: `⚠️ **Review full-time availability vs. study stage:**\n${names.map(n => `• ${n}`).join('\n').slice(0, 1800)}`,
      allowedMentions: { parse: [] },
    });
  }
}

async function completionSnapshot(client, cohort, guild) {
  await syncMembers(client, cohort);
  const [records, members, profileData] = await Promise.all([
    loadAllRecords(cohort),
    fetchGuildMembers(guild),
    appsScriptGet(cohort, { action: 'missingprofiles' }, { label: 'Private profile completion check' }),
  ]);
  const eligible = [...members.values()].filter(member =>
    !member.user.bot && !cohort.supervisorIds.includes(member.id));
  const completedOnboarding = new Set(records.filter(isComplete).map(record => record.userId));
  const profileMissing = new Map((profileData.profiles || []).map(profile => [String(profile.discordId), profile]));
  const incomplete = eligible.map(member => {
    const needsOnboarding = !completedOnboarding.has(member.id);
    const profile = profileMissing.get(member.id);
    return {
      member,
      needsOnboarding,
      needsProfile: Boolean(profile),
      missingProfileFields: Array.isArray(profile?.missing) ? profile.missing : [],
    };
  }).filter(item => item.needsOnboarding || item.needsProfile);
  return {
    eligible: eligible.length,
    incomplete,
    onboardingIncomplete: incomplete.filter(item => item.needsOnboarding).length,
    profileIncomplete: incomplete.filter(item => item.needsProfile).length,
  };
}

async function postCompletionCheck(msg, client, cohort, sendReminder) {
  const snapshot = await completionSnapshot(client, cohort, msg.guild);
  await msg.channel.send({
    content: [
      `## Student Completion Check — ${cohort.name}`,
      `Current students: **${snapshot.eligible}**`,
      `Private onboarding incomplete: **${snapshot.onboardingIncomplete}**`,
      `Private profile incomplete: **${snapshot.profileIncomplete}**`,
      `Needs either action: **${snapshot.incomplete.length}**`,
    ].join('\n'),
    allowedMentions: { parse: [] },
  });
  if (snapshot.incomplete.length) {
    const lines = snapshot.incomplete.map(item => [
      item.member.displayName,
      `@${item.member.user.username}`,
      item.member.id,
      item.needsOnboarding ? 'onboarding' : '',
      item.needsProfile ? `profile (${item.missingProfileFields.join(', ')})` : '',
    ].filter(Boolean).join('\t'));
    for (let index = 0; index < lines.length; index += 25) {
      await msg.channel.send({
        content: `\`\`\`text\nNAME\tUSERNAME\tDISCORD ID\tMISSING\n${lines.slice(index, index + 25).join('\n')}\n\`\`\``,
        allowedMentions: { parse: [] },
      });
    }
  }
  if (!sendReminder || !snapshot.incomplete.length) return snapshot;

  const rulesMessage = await ensureRulesMessage(client, cohort);
  const welcome = await client.channels.fetch(cohort.channels.welcome);
  for (let index = 0; index < snapshot.incomplete.length; index += 35) {
    const chunk = snapshot.incomplete.slice(index, index + 35);
    const ids = chunk.map(item => item.member.id);
    await welcome.send({
      content: [
        index === 0 ? '## Complete your private bootcamp setup' : '**More students who still need to complete setup:**',
        ids.map(id => `<@${id}>`).join(' '),
        '',
        'Please use the buttons below. Contact details open in a private form; onboarding answers are ephemeral and private. Nothing you type is posted publicly.',
      ].join('\n'),
      components: publicComponents(rulesMessage.url, cohort),
      allowedMentions: { users: ids },
    });
  }
  return snapshot;
}

async function onboardingSnapshot(cohort, guild) {
  const [records, members] = await Promise.all([loadAllRecords(cohort), fetchGuildMembers(guild)]);
  const eligible = [...members.values()].filter(member =>
    !member.user.bot && !cohort.supervisorIds.includes(member.id));
  const recordsById = new Map(records.map(record => [String(record.userId), record]));
  const incomplete = eligible.filter(member => !isComplete(recordsById.get(member.id) || {}));
  return { eligible, incomplete, records, recordsById, members };
}

async function missingRoleProfileSnapshot(cohort, guild) {
  const snapshot = await onboardingSnapshot(cohort, guild);
  const missing = snapshot.eligible.map(member => {
    const record = snapshot.recordsById.get(member.id) || {};
    return { member, fields: missingRoleProfileFields(record) };
  }).filter(item => item.fields.length);
  return { ...snapshot, missing };
}

async function postRoleProfileReminder(client, cohort, guild, channel, followup = false) {
  const snapshot = await missingRoleProfileSnapshot(cohort, guild);
  if (!snapshot.missing.length) return { sent: 0, snapshot };
  const rulesMessage = await ensureRulesMessage(client, cohort);
  for (let index = 0; index < snapshot.missing.length; index += 35) {
    const chunk = snapshot.missing.slice(index, index + 35);
    const ids = chunk.map(item => item.member.id);
    await channel.send({
      content: [
        followup && index === 0
          ? '## Role-profile reminder — still incomplete after two hours'
          : (index === 0 ? '## Complete your role profile' : '**More students who still need role-profile data:**'),
        ids.map(id => `<@${id}>`).join(' '),
        '',
        'Use **Complete private onboarding** below. Select your real location, availability, work mode, English level and every skill you can genuinely demonstrate. Do not exaggerate skills. Answers are processed one member at a time.',
      ].join('\n'),
      components: onboardingOnlyComponents(rulesMessage.url),
      allowedMentions: { users: ids },
    });
  }
  return { sent: snapshot.missing.length, snapshot };
}

function clearRoleReminderTimer(cohort) {
  const existing = roleReminderTimers.get(cohort.guildId);
  if (existing) clearTimeout(existing);
  roleReminderTimers.delete(cohort.guildId);
}

async function runRoleReminder(client, cohort, state) {
  clearRoleReminderTimer(cohort);
  const guild = await client.guilds.fetch(cohort.guildId).catch(() => null);
  const channel = guild && await guild.channels.fetch(state.channelId).catch(() => null);
  if (guild && channel?.isTextBased()) {
    await postRoleProfileReminder(client, cohort, guild, channel, true).catch(error =>
      console.error(`[onboarding] ${cohort.name} role reminder failed:`, error.message));
  }
  await setState(cohort, roleReminderKey(cohort), '').catch(() => {});
}

async function scheduleRoleReminder(client, cohort, channelId, dueAt = Date.now() + ROLE_REMINDER_DELAY_MS) {
  clearRoleReminderTimer(cohort);
  const state = { channelId, dueAt, createdAt: Date.now() };
  await setState(cohort, roleReminderKey(cohort), JSON.stringify(state));
  const delay = Math.max(0, Math.min(ROLE_REMINDER_DELAY_MS, dueAt - Date.now()));
  const timer = setTimeout(() => runRoleReminder(client, cohort, state), delay);
  timer.unref?.();
  roleReminderTimers.set(cohort.guildId, timer);
  return state;
}

async function recoverRoleReminders(client) {
  for (const cohort of cohorts) {
    const raw = await getState(cohort, roleReminderKey(cohort)).catch(() => '');
    let state;
    try { state = JSON.parse(raw || 'null'); } catch { state = null; }
    if (!state?.channelId || !Number.isFinite(Number(state.dueAt))) continue;
    await scheduleRoleReminder(client, cohort, state.channelId, Number(state.dueAt));
  }
}

async function sendOnboardingReminder(client, cohort, guild, channel) {
  const snapshot = await onboardingSnapshot(cohort, guild);
  if (!snapshot.incomplete.length) return { ...snapshot, sent: 0 };
  const rulesMessage = await ensureRulesMessage(client, cohort);
  const categories = categorizeOnboarding(snapshot.eligible, snapshot.records);
  for (let index = 0; index < categories.missingProfile.length; index += 35) {
    const chunk = categories.missingProfile.slice(index, index + 35);
    const ids = chunk.map(member => member.id);
    await channel.send({
      content: [
        index === 0 ? '## Complete your private onboarding' : '**More students who still need private onboarding:**',
        ids.map(id => `<@${id}>`).join(' '),
        '',
        'Use the button below to answer the private onboarding questions. Your gender and study-stage answers are not posted publicly.',
      ].join('\n'),
      components: onboardingOnlyComponents(rulesMessage.url),
      allowedMentions: { users: ids },
    });
  }
  for (let index = 0; index < categories.rulesPending.length; index += 35) {
    const chunk = categories.rulesPending.slice(index, index + 35);
    const ids = chunk.map(member => member.id);
    await channel.send({
      content: [
        index === 0 ? '## Please read and accept the rules' : '**More students awaiting rules acceptance:**',
        ids.map(id => `<@${id}>`).join(' '),
        '',
        'Your intake role profile is already complete. No second private questionnaire is required.',
      ].join('\n'),
      components: rulesOnlyComponents(rulesMessage.url),
      allowedMentions: { users: ids },
    });
  }
  return { ...snapshot, sent: snapshot.incomplete.length };
}

async function repairOnboardingRoles(cohort, guild) {
  const snapshot = await onboardingSnapshot(cohort, guild);
  const liveIds = new Set(snapshot.eligible.map(member => member.id));
  const candidates = snapshot.records.filter(record => liveIds.has(String(record.userId)));
  const before = { missingRoles: 0, staleRoles: 0 };
  for (const record of candidates) {
    const member = snapshot.members.get(String(record.userId));
    if (!member) continue;
    const needs = onboardingRoleNeeds(record, [...member.roles.cache.values()].map(role => role.name));
    before.missingRoles += needs.missing.length;
    before.staleRoles += needs.stale.length;
  }

  const failures = [];
  let repaired = 0;
  let legacyAssignmentsRemoved = 0;
  for (const record of candidates) {
    const member = snapshot.members.get(String(record.userId));
    if (!member) continue;
    try {
      const result = await applyProfileRoles(member, record);
      legacyAssignmentsRemoved += result.removedLegacy;
      repaired++;
    } catch (error) {
      failures.push(`${member.user.username}: ${error.message}`);
    }
  }
  const remaining = { missingRoles: 0, staleRoles: 0 };
  const missingProfiles = [];
  for (const record of candidates) {
    const member = await guild.members.fetch(String(record.userId)).catch(() => null);
    if (!member) continue;
    const needs = onboardingRoleNeeds(record, [...member.roles.cache.values()].map(role => role.name));
    remaining.missingRoles += needs.missing.length;
    remaining.staleRoles += needs.stale.length;
    if (needs.profileFields.length) missingProfiles.push({ member, fields: needs.profileFields });
  }
  const noRecord = snapshot.eligible
    .filter(member => !candidates.some(record => String(record.userId) === member.id))
    .map(member => ({ member, fields: missingRoleProfileFields({}) }));
  missingProfiles.push(...noRecord);
  return {
    candidates: candidates.length,
    repaired,
    before,
    remaining,
    missingProfiles,
    legacyAssignmentsRemoved,
    failures,
  };
}

async function runRoleRepairCommand(msg, client, cohort) {
  const requested = msg.mentions.channels.first();
  const reminderChannel = requested || await client.channels.fetch(cohort.channels.discussion);
  if (!reminderChannel || reminderChannel.guildId !== cohort.guildId || !reminderChannel.isTextBased()) {
    return msg.reply('Choose a text channel in this server, for example `!rolerepair #discussion`.');
  }
  await msg.reply({
    content: 'Repairing independent location, availability, work-mode, English and skill roles from saved answers...',
    allowedMentions: { parse: [] },
  });
  const result = await enqueue(`roles:${cohort.guildId}`, () => repairOnboardingRoles(cohort, msg.guild));
  let reminded = 0;
  if (result.missingProfiles.length) {
    const reminder = await postRoleProfileReminder(client, cohort, msg.guild, reminderChannel, false);
    reminded = reminder.sent;
    if (reminded) await scheduleRoleReminder(client, cohort, reminderChannel.id);
  } else {
    clearRoleReminderTimer(cohort);
    await setState(cohort, roleReminderKey(cohort), '');
  }
  const lines = [
    `✅ Role repair processed **${result.repaired}/${result.candidates}** saved member record(s), one at a time.`,
    `Before: **${result.before.missingRoles}** missing role assignments · **${result.before.staleRoles}** stale managed assignments`,
    `After: **${result.remaining.missingRoles}** missing · **${result.remaining.staleRoles}** stale`,
    `Legacy fruit-team assignments removed from members: **${result.legacyAssignmentsRemoved}** (role objects and history were not deleted)`,
    reminded
      ? `Mentioned **${reminded}** student(s) needing data in <#${reminderChannel.id}>; remaining students will be reminded once after two hours.`
      : 'Every current student has the saved role data needed; no reminder was posted.',
  ];
  if (result.failures.length) lines.push('', '⚠️ Assignment failures:', ...result.failures.slice(0, 20));
  return msg.channel.send({ content: lines.join('\n').slice(0, 1990), allowedMentions: { parse: [] } });
}

module.exports = function registerOnboarding(client) {
  const recover = async () => {
    await recoverRoleReminders(client);
    // Full-cohort repair is intentionally command-driven. This avoids a
    // reconnect changing legacy or closing cohorts and keeps startup light.
    // New or resubmitted answers are still reconciled immediately.
  };
  if (client.isReady?.()) recover().catch(error =>
    console.error('[onboarding] startup recovery failed:', error.message));
  else client.once('clientReady', () => recover().catch(error =>
    console.error('[onboarding] startup recovery failed:', error.message)));

  client.on('guildMemberAdd', async member => {
    const cohort = cohorts.find(c => c.guildId === member.guild.id);
    if (!cohort || member.user.bot || !cohort.channels.welcome || !cohort.channels.rules) return;
    try {
      // OAuth admission fires guildMemberAdd just before the intake backend
      // finishes saving its record. Recheck for up to 24 seconds so a temporary
      // Apps Script lock cannot show successful intake users a redundant form.
      const rulesMessage = await ensureRulesMessage(client, cohort);
      const record = await waitForRoleProfile(cohort, member.id);
      const profileComplete = isRoleProfileComplete(record);
      const channel = await client.channels.fetch(cohort.channels.welcome);
      await channel.send({
        content: profileComplete
          ? `👋 Welcome ${member}! Your intake profile and roles are ready. Please read and accept the rules; no second private profile is required.`
          : `👋 Welcome ${member}! Please read the rules. Some intake role data is missing, so the private fallback button is available below. Contact details remain private.`,
        components: publicComponents(rulesMessage.url, cohort, record),
        allowedMentions: { users: [member.id] },
      });
    } catch (err) { console.error('[onboarding] welcome failed:', err.message); }
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.customId?.startsWith('onboard:') || !interaction.guildId) return;
    const cohort = cohorts.find(c => c.guildId === interaction.guildId);
    if (!cohort) return;

    if (interaction.isButton() && interaction.customId === 'onboard:start') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const record = await loadRecord(cohort, interaction.user.id);
        const url = await rulesMessageUrl(client, cohort);
        if (isRoleProfileComplete(record)) {
          await interaction.editReply({
            content: record.rulesAccepted
              ? '✅ Your intake role profile and rules acceptance are already complete.'
              : '✅ Your intake role profile is complete. Only rules acceptance remains; no second questionnaire is required.',
            components: publicComponents(url, cohort, record),
          });
          return;
        }
        await interaction.editReply({ content: questionnaireContent(record), components: questionnaireRows(record, url) });
      } catch (err) {
        await interaction.editReply(`❌ Could not start onboarding: ${err.message}`);
      }
      return;
    }

    if (interaction.isButton() && interaction.customId === 'onboard:accept_rules_public') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        const record = await loadRecord(cohort, interaction.user.id);
        if (!isRoleProfileComplete(record)) {
          await interaction.editReply('Your intake role data is still incomplete. Use **Complete missing role profile** instead.');
          return;
        }
        record.rulesAccepted = true;
        record.completedAt = record.completedAt || new Date().toISOString();
        await saveRecord(cohort, record);
        await reconcileProfileRoles(cohort, member, record);
        await interaction.editReply('✅ Rules accepted. Your intake profile and Discord roles are complete.');
      } catch (error) {
        await interaction.editReply(`❌ Could not save rules acceptance: ${error.message}`);
      }
      return;
    }

    if (interaction.isButton() && ['onboard:page_core', 'onboard:page_skills'].includes(interaction.customId)) {
      await interaction.deferUpdate();
      try {
        const record = await loadRecord(cohort, interaction.user.id);
        const url = await rulesMessageUrl(client, cohort);
        const page = interaction.customId.endsWith('core') ? 'core' : 'skills';
        await interaction.editReply({ content: questionnaireContent(record), components: questionnaireRows(record, url, page) });
      } catch (err) {
        await interaction.editReply(`❌ Could not open role profile: ${err.message}`);
      }
      return;
    }

    if (interaction.isButton() && interaction.customId === 'onboard:accept_rules') {
      await interaction.deferUpdate();
      await enqueue(`${cohort.guildId}:${interaction.user.id}`, () =>
        processOnboardingAnswer(client, interaction, cohort, 'rulesAccepted', true)
      ).catch(err => interaction.editReply(`❌ Could not save onboarding: ${err.message}`).catch(() => {}));
      return;
    }

    if (interaction.isStringSelectMenu()) {
      const field = interaction.customId.slice('onboard:'.length);
      if (!QUESTIONS[field]) return;
      await interaction.deferUpdate();
      await enqueue(`${cohort.guildId}:${interaction.user.id}`, () =>
        processOnboardingAnswer(client, interaction, cohort, field,
          field === 'skills' ? interaction.values : interaction.values[0])
      ).catch(err => interaction.editReply(`❌ Could not save onboarding: ${err.message}`).catch(() => {}));
    }
  });

  client.on('messageCreate', async msg => {
    if (msg.author.bot) return;
    const lower = msg.content.trim().toLowerCase();
    if (!['!onboardingpanel', '!onboardingstatus', '!finalizegroups',
      '!completioncheck', '!completionreminder', '!onboardingrepair'].includes(lower) &&
        !lower.startsWith('!rolerepair') &&
        !lower.startsWith('!onboardingreminder') &&
        !lower.startsWith('!setrulesmessage') && !lower.startsWith('!resetonboarding')) return;
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;
    if (msg.channelId !== cohort.channels.supervisor) return msg.reply(`Run onboarding administration in <#${cohort.channels.supervisor}>.`);

    try {
      if (lower === '!onboardingpanel') {
        const result = await ensureOnboardingSetup(client, cohort);
        return msg.reply(`✅ Onboarding panel ready: ${result.panel.url}\nRules message: ${result.rulesMessage.url}`);
      }
      if (lower === '!onboardingstatus') return postOnboardingStatus(msg, cohort);
      if (lower.startsWith('!onboardingreminder')) {
        const requested = msg.mentions.channels.first();
        const channel = requested || await client.channels.fetch(cohort.channels.discussion);
        if (!channel || channel.guildId !== cohort.guildId || !channel.isTextBased()) {
          return msg.reply('Choose a text channel in this server, for example `!onboardingreminder #discussion`.');
        }
        await msg.reply({ content: `Checking current members before posting in <#${channel.id}>...`, allowedMentions: { parse: [] } });
        const result = await sendOnboardingReminder(client, cohort, msg.guild, channel);
        return msg.channel.send({
          content: result.sent
            ? `✅ Mentioned only **${result.sent}** current student(s) with incomplete private onboarding in <#${channel.id}>.`
            : '✅ Every current student has completed private onboarding; nothing was posted.',
          allowedMentions: { parse: [] },
        });
      }
      if (lower === '!onboardingrepair' || lower.startsWith('!rolerepair')) {
        return runRoleRepairCommand(msg, client, cohort);
      }
      if (lower === '!completioncheck') return postCompletionCheck(msg, client, cohort, false);
      if (lower === '!completionreminder') {
        const result = await postCompletionCheck(msg, client, cohort, true);
        return msg.reply(result.incomplete.length
          ? `✅ Mentioned only the **${result.incomplete.length}** current student(s) who still need private onboarding or profile data in <#${cohort.channels.welcome}>.`
          : '✅ Every current student has completed private onboarding and profile data; no reminder was posted.');
      }
      if (lower === '!finalizegroups') {
        return msg.reply('Fruit-team grouping is retired. Run `!rolerepair [#channel]` to assign independent division, Dhaka-area, availability, work-mode, English and skill roles.');
      }
      if (lower.startsWith('!setrulesmessage')) {
        const match = msg.content.match(/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/i);
        if (!match) return msg.reply('Usage: `!setrulesmessage <Discord message link from #rules-and-regulations>`');
        if (match[1] !== cohort.guildId || match[2] !== cohort.channels.rules) {
          return msg.reply(`That link must be a message from <#${cohort.channels.rules}> in this server.`);
        }
        const channel = await client.channels.fetch(match[2]);
        const message = await channel.messages.fetch(match[3]);
        await setState(cohort, rulesKey(cohort), message.id);
        await ensureOnboardingPanel(client, cohort, message);
        return msg.reply(`✅ Rules link updated: ${message.url}`);
      }
      if (lower.startsWith('!resetonboarding')) {
        const user = msg.mentions.users.first();
        if (!user) return msg.reply('Usage: `!resetonboarding @member`');
        await setState(cohort, recordKey(cohort, user.id), '');
        const member = await msg.guild.members.fetch(user.id).catch(() => null);
        if (member) {
          await replaceRoles(member, r => r.name.startsWith(IDENTITY_PREFIX) || isManagedProfileRoleName(r.name), null);
        }
        return msg.reply(`✅ Cleared onboarding answers and managed roles for **${user.username}**.`);
      }
    } catch (err) {
      await msg.reply(`❌ ${err.message}`);
    }
  });
};

module.exports.ensureOnboardingSetup = ensureOnboardingSetup;
module.exports.finalizeGroups = finalizeGroups;
module.exports.completionSnapshot = completionSnapshot;
module.exports.ensureRulesMessage = ensureRulesMessage;
module.exports.publicComponents = publicComponents;
module.exports.onboardingOnlyComponents = onboardingOnlyComponents;
module.exports.onboardingRoleNeeds = onboardingRoleNeeds;
module.exports.isRoleProfileComplete = isRoleProfileComplete;
module.exports.categorizeOnboarding = categorizeOnboarding;
module.exports.waitForRoleProfile = waitForRoleProfile;
module.exports.repairOnboardingRoles = repairOnboardingRoles;
module.exports.sendOnboardingReminder = sendOnboardingReminder;
module.exports.applyProfileRoles = applyProfileRoles;
module.exports.reconcileProfileRoles = reconcileProfileRoles;
module.exports.missingRoleProfileSnapshot = missingRoleProfileSnapshot;
module.exports.postRoleProfileReminder = postRoleProfileReminder;
