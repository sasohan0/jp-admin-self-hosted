'use strict';

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { cohorts } = require('./config');
const { appsScriptGet, appsScriptPost } = require('./apps-script-api');
const { getRoster, isExcluded } = require('./roster');
const {
  loadWorkCalendar,
  resolveDateArgument,
  validDateKey,
} = require('./work-calendar');
const { workingDatesBetween } = require('./followup-rules');

const MAX_REASON = 1200;

function createSerialQueue() {
  const tails = new Map();
  return {
    run(key, work) {
      const queueKey = String(key || 'default');
      const previous = tails.get(queueKey) || Promise.resolve();
      const current = previous.catch(() => {}).then(work);
      tails.set(queueKey, current);
      current.finally(() => {
        if (tails.get(queueKey) === current) tails.delete(queueKey);
      }).catch(() => {});
      return current;
    },
    size() { return tails.size; },
  };
}

const leaveQueue = createSerialQueue();

function leaveModal(cohort) {
  return new ModalBuilder()
    .setCustomId(`leave:submit:${cohort.guildId}`)
    .setTitle('Request bootcamp leave')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('start').setLabel('Start date (YYYY-MM-DD or today)')
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10)),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('end').setLabel('End date (YYYY-MM-DD or today)')
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10)),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('reason').setLabel('Private reason')
          .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(MAX_REASON)),
    );
}

function decisionModal(cohort, requestId, action) {
  const modal = new ModalBuilder()
    .setCustomId(`leave:${action}submit:${cohort.guildId}:${requestId}`)
    .setTitle(action === 'adjust' ? 'Adjust and approve leave' : action === 'approve' ? 'Approve leave request' : 'Reject leave request');
  if (action === 'adjust') {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('start').setLabel('Approved start (YYYY-MM-DD or today)')
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10)),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('end').setLabel('Approved end (YYYY-MM-DD or today)')
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10)),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('note').setLabel('Mentor note to the student')
          .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(800)),
    );
  } else if (action === 'approve') {
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('note').setLabel('Mentor note to the student')
        .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(800),
    ));
  } else {
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('note').setLabel('Mentor note / rejection reason')
        .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(800),
    ));
  }
  return modal;
}

function requestButtons(cohort, requestId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`leave:approve:${cohort.guildId}:${requestId}`)
      .setLabel('Approve requested dates').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`leave:adjust:${cohort.guildId}:${requestId}`)
      .setLabel('Adjust dates').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`leave:reject:${cohort.guildId}:${requestId}`)
      .setLabel('Reject').setStyle(ButtonStyle.Danger),
  )];
}

function parseDateRange(startValue, endValue, timezone, now = new Date()) {
  const start = resolveDateArgument(startValue, timezone, now);
  const end = resolveDateArgument(endValue, timezone, now);
  if (!start || !end) throw new Error('Dates must be YYYY-MM-DD, today, or tomorrow');
  if (start > end) throw new Error('Leave start date cannot be after the end date');
  const span = Math.round((new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86400000);
  if (span > 62) throw new Error('A leave request cannot exceed 63 calendar days');
  return { start, end };
}

async function activeStudent(cohort, discordId) {
  const roster = await getRoster(cohort, true);
  return roster.find(student => student.discordId === discordId && !isExcluded(cohort, student)) || null;
}

async function fetchRequest(cohort, requestId) {
  const data = await appsScriptGet(cohort, { action: 'leaverequests', limit: 200 }, {
    label: 'Leave request lookup',
  });
  return (data.requests || []).find(item => item.requestId === requestId) || null;
}

async function approvedWorkingDates(cohort, start, end) {
  const calendar = await loadWorkCalendar(cohort);
  const dates = workingDatesBetween(calendar, start, end);
  if (!dates.length) throw new Error('This range contains no configured working days');
  return dates;
}

async function notifyStudent(client, cohort, request, text) {
  const issues = cohort.channels.issues
    ? await client.channels.fetch(cohort.channels.issues).catch(() => null)
    : null;
  if (!issues?.isTextBased?.()) throw new Error('issues channel is not configured or reachable');
  const marker = `Leave decision reference: ${request.requestId}`;
  const recent = await issues.messages.fetch({ limit: 100 }).catch(() => null);
  const alreadyPosted = recent?.some(message =>
    message.author.id === client.user.id && message.content.includes(marker));
  if (!alreadyPosted) {
    await issues.send({
      content: `<@${request.discordId}>\n${text}\n-# ${marker}`.slice(0, 2000),
      allowedMentions: { users: [request.discordId] },
    });
  }
  const user = await client.users.fetch(request.discordId).catch(() => null);
  if (user && !alreadyPosted) await user.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
}

async function decide(client, cohort, supervisorId, requestId, status, dates, note) {
  const mentorNote = String(note || '').trim();
  if (!mentorNote) throw new Error('A mentor note is required for every leave decision');
  return leaveQueue.run(cohort.guildId, async () => {
    const existing = await fetchRequest(cohort, requestId);
    if (!existing) throw new Error('Leave request was not found');
    const result = await appsScriptPost(cohort, {
      action: 'decideLeaveRequest', requestId, status, dates,
      supervisorId, note: mentorNote,
    }, { idempotent: true, label: 'Leave decision' });
    const range = result.approvedDates?.length
      ? `${result.approvedDates[0]} through ${result.approvedDates.at(-1)} (${result.approvedDates.length} working day(s))`
      : '';
    const publicText = status === 'approved'
      ? `✅ Leave request **${result.requestId.slice(0, 8)}** is **APPROVED** for ${range}. Approved dates are marked **L** and are not counted as absence.\n**Mentor note:** ${mentorNote.slice(0, 800)}`
      : `❌ Leave request **${result.requestId.slice(0, 8)}** is **REJECTED**.\n**Mentor note:** ${mentorNote.slice(0, 800)}`;
    const noticeKey = `leave_decision_notice_v1_${cohort.guildId}_${result.requestId}`;
    const notice = await appsScriptGet(cohort, { action: 'getstate', k: noticeKey }, {
      label: 'Leave decision notice state',
    });
    if (String(notice.value || '') !== 'sent') {
      await notifyStudent(client, cohort, result, publicText);
      await appsScriptPost(cohort, { action: 'setState', k: noticeKey, v: 'sent' }, {
        idempotent: true, label: 'Leave decision notice state write',
      });
      result.noticeSent = true;
    } else {
      result.noticeSent = false;
    }
    return result;
  });
}

function requestEmbed(cohort, request) {
  return new EmbedBuilder()
    .setTitle(`Leave request · ${request.requestId.slice(0, 8)}`)
    .setColor(0xe67e22)
    .setDescription(request.reason)
    .addFields(
      { name: 'Student', value: `${request.name}\n<@${request.discordId}>`, inline: true },
      { name: 'Requested dates', value: `${request.requestedStart} → ${request.requestedEnd}`, inline: true },
      { name: 'Request ID', value: `\`${request.requestId}\``, inline: false },
      { name: 'Private contact', value: `${request.email || 'NO EMAIL'}\n${request.phone || 'NO PHONE'}`, inline: false },
    )
    .setFooter({ text: 'Reason and contact details are private to bot-admin.' });
}

module.exports = function registerLeave(client) {
  client.on('messageCreate', async message => {
    if (message.author.bot || !message.guildId) return;
    const content = message.content.trim();
    if (!/^!leaves?(?:\s|$)/i.test(content)) return;
    const cohort = cohorts.find(item => item.guildId === message.guildId);
    if (!cohort) return;

    if (/^!leave$/i.test(content)) {
      if (message.channelId !== cohort.channels.issues) {
        return message.reply(cohort.channels.issues
          ? `Request leave in <#${cohort.channels.issues}> with \`!leave\`.`
          : 'The issues/leave-request channel is not configured. Ask your mentor for help.');
      }
      const student = await activeStudent(cohort, message.author.id);
      if (!student) return message.reply('Your active student profile is not linked yet. Ask your mentor for help.');
      return message.reply({
        content: 'Open the private form below. Your reason is sent only to mentors.',
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`leave:open:${cohort.guildId}`)
            .setLabel('Request leave privately').setStyle(ButtonStyle.Primary),
        )],
        allowedMentions: { parse: [] },
      });
    }

    if (!cohort.supervisorIds.includes(message.author.id)) return;
    if (message.channelId !== cohort.channels.supervisor) {
      return message.reply(`Run leave administration in <#${cohort.channels.supervisor}>.`);
    }
    try {
      if (/^!leaves(?:\s+setup)?$/i.test(content)) {
        const data = await appsScriptGet(cohort, { action: 'leaverequests', status: 'pending', limit: 100 }, {
          label: 'Leave requests',
        });
        const pending = [...(data.requests || [])].reverse();
        await message.reply(`✅ Leave ledger is ready. Pending requests: **${pending.length}**. Review cards follow **oldest first**, one by one.`);
        for (const request of pending) {
          await message.channel.send({
            embeds: [requestEmbed(cohort, request)], components: requestButtons(cohort, request.requestId),
            allowedMentions: { parse: [] },
          });
        }
        return;
      }
      const approve = content.match(/^!leave\s+approve\s+(\S+)(?:\s+(\S+)(?:\.\.|\s+)(\S+))?(?:\s*\|\s*(.*))?$/i);
      const reject = content.match(/^!leave\s+reject\s+(\S+)(?:\s*\|\s*(.*))?$/i);
      if (approve) {
        const note = String(approve[4] || '').trim();
        if (!note) throw new Error('Add a mentor note after `|`, for example: `| Approved for your exam`');
        const request = await fetchRequest(cohort, approve[1]);
        if (!request) throw new Error('Leave request was not found');
        const range = approve[2]
          ? parseDateRange(approve[2], approve[3] || approve[2], cohort.timezone)
          : { start: request.requestedStart, end: request.requestedEnd };
        const dates = await approvedWorkingDates(cohort, range.start, range.end);
        const result = await decide(client, cohort, message.author.id, request.requestId, 'approved', dates, note);
        return message.reply(result.decisionChanged === false
          ? `ℹ️ Leave request **${result.requestId.slice(0, 8)}** was already approved; ${result.noticeSent ? 'its missing #issues notice was recovered' : 'no duplicate notification was sent'}.`
          : `✅ Approved **${result.name}** for **${result.approvedDates.length}** working day(s); Attendance now shows L and the student was notified in #issues.`);
      }
      if (reject) {
        const note = String(reject[2] || '').trim();
        if (!note) throw new Error('Add the rejection note after `|`');
        const result = await decide(client, cohort, message.author.id, reject[1], 'rejected', [], note);
        return message.reply(result.decisionChanged === false
          ? `ℹ️ Leave request **${result.requestId.slice(0, 8)}** was already rejected; ${result.noticeSent ? 'its missing #issues notice was recovered' : 'no duplicate notification was sent'}.`
          : `✅ Rejected leave request **${result.requestId.slice(0, 8)}** and notified the student in #issues.`);
      }
      await message.reply('Use `!leaves`, `!leave approve <request-id> [start..end] | note`, or `!leave reject <request-id> | reason`.');
    } catch (error) {
      await message.reply(`❌ Leave action failed: ${String(error.message).slice(0, 300)}`);
    }
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.customId?.startsWith('leave:') || !interaction.guildId) return;
    const cohort = cohorts.find(item => item.guildId === interaction.guildId);
    if (!cohort) return;
    const parts = interaction.customId.split(':');
    try {
      if (parts[1] === 'open' && interaction.isButton()) {
        if (interaction.channelId !== cohort.channels.issues) throw new Error('Open leave requests from the issues channel');
        return interaction.showModal(leaveModal(cohort));
      }
      if (parts[1] === 'submit' && interaction.isModalSubmit()) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const outcome = await leaveQueue.run(cohort.guildId, async () => {
          const student = await activeStudent(cohort, interaction.user.id);
          if (!student) throw new Error('Your active student profile is not linked. Ask your mentor to run `!studentstatus <your Discord ID> active`, which now verifies the Sheet before reporting success.');
          const range = parseDateRange(
            interaction.fields.getTextInputValue('start'),
            interaction.fields.getTextInputValue('end'), cohort.timezone);
          const request = await appsScriptPost(cohort, {
            action: 'submitLeaveRequest', requestId: interaction.id,
            discordId: interaction.user.id,
            requestedStart: range.start, requestedEnd: range.end,
            reason: interaction.fields.getTextInputValue('reason'),
          }, { idempotent: true, label: 'Leave request submission' });
          if (request.created !== false) {
            const admin = await client.channels.fetch(cohort.channels.supervisor);
            await admin.send({
              embeds: [requestEmbed(cohort, request)], components: requestButtons(cohort, request.requestId),
              allowedMentions: { parse: [] },
            });
          }
          return request;
        });
        return interaction.editReply(outcome.created === false
          ? `⚠️ You already have pending leave request **${outcome.requestId.slice(0, 8)}** for these dates. It was not submitted or queued twice.`
          : `✅ Leave request **${outcome.requestId.slice(0, 8)}** was queued and sent privately to your mentors.`);
      }
      if (!cohort.supervisorIds.includes(interaction.user.id)) throw new Error('Only a configured supervisor can decide leave');
      const action = parts[1];
      const requestId = parts.slice(3).join(':');
      if (action === 'approve' && interaction.isButton()) return interaction.showModal(decisionModal(cohort, requestId, 'approve'));
      if (action === 'adjust' && interaction.isButton()) return interaction.showModal(decisionModal(cohort, requestId, 'adjust'));
      if (action === 'reject' && interaction.isButton()) return interaction.showModal(decisionModal(cohort, requestId, 'reject'));
      if (action === 'approvesubmit' && interaction.isModalSubmit()) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const request = await fetchRequest(cohort, requestId);
        if (!request) throw new Error('Leave request was not found');
        const dates = await approvedWorkingDates(cohort, request.requestedStart, request.requestedEnd);
        const result = await decide(client, cohort, interaction.user.id, requestId, 'approved', dates, interaction.fields.getTextInputValue('note'));
        await interaction.message?.edit({ components: [] }).catch(() => {});
        await interaction.editReply(result.decisionChanged === false
          ? `ℹ️ ${result.name}'s request was already approved. ${result.noticeSent ? 'Its missing #issues notice was recovered.' : 'No duplicate notification was sent.'}`
          : `✅ Approved ${result.name} for ${result.approvedDates.length} working day(s) and posted the mentor note in #issues.`);
        return;
      }
      if (action === 'adjustsubmit' && interaction.isModalSubmit()) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const range = parseDateRange(interaction.fields.getTextInputValue('start'), interaction.fields.getTextInputValue('end'), cohort.timezone);
        const dates = await approvedWorkingDates(cohort, range.start, range.end);
        const result = await decide(client, cohort, interaction.user.id, requestId, 'approved', dates, interaction.fields.getTextInputValue('note'));
        await interaction.message?.edit({ components: [] }).catch(() => {});
        await interaction.editReply(result.decisionChanged === false
          ? `ℹ️ ${result.name}'s request was already approved. ${result.noticeSent ? 'Its missing #issues notice was recovered.' : 'No duplicate notification was sent.'}`
          : `✅ Adjusted and approved ${result.name} for ${result.approvedDates.length} working day(s), with the mentor note posted in #issues.`);
        return;
      }
      if (action === 'rejectsubmit' && interaction.isModalSubmit()) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await decide(client, cohort, interaction.user.id, requestId, 'rejected', [], interaction.fields.getTextInputValue('note'));
        await interaction.message?.edit({ components: [] }).catch(() => {});
        await interaction.editReply(result.decisionChanged === false
          ? `ℹ️ ${result.name}'s request was already rejected. ${result.noticeSent ? 'Its missing #issues notice was recovered.' : 'No duplicate notification was sent.'}`
          : `✅ Rejected ${result.name}'s request and posted the mentor note in #issues.`);
      }
    } catch (error) {
      const payload = { content: `❌ Leave action failed: ${String(error.message).slice(0, 300)}`, flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  });
};

module.exports.parseDateRange = parseDateRange;
module.exports.requestButtons = requestButtons;
module.exports.createSerialQueue = createSerialQueue;
