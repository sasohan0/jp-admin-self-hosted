// ============================================================
//  agent.js - private conversational command finder. It uses
//  the authoritative help catalog, asks one focused follow-up
//  when needed, and NEVER executes a proposed command.
// ============================================================
const { cohorts } = require('./config');
const { askJson } = require('./groq');
const { catalogEntries } = require('./help');
const {
  buildCommandReference,
  deterministicPlan,
  rankNaturalCommands,
  supportedSuggestions,
} = require('./agent-intent');

const pendingQuestions = new Map();
const PENDING_TTL_MS = 5 * 60 * 1000;
const MAX_FOLLOW_UPS = 2;

function sessionKey(msg) {
  return `${msg.guildId}:${msg.channelId}:${msg.author.id}`;
}

function activeSession(key) {
  const session = pendingQuestions.get(key);
  if (!session) return null;
  if (Date.now() - session.createdAt > PENDING_TTL_MS) {
    pendingQuestions.delete(key);
    return null;
  }
  return session;
}

function pruneExpiredSessions(now = Date.now()) {
  for (const [key, session] of pendingQuestions) {
    if (now - session.createdAt > PENDING_TTL_MS) pendingQuestions.delete(key);
  }
}

function commandPayload(commands, explanation, source = 'JP Command Guide') {
  const blocks = commands.length
    ? commands.map(command => `\`\`\`text\n${command}\n\`\`\``).join('\n')
    : '_No exact command was found._';
  return {
    embeds: [{
      title: `🤖 ${source}`,
      color: commands.length ? 0x2ecc71 : 0xe67e22,
      description: `${blocks}\n${explanation || ''}`.slice(0, 4096),
      footer: { text: 'Suggestion only — review, then copy and send the command you want.' },
    }],
    allowedMentions: { parse: [], repliedUser: false },
  };
}

async function askFollowUp(msg, key, baseRequest, question, turns = 1) {
  const sent = await msg.reply({
    embeds: [{
      title: 'One detail needed',
      color: 0x5865f2,
      description: `${question}\n\nReply directly to this message in plain English. Type \`cancel\` to stop.`,
      footer: { text: 'I will suggest the command after your answer; I will not run it.' },
    }],
    allowedMentions: { parse: [], repliedUser: false },
  });
  pendingQuestions.set(key, {
    baseRequest,
    promptMessageId: sent.id,
    createdAt: Date.now(),
    turns,
  });
}

function fallbackPayload(request, entries, error) {
  const matches = rankNaturalCommands(request, entries, 3);
  if (matches.length) {
    return commandPayload(
      matches.map(item => item.command),
      'These are the closest commands from the verified Command Center catalog. Fill in any values shown inside angle brackets.',
      'Closest verified commands',
    );
  }
  return commandPayload([], `I could not map that request${error ? ` (${error})` : ''}. Try \`!help <keyword>\` or \`!help\` to open Command Center.`);
}

module.exports = function registerAgent(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const content = msg.content.trim();
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;

    pruneExpiredSessions();
    const key = sessionKey(msg);
    const session = activeSession(key);
    const jpMatch = content.match(/^!jp(?:\s+([\s\S]*))?$/i);
    const isPromptReply = Boolean(
      session &&
      msg.reference?.messageId === session.promptMessageId &&
      !content.startsWith('!'),
    );
    if (!jpMatch && !isPromptReply) return;
    if (msg.channelId !== cohort.channels.supervisor) {
      await msg.reply({ content: `Use \`!jp\` privately in <#${cohort.channels.supervisor}>.`, allowedMentions: { parse: [], repliedUser: false } });
      return;
    }

    const supplied = String(isPromptReply ? content : (jpMatch?.[1] || '')).trim();
    if (/^(?:cancel|never mind|nevermind)$/i.test(supplied)) {
      pendingQuestions.delete(key);
      await msg.reply({ content: 'Cancelled. Ask another question whenever you need.', allowedMentions: { parse: [], repliedUser: false } });
      return;
    }

    if (!supplied) {
      await askFollowUp(
        msg,
        key,
        '',
        'What do you want to do? For example: “set the job target to 10”, “find students missing onboarding”, or “change Dawn attendance time”.',
      );
      return;
    }

    const request = isPromptReply
      ? `${session.baseRequest}${session.baseRequest ? '. ' : ''}Answer: ${supplied}`
      : supplied;
    pendingQuestions.delete(key);
    const entries = catalogEntries();
    const deterministic = deterministicPlan(request);
    if (deterministic?.question) {
      const turns = Number(session?.turns || 0);
      if (turns >= MAX_FOLLOW_UPS) {
        await msg.reply(fallbackPayload(request, entries, 'I still do not have enough exact information after two answers'));
        return;
      }
      await askFollowUp(msg, key, request, deterministic.question, turns + 1);
      return;
    }
    if (deterministic?.commands?.length) {
      await msg.reply(commandPayload(deterministic.commands, deterministic.explanation));
      return;
    }

    try {
      const ranked = rankNaturalCommands(request, entries, 12);
      const referenceEntries = ranked.length ? ranked : entries;
      const result = await askJson([
        {
          role: 'system',
          content:
            `You are JP ADMIN's private command finder. Map the mentor's plain-language request to the smallest set of exact commands from the catalog below. ` +
            `Never execute anything. Never invent a command, subcommand, setting key, channel, date, member, or value. Ask exactly one short natural follow-up if a required detail is missing or the intent is ambiguous. ` +
            `Respond ONLY with JSON: {"commands":["!exact command", ...], "explanation":"1-2 short plain-English sentences", "needs_input":"one direct question, or empty"}. ` +
            `When needs_input is non-empty, commands may contain a catalog template but must not pretend missing values are known. Return at most three commands.\n\nVERIFIED CATALOG:\n${buildCommandReference(referenceEntries)}`,
        },
        { role: 'user', content: request },
      ]);

      const commands = supportedSuggestions(result.commands, entries);
      if (String(result.needs_input || '').trim()) {
        const turns = Number(session?.turns || 0);
        if (turns >= MAX_FOLLOW_UPS) {
          await msg.reply(fallbackPayload(request, entries, 'I still do not have enough exact information after two answers'));
          return;
        }
        await askFollowUp(msg, key, request, String(result.needs_input).trim().slice(0, 500), turns + 1);
        return;
      }
      if (!commands.length) {
        await msg.reply(fallbackPayload(request, entries));
        return;
      }
      await msg.reply(commandPayload(commands, result.explanation));
    } catch (error) {
      const note = error.message.includes('GROQ') ? 'AI is unavailable; check !groqstatus' : 'AI lookup failed';
      await msg.reply(fallbackPayload(request, entries, note));
    }
  });
};

module.exports.commandPayload = commandPayload;
module.exports.fallbackPayload = fallbackPayload;
