// Pure command-discovery helpers for the conversational !jp assistant.

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'can', 'change', 'command', 'could', 'do', 'find', 'for',
  'does', 'give', 'has', 'help', 'how', 'i', 'in', 'is', 'it', 'me', 'my',
  'need', 'of', 'our', 'please', 'run', 'set', 'show', 'the', 'to', 'use',
  'want', 'what', 'when', 'where', 'which', 'who', 'with',
]);

const TERM_GROUPS = [
  ['job', 'jobs', 'application', 'applications', 'apply', 'applied', 'applying'],
  ['outreach', 'outreaches'],
  ['student', 'students', 'member', 'members', 'roster'],
  ['target', 'targets', 'goal', 'goals', 'quota'],
  ['attendance', 'attend', 'present', 'absent', 'absence'],
  ['profile', 'profiles', 'onboarding', 'identity', 'survey', 'data'],
  ['disable', 'stop', 'off', 'pause'],
  ['enable', 'start', 'on', 'resume'],
  ['schedule', 'time', 'times', 'window', 'clock'],
  ['question', 'questions', 'quiz', 'quizzes'],
  ['dawn', 'morning', 'wakeup', 'wake'],
  ['interview', 'interviews'],
  ['communication', 'communications', 'practice'],
  ['workshop', 'workshops'],
];

const TERM_EXPANSIONS = new Map();
for (const group of TERM_GROUPS) {
  for (const term of group) TERM_EXPANSIONS.set(term, group);
}

const TARGET_METRICS = [
  { metric: 'applications', pattern: /\b(?:job|jobs|application|applications|apply|applying)\b/i },
  { metric: 'outreach', pattern: /\boutreach(?:es)?\b/i },
  { metric: 'attendance', pattern: /\battendance\b/i },
  { metric: 'interviews', pattern: /\binterviews?\b/i },
  { metric: 'communication', pattern: /\bcommunication\b/i },
  { metric: 'workshops', pattern: /\bworkshops?\b/i },
];

const AUTOMATION_KEYS = [
  ['specialworkshop', /\bspecial\s+workshop\b/i],
  ['weeklyreport', /\bweekly\s+(?:report|leaderboard)\b/i],
  ['dmnudges', /\b(?:dm\s*)?nudges?\b/i],
  ['contentsync', /\bcontent\s*sync\b/i],
  ['questions', /\bquestions?\b/i],
  ['workshop', /\bworkshops?\b/i],
  ['attendance', /\battendance\b/i],
  ['outreach', /\boutreach\b/i],
  ['jobs', /\b(?:jobs?|applications?|applying)\b/i],
  ['rtbr', /\b(?:rtbr|referral)\b/i],
  ['resources', /\bresources?\b/i],
  ['reports', /\breports?\b/i],
];

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9@#:_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function meaningfulTerms(query) {
  return normalizeText(query).split(' ').filter(term => term && !STOP_WORDS.has(term));
}

function expandedTerms(term) {
  return TERM_EXPANSIONS.get(term) || [term];
}

function rankNaturalCommands(query, entries, limit = 5) {
  const normalized = normalizeText(query);
  const terms = meaningfulTerms(query);
  if (!terms.length) return [];

  return entries.map(entry => {
    const command = normalizeText(entry.command);
    const description = normalizeText(entry.description);
    const category = normalizeText(`${entry.category} ${entry.section}`);
    let matched = 0;
    let score = 0;
    for (const term of terms) {
      const variants = expandedTerms(term);
      if (variants.some(value => command.includes(value))) {
        matched += 1;
        score += 7;
      } else if (variants.some(value => description.includes(value))) {
        matched += 1;
        score += 4;
      } else if (variants.some(value => category.includes(value))) {
        matched += 1;
        score += 2;
      }
    }
    if (!matched) return null;
    if (command === normalized || command === `jp ${normalized}`) score += 20;
    score += matched / terms.length;
    return { ...entry, score, matched, coverage: matched / terms.length };
  }).filter(Boolean)
    .filter(entry => entry.coverage >= (terms.length >= 3 ? 0.5 : 1))
    .sort((a, b) => b.score - a.score || b.coverage - a.coverage || a.command.localeCompare(b.command))
    .slice(0, limit);
}

function parseClock(hourText, minuteText, suffixText) {
  let hour = Number(hourText);
  const minute = Number(minuteText || 0);
  const suffix = String(suffixText || '').toLowerCase();
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59) return null;
  if (suffix === 'pm' && hour < 12) hour += 12;
  if (suffix === 'am' && hour === 12) hour = 0;
  if (hour > 23 || (suffix && Number(hourText) > 12)) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function extractTimeRange(input) {
  const value = String(input || '').toLowerCase();
  const match = value.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to|until)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b/i);
  if (!match) return null;
  let startSuffix = match[3] || '';
  const endSuffix = match[6] || '';
  if (!startSuffix && endSuffix) startSuffix = endSuffix;
  const start = parseClock(match[1], match[2], startSuffix);
  const end = parseClock(match[4], match[5], endSuffix);
  return start && end && start !== end ? `${start}-${end}` : null;
}

function requestedTargetMetric(request) {
  return TARGET_METRICS.find(item => item.pattern.test(request))?.metric || '';
}

function requestedAmount(request) {
  const numbers = [...String(request || '').matchAll(/\b(\d{1,3})\b/g)].map(match => Number(match[1]));
  return numbers.find(value => Number.isInteger(value) && value >= 0 && value <= 999);
}

function deterministicPlan(request) {
  const text = String(request || '').trim();
  const lower = text.toLowerCase();
  const range = extractTimeRange(text);

  if (/\b(?:show|list|report|count|manage|panel|dashboard)\b/i.test(text) &&
      /\bactive\b/i.test(text) && /\binactive\b/i.test(text) &&
      /\b(?:student|member|status)\b/i.test(text)) {
    return {
      commands: ['!studentstatuspanel'],
      explanation: 'This opens the private active/inactive count dashboard with separate lists and verified status-change buttons.',
    };
  }

  const statusIntent = /\b(?:reactivate|activate|restore|include)\b/i.test(text)
    ? 'active'
    : /\b(?:deactivate|exclude)\b/i.test(text)
      ? 'inactive'
      : /\b(?:make|mark|set|change|turn)\b[\s\S]{0,100}\bactive\b/i.test(text)
        ? 'active'
        : /\b(?:make|mark|set|change|turn)\b[\s\S]{0,100}\binactive\b/i.test(text)
          ? 'inactive'
          : '';
  if (statusIntent && /\b(?:student|member|profile|user|inactive|active)\b/i.test(text)) {
    const mentionMatch = text.match(/<@!?(\d{15,22})>/);
    const rawId = mentionMatch?.[1] || text.match(/\b(\d{15,22})\b/)?.[1] || '';
    if (!rawId) {
      return { question: `What is the Discord ID or @mention of the student you want to mark ${statusIntent}?` };
    }
    return {
      commands: [`!studentstatus ${rawId} ${statusIntent}`],
      explanation: `This changes the student's cohort tracking status. Activation now syncs Discord, clears inactive Sheet markers, resets warnings, and verifies the final roster state before reporting success.`,
    };
  }

  if (/\bdawn\b/.test(lower) && /\b(?:attendance|count|scan|present)\b/.test(lower)) {
    if (!range) {
      return { question: 'What Dawn attendance time range should count? You can reply naturally, for example: `5 AM to 7 AM`.' };
    }
    return {
      commands: [`!dawn attendance ${range}`],
      explanation: 'This changes only the Dawn attendance-counting window. It does not close the channel outside that time.',
    };
  }

  if (/\bdawn\b/.test(lower) && (
    /\b(?:window|time|hours?)\b/.test(lower) ||
    (/\balways\b/.test(lower) && /\b(?:channel|open|send|message)\b/.test(lower))
  )) {
    const sending = /\b(?:send|sending|message|channel|open|close|access)\b/.test(lower);
    if (!sending && !/\battendance\b/.test(lower)) {
      return { question: 'Do you want to change when members can send messages, or when messages count as Dawn attendance?' };
    }
    if (/\balways\b/.test(lower)) {
      return {
        commands: ['!dawn window always'],
        explanation: 'This keeps the Dawn channel open for members at all times; attendance is still counted only in its separate attendance window.',
      };
    }
    if (!range) {
      return { question: 'What Dawn channel sending window do you want? Reply with a range such as `5 AM to 11 PM`, or say `always`.' };
    }
    return {
      commands: [`!dawn window ${range}`],
      explanation: 'This controls when members may send messages. The Dawn attendance-counting window remains separate.',
    };
  }

  if (/\b(?:target|goal|quota)\b/.test(lower)) {
    const metric = requestedTargetMetric(text);
    const amount = requestedAmount(text);
    if (!metric) return { question: 'Which target do you want to change: applications, outreach, attendance, interviews, communication, or workshops?' };
    if (amount === undefined) return { question: `What should the ${metric} target be? Reply with a whole number.` };
    return {
      commands: [`!target ${metric} ${amount}`],
      explanation: `This changes the ${metric} goal only for this cohort.`,
    };
  }

  const stop = /\b(?:disable|stop|turn off|pause)\b/.test(lower);
  const start = /\b(?:enable|start|turn on|resume)\b/.test(lower);
  if (stop || start) {
    const key = AUTOMATION_KEYS.find(([, pattern]) => pattern.test(text))?.[0];
    if (key) {
      return {
        commands: [`!automation ${stop ? 'stop' : 'start'} ${key}`],
        explanation: `This ${stop ? 'pauses' : 'enables'} the ${key} automation for this cohort. Manual mentor commands remain available.`,
      };
    }
  }

  if (/\b(?:incomplete|missing)\b/.test(lower) && /\bonboarding\b/.test(lower) && /\b(?:mention|remind|form|send)\b/.test(lower)) {
    const channel = text.match(/<#(\d+)>/)?.[0];
    return {
      commands: [`!onboardingreminder${channel ? ` ${channel}` : ''}`],
      explanation: channel
        ? 'This mentions only members missing private onboarding in the selected channel.'
        : 'This mentions only members missing private onboarding in the default discussion channel.',
    };
  }

  if (/\b(?:incomplete|missing|not completed)\b/.test(lower) && /\bonboarding\b/.test(lower)) {
    return {
      commands: [/\bprofile\b/.test(lower) ? '!completioncheck' : '!onboardingstatus'],
      explanation: /\bprofile\b/.test(lower)
        ? 'This privately checks both onboarding and required-profile completion.'
        : 'This privately shows onboarding completion without exposing sensitive answers.',
    };
  }

  return null;
}

function buildCommandReference(entries) {
  return entries.map(entry => `${entry.command} — ${entry.description}`).join('\n');
}

function knownCommandRoots(entries) {
  const roots = new Set();
  for (const entry of entries) {
    for (const match of entry.command.matchAll(/![a-z][a-z0-9-]*/gi)) roots.add(match[0].toLowerCase());
  }
  return roots;
}

function supportedSuggestions(commands, entries) {
  const roots = knownCommandRoots(entries);
  return [...new Set((Array.isArray(commands) ? commands : [])
    .map(value => String(value || '').trim())
    .filter(value => /^![a-z]/i.test(value) && roots.has(value.match(/^![a-z][a-z0-9-]*/i)?.[0].toLowerCase())))]
    .slice(0, 3);
}

module.exports = {
  buildCommandReference,
  deterministicPlan,
  extractTimeRange,
  meaningfulTerms,
  rankNaturalCommands,
  supportedSuggestions,
};
