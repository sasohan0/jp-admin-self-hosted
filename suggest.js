// ============================================================
//  suggest.js - AI activity suggestions with approval flow
//  !suggest -> bot analyzes recent stats -> proposes an activity
//  in #bot-admin -> supervisor reacts ✅ within 24h -> posted to
//  #discussion (@everyone). Auto daily at 9 PM if the
//  'suggestions' automation is switched on.
// ============================================================
const { cohorts } = require('./config');
const { askJson } = require('./groq');
const { isOn } = require('./automations');
const { report } = require('./reporter');
const { getNumber } = require('./settings');
const { isScheduledToday } = require('./scheduler');
const { scheduleAtSetting } = require('./runtime-schedule');

const pending = new Map(); // botMsgId -> { cohort, text, expires }

async function api(cohort, params) {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const res = await fetch(`${cohort.appsScriptUrl}?key=${encodeURIComponent(cohort.apiKey)}&${qs}`, { redirect: 'follow' });
  return res.json();
}

module.exports = function registerSuggest(client) {
  for (const cohort of cohorts) {
    scheduleAtSetting(cohort, 'suggestions', 'suggestiontime', async () => {
      if (await isOn(cohort, 'suggestions') && await isScheduledToday(cohort, 'suggestions')) {
        await makeSuggestion(client, cohort);
      }
    });
  }

  client.on('messageCreate', async (msg) => {
    if (msg.author.bot || msg.content.trim().toLowerCase() !== '!suggest') return;
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;
    await makeSuggestion(client, cohort);
  });

  // approval by ✅ reaction from a supervisor
  client.on('messageReactionAdd', async (reaction, user) => {
    try {
      if (reaction.partial) await reaction.fetch();
      const rec = pending.get(reaction.message.id);
      if (!rec || reaction.emoji.name !== '✅') return;
      if (!rec.cohort.supervisorIds.includes(user.id)) return;
      if (Date.now() > rec.expires) { pending.delete(reaction.message.id); return; }
      pending.delete(reaction.message.id);

      const ch = await client.channels.fetch(rec.cohort.channels.discussion);
      await ch.send({
        content: `@everyone\n📋 **Today's task from your mentors:**\n\n${rec.text}`,
        allowedMentions: { parse: ['everyone'] },
      });
      await reaction.message.reply('✅ Approved — posted to the students.');
      report(rec.cohort.name, 'Suggested activity approved & posted');
    } catch (err) { console.error('[suggest] approval failed:', err.message); }
  });
};

async function makeSuggestion(client, cohort) {
  try {
    const jobTarget = await getNumber(cohort, 'jobstarget');
    const [rtbr, outreach] = await Promise.all([
      api(cohort, { action: 'rtbr', days: 7, jobTarget }),
      api(cohort, { action: 'outreachstatus', staleDays: 2 }),
    ]);
    const students = rtbr.students || [];
    const summary = {
      activeStudents: students.length,
      avgQuestions: students.length ? Math.round(students.reduce((a, s) => a + s.questions, 0) / students.length) : 0,
      avgJobPts: students.length ? Math.round(students.reduce((a, s) => a + s.jobPts, 0) / students.length) : 0,
      avgWorkshop: students.length ? Math.round(students.reduce((a, s) => a + s.workshop, 0) / students.length) : 0,
      outreachSilent: (outreach.stale || []).length + (outreach.never || []).length,
    };

    const r = await askJson([
      { role: 'system', content: 'You are a mentor assistant for junior MERN-stack developers in Bangladesh seeking jobs. Given weekly stats, propose ONE concrete, actionable group task for tomorrow that fixes the weakest area (e.g. a mini project sprint, mock interview pairing, LinkedIn outreach challenge, portfolio README polish). Respond ONLY with JSON: {"task":"the task written directly TO the students, 3-6 sentences, motivating, with clear deliverable and deadline","why":"1 sentence for the mentor"}' },
      { role: 'user', content: JSON.stringify(summary) },
    ]);

    const admin = await client.channels.fetch(cohort.channels.supervisor);
    const m = await admin.send({
      embeds: [{
        title: '💡 Suggested activity — react ✅ to post it to students',
        description: `**Task:**\n${r.task}\n\n**Why:** ${r.why}`,
        color: 0x9b59b6,
        footer: { text: 'Approval window: 24 h. Ignore to discard.' },
      }],
    });
    await m.react('✅');
    pending.set(m.id, { cohort, text: r.task, expires: Date.now() + 24 * 3600 * 1000 });
    report(cohort.name, 'Activity suggestion posted for approval');
  } catch (err) { console.error('[suggest] failed:', err.message); }
}
