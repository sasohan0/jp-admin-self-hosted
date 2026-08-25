// ============================================================
//  workshop.js v2 - fully runtime-configurable session system
//  Minute-tick scheduler: every event time comes from !set
//  (slots, preminutes, announcetime, noshowtime, pollwindow,
//  meeturl, gpturl) - changes apply live, no restart.
//  Events per day:
//   • announcetime: full announcement (@everyone, both channels)
//   • per slot: reminder PRE minutes before start (discussion +
//     workshop) with meet + GPT links
//   • start+40: ✅ attendance poll (both channels, roster-verified)
//   • noshowtime: mention students who attended NO session
// ============================================================
const cron = require('node-cron');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { cohorts } = require('./config');
const { getRoster, isExcluded, mention } = require('./roster');
const { report, reportError } = require('./reporter');
const { isWarmup } = require('./state');
const { isOn, setOn } = require('./automations');
const { isScheduledToday } = require('./scheduler');
const { getSetting, getNumber, parseSlots, resolveChannel, setSetting } = require('./settings');
const { normalizeTime } = require('./runtime-schedule');
const { validDateKey } = require('./work-calendar');
const { ROLE_NAME } = require('./dawn-discipline');

const fired = {};          // cohort -> Set('day:event')
const todayAttendance = {}; // cohort -> { day, emails:Set }
const sendLocks = new Set();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const dhakaToday = (tz) => new Date().toLocaleDateString('en-CA', { timeZone: tz });

function nowMin(tz) {
  const n = new Date();
  return Number(n.toLocaleString('en-GB', { timeZone: tz, hour: '2-digit', hour12: false })) * 60 +
         Number(n.toLocaleString('en-GB', { timeZone: tz, minute: '2-digit' }));
}
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
const label12 = (min) => {
  const h = Math.floor(min / 60), m = min % 60;
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

async function workshopChannels(cohort) {
  return [...new Set([
    await resolveChannel(cohort, 'channel_workshop', cohort.channels.workshop),
    await resolveChannel(cohort, 'channel_discussion', cohort.channels.discussion),
  ].filter(Boolean))];
}

async function workshopPanel(cohort) {
  const [dailyOn, specialOn, slots, announceTime, specialDate, specialTime, specialTitle] = await Promise.all([
    isOn(cohort, 'workshop'), isOn(cohort, 'specialworkshop'), getSetting(cohort, 'slots'),
    getSetting(cohort, 'announcetime'), getSetting(cohort, 'specialworkshopdate'),
    getSetting(cohort, 'specialworkshoptime'), getSetting(cohort, 'specialworkshoptitle'),
  ]);
  return {
    embeds: [{
      title: `🎤 ${cohort.name} — Workshop Control`,
      color: dailyOn || specialOn ? 0x5865f2 : 0x95a5a6,
      fields: [
        {
          name: `Daily communication workshop · ${dailyOn ? 'ON' : 'OFF'}`,
          value: `Approval request: **${announceTime}**\nSlots: **${slots}**\nNo public schedule/reminder/poll is sent until a supervisor confirms that day.`,
        },
        {
          name: `Dawn Focus special workshop · ${specialOn ? 'ON' : 'OFF'}`,
          value: `Confirmation request: **${specialDate || 'not scheduled'} ${specialTime}**\nTitle: **${specialTitle}**\nThe final announcement goes only to Dawn Focus Circle after confirmation.`,
        },
      ],
      footer: { text: 'All controls and confirmations stay private in #bot-admin.' },
    }],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('wctl:toggle:daily').setLabel(dailyOn ? 'Disable Daily' : 'Enable Daily')
          .setStyle(dailyOn ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId('wctl:edit:daily').setLabel('Edit Daily Schedule').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('wctl:request:daily').setLabel('Confirm / Send Daily').setStyle(ButtonStyle.Secondary),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('wctl:toggle:special').setLabel(specialOn ? 'Disable Dawn Special' : 'Enable Dawn Special')
          .setStyle(specialOn ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId('wctl:edit:special').setLabel('Edit Dawn Special').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('wctl:request:special').setLabel('Confirm / Send Special').setStyle(ButtonStyle.Secondary),
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

async function regularWorkshopModal(cohort) {
  const [slots, announceTime, preminutes, pollwindow, meeturl] = await Promise.all([
    getSetting(cohort, 'slots'), getSetting(cohort, 'announcetime'), getSetting(cohort, 'preminutes'),
    getSetting(cohort, 'pollwindow'), getSetting(cohort, 'meeturl'),
  ]);
  return new ModalBuilder().setCustomId('wctl:regular:submit').setTitle('Daily workshop schedule').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('slots').setLabel('Session slots').setStyle(TextInputStyle.Short).setValue(slots).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('announce').setLabel('Approval request time (HH:MM)').setStyle(TextInputStyle.Short).setValue(announceTime).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pre').setLabel('Reminder minutes before session').setStyle(TextInputStyle.Short).setValue(String(preminutes)).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('poll').setLabel('Poll window in minutes').setStyle(TextInputStyle.Short).setValue(String(pollwindow)).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('meet').setLabel('Meeting link').setStyle(TextInputStyle.Short).setValue(meeturl).setRequired(true)),
  );
}

async function specialWorkshopModal(cohort) {
  const [date, time, title, link, context] = await Promise.all([
    getSetting(cohort, 'specialworkshopdate'), getSetting(cohort, 'specialworkshoptime'),
    getSetting(cohort, 'specialworkshoptitle'), getSetting(cohort, 'specialworkshoplink'),
    getSetting(cohort, 'specialworkshopcontext'),
  ]);
  return new ModalBuilder().setCustomId('wctl:special:submit').setTitle('Dawn Focus special workshop').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('date').setLabel('Confirmation date (YYYY-MM-DD)').setStyle(TextInputStyle.Short).setValue(date || dhakaToday(cohort.timezone)).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('time').setLabel('Confirmation time (HH:MM)').setStyle(TextInputStyle.Short).setValue(time).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Workshop title').setStyle(TextInputStyle.Short).setValue(title).setMaxLength(100).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('link').setLabel('Meeting/resource link').setStyle(TextInputStyle.Short).setValue(link || '').setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('context').setLabel('Announcement details and session schedule').setStyle(TextInputStyle.Paragraph).setValue(context).setMaxLength(1200).setRequired(true)),
  );
}

async function saveRegularWorkshop(cohort, interaction) {
  const slots = interaction.fields.getTextInputValue('slots').trim();
  if (!slots || parseSlots(slots).length !== slots.split(',').filter(Boolean).length) {
    throw new Error('Slots must look like `11:30-13:00,15:00-17:00`.');
  }
  const announceTime = normalizeTime(interaction.fields.getTextInputValue('announce'));
  if (!announceTime) throw new Error('Approval time must use 24-hour HH:MM.');
  const pre = Number(interaction.fields.getTextInputValue('pre'));
  const poll = Number(interaction.fields.getTextInputValue('poll'));
  if (!Number.isInteger(pre) || pre < 0 || pre > 120) throw new Error('Reminder must be 0–120 minutes.');
  if (!Number.isInteger(poll) || poll < 1 || poll > 120) throw new Error('Poll window must be 1–120 minutes.');
  const meet = interaction.fields.getTextInputValue('meet').trim();
  if (!/^https?:\/\//i.test(meet)) throw new Error('Meeting link must start with http:// or https://.');
  for (const [key, value] of [['slots', slots], ['announcetime', announceTime], ['preminutes', pre], ['pollwindow', poll], ['meeturl', meet]]) {
    await setSetting(cohort, key, value);
  }
}

async function saveSpecialWorkshop(cohort, interaction) {
  const date = interaction.fields.getTextInputValue('date').trim();
  const time = normalizeTime(interaction.fields.getTextInputValue('time'));
  const title = interaction.fields.getTextInputValue('title').trim();
  const link = interaction.fields.getTextInputValue('link').trim();
  const context = interaction.fields.getTextInputValue('context').trim();
  if (!validDateKey(date)) throw new Error('Date must be a real YYYY-MM-DD date.');
  if (!time) throw new Error('Time must use 24-hour HH:MM.');
  if (link && !/^https?:\/\//i.test(link)) throw new Error('Link must start with http:// or https://.');
  for (const [key, value] of [
    ['specialworkshopdate', date], ['specialworkshoptime', time], ['specialworkshoptitle', title],
    ['specialworkshoplink', link], ['specialworkshopcontext', context], ['specialworkshoplastsent', ''],
  ]) await setSetting(cohort, key, value);
}

async function requestApproval(client, cohort, kind) {
  const admin = await client.channels.fetch(cohort.channels.supervisor);
  const day = dhakaToday(cohort.timezone);
  if (kind === 'daily') {
    if (!(await isOn(cohort, 'workshop'))) throw new Error('Enable the daily workshop first.');
    const [slots, meeturl, sent] = await Promise.all([
      getSetting(cohort, 'slots'), getSetting(cohort, 'meeturl'), getSetting(cohort, 'workshoplastsent'),
    ]);
    if (sent === day) {
      await admin.send({ content: `ℹ️ The daily workshop announcement for **${day}** was already sent.`, allowedMentions: { parse: [] } });
      return;
    }
    await admin.send({
      embeds: [{
        title: 'Confirm daily workshop announcement',
        color: 0xf1c40f,
        description: `Date: **${day}**\nSlots: **${slots}**\nMeeting: ${meeturl}\n\nNothing will be posted publicly until a supervisor confirms.`,
      }],
      components: [confirmationButtons('daily', day)],
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (!(await isOn(cohort, 'specialworkshop'))) throw new Error('Enable the Dawn special workshop first.');
  const [date, time, title, link, context, sent] = await Promise.all([
    getSetting(cohort, 'specialworkshopdate'), getSetting(cohort, 'specialworkshoptime'),
    getSetting(cohort, 'specialworkshoptitle'), getSetting(cohort, 'specialworkshoplink'),
    getSetting(cohort, 'specialworkshopcontext'), getSetting(cohort, 'specialworkshoplastsent'),
  ]);
  if (!validDateKey(date)) throw new Error('Configure the Dawn special workshop date first.');
  if (sent === date) {
    await admin.send({ content: `ℹ️ The Dawn special workshop announcement for **${date}** was already sent.`, allowedMentions: { parse: [] } });
    return;
  }
  await admin.send({
    embeds: [{
      title: 'Confirm Dawn Focus special workshop',
      color: 0xf1c40f,
      description: `Configured confirmation: **${date} ${time}**\nTitle: **${title}**\n${context}${link ? `\n${link}` : ''}\n\nIt will be posted only in Dawn Focus Circle after confirmation.`,
    }],
    components: [confirmationButtons('special', date)],
    allowedMentions: { parse: [] },
  });
}

function confirmationButtons(kind, token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wctl:send:${kind}:${token}`).setLabel('Confirm and Send').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`wctl:cancel:${kind}:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
}

async function confirmDailyAnnouncement(client, cohort, expectedDay) {
  if (!(await isOn(cohort, 'workshop'))) throw new Error('Daily workshop automation is OFF. Enable it before confirming.');
  const day = dhakaToday(cohort.timezone);
  if (expectedDay !== day) throw new Error('That confirmation expired; request a new one for today.');
  const lock = `${cohort.guildId}:daily:${day}`;
  if (sendLocks.has(lock)) throw new Error('This announcement is already being sent.');
  sendLocks.add(lock);
  try {
    if ((await getSetting(cohort, 'workshoplastsent')) === day) throw new Error('Today’s workshop announcement was already sent.');
    await announce(client, cohort);
    await setSetting(cohort, 'workshoplastsent', day);
  } finally { sendLocks.delete(lock); }
}

async function confirmSpecialAnnouncement(client, cohort, expectedDate) {
  if (!(await isOn(cohort, 'specialworkshop'))) throw new Error('Dawn special-workshop automation is OFF. Enable it before confirming.');
  const [date, title, link, context] = await Promise.all([
    getSetting(cohort, 'specialworkshopdate'), getSetting(cohort, 'specialworkshoptitle'),
    getSetting(cohort, 'specialworkshoplink'), getSetting(cohort, 'specialworkshopcontext'),
  ]);
  if (expectedDate !== date) throw new Error('That confirmation is outdated; request a new one.');
  const lock = `${cohort.guildId}:special:${date}`;
  if (sendLocks.has(lock)) throw new Error('This announcement is already being sent.');
  sendLocks.add(lock);
  try {
    if ((await getSetting(cohort, 'specialworkshoplastsent')) === date) throw new Error('This special-workshop announcement was already sent.');
    const guild = await client.guilds.fetch(cohort.guildId);
    await guild.roles.fetch();
    const role = guild.roles.cache.find(item => item.name.toLowerCase() === ROLE_NAME.toLowerCase());
    const channel = cohort.channels.discipline ? await client.channels.fetch(cohort.channels.discipline).catch(() => null) : null;
    if (!role || !channel?.isTextBased()) throw new Error('Run `!dawn setup` before sending a Dawn special workshop.');
    await channel.send({
      content: `<@&${role.id}>\n🎓 **${title}**\n${context}${link ? `\n🔗 ${link}` : ''}`.slice(0, 1990),
      allowedMentions: { roles: [role.id] },
    });
    await setSetting(cohort, 'specialworkshoplastsent', date);
    report(cohort.name, `Dawn special workshop announced (${date})`);
  } finally { sendLocks.delete(lock); }
}

module.exports = function registerWorkshop(client) {
  cron.schedule('* * * * *', () => tick(client), { timezone: 'Asia/Dhaka' });
  console.log('[workshop] minute scheduler active');

  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const lower = msg.content.trim().toLowerCase();
    if (!['!workshop', '!specialworkshop', '!workshopannounce', '!workshoppoll'].includes(lower)) return;
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;
    if (msg.channelId !== cohort.channels.supervisor) {
      await msg.reply({ content: `Run workshop controls in <#${cohort.channels.supervisor}>.`, allowedMentions: { parse: [] } });
      return;
    }
    if (lower === '!workshop' || lower === '!specialworkshop') return msg.channel.send(await workshopPanel(cohort));
    if (lower === '!workshopannounce') return requestApproval(client, cohort, 'daily');
    if (lower === '!workshoppoll') return runPoll(client, cohort, { name: 'Manual' }, true);
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.customId?.startsWith('wctl:')) return;
    const cohort = cohorts.find(candidate => candidate.guildId === interaction.guildId);
    if (!cohort || !cohort.supervisorIds.includes(interaction.user.id) ||
        interaction.channelId !== cohort.channels.supervisor) {
      await interaction.reply({ content: 'Workshop controls are private to configured supervisors in #bot-admin.', ephemeral: true }).catch(() => {});
      return;
    }
    const [, action, kind, token] = interaction.customId.split(':');
    try {
      if (interaction.isButton() && action === 'open') {
        await interaction.reply({ ...(await workshopPanel(cohort)), ephemeral: true });
        return;
      }
      if (interaction.isButton() && action === 'toggle') {
        await interaction.deferUpdate();
        const key = kind === 'special' ? 'specialworkshop' : 'workshop';
        await setOn(cohort, key, !(await isOn(cohort, key)));
        await interaction.message.edit(await workshopPanel(cohort));
        return;
      }
      if (interaction.isButton() && action === 'edit') {
        await interaction.showModal(kind === 'special'
          ? await specialWorkshopModal(cohort)
          : await regularWorkshopModal(cohort));
        return;
      }
      if (interaction.isButton() && action === 'request') {
        await interaction.deferReply({ ephemeral: true });
        await requestApproval(client, cohort, kind);
        await interaction.editReply(`✅ ${kind === 'special' ? 'Special Dawn' : 'Daily'} workshop confirmation posted in #bot-admin.`);
        return;
      }
      if (interaction.isButton() && action === 'cancel') {
        await interaction.update({ content: 'Workshop announcement cancelled.', embeds: [], components: [], allowedMentions: { parse: [] } });
        return;
      }
      if (interaction.isButton() && action === 'send') {
        await interaction.deferReply({ ephemeral: true });
        if (kind === 'daily') await confirmDailyAnnouncement(client, cohort, token);
        else await confirmSpecialAnnouncement(client, cohort, token);
        await interaction.message.edit({ components: [] }).catch(() => {});
        await interaction.editReply('✅ Confirmed announcement sent.');
        return;
      }
      if (interaction.isModalSubmit() && action === 'regular') {
        await interaction.deferReply({ ephemeral: true });
        await saveRegularWorkshop(cohort, interaction);
        await interaction.editReply('✅ Daily workshop settings saved. The bot will ask for confirmation before the next public announcement.');
        return;
      }
      if (interaction.isModalSubmit() && action === 'special') {
        await interaction.deferReply({ ephemeral: true });
        await saveSpecialWorkshop(cohort, interaction);
        await interaction.editReply('✅ Dawn Focus special-workshop schedule saved. Enable it from `!workshop`; the bot will request confirmation at the configured send time.');
      }
    } catch (error) {
      const payload = { content: `❌ Workshop control failed: ${String(error.message).slice(0, 300)}`, ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.editReply(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  });
};

async function tick(client) {
  for (const cohort of cohorts) {
    try {
      const day = dhakaToday(cohort.timezone);
      const now = nowMin(cohort.timezone);
      const set = (fired[cohort.guildId] = fired[cohort.guildId] || { day, keys: new Set() });
      if (set.day !== day) { set.day = day; set.keys.clear(); }
      const once = async (key, fn) => {
        if (set.keys.has(key)) return;
        set.keys.add(key);
        await fn();
      };

      // Special Dawn workshops have their own opt-in switch and schedule. The
      // scheduled moment creates a private confirmation card, never a public
      // post without a supervisor click.
      if ((await isOn(cohort, 'specialworkshop')) &&
          (await isScheduledToday(cohort, 'specialworkshop'))) {
        const specialDate = await getSetting(cohort, 'specialworkshopdate');
        const specialTime = await getSetting(cohort, 'specialworkshoptime');
        if (specialDate === day && now === toMin(specialTime)) {
          await once(`special-approval:${specialDate}:${specialTime}`, () => requestApproval(client, cohort, 'special'));
        }
      }

      if (!cohort.channels.workshop || !(await isOn(cohort, 'workshop')) ||
          !(await isScheduledToday(cohort, 'workshop')) || (await isWarmup(cohort))) continue;

      if (now === toMin(await getSetting(cohort, 'announcetime'))) {
        await once('approval', () => requestApproval(client, cohort, 'daily'));
      }

      // Reminders, polls, and no-show reports become active only after the
      // supervisor confirms that day's public schedule announcement.
      if ((await getSetting(cohort, 'workshoplastsent')) !== day) continue;

      const pre = await getNumber(cohort, 'preminutes');
      const slots = parseSlots(await getSetting(cohort, 'slots'));
      for (const slot of slots) {
        if (now === slot.startMin - pre) await once(`pre:${slot.name}`, () => preReminder(client, cohort, slot, pre));
        if (now === slot.startMin + 40) await once(`poll:${slot.name}`, () => runPoll(client, cohort, slot));
      }

      if (now === toMin(await getSetting(cohort, 'noshowtime'))) await once('noshow', () => noShowReport(client, cohort));
    } catch (err) { console.error('[workshop] tick error:', err.message); }
  }
}

async function announce(client, cohort) {
  try {
    const [meetUrl, gptUrl, slotsStr] = await Promise.all([
      getSetting(cohort, 'meeturl'), getSetting(cohort, 'gpturl'), getSetting(cohort, 'slots'),
    ]);
    const slots = parseSlots(slotsStr);
    const text = `@everyone

### 📣 **Update: Daily Communication Workshop**

To accelerate our communication growth, we are integrating a specialized AI tool into our daily workshop routine.

---

### 🤖 **New Tool: "Speak More" GPT**

We will be utilizing the **[Speak More](${gptUrl})** custom GPT. This tool is designed to provide real-time feedback on your English fluency, interview answers (STAR method), and technical explanations using its voice mode.

---

### 🕒 **Workshop Schedule & Attendance**

Please remember that participating in the workshop is mandatory for your professional development.

${slots.map(s => `* **${s.name} Slot:** ${label12(s.startMin)} – ${label12(s.endMin)}`).join('\n')}

**Important Notes:**

* **Mandatory:** You must join at least **one** of these slots daily. Attendance is recorded via ✅ polls during each session.
* **Highly Recommended:** Joining all sessions is encouraged to maximize your practice time and feedback.
* **Location:** Join via the [Virtual Breakroom](${meetUrl}).

Make sure to use the **Speak More** tool to refine your responses before and during our sessions. Let's make the most of this resource to level up!

**Jazakallah Khairan.** 💙`;
    for (const chId of await workshopChannels(cohort)) {
      const ch = await client.channels.fetch(chId);
      await ch.send({ content: text, allowedMentions: { parse: ['everyone'] } });
      await sleep(1000);
    }
    report(cohort.name, 'Workshop daily announcement posted');
    return true;
  } catch (err) {
    reportError(cohort.name, 'Workshop announcement failed: ' + err.message);
    throw err;
  }
}

async function preReminder(client, cohort, slot, pre) {
  try {
    const [meetUrl, gptUrl] = await Promise.all([getSetting(cohort, 'meeturl'), getSetting(cohort, 'gpturl')]);
    const text = `@everyone\n⏰ **${slot.name} workshop session starts in ${pre} minutes** (${label12(slot.startMin)})!\n🎥 Join: ${meetUrl}\n🤖 Warm up with [Speak More](${gptUrl}) — attendance poll comes during the session. See you inside! 🎤`;
    for (const chId of (await workshopChannels(cohort)).reverse()) {
      const ch = await client.channels.fetch(chId);
      await ch.send({ content: text, allowedMentions: { parse: ['everyone'] } });
      await sleep(900);
    }
    report(cohort.name, `Session reminder posted (${slot.name})`);
  } catch (err) { reportError(cohort.name, `Session reminder failed (${slot.name}): ` + err.message); }
}

async function runPoll(client, cohort, slot, manual = false) {
  try {
    const windowMin = await getNumber(cohort, 'pollwindow');
    const deadline = Math.floor((Date.now() + windowMin * 60 * 1000) / 1000);
    const text = `🗳 **${slot.name} session attendance!** If you are in the workshop right now, react ✅ within **${windowMin} minutes** (closes <t:${deadline}:R>). Attendance counts toward your Right-To-Be-Referred score.`;
    const msgs = [];
    for (const chId of await workshopChannels(cohort)) {
      const ch = await client.channels.fetch(chId);
      const m = await ch.send(text);
      await m.react('✅');
      msgs.push(m);
      await sleep(800);
    }
    setTimeout(() => closePoll(client, cohort, slot, msgs, manual), windowMin * 60 * 1000);
    report(cohort.name, `Workshop poll opened (${slot.name})`);
  } catch (err) { reportError(cohort.name, `Workshop poll failed (${slot.name}): ` + err.message); }
}

async function closePoll(client, cohort, slot, msgs, manual = false) {
  try {
    // A poll may have opened before a supervisor declared a same-day holiday.
    // Suppress its delayed write/report unless the poll was explicitly manual.
    if (!manual && !(await isScheduledToday(cohort, 'workshop'))) {
      console.log(`[workshop] ${cohort.name}: poll close suppressed (holiday/not scheduled)`);
      return;
    }
    const roster = await getRoster(cohort, true);
    const byId = new Map(roster.map(s => [s.discordId, s]));
    const attended = new Map();
    for (const m of msgs) {
      try {
        const fresh = await m.channel.messages.fetch(m.id);
        const reaction = fresh.reactions.cache.get('✅');
        if (!reaction) continue;
        const users = await reaction.users.fetch();
        for (const [id] of users) {
          const s = byId.get(id);
          if (s && !isExcluded(cohort, s)) attended.set(s.email, s);
        }
      } catch { /* skip */ }
    }
    const day = dhakaToday(cohort.timezone);
    const entries = [...attended.values()].map(s => ({ email: s.email, name: s.name }));
    if (entries.length) {
      await fetch(cohort.appsScriptUrl, {
        method: 'POST', redirect: 'follow',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: cohort.apiKey, action: 'logWorkshop', date: day, slot: slot.name, entries }),
      });
    }
    const rec = (todayAttendance[cohort.guildId] = todayAttendance[cohort.guildId] || { day, emails: new Set() });
    if (rec.day !== day) { rec.day = day; rec.emails = new Set(); }
    for (const e of attended.keys()) rec.emails.add(e);

    const ch = await client.channels.fetch(cohort.channels.workshop);
    const names = entries.map(e => e.name).sort();
    await ch.send({
      embeds: [{
        title: `✅ ${slot.name} session attendance — ${entries.length} joined`,
        description: names.length ? names.map(n => `• ${n}`).join('\n').slice(0, 4000) : 'Nobody marked attendance this session.',
        color: entries.length ? 0x2ecc71 : 0x95a5a6,
        footer: { text: '+4 RTBR points per attended session' },
      }],
    });
    report(cohort.name, `Workshop poll closed (${slot.name}): ${entries.length} attended`);
  } catch (err) { reportError(cohort.name, `Poll close failed (${slot.name}): ` + err.message); }
}

async function noShowReport(client, cohort) {
  try {
    const day = dhakaToday(cohort.timezone);
    const roster = await getRoster(cohort, true);
    const rec = todayAttendance[cohort.guildId];
    const attended = (rec && rec.day === day) ? rec.emails : new Set();
    const missing = roster.filter(s => !isExcluded(cohort, s) && !attended.has(s.email));
    const ch = await client.channels.fetch(await resolveChannel(cohort, 'channel_noshow', cohort.channels.workshop));
    if (!missing.length) {
      await ch.send('🌟 **Every student joined at least one workshop session today. Outstanding!**');
      return;
    }
    const lines = [
      `@everyone\n📢 **Workshop no-show report** — these students did not join ANY session today. Communication practice is mandatory — join at least one slot tomorrow! 🎤`,
      ...missing.map(s => `• ${mention(s)}`),
    ];
    for (const chunk of chunkLines(lines, 1900)) {
      await ch.send({ content: chunk, allowedMentions: { parse: ['users', 'everyone'] } });
      await sleep(1200);
    }
    report(cohort.name, `Workshop no-shows: ${missing.length}`);
  } catch (err) { reportError(cohort.name, 'No-show report failed: ' + err.message); }
}

function getTodayWorkshopMisses(cohortOrGuildId) {
  const guildId = typeof cohortOrGuildId === 'object' ? cohortOrGuildId?.guildId : cohortOrGuildId;
  return todayAttendance[guildId]; // used by DM nudges
}

function chunkLines(lines, maxLen) {
  const chunks = []; let cur = '';
  for (const line of lines) {
    if (cur.length + line.length + 1 > maxLen) { chunks.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

module.exports.getTodayWorkshopMisses = getTodayWorkshopMisses;
module.exports.confirmationButtons = confirmationButtons;
module.exports.regularWorkshopModal = regularWorkshopModal;
module.exports.specialWorkshopModal = specialWorkshopModal;
module.exports.workshopPanel = workshopPanel;
