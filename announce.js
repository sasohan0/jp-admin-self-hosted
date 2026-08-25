// ============================================================
//  announce.js - one-time channel intro announcements
//  !announceall - posts + pins an intro in every automated
//  channel and mirrors each to #automation-announcement.
//  Run once per server (supervisor decides when).
// ============================================================
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { cohorts } = require('./config');
const { report } = require('./reporter');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const EDIT_BUTTON_PREFIX = 'announcement_edit:';
const EDIT_MODAL_PREFIX = 'announcement_edit_submit:';

const INTROS = {
  discussion: `🤖 **JP ADMIN is active in this channel!**\n\n• **Attendance results** post here when a mentor closes the daily form with reporting enabled.\n• Technical questions may also be scheduled here by your mentors. **Reply to the question message** to answer — you get AI feedback and points instantly. One attempt each, honest typing only (copy-paste is detected).\n\nYour points build your **Right-To-Be-Referred score** — top scorers get first access to mentor-special job referrals! 💼`,
  workshop: `🤖 **Welcome to the Communication Workshop!**\n\n• Technical and communication questions drop during the schedule configured by your mentors. Type your answer in the channel within the shown answer window — AI scores you 0–10 with feedback. First correct answer gets +2 ⚡.\n• When time's up, the **model answer + easy explanation** posts automatically.\n• **Live sessions** follow the announced schedule — attendance polls appear during each session; react ✅ to get counted.\n• Question-score and full performance leaderboards post on the configured days and times.\n\nEverything counts toward your **Right-To-Be-Referred score**! 🏆`,
  jobTracking: `🤖 **Job Application Tracking is live!**\n\n📌 **Post your Google Sheet tracker link here once** (sharing: "Anyone with the link → Viewer"). The bot links it to you automatically (✅ reaction = linked).\n\n• On scheduled days, the bot checks every active student's tracker at the time configured by your mentors.\n• Your line shows applications dated today, total tracker rows, new rows since the previous successful check, and recent history.\n• The daily target is set by your mentors and shown in the report.\n\nMore applications → more interview calls → hired faster. 💪`,
  interviewUpdates: `🤖 **Share your interview calls here!**\n\nWhen you get an interview call, post it here (company + role). JP ADMIN instantly replies with a **personalized prep guide**: about the company, the role, what to practice, likely questions, and which project to showcase.\n\nEvery interview you share = **+15 Right-To-Be-Referred points**. Share them all! 🎯`,
  outreach: `🤖 **Outreach tracking is active here.**\n\nPost your company lists, cold-message progress, and profile updates here — every post is logged automatically. Students below the configured outreach expectation are included in the scheduled follow-up report. Consistency wins jobs! 📣`,
  hired: `🤖 **The celebration channel!** When a mentor announces a hire here and mentions the student, JP ADMIN automatically updates all records and excludes them from student reminders. 🎉`,
  projects: `🚀 **Share your BEST projects here!**\n\nWhen mentors match students to job referrals, the bot reads THIS channel. Use this template (one message per project):\n\n**Project Name:** ...\n**Live Link:** https://...\n**GitHub:** https://...\n**Stack:** MongoDB, Express, React, Node, ...\n**Key Features:** 3-5 bullet points of what it does and what YOU built\n**What makes it special:** 1-2 sentences\n\nThe more precise your post, the better the bot can match you to real job referrals. Update anytime by posting again — the 🚀 reaction means it's saved. 💼`,
  rtbr: `⚖️ **Right-To-Be-Referred — how it works**\n\nOn the schedule configured by your mentors, JP ADMIN combines recent activity into one ranking:\n\n❓ **Questions** — points from every answered drop\n🎯 **Interviews** — points for interviews shared in the interview channel\n💼 **Job applications** — progress against this cohort's configured daily target\n🔥 **Streak** — consecutive days meeting that target\n🎤 **Workshop** — points for attended sessions\n\n**Top scorers get referred FIRST to mentor-special jobs.** Every point is visible in the tracking sheet — fully transparent. Climb the board! 🏆`,
  warning: `⚠️ **Attendance warning channel**\n\nJP ADMIN checks recorded Attendance on the working days and time configured by your mentors (default: Monday and Wednesday). A warning is posted only when a student has a **new pair of two consecutive unapproved absences**. Approved leave marked **L** is excluded.\n\n• Each new pair increases the counter by 1.\n• Three warnings represent six separately counted absence dates and make the student inactive.\n• Students can appeal from the eliminated-student notice.\n• If no new qualifying incident exists, this channel stays quiet—silence does not mean the check failed.\n\nMentors can verify privately with \`!activitycheck attendance\`, \`!warnings @student\`, and \`!warningreport\`.`,
};

function parseDiscordMessageLink(value) {
  const match = String(value || '').match(
    /https?:\/\/(?:canary\.|ptb\.)?(?:discord\.com|discordapp\.com)\/channels\/(\d+)\/(\d+)\/(\d+)/i
  );
  return match ? { guildId: match[1], channelId: match[2], messageId: match[3] } : null;
}

function editableAnnouncementChannelIds(cohort) {
  const keys = ['rules', ...Object.keys(INTROS)];
  return new Set(keys.map(key => String(cohort.channels?.[key] || '')).filter(Boolean));
}

function editCustomId(prefix, channelId, messageId) {
  return `${prefix}${channelId}:${messageId}`;
}

function parseEditCustomId(value, prefix) {
  if (!String(value || '').startsWith(prefix)) return null;
  const [channelId, messageId] = String(value).slice(prefix.length).split(':');
  return /^\d+$/.test(channelId || '') && /^\d+$/.test(messageId || '')
    ? { channelId, messageId }
    : null;
}

async function fetchEditableAnnouncement(client, cohort, target) {
  if (target.guildId && target.guildId !== cohort.guildId) throw new Error('That message belongs to another server.');
  if (!editableAnnouncementChannelIds(cohort).has(String(target.channelId))) {
    throw new Error('That message is not in a configured rules or announcement channel.');
  }
  const channel = await client.channels.fetch(target.channelId);
  if (!channel?.isTextBased?.()) throw new Error('The target is not a text channel.');
  const message = await channel.messages.fetch(target.messageId);
  if (message.author.id !== client.user.id) {
    throw new Error('I can edit only messages authored by this bot. If you authored it, edit it directly in Discord.');
  }
  if (!message.pinned) throw new Error('For safety, only pinned bot announcements can be edited.');
  if (!message.content) throw new Error('This announcement has no editable text content.');
  return message;
}

function editorButton(message) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(editCustomId(EDIT_BUTTON_PREFIX, message.channelId, message.id))
      .setLabel('Edit pinned announcement')
      .setStyle(ButtonStyle.Primary)
  );
}

function editorModal(message) {
  return new ModalBuilder()
    .setCustomId(editCustomId(EDIT_MODAL_PREFIX, message.channelId, message.id))
    .setTitle('Edit pinned bot announcement')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('announcement_content')
        .setLabel('Announcement text (Markdown supported)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(2000)
        .setValue(message.content.slice(0, 2000))
    ));
}

async function runAnnounceAll(client, cohort, msg) {
    const mirror = [];
    let posted = 0, failed = [];

    for (const [key, text] of Object.entries(INTROS)) {
      const chId = cohort.channels[key];
      if (!chId || String(chId).startsWith('PASTE')) continue;
      try {
        const ch = await client.channels.fetch(chId);
        const m = await ch.send(text);
        await m.pin().catch(() => failed.push(`pin in <#${chId}> (needs Manage Messages)`));
        mirror.push(`**<#${chId}>**\n${text}`);
        posted++;
        await sleep(1200);
      } catch (err) {
        failed.push(`<#${chId}>: ${err.message}`);
      }
    }

    // mirror everything to #automation-announcement
    if (cohort.channels.automationLog) {
      try {
        const logCh = await client.channels.fetch(cohort.channels.automationLog);
        for (const text of mirror) {
          await logCh.send(text.slice(0, 2000));
          await sleep(1200);
        }
      } catch (err) { failed.push('automation-announcement mirror: ' + err.message); }
    }

    if (msg) await msg.reply(`✅ Posted ${posted} announcements.` + (failed.length ? `\n⚠️ Issues:\n• ${failed.join('\n• ')}` : ''));
    report(cohort.name, `Channel intro announcements posted (${posted})`);
    return posted;
}

function registerAnnounce(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const lower = msg.content.trim().toLowerCase();
    const cohortSel = cohorts.find(c => c.guildId === msg.guildId);

    if (lower.startsWith('!editannouncement')) {
      if (!cohortSel || !cohortSel.supervisorIds.includes(msg.author.id)) return;
      if (msg.channelId !== cohortSel.channels.supervisor) {
        return msg.reply(`Run this editor in <#${cohortSel.channels.supervisor}>.`);
      }
      const target = parseDiscordMessageLink(msg.content);
      if (!target) return msg.reply('Usage: `!editannouncement <Discord message link>`');
      try {
        const message = await fetchEditableAnnouncement(client, cohortSel, target);
        return msg.reply({
          content: `Ready to edit the pinned bot announcement in <#${message.channelId}>. The message link and onboarding rules button will stay valid because the message ID will not change.`,
          components: [editorButton(message)],
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        return msg.reply(`\u274c ${err.message}`);
      }
    }

    // !announce <key> [key2...]  - post intro only in named channel(s)
    if (lower.startsWith('!announce ') && lower !== '!announceall') {
      if (!cohortSel || !cohortSel.supervisorIds.includes(msg.author.id)) return;
      const keys = msg.content.trim().split(/\s+/).slice(1).map(k => k.toLowerCase());
      const valid = keys.filter(k => INTROS[k]);
      const invalid = keys.filter(k => !INTROS[k]);
      if (!valid.length) {
        return msg.reply('Usage: `!announce <channel>` where channel is one of: ' +
          Object.keys(INTROS).map(k => `\`${k}\``).join(', ') + '\nOr `!announceall` for every channel.');
      }
      let done = 0;
      for (const key of valid) {
        const chId = cohortSel.channels[key];
        if (!chId) continue;
        try {
          const ch = await client.channels.fetch(chId);
          const m = await ch.send(INTROS[key]);
          await m.pin().catch(() => {});
          if (cohortSel.channels.automationLog) {
            const logCh = await client.channels.fetch(cohortSel.channels.automationLog);
            await logCh.send(`**<#${chId}>**\n${INTROS[key]}`.slice(0, 2000));
          }
          done++;
        } catch (err) { /* skip */ }
      }
      await msg.reply(`✅ Announced in ${done} channel(s): ${valid.join(', ')}` +
        (invalid.length ? `\n⚠️ Unknown: ${invalid.join(', ')}` : ''));
      return;
    }

    if (lower !== '!announceall') return;
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;
    await msg.reply('📣 Posting + pinning intro announcements in every automated channel...');
    await runAnnounceAll(client, cohort, msg);
  });

  client.on('interactionCreate', async interaction => {
    const isEditorButton = interaction.isButton() && interaction.customId.startsWith(EDIT_BUTTON_PREFIX);
    const isEditorModal = interaction.isModalSubmit() && interaction.customId.startsWith(EDIT_MODAL_PREFIX);
    if (!isEditorButton && !isEditorModal) return;

    const cohort = cohorts.find(c => c.guildId === interaction.guildId);
    if (!cohort || !cohort.supervisorIds.includes(interaction.user.id) || interaction.channelId !== cohort.channels.supervisor) {
      await interaction.reply({
        content: 'Only configured supervisors can edit pinned bot announcements from #bot-admin.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    const target = parseEditCustomId(
      interaction.customId,
      isEditorButton ? EDIT_BUTTON_PREFIX : EDIT_MODAL_PREFIX
    );
    if (!target) {
      await interaction.reply({ content: 'Invalid announcement editor target.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }

    try {
      const message = await fetchEditableAnnouncement(client, cohort, target);
      if (isEditorButton) {
        await interaction.showModal(editorModal(message));
        return;
      }

      const content = interaction.fields.getTextInputValue('announcement_content');
      if (!content.trim()) {
        await interaction.reply({ content: 'Announcement text cannot be empty.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await message.edit({ content, allowedMentions: { parse: [] } });
      await interaction.editReply(`\u2705 Edited the pinned announcement: ${message.url}`);
    } catch (err) {
      const payload = { content: `\u274c ${err.message}`.slice(0, 2000), flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload.content).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  });
}

module.exports = registerAnnounce;
module.exports.runAnnounceAll = runAnnounceAll;
module.exports.parseDiscordMessageLink = parseDiscordMessageLink;
module.exports.editableAnnouncementChannelIds = editableAnnouncementChannelIds;
module.exports.parseEditCustomId = parseEditCustomId;
module.exports.INTROS = INTROS;
