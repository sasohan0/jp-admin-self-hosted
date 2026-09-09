// ============================================================
//  automations.js - master on/off switch for every automation
//   !automation            - list all with states
//   !automation stop <key|all>
//   !automation start <key|all>
//  Scheduled actions check isOn() before firing; manual
//  commands always work regardless.
// ============================================================
const { cohorts } = require('./config');
const { appsScriptGet, appsScriptPost } = require('./apps-script-api');
const { syncAutomationChannelVisibility } = require('./channel-visibility');

// Commands update this process immediately. A longer refresh interval prevents
// minute-based schedulers from generating hundreds of unnecessary Sheet calls.
const CACHE_MS = 30 * 60 * 1000;

const KEYS = {
  attendance: 'Attendance form reminders',
  outreach: 'Outreach follow-up report',
  jobs: 'Job tracker report',
  questions: 'Daily question drops',
  workshop: 'Session announcements, polls, no-show report',
  specialworkshop: 'Dawn Focus special-workshop approval and announcement',
  reports: 'Master switch for leaderboards and weekly reports',
  leaderboard: 'Question-score leaderboard',
  weeklyreport: 'Weekly performance leaderboard',
  rtbr: 'Weekly Right-To-Be-Referred board',
  resources: 'Daily resource repost',
  dmnudges: 'Personal DM nudges to lagging students',
  suggestions: 'AI activity suggestions in bot-admin',
  activityprompts: 'Morning outreach, interview, and communication prompts',
  outreachprompt: 'Morning outreach template',
  interviewprompt: 'Morning interview-update template',
  communicationprompt: 'Morning communication-practice template',
  escalations: 'Attendance, application, and interview follow-up mentions',
  attendancewarning: 'Consecutive-attendance warning',
  warningreport: 'Weekly private inactive, warning, and attendance report',
  jobemergency: 'Two-workday application emergency',
  interviewfollowup: 'Thursday interview reminder and review',
  contentsync: 'Periodic reusable content backfill',
  discipline: 'Dawn Focus Circle check-ins and permit workflow',
  mailer: 'Post-attendance absence and warning email batches',
};
const PARENTS = {
  outreachprompt: 'activityprompts',
  interviewprompt: 'activityprompts',
  communicationprompt: 'activityprompts',
  attendancewarning: 'escalations',
  warningreport: 'reports',
  jobemergency: 'escalations',
  interviewfollowup: 'escalations',
};

// A newly opened cohort needs identity/roster syncing (always-on handlers),
// attendance, job tracking and durable content reconciliation. Noisy student
// programmes remain held until a mentor intentionally starts them.
const STARTER_ON = Object.freeze(['attendance', 'jobs', 'contentsync']);

const cache = {}; // guildId -> { at, states }

function isAutomationCommand(content) {
  return /^!automation(?:\s|$)/i.test(String(content || '').trim());
}

async function fetchStates(cohort) {
  const hit = cache[cohort.guildId];
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.states;
  try {
    const raw = (await appsScriptGet(cohort, {
      action: 'getstates',
      prefix: `auto_${cohort.guildId}_`,
    }, { label: 'Automation settings' })).states || {};
    const states = {};
    for (const [k, v] of Object.entries(raw)) states[k.replace(`auto_${cohort.guildId}_`, '')] = v;
    cache[cohort.guildId] = { at: Date.now(), states };
    return states;
  } catch { return (hit && hit.states) || {}; }
}

// default ON, except explicitly opt-in features
async function isOn(cohort, key) {
  const states = await fetchStates(cohort);
  if (['leaderboard', 'weeklyreport'].includes(key) && states.reports === '0') return false;
  if (PARENTS[key] && states[PARENTS[key]] === '0') return false;
  if (states[key] !== undefined) return states[key] === '1';
  return !['dmnudges', 'suggestions', 'specialworkshop', 'mailer'].includes(key);
}

async function setOn(cohort, key, on) {
  await appsScriptPost(cohort, {
    action: 'setState',
    k: `auto_${cohort.guildId}_${key}`,
    v: on ? '1' : '0',
  }, { idempotent: true, label: 'Automation setting write' });
  cache[cohort.guildId] = null;
}

function defaultOn(key) {
  return !['dmnudges', 'suggestions', 'specialworkshop', 'mailer'].includes(key);
}

async function resolvedStates(cohort) {
  const raw = await fetchStates(cohort);
  const states = {};
  for (const key of Object.keys(KEYS)) {
    let on = raw[key] === undefined ? defaultOn(key) : raw[key] === '1';
    if (PARENTS[key]) {
      const parent = PARENTS[key];
      const parentOn = raw[parent] === undefined ? defaultOn(parent) : raw[parent] === '1';
      on = on && parentOn;
    }
    states[key] = on;
  }
  return states;
}

async function applyStarterPreset(cohort) {
  const failures = [];
  for (const key of Object.keys(KEYS)) {
    try { await setOn(cohort, key, STARTER_ON.includes(key)); }
    catch (error) { failures.push(`${key}: ${error.message}`); }
  }
  return { states: await resolvedStates(cohort), failures };
}

function registerAutomations(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const content = msg.content.trim();
    if (!isAutomationCommand(content)) return;
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;

    const [, action, target] = content.toLowerCase().split(/\s+/);

    if (!action || action === 'list') {
      const lines = [];
      for (const [key, desc] of Object.entries(KEYS)) {
        lines.push(`${(await isOn(cohort, key)) ? '🟢' : '🔴'} \`${key}\` — ${desc}`);
      }
      return msg.channel.send({
        embeds: [{
          title: '🎛 Automation Switches', color: 0x3498db,
          description: lines.join('\n') + '\n\n`!automation stop <key|all>` · `!automation start <key|all>` — applies immediately.',
        }],
      });
    }


    if (action === 'starter') {
      await msg.reply({
        content: '🧰 Applying the safe new-cohort preset and student channel visibility...',
        allowedMentions: { parse: [] },
      });
      try {
        const preset = await applyStarterPreset(cohort);
        const visibility = await syncAutomationChannelVisibility(client, cohort, preset.states);
        const held = Object.keys(KEYS).filter(key => !preset.states[key]);
        await msg.channel.send({
          content: [
            `✅ Starter preset ready. Active: **${STARTER_ON.join(', ')}**.`,
            `Held: **${held.join(', ')}**.`,
            `Student workflow channels updated: **${visibility.updated.length}**; missing: **${visibility.missing.length}**; failed: **${visibility.failed.length}**.`,
            `Switch write failures: **${preset.failures.length}**.`,
            'Core channels were not hidden. Manual commands and event-safe roster/intake syncing remain available.',
            ...(visibility.failed.length ? [`⚠️ ${visibility.failed.join('; ').slice(0, 500)}`] : []),
            ...(preset.failures.length ? [`⚠️ ${preset.failures.join('; ').slice(0, 500)}`] : []),
          ].join('\n'),
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        await msg.reply({ content: `❌ Starter preset failed safely: ${error.message}`, allowedMentions: { parse: [] } });
      }
      return;
    }

    if (!['stop', 'start'].includes(action)) return msg.reply('Usage: `!automation [list|start|stop] <key|all>`');
    const on = action === 'start';
    const targets = target === 'all' ? Object.keys(KEYS) : [target];
    if (!targets.every(t => t in KEYS)) {
      return msg.reply(`❓ Unknown key. Valid: ${Object.keys(KEYS).map(k => `\`${k}\``).join(', ')}, \`all\``);
    }
    for (const t of targets) await setOn(cohort, t, on);
    const visibility = await syncAutomationChannelVisibility(client, cohort, await resolvedStates(cohort));
    await msg.reply({
      content: `${on ? '🟢 Started' : '🔴 Stopped'}: **${targets.join(', ')}** — live immediately. Student workflow channels updated: **${visibility.updated.length}**${visibility.failed.length ? `; ⚠️ ${visibility.failed.length} failed` : ''}.`,
      allowedMentions: { parse: [] },
    });
  });
}

module.exports = {
  STARTER_ON,
  registerAutomations,
  isAutomationCommand,
  isOn,
  setOn,
  applyStarterPreset,
  resolvedStates,
  KEYS,
  PARENTS,
};
