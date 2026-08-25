// ============================================================
//  questions.js - three-period scheduler + AI evaluation/scoring
//  Private !questions controls morning/afternoon/evening time/count,
//  qwindow, safe gap, and destination. Remaining timers can be replanned.
// ============================================================

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { cohorts } = require('./config');
const { getRoster, isExcluded } = require('./roster');
const { askJson } = require('./groq');
const { isWarmup } = require('./state');
const { isScheduledToday } = require('./scheduler');
const { isOn, setOn } = require('./automations');
const { getSetting, getNumber, resolveChannel, setSetting } = require('./settings');
const { localClock, scheduleAtSetting } = require('./runtime-schedule');
const { buildPeriodPlan, parseGapMinutes, parsePeriodValue } = require('./question-plan');

const COMM = 'communication';
const TECH_CATS = ['technical', 'brainstorming', 'situational'];
const active = {}; // `${cohort.guildId}:${channelId}` -> question state
const planVersion = {}; // guildId -> incrementing generation; safely replaces pending daily timers

// ---------------- helpers ----------------
async function api(cohort, params) {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const res = await fetch(`${cohort.appsScriptUrl}?key=${encodeURIComponent(cohort.apiKey)}&${qs}`, { redirect: 'follow' });
  return res.json();
}
async function post(cohort, body) {
  const res = await fetch(cohort.appsScriptUrl, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ key: cohort.apiKey }, body)),
  });
  return res.json();
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// AI-generate questions into the bank (auto-refill + manual command)
async function generateQuestions(cohort, category, count) {
  const r = await askJson([
    { role: 'system', content: `Respond ONLY with JSON: {"questions":[{"question":"...","answer":"model answer, 2-5 sentences","difficulty":"easy|medium|hard"}]}` },
    { role: 'user', content:
      `Generate ${count} "${category}" practice questions for junior MERN-stack developers in Bangladesh preparing for jobs. ` +
      `STRICT stack: MongoDB, Express, React, Node.js, Next.js, JavaScript/TypeScript, HTML/CSS, REST/GraphQL, Git. NEVER C#, ASP.NET, .NET, or Java. ` +
      `Also include some modern AI-related dev topics where fitting: AI agents, prompt engineering, using AI coding tools ("vibe coding") responsibly, integrating LLM APIs into MERN apps. ` +
      `Category meanings - communication: professional English/workplace communication for interviews and outreach; technical: coding/CS concepts; brainstorming: open critical-thinking; situational: workplace scenario judgment. ` +
      `Make them realistic interview-grade, varied difficulty, and DIFFERENT from common textbook questions.` },
  ]);
  const data = await post(cohort, { action: 'addQuestions',
    questions: (r.questions || []).map(q => ({ ...q, category })) });
  if (data.error) throw new Error(data.error);
  return data.added || 0;
}

function nowMinutes(tz) {
  const now = new Date();
  return Number(now.toLocaleString('en-GB', { timeZone: tz, hour: '2-digit', hour12: false })) * 60 +
         Number(now.toLocaleString('en-GB', { timeZone: tz, minute: '2-digit' }));
}

// ============================================================
//  DAILY PLAN
// ============================================================
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function legacyQuestionChannelId(cohort, choice) {
  if (choice === 'workshop') return cohort.channels.workshop;
  if (choice === 'dawn') return cohort.channels.discipline;
  return cohort.channels.discussion;
}

async function questionChannelId(cohort, choice) {
  return resolveChannel(cohort, 'channel_questions', legacyQuestionChannelId(cohort, choice));
}

async function questionSchedule(cohort) {
  const [morningTime, morningCount, afternoonTime, afternoonCount, eveningTime,
    eveningCount, windowMin, gapMin, channel] = await Promise.all([
    getSetting(cohort, 'qmorningtime'), getNumber(cohort, 'qmorningcount'),
    getSetting(cohort, 'qafternoontime'), getNumber(cohort, 'qafternooncount'),
    getSetting(cohort, 'qeveningtime'), getNumber(cohort, 'qeveningcount'),
    getNumber(cohort, 'qwindow'), getNumber(cohort, 'qperiodgap'), getSetting(cohort, 'qchannel'),
  ]);
  return {
    periods: {
      morning: { time: morningTime, count: morningCount },
      afternoon: { time: afternoonTime, count: afternoonCount },
      evening: { time: eveningTime, count: eveningCount },
    },
    windowMin,
    gapMin,
    channel: ['discussion', 'workshop', 'dawn'].includes(channel) ? channel : 'discussion',
  };
}

async function planToday(client, cohort) {
  if (!(await isOn(cohort, 'questions'))) {
    console.log(`[questions] ${cohort.name}: automation OFF - no drops today`);
    return;
  }
  if (!(await isScheduledToday(cohort, 'questions'))) {
    console.log(`[questions] ${cohort.name}: not scheduled today (day of week)`);
    return;
  }
  if (await isWarmup(cohort)) {
    console.log(`[questions] ${cohort.name}: warm-up period - no drops today`);
    return;
  }
  const generation = (planVersion[cohort.guildId] || 0) + 1;
  planVersion[cohort.guildId] = generation;
  const schedule = await questionSchedule(cohort);
  const events = buildPeriodPlan(schedule.periods, schedule.windowMin, schedule.gapMin);
  const nowMin = nowMinutes(cohort.timezone);
  const channelId = await questionChannelId(cohort, schedule.channel);
  if (!channelId) {
    console.warn(`[questions] ${cohort.name}: ${schedule.channel} question channel is unavailable`);
    return;
  }
  const categories = shuffle(events.map((_, index) =>
    index % 3 === 2 ? COMM : TECH_CATS[index % TECH_CATS.length]));
  let planned = 0;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.minute <= nowMin + 1) continue;
    setTimeout(() => {
      if (planVersion[cohort.guildId] === generation) {
        dropQuestion(
          client, cohort, channelId, categories[index], schedule.windowMin,
          true,
        );
      }
    }, (event.minute - nowMin) * 60 * 1000);
    planned++;
  }
  console.log(`[questions] ${cohort.name}: planned ${planned} ${schedule.channel} drops across morning/afternoon/evening`);
}

// ============================================================
//  DROP
// ============================================================
async function dropQuestion(client, cohort, channelId, category, windowMin, requireReply, manual = false) {
  const key = `${cohort.guildId}:${channelId}`;
  try {
    // fire-time gate: a mid-day !automation stop cancels pending timers here
    if (!manual && !(await isOn(cohort, 'questions'))) {
      console.log(`[questions] ${cohort.name}: drop suppressed (automation OFF)`);
      return;
    }
    // Timers are planned earlier in the day. Re-check the working calendar at
    // fire time so a holiday declared after planning cancels the pending drop.
    if (!manual && !(await isScheduledToday(cohort, 'questions'))) {
      console.log(`[questions] ${cohort.name}: drop suppressed (holiday/not scheduled)`);
      return;
    }
    // channel override for workshop drops
    if (channelId === cohort.channels.workshop) {
      channelId = await resolveChannel(cohort, 'channel_workshop', channelId);
    }
    if (active[key]) { // one active per channel - retry in 5 min
      setTimeout(() => dropQuestion(client, cohort, channelId, category, windowMin, requireReply, manual), 5 * 60 * 1000);
      return;
    }
    let q = await api(cohort, { action: 'nextquestion', category });
    if (q.error) {
      // bank empty for this category -> auto-generate a batch and retry
      console.log(`[questions] ${cohort.name}: bank empty for '${category}', auto-generating 15...`);
      try {
        const added = await generateQuestions(cohort, category, 15);
        console.log(`[questions] ${cohort.name}: auto-added ${added} ${category} questions`);
        q = await api(cohort, { action: 'nextquestion', category });
      } catch (genErr) {
        console.error('[questions] auto-refill failed:', genErr.message);
      }
    }
    if (q.error) {
      const admin = await client.channels.fetch(cohort.channels.supervisor);
      await admin.send(`⚠️ Question drop skipped: ${q.error} (auto-refill also failed - check GROQ_API_KEY / terminal log).`);
      return;
    }

    const channel = await client.channels.fetch(channelId);
    const deadline = Date.now() + windowMin * 60 * 1000;
    const emoji = category === COMM ? '🗣' : category === 'technical' ? '💻' : category === 'brainstorming' ? '🧠' : '🎭';

    const sent = await channel.send({
      content: `📢 **New ${category} question!** Closes <t:${Math.floor(deadline / 1000)}:R>` +
        (requireReply ? ' — **Reply to THIS message** to answer!' : ' — type your answer below!'),
      embeds: [{
        title: `${emoji} ${category.toUpperCase()} — ${q.difficulty || 'medium'}`,
        description: String(q.question).slice(0, 4000),
        color: category === COMM ? 0x9b59b6 : 0x3498db,
        footer: { text: (requireReply ? 'Use Discord Reply on this message. ' : '') + 'One attempt each. Type honestly - copy-paste gets detected!' },
      }],
    });

    active[key] = {
      qid: q.id, category, channelId, requireReply,
      question: q.question, modelAnswer: q.modelAnswer,
      deadline, droppedAt: Date.now(), answered: new Set(),
      firstCorrectDone: false, results: [], msgId: sent.id,
    };
    setTimeout(() => closeQuestion(client, cohort, key), windowMin * 60 * 1000);
    console.log(`[questions] ${cohort.name}: dropped ${q.id} (${category}) in ${channelId}`);
  } catch (err) {
    console.error('[questions] drop failed:', err.message);
    active[key] = null;
  }
}

// ============================================================
//  CLOSE + breakdown
// ============================================================
async function closeQuestion(client, cohort, key) {
  const a = active[key];
  if (!a) return;
  active[key] = null;
  try {
    const channel = await client.channels.fetch(a.channelId);

    let easy = '';
    try {
      const r = await askJson([
        { role: 'system', content: 'Respond ONLY with JSON: {"easy_explanation": "the model answer explained in very simple English for junior developers in Bangladesh, 3-6 short bullet lines, friendly tone"}' },
        { role: 'user', content: `Question: ${a.question}\nModel answer: ${a.modelAnswer}` },
      ]);
      easy = r.easy_explanation || '';
    } catch { /* fall back to raw model answer */ }

    const top = a.results.filter(r => r.score >= 6).sort((x, y) => y.score - x.score).slice(0, 5);
    const fields = [{ name: '✅ Model answer', value: String(a.modelAnswer).slice(0, 1024) }];
    if (easy) fields.push({ name: '💡 In simple words', value: String(easy).slice(0, 1024) });
    fields.push({
      name: `🏅 Scorers this round (${a.results.length} answered)`,
      value: top.length
        ? top.map(r => `• **${r.name}** — ${r.score}/10${r.bonus ? ' ⚡+2 first!' : ''}`).join('\n').slice(0, 1024)
        : 'Nobody answered this one — read the breakdown above and catch the next drop! 💪',
    });

    await channel.send({
      embeds: [{ title: `⏰ Time's up — ${a.category} question closed`, color: 0x95a5a6, fields }],
      reply: { messageReference: a.msgId },
    });
  } catch (err) {
    console.error('[questions] close failed:', err.message);
  }
}

// ============================================================
//  EVALUATE
// ============================================================
const EVAL_SYSTEM = `You evaluate a junior developer's answer to a practice question. Compare with the model answer (meaning matters, not exact words; casual language and typos are FINE and are a sign of honest typing).
Suspect cheating (AI-generated or copy-pasted) when the answer has: perfectly polished essay structure, formal headings/bullets unusual for chat, generic AI phrasing, or covers far more than asked with flawless grammar. A "fast_paste" hint means it appeared too fast to have been typed.
Respond ONLY with JSON:
{"correct": true/false, "score": 0-10, "cheating_suspected": true/false, "feedback": "1-2 sentences, warm and specific, simple English"}`;

const PRAISES = ['🌟 Brilliant!', '🔥 On fire!', '💎 Premium answer!', '🚀 Interview-ready!', '👑 Top class!'];
function clip(t, n) { return String(t || '').slice(0, n); }

async function evaluateAnswer(client, cohort, msg, a, student) {
  a.answered.add(msg.author.id);
  const fastPaste = msg.content.length > 350 && (Date.now() - a.droppedAt) < 60 * 1000;

  let r;
  try {
    r = await askJson([
      { role: 'system', content: EVAL_SYSTEM },
      { role: 'user', content:
        `Question: ${a.question}\nModel answer: ${a.modelAnswer}\n` +
        `Student answer: ${msg.content.slice(0, 1200)}\nHints: fast_paste=${fastPaste}` },
    ]);
  } catch (err) {
    console.error('[questions] eval failed:', err.message);
    return;
  }

  let score = Math.max(0, Math.min(10, Number(r.score) || 0));
  const cheat = !!r.cheating_suspected || fastPaste;
  let bonus = false;

  if (cheat && r.correct) {
    score = Math.ceil(score * 0.3);
  } else if (r.correct && !a.firstCorrectDone) {
    a.firstCorrectDone = true; bonus = true; score += 2;
  }
  a.results.push({ name: student.name, score, bonus });

  post(cohort, {
    action: 'logScore', email: student.email, name: student.name,
    category: a.category, qid: a.qid, score, cheat, messageId: a.msgId,
  }).catch(e => console.error('[questions] logScore failed:', e.message));

  if (cheat && r.correct) {
    await msg.reply({
      content: `⚠️ ${msg.author} Your answer is **correct** — but it looks copy-pasted or AI-generated. No cheating! Type it yourself and practice honestly — interviews have no copy-paste. **${score}/10** (reduced).`,
      allowedMentions: { users: [msg.author.id] },
    });
  } else if (r.correct && score >= 8) {
    const payload = {
      content: `${PRAISES[rand(0, PRAISES.length - 1)]} ${msg.author}`,
      embeds: [{
        title: '🏆 OUTSTANDING ANSWER',
        description: `**${student.name}** nailed it${bonus ? ' — and was **first**! ⚡ +2 bonus' : ''}\n\n**Score: ${score}/10**\n_${clip(r.feedback, 300)}_`,
        color: 0xf1c40f,
        footer: { text: 'Honest typed answers build real interview power. Keep going! ✨' },
      }],
      allowedMentions: { users: [msg.author.id] },
    };
    if (cohort.honorStickerId) payload.stickers = [cohort.honorStickerId];
    await msg.reply(payload).catch(async () => {
      delete payload.stickers;
      await msg.reply(payload);
    });
  } else if (r.correct) {
    await msg.reply({
      content: `✅ Correct, ${msg.author}! **${score}/10**${bonus ? ' ⚡ first-correct +2!' : ''} — ${clip(r.feedback, 200)}`,
      allowedMentions: { users: [msg.author.id] },
    });
  } else {
    await msg.reply({
      content: `📝 Not quite, ${msg.author} — **${score}/10**. ${clip(r.feedback, 250)} Full breakdown when the timer ends — read it and grab the next one! 💪`,
      allowedMentions: { users: [msg.author.id] },
    });
  }
}

// ============================================================
//  LEADERBOARD + WEEKLY REPORT (posted in workshop channel)
// ============================================================
async function postLeaderboard(client, cohort, days) {
  try {
    const data = await api(cohort, { action: 'scores', days });
    const channel = await client.channels.fetch(await resolveChannel(cohort, 'channel_reports', cohort.channels.workshop));
    const students = (data.students || []).slice(0, 10);
    if (!students.length) {
      await channel.send(`📊 No scores in the last ${days} days — answer the next question drop to get on the board!`);
      return;
    }
    const medals = ['🥇', '🥈', '🥉'];
    const lines = students.map((s, i) =>
      `${medals[i] || `**${i + 1}.**`} **${s.name}** — ${s.total} pts (${s.answers} answers${s.cheats ? `, ⚠️${s.cheats}` : ''})`);
    await channel.send({
      content: '@everyone',
      allowedMentions: { parse: ['everyone'] },
      embeds: [{
        title: `🏆 Leaderboard — last ${days} days`,
        description: lines.join('\n'),
        color: 0xf1c40f,
        footer: { text: 'Points come from question drops. Honest answers only - cheats score 30%.' },
      }],
    });
  } catch (err) { console.error('[questions] leaderboard failed:', err.message); }
}

async function questionPanel(cohort) {
  const [schedule, enabled] = await Promise.all([questionSchedule(cohort), isOn(cohort, 'questions')]);
  const channelId = await questionChannelId(cohort, schedule.channel);
  const effectiveGap = Math.max(schedule.gapMin, schedule.windowMin + 2);
  return {
    embeds: [{
      title: `❓ ${cohort.name} — Question Schedule`,
      color: enabled ? 0x2ecc71 : 0xe74c3c,
      description: [
        `Automation: **${enabled ? 'ON' : 'OFF'}**`,
        `Morning: **${schedule.periods.morning.time} · ${schedule.periods.morning.count} questions**`,
        `Afternoon: **${schedule.periods.afternoon.time} · ${schedule.periods.afternoon.count} questions**`,
        `Evening: **${schedule.periods.evening.time} · ${schedule.periods.evening.count} questions**`,
        `Answer window: **${schedule.windowMin} minutes**`,
        `Gap: **${effectiveGap} minutes**${effectiveGap !== schedule.gapMin ? ' (raised automatically so questions do not overlap)' : ''}`,
        `Channel: ${channelId ? `<#${channelId}>` : '**not configured**'}`,
      ].join('\n'),
      footer: { text: 'Edit Schedule saves immediately. Replan Today replaces only remaining timers.' },
    }],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('qctl:toggle').setLabel(enabled ? 'Turn Questions Off' : 'Turn Questions On')
        .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('qctl:edit').setLabel('Edit Schedule').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('qctl:replan').setLabel('Replan Today').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('qctl:drop').setLabel('Drop One Now').setStyle(ButtonStyle.Secondary),
    ), new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId('qctl:channel')
        .setPlaceholder('Choose the question channel')
        .setChannelTypes(ChannelType.GuildText)
        .setMinValues(1)
        .setMaxValues(1),
    )],
    allowedMentions: { parse: [] },
  };
}

function questionScheduleModal(schedule) {
  return new ModalBuilder().setCustomId('qctl:schedule').setTitle('Question schedule').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('morning').setLabel('Morning: HH:MM, count').setStyle(TextInputStyle.Short)
      .setValue(`${schedule.periods.morning.time},${schedule.periods.morning.count}`).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('afternoon').setLabel('Afternoon: HH:MM, count').setStyle(TextInputStyle.Short)
      .setValue(`${schedule.periods.afternoon.time},${schedule.periods.afternoon.count}`).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('evening').setLabel('Evening: HH:MM, count').setStyle(TextInputStyle.Short)
      .setValue(`${schedule.periods.evening.time},${schedule.periods.evening.count}`).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('window').setLabel('Answer window in minutes (1-120)').setStyle(TextInputStyle.Short)
      .setValue(String(schedule.windowMin)).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('gap').setLabel('Minutes between questions (1-180)').setStyle(TextInputStyle.Short)
      .setPlaceholder('10')
      .setValue(String(schedule.gapMin)).setRequired(true)),
  );
}

async function saveQuestionSchedule(cohort, interaction) {
  const periods = {
    morning: parsePeriodValue(interaction.fields.getTextInputValue('morning')),
    afternoon: parsePeriodValue(interaction.fields.getTextInputValue('afternoon')),
    evening: parsePeriodValue(interaction.fields.getTextInputValue('evening')),
  };
  if (Object.values(periods).some(value => !value)) {
    throw new Error('Each period must use `HH:MM,count`, with 0–10 questions.');
  }
  const windowMin = Number(interaction.fields.getTextInputValue('window'));
  if (!Number.isInteger(windowMin) || windowMin < 1 || windowMin > 120) {
    throw new Error('Answer window must be a whole number from 1 to 120.');
  }
  const gap = parseGapMinutes(interaction.fields.getTextInputValue('gap'));
  if (!gap) throw new Error('Question gap must be a whole number from 1 to 180.');
  // Validate overlap/midnight before writing any partial configuration.
  buildPeriodPlan(periods, windowMin, gap);
  const updates = [
    ['qmorningtime', periods.morning.time], ['qmorningcount', periods.morning.count],
    ['qafternoontime', periods.afternoon.time], ['qafternooncount', periods.afternoon.count],
    ['qeveningtime', periods.evening.time], ['qeveningcount', periods.evening.count],
    ['qwindow', windowMin], ['qperiodgap', gap],
  ];
  for (const [key, value] of updates) await setSetting(cohort, key, value);
}

// ============================================================
//  REGISTER
// ============================================================
module.exports = function registerQuestions(client) {
  for (const cohort of cohorts) {
    planToday(client, cohort);
    scheduleAtSetting(cohort, 'questionplan', 'questionplantime', () => planToday(client, cohort));
    scheduleAtSetting(cohort, 'leaderboard', 'leaderboardtime', async () => {
      if (!(await isOn(cohort, 'leaderboard')) || !(await isScheduledToday(cohort, 'leaderboard'))) return;
      const interval = await getNumber(cohort, 'leaderboardinterval');
      if (interval > 1 && (localClock(cohort.timezone).dayOfMonth - 1) % interval !== 0) return;
      await postLeaderboard(client, cohort, interval);
    });
    console.log(`[questions] ${cohort.name}: runtime-configurable scheduling active`);
  }

  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort) return;

    const content = msg.content.trim();
    const lower = content.toLowerCase();

    if (lower === '!questions' || lower.startsWith('!questions ')) {
      if (!cohort.supervisorIds.includes(msg.author.id)) return;
      if (msg.channelId !== cohort.channels.supervisor) {
        await msg.reply({ content: `Run this control in <#${cohort.channels.supervisor}>.`, allowedMentions: { parse: [] } });
        return;
      }
      const parts = content.split(/\s+/);
      const subcommand = (parts[1] || '').toLowerCase();
      if (subcommand === 'channel') {
        const raw = parts[2] || '';
        if (raw.toLowerCase() === 'reset') {
          await setSetting(cohort, 'channel_questions', '');
        } else {
          const channelId = raw.replace(/[<#>]/g, '');
          const channel = await msg.guild.channels.fetch(channelId).catch(() => null);
          if (!channel?.isTextBased?.() || channel.guildId !== cohort.guildId) {
            return msg.reply('Usage: `!questions channel #channel` or `!questions channel reset`.');
          }
          await setSetting(cohort, 'channel_questions', channel.id);
        }
        await planToday(client, cohort);
        await msg.reply('✅ Question destination saved and today’s remaining timers were rebuilt.');
      } else if (['amount', 'amounts'].includes(subcommand)) {
        const counts = parts.slice(2).map(Number);
        if (counts.length !== 3 || counts.some(value => !Number.isInteger(value) || value < 0 || value > 10)) {
          return msg.reply('Usage: `!questions amounts <morning 0-10> <afternoon 0-10> <evening 0-10>`.');
        }
        for (const [key, value] of [
          ['qmorningcount', counts[0]],
          ['qafternooncount', counts[1]],
          ['qeveningcount', counts[2]],
        ]) await setSetting(cohort, key, value);
        await planToday(client, cohort);
        await msg.reply(`✅ Question amounts saved: morning **${counts[0]}**, afternoon **${counts[1]}**, evening **${counts[2]}**.`);
      } else if (subcommand) {
        return msg.reply('Use `!questions`, `!questions channel #channel`, or `!questions amounts <morning> <afternoon> <evening>`.');
      }
      await msg.channel.send(await questionPanel(cohort));
      return;
    }

    // ---------- supervisor commands ----------
    if (lower.startsWith('!genquestions') || lower.startsWith('!dropquestion') ||
        lower === '!replanquestions' ||
        lower === '!leaderboard' || lower === '!cleanbank') {
      if (!cohort.supervisorIds.includes(msg.author.id)) return;

      if (lower.startsWith('!genquestions')) {
        const [, category = 'communication', countRaw = '10'] = content.split(/\s+/);
        const count = Math.min(20, parseInt(countRaw, 10) || 10);
        await msg.reply(`🧪 Generating ${count} ${category} questions with AI...`);
        try {
          const added = await generateQuestions(cohort, category, count);
          await msg.reply(`✅ Added **${added}** ${category} questions to Question_Bank. Review/edit them in the Sheet anytime.`);
        } catch (err) { await msg.reply('❌ ' + err.message); }
        return;
      }

      if (lower === '!replanquestions') {
        await planToday(client, cohort);
        await msg.reply('✅ Replaced today’s remaining question timers using the latest amounts and time window.');
        return;
      }

      if (lower.startsWith('!dropquestion')) {
        // !dropquestion [category] [workshop|discussion]  (default: workshop)
        const parts = content.split(/\s+/);
        const cat = (parts[1] || COMM).toLowerCase();
        const place = (parts[2] || 'workshop').toLowerCase();
        const inDiscussion = place === 'discussion';
        const channelId = inDiscussion ? cohort.channels.discussion : cohort.channels.workshop;
        const windowMin = await getNumber(cohort, 'qwindow');
        await msg.reply(`🚀 Dropping a ${cat} question in <#${channelId}> (${windowMin} min window)...`);
        await dropQuestion(client, cohort, channelId, cat, windowMin, inDiscussion, true);
        return;
      }

      if (lower === '!cleanbank') {
        await msg.reply('🧹 Removing C#/.NET questions from the bank...');
        try {
          const data = await post(cohort, { action: 'cleanBank', keywords: [] });
          await msg.reply(`✅ Removed **${data.removed}** questions containing C#, ASP.NET, .NET, or dotnet.`);
        } catch (err) { await msg.reply('❌ ' + err.message); }
        return;
      }

      if (lower === '!leaderboard') return postLeaderboard(client, cohort, 2);
    }

    // ---------- student answers ----------
    if (content.startsWith('!') || content.length < 3) return;
    const key = `${cohort.guildId}:${msg.channelId}`;
    const a = active[key];
    if (!a || Date.now() > a.deadline) return;
    // in the discussion channel, only Replies to the question count -
    // normal chat must never get scored
    if (a.requireReply && (!msg.reference || msg.reference.messageId !== a.msgId)) return;
    if (a.answered.has(msg.author.id)) return;

    const roster = await getRoster(cohort);
    const student = roster.find(r => r.discordId === msg.author.id);
    if (!student || isExcluded(cohort, student)) return;

    await evaluateAnswer(client, cohort, msg, a, student);
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.customId?.startsWith('qctl:')) return;
    const cohort = cohorts.find(candidate => candidate.guildId === interaction.guildId);
    if (!cohort || !cohort.supervisorIds.includes(interaction.user.id) ||
        interaction.channelId !== cohort.channels.supervisor) {
      await interaction.reply({ content: 'Question controls are private to configured supervisors in #bot-admin.', ephemeral: true }).catch(() => {});
      return;
    }
    const action = interaction.customId.split(':')[1];
    try {
      if (interaction.isButton() && action === 'open') {
        await interaction.reply({ ...(await questionPanel(cohort)), ephemeral: true });
        return;
      }
      if (interaction.isButton() && action === 'edit') {
        await interaction.showModal(questionScheduleModal(await questionSchedule(cohort)));
        return;
      }
      if (interaction.isButton() && action === 'toggle') {
        await interaction.deferUpdate();
        await setOn(cohort, 'questions', !(await isOn(cohort, 'questions')));
        planVersion[cohort.guildId] = (planVersion[cohort.guildId] || 0) + 1;
        await interaction.message.edit(await questionPanel(cohort));
        return;
      }
      if (interaction.isButton() && action === 'replan') {
        await interaction.deferReply({ ephemeral: true });
        await planToday(client, cohort);
        await interaction.editReply('✅ Remaining question timers were rebuilt from the current schedule.');
        return;
      }
      if (interaction.isButton() && action === 'drop') {
        await interaction.deferReply({ ephemeral: true });
        const schedule = await questionSchedule(cohort);
        const channelId = await questionChannelId(cohort, schedule.channel);
        if (!channelId) throw new Error(`${schedule.channel} channel is not configured.`);
        await dropQuestion(client, cohort, channelId, 'technical', schedule.windowMin, true, true);
        await interaction.editReply(`✅ Dropped one question with a **${schedule.windowMin}-minute** window.`);
        return;
      }
      if (interaction.isChannelSelectMenu() && action === 'channel') {
        await interaction.deferReply({ ephemeral: true });
        const channelId = interaction.values[0];
        const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased?.()) throw new Error('Choose a text channel in this server.');
        await setSetting(cohort, 'channel_questions', channel.id);
        await planToday(client, cohort);
        await interaction.editReply(`✅ Questions will now be sent in <#${channel.id}>. Remaining timers were rebuilt.`);
        return;
      }
      if (interaction.isModalSubmit() && action === 'schedule') {
        await interaction.deferReply({ ephemeral: true });
        await saveQuestionSchedule(cohort, interaction);
        await planToday(client, cohort);
        await interaction.editReply('✅ Question schedule saved and today’s remaining timers were rebuilt. Run `!questions` to see the updated panel.');
      }
    } catch (error) {
      const payload = { content: `❌ Question control failed: ${String(error.message).slice(0, 300)}`, ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.editReply(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  });
};

module.exports.planToday = planToday;
module.exports.questionPanel = questionPanel;
module.exports.questionSchedule = questionSchedule;
