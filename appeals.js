'use strict';

const { randomUUID } = require('crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { cohorts } = require('./config');
const { appsScriptGet, appsScriptPost } = require('./apps-script-api');
const { excluded, getRoster } = require('./roster');
const { setStudentActive } = require('./exclude');
const {
  APPEAL_CAUSES,
  APPEAL_SCOPES,
  parseAppealCommand,
  sanitizeAppealText,
  validAppealCause,
} = require('./appeal-rules');

function appealButton(cohort, scope, userId, label = 'Appeal this decision') {
  return new ButtonBuilder()
    .setCustomId(`appeal:start:${cohort.guildId}:${scope}:${userId}`)
    .setLabel(label)
    .setStyle(ButtonStyle.Primary);
}

function causePicker(cohort, scope, userId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`appeal:cause:${cohort.guildId}:${scope}:${userId}`)
      .setPlaceholder('Choose the main reason')
      .addOptions(Object.entries(APPEAL_CAUSES).map(([value, label]) => ({ label, value }))),
  );
}

function appealModal(cohort, scope, userId, cause) {
  return new ModalBuilder()
    .setCustomId(`appeal:submit:${cohort.guildId}:${scope}:${userId}:${cause}`)
    .setTitle(scope === 'dawn' ? 'Appeal Dawn Focus removal' : 'Appeal bootcamp inactivity')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('dates')
          .setLabel('Affected absence dates')
          .setPlaceholder('Example: 2026-08-10, 2026-08-11')
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(400),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('explanation')
          .setLabel('Explain what happened on those dates')
          .setPlaceholder('Give a truthful, specific explanation for the mentor.')
          .setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(20).setMaxLength(1500),
      ),
    );
}

function decisionModal(cohort, requestId, status) {
  return new ModalBuilder()
    .setCustomId(`appeal:decision:${cohort.guildId}:${status}:${requestId}`)
    .setTitle(status === 'approved' ? 'Approve appeal' : 'Decline appeal')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('note')
        .setLabel(status === 'approved' ? 'Mentor note (optional)' : 'Reason for declining')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(status !== 'approved')
        .setMaxLength(1000),
    ));
}

function reviewButtons(cohort, requestId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`appeal:review:${cohort.guildId}:approved:${requestId}`)
      .setLabel('Approve and restore').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`appeal:review:${cohort.guildId}:declined:${requestId}`)
      .setLabel('Decline with note').setStyle(ButtonStyle.Danger),
  )];
}

function reviewEmbed(request) {
  return new EmbedBuilder()
    .setTitle(`${APPEAL_SCOPES[request.scope] || request.scope} appeal · ${request.requestId.slice(0, 8)}`)
    .setColor(0xe67e22)
    .setDescription(request.explanation || 'No explanation supplied')
    .addFields(
      { name: 'Student', value: `${request.name || 'Unknown'}\n<@${request.discordId}>`, inline: true },
      { name: 'Cause', value: APPEAL_CAUSES[request.cause] || request.cause || 'Unknown', inline: true },
      { name: 'Affected dates', value: request.affectedDates || 'Not specified', inline: false },
      { name: 'Private contact', value: `${request.email || 'NO EMAIL'}\n${request.phone || 'NO PHONE'}`, inline: false },
      { name: 'Request ID', value: `\`${request.requestId}\``, inline: false },
    )
    .setFooter({ text: 'Private mentor review · approval restores only the requested scope.' });
}

function privateResponse(interaction, payload) {
  return interaction.guildId ? { ...payload, flags: MessageFlags.Ephemeral } : payload;
}

async function fetchAppeal(cohort, requestId) {
  const data = await appsScriptGet(cohort, { action: 'appeals', limit: 200 }, { label: 'Appeal lookup' });
  return (data.appeals || []).find(item => item.requestId === requestId) || null;
}

async function sendReview(client, cohort, request) {
  const admin = await client.channels.fetch(cohort.channels.supervisor);
  await admin.send({
    embeds: [reviewEmbed(request)],
    components: reviewButtons(cohort, request.requestId),
    allowedMentions: { parse: [] },
  });
}

async function notifyStudent(client, cohort, request, content, options = {}) {
  const user = await client.users.fetch(request.discordId).catch(() => null);
  const sent = user
    ? await user.send({ content, allowedMentions: { parse: [] } }).then(() => true).catch(() => false)
    : false;
  if (request.scope === 'dawn') {
    const channelId = cohort.channels.emergency || cohort.channels.issues;
    const channel = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
    const approved = options.status === 'approved';
    await channel?.send({
      content: approved
        ? `<@${request.discordId}> ✅ **Your Dawn Focus appeal was approved by a mentor.** Your role and channel access are restored. Attendance counting resumes from the next scheduled check-in; follow the agreed commitment.`
        : `<@${request.discordId}> ❌ **Your Dawn Focus appeal was declined.** Check your private mentor note and contact your mentor if clarification is needed. Access remains removed.`,
      allowedMentions: { users: [request.discordId] },
    }).catch(() => {});
    return sent;
  }
  if (sent) return true;
  const channelId = request.scope === 'bootcamp'
    ? (cohort.channels.eliminated || cohort.channels.issues)
    : cohort.channels.issues;
  const channel = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
  await channel?.send({
    content: `<@${request.discordId}> your appeal **${request.requestId.slice(0, 8)}** was decided. Please contact your mentor if you cannot read the private result.`,
    allowedMentions: { users: [request.discordId] },
  }).catch(() => {});
  return false;
}

async function restoreScope(client, cohort, request, mentorId) {
  if (request.scope === 'bootcamp') {
    return setStudentActive(client, cohort, request.discordId);
  }
  if (request.scope === 'dawn') {
    const guild = await client.guilds.fetch(cohort.guildId);
    const member = await guild.members.fetch(request.discordId);
    const dawn = require('./dawn-discipline');
    return dawn.restoreDawnAccess(client, cohort, member, mentorId);
  }
  throw new Error('Unknown appeal scope');
}

async function decideAppeal(client, cohort, mentorId, requestId, status, note) {
  const request = await fetchAppeal(cohort, requestId);
  if (!request) throw new Error('Appeal request was not found');
  if (request.status !== 'pending') throw new Error(`Appeal was already ${request.status}`);
  if (status === 'approved') await restoreScope(client, cohort, request, mentorId);
  const result = await appsScriptPost(cohort, {
    action: 'decideAppeal', requestId, status, mentorId,
    note: sanitizeAppealText(note, 1000),
  }, { idempotent: true, label: 'Appeal decision' });
  await notifyStudent(client, cohort, result, status === 'approved'
    ? `✅ Your **${APPEAL_SCOPES[result.scope]}** appeal was approved. ${result.scope === 'bootcamp' ? 'Your active status is restored and attendance/activity tracking plus points resume from now.' : 'Your Dawn role and channel access are restored; check-in attendance resumes from the next scheduled window.'} Mentor note: ${result.decisionNote || 'Return consistently and follow the attendance rules.'}`
    : `❌ Your **${APPEAL_SCOPES[result.scope]}** appeal was declined. ${result.scope === 'bootcamp' ? 'You remain inactive and no attendance/activity points will be recorded.' : 'Dawn access remains removed.'} Mentor note: ${result.decisionNote || 'Contact your mentor for clarification.'}`,
  { status });
  return result;
}

async function notifyRestriction(client, cohort, student, options = {}) {
  const scope = options.scope === 'dawn' ? 'dawn' : 'bootcamp';
  const reason = sanitizeAppealText(options.reason, 900) || 'Required attendance was missed.';
  const button = new ActionRowBuilder().addComponents(appealButton(cohort, scope, student.discordId));
  const title = scope === 'dawn' ? 'Dawn Focus Circle access removed' : 'Bootcamp tracking status: inactive';
  const consequence = scope === 'dawn'
    ? 'Your Dawn role and channel access are removed. Dawn attendance will not be recorded until a mentor approves your appeal and restores the role.'
    : 'You are inactive. Attendance, applications, outreach, interviews, communication, RTBR/leaderboard credit and all other bootcamp points will not be recorded until a mentor reactivates you.';
  const recovery = scope === 'dawn'
    ? 'To rejoin, submit the appeal below with the exact missed dates, a valid serious cause, and a clear promise to follow the check-in schedule. The normal Dawn join form cannot bypass removal. You will be mentioned in #emergency and privately notified when a mentor approves or declines.'
    : 'Contact your mentor immediately. To request reactivation, use the appeal below and give the exact dates, a valid serious cause, and a clear plan to resume consistently.';
  const body = `<@${student.discordId}> **${title}**\n**Reason:** ${reason}\n**Effect:** ${consequence}\n**Valid causes:** medical emergency, final examination, death/bereavement, or another serious unavoidable event.\n**Next step:** ${recovery}`;
  let publicSent = false;
  if (options.public !== false && (scope === 'bootcamp' || options.public === true)) {
    const channelId = options.publicChannelId || (scope === 'bootcamp'
      ? cohort.channels.eliminated
      : (cohort.channels.emergency || cohort.channels.issues));
    const channel = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
    if (channel) {
      await channel.send({
        content: body,
        components: [button],
        allowedMentions: { users: [student.discordId] },
      });
      publicSent = true;
    }
    else {
      const admin = await client.channels.fetch(cohort.channels.supervisor).catch(() => null);
      await admin?.send({
        content: `⚠️ Could not post ${scope === 'dawn' ? 'Dawn removal' : 'elimination'} notice for <@${student.discordId}> because the required channel is not configured. Run \`!ensurechannels\`.`,
        allowedMentions: { parse: [] },
      }).catch(() => {});
    }
  }
  const user = await client.users.fetch(student.discordId).catch(() => null);
  const dmSent = await user?.send({
    content: body.replace(`<@${student.discordId}> `, ''),
    components: [button],
    allowedMentions: { parse: [] },
  }).then(() => true).catch(() => false) || false;
  if (!publicSent && !dmSent && options.fallbackPublic !== false) {
    const channelId = scope === 'dawn'
      ? (cohort.channels.emergency || cohort.channels.issues)
      : (cohort.channels.eliminated || cohort.channels.issues);
    const channel = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
    await channel?.send({
      content: scope === 'dawn'
        ? `<@${student.discordId}> your Dawn Focus access remains removed. Use the mobile-friendly appeal below; only mentor approval can restore the role.`
        : `<@${student.discordId}> your inactive bootcamp status remains active. No tracking or points are recorded. Use the mobile-friendly appeal below or contact your mentor.`,
      components: [button],
      allowedMentions: { users: [student.discordId] },
    }).catch(() => {});
  }
  return { publicSent, dmSent };
}

async function inactiveOnRejoin(client, cohort, member) {
  await getRoster(cohort, true);
  if (!excluded[cohort.guildId]?.has(member.id)) return;
  await notifyRestriction(client, cohort, {
    discordId: member.id,
    name: member.displayName,
  }, {
    scope: 'bootcamp', public: false, fallbackPublic: true,
    reason: 'Your earlier inactive status is still in effect. Rejoining Discord does not reset attendance warnings.',
  });
}

module.exports = function registerAppeals(client) {
  client.on('guildMemberAdd', member => {
    const cohort = cohorts.find(item => item.guildId === member.guild.id);
    if (!cohort || member.user.bot || cohort.supervisorIds.includes(member.id)) return;
    setTimeout(() => inactiveOnRejoin(client, cohort, member).catch(() => {}), 8000);
  });

  client.on('messageCreate', async message => {
    if (message.author.bot || !message.guildId) return;
    const command = parseAppealCommand(message.content);
    if (!command) return;
    const cohort = cohorts.find(item => item.guildId === message.guildId);
    if (!cohort || !cohort.supervisorIds.includes(message.author.id)) return;
    if (message.channelId !== cohort.channels.supervisor) {
      return message.reply(`Run appeal administration in <#${cohort.channels.supervisor}>.`);
    }
    try {
      if (command.action === 'list') {
        const data = await appsScriptGet(cohort, {
          action: 'appeals', status: command.status, limit: 100,
        }, { label: 'Appeal list' });
        const appeals = data.appeals || [];
        await message.reply(`Appeal ledger is ready. ${command.status ? 'Pending' : 'Recent'} appeals: **${appeals.length}**.`);
        for (const appeal of appeals) {
          await message.channel.send({
            embeds: [reviewEmbed(appeal)],
            components: appeal.status === 'pending' ? reviewButtons(cohort, appeal.requestId) : [],
            allowedMentions: { parse: [] },
          });
        }
        return;
      }
      if (command.action === 'help') {
        return message.reply('Use `!appeals`, `!appeals all`, `!appeal approve <request-id> | note`, or `!appeal decline <request-id> | note`.');
      }
      const result = await decideAppeal(
        client, cohort, message.author.id, command.requestId, command.action, command.note);
      return message.reply(`✅ Appeal **${result.requestId.slice(0, 8)}** was ${result.status}; ${APPEAL_SCOPES[result.scope]} status was updated.`);
    } catch (error) {
      return message.reply(`❌ Appeal action failed: ${String(error.message).slice(0, 300)}`);
    }
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.customId?.startsWith('appeal:')) return;
    const parts = interaction.customId.split(':');
    const action = parts[1];
    const guildId = parts[2];
    const cohort = cohorts.find(item => item.guildId === guildId);
    if (!cohort) return;
    try {
      if (action === 'start' && interaction.isButton()) {
        const scope = parts[3];
        const userId = parts[4];
        if (interaction.user.id !== userId) {
          return interaction.reply(privateResponse(interaction, { content: 'This appeal button belongs to another student.' }));
        }
        return interaction.reply(privateResponse(interaction, {
          content: 'Choose the truthful main cause. Your answer is sent only to mentors.',
          components: [causePicker(cohort, scope, userId)],
        }));
      }
      if (action === 'cause' && interaction.isStringSelectMenu()) {
        const scope = parts[3];
        const userId = parts[4];
        if (interaction.user.id !== userId) throw new Error('This appeal belongs to another student');
        const cause = interaction.values[0];
        if (!APPEAL_SCOPES[scope] || !validAppealCause(cause)) throw new Error('Invalid appeal category');
        return interaction.showModal(appealModal(cohort, scope, userId, cause));
      }
      if (action === 'submit' && interaction.isModalSubmit()) {
        const scope = parts[3];
        const userId = parts[4];
        const cause = parts[5];
        if (interaction.user.id !== userId || !APPEAL_SCOPES[scope] || !validAppealCause(cause)) {
          throw new Error('Invalid appeal submission');
        }
        await interaction.deferReply(privateResponse(interaction, {}));
        const roster = await getRoster(cohort, true);
        const student = roster.find(item => String(item.discordId || '') === userId);
        if (!student) throw new Error('Your student profile is not linked; contact your mentor');
        if (scope === 'bootcamp' && !excluded[cohort.guildId]?.has(userId)) {
          throw new Error('Your bootcamp profile is already active; no appeal is required');
        }
        if (scope === 'dawn') {
          const dawn = require('./dawn-discipline');
          if (!await dawn.dawnAppealRequired(cohort, userId)) {
            throw new Error('Your Dawn Focus account does not currently require an appeal');
          }
        }
        const result = await appsScriptPost(cohort, {
          action: 'submitAppeal', requestId: randomUUID(), scope, discordId: userId, cause,
          affectedDates: sanitizeAppealText(interaction.fields.getTextInputValue('dates'), 400),
          explanation: sanitizeAppealText(interaction.fields.getTextInputValue('explanation'), 1500),
        }, { idempotent: true, label: 'Appeal submission' });
        if (result.created !== false) await sendReview(client, cohort, result);
        return interaction.editReply({
          content: result.created === false
            ? `Your earlier appeal **${result.requestId.slice(0, 8)}** is still pending mentor review.`
            : `✅ Appeal **${result.requestId.slice(0, 8)}** was sent privately to your mentors.`,
          components: [],
        });
      }
      if (action === 'review' && interaction.isButton()) {
        if (!cohort.supervisorIds.includes(interaction.user.id) || interaction.guildId !== guildId) {
          return interaction.reply(privateResponse(interaction, { content: 'Only a configured mentor can decide this appeal.' }));
        }
        return interaction.showModal(decisionModal(cohort, parts.slice(4).join(':'), parts[3]));
      }
      if (action === 'decision' && interaction.isModalSubmit()) {
        if (!cohort.supervisorIds.includes(interaction.user.id) || interaction.guildId !== guildId) {
          throw new Error('Only a configured mentor can decide this appeal');
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const status = parts[3];
        const result = await decideAppeal(client, cohort, interaction.user.id,
          parts.slice(4).join(':'), status,
          interaction.fields.getTextInputValue('note'));
        return interaction.editReply(`✅ ${APPEAL_SCOPES[result.scope]} appeal **${result.requestId.slice(0, 8)}** was ${result.status}.`);
      }
    } catch (error) {
      const payload = { content: `❌ Appeal failed: ${String(error.message).slice(0, 300)}` };
      if (interaction.deferred || interaction.replied) return interaction.editReply(payload).catch(() => {});
      return interaction.reply(privateResponse(interaction, payload)).catch(() => {});
    }
  });
};

module.exports.APPEAL_CAUSES = APPEAL_CAUSES;
module.exports.appealButton = appealButton;
module.exports.decideAppeal = decideAppeal;
module.exports.notifyRestriction = notifyRestriction;
module.exports.reviewButtons = reviewButtons;
