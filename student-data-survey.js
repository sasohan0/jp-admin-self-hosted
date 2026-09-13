// ============================================================
// student-data-survey.js
// Supervisor-controlled private profile completion for current students.
// No private fields or unresolved-student lists are posted publicly.
// ============================================================

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { cohorts } = require('./config');
const { clearCache, getRoster, syncMembers } = require('./roster');
const { fetchGuildMembers } = require('./discord-members');
const { chunkLines } = require('./message-chunks');
const { createJoinRosterSyncQueue } = require('./join-roster-sync');
const { getNumber } = require('./settings');

const FIELD_DEFINITIONS = Object.freeze({
  name: {
    label: 'Full name',
    placeholder: 'Your official full name',
    maxLength: 100,
  },
  email: {
    label: 'Enrollment email',
    placeholder: 'student@example.com',
    maxLength: 254,
  },
  phone: {
    label: 'Phone / WhatsApp number',
    placeholder: '01XXXXXXXXX',
    maxLength: 20,
  },
  region: {
    label: 'Division / current region',
    placeholder: 'Dhaka, Chattogram, Abroad, etc.',
    maxLength: 100,
  },
  subregion: {
    label: 'Dhaka area (Dhaka only)',
    placeholder: 'Mirpur, Uttara, Savar, etc.; blank outside Dhaka',
    maxLength: 100,
  },
});
const FIELD_ORDER = Object.freeze(Object.keys(FIELD_DEFINITIONS));
const DASHBOARD_SEND_ID = 'jp_profile_send_all';
const DASHBOARD_REFRESH_ID = 'jp_profile_refresh';
const SURVEY_START_PREFIX = 'jp_profile_start:';
const SURVEY_SUBMIT_PREFIX = 'jp_profile_submit:';
const CHANNEL_SURVEY_PREFIX = 'jp_profile_channel:';
const ADMIN_EDIT_PREFIX = 'jp_profile_admin_edit:';
const ADMIN_SUBMIT_PREFIX = 'jp_profile_admin_submit:';
const LEGACY_VERIFY_BUTTON_ID = 'jp_roster_verify_start';
const automaticDeliveryRuns = new Map();

function normalizeMissingFields(fields) {
  const wanted = new Set((fields || []).map(value => String(value || '').trim().toLowerCase()));
  return FIELD_ORDER.filter(field => wanted.has(field));
}

function encodeSurveyCustomId(prefix, guildId, fields) {
  const mask = normalizeMissingFields(fields)
    .map(field => FIELD_ORDER.indexOf(field))
    .join('');
  return `${prefix}${guildId}:${mask || '01234'}`;
}

function parseSurveyCustomId(customId, prefix) {
  const value = String(customId || '');
  if (!value.startsWith(prefix)) return null;
  const [guildId, mask = ''] = value.slice(prefix.length).split(':');
  if (!/^\d{16,22}$/.test(guildId || '')) return null;
  const fields = [...new Set(mask.split('')
    .map(index => FIELD_ORDER[Number(index)])
    .filter(Boolean))];
  return { guildId, fields: fields.length ? fields : [...FIELD_ORDER] };
}

function hasLegacyVerificationButton(message) {
  return (message.components || []).some(row =>
    (row.components || []).some(component => component.customId === LEGACY_VERIFY_BUTTON_ID),
  );
}

async function backendGet(cohort, action, params = {}) {
  const url = new URL(cohort.appsScriptUrl);
  url.searchParams.set('action', action);
  url.searchParams.set('guildId', cohort.guildId);
  url.searchParams.set('key', cohort.apiKey);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { redirect: 'follow' });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Apps Script returned non-JSON (HTTP ${response.status})`);
  }
  if (!response.ok || data.error) {
    throw new Error(data.error || `Apps Script HTTP ${response.status}`);
  }
  return data;
}

async function backendPost(cohort, body) {
  const response = await fetch(cohort.appsScriptUrl, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ key: cohort.apiKey }, body)),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Apps Script returned non-JSON (HTTP ${response.status})`);
  }
  if (!response.ok || data.error) {
    throw new Error(data.error || `Apps Script HTTP ${response.status}`);
  }
  return data;
}

function dashboardPayload(cohort, result) {
  const incomplete = result.profiles || [];
  const pendingDelivery = incomplete.filter(profile =>
    String(profile.deliveryStatus || '').trim().toUpperCase() !== 'SENT');
  const preview = incomplete.slice(0, 12).map(profile => {
    const missing = normalizeMissingFields(profile.missing).join(', ') || 'profile review';
    const delivery = profile.deliveryStatus ? ` · ${profile.deliveryStatus}` : '';
    return `• ${profile.displayName || profile.username || profile.discordId} — ${missing}${delivery}`;
  });
  if (incomplete.length > preview.length) {
    preview.push(`…and ${incomplete.length - preview.length} more`);
  }
  const embed = new EmbedBuilder()
    .setTitle(`Private Student Data — ${cohort.name}`)
    .setColor(incomplete.length ? 0xe67e22 : 0x2ecc71)
    .setDescription(
      incomplete.length
        ? 'These current Discord students have missing profile fields. Use the button below to send each one a private Discord survey.'
        : 'Every current Discord student has the required profile fields.',
    )
    .addFields(
      { name: 'Current students', value: String(result.total || 0), inline: true },
      { name: 'Complete profiles', value: String(result.complete || 0), inline: true },
      { name: 'Need data', value: String(incomplete.length), inline: true },
      { name: 'Survey delivered', value: String(result.delivered || 0), inline: true },
      { name: 'Survey completed', value: String(result.completedSurveys || 0), inline: true },
      { name: 'Delivery problems', value: String(result.deliveryProblems || 0), inline: true },
      {
        name: 'Missing fields (private preview)',
        value: preview.length ? preview.join('\n').slice(0, 1024) : 'None',
      },
    )
    .setFooter({
      text: 'Delivered = Discord accepted the DM. Completed = the student submitted it.',
    });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(DASHBOARD_SEND_ID)
      .setLabel('Send / retry pending surveys')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!pendingDelivery.length),
    new ButtonBuilder()
      .setCustomId(DASHBOARD_REFRESH_ID)
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

function privateSurveyPayload(cohort, profile) {
  const fields = normalizeMissingFields(profile.missing);
  return {
    embeds: [new EmbedBuilder()
      .setTitle(`${cohort.name} — complete your private student profile`)
      .setColor(0x3498db)
      .setDescription(
        'A mentor requested the missing information below. Your answers go directly to the private cohort Sheet and are not posted in any Discord channel.',
      )
      .addFields({
        name: 'Please provide',
        value: fields.map(field => FIELD_DEFINITIONS[field].label).join('\n'),
      })
      .setFooter({ text: 'Your Discord account and ID are attached automatically.' })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(encodeSurveyCustomId(SURVEY_START_PREFIX, cohort.guildId, fields))
        .setLabel('Fill private data survey')
        .setStyle(ButtonStyle.Primary),
    )],
    allowedMentions: { parse: [] },
  };
}

function encodeAdminProfileCustomId(prefix, guildId, discordId) {
  return `${prefix}${guildId}:${discordId}`;
}

function parseAdminProfileCustomId(customId, prefix) {
  const value = String(customId || '');
  if (!value.startsWith(prefix)) return null;
  const [guildId, discordId, extra] = value.slice(prefix.length).split(':');
  if (extra || !/^\d{16,22}$/.test(guildId || '') || !/^\d{16,22}$/.test(discordId || '')) {
    return null;
  }
  return { guildId, discordId };
}

function parseEditProfileTargetId(content) {
  const match = String(content || '').trim().match(/^!editprofile\s+(?:<@!?)?(\d{16,22})>?$/i);
  return match ? match[1] : '';
}

function channelSurveyButton(cohort) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CHANNEL_SURVEY_PREFIX}${cohort.guildId}`)
      .setLabel('Complete my private profile')
      .setStyle(ButtonStyle.Primary),
  );
}

function resolveMentionedChannel(msg, content) {
  const mentioned = msg.mentions.channels.first();
  if (mentioned) return mentioned;
  const rawId = String(content || '').match(/\b(\d{17,20})\b/)?.[1];
  return rawId ? msg.guild.channels.cache.get(rawId) : null;
}

async function postChannelSurvey(msg, cohort, channel, profiles) {
  if (!channel || channel.guildId !== cohort.guildId || !channel.isTextBased?.() || typeof channel.send !== 'function') {
    throw new Error('Choose a text channel in this server, for example `!profilesurvey #discussion`.');
  }
  const members = await fetchGuildMembers(msg.guild);
  const eligible = (profiles || []).filter(profile => {
    const member = members.get(profile.discordId);
    return member && !member.user.bot && !cohort.supervisorIds.includes(member.id);
  });
  if (!eligible.length) return { posted: 0, messages: 0 };

  const chunks = [];
  let current = [];
  let length = 0;
  for (const profile of eligible) {
    const mention = `<@${profile.discordId}>`;
    if (current.length && length + mention.length + 2 > 1600) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(mention);
    length += mention.length + 2;
  }
  if (current.length) chunks.push(current);

  for (let index = 0; index < chunks.length; index++) {
    const ids = chunks[index].map(value => value.slice(2, -1));
    await channel.send({
      content:
        `${index === 0 ? '## Student profile completion required\n' : ''}` +
        `${chunks[index].join(' ')}\n\n` +
        'Please use the button below. The form is private: your answers are saved to the cohort Sheet and are not posted in this channel.',
      components: [channelSurveyButton(cohort)],
      allowedMentions: { users: ids },
    });
  }
  return { posted: eligible.length, messages: chunks.length };
}

function surveyModal(guildId, fields, initialValues = {}, options = {}) {
  const selected = normalizeMissingFields(fields);
  const modal = new ModalBuilder()
    .setCustomId(options.customId || encodeSurveyCustomId(SURVEY_SUBMIT_PREFIX, guildId, selected))
    .setTitle(options.title || 'Private student data');
  for (const field of selected) {
    const definition = FIELD_DEFINITIONS[field];
    const input = new TextInputBuilder()
        .setCustomId(`jp_profile_${field}`)
        .setLabel(definition.label)
        .setPlaceholder(definition.placeholder)
        .setRequired(field !== 'subregion')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(definition.maxLength);
    const initial = String(initialValues[field] || '').trim().slice(0, definition.maxLength);
    if (initial) input.setValue(initial);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
}

function adminEditButton(cohort, member) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeAdminProfileCustomId(
        ADMIN_EDIT_PREFIX, cohort.guildId, member.id))
      .setLabel(`Edit ${member.user.username}'s private profile`.slice(0, 80))
      .setStyle(ButtonStyle.Primary),
  );
}

function profileInitialValues(profile, member) {
  const email = String(profile?.email || '').trim();
  return {
    name: profile?.name || member?.displayName || member?.user?.globalName || member?.user?.username || '',
    email: /@(?:pending\.jp-admin\.invalid|discord\.com)$/i.test(email) ? '' : email,
    phone: profile?.phone || '',
    region: profile?.region || '',
    subregion: profile?.subregion || '',
  };
}

async function removeLegacyWelcomePanel(client, cohort) {
  if (!cohort.channels.welcome) return 0;
  const channel = await client.channels.fetch(cohort.channels.welcome).catch(() => null);
  if (!channel?.isTextBased()) return 0;
  const [recent, pinned] = await Promise.all([
    channel.messages.fetch({ limit: 100 }).catch(() => null),
    channel.messages.fetchPins()
      .then(result => result.items.map(item => item.message))
      .catch(() => null),
  ]);
  const candidates = new Map();
  for (const collection of [recent, pinned]) {
    for (const message of collection?.values?.() || []) {
      candidates.set(message.id, message);
    }
  }
  const legacy = [...candidates.values()].filter(message =>
    message.author.id === client.user.id && hasLegacyVerificationButton(message));
  let removed = 0;
  for (const message of legacy) {
    await message.delete().then(() => { removed++; }).catch(() => {});
  }
  return removed;
}

async function sendPrivateSurveys(client, cohort, profiles) {
  const result = { sent: [], dmClosed: [], absent: [], receiptError: '' };
  const guild = await client.guilds.fetch(cohort.guildId);
  for (const profile of profiles || []) {
    const member = await guild.members.fetch(profile.discordId).catch(() => null);
    if (!member || member.user.bot || cohort.supervisorIds.includes(member.id)) {
      result.absent.push(profile);
      continue;
    }
    await member.send(privateSurveyPayload(cohort, profile))
      .then(() => result.sent.push(profile))
      .catch(() => result.dmClosed.push(profile));
  }
  const receiptItems = [
    ...result.sent.map(profile => ({
      discordId: profile.discordId, username: profile.username,
      displayName: profile.displayName, status: 'SENT',
    })),
    ...result.dmClosed.map(profile => ({
      discordId: profile.discordId, username: profile.username,
      displayName: profile.displayName, status: 'DM BLOCKED',
    })),
    ...result.absent.map(profile => ({
      discordId: profile.discordId, username: profile.username,
      displayName: profile.displayName, status: 'NOT IN SERVER',
    })),
  ];
  try {
    result.receipts = await backendPost(cohort, {
      action: 'recordProfileSurveyDeliveries',
      items: receiptItems,
    });
  } catch (err) {
    // DM attempts already happened. Keep their result truthful while making
    // any failure to save the durable Sheet receipts visible to supervisors.
    result.receiptError = err.message;
  }
  return result;
}

function selectUndeliveredProfiles(profiles) {
  return (profiles || []).filter(profile => {
    const status = String(profile.deliveryStatus || '').trim().toUpperCase();
    return !status || status === 'NOT IN SERVER';
  });
}

async function deliverNewPrivateSurveys(client, cohort) {
  const guildId = String(cohort?.guildId || '');
  if (automaticDeliveryRuns.has(guildId)) return automaticDeliveryRuns.get(guildId);
  const run = (async () => {
    const current = await backendGet(cohort, 'missingprofiles');
    const pending = selectUndeliveredProfiles(current.profiles);
    if (!pending.length) return { attempted: 0, sent: [], dmClosed: [], absent: [] };
    const result = await sendPrivateSurveys(client, cohort, pending);
    result.attempted = pending.length;
    return result;
  })();
  automaticDeliveryRuns.set(guildId, run);
  try {
    return await run;
  } finally {
    if (automaticDeliveryRuns.get(guildId) === run) automaticDeliveryRuns.delete(guildId);
  }
}

async function sendDeliveryReport(channel, result) {
  const summary = [
    `✅ Private surveys sent: ${result.sent.length}`,
    `⚠️ DMs closed/blocked: ${result.dmClosed.length}`,
    `⚪ No longer in server: ${result.absent.length}`,
    result.receiptError
      ? `⚠️ Sheet delivery receipts were not saved: ${result.receiptError.slice(0, 180)}`
      : `🧾 Sheet delivery receipts saved: ${result.receipts?.recorded || 0}`,
  ];
  await channel.send({
    content: summary.join('\n'),
    allowedMentions: { parse: [] },
  });
  const review = [
    ...result.dmClosed.map(item =>
      `DM CLOSED\t${item.displayName || item.username || item.discordId}\t${item.discordId}`),
    ...result.absent.map(item =>
      `NOT IN SERVER\t${item.displayName || item.username || item.discordId}\t${item.discordId}`),
  ];
  for (const content of chunkLines(review, 1800)) {
    await channel.send({
      content: `\`\`\`text\n${content}\n\`\`\``,
      allowedMentions: { parse: [] },
    });
  }
}

function resolveAdminCohort(interaction) {
  const cohort = cohorts.find(item => item.guildId === interaction.guildId);
  if (!cohort || interaction.channelId !== cohort.channels.supervisor) return null;
  if (!cohort.supervisorIds.includes(interaction.user.id)) return null;
  return cohort;
}

function hasCompletePrivateProfile(entry) {
  if (!entry) return false;
  const email = String(entry.email || '').trim().toLowerCase();
  const phoneDigits = String(entry.phone || '').replace(/\D/g, '');
  return Boolean(
    String(entry.name || '').trim() &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) &&
    !email.endsWith('@pending.jp-admin.invalid') &&
    !email.endsWith('@discord.com') &&
    !email.endsWith('.invalid') &&
    phoneDigits.length >= 8 && phoneDigits.length <= 15 &&
    String(entry.region || '').trim() &&
    (!/^dhaka$/i.test(String(entry.region || '').trim()) || String(entry.subregion || '').trim()),
  );
}

function selectAttentionProfiles(profiles, roster, activityStudents) {
  const emailByDiscordId = new Map((roster || []).map(student => [
    String(student.discordId || ''),
    String(student.email || '').trim().toLowerCase(),
  ]));
  const jobsByEmail = new Map((activityStudents || []).map(student => [
    String(student.email || '').trim().toLowerCase(),
    Number(student.jobPts) || 0,
  ]));
  return (profiles || []).filter(profile => {
    const email = emailByDiscordId.get(String(profile.discordId || ''));
    return !email || !jobsByEmail.has(email) || jobsByEmail.get(email) <= 0;
  });
}

async function waitForAdmissionProfile(cohort, discordId, delayMs = 3500) {
  if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  const roster = await getRoster(cohort, true);
  return roster.find(entry => String(entry.discordId || '') === String(discordId || '')) || null;
}

module.exports = function registerStudentDataSurvey(client) {
  const joinRosterSync = createJoinRosterSyncQueue({
    sync: syncMembers,
    delayMs: 30000,
    onSuccess: async (cohort, result) => {
      console.log(
        `[student-data] ${cohort.name}: Discord roster reconciled ` +
        `(${result.eligibleMembers} current students)`,
      );
      if (!(result.unmatched || []).length) return;
      try {
        const delivery = await deliverNewPrivateSurveys(client, cohort);
        if (!delivery.attempted) return;
        const channel = await client.channels.fetch(cohort.channels.supervisor).catch(() => null);
        if (channel?.isTextBased()) await sendDeliveryReport(channel, delivery);
      } catch (err) {
        console.error(`[student-data] automatic private survey failed for ${cohort.name}: ${err.message}`);
      }
    },
    onError: async (cohort, err, attempt) => {
      console.error(
        `[student-data] ${cohort.name}: join roster reconciliation failed ` +
        `(attempt ${attempt}): ${err.message}`,
      );
      if (attempt !== 1 || !cohort.channels?.supervisor) return;
      const channel = await client.channels.fetch(cohort.channels.supervisor).catch(() => null);
      await channel?.send({
        content:
          '⚠️ Automatic roster sync after new member joins failed and will retry. ' +
          'No student was removed. Run `!profilecheck` later if this warning repeats.',
        allowedMentions: { parse: [] },
      }).catch(() => {});
    },
  });

  // Catch members who arrived while Render or Discord was unavailable. This
  // runs once per cohort after every process start and shares the same batching
  // queue as live guildMemberAdd events.
  client.once('clientReady', () => {
    for (const cohort of cohorts) joinRosterSync.schedule(client, cohort);
  });

  client.on('guildMemberAdd', async (member) => {
    const cohort = cohorts.find(item => item.guildId === member.guild.id);
    if (!cohort || member.user.bot || cohort.supervisorIds.includes(member.id)) return;
    joinRosterSync.schedule(client, cohort);
    try {
      const admittedProfile = await waitForAdmissionProfile(cohort, member.id);
      if (hasCompletePrivateProfile(admittedProfile)) return;
    } catch (err) {
      console.warn(`[student-data] join profile check failed for ${cohort.name}/${member.id}: ${err.message}`);
    }
    const profile = {
      discordId: member.id,
      username: member.user.username,
      displayName: member.displayName,
      missing: FIELD_ORDER,
    };
    let status = 'SENT';
    try {
      await member.send(privateSurveyPayload(cohort, profile));
    } catch (err) {
      status = 'DM BLOCKED';
      console.warn(`[student-data] join survey DM blocked for ${cohort.name}/${member.id}: ${err.message}`);
    }
    try {
      await backendPost(cohort, {
        action: 'recordProfileSurveyDeliveries',
        items: [{
          discordId: member.id,
          username: member.user.username,
          displayName: member.displayName,
          status,
        }],
      });
      clearCache(cohort);
    } catch (err) {
      console.error(`[student-data] join survey receipt failed for ${cohort.name}/${member.id}:`, err.message);
    }
  });

  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const content = msg.content.trim();
    const lower = content.toLowerCase();
    const isAttentionSurvey = /^!studentsurvey\s+attention(?:\s+\d+)?(?:\s+send)?$/i.test(content);
    const isDashboard = lower === '!missingdata' || lower === '!profilecheck' ||
      lower === '!studentsurvey' || lower === '!studentsurvey incomplete';
    const isChannelSurvey = lower === '!profilesurvey' || lower.startsWith('!profilesurvey ');
    const isEditProfile = lower === '!editprofile' || lower.startsWith('!editprofile ');
    if (!isDashboard && !isAttentionSurvey && !isChannelSurvey && !isEditProfile) return;
    const cohort = cohorts.find(item => item.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;
    if (msg.channelId !== cohort.channels.supervisor) {
      await msg.reply(`Run this private command in <#${cohort.channels.supervisor}>.`);
      return;
    }
    try {
      if (isEditProfile) {
        const targetId = msg.mentions.users.first()?.id || parseEditProfileTargetId(content);
        const member = targetId
          ? await msg.guild.members.fetch(targetId).catch(() => null)
          : null;
        if (!member || member.user.bot || cohort.supervisorIds.includes(member.id)) {
          await msg.reply('Usage: `!editprofile @student` or `!editprofile <Discord ID>`');
          return;
        }
        await msg.reply({
          content:
            `Private manual correction for **${member.displayName}**. ` +
            'The form opens only for a configured supervisor and overwrites the five identity/contact fields after validation.',
          components: [adminEditButton(cohort, member)],
          allowedMentions: { parse: [] },
        });
        return;
      }
      let syncResult = null;
      if (lower === '!profilecheck' || isChannelSurvey || isAttentionSurvey) {
        syncResult = await syncMembers(client, cohort);
      }
      const [result, removed] = await Promise.all([
        backendGet(cohort, 'missingprofiles'),
        removeLegacyWelcomePanel(client, cohort),
      ]);
      if (isAttentionSurvey) {
        const days = Math.max(1, Math.min(30, Number(content.match(/\b(\d+)\b/)?.[1] || 3)));
        const send = /\bsend\s*$/i.test(content);
        const [roster, activity] = await Promise.all([
          getRoster(cohort, true),
          backendGet(cohort, 'rtbr', { days, jobTarget: await getNumber(cohort, 'jobstarget') }),
        ]);
        const attention = selectAttentionProfiles(result.profiles, roster, activity.students);
        // `send` is an explicit supervisor action. Resend to the selected
        // attention group if an earlier general survey was delivered but the
        // student never completed it.
        const selectedForDelivery = attention;
        const lines = attention.map(profile =>
          `${profile.displayName || profile.username || 'Unknown'}\t@${profile.username || 'unknown'}\t${profile.discordId}\tmissing: ${normalizeMissingFields(profile.missing).join(', ')}`);
        await msg.reply({
          content: `**Incomplete + no job activity in the last ${days} day(s): ${attention.length}**\n` +
            (send
              ? `Private surveys selected: ${selectedForDelivery.length}`
              : `Preview only. Send with \`!studentsurvey attention ${days} send\`.`),
          allowedMentions: { parse: [] },
        });
        for (const block of chunkLines(lines, 1750)) {
          await msg.channel.send({
            content: `\`\`\`text\n${block}\n\`\`\``,
            allowedMentions: { parse: [] },
          });
        }
        if (send && selectedForDelivery.length) {
          const delivery = await sendPrivateSurveys(client, cohort, selectedForDelivery);
          await sendDeliveryReport(msg.channel, delivery);
        }
        return;
      }
      if (isChannelSurvey) {
        const target = resolveMentionedChannel(msg, content);
        if (!target) {
          await msg.reply('Usage: `!profilesurvey #channel`');
          return;
        }
        const posted = await postChannelSurvey(msg, cohort, target, result.profiles || []);
        await msg.reply({
          content: posted.posted
            ? `✅ Mentioned **${posted.posted}** incomplete student(s) in ${target}. Their button opens a private Discord form.`
            : `✅ No current student needs profile data; nothing was posted in ${target}.`,
          allowedMentions: { parse: [] },
        });
        return;
      }
      await msg.reply(dashboardPayload(cohort, result));
      if (syncResult) {
        const roster = await getRoster(cohort, true);
        const currentIds = new Set(roster.map(item => item.discordId).filter(Boolean));
        const reviewTotal = Number(syncResult.rosterReview?.total || result.total || 0);
        const complete = Number(result.complete || 0);
        const incompleteProfiles = result.profiles || [];
        const ready = reviewTotal === syncResult.eligibleMembers &&
          complete === reviewTotal && currentIds.size === syncResult.eligibleMembers &&
          !syncResult.replacementSkipped;
        await msg.channel.send({
          content:
            `**Profile sync check**\n` +
            `Status: ${ready ? '✅ READY — every current student is captured, linked, and complete' : '⚠️ ACTION NEEDED'}\n` +
            `Discord students captured: ${reviewTotal}/${syncResult.eligibleMembers}\n` +
            `Bot_Map rows with Discord ID: ${currentIds.size}\n` +
            `Complete private profiles: ${complete}/${reviewTotal}\n` +
            `Needs information: ${incompleteProfiles.length}` +
            (syncResult.replacementSkipped ? `\n⚠️ Bot_Map replacement was safely skipped: ${syncResult.skipReason}` : ''),
          allowedMentions: { parse: [] },
        });
        const incompleteLines = incompleteProfiles.map(profile =>
          `${profile.displayName || profile.username || 'Unknown'}\t@${profile.username || 'unknown'}\t${profile.discordId}\tmissing: ${normalizeMissingFields(profile.missing).join(', ')}`);
        for (const block of chunkLines(incompleteLines, 1750)) {
          await msg.channel.send({
            content: `**Incomplete profiles (copyable; no pings):**\n\`\`\`text\n${block}\n\`\`\``,
            allowedMentions: { parse: [] },
          });
        }
      }
      if (removed) {
        await msg.channel.send({
          content: `🧹 Removed ${removed} obsolete welcome-channel verification panel${removed === 1 ? '' : 's'}.`,
          allowedMentions: { parse: [] },
        });
      }
    } catch (err) {
      console.error('[student-data] dashboard failed:', err);
      await msg.reply({
        content: `❌ Missing-data check failed: ${err.message.slice(0, 300)}`,
        allowedMentions: { parse: [] },
      });
    }
  });

  client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton()) {
      const adminEdit = parseAdminProfileCustomId(interaction.customId, ADMIN_EDIT_PREFIX);
      if (adminEdit) {
        const cohort = resolveAdminCohort(interaction);
        if (!cohort || cohort.guildId !== adminEdit.guildId) {
          await interaction.reply({
            content: 'This private editor is only available to configured supervisors in bot-admin.',
            ephemeral: true,
          });
          return;
        }
        try {
          // Discord requires a modal to be the interaction's first response.
          // Do not wait for a Sheet read or Discord API fetch here: either can
          // exceed the acknowledgement window. Submission verifies the current
          // member authoritatively before any write occurs.
          const member = interaction.guild.members.cache.get(adminEdit.discordId) || null;
          await interaction.showModal(surveyModal(
            cohort.guildId,
            FIELD_ORDER,
            profileInitialValues(null, member),
            {
              customId: encodeAdminProfileCustomId(
                ADMIN_SUBMIT_PREFIX, cohort.guildId, adminEdit.discordId),
              title: 'Supervisor profile correction',
            },
          ));
        } catch (err) {
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: `Could not open editor: ${err.message}`, ephemeral: true });
          }
        }
        return;
      }
    }

    if (interaction.isButton() &&
        [DASHBOARD_SEND_ID, DASHBOARD_REFRESH_ID].includes(interaction.customId)) {
      const cohort = resolveAdminCohort(interaction);
      if (!cohort) {
        await interaction.reply({
          content: 'This control is only available to configured supervisors in this cohort’s private bot-admin channel.',
          ephemeral: true,
        });
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      try {
        const current = await backendGet(cohort, 'missingprofiles');
        if (interaction.customId === DASHBOARD_REFRESH_ID) {
          await interaction.message.edit(dashboardPayload(cohort, current));
          await interaction.editReply('✅ Missing-data status refreshed.');
          return;
        }
        const pending = (current.profiles || []).filter(profile =>
          String(profile.deliveryStatus || '').trim().toUpperCase() !== 'SENT');
        const delivery = await sendPrivateSurveys(client, cohort, pending);
        await sendDeliveryReport(interaction.channel, delivery);
        await interaction.editReply(
          `✅ Finished: ${delivery.sent.length} private survey(s) sent. Delivery problems are listed only in bot-admin.`,
        );
      } catch (err) {
        console.error('[student-data] dashboard action failed:', err);
        await interaction.editReply(`❌ ${err.message.slice(0, 300)}`);
      }
      return;
    }

    if (interaction.isButton()) {
      const channelSurvey = parseSurveyCustomId(interaction.customId, CHANNEL_SURVEY_PREFIX);
      if (channelSurvey) {
        const cohort = cohorts.find(item => item.guildId === channelSurvey.guildId);
        if (!cohort || interaction.guildId !== cohort.guildId) {
          await interaction.reply({ content: 'This cohort survey is not valid here.', ephemeral: true });
          return;
        }
        try {
          const member = interaction.member;
          if (!member || member.user.bot || cohort.supervisorIds.includes(member.id)) {
            throw new Error('Only a current student in this cohort can submit this survey');
          }
          // A modal must be the interaction's first response. Ask for the five
          // canonical fields here; the Discord-ID-keyed backend fills only
          // missing authoritative values and preserves existing data.
          await interaction.showModal(surveyModal(cohort.guildId, FIELD_ORDER));
        } catch (err) {
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
              content: `❌ Could not open your private profile form: ${err.message.slice(0, 240)}`,
              ephemeral: true,
            });
          }
        }
        return;
      }
      const parsed = parseSurveyCustomId(interaction.customId, SURVEY_START_PREFIX);
      if (!parsed) return;
      const cohort = cohorts.find(item => item.guildId === parsed.guildId);
      if (!cohort) {
        await interaction.reply({ content: 'This cohort is no longer active.' });
        return;
      }
      const guild = await client.guilds.fetch(cohort.guildId).catch(() => null);
      const member = await guild?.members.fetch(interaction.user.id).catch(() => null);
      if (!member || member.user.bot || cohort.supervisorIds.includes(member.id)) {
        await interaction.reply({
          content: 'Only a current student in this cohort can submit this survey.',
        });
        return;
      }
      await interaction.showModal(surveyModal(cohort.guildId, parsed.fields));
      return;
    }

    if (!interaction.isModalSubmit()) return;
    const adminSubmit = parseAdminProfileCustomId(interaction.customId, ADMIN_SUBMIT_PREFIX);
    if (adminSubmit) {
      const cohort = resolveAdminCohort(interaction);
      if (!cohort || cohort.guildId !== adminSubmit.guildId) {
        await interaction.reply({
          content: 'This private editor is only available to configured supervisors in bot-admin.',
          ephemeral: true,
        });
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      try {
        const member = await interaction.guild.members.fetch(adminSubmit.discordId);
        if (member.user.bot || cohort.supervisorIds.includes(member.id)) {
          throw new Error('Choose a current student in this cohort');
        }
        const fields = {};
        for (const field of FIELD_ORDER) {
          fields[field] = interaction.fields.getTextInputValue(`jp_profile_${field}`).trim();
        }
        await backendPost(cohort, {
          action: 'submitStudentProfile',
          guildId: cohort.guildId,
          discordId: member.id,
          username: member.user.username,
          displayName: member.displayName,
          supervisorId: interaction.user.id,
          adminOverride: true,
          fields,
        });
        clearCache(cohort);
        await interaction.editReply(
          `Saved and synchronized **${member.displayName}** across All Data, Bot_Map, ` +
          'Roster Review, Attendance, Jobs Applied, Outreach Update, Interview Updates, and Job_Sheets.',
        );
      } catch (err) {
        console.error('[student-data] supervisor correction failed:', err.message);
        await interaction.editReply(`Profile correction was not saved: ${err.message.slice(0, 260)}`);
      }
      return;
    }
    const parsed = parseSurveyCustomId(interaction.customId, SURVEY_SUBMIT_PREFIX);
    if (!parsed) return;
    const cohort = cohorts.find(item => item.guildId === parsed.guildId);
    if (!cohort) {
      await interaction.reply({ content: 'This cohort is no longer active.' });
      return;
    }
    // Survey buttons live in DMs, so a normal interaction reply is already
    // private; ephemeral flags are not required or relied on here.
    await interaction.deferReply();
    try {
      const guild = await client.guilds.fetch(cohort.guildId);
      const member = await guild.members.fetch(interaction.user.id).catch(() => null);
      if (!member || member.user.bot || cohort.supervisorIds.includes(member.id)) {
        throw new Error('Only a current student in this cohort can submit this survey');
      }
      const fields = {};
      for (const field of parsed.fields) {
        fields[field] = interaction.fields.getTextInputValue(`jp_profile_${field}`).trim();
      }
      const result = await backendPost(cohort, {
        action: 'submitStudentProfile',
        guildId: cohort.guildId,
        discordId: member.id,
        username: member.user.username,
        displayName: member.displayName,
        fields,
      });
      clearCache(cohort);
      const remaining = normalizeMissingFields(result.remainingMissing);
      await interaction.editReply({
        content: remaining.length
          ? `✅ Saved privately. Still needed: ${remaining.map(field => FIELD_DEFINITIONS[field].label).join(', ')}.`
          : '✅ Your private student profile is complete and linked to your current Discord account.' +
            (result.reviewRequired ? '\nA mentor will review one or more differences from the older Sheet data.' : ''),
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      console.error('[student-data] submission failed:', err.message);
      await interaction.editReply({
        content:
          `❌ Your data was not saved: ${err.message.slice(0, 260)}\n` +
          'Please check the values or contact your mentor privately.',
        allowedMentions: { parse: [] },
      });
    }
  });
};

module.exports.normalizeMissingFields = normalizeMissingFields;
module.exports.encodeSurveyCustomId = encodeSurveyCustomId;
module.exports.parseSurveyCustomId = parseSurveyCustomId;
module.exports.hasLegacyVerificationButton = hasLegacyVerificationButton;
module.exports.encodeAdminProfileCustomId = encodeAdminProfileCustomId;
module.exports.parseAdminProfileCustomId = parseAdminProfileCustomId;
module.exports.parseEditProfileTargetId = parseEditProfileTargetId;
module.exports.channelSurveyButton = channelSurveyButton;
module.exports.hasCompletePrivateProfile = hasCompletePrivateProfile;
module.exports.selectAttentionProfiles = selectAttentionProfiles;
module.exports.deliverNewPrivateSurveys = deliverNewPrivateSurveys;
module.exports.selectUndeliveredProfiles = selectUndeliveredProfiles;
