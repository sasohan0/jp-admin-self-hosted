// ============================================================
//  onboarding.js - private bootcamp onboarding + role grouping
//
//  Public: welcome greeting, exact rules-message link, Start button.
//  Private: ephemeral selects for gender, division, job readiness,
//  and study stage. Answers persist through the existing Sheet
//  state API. Identity teams contain at most six members.
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

const IDENTITY_PREFIX = 'Bootcamp · ';
const READINESS_ROLES = {
  full_time: 'Job Ready · Full-Time',
  limited: 'Job Search · Limited Availability',
  study: 'Study First · Not Job Ready',
};
const ROLE_COLORS = [0x2ecc71, 0x3498db, 0x9b59b6, 0xe67e22, 0xe91e63, 0x1abc9c, 0xf1c40f];

const QUESTIONS = {
  gender: {
    placeholder: '1/4 — Gender (kept private)',
    options: [
      ['Female', 'female', 'Used only to improve team placement'],
      ['Male', 'male', 'Used only to improve team placement'],
      ['Prefer not to say', 'private', 'You can keep this private'],
    ],
  },
  division: {
    placeholder: '2/4 — Division / location',
    options: [
      ['Barishal', 'Barishal'], ['Chattogram', 'Chattogram'], ['Dhaka', 'Dhaka'],
      ['Khulna', 'Khulna'], ['Mymensingh', 'Mymensingh'], ['Rajshahi', 'Rajshahi'],
      ['Rangpur', 'Rangpur'], ['Sylhet', 'Sylhet'], ['Outside Bangladesh', 'Abroad'],
      ['Other / not listed', 'Other'],
    ],
  },
  availability: {
    placeholder: '3/4 — Current job-search availability',
    options: [
      ['Full-time job ready now', 'full_time', 'Actively searching and available for full-time work'],
      ['Searching, but limited availability', 'limited', 'Study or other commitments limit full-time availability'],
      ['Not job searching — study first', 'study', 'School/college/early university study should be the priority'],
    ],
  },
  studyStage: {
    placeholder: '4/4 — Current study stage',
    options: [
      ['Graduated / not currently studying', 'graduated'],
      ['University final year', 'university_final'],
      ['University 1st–3rd year', 'university_early'],
      ['College / HSC / board exams', 'college'],
      ['School', 'school'],
      ['Other', 'other'],
    ],
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
  return Boolean(record.gender && record.division && record.availability && record.studyStage && record.rulesAccepted);
}

function needsAvailabilityReview(record) {
  return record.availability === 'full_time' && ['school', 'college', 'university_early'].includes(record.studyStage);
}

function progress(record) {
  return [record.gender, record.division, record.availability, record.studyStage, record.rulesAccepted].filter(Boolean).length;
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
  const selected = record[field];
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`onboard:${field}`)
    .setPlaceholder(question.placeholder)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(question.options.map(([label, value, description]) => ({
      label, value,
      ...(description ? { description } : {}),
      default: selected === value,
    })));
  return new ActionRowBuilder().addComponents(menu);
}

function questionnaireRows(record, rulesUrl) {
  const accept = new ButtonBuilder()
    .setCustomId('onboard:accept_rules')
    .setLabel(record.rulesAccepted ? 'Rules accepted ✓' : 'I read and accept the rules')
    .setStyle(record.rulesAccepted ? ButtonStyle.Success : ButtonStyle.Primary)
    .setDisabled(Boolean(record.rulesAccepted));
  const rules = new ButtonBuilder().setLabel('Open rules').setStyle(ButtonStyle.Link).setURL(rulesUrl);
  return [
    selectRow('gender', record),
    selectRow('division', record),
    selectRow('availability', record),
    selectRow('studyStage', record),
    new ActionRowBuilder().addComponents(rules, accept),
  ];
}

function questionnaireContent(record) {
  const done = progress(record);
  const lines = [
    `**Private bootcamp onboarding — ${done}/5 complete**`,
    'Your answers are visible only to the bot backend and mentors with Sheet access. Gender is used only to improve team placement.',
  ];
  if (record.groupName) lines.push(`\n🍉 **Probable identity group:** ${record.groupName}${record.groupProvisional ? ' _(may change at final grouping)_' : ''}`);
  if (record.availability && READINESS_ROLES[record.availability]) lines.push(`🎯 **Job-readiness role:** ${READINESS_ROLES[record.availability]}`);
  if (needsAvailabilityReview(record)) {
    lines.push('⚠️ **Please review your availability:** full-time job readiness may conflict with your current study stage. Choose “limited” or “study first” if full-time work would interrupt your education.');
  }
  if (isComplete(record)) lines.push('\n✅ **Onboarding complete.** You can reopen the panel later to update an answer.');
  else lines.push('\nChoose one answer in each menu and accept the rules. Every answer is saved immediately.');
  return lines.join('\n');
}

function publicComponents(rulesUrl, cohort) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Read rules & regulations').setStyle(ButtonStyle.Link).setURL(rulesUrl),
    new ButtonBuilder().setCustomId('onboard:start').setLabel('Start private onboarding').setStyle(ButtonStyle.Success),
  ), channelSurveyButton(cohort)];
}

function onboardingOnlyComponents(rulesUrl) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Read rules & regulations').setStyle(ButtonStyle.Link).setURL(rulesUrl),
    new ButtonBuilder().setCustomId('onboard:start').setLabel('Complete private onboarding').setStyle(ButtonStyle.Success),
  )];
}

function onboardingRoleNeeds(record, roleNames = []) {
  const names = new Set(roleNames);
  return {
    identity: Boolean(record?.gender && record?.division) &&
      ![...names].some(name => String(name).startsWith(IDENTITY_PREFIX)),
    readiness: Boolean(READINESS_ROLES[record?.availability]) &&
      !names.has(READINESS_ROLES[record.availability]),
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
    content: '## 👋 Welcome to the Bootcamp\nRead the rules, complete your private contact profile, then finish the private onboarding questions. Email and phone answers go only to the cohort Sheet; they are never posted in this channel. Existing and new members can use this panel. Identity teams have a maximum of six people.',
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
  else record[field] = value;
  if (isComplete(record) && !record.completedAt) record.completedAt = new Date().toISOString();
  await saveRecord(cohort, record);

  if (record.gender && record.division) {
    record = await enqueue(`groups:${cohort.guildId}`, () => assignProvisionalGroup(cohort, member, record));
  }
  if (record.availability) await applyReadinessRole(member, record.availability);
  if (isComplete(record)) {
    await enqueue(`groups:${cohort.guildId}`, () => maybeFinalizeGroups(cohort, interaction.guild));
  }

  record = await loadRecord(cohort, interaction.user.id);
  const rulesUrl = await rulesMessageUrl(client, cohort);
  await interaction.editReply({ content: questionnaireContent(record), components: questionnaireRows(record, rulesUrl) });
}

async function postOnboardingStatus(msg, cohort) {
  const [records, members, finalized] = await Promise.all([
    loadAllRecords(cohort), fetchGuildMembers(msg.guild), getState(cohort, finalizedKey(cohort)),
  ]);
  const eligible = [...members.values()].filter(m => !m.user.bot && !cohort.supervisorIds.includes(m.id));
  const eligibleIds = new Set(eligible.map(m => m.id));
  const completed = records.filter(r => eligibleIds.has(r.userId) && isComplete(r));
  const byDivision = {};
  const byAvailability = {};
  for (const r of completed) {
    byDivision[r.division] = (byDivision[r.division] || 0) + 1;
    byAvailability[r.availability] = (byAvailability[r.availability] || 0) + 1;
  }
  const majority = Math.floor(eligible.length / 2) + 1;
  const missing = eligible.filter(m => !completed.some(r => r.userId === m.id));
  const reviewRecords = completed.filter(needsAvailabilityReview);
  const reviewCount = reviewRecords.length;
  const fmt = (obj, labels = {}) => Object.entries(obj).map(([k, v]) => `• ${labels[k] || k}: **${v}**`).join('\n') || '—';

  await msg.channel.send({
    embeds: [{
      title: `👋 Onboarding Status — ${cohort.name}`,
      color: completed.length >= majority ? 0x2ecc71 : 0xe67e22,
      fields: [
        { name: 'Completed', value: `${completed.length} / ${eligible.length}`, inline: true },
        { name: 'Auto-finalize majority', value: String(majority), inline: true },
        { name: 'Groups finalized', value: finalized === '1' ? 'Yes' : 'Not yet', inline: true },
        { name: 'Availability review', value: String(reviewCount), inline: true },
        { name: 'By division/location', value: fmt(byDivision).slice(0, 1024) },
        { name: 'Job availability', value: fmt(byAvailability, {
          full_time: 'Full-time ready', limited: 'Limited availability', study: 'Study first',
        }).slice(0, 1024) },
      ],
      footer: { text: 'Gender answers are intentionally not listed. They are used only by the grouping algorithm.' },
    }],
  });
  if (missing.length) {
    const lines = missing.map(m => `• ${m.user.username}`);
    for (let i = 0; i < lines.length; i += 40) {
      await msg.channel.send({ content: `**Still needs onboarding:**\n${lines.slice(i, i + 40).join('\n')}`, allowedMentions: { parse: [] } });
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

async function sendOnboardingReminder(client, cohort, guild, channel) {
  const snapshot = await onboardingSnapshot(cohort, guild);
  if (!snapshot.incomplete.length) return { ...snapshot, sent: 0 };
  const rulesMessage = await ensureRulesMessage(client, cohort);
  for (let index = 0; index < snapshot.incomplete.length; index += 35) {
    const chunk = snapshot.incomplete.slice(index, index + 35);
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
  return { ...snapshot, sent: snapshot.incomplete.length };
}

async function repairOnboardingRoles(cohort, guild) {
  const snapshot = await onboardingSnapshot(cohort, guild);
  const liveIds = new Set(snapshot.eligible.map(member => member.id));
  const candidates = snapshot.records.filter(record => liveIds.has(String(record.userId)));
  const completed = candidates.filter(isComplete);
  const majority = Math.floor(snapshot.eligible.length / 2) + 1;
  const alreadyFinalized = await getState(cohort, finalizedKey(cohort));
  const shouldFinalize = alreadyFinalized === '1' || completed.length >= Math.max(2, majority);
  const before = { identity: 0, readiness: 0 };
  for (const record of candidates) {
    const member = snapshot.members.get(String(record.userId));
    if (!member) continue;
    const needs = onboardingRoleNeeds(record, [...member.roles.cache.values()].map(role => role.name));
    if (needs.identity) before.identity++;
    if (needs.readiness) before.readiness++;
  }

  const failures = [];
  const plannedGroups = groupsFromRecords(candidates, liveIds);
  for (const record of candidates) {
    const member = snapshot.members.get(String(record.userId));
    if (!member) continue;
    try {
      if (record.availability) await applyReadinessRole(member, record.availability);
      // Completed records are assigned once by the final rebalance below. Only
      // partial records need provisional recovery when final grouping applies.
      if (record.gender && record.division && (!shouldFinalize || !isComplete(record))) {
        let selected = plannedGroups.find(group => group.members.some(item => item.userId === record.userId));
        if (!selected || selected.division !== record.division || selected.members.length > MAX_GROUP_SIZE) {
          selected = chooseProvisionalGroup(plannedGroups, record, MAX_GROUP_SIZE);
        }
        let role;
        if (selected) {
          role = guild.roles.cache.get(selected.roleId) || await ensureRole(guild, selected.roleName);
          selected.roleId = role.id;
          selected.roleName = role.name;
          if (!selected.members.some(item => item.userId === record.userId)) selected.members.push(record);
        } else {
          const divisionGroupCount = plannedGroups.filter(group => group.division === record.division).length;
          role = await ensureRole(guild, identityRoleName(record.division, divisionGroupCount));
          selected = { roleId: role.id, roleName: role.name, division: record.division,
            genders: new Set([record.gender]), members: [record] };
          plannedGroups.push(selected);
        }
        await replaceRoles(member, roleItem => roleItem.name.startsWith(IDENTITY_PREFIX), role);
        record.groupRoleId = role.id;
        record.groupName = role.name;
        record.groupProvisional = true;
        await saveRecord(cohort, record);
      }
    } catch (error) {
      failures.push(`${member.user.username}: ${error.message}`);
    }
  }

  // Preserve the strict-majority behavior. If final grouping was already
  // reached, or is reached now, rebalance completed members after provisional
  // recovery so no member remains on a stale/missing identity role.
  let finalized = null;
  if (shouldFinalize) {
    try {
      finalized = await finalizeGroups(cohort, guild, snapshot);
    } catch (error) {
      failures.push(`Final rebalance: ${error.message}`);
    }
  }

  const remaining = { identity: 0, readiness: 0 };
  for (const record of candidates) {
    const member = await guild.members.fetch(String(record.userId)).catch(() => null);
    if (!member) continue;
    const needs = onboardingRoleNeeds(record, [...member.roles.cache.values()].map(role => role.name));
    if (needs.identity) remaining.identity++;
    if (needs.readiness) remaining.readiness++;
  }
  return { candidates: candidates.length, incomplete: snapshot.incomplete.length, before, remaining, failures, finalized };
}

module.exports = function registerOnboarding(client) {
  client.on('guildMemberAdd', async member => {
    const cohort = cohorts.find(c => c.guildId === member.guild.id);
    if (!cohort || member.user.bot || !cohort.channels.welcome || !cohort.channels.rules) return;
    try {
      const rulesMessage = await ensureRulesMessage(client, cohort);
      const channel = await client.channels.fetch(cohort.channels.welcome);
      await channel.send({
        content: `👋 Welcome ${member}! Please read the rules, complete your private contact profile, and finish private onboarding. Your email, phone, and other profile answers are never posted in this channel.`,
        components: publicComponents(rulesMessage.url, cohort),
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
        await interaction.editReply({ content: questionnaireContent(record), components: questionnaireRows(record, url) });
      } catch (err) {
        await interaction.editReply(`❌ Could not start onboarding: ${err.message}`);
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
        processOnboardingAnswer(client, interaction, cohort, field, interaction.values[0])
      ).catch(err => interaction.editReply(`❌ Could not save onboarding: ${err.message}`).catch(() => {}));
    }
  });

  client.on('messageCreate', async msg => {
    if (msg.author.bot) return;
    const lower = msg.content.trim().toLowerCase();
    if (!['!onboardingpanel', '!onboardingstatus', '!finalizegroups',
      '!completioncheck', '!completionreminder', '!onboardingrepair'].includes(lower) &&
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
      if (lower === '!onboardingrepair') {
        await msg.reply({ content: 'Repairing identity and job-readiness roles from saved private onboarding answers...', allowedMentions: { parse: [] } });
        const result = await enqueue(`groups:${cohort.guildId}`, () => repairOnboardingRoles(cohort, msg.guild));
        const lines = [
          `✅ Onboarding role repair checked **${result.candidates}** member record(s).`,
          `Before repair: **${result.before.identity}** missing identity role · **${result.before.readiness}** missing readiness role`,
          `Still missing: **${result.remaining.identity}** identity · **${result.remaining.readiness}** readiness`,
          `Private onboarding incomplete: **${result.incomplete}**`,
          result.finalized ? `Final grouping: **${result.finalized.participants}** members in **${result.finalized.groups}** teams` : 'Final grouping: majority threshold not reached yet',
        ];
        if (result.failures.length) lines.push('', '⚠️ Failures:', ...result.failures.slice(0, 20));
        return msg.channel.send({ content: lines.join('\n').slice(0, 1990), allowedMentions: { parse: [] } });
      }
      if (lower === '!completioncheck') return postCompletionCheck(msg, client, cohort, false);
      if (lower === '!completionreminder') {
        const result = await postCompletionCheck(msg, client, cohort, true);
        return msg.reply(result.incomplete.length
          ? `✅ Mentioned only the **${result.incomplete.length}** current student(s) who still need private onboarding or profile data in <#${cohort.channels.welcome}>.`
          : '✅ Every current student has completed private onboarding and profile data; no reminder was posted.');
      }
      if (lower === '!finalizegroups') {
        await msg.reply('⏳ Rebalancing completed members into final division teams (maximum six each)...');
        const result = await enqueue(`groups:${cohort.guildId}`, () => finalizeGroups(cohort, msg.guild));
        return msg.channel.send(`✅ Finalized **${result.participants}** members into **${result.groups}** groups.` +
          (result.failures.length ? `\n⚠️ Failed assignments:\n${result.failures.slice(0, 20).join('\n')}` : ''));
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
          await replaceRoles(member, r => r.name.startsWith(IDENTITY_PREFIX) || Object.values(READINESS_ROLES).includes(r.name), null);
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
module.exports.repairOnboardingRoles = repairOnboardingRoles;
module.exports.sendOnboardingReminder = sendOnboardingReminder;
