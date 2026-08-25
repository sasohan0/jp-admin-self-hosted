'use strict';

// Interview announcements are parsed first and stored with a permanent
// Discord-message identity. Groq may enrich the one-time student reply, but it
// never controls whether a structured interview reaches the Sheet.

const { cohorts } = require('./config');
const { getRoster, rosterForBackfill, syncMembers } = require('./roster');
const { askJson } = require('./groq');
const { parseInterviewAnnouncements } = require('./interview-parser');
const { appsScriptPost } = require('./apps-script-api');
const { resolveChannel } = require('./settings');
const { runQuotaTask } = require('./quota-queue');

const messageQueues = new Map();
const completedSignatures = new Map();
const MAX_COMPLETED_SIGNATURES = 2000;

const SYSTEM_PROMPT = `You are an assistant for a job-placement mentorship program for junior MERN-stack developers in Bangladesh.
A message from the program's "interview updates" Discord channel will be given. Students often post STRUCTURED forms like:
"Interview Serial: 1st / Date: July 08 / Time: 5:00 PM / Company: XYZ / Location: Remote" - sometimes MULTIPLE interviews in one message. These ARE interview announcements.

Respond ONLY with a JSON object, no other text:
{
  "is_interview_announcement": true/false,
  "interviews": [{"company": "...", "role": "role or empty string", "date": "stated interview date or empty string", "time": "stated time or empty string", "location": "remote/onsite/address or empty string"}],
  "company": "the first/main company name",
  "role": "role or empty string",
  "company_known": true/false,
  "company_intro": "1-2 sentences about the company. EMPTY STRING if company_known is false - never invent facts",
  "role_intro": "1-2 sentences: what this role does day to day (MERN context if role unknown)",
  "practice_areas": ["4-6 specific topics to practice"],
  "likely_questions": ["3-4 realistic interview questions"],
  "project_tip": "1-2 sentences: which kind of portfolio project to showcase"
}

Rules:
- Congratulations FROM OTHER students, casual chat, or questions => is_interview_announcement=false.
- Interview RESULTS (passed/failed) => false.
- Never invent company facts.
- Keep everything concise and practical for a junior developer.`;

function clip(text) {
  return String(text || '').slice(0, 1024);
}

function dateKey(date, timezone) {
  return date.toLocaleDateString('en-CA', { timeZone: timezone });
}

async function postBackend(cohort, body, tries = 5) {
  return appsScriptPost(cohort, body, {
    attempts: tries,
    idempotent: true,
    label: 'Interview write',
    timeoutMs: 180000,
  });
}

async function notifyAdmin(client, cohort, text) {
  const admin = await client.channels.fetch(cohort.channels.supervisor).catch(() => null);
  if (!admin?.isTextBased()) return;
  await admin.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
}

async function processInterviewMessage(msg) {
  if (!msg || msg.author?.bot) return;
  const cohort = cohorts.find(candidate => candidate.guildId === msg.guildId);
  if (!cohort) return;
  const interviewChannelId = await resolveChannel(
    cohort, 'channel_interview', cohort.channels.interviewUpdates);
  if (msg.channelId !== interviewChannelId) return;
  if (msg.content.startsWith('!') || msg.content.trim().length < 15) return;

  const deterministic = parseInterviewAnnouncements(msg.content);
  let roster = await getRoster(cohort);
  let student = roster.find(entry => entry.discordId === msg.author.id);
  const isSupervisor = cohort.supervisorIds.includes(msg.author.id);
  if (!student && !isSupervisor) {
    await syncMembers(msg.client, cohort);
    roster = await getRoster(cohort, true);
    student = roster.find(entry => entry.discordId === msg.author.id);
  }
  if (!student && !isSupervisor) {
    await notifyAdmin(
      msg.client,
      cohort,
      `❌ **Interview event could not be linked:** ${msg.url || `message ${msg.id}`} · member ID \`${msg.author.id}\`. Run \`!profilecheck\` and retry the message after roster repair.`,
    );
    return;
  }

  let result = null;
  if (!deterministic.length) {
    try {
      result = await askJson([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: msg.content.slice(0, 1500) },
      ]);
    } catch (err) {
      console.error('[interview] AI classification failed; no deterministic event found:', err.message);
    }
  }

  const aiInterviews = result?.is_interview_announcement &&
    Array.isArray(result.interviews) && result.interviews.length
    ? result.interviews
    : [];
  // Parsed structured fields are authoritative. AI may enrich the reply, but
  // it must never expand one parsed interview into hallucinated extra rows.
  const interviews = deterministic.length
    ? deterministic
    : aiInterviews.length
      ? aiInterviews
      : result?.is_interview_announcement
        ? [{ company: result.company || '', role: result.role || '' }]
        : [];
  if (!interviews.length) return;

  // One locked bulk write uses Discord message ID + event index as the durable
  // idempotency key. This also makes genuine message edits update in place.
  let saved = { created: 0, updated: 0, duplicates: 0, messagePreviouslySeen: false };
  if (student) {
    try {
      saved = await postBackend(cohort, {
        action: 'logInterviews',
        guildId: cohort.guildId,
        email: student.email,
        name: student.name,
        date: dateKey(new Date(msg.createdTimestamp || Date.now()), cohort.timezone),
        messageId: msg.id || '',
        messageUrl: msg.url || '',
        interviews: interviews.slice(0, 10).map((interview, eventIndex) => ({
          eventIndex,
          company: interview.company || '',
          role: interview.role || result?.role || '',
          interviewDate: interview.date || '',
          details: [interview.time, interview.location].filter(Boolean).join(' | ') || msg.content.slice(0, 500),
        })),
      });
    } catch (err) {
      console.error('[interview] log failed:', err.message);
      await notifyAdmin(
        msg.client,
        cohort,
        `❌ **Interview event was not saved:** ${msg.url || `message ${msg.id}`} · member ID \`${msg.author.id}\` · ${String(err.message).slice(0, 250)}`,
      );
      return;
    }
  }

  // Embed-only updates, real edits, retries, and restarts must not produce a
  // second reaction/reply. Real edits can update existing rows silently.
  if (!student || !Number(saved.created) || saved.messagePreviouslySeen) return;
  await msg.react('🎉').catch(() => {});

  // The durable write is deliberately completed before optional AI enrichment.
  // A missing/deprecated AI model must never suppress the Sheet record or the
  // student's confirmation.
  if (deterministic.length && !result) {
    try {
      result = await askJson([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: msg.content.slice(0, 1500) },
      ]);
    } catch (err) {
      console.error('[interview] AI prep enrichment unavailable:', err.message);
    }
  }

  const fields = [];
  if (result?.company_known && result.company_intro) {
    fields.push({ name: `🏢 About ${result.company || 'the company'}`, value: clip(result.company_intro) });
  }
  if (result?.role_intro) {
    fields.push({ name: `👨‍💻 The role${result.role ? `: ${result.role}` : ''}`, value: clip(result.role_intro) });
  }
  if (Array.isArray(result?.practice_areas) && result.practice_areas.length) {
    fields.push({ name: '📚 Practice these', value: clip(result.practice_areas.map(area => `• ${area}`).join('\n')) });
  }
  if (Array.isArray(result?.likely_questions) && result.likely_questions.length) {
    fields.push({ name: '❓ Likely questions', value: clip(result.likely_questions.map(question => `• ${question}`).join('\n')) });
  }
  if (result?.project_tip) {
    fields.push({ name: '🛠 Project to showcase', value: clip(result.project_tip) });
  }
  if (!fields.length) {
    await msg.reply({
      content: `✅ Interview update recorded in **Interview_Log** and **Interview Updates** (${Number(saved.created)} event${Number(saved.created) === 1 ? '' : 's'}).`,
      allowedMentions: { parse: [] },
    }).catch(() => {});
    console.log(`[interview] deterministic log saved for ${student.name}`);
    return;
  }

  await msg.reply({
    content: `🎉 Congratulations ${msg.author}! Here's your prep guide:`,
    embeds: [{
      title: `🎯 Interview Prep${result.company ? ` — ${result.company}` : ''}`,
      color: 0x3498db,
      fields,
      footer: {
        text: 'AI-generated guide — verify company details yourself. Ask your mentors for mock interview practice!',
      },
    }],
    allowedMentions: { users: [msg.author.id] },
  });
}

async function fetchInterviewHistory(channel, maxMessages) {
  const messages = [];
  let before = '';
  while (messages.length < maxMessages) {
    const limit = Math.min(100, maxMessages - messages.length);
    const batch = await channel.messages.fetch({ limit, ...(before ? { before } : {}) });
    if (!batch.size) break;
    messages.push(...batch.values());
    before = batch.last().id;
    if (batch.size < limit) break;
  }
  return messages;
}

async function backfillInterviewHistory(client, cohort, options = {}) {
  const maxMessages = Math.min(10000, Math.max(1, Number(options.maxMessages) || 10000));
  const channelId = await resolveChannel(
    cohort, 'channel_interview', cohort.channels.interviewUpdates);
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased()) throw new Error('configured interview-update channel is not readable');

  const rosterState = options.rosterState || await rosterForBackfill(client, cohort);
  const byId = new Map(rosterState.roster.map(student => [student.discordId, student]));
  const messages = await fetchInterviewHistory(channel, maxMessages);
  const entries = [];
  let skippedMembers = 0;
  let unrecognized = 0;
  for (const message of messages) {
    if (message.author?.bot || String(message.content || '').trim().startsWith('!')) continue;
    const student = byId.get(message.author.id);
    if (!student) { skippedMembers++; continue; }
    const interviews = parseInterviewAnnouncements(message.content);
    if (!interviews.length) { unrecognized++; continue; }
    entries.push({
      email: student.email,
      name: student.name,
      date: dateKey(new Date(message.createdTimestamp || Date.now()), cohort.timezone),
      loggedAt: new Date(message.createdTimestamp || Date.now()).toISOString(),
      messageId: message.id,
      messageUrl: message.url || '',
      interviews: interviews.slice(0, 10).map((interview, eventIndex) => ({
        eventIndex,
        company: interview.company || '',
        role: interview.role || '',
        interviewDate: interview.date || '',
        details: [interview.time, interview.location].filter(Boolean).join(' | ') ||
          String(message.content || '').slice(0, 500),
      })),
    });
  }

  entries.sort((a, b) => a.date.localeCompare(b.date) || a.messageId.localeCompare(b.messageId));
  let created = 0;
  let updated = 0;
  let duplicates = 0;
  for (let index = 0; index < entries.length; index += 100) {
    const result = await postBackend(cohort, {
      action: 'backfillInterviews',
      guildId: cohort.guildId,
      entries: entries.slice(index, index + 100),
    });
    created += Number(result.created) || 0;
    updated += Number(result.updated) || 0;
    duplicates += Number(result.duplicates) || 0;
  }
  if (!entries.length) {
    // Rebuild the matrix even when no parseable history was found. This repairs
    // missing count columns from the existing authoritative Interview_Log.
    await postBackend(cohort, { action: 'repairInterviewDuplicates', guildId: cohort.guildId });
  }
  return {
    messages: messages.length,
    recognized: entries.length,
    created,
    updated,
    duplicates,
    skippedMembers,
    unrecognized,
    rosterRefreshed: rosterState.refreshed,
  };
}

function messageSignature(msg) {
  return `${msg.guildId || ''}:${msg.channelId || ''}:${msg.id || ''}:${String(msg.content || '')}`;
}

function rememberSignature(key, signature) {
  completedSignatures.delete(key);
  completedSignatures.set(key, signature);
  if (completedSignatures.size > MAX_COMPLETED_SIGNATURES) {
    completedSignatures.delete(completedSignatures.keys().next().value);
  }
}

function enqueueInterviewMessage(msg) {
  const key = `${msg.guildId || ''}:${msg.id || ''}`;
  const signature = messageSignature(msg);
  const previous = messageQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    if (completedSignatures.get(key) === signature) return;
    await processInterviewMessage(msg);
    rememberSignature(key, signature);
  });
  const tracked = next.finally(() => {
    if (messageQueues.get(key) === tracked) messageQueues.delete(key);
  });
  messageQueues.set(key, tracked);
  return tracked;
}

module.exports = function registerInterview(client) {
  client.on('messageCreate', async msg => {
    const cohort = cohorts.find(candidate => candidate.guildId === msg.guildId);
    const command = msg.content.trim().toLowerCase();
    if (!msg.author.bot && command === '!backfillinterviews' && cohort &&
        cohort.supervisorIds.includes(msg.author.id) && msg.channelId === cohort.channels.supervisor) {
      await msg.reply({ content: '⏳ Reconciling interview-update history into Interview_Log and Interview Updates…', allowedMentions: { parse: [] } });
      try {
        const result = await runQuotaTask(
          `interview-backfill:${cohort.guildId}`,
          () => backfillInterviewHistory(client, cohort),
        );
        await msg.reply({
          content: `✅ Interview backfill complete: **${result.messages}** messages scanned · **${result.recognized}** student updates recognized · **${result.created}** event(s) added · **${result.updated}** repaired · **${result.duplicates}** already present · **${result.unrecognized}** non-interview/unrecognized student messages skipped.`,
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        await msg.reply({ content: `❌ Interview backfill failed: ${String(error.message).slice(0, 300)}`, allowedMentions: { parse: [] } });
      }
      return;
    }
    if (!msg.author.bot && command === '!repairinterviews' && cohort &&
        cohort.supervisorIds.includes(msg.author.id) && msg.channelId === cohort.channels.supervisor) {
      try {
        const result = await postBackend(cohort, {
          action: 'repairInterviewDuplicates', guildId: cohort.guildId,
        });
        await msg.reply({
          content: `✅ Interview Log repaired: **${result.removed || 0}** exact duplicate row(s) removed; **${result.remaining || 0}** event row(s) remain.`,
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        await msg.reply({ content: `❌ Interview repair failed: ${String(error.message).slice(0, 300)}`, allowedMentions: { parse: [] } });
      }
      return;
    }
    enqueueInterviewMessage(msg).catch(async err => {
      console.error('[interview] failed:', err.message);
      if (cohort) {
        await notifyAdmin(
          client,
          cohort,
          `❌ **Interview message processing failed:** ${msg.url || `message ${msg.id}`} · ${String(err.message).slice(0, 250)}`,
        );
      }
    });
  });
  client.on('messageUpdate', async (oldMessage, newMessage) => {
    try {
      if (newMessage.partial) newMessage = await newMessage.fetch();
      // Link-preview/embed resolution also emits messageUpdate. Ignore it when
      // the student-visible text did not change.
      if (!oldMessage.partial && oldMessage.content === newMessage.content) return;
      await enqueueInterviewMessage(newMessage);
    } catch (err) {
      console.error('[interview] edited-message processing failed:', err.message);
      const cohort = cohorts.find(candidate => candidate.guildId === newMessage.guildId);
      if (cohort) {
        await notifyAdmin(
          client,
          cohort,
          `❌ **Edited interview message processing failed:** ${newMessage.url || `message ${newMessage.id}`} · ${String(err.message).slice(0, 250)}`,
        );
      }
    }
  });
};

module.exports.enqueueInterviewMessage = enqueueInterviewMessage;
module.exports.messageSignature = messageSignature;
module.exports.processInterviewMessage = processInterviewMessage;
module.exports.backfillInterviewHistory = backfillInterviewHistory;
