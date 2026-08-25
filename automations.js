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

    if (!['stop', 'start'].includes(action)) return msg.reply('Usage: `!automation [list|start|stop] <key|all>`');
    const on = action === 'start';
    const targets = target === 'all' ? Object.keys(KEYS) : [target];
    if (!targets.every(t => t in KEYS)) {
      return msg.reply(`❓ Unknown key. Valid: ${Object.keys(KEYS).map(k => `\`${k}\``).join(', ')}, \`all\``);
    }
    for (const t of targets) await setOn(cohort, t, on);
    await msg.reply(`${on ? '🟢 Started' : '🔴 Stopped'}: **${targets.join(', ')}** — live immediately.`);
  });
}

module.exports = { registerAutomations, isAutomationCommand, isOn, setOn, KEYS, PARENTS };
