// ============================================================
//  discover.js - channel auto-discovery by NAME
//  For a NEW server, the cohort config only needs guildId +
//  appsScriptUrl + apiKey. At startup this fills in every
//  channel ID by matching standard channel names.
//  Explicit IDs in config always win over discovery.
// ============================================================
const { cohorts } = require('./config');
const { normalizeChannelName: norm } = require('./channel-names');

const NAME_MAP = {
  welcome: ['welcome-to-the-bootcamp', 'welcome-to-bootcamp', 'bootcamp-welcome', 'welcome'],
  rules: ['rules-and-regulations', 'rules-and-regulation', 'rules-regulations', 'server-rules', 'rules'],
  discussion: ['discussion'],
  supervisor: ['bot-admin'],
  hired: ['successfully-hired'],
  outreach: ['outreach-update', 'outreach-updates', 'outreach'],
  interviewUpdates: ['interview-update', 'interview-updates'],
  workshop: ['communication-workshop'],
  jobTracking: ['job-tracking-sheet', 'job-tracking'],
  jobPosts: ['job-posts', 'job-post', 'job-opportunities', 'job-opportunity'],
  rtbr: ['right-to-be-referred'],
  automationLog: ['automation-announcement'],
  resources: ['resources'],
  resumeUpdates: ['updated-resume', 'update-resume', 'resume'],
  projects: ['my-best-projects', 'best-projects'],
  jobHunting: ['job-hunting-channels', 'job-hunting-channel', 'job-hunting'],
  warning: ['warning', 'warnings'],
  emergency: ['emergency'],
  discipline: ['dawn-focus-circle'],
  groupActivities: ['group-activities'],
  issues: ['issues', 'issue', 'leave-requests', 'leave-request'],
  eliminated: ['eliminated-students', 'eliminated-student', 'inactive-students'],
};

async function discoverChannels(client) {
  for (const cohort of cohorts) {
    let guild;
    try { guild = await client.guilds.fetch(cohort.guildId); }
    catch { console.warn(`[discover] ${cohort.name}: guild not reachable`); continue; }
    const channels = await guild.channels.fetch();

    cohort.channels = cohort.channels || {};
    const found = [], missing = [];
    for (const [key, names] of Object.entries(NAME_MAP)) {
      const current = cohort.channels[key];
      if (current && !String(current).startsWith('PASTE')) continue; // explicit ID wins
      const match = channels.find(c => c && typeof c.isTextBased === 'function' && c.isTextBased() && names.includes(norm(c.name)));
      if (match) { cohort.channels[key] = match.id; found.push(`${key}→#${match.name}`); }
      else missing.push(key);
    }
    if (found.length) console.log(`[discover] ${cohort.name}: auto-found ${found.join(', ')}`);
    if (missing.length) console.warn(`[discover] ${cohort.name}: NOT found (create channels or set IDs): ${missing.join(', ')}`);
  }
}

module.exports = { discoverChannels };
