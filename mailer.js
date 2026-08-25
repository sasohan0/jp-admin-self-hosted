'use strict';

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { cohorts } = require('./config');
const { appsScriptGet, appsScriptPost } = require('./apps-script-api');
const { getRoster, isExcluded } = require('./roster');
const { isOn, setOn } = require('./automations');
const {
  DEFAULT_TEMPLATES,
  TEMPLATE_TYPES,
  buildMailerAudience,
  normalizeEmail,
  normalizeEmailList,
  normalizeMailerConfig,
  renderTemplate,
  templateVariables,
} = require('./mailer-rules');
const { validDateKey, dateKeyInZone } = require('./work-calendar');

const pendingSends = new Map();
const PENDING_MS = 10 * 60 * 1000;
const MAIL_RECIPIENTS_PER_MESSAGE = 50;

function configKey(cohort) {
  return `cohort_mailer_config_v1_${cohort.guildId}`;
}

async function loadMailerConfig(cohort) {
  const data = await appsScriptGet(cohort, { action: 'getstate', k: configKey(cohort) }, {
    label: 'Cohort mailer configuration',
  });
  try { return normalizeMailerConfig(JSON.parse(String(data.value || '{}')), cohort.name); }
  catch { return normalizeMailerConfig({}, cohort.name); }
}

async function saveMailerConfig(cohort, config) {
  const normalized = normalizeMailerConfig(config, cohort.name);
  await appsScriptPost(cohort, {
    action: 'setState', k: configKey(cohort), v: JSON.stringify(normalized),
  }, { idempotent: true, label: 'Cohort mailer configuration write' });
  return normalized;
}

function selectedMailTypes(value) {
  const key = String(value || 'all').toLowerCase();
  if (key === 'warnings') return ['warning1', 'warning2', 'inactive'];
  if (key === 'all') return [...TEMPLATE_TYPES];
  return TEMPLATE_TYPES.includes(key) ? [key] : [];
}

function mailerCounts(groups) {
  return Object.fromEntries(TEMPLATE_TYPES.map(type => [type, groups[type]?.length || 0]));
}

function mailerAudienceSummary(groups, recordedAbsentCount = 0) {
  const counts = mailerCounts(groups);
  const eligible = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const missingEmail = groups?.skippedNoEmail?.length || 0;
  const alreadyInactive = groups?.skippedInactive?.length || 0;
  const excludedBeforeReport = groups?.excludedBeforeReport?.length || 0;
  const duplicateEmail = groups?.skippedDuplicateEmail?.length || 0;
  const recordedAbsent = Math.max(0, Number(recordedAbsentCount) || 0);
  const accounted = eligible + missingEmail + alreadyInactive + duplicateEmail;
  return {
    counts,
    eligible,
    missingEmail,
    alreadyInactive,
    excludedBeforeReport,
    duplicateEmail,
    recordedAbsent,
    unreconciled: Math.max(0, recordedAbsent - accounted),
  };
}

function mailerRecipientAudit(groups, types) {
  const rows = ['RESULT\tMAIL TYPE\tNAME\tEMAIL\tDISCORD ID\tREASON'];
  for (const type of types || []) {
    for (const student of groups?.[type] || []) {
      rows.push([
        'ELIGIBLE',
        type,
        String(student.name || student.displayName || 'Unknown').replace(/[\t\r\n]+/g, ' ').trim(),
        normalizeEmail(student.email) || 'NO VALID EMAIL',
        String(student.discordId || ''),
        '',
      ].join('\t'));
    }
  }
  const skippedGroups = [
    ['excludedBeforeReport', 'NOT IN ATTENDANCE REPORT', 'excluded', 'Excluded from attendance tracking before the report; not counted absent or emailed'],
    ['skippedInactive', 'SKIPPED', 'inactive', 'Already inactive before this mail run; use !inactivestudents for a recovery email'],
    ['skippedNoEmail', 'SKIPPED', 'unknown', 'No valid student email'],
    ['skippedDuplicateEmail', 'SKIPPED', 'unknown', 'Another student row already uses this email'],
  ];
  for (const [groupKey, result, fallbackType, reason] of skippedGroups) {
    for (const student of groups?.[groupKey] || []) {
      const mailType = String(student.mailType || fallbackType);
      if (!['skippedInactive', 'excludedBeforeReport'].includes(groupKey) &&
          !(types || []).includes(mailType)) continue;
      rows.push([
        result,
        mailType,
        String(student.name || student.displayName || 'Unknown').replace(/[\t\r\n]+/g, ' ').trim(),
        normalizeEmail(student.email) || 'NO VALID EMAIL',
        String(student.discordId || ''),
        reason,
      ].join('\t'));
    }
  }
  return rows.length > 1 ? rows.join('\n') : '';
}

function recipientAuditFile(cohort, date, groups, types) {
  const audit = mailerRecipientAudit(groups, types);
  if (!audit) return [];
  const cohortName = String(cohort.name || 'cohort').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 50);
  return [{
    attachment: Buffer.from(audit, 'utf8'),
    name: `${cohortName}-${date}-mailer-recipients.tsv`,
  }];
}

async function prepareMailerRun(cohort, date, options = {}) {
  const config = options.config || await loadMailerConfig(cohort);
  const [roster, absences, warningData] = await Promise.all([
    getRoster(cohort, true),
    appsScriptGet(cohort, {
      action: 'absences', start: date, end: date, guildId: cohort.guildId,
      // Include a student who became inactive from today's third warning so
      // the one-time inactive email can still verify today's absence.
      includeExcluded: 1,
    }, { label: 'Attendance mailer absence read' }),
    appsScriptGet(cohort, {
      action: 'getstate', k: `attendance_warning_state_v1_${cohort.guildId}`,
    }, { label: 'Attendance mailer warning-state read' }),
  ]);
  let warningState = {};
  try { warningState = JSON.parse(String(warningData.value || '{}')); } catch { warningState = {}; }
  const sessionRecorded = (absences.recordedSessions || []).includes(date);
  const groups = buildMailerAudience({
    roster,
    absentStudents: sessionRecorded ? (absences.students || []) : [],
    warningState,
    date,
    isInactive: student => isExcluded(cohort, student),
  });
  const absentIds = new Set((absences.students || [])
    .map(student => String(student.discordId || '').trim()).filter(Boolean));
  const absentEmails = new Set((absences.students || [])
    .map(student => normalizeEmail(student.email)).filter(Boolean));
  groups.excludedBeforeReport = roster.filter(student => {
    if (!isExcluded(cohort, student)) return false;
    const id = String(student.discordId || '').trim();
    const email = normalizeEmail(student.email);
    return !(id && absentIds.has(id)) && !(email && absentEmails.has(email));
  });
  return {
    config,
    date,
    groups,
    sessionRecorded,
    recordedAbsentCount: sessionRecorded ? (absences.students || []).length : 0,
    skippedNoEmail: groups.skippedNoEmail || [],
    skippedInactive: groups.skippedInactive || [],
  };
}

function batchesFor(prepared, types) {
  const batches = [];
  const administrativeRecipients = normalizeEmailList([
    ...(prepared.config.to || []),
    ...(prepared.config.cc || []),
    ...(prepared.config.bcc || []),
  ]);
  const studentCapacity = MAIL_RECIPIENTS_PER_MESSAGE - administrativeRecipients.length;
  const administrativeSet = new Set(administrativeRecipients);
  if (studentCapacity < 1 && types.some(type => (prepared.groups[type] || []).length)) {
    throw new Error(`To/CC/additional BCC must leave at least one of Google's ${MAIL_RECIPIENTS_PER_MESSAGE} recipient slots for students`);
  }
  for (const type of types) {
    const students = (prepared.groups[type] || []).filter(student =>
      !administrativeSet.has(normalizeEmail(student.email)));
    const variables = templateVariables(prepared.config, prepared.cohort, prepared.date, type);
    const template = prepared.config.templates[type];
    for (let index = 0; index < students.length; index += studentCapacity) {
      const chunk = students.slice(index, index + studentCapacity);
      batches.push({
        type,
        part: Math.floor(index / studentCapacity) + 1,
        students: chunk,
        studentBcc: chunk.map(student => student.email),
        subject: renderTemplate(template.subject, variables),
        body: renderTemplate(template.body, variables),
      });
    }
  }
  return batches;
}

function mailerBatchKey(cohort, prepared, batch) {
  const scope = String(prepared.batchScope || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60);
  return `${cohort.guildId}:${prepared.date}:${batch.type}:${scope ? `${scope}:` : ''}${batch.part}`;
}

async function sendPreparedMailer(cohort, prepared, types) {
  if (!prepared.config.to.length) throw new Error('configure at least one private To address before sending');
  const batches = batchesFor({ ...prepared, cohort }, types);
  const results = [];
  for (const batch of batches) {
    const response = await appsScriptPost(cohort, {
      action: 'sendCohortEmailBatch',
      guildId: cohort.guildId,
      cohort: cohort.name,
      date: prepared.date,
      mailType: batch.type,
      batchKey: mailerBatchKey(cohort, prepared, batch),
      to: prepared.config.to,
      cc: prepared.config.cc,
      extraBcc: prepared.config.bcc,
      studentBcc: batch.studentBcc,
      replyTo: prepared.config.replyTo,
      senderName: prepared.config.senderName,
      subject: batch.subject,
      body: batch.body,
    }, { idempotent: true, label: `Cohort ${batch.type} email batch` });
    results.push({ ...response, type: batch.type, count: batch.students.length, part: batch.part });
  }
  const delivery = mailerDeliverySummary(results);
  return { batches: results, counts: mailerCounts(prepared.groups), ...delivery };
}

function mailerDeliverySummary(results = []) {
  const newlySent = results.filter(item => !item.duplicate && item.status === 'sent');
  const previouslySent = results.filter(item => item.duplicate && item.status === 'sent');
  return {
    sentRecipients: newlySent.reduce((sum, item) => sum + Number(item.count || 0), 0),
    sentBatches: newlySent.length,
    previouslySentRecipients: previouslySent.reduce((sum, item) =>
      sum + Number(item.recipients || item.count || 0), 0),
    previouslySentBatches: previouslySent.length,
  };
}

async function queueInactiveMailerConfirmation(cohort, authorId, students, scope = 'all') {
  const config = await loadMailerConfig(cohort);
  if (!config.to.length) throw new Error('configure at least one private To address first with `!mailer to you@example.com`');
  const seenIds = new Set();
  const seenEmails = new Set();
  const recipients = [];
  const skipped = [];
  for (const student of students || []) {
    const discordId = String(student.discordId || '').trim();
    const email = normalizeEmail(student.email);
    if (!discordId || seenIds.has(discordId)) continue;
    seenIds.add(discordId);
    if (!email || seenEmails.has(email)) {
      skipped.push(student);
      continue;
    }
    seenEmails.add(email);
    recipients.push({ ...student, discordId, email });
  }
  if (!recipients.length) throw new Error('no selected inactive student has a valid email address');
  const date = dateKeyInZone(cohort.timezone);
  const safeScope = scope === 'all'
    ? 'inactive-roster'
    : `inactive-student-${String(scope || '').replace(/\D/g, '').slice(0, 22)}`;
  const prepared = {
    config,
    date,
    groups: {
      absent: [], warning1: [], warning2: [], inactive: recipients,
      skippedNoEmail: skipped, skippedInactive: [], skippedDuplicateEmail: [],
    },
    skippedNoEmail: skipped,
    skippedInactive: [],
    sessionRecorded: true,
    recordedAbsentCount: recipients.length + skipped.length,
    batchScope: safeScope,
  };
  prunePending();
  const token = Math.random().toString(36).slice(2, 10);
  pendingSends.set(token, {
    cohortId: cohort.guildId,
    authorId: String(authorId),
    prepared,
    types: ['inactive'],
    createdAt: Date.now(),
  });
  const recipientPreview = recipients.slice(0, 12)
    .map(student => `• ${student.name || student.displayName || student.discordId} — ${student.email}`);
  return {
    content: [
      `📧 **Confirm inactive-student mail — ${cohort.name}**`,
      `Selected valid recipients: **${recipients.length}** · missing/invalid email: **${skipped.length}**`,
      'You remain the visible To recipient. Every student address is sent privately in BCC and will not appear in your received copy.',
      '',
      ...recipientPreview,
      recipients.length > recipientPreview.length ? `• …and ${recipients.length - recipientPreview.length} more` : '',
    ].filter(Boolean).join('\n').slice(0, 1900),
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mailer:confirm:${cohort.guildId}:${token}`)
        .setLabel(`Send inactive email (${recipients.length})`).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`mailer:cancel:${cohort.guildId}:${token}`)
        .setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )],
    files: recipientAuditFile(cohort, date, prepared.groups, ['inactive']),
    allowedMentions: { parse: [] },
  };
}

async function runAttendanceMailer(client, cohort, date, options = {}) {
  const config = await loadMailerConfig(cohort);
  if (options.automatic && !(await isOn(cohort, 'mailer'))) return { skipped: true, reason: 'disabled' };
  const prepared = await prepareMailerRun(cohort, date, { config });
  const types = selectedMailTypes(options.types || 'all');
  const result = await sendPreparedMailer(cohort, prepared, types);
  const summary = mailerAudienceSummary(prepared.groups, prepared.recordedAbsentCount);
  if (options.notify !== false && cohort.channels.supervisor) {
    const channel = await client.channels.fetch(cohort.channels.supervisor).catch(() => null);
    await channel?.send({
      content: [
        `📧 **Attendance mailer — ${cohort.name} · ${date}**`,
        `• Attendance report absent: **${summary.recordedAbsent}** · eligible email recipients: **${summary.eligible}**`,
        `• Absent: **${result.counts.absent}** · warning 1: **${result.counts.warning1}** · warning 2: **${result.counts.warning2}** · inactive: **${result.counts.inactive}**`,
        `• Newly mailed recipients: **${result.sentRecipients}** · batches processed: **${result.batches.length}**`,
        result.previouslySentRecipients
          ? `• Already sent earlier and safely skipped: **${result.previouslySentRecipients}** recipient(s) in **${result.previouslySentBatches}** batch(es)`
          : '',
        `• Excluded before the attendance report: **${summary.excludedBeforeReport}** (not counted absent or emailed)`,
        `• Returned as absent but skipped inactive: **${summary.alreadyInactive}** · missing/invalid email: **${summary.missingEmail}** · duplicate email: **${summary.duplicateEmail}**`,
        summary.unreconciled ? `• ⚠️ Unreconciled absence rows: **${summary.unreconciled}** (see the private audit and run \`!profilecheck\`)` : '',
        prepared.sessionRecorded ? '' : '• No attendance session was recorded for this date, so no ordinary absence email was generated.',
      ].filter(Boolean).join('\n'),
      files: recipientAuditFile(cohort, date, prepared.groups, types),
      allowedMentions: { parse: [] },
    }).catch(() => {});
  }
  return { ...result, prepared };
}

function maskedList(values) {
  return values.length ? values.join(', ') : '— not set';
}

function statusMessage(cohort, config, quota, enabled = config.enabled) {
  return [
    `📧 **Cohort mailer — ${cohort.name}**`,
    `• Automatic post-attendance mail: **${enabled ? 'ON' : 'OFF'}**`,
    `• To: ${maskedList(config.to)}`,
    `• CC: ${maskedList(config.cc)} (Programming Hero audit address is always included)`,
    `• Additional BCC: ${maskedList(config.bcc)}`,
    `• Reply-To: ${config.replyTo || '— not set'}`,
    `• Sender: ${config.senderName}`,
    quota === undefined ? '' : `• Apps Script email recipients remaining today: **${quota}**`,
    '',
    '`!mailer to|cc|bcc <emails|none>` · `replyto <email|none>`',
    '`!mailer sender <name>` · `mentor <name>` · `phone <number>`',
    '`!mailer template absent|warning1|warning2|inactive` · `preview <type>`',
    '`!mailer send absent|warnings|all [YYYY-MM-DD]` · `enable|disable` · `quota`',
  ].filter(Boolean).join('\n');
}

function templateModal(cohort, type, config) {
  const template = config.templates[type];
  return new ModalBuilder()
    .setCustomId(`mailer:template:${cohort.guildId}:${type}`)
    .setTitle(`Edit ${type} email`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('subject').setLabel('Subject')
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(180)
          .setValue(template.subject.slice(0, 180)),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('body').setLabel('Plain-text email body')
          .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)
          .setValue(template.body.slice(0, 4000)),
      ),
    );
}

function previewMessage(cohort, config, type) {
  const variables = templateVariables(config, cohort, dateKeyInZone(cohort.timezone), type);
  return {
    embeds: [{
      title: `Email preview: ${type}`,
      color: type === 'inactive' ? 0xe74c3c : type.startsWith('warning') ? 0xf39c12 : 0x3498db,
      fields: [
        { name: 'Subject', value: renderTemplate(config.templates[type].subject, variables).slice(0, 1024) },
        { name: 'Body', value: renderTemplate(config.templates[type].body, variables).slice(0, 1024) },
      ],
      footer: { text: 'BCC recipients never see one another. Use !mailer template <type> to edit.' },
    }],
    allowedMentions: { parse: [] },
  };
}

function prunePending() {
  const now = Date.now();
  for (const [token, pending] of pendingSends) if (now - pending.createdAt > PENDING_MS) pendingSends.delete(token);
}

module.exports = function registerMailer(client) {
  client.on('messageCreate', async msg => {
    if (msg.author.bot || !/^!mailer(?:\s|$)/i.test(msg.content.trim())) return;
    const cohort = cohorts.find(item => item.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;
    if (msg.channelId !== cohort.channels.supervisor) {
      await msg.reply(`Run the mailer privately in <#${cohort.channels.supervisor}>.`);
      return;
    }
    try {
      const content = msg.content.trim();
      const parts = content.split(/\s+/);
      const action = String(parts[1] || 'status').toLowerCase();
      let config = await loadMailerConfig(cohort);
      if (['status', 'list'].includes(action)) {
        await msg.channel.send({ content: statusMessage(cohort, config, undefined, await isOn(cohort, 'mailer')), allowedMentions: { parse: [] } });
        return;
      }
      if (['enable', 'disable'].includes(action)) {
        if (action === 'enable' && !config.to.length) throw new Error('set a private To address first with `!mailer to you@example.com`');
        config.enabled = action === 'enable';
        config = await saveMailerConfig(cohort, config);
        await setOn(cohort, 'mailer', config.enabled);
        await msg.reply(`📧 Automatic attendance/warning mail is now **${config.enabled ? 'ON' : 'OFF'}**.`);
        return;
      }
      if (['to', 'cc', 'bcc'].includes(action)) {
        const raw = content.replace(new RegExp(`^!mailer\\s+${action}\\s*`, 'i'), '').trim();
        if (!raw) throw new Error(`provide addresses or use \`!mailer ${action} none\``);
        config[action] = /^none$/i.test(raw) ? [] : normalizeEmailList(raw);
        if (!/^none$/i.test(raw) && !config[action].length) throw new Error('no valid email address was found');
        config = await saveMailerConfig(cohort, config);
        await msg.reply(`✅ Mailer ${action.toUpperCase()} saved: ${maskedList(config[action])}${action === 'cc' ? ' · Programming Hero audit CC is mandatory' : ''}`);
        return;
      }
      if (action === 'replyto') {
        const raw = content.replace(/^!mailer\s+replyto\s*/i, '').trim();
        config.replyTo = /^none$/i.test(raw) ? '' : normalizeEmail(raw);
        if (raw && !/^none$/i.test(raw) && !config.replyTo) throw new Error('Reply-To must be one valid email address');
        await saveMailerConfig(cohort, config);
        await msg.reply(`✅ Reply-To saved: ${config.replyTo || 'none'}`);
        return;
      }
      if (['sender', 'mentor', 'phone'].includes(action)) {
        const raw = content.replace(new RegExp(`^!mailer\\s+${action}\\s*`, 'i'), '').trim();
        if (!raw) throw new Error(`provide a value after \`!mailer ${action}\``);
        if (action === 'sender') config.senderName = raw;
        if (action === 'mentor') config.mentorName = raw;
        if (action === 'phone') config.mentorPhone = raw;
        config = await saveMailerConfig(cohort, config);
        await msg.reply(`✅ Mailer ${action} value saved.`);
        return;
      }
      if (action === 'template') {
        const type = String(parts[2] || '').toLowerCase();
        if (!TEMPLATE_TYPES.includes(type)) throw new Error(`choose: ${TEMPLATE_TYPES.join(', ')}`);
        await msg.channel.send({
          content: `Click to edit the **${type}** template. Variables: \`{{cohort}}\`, \`{{date}}\`, \`{{warning_count}}\`, \`{{warnings_remaining}}\`, \`{{mentor_name}}\`, \`{{mentor_phone}}\`.`,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`mailer:open:${cohort.guildId}:${type}`)
              .setLabel(`Edit ${type} template`).setStyle(ButtonStyle.Primary),
          )],
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (action === 'reset') {
        const type = String(parts[2] || 'all').toLowerCase();
        if (type === 'all') config.templates = JSON.parse(JSON.stringify(DEFAULT_TEMPLATES));
        else {
          if (!TEMPLATE_TYPES.includes(type)) throw new Error(`choose: all, ${TEMPLATE_TYPES.join(', ')}`);
          config.templates[type] = { ...DEFAULT_TEMPLATES[type] };
        }
        await saveMailerConfig(cohort, config);
        await msg.reply(`✅ Restored the default **${type}** mail template${type === 'all' ? 's' : ''}.`);
        return;
      }
      if (action === 'preview') {
        const type = String(parts[2] || '').toLowerCase();
        if (!TEMPLATE_TYPES.includes(type)) throw new Error(`choose: ${TEMPLATE_TYPES.join(', ')}`);
        await msg.channel.send(previewMessage(cohort, config, type));
        return;
      }
      if (action === 'quota') {
        const quota = await appsScriptGet(cohort, { action: 'mailerstatus' }, { label: 'Mailer quota status' });
        await msg.channel.send({ content: statusMessage(cohort, config, quota.remainingDailyRecipients, await isOn(cohort, 'mailer')), allowedMentions: { parse: [] } });
        return;
      }
      if (action === 'send') {
        const selection = String(parts[2] || 'all').toLowerCase();
        const types = selectedMailTypes(selection);
        if (!types.length) throw new Error('choose `absent`, `warnings`, `warning1`, `warning2`, `inactive`, or `all`');
        const date = validDateKey(parts[3]) ? parts[3] : dateKeyInZone(cohort.timezone);
        if (!config.to.length) throw new Error('configure at least one private To address first');
        const prepared = await prepareMailerRun(cohort, date, { config });
        const summary = mailerAudienceSummary(prepared.groups, prepared.recordedAbsentCount);
        const counts = summary.counts;
        prunePending();
        const token = Math.random().toString(36).slice(2, 10);
        pendingSends.set(token, { cohortId: cohort.guildId, authorId: msg.author.id, prepared, types, createdAt: Date.now() });
        await msg.channel.send({
          content: [
            `📧 **Confirm mailer run — ${cohort.name} · ${date}**`,
            `Selected: **${types.join(', ')}**`,
            `Attendance report absent: **${summary.recordedAbsent}** · eligible email recipients: **${summary.eligible}**`,
            `Absent: **${counts.absent}** · warning 1: **${counts.warning1}** · warning 2: **${counts.warning2}** · inactive: **${counts.inactive}**`,
            `Excluded before the attendance report: **${summary.excludedBeforeReport}** (not counted absent or emailed)`,
            `Returned as absent but skipped inactive: **${summary.alreadyInactive}** · missing/invalid email: **${summary.missingEmail}** · duplicate email: **${summary.duplicateEmail}**`,
            summary.unreconciled ? `⚠️ Unreconciled absence rows: **${summary.unreconciled}** (run \`!profilecheck\`)` : '',
            prepared.sessionRecorded ? '' : '⚠️ No recorded attendance session exists for this date; the absent group is empty.',
            '', 'Student addresses remain BCC-only. The attached private TSV lists every eligible or skipped student and the reason.',
          ].filter(Boolean).join('\n'),
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`mailer:confirm:${cohort.guildId}:${token}`).setLabel('Send email batches').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`mailer:cancel:${cohort.guildId}:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
          )],
          files: recipientAuditFile(cohort, date, prepared.groups, types),
          allowedMentions: { parse: [] },
        });
        return;
      }
      await msg.reply('Use `!mailer status|enable|disable|to|cc|bcc|replyto|sender|mentor|phone|template|reset|preview|send|quota`.');
    } catch (error) {
      await msg.reply(`❌ Mailer: ${String(error.message || error).slice(0, 500)}`);
    }
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.customId?.startsWith('mailer:')) return;
    const [, action, guildId, value] = interaction.customId.split(':');
    const cohort = cohorts.find(item => item.guildId === guildId);
    if (!cohort || interaction.guildId !== guildId || interaction.channelId !== cohort.channels.supervisor ||
        !cohort.supervisorIds.includes(interaction.user.id)) {
      if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'This private mailer control is not available here.', ephemeral: true }).catch(() => {});
      return;
    }
    try {
      if (action === 'open' && interaction.isButton()) {
        const config = await loadMailerConfig(cohort);
        await interaction.showModal(templateModal(cohort, value, config));
        return;
      }
      if (action === 'template' && interaction.isModalSubmit()) {
        if (!TEMPLATE_TYPES.includes(value)) throw new Error('unknown template type');
        const config = await loadMailerConfig(cohort);
        config.templates[value] = {
          subject: interaction.fields.getTextInputValue('subject').trim(),
          body: interaction.fields.getTextInputValue('body').trim(),
        };
        await saveMailerConfig(cohort, config);
        await interaction.reply({ content: `✅ Saved the **${value}** email template.`, ephemeral: true });
        return;
      }
      if (['confirm', 'cancel'].includes(action) && interaction.isButton()) {
        const pending = pendingSends.get(value);
        if (!pending || Date.now() - pending.createdAt > PENDING_MS || pending.authorId !== interaction.user.id || pending.cohortId !== guildId) {
          pendingSends.delete(value);
          await interaction.reply({ content: 'This mail confirmation expired. Run `!mailer send ...` again.', ephemeral: true });
          return;
        }
        await interaction.deferUpdate();
        pendingSends.delete(value);
        if (action === 'cancel') {
          await interaction.editReply({ content: 'Mailer run cancelled. No email was sent.', components: [] });
          return;
        }
        const result = await sendPreparedMailer(cohort, pending.prepared, pending.types);
        await interaction.editReply({
          content: [
            '✅ **Mailer completed**',
            `• Newly sent now: **${result.sentRecipients}** recipient(s) in **${result.sentBatches}** batch(es)`,
            `• Already sent earlier: **${result.previouslySentRecipients}** recipient(s) in **${result.previouslySentBatches}** batch(es) — safely skipped, not duplicated`,
          ].join('\n'),
          components: [], allowedMentions: { parse: [] },
        });
      }
    } catch (error) {
      const content = `❌ Mailer action failed: ${String(error.message || error).slice(0, 450)}`;
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content, components: [] }).catch(() => {});
      else await interaction.reply({ content, ephemeral: true }).catch(() => {});
    }
  });
};

module.exports.batchesFor = batchesFor;
module.exports.configKey = configKey;
module.exports.loadMailerConfig = loadMailerConfig;
module.exports.mailerAudienceSummary = mailerAudienceSummary;
module.exports.mailerCounts = mailerCounts;
module.exports.mailerDeliverySummary = mailerDeliverySummary;
module.exports.mailerBatchKey = mailerBatchKey;
module.exports.mailerRecipientAudit = mailerRecipientAudit;
module.exports.prepareMailerRun = prepareMailerRun;
module.exports.queueInactiveMailerConfirmation = queueInactiveMailerConfirmation;
module.exports.runAttendanceMailer = runAttendanceMailer;
module.exports.saveMailerConfig = saveMailerConfig;
module.exports.selectedMailTypes = selectedMailTypes;
module.exports.sendPreparedMailer = sendPreparedMailer;
