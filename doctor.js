// ============================================================
//  doctor.js - !doctor [check] : full system self-diagnosis
//  Checks, one by one, with real calls (not assumptions):
//   sheet   - Apps Script GET reachable, version, all tabs exist
//   post    - Apps Script POST write path works (state ping)
//   form    - active attendance form reachable, open/closed
//   groq    - AI reachable, quota remaining, key rotation
//   perms   - bot permissions in every configured channel
//   onboarding - welcome/rules channels, rules link, panel, roles permission
//   roster  - Bot_Map loads, counts mapped IDs / missing IDs
//   switches- automation states + warm-up status
//   student - one student tracker readable (job sheet sync test)
//  !doctor        -> run everything
//  !doctor groq   -> run one check
// ============================================================
const { cohorts } = require('./config');
const { getStatus } = require('./groq');
const { getRoster } = require('./roster');
const { isOn, KEYS } = require('./automations');
const { getSetupDate } = require('./state');
const { getIntakeSettings, portalBaseUrl, portalConfigProblems, validateIntakeBackend } = require('./intake-settings');
const { appsScriptGet, appsScriptPost } = require('./apps-script-api');

const EXPECTED_VERSION = 'v55';
const REQUIRED_PERMS = ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory'];

function formatRosterDoctor(roster, review) {
  const loaded = Array.isArray(roster) ? roster : [];
  const noId = loaded.filter(s => !s.discordId && s.status !== 'hired' && s.status !== 'left').length;
  const total = Number(review?.total || 0);
  const verified = Number(review?.verified || loaded.length);
  const pending = Number(review?.needsVerification || 0);
  const incomplete = Number(review?.incompleteProfiles || 0);
  if (total) {
    return `${verified} verified active students; ${total} current Discord students captured in Roster Review` +
      (incomplete ? `; ⚠️ ${incomplete} need private profile data` : '; profiles complete') +
      (pending ? `; ${pending} provisional/incomplete identities` : '') +
      (noId ? `; ⚠️ ${noId} active rows without Discord ID` : '');
  }
  return `${loaded.length} students loaded` +
    (noId ? `, ⚠️ ${noId} without Discord ID (run !syncmembers / !audit)` : ', all mapped') +
    '; Roster Review has not been populated yet';
}

async function apiRaw(cohort, params) {
  return appsScriptGet(cohort, params, { label: 'Doctor backend check' });
}
async function postRaw(cohort, body) {
  return appsScriptPost(cohort, body, {
    idempotent: body?.action === 'setState',
    label: 'Doctor backend write',
  });
}

const CHECKS = {
  async sheet(cohort) {
    const h = await apiRaw(cohort, { action: 'health' });
    if (h.error) throw new Error(h.error);
    const missing = Object.entries(h.tabs || {}).filter(([, ok]) => !ok).map(([t]) => t);
    const verNote = h.version === EXPECTED_VERSION ? `version ${h.version}` : `⚠️ version ${h.version || 'old'} (expected ${EXPECTED_VERSION} — redeploy New version!)`;
    if (missing.length) return `reachable, ${verNote}; missing tabs: ${missing.join(', ')} (created on first use)`;
    return `reachable, ${verNote}, all ${Object.keys(h.tabs).length} tabs present`;
  },
  async post(cohort) {
    const r = await postRaw(cohort, { action: 'setState', k: `doctor_${Date.now() % 1000}`, v: 'ok' });
    if (r.error) throw new Error(r.error);
    return 'write path OK';
  },
  async form(cohort) {
    const s = await apiRaw(cohort, { action: 'formstatus' });
    if (s.error) throw new Error(s.error);
    return `"${s.title}" — ${s.accepting ? 'OPEN 🟢' : 'CLOSED 🔴'}`;
  },
  async groq() {
    const s = await getStatus();
    if (!s.keysConfigured) throw new Error('no GROQ_API_KEY(S) set');
    if (!s.remainingRequests) throw new Error('no response from Groq — key invalid?');
    return `${s.keysConfigured} key(s), ${s.remainingRequests}/${s.limitRequests} requests left today`;
  },
  async perms(cohort, client, guild) {
    const me = guild.members.me;
    const bad = [];
    for (const permission of ['ManageRoles', 'ManageChannels', 'ManageMessages']) {
      if (!me.permissions.has(permission)) bad.push(`server: missing ${permission}`);
    }
    for (const [label, id] of Object.entries(cohort.channels)) {
      if (!id || String(id).startsWith('PASTE')) continue;
      let ch;
      try { ch = await guild.channels.fetch(id); }
      catch { bad.push(`${label}: unreachable`); continue; }
      const missing = REQUIRED_PERMS.filter(p => !ch.permissionsFor(me).has(p));
      if (missing.length) bad.push(`${label}: missing ${missing.join(',')}`);
    }
    if (bad.length) throw new Error(bad.join(' | ').slice(0, 300));
    return `all ${Object.keys(cohort.channels).length} channels OK` + (me.permissions.has('Administrator') ? ' (Administrator ✓)' : '');
  },
  async onboarding(cohort, client, guild) {
    if (!cohort.channels.welcome || !cohort.channels.rules || !cohort.channels.supervisor) {
      throw new Error('welcome, rules, or bot-admin channel is missing (run !setupserver)');
    }
    const [welcome, rules, rulesState, panelState] = await Promise.all([
      guild.channels.fetch(cohort.channels.welcome),
      guild.channels.fetch(cohort.channels.rules),
      apiRaw(cohort, { action: 'getstate', k: `ob_${cohort.guildId}_rules_message` }),
      apiRaw(cohort, { action: 'getstate', k: `ob_${cohort.guildId}_panel_message` }),
    ]);
    if (!welcome || !rules) throw new Error('welcome or rules channel is unreachable');
    if (!guild.members.me.permissions.has('ManageRoles')) throw new Error('Manage Roles is missing');
    return `#${welcome.name} + #${rules.name} reachable; rules ${rulesState.value ? 'linked' : 'not linked'}; panel ${panelState.value ? 'ready' : 'not created'}`;
  },
  async roster(cohort) {
    const [roster, review] = await Promise.all([
      getRoster(cohort, true),
      apiRaw(cohort, { action: 'rosterreview' }),
    ]);
    if (review.error) throw new Error(review.error);
    return formatRosterDoctor(roster, review);
  },
  async schedules(cohort) {
    const { DEFAULT_DAYS, SCHEDULE_KEYS, formatDays, getScheduleRaw, isScheduledToday } = require('./scheduler');
    const { formatDays: formatCalendarDays, getCalendarDay, loadWorkCalendar } = require('./work-calendar');
    const today = new Date().toLocaleString('en-US', { weekday: 'short', timeZone: cohort.timezone });
    const [calendar, calendarToday] = await Promise.all([loadWorkCalendar(cohort), getCalendarDay(cohort)]);
    const lines = [`calendar: ${formatCalendarDays(calendar.workdays)} — today ${calendarToday.working ? '✅ working' : '🏖️ holiday'} (${calendarToday.source})`];
    for (const k of SCHEDULE_KEYS) {
      const raw = await getScheduleRaw(cohort, k);
      const scheduled = await isScheduledToday(cohort, k);
      if (raw || DEFAULT_DAYS[k]) {
        const shown = raw || JSON.stringify(DEFAULT_DAYS[k]);
        lines.push(`\`${k}\`: ${formatDays(shown)} — ${scheduled ? '✅ runs today' : '⏸ skipped today'}`);
      }
    }
    return lines.length ? lines.join(' | ') : `every day (no custom schedules set). Today: ${today}`;
  },

  async customizations(cohort) {
    const { getSetting } = require('./settings');
    const checks = [
      ['jobstarget', 'Job target'],
      ['outreachdaily', 'Outreach daily'],
      ['weeklyattendance', 'Attendance/week'],
      ['weeklyinterviews', 'Interviews/week'],
      ['weeklycommunication', 'Communication/week'],
      ['weeklyworkshops', 'Workshops/week'],
      ['workshoptech', 'Workshop tech/day'],
      ['workshopcomm', 'Workshop communication/day'],
      ['discussiontech', 'Discussion questions/day'],
      ['jobschecktime', 'Jobs report time'],
      ['outreachtime', 'Outreach report time'],
      ['rtbrdays', 'RTBR counting days'],
      ['slots', 'Workshop slots'],
      ['channel_jobs', 'Jobs channel override'],
      ['channel_attendance', 'Attendance channel override'],
    ];
    const customs = [];
    for (const [k, label] of checks) {
      const v = await getSetting(cohort, k);
      customs.push(`${label}: **${v || '(default)'}**`);
    }
    return customs.join(' | ');
  },

  async switches(cohort) {
    const states = [];
    for (const k of Object.keys(KEYS)) states.push(`${(await isOn(cohort, k)) ? '🟢' : '🔴'}${k}`);
    const setup = await getSetupDate(cohort);
    return states.join(' ') + (setup ? ` | setup: ${setup}` : '');
  },
  async student(cohort) {
    const data = await apiRaw(cohort, { action: 'jobsheets' });
    const sheets = data.sheets || [];
    if (!sheets.length) return 'no trackers linked yet (students post links in #job-tracking-sheet)';
    const probe = sheets[0];
    const res = await fetch(`https://docs.google.com/spreadsheets/d/${probe.sheetId}/gviz/tq?tqx=out:json`, { redirect: 'follow' });
    const text = await res.text();
    if (!text.includes('setResponse')) throw new Error(`sample tracker (${probe.email}) not publicly readable`);
    return `${sheets.length} trackers linked; sample tracker readable ✓`;
  },
  async forwarder(cohort, client) {
    const { getForwarderHealth } = require('./forwarder');
    const health = await getForwarderHealth(client, cohort);
    if (!health.applicable) return `controlled from ${health.hub}'s bot-admin channel`;
    const route = health.source && health.destination
      ? `${health.source} -> ${health.destination}`
      : 'route not configured';
    if (health.status === 'WAITING' || health.status === 'UNKNOWN') {
      throw new Error(`${health.status}: ${route}; ${health.lastError || 'state/route validation pending'}`);
    }
    return `${health.status}: ${route}${health.lastValidatedAt ? `; checked ${health.lastValidatedAt}` : ''}`;
  },
  async intake(cohort) {
    const problems = portalConfigProblems();
    if (problems.length) throw new Error(`portal environment incomplete: ${problems.join(', ')}`);
    await validateIntakeBackend(cohort);
    const settings = await getIntakeSettings(cohort, true);
    return `${settings.enabled ? 'OPEN' : 'CLOSED'}: ${portalBaseUrl()}/intake/${settings.slug}; backend version supports structured responses`;
  },
};

module.exports = function registerDoctor(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const content = msg.content.trim().toLowerCase();
    if (!content.startsWith('!doctor')) return;
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;

    const only = content.split(/\s+/)[1];
    const toRun = only ? (CHECKS[only] ? [only] : null) : Object.keys(CHECKS);
    if (!toRun) return msg.reply(`Unknown check. Available: ${Object.keys(CHECKS).map(k => `\`${k}\``).join(', ')}`);

    await msg.reply(`🩺 Running ${toRun.length} check(s) — real calls, not assumptions...`);
    const lines = [];
    for (const name of toRun) {
      try {
        const result = await CHECKS[name](cohort, client, msg.guild);
        lines.push(`✅ **${name}** — ${result}`);
      } catch (err) {
        lines.push(`❌ **${name}** — ${err.message.slice(0, 200)}`);
      }
    }
    const allOk = lines.every(l => l.startsWith('✅'));
    await msg.channel.send({
      embeds: [{
        title: allOk ? '🩺 Doctor: all systems healthy' : '🩺 Doctor: issues found',
        description: lines.join('\n').slice(0, 4000),
        color: allOk ? 0x2ecc71 : 0xe74c3c,
        footer: { text: `Single check: !doctor <${Object.keys(CHECKS).join('|')}>`.slice(0, 2048) },
      }],
    });
  });
};
module.exports.formatRosterDoctor = formatRosterDoctor;
