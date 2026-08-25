'use strict';

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
} = require('discord.js');
const { cohorts } = require('./config');
const { excluded, getRoster, syncMembers } = require('./roster');
const {
  getAttendanceWarningState,
  getInactiveMetadata,
  setStudentsActive,
  setStudentsInactive,
} = require('./exclude');
const { queueInactiveMailerConfirmation } = require('./mailer');

const PAGE_SIZE = 4;
const UNKNOWN_DATE = '__unknown__';

function parseInactiveStudentsCommand(content) {
  const match = String(content || '').trim()
    .match(/^!(?:inactivestudents|inactivepanel)(?:\s+(?:page\s+)?(\d+))?$/i);
  if (!match) return null;
  return { page: Math.max(0, Number(match[1] || 1) - 1) };
}

function parseStudentPanelCommand(content) {
  const match = String(content || '').trim()
    .match(/^!(studentstatuspanel|studentpanel|activestudents|activepanel)(?:\s+(?:page\s+)?(\d+))?$/i);
  if (!match) return null;
  return {
    view: /active(?:students|panel)/i.test(match[1]) ? 'active' : 'overview',
    page: Math.max(0, Number(match[2] || 1) - 1),
  };
}

function dateFromTimestamp(value, timezone = 'Asia/Dhaka') {
  const date = new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-CA', { timeZone: timezone });
}

function inactiveRecords(roster, inactiveIds, warningState, metadata, timezone) {
  const manual = inactiveIds instanceof Set ? inactiveIds : new Set(inactiveIds || []);
  return (roster || []).filter(student => {
    const id = String(student.discordId || '');
    if (!id || student.status === 'hired' || student.status === 'left') return false;
    return student.active === false || manual.has(id);
  }).map(student => {
    const id = String(student.discordId);
    const meta = metadata?.[id] || {};
    const warning = warningState?.[id] || {};
    const inactiveDate = /^\d{4}-\d{2}-\d{2}$/.test(String(meta.inactiveDate || ''))
      ? String(meta.inactiveDate)
      : (Number(warning.count || 0) >= 3 || warning.inactive
        ? dateFromTimestamp(warning.updatedAt, timezone)
        : '');
    const reasons = Array.isArray(student.inactiveReasons)
      ? student.inactiveReasons.filter(Boolean).join('; ')
      : '';
    const reason = String(meta.reason ||
      (Number(warning.count || 0) >= 3 ? 'Reached 3/3 attendance warnings' : '') ||
      reasons || (manual.has(id) ? 'Manually inactive' : 'Inactive Sheet marker')).slice(0, 300);
    return {
      ...student,
      discordId: id,
      inactiveDate,
      source: String(meta.source || (Number(warning.count || 0) >= 3
        ? 'attendance-warning' : (manual.has(id) ? 'manual/legacy' : 'sheet-marker'))),
      reason,
      warningCount: Math.max(0, Number(warning.count || 0)),
    };
  }).sort((a, b) => {
    if (a.inactiveDate !== b.inactiveDate) return String(b.inactiveDate).localeCompare(String(a.inactiveDate));
    return String(a.name || a.displayName || '').localeCompare(String(b.name || b.displayName || ''));
  });
}

function activeRecords(roster, inactiveIds) {
  const manual = inactiveIds instanceof Set ? inactiveIds : new Set(inactiveIds || []);
  return (roster || []).filter(student => {
    const id = String(student.discordId || '');
    return id && student.status !== 'hired' && student.status !== 'left' &&
      student.active !== false && !manual.has(id);
  }).map(student => ({ ...student, discordId: String(student.discordId) }))
    .sort((a, b) => String(a.name || a.displayName || '')
      .localeCompare(String(b.name || b.displayName || '')));
}

function safePage(page, total) {
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return Math.min(Math.max(0, Number(page) || 0), pageCount - 1);
}

function shortLabel(value, max = 55) {
  const text = String(value || 'Student').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function buildInactivePanel(cohort, records, page = 0) {
  const currentPage = safePage(page, records.length);
  const pageCount = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
  const visible = records.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const description = records.length
    ? visible.map((student, index) => {
      const number = currentPage * PAGE_SIZE + index + 1;
      return [
        `**${number}. ${student.name || student.displayName || 'Unknown student'}** · <@${student.discordId}>`,
        `Inactive date: **${student.inactiveDate || 'not recorded (legacy)'}** · warning: **${student.warningCount}/3**`,
        `Reason: ${student.reason || 'Not recorded'} · source: ${student.source || 'unknown'}`,
      ].join('\n');
    }).join('\n\n')
    : 'No current, activatable student is inactive. Hired and left students are protected and are not shown here.';
  const embed = new EmbedBuilder()
    .setTitle(`Inactive Student Control — ${cohort.name}`)
    .setColor(records.length ? 0xe67e22 : 0x2ecc71)
    .setDescription(description)
    .setFooter({ text: `Private mentor control · ${records.length} inactive · page ${currentPage + 1}/${pageCount}` });
  const components = visible.map((student, index) => new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`inactive:one:${cohort.guildId}:${student.discordId}:${currentPage}`)
      .setLabel(shortLabel(`Activate ${currentPage * PAGE_SIZE + index + 1} · ${student.name || student.displayName}`))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`inactive:emailone:${cohort.guildId}:${student.discordId}:${currentPage}`)
      .setLabel(shortLabel(`Email ${currentPage * PAGE_SIZE + index + 1}`))
      .setStyle(ButtonStyle.Primary),
  ));
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`inactive:page:${cohort.guildId}:${currentPage - 1}`)
      .setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === 0),
    new ButtonBuilder().setCustomId(`inactive:page:${cohort.guildId}:${currentPage + 1}`)
      .setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(currentPage >= pageCount - 1),
    new ButtonBuilder().setCustomId(`inactive:dates:${cohort.guildId}:${currentPage}`)
      .setLabel('Activate by date').setStyle(ButtonStyle.Primary).setDisabled(!records.length),
    new ButtonBuilder().setCustomId(`inactive:all:${cohort.guildId}:${currentPage}`)
      .setLabel('Activate all').setStyle(ButtonStyle.Danger).setDisabled(!records.length),
    new ButtonBuilder().setCustomId(`inactive:emailall:${cohort.guildId}:${currentPage}`)
      .setLabel('Email all inactive').setStyle(ButtonStyle.Primary).setDisabled(!records.length),
  );
  components.push(controls);
  return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

function buildActivePanel(cohort, records, page = 0) {
  const currentPage = safePage(page, records.length);
  const pageCount = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
  const visible = records.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const embed = new EmbedBuilder()
    .setTitle(`Active Student Control — ${cohort.name}`)
    .setColor(0x2ecc71)
    .setDescription(visible.length
      ? visible.map((student, index) =>
        `**${currentPage * PAGE_SIZE + index + 1}. ${student.name || student.displayName || 'Unknown student'}** · <@${student.discordId}>\n${student.email || 'No email'} · ${student.phone || 'No phone'}`)
        .join('\n\n')
      : 'No current activatable student is active. Hired and left students are protected and are not shown here.')
    .setFooter({ text: `Private mentor control · ${records.length} active · page ${currentPage + 1}/${pageCount}` });
  const components = visible.map((student, index) => new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`inactive:deactivate:${cohort.guildId}:${student.discordId}:${currentPage}`)
      .setLabel(shortLabel(`Make inactive ${currentPage * PAGE_SIZE + index + 1} · ${student.name || student.displayName}`))
      .setStyle(ButtonStyle.Danger),
  ));
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`inactive:active:${cohort.guildId}:${currentPage - 1}`)
      .setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === 0),
    new ButtonBuilder().setCustomId(`inactive:active:${cohort.guildId}:${currentPage + 1}`)
      .setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(currentPage >= pageCount - 1),
    new ButtonBuilder().setCustomId(`inactive:overview:${cohort.guildId}`)
      .setLabel('Counts').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`inactive:activerefresh:${cohort.guildId}:${currentPage}`)
      .setLabel('Refresh').setStyle(ButtonStyle.Secondary),
  ));
  return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

function buildStatusOverview(cohort, status) {
  const embed = new EmbedBuilder()
    .setTitle(`Student Status Center — ${cohort.name}`)
    .setColor(status.inactive.length ? 0x3498db : 0x2ecc71)
    .setDescription([
      `🟢 **Active students: ${status.active.length}**`,
      `🔴 **Inactive students: ${status.inactive.length}**`,
      `🛡️ **Protected hired/left: ${status.protectedCount}**`,
      '',
      'Open either list to review students and change status. Every change is verified against the cohort Sheet before success is shown.',
    ].join('\n'));
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`inactive:active:${cohort.guildId}:0`)
        .setLabel(`Active (${status.active.length})`).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`inactive:inactive:${cohort.guildId}:0`)
        .setLabel(`Inactive (${status.inactive.length})`).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`inactive:overviewrefresh:${cohort.guildId}`)
        .setLabel('Refresh counts').setStyle(ButtonStyle.Secondary),
    )],
    allowedMentions: { parse: [] },
  };
}

function dateGroups(records) {
  const groups = new Map();
  for (const student of records || []) {
    const key = student.inactiveDate || UNKNOWN_DATE;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(student);
  }
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === UNKNOWN_DATE) return 1;
    if (b === UNKNOWN_DATE) return -1;
    return b.localeCompare(a);
  });
}

async function loadInactiveRecords(client, cohort, options = {}) {
  return (await loadStudentStatus(client, cohort, options)).inactive;
}

async function loadStudentStatus(client, cohort, options = {}) {
  if (options.sync) await syncMembers(client, cohort, { force: true });
  const [roster, warningState, metadata] = await Promise.all([
    getRoster(cohort, true),
    getAttendanceWarningState(cohort),
    getInactiveMetadata(cohort),
  ]);
  return {
    active: activeRecords(roster, excluded[cohort.guildId]),
    inactive: inactiveRecords(roster, excluded[cohort.guildId], warningState, metadata, cohort.timezone),
    protectedCount: roster.filter(student => student.discordId &&
      (student.status === 'hired' || student.status === 'left')).length,
  };
}

function privatePayload(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
}

async function editOriginalPanel(client, interaction, cohort, messageId, page) {
  const records = await loadInactiveRecords(client, cohort);
  const message = await interaction.channel.messages.fetch(messageId).catch(() => null);
  if (message) await message.edit(buildInactivePanel(cohort, records, page));
  return records;
}

module.exports = function registerInactiveControls(client) {
  client.on('messageCreate', async message => {
    if (message.author.bot || !message.guildId) return;
    const panelCommand = parseStudentPanelCommand(message.content);
    const inactiveCommand = parseInactiveStudentsCommand(message.content);
    const command = panelCommand || (inactiveCommand && { view: 'inactive', page: inactiveCommand.page });
    if (!command) return;
    const cohort = cohorts.find(item => item.guildId === message.guildId);
    if (!cohort || !cohort.supervisorIds.includes(message.author.id)) return;
    if (message.channelId !== cohort.channels.supervisor) {
      return message.reply(`Run inactive-student controls in <#${cohort.channels.supervisor}>.`);
    }
    try {
      await message.reply('Refreshing the Discord-primary roster and building the private student-status controls...');
      const status = await loadStudentStatus(client, cohort, { sync: true });
      const payload = command.view === 'active'
        ? buildActivePanel(cohort, status.active, command.page)
        : command.view === 'inactive'
          ? buildInactivePanel(cohort, status.inactive, command.page)
          : buildStatusOverview(cohort, status);
      return message.channel.send(payload);
    } catch (error) {
      return message.reply(`❌ Student-status panel failed: ${String(error.message || error).slice(0, 300)}`);
    }
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.customId?.startsWith('inactive:')) return;
    try {
      const parts = interaction.customId.split(':');
      const action = parts[1];
      const guildId = parts[2];
      const cohort = cohorts.find(item => item.guildId === guildId);
      if (!cohort || interaction.guildId !== guildId ||
          !cohort.supervisorIds.includes(interaction.user.id) ||
          interaction.channelId !== cohort.channels.supervisor) {
        await interaction.reply(privatePayload({ content: 'Only a configured mentor can use this cohort’s private student-status controls.' })).catch(() => {});
        return;
      }
      if (action === 'overview' || action === 'overviewrefresh') {
        await interaction.deferUpdate();
        const status = await loadStudentStatus(client, cohort, { sync: action === 'overviewrefresh' });
        await interaction.editReply(buildStatusOverview(cohort, status));
        return;
      }
      if (action === 'active' || action === 'activerefresh') {
        await interaction.deferUpdate();
        const page = Number(parts[3] || 0);
        const status = await loadStudentStatus(client, cohort, { sync: action === 'activerefresh' });
        await interaction.editReply(buildActivePanel(cohort, status.active, page));
        return;
      }
      if (action === 'inactive') {
        await interaction.deferUpdate();
        const page = Number(parts[3] || 0);
        const status = await loadStudentStatus(client, cohort);
        await interaction.editReply(buildInactivePanel(cohort, status.inactive, page));
        return;
      }
      if (action === 'page' || action === 'refresh') {
        await interaction.deferUpdate();
        const page = Number(parts[3] || 0);
        const records = await loadInactiveRecords(client, cohort, { sync: action === 'refresh' });
        await interaction.editReply(buildInactivePanel(cohort, records, page));
        return;
      }
      if (action === 'one') {
        await interaction.deferUpdate();
        const discordId = parts[3];
        const page = Number(parts[4] || 0);
        const result = await setStudentsActive(client, cohort, [discordId]);
        const records = await loadInactiveRecords(client, cohort);
        await interaction.editReply(buildInactivePanel(cohort, records, page));
        const content = result.activated.length
          ? `✅ Activated **${result.activated[0].student.name || discordId}**. Inactive markers and attendance warnings were cleared; tracking resumes now.${(result.roleSync?.failed?.length || result.roleSync?.missing?.length) ? ' Discord role sync needs review; run `!statusroles`.' : ''}`
          : `❌ Activation failed: ${result.failures[0]?.error || 'verification failed'}`;
        await interaction.followUp(privatePayload({ content }));
        return;
      }
      if (action === 'emailone' || action === 'emailall') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const records = await loadInactiveRecords(client, cohort);
        const selected = action === 'emailone'
          ? records.filter(student => student.discordId === parts[3])
          : records;
        if (!selected.length) {
          await interaction.editReply({ content: 'No matching inactive student is available. Refresh the panel.', components: [] });
          return;
        }
        const scope = action === 'emailone' ? selected[0].discordId : 'all';
        await interaction.editReply(await queueInactiveMailerConfirmation(
          cohort, interaction.user.id, selected, scope));
        return;
      }
      if (action === 'deactivate') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const discordId = parts[3];
        const page = Number(parts[4] || 0);
        const status = await loadStudentStatus(client, cohort);
        const student = status.active.find(item => item.discordId === discordId);
        if (!student) {
          await interaction.editReply({ content: 'This student is no longer active. Refresh the status panel.', components: [] });
          return;
        }
        await interaction.editReply({
          content: `Make **${student.name || student.displayName || discordId}** inactive? They will stop receiving tracked attendance, activity credit, checks, warnings, and routine mentions until a mentor activates them again. Their history is preserved.`,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`inactive:confirmdeactivate:${guildId}:${interaction.message.id}:${discordId}:${page}`)
              .setLabel('Confirm make inactive').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`inactive:cancel:${guildId}`)
              .setLabel('Cancel').setStyle(ButtonStyle.Secondary),
          )],
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (action === 'confirmdeactivate') {
        await interaction.deferUpdate();
        const messageId = parts[3];
        const discordId = parts[4];
        const page = Number(parts[5] || 0);
        const result = await setStudentsInactive(cohort, [discordId], {
          client,
          source: 'status-panel', reason: 'Marked inactive by a mentor from the Student Status Center',
        });
        const failure = result.failures?.[0];
        const status = await loadStudentStatus(client, cohort);
        const message = await interaction.channel.messages.fetch(messageId).catch(() => null);
        if (message) await message.edit(buildActivePanel(cohort, status.active, page));
        await interaction.editReply({
          content: failure
            ? `❌ Status was not changed: ${failure.error}`
            : `🚫 Student is verified inactive. Existing history is preserved and future tracking is paused until mentor activation.${(result.roleSync?.failed?.length || result.roleSync?.missing?.length) ? ' Discord role sync needs review; run `!statusroles`.' : ''}`,
          components: [], allowedMentions: { parse: [] },
        });
        return;
      }
      if (action === 'all') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const page = Number(parts[3] || 0);
        const records = await loadInactiveRecords(client, cohort);
        await interaction.editReply({
          content: `Activate **all ${records.length}** currently inactive, activatable students? This clears inactive Sheet markers, manual exclusion, and attendance warnings for each verified student. Hired/left students remain protected.`,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`inactive:confirmall:${guildId}:${interaction.message.id}:${page}`)
              .setLabel(`Confirm activate all (${records.length})`).setStyle(ButtonStyle.Danger)
              .setDisabled(!records.length),
            new ButtonBuilder().setCustomId(`inactive:cancel:${guildId}`)
              .setLabel('Cancel').setStyle(ButtonStyle.Secondary),
          )], allowedMentions: { parse: [] },
        });
        return;
      }
      if (action === 'dates') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const page = Number(parts[3] || 0);
        const records = await loadInactiveRecords(client, cohort);
        const groups = dateGroups(records).slice(0, 25);
        if (!groups.length) {
          await interaction.editReply({ content: 'No inactive student is available.', components: [] });
          return;
        }
        const picker = new StringSelectMenuBuilder()
          .setCustomId(`inactive:datepick:${guildId}:${interaction.message.id}:${page}`)
          .setPlaceholder('Choose an inactive date')
          .addOptions(groups.map(([date, students]) => ({
            label: date === UNKNOWN_DATE ? 'Date not recorded (legacy)' : date,
            value: date,
            description: `${students.length} student${students.length === 1 ? '' : 's'} will be selected`,
          })));
        await interaction.editReply({
          content: 'Choose the inactive-date group to review. The next step asks for confirmation.',
          components: [new ActionRowBuilder().addComponents(picker)],
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (action === 'datepick' && interaction.isStringSelectMenu()) {
        await interaction.deferUpdate();
        const messageId = parts[3];
        const page = Number(parts[4] || 0);
        const selectedDate = interaction.values[0];
        const records = await loadInactiveRecords(client, cohort);
        const selected = records.filter(student => (student.inactiveDate || UNKNOWN_DATE) === selectedDate);
        const label = selectedDate === UNKNOWN_DATE ? 'date not recorded (legacy)' : selectedDate;
        await interaction.editReply({
          content: `Activate **${selected.length}** student(s) inactive on **${label}**?\n${selected.map(student => `• ${student.name || student.discordId}`).join('\n') || 'No current match.'}`,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`inactive:confirmdate:${guildId}:${messageId}:${page}:${selectedDate}`)
              .setLabel(`Confirm date group (${selected.length})`).setStyle(ButtonStyle.Danger)
              .setDisabled(!selected.length),
            new ButtonBuilder().setCustomId(`inactive:cancel:${guildId}`)
              .setLabel('Cancel').setStyle(ButtonStyle.Secondary),
          )],
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (action === 'confirmall' || action === 'confirmdate') {
        await interaction.deferUpdate();
        const messageId = parts[3];
        const page = Number(parts[4] || 0);
        const selectedDate = action === 'confirmdate' ? parts[5] : '';
        const records = await loadInactiveRecords(client, cohort);
        const selected = action === 'confirmdate'
          ? records.filter(student => (student.inactiveDate || UNKNOWN_DATE) === selectedDate)
          : records;
        const result = await setStudentsActive(client, cohort, selected.map(student => student.discordId));
        await editOriginalPanel(client, interaction, cohort, messageId, page);
        await interaction.editReply({
          content: [
            `✅ Activated: **${result.activated.length}**`,
            `❌ Failed verification: **${result.failures.length}**`,
            `🔐 Discord role issues: **${(result.roleSync?.failed?.length || 0) + (result.roleSync?.missing?.length || 0)}**`,
            result.failures.length ? result.failures.map(item => `• ${item.discordId}: ${item.error}`).join('\n') : 'The original panel has been refreshed.',
          ].join('\n'),
          components: [],
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (action === 'cancel') {
        await interaction.update({ content: 'Status change cancelled. No student status was changed.', components: [] });
        return;
      }
    } catch (error) {
      console.error('[student-status] interaction failed:', String(error?.message || error));
      const payload = { content: `❌ Inactive-student control failed: ${String(error.message || error).slice(0, 300)}`, components: [] };
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
      else await interaction.reply(privatePayload(payload)).catch(() => {});
    }
  });
};

module.exports.PAGE_SIZE = PAGE_SIZE;
module.exports.UNKNOWN_DATE = UNKNOWN_DATE;
module.exports.buildInactivePanel = buildInactivePanel;
module.exports.buildActivePanel = buildActivePanel;
module.exports.buildStatusOverview = buildStatusOverview;
module.exports.dateGroups = dateGroups;
module.exports.activeRecords = activeRecords;
module.exports.inactiveRecords = inactiveRecords;
module.exports.parseInactiveStudentsCommand = parseInactiveStudentsCommand;
module.exports.parseStudentPanelCommand = parseStudentPanelCommand;
