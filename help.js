// ============================================================
//  help.js - !help command reference (supervisor, #bot-admin)
// ============================================================
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { cohorts } = require('./config');

const CATEGORY_LABELS = [
  'Server setup',
  'Identity & roster',
  'Attendance & forms',
  'Outreach & jobs',
  'Questions & scores',
  'Workshop sessions',
  'Automation control',
  'New cohort',
  'Referrals & AI',
  'Forwarder & misc',
];

const SEARCH_SYNONYMS = {
  job: ['job', 'jobs', 'application', 'applications', 'apply'],
  jobs: ['job', 'jobs', 'application', 'applications', 'apply'],
  target: ['target', 'targets', 'goal', 'goals', 'quota'],
  member: ['member', 'members', 'student', 'students', 'roster'],
  profile: ['profile', 'onboarding', 'identity', 'data', 'survey'],
  absence: ['absence', 'absent', 'attendance', 'missing'],
  schedule: ['schedule', 'time', 'times', 'calendar', 'window'],
};

const SECTIONS = [
  ['🆕 Server setup', [
    ['/setup or !setup', 'Open/recover the private four-step guide; self-hosted owner always retains access'],
    ['!setupserver', 'Create missing channels, discover IDs, post+pin intros, start 3-day warm-up'],
    ['!ensurechannels', 'Create/reuse only missing standard channels and repair permissions; no announcements or warm-up reset'],
    ['!repairpermissions', 'Repair private/locked channel overwrites without reposting setup messages'],
    ['!announceall', 'Re-post + pin channel intro announcements'],
    ['!editannouncement <message link>', 'Open a private editor for a pinned bot-authored rules/intro message'],
    ['!checkperms', "Report the bot's permissions in every configured channel"],
    ['!onboardingpanel', 'Create or refresh the welcome panel and exact rules link'],
    ['!onboardingstatus', 'Private completion, division, availability, and role-profile summary'],
    ['!onboardingreminder [#channel]', 'Mention only members missing private onboarding; defaults to discussion'],
    ['!rolerepair [#channel]', 'Reconcile division, Dhaka-area, availability, work-mode, English and skill roles; mention missing profiles and retry after 2h'],
    ['!onboardingrepair', 'Compatibility alias for !rolerepair'],
    ['!completioncheck', 'Private combined check for incomplete onboarding or private profile'],
    ['!completionreminder', 'Mention only incomplete students in welcome with both private forms'],
    ['!finalizegroups', 'Retired compatibility command; directs mentors to !rolerepair'],
    ['!setrulesmessage <link>', 'Use an existing template message as the official rules'],
    ['!resetonboarding @member', 'Delete one member’s answers and managed onboarding roles'],
  ]],
  ['👥 Identity & roster', [
    ['!syncmembers', 'Sync every current Discord student; preserve Roster Review edits and repair all tracking rows'],
    ['!missingdata', 'Private dashboard: see missing profile fields and send students DM surveys'],
    ['!studentsurvey incomplete', 'Open the private missing-profile survey dashboard'],
    ['!studentsurvey attention [days] [send]', 'Preview or send surveys to incomplete students with no job activity'],
    ['!profilecheck', 'Refresh Discord-primary roster data and verify every current member/profile is captured'],
    ['!profilesurvey #channel', 'Mention incomplete students in one channel; answers open and submit privately'],
    ['!editprofile @student|ID', 'Supervisor correction form; a raw Discord ID avoids pinging the student'],
    ['!synchiredroles', 'Assign/reconcile Hired roles from explicit Bot_Map hired statuses'],
    ['!statusroles', 'Reconcile mutually exclusive Active Student / Inactive Student roles from verified Sheet status'],
    ['!audit', 'Two-way audit: server members ↔ Sheet database'],
    ['!addstudent <email> @user', 'Supervisor fallback to manually link one person'],
    ['!students [region] [sub]', 'Region directory with WhatsApp + resume links'],
    ['!active [top <n>]', 'Most engaged students (RTBR last 7 days) to spotlight'],
    ['!inactive [days <n>]', 'Students with no activity this week to reach out to'],
    ['!notapplying [days <n>]', 'Private copyable list of active students with no job-application activity'],
    ['!studentstatus @user active|inactive', 'Verified activation/deactivation; activation syncs Discord, clears inactive Sheet markers, and resets warnings'],
    ['!studentstatuspanel', 'Private status center with active/inactive counts, separate lists, and verified status-change buttons'],
    ['!activestudents [page n]', 'Open the active-student list directly; each inactivation requires confirmation'],
    ['!inactivestudents', 'Private inactive panel: activate or email one/all students with confirmation'],
    ['!warnings @user / !warnings undo|reset @user', 'Inspect, undo only the latest incident, or reset one student’s warning counter'],
    ['!warnings start YYYY-MM-DD', 'Set one cohort-wide warning baseline, rebase records, repair unfair warning inactivity, and publish a correction'],
    ['!warningreport', 'Private weekly inactive, warning-count, and attendance-absence report'],
    ['!appeals / !appeals all', 'Review pending or recent bootcamp and Dawn access appeals'],
    ['!appeal approve|decline <id> | note', 'Restore the requested scope or decline with a private mentor note'],
    ['!calllist', 'Inactive students with phone + one-click WhatsApp links'],
    ['!studentreport', 'Private one/all/severe-needs-attention picker; flagged students show review reasons'],
    ['!filllocations [tab | column]', 'Auto-fill Region/Subregion from a form tab'],
  ]],
  ['📋 Attendance & form', [
    ['!openform', 'Open the active form + post its link to students'],
    ['!forms', 'List forms bound to the sheet; !forms use <n> to switch active'],
    ['!forms link <edit URL|ID>', 'Link an existing attendance form even when no bound forms are listed'],
    ['!closeform', 'Close the form and post/update attendance 30 s later'],
    ['!closeform silent', 'Close the form without posting an attendance report'],
    ['!formstatus', 'Is the form open right now'],
    ['!attendance [YYYY-MM-DD]', 'Recheck and update today or one previous report'],
    ['!checkattendance [YYYY-MM-DD]', 'Private roster/response readiness audit; never posts or pings students'],
    ['!repairattendance', 'Add/update every active Discord-linked student in Attendance without changing marks'],
    ['!checkpipelines [YYYY-MM-DD] [all]', 'Private combined Attendance/jobs/outreach/interview audit; problems only by default'],
    ['!repairpipelines', 'Repair active identity rows and activity-tab schemas without deleting history'],
    ['!absent [current|previous|month week n]', 'Private copyable absence list with contact and consecutive-day counts'],
    ['!leave', 'Student: open a private leave request form in #issues'],
    ['!openleaves / !leaves', 'Supervisor: open one private paged leave manager for pending requests'],
    ['!leave approve|reject <request-id> | note', 'Supervisor fallback; every decision requires a mentor note and approved working dates become L'],
    ['!setupsheets existing|empty confirm', 'Build Jobs Applied, Outreach Update, and Interview Updates matrices; raw logs stay intact'],
    ['!arrangesheets', 'Rename active Form tabs and arrange/color review, reference, other-Form, and bot-data tabs'],
    ['!setupcohortsheet [Sheet URL]', 'Create/repair every required tab and bind a new Sheet when needed'],
    ['!setupcohortsheet cleanup confirm', 'Back up, then remove obsolete Form-response tabs'],
    ['!setupcohortsheet fresh confirm [URL]', 'Prepare an empty-history new-cohort workbook with clean formatting'],
  ]],
  ['📣 Outreach & jobs', [
    ['!backfilloutreach [N days]', 'Reconcile recent outreach messages; defaults to 3 calendar days, accepts 1-30, and preserves older events'],
    ['!backfillinterviews [N days]', 'Reconcile recent interview messages; defaults to 3 calendar days, accepts 1-30, and preserves older events'],
    ['!outreachcheck', 'Run the scheduled outreach follow-up report now'],
    ['!backfilljobsheets [N days]', 'Import recent tracker links; defaults to 3 calendar days and accepts 1-30'],
    ['!jobscheck [YYYY-MM-DD]', 'Run today or recover one missed dated jobs check'],
    ['!checkjobsheets [YYYY-MM-DD]', 'Deep private tracker audit across public tabs; keeps contacts private, never pings/writes'],
    ['!activityprompt outreach|interview|communication|all', 'Post one or all daily @everyone activity templates now'],
    ['!activitycheck attendance [YYYY-MM-DD]|jobs|interviews|all', 'Run checks now; attendance/jobs post private contact TSV in bot-admin'],
    ['!followup <type> [days N] [#channel]', 'Preview then manually announce selected gaps; never changes scheduled automation'],
    ['!repairinterviews', 'Remove exact historical Interview_Log duplicates and rebuild interview serials'],
  ]],
  ['❓ Questions & scores', [
    ['!questions', 'Open the private clickable morning/afternoon/evening question scheduler'],
    ['!questions channel #channel', 'Set a dedicated question destination (not discussion)'],
    ['!questions amounts <morning> <afternoon> <evening>', 'Set the three daily question amounts'],
    ['!dropquestion [cat] [workshop|discussion]', 'Drop one question now'],
    ['!genquestions <cat> <count>', 'AI-generate questions (auto-refill also exists)'],
    ['!leaderboard', 'Post the question-score leaderboard now'],
    ['!weeklyreport', 'Post the full performance leaderboard now in #discussion'],
    ['!rtbr', 'Post RTBR and assign the Right to Be Referred role to the qualified top students'],
    ['!rtbr top <1-25> / !rtbr days <1-90>', 'Change qualified-role quantity or rolling scoring window'],
    ['!rtbr time HH:MM', 'Change the weekly RTBR calculation/role-assignment time'],
    ['!replanquestions', 'Replace today’s remaining question timers after changing counts/hours'],
  ]],
  ['🎤 Workshop sessions', [
    ['!workshop', 'Open private daily and Dawn special-workshop controls'],
    ['!workshopannounce', 'Request a private confirmation before posting today’s workshop schedule'],
    ['!workshoppoll', 'Open an attendance poll now (auto 40 min into each slot)'],
    ['!specialworkshop', 'Open the Dawn Focus special-workshop schedule and approval controls'],
  ]],
  ['🎛 Control (annoyance prevention)', [
    ['!control', 'One private overview of switches, targets, times, schedules, students, and cohort controls'],
    ['!automation [list|start|stop] <key|all>', 'Master on/off - works instantly, even mid-day'],
    ['!automation starter', 'Safe new-cohort preset: keep attendance/jobs/sync active; hold noisy programmes and hide only their workflow channels'],
    ['!targets / !target <metric> <amount>', 'View/change goals: applications, outreach, attendance, interviews, communication, workshops'],
    ['!times / !time <name> HH:MM', 'View/change automation clock times in this cohort timezone'],
    ['!settings / !set <key> <value>', 'Advanced settings: times, quantities, question hours, slots...'],
    ['!set channel_<name> #channel', 'Redirect any automation to another channel'],
    ['!accessrules list|defaults|apply', 'Manage durable role/channel visibility rules; defaults hide job posts only from inactive students'],
    ['!accessrules block|unblock|allow @role #channel', 'Block any role from a channel, restore inheritance, or explicitly allow viewing; deny/remove aliases also work'],
    ['!mailer status|enable|disable|quota', 'Configure the private post-attendance BCC mailer and check Apps Script recipient quota'],
    ['!mailer to|cc|bcc <emails|none>', 'Set administrative mail headers; student recipients always remain BCC-only'],
    ['!mailer replyto|sender|mentor|phone <value>', 'Set the reply address, sender label, mentor name, and mentor phone used by templates'],
    ['!mailer template|preview <type>', 'Edit or preview absent, warning1, warning2, or inactive email templates'],
    ['!mailer send absent|warnings|all [YYYY-MM-DD]', 'Reconcile the full absent count, attach a private recipient/skipped-reason TSV, and confirm an idempotent mail run'],
    ['!exclude @user / !include @user / !excluded', 'Remove a student from ALL warnings & DMs'],
    ['!say #channel <message>', 'Send any one-off announcement as the bot'],
    ['!announce <channelkey>', 'Post + pin intro in ONE channel (vs !announceall)'],
    ['!jp [natural language]', 'Private command finder: asks one focused follow-up when needed, then suggests verified commands without running them'],
  ]],
  ['🆕 New cohort', [
    ['/setup or !setup', 'Open guided setup; self-hosted owner recovery is automatic'],
    ['!cohorts', 'Private add/update/retire panel for the managed one-bot deployment'],
    ['!backend / !backend help', 'View/edit uptime; dated `override ... always|HH:MM-HH:MM` keeps special dates online without changing the regular schedule'],
    ['!supervisor list|add @user|remove @user', 'Manage this server’s supervisors, private permissions, and roster exclusion'],
    ['!intake status|enable [slug]|disable|link', 'Control the secure pre-entry Discord OAuth portal and share its cohort-specific link'],
    ['!setupcohortsheet [Sheet URL]', 'One-command required Sheet/tab/trigger setup'],
    ['!formtemplate', 'Show editable/saved form-template commands (use in #bot-admin)'],
    ['!formtemplate show enrollment|attendance', 'Review every working-template question and choice'],
    ['!createforms <cohort name>', 'Build forms from the validated working template'],
    ['!createforms attendance [cohort name]', 'Portal cohorts: create only the daily attendance Google Form'],
    ['!designforms <description>', 'AI-design, save, approve, and build an editable template'],
    ['!addstudent <email> @user', 'Add a student to Bot_Map + Attendance'],
  ]],
  ['🎯 Referrals & AI', [
    ['!match <paste JD>', 'AI: best candidates for a job (skills, location, projects, RTBR)'],
    ['!suggest', 'AI activity suggestion → react ✅ to post to students'],
    ['!dmnudges', 'DM lagging students now (automatic time is configurable when enabled)'],
    ['!cleanbank', 'Remove C#/.NET questions from the bank'],
    ['!groqstatus', 'AI API quota + key rotation status'],
    ['!filllocations [tab | column]', 'Auto-fill Region/Subregion from a form tab'],
  ]],
  ['📡 Forwarder & misc', [
    ['!cohortstatus', "Private health check for this server's Discord, channels, and Sheet backend"],
    ['!forwarder status|start|stop', 'Private control; status verifies live channel access'],
    ['!forwarder set <srcId> <dstId>', 'Validate and save a cross-server route; remains OFF until started'],
    ['!backupresources / !postresource', 'Preserve #resources in Sheet / repost one'],
    ['!resourcesync status|on|off', 'Opt this cohort into new STRIDE supervisor resources'],
    ['!contentsync source <server-id|control>', 'Save the old cohort used for reusable Resources and Job Hunting content'],
    ['!contentsync run resources|jobhunting one|all', 'Copy one next item or the complete remaining backlog'],
    ['!contentsync auto resources|jobhunting on|off', 'Enable or disable one-item periodic backfill'],
    ['!dawn setup|invite|status|review|repair|sync', 'Manage Dawn Focus; sync reconciles every current role member into the canonical Sheet'],
    ['!dawn window [always|HH:MM-HH:MM]', 'Show or set when members can send; separate from attendance'],
    ['!dawn attendance [HH:MM-HH:MM]', 'Show or set the exact Sun–Thu attendance scan window (default 05:00–07:00)'],
    ['!dawn add|remove @student', 'Restore or remove one student’s Dawn Focus access'],
    ['!groupactivities setup|sync|status', 'Create the group-activities hub and private threads from identity-region roles'],
    ['!dailyreport', "Today's in-memory activity + failures (manual only)"],
    ['!schedule [key] [days]', 'Set days for attendance, jobs, outreach, questions, workshop, leaderboards, weekly reports, RTBR, resources, nudges, or suggestions'],
    ['!calendar / !calendar help', 'Open the date selector or set regular workdays and announced holiday/working overrides'],
    ['!doctor [check]', 'Self-diagnosis including Sheet, Discord, roster, tracker, and forwarder route/state'],
    ['!help / !commands / !commandcenter', 'Open the searchable, category-based private Command Center; use !help all for the full list'],
  ]],
];

function sectionFields(name, commands) {
  const fields = [];
  let value = '';
  for (const [command, description] of commands) {
    const entry = `\`${command}\`\n↳ ${description}`;
    if (value && value.length + entry.length + 1 > 1024) {
      fields.push({ name: fields.length ? `${name} (continued)` : name, value });
      value = '';
    }
    value += `${value ? '\n' : ''}${entry}`;
  }
  if (value) fields.push({ name: fields.length ? `${name} (continued)` : name, value });
  return fields;
}

function helpPayloads() {
  const payloads = [];
  let fields = [];
  let size = 100;
  for (const [name, commands] of SECTIONS) {
    for (const field of sectionFields(name, commands)) {
      const fieldSize = field.name.length + field.value.length;
      if (fields.length >= 20 || size + fieldSize > 5500) {
        payloads.push(fields);
        fields = [];
        size = 100;
      }
      fields.push(field);
      size += fieldSize;
    }
  }
  if (fields.length) payloads.push(fields);
  return payloads.map((group, index) => ({
    embeds: [{
      title: index ? '🤖 JP ADMIN — Command Reference (continued)' : '🤖 JP ADMIN — Command Reference',
      color: 0xd4af37,
      fields: group,
      footer: { text: `Part ${index + 1}/${payloads.length} · All commands are supervisor-only.` },
    }],
    allowedMentions: { parse: [] },
  }));
}

function catalogEntries() {
  return SECTIONS.flatMap(([section, commands], sectionIndex) => commands.map(([command, description]) => ({
    section,
    sectionIndex,
    category: CATEGORY_LABELS[sectionIndex] || `Category ${sectionIndex + 1}`,
    command,
    description,
  })));
}

function searchCommands(query, limit = 20) {
  const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { matches: [], total: 0 };
  const ranked = catalogEntries().map(entry => {
    const command = entry.command.toLowerCase();
    const haystack = `${entry.category} ${entry.section} ${entry.command} ${entry.description}`.toLowerCase();
    if (!terms.every(term => (SEARCH_SYNONYMS[term] || [term]).some(candidate => haystack.includes(candidate)))) return null;
    const exact = command === terms.join(' ');
    const prefix = command.startsWith(`!${terms[0]}`) || command.startsWith(terms[0]);
    return { ...entry, rank: exact ? 0 : prefix ? 1 : 2 };
  }).filter(Boolean).sort((a, b) => a.rank - b.rank || a.sectionIndex - b.sectionIndex || a.command.localeCompare(b.command));
  return { matches: ranked.slice(0, limit), total: ranked.length };
}

function entriesToFields(name, entries) {
  return sectionFields(name, entries.map(entry => [entry.command, entry.description]));
}

function categoryPayload(sectionIndex) {
  const index = Number(sectionIndex);
  const section = SECTIONS[index];
  if (!section) return null;
  const category = CATEGORY_LABELS[index] || `Category ${index + 1}`;
  const entries = section[1].map(([command, description]) => ({ command, description }));
  return {
    embeds: [{
      title: `JP ADMIN Command Center — ${category}`,
      color: 0x5865f2,
      fields: entriesToFields(category, entries),
      footer: { text: `${entries.length} commands · Copy a command and send it in #bot-admin.` },
    }],
    allowedMentions: { parse: [] },
  };
}

function searchPayload(query) {
  const result = searchCommands(query);
  const fields = result.matches.length
    ? entriesToFields(`Results for “${String(query).trim().slice(0, 80)}”`, result.matches)
    : [{ name: 'No matches', value: 'Try a shorter term such as `attendance`, `jobs`, `survey`, `dawn`, `schedule`, or `cohort`.' }];
  return {
    embeds: [{
      title: 'JP ADMIN Command Search',
      color: result.matches.length ? 0x2ecc71 : 0xe67e22,
      fields,
      footer: {
        text: result.total > result.matches.length
          ? `Showing ${result.matches.length} of ${result.total} matches. Use a more specific search.`
          : `${result.total} matching command${result.total === 1 ? '' : 's'}.`,
      },
    }],
    allowedMentions: { parse: [] },
  };
}

function commandCenterComponents(cohort) {
  const categoryMenu = new StringSelectMenuBuilder()
    .setCustomId(`cmdcenter:category:${cohort.guildId}`)
    .setPlaceholder('Choose a command category')
    .addOptions(SECTIONS.map(([, commands], index) => ({
      label: CATEGORY_LABELS[index] || `Category ${index + 1}`,
      description: `${commands.length} available command${commands.length === 1 ? '' : 's'}`,
      value: String(index),
    })));
  return [
    new ActionRowBuilder().addComponents(categoryMenu),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cmdcenter:search:${cohort.guildId}`).setLabel('Search commands').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`cmdcenter:all:${cohort.guildId}`).setLabel('Full reference').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function commandCenterPayload(cohort, ephemeral = false) {
  const commandCount = SECTIONS.reduce((sum, [, commands]) => sum + commands.length, 0);
  return {
    embeds: [{
      title: `JP ADMIN — ${cohort.name} Command Center`,
      color: 0xd4af37,
      description: [
        'Choose a category or search by what you want to do.',
        'Examples: `attendance`, `job target`, `missing profile`, `holiday`, or `Dawn`.',
        '',
        `**${commandCount} commands** across **${SECTIONS.length} categories**. Results are visible only to you.`,
      ].join('\n'),
      footer: { text: 'Supervisor-only · This server’s commands and settings remain cohort-specific.' },
    }],
    components: commandCenterComponents(cohort),
    allowedMentions: { parse: [] },
    ...(ephemeral ? { ephemeral: true } : {}),
  };
}

function searchModal(cohort) {
  return new ModalBuilder()
    .setCustomId(`cmdcenter:searchsubmit:${cohort.guildId}`)
    .setTitle('Search JP ADMIN commands')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('query')
        .setLabel('What do you want to do?')
        .setPlaceholder('Example: attendance, job target, or missing profile')
        .setStyle(TextInputStyle.Short)
        .setMinLength(2)
        .setMaxLength(80)
        .setRequired(true),
    ));
}

function authorizedCohort(event, guildId) {
  const cohort = cohorts.find(item => item.guildId === event.guildId && item.guildId === guildId);
  if (!cohort || !cohort.supervisorIds.includes(event.user?.id || event.author?.id)) return null;
  return cohort;
}

async function sendFullReference(interaction) {
  const payloads = helpPayloads();
  await interaction.reply({ ...payloads[0], ephemeral: true });
  for (const payload of payloads.slice(1)) await interaction.followUp({ ...payload, ephemeral: true });
}

module.exports = function registerHelp(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const match = msg.content.trim().match(/^!(?:help|commands|commandcenter)(?:\s+(.+))?$/i);
    if (!match) return;
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;
    if (msg.channelId !== cohort.channels.supervisor) {
      await msg.reply({ content: `Open the Command Center in <#${cohort.channels.supervisor}>.`, allowedMentions: { parse: [] } });
      return;
    }
    const query = String(match[1] || '').trim();
    if (/^all$/i.test(query)) {
      for (const payload of helpPayloads()) await msg.channel.send(payload);
      return;
    }
    if (query) {
      await msg.channel.send(searchPayload(query));
      return;
    }
    await msg.channel.send(commandCenterPayload(cohort));
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.customId?.startsWith('cmdcenter:')) return;
    const [, action, guildId] = interaction.customId.split(':');
    const cohort = authorizedCohort(interaction, guildId);
    if (!cohort || interaction.channelId !== cohort.channels.supervisor) {
      if (interaction.isRepliable()) await interaction.reply({ content: 'This Command Center is restricted to this cohort’s mentors in #bot-admin.', ephemeral: true });
      return;
    }
    try {
      if (action === 'open' && interaction.isButton()) {
        await interaction.reply(commandCenterPayload(cohort, true));
        return;
      }
      if (action === 'category' && interaction.isStringSelectMenu()) {
        const payload = categoryPayload(interaction.values[0]);
        await interaction.reply({ ...(payload || searchPayload('')), ephemeral: true });
        return;
      }
      if (action === 'search' && interaction.isButton()) {
        await interaction.showModal(searchModal(cohort));
        return;
      }
      if (action === 'searchsubmit' && interaction.isModalSubmit()) {
        await interaction.reply({ ...searchPayload(interaction.fields.getTextInputValue('query')), ephemeral: true });
        return;
      }
      if (action === 'all' && interaction.isButton()) await sendFullReference(interaction);
    } catch (error) {
      const payload = { content: `Command Center failed: ${error.message.slice(0, 250)}`, ephemeral: true, allowedMentions: { parse: [] } };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => null);
      else if (interaction.isRepliable()) await interaction.reply(payload).catch(() => null);
    }
  });
};

module.exports.SECTIONS = SECTIONS;
module.exports.helpPayloads = helpPayloads;
module.exports.sectionFields = sectionFields;
module.exports.catalogEntries = catalogEntries;
module.exports.searchCommands = searchCommands;
module.exports.categoryPayload = categoryPayload;
module.exports.searchPayload = searchPayload;
module.exports.commandCenterPayload = commandCenterPayload;
