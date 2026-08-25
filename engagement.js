// ============================================================
//  engagement.js - !active / !inactive / !calllist
//   !active [top <n>]     - top engaged students (last 7 days)
//     ranked by questions answered + workshop attendance +
//     job applications + outreach posts
//   !inactive [days <n>]  - students with no activity in N days
//     (default 5 days) across ALL tracked dimensions
//   !calllist             - inactive with phone numbers,
//     formatted for WhatsApp outreach (one-click links)
// ============================================================
const { cohorts } = require('./config');
const { getRoster, isExcluded, mention } = require('./roster');
const { waLink } = require('./contact');
const { getNumber } = require('./settings');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(cohort, params) {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const res = await fetch(`${cohort.appsScriptUrl}?key=${encodeURIComponent(cohort.apiKey)}&${qs}`, { redirect: 'follow' });
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error('Sheet unavailable — redeploy Apps Script'); }
}

function daysAgo(dateStr, tz) {
  if (!dateStr) return 999;
  const d = new Date(String(dateStr) + 'T00:00:00');
  const today = new Date(new Date().toLocaleDateString('en-CA', { timeZone: tz }) + 'T00:00:00');
  return Math.floor((today - d) / 86400000);
}

function engagementCommandName(content) {
  const command = String(content || '').trim().toLowerCase().split(/\s+/)[0];
  return ['!active', '!inactive', '!notapplying', '!calllist'].includes(command)
    ? command
    : '';
}

module.exports = function registerEngagement(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const content = msg.content.trim();
    const lower = content.toLowerCase();
    const command = engagementCommandName(content);
    if (!command) return;
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;

    await msg.reply('⏳ Gathering engagement data...');
    try {
      const jobTarget = await getNumber(cohort, 'jobstarget');
      const windowDays = Math.max(1, Math.min(30,
        parseInt(content.match(/days?\s+(\d+)/i)?.[1] || (command === '!active' ? '7' : '5'), 10)));
      const [info, rtbr, outreach] = await Promise.all([
        api(cohort, { action: 'studentinfo' }),
        api(cohort, { action: 'rtbr', days: windowDays, jobTarget }),
        api(cohort, { action: 'outreachstatus', staleDays: windowDays }),
        sleep(0),
      ]);

      const roster = await getRoster(cohort, true);
      const rtbrByEmail = new Map((rtbr.students || []).map(s => [s.email, s]));
      const staleEmails = new Set([
        ...(outreach.stale || []).map(s => s.email),
        ...(outreach.never || []).map(s => s.email),
      ]);

      const infoByEmail = new Map((info.students || []).map(student => [student.email, student]));
      const students = roster.filter(student => !isExcluded(cohort, student));

      // ---- !active ----
      if (command === '!active') {
        const topN = parseInt(content.match(/top\s+(\d+)/i)?.[1] || '15', 10);
        const scored = students.map(s => {
          const r = rtbrByEmail.get(s.email);
          return { s, total: r ? r.total : 0,
            q: r ? r.questions : 0, workshop: r ? r.workshop : 0,
            jobPts: r ? r.jobPts : 0, streak: r ? r.streak : 0 };
        }).sort((a, b) => b.total - a.total).slice(0, topN);

        if (!scored.length) return msg.reply('No scoring data for this week yet.');
        const lines = scored.map((x, i) =>
          `**${i + 1}.** ${mention(x.s)} (**${x.total.toFixed(0)}pts**) — ❓${x.q.toFixed(0)} 🎤${x.workshop} 💼${x.jobPts.toFixed(0)}${x.streak ? ` 🔥${x.streak}` : ''}`
        );
        for (const chunk of chunkLines([`🌟 **Active students (last ${windowDays} days):**`, ...lines], 1900)) {
          await msg.channel.send({ content: chunk, allowedMentions: { parse: [] } });
          await sleep(800);
        }
        return;
      }

      // ---- !notapplying ----
      if (command === '!notapplying') {
        const notApplying = students.filter(student => {
          const activity = rtbrByEmail.get(student.email);
          return !activity || Number(activity.jobPts) <= 0;
        });
        if (!notApplying.length) return msg.reply(`✅ Every active student has job-application activity in the last ${windowDays} day(s).`);
        const lines = notApplying.map(student => {
          const privateInfo = infoByEmail.get(student.email) || {};
          const wa = waLink(privateInfo.phone || student.phone);
          return `${student.name}\t${student.email}\t${privateInfo.phone || student.phone || ''}\t@${student.username || ''}\t${wa || ''}`;
        });
        for (const chunk of chunkLines(lines, 1750)) {
          await msg.channel.send({
            content: `**No job-application activity in the last ${windowDays} day(s):**\n\`\`\`text\n${chunk}\n\`\`\``,
            allowedMentions: { parse: [] },
          });
        }
        return;
      }

      // ---- !inactive + !calllist ----
      const inactiveDays = windowDays;
      const inactive = students.filter(s => {
        const r = rtbrByEmail.get(s.email);
        const hasNoActivity = !r || r.total === 0;
        const isStale = staleEmails.has(s.email);
        return hasNoActivity && isStale;
      }).map(s => {
        const info2 = infoByEmail.get(s.email);
        return { s, phone: info2 ? info2.phone : '' };
      });

      if (!inactive.length) {
        return msg.reply(`✅ No students appear inactive for ${inactiveDays}+ days — great engagement this week!`);
      }

      const isCallList = command === '!calllist';
      const lines = inactive.map(({ s, phone }) => {
        const wa = waLink(phone);
        const tag = mention(s);
        const contact = [
          phone || '_no phone_',
          wa ? `[WhatsApp](${wa})` : null,
        ].filter(Boolean).join(' · ');
        if (isCallList) {
          return `• **${s.name}**${phone ? ` — ${phone}` : ' — _no phone_'}${wa ? `\n  → [WhatsApp](${wa})` : ''}`;
        }
        return `• ${tag} — ${contact}`;
      });

      const header = isCallList
        ? `📞 **Call/WhatsApp list — ${inactive.length} inactive students** (no RTBR activity this week + silent outreach):`
        : `😴 **Inactive students (${inactive.length}) — reach out:**`;

      for (const chunk of chunkLines([header, ...lines], 1900)) {
        await msg.channel.send({ content: chunk, allowedMentions: { parse: [] } });
        await sleep(800);
      }
    } catch (err) { await msg.reply('❌ ' + err.message); }
  });
};

module.exports.engagementCommandName = engagementCommandName;

function chunkLines(lines, maxLen) {
  const chunks = []; let cur = '';
  for (const l of lines) {
    if (cur.length + l.length + 1 > maxLen) { chunks.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + l;
  }
  if (cur) chunks.push(cur);
  return chunks;
}
