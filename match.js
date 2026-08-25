// ============================================================
//  match.js - !match <paste the JD>
//  Groq call 1: extract skills / seniority / location / onsite
//  Then merge student data (region, RTBR, resume, projects) and
//  Groq call 2: rank the best 5 candidates with reasons.
// ============================================================
const { cohorts } = require('./config');
const { askJson } = require('./groq');
const { waLink } = require('./contact');
const { getNumber } = require('./settings');

async function api(cohort, params) {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const res = await fetch(`${cohort.appsScriptUrl}?key=${encodeURIComponent(cohort.apiKey)}&${qs}`, { redirect: 'follow' });
  return res.json();
}
module.exports = function registerMatch(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const content = msg.content.trim();
    if (!content.toLowerCase().startsWith('!match')) return;
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;

    const jd = content.slice('!match'.length).trim();
    if (jd.length < 40) return msg.reply('Paste the job description after the command: `!match <full JD text>`');

    await msg.reply('🔎 Analyzing the JD and ranking candidates...');
    try {
      // 1. extract requirements
      const req = await askJson([
        { role: 'system', content: 'Respond ONLY with JSON: {"role":"...","skills":["..."],"onsite":true/false,"location":"city or empty","seniority":"junior|mid|senior","notes":"1 sentence"}' },
        { role: 'user', content: jd.slice(0, 3000) },
      ]);

      // 2. student data
      const jobTarget = await getNumber(cohort, 'jobstarget');
      const [info, rtbrData] = await Promise.all([
        api(cohort, { action: 'studentinfo' }),
        api(cohort, { action: 'rtbr', days: 14, jobTarget }),
      ]);
      const rtbrByEmail = {};
      for (const s of (rtbrData.students || [])) rtbrByEmail[s.email] = s.total;

      const candidates = (info.students || [])
        .filter(s => s.status !== 'hired' && s.status !== 'left')
        .map(s => ({
          email: s.email, name: s.name,
          region: s.region || '', subregion: s.subregion || '',
          rtbr: rtbrByEmail[s.email] || 0,
          hasResume: !!s.resume,
          projects: (s.projects || []).map(p => p.summary.slice(0, 150)),
        }));

      // 3. rank
      const ranked = await askJson([
        { role: 'system', content: 'You match junior developers to a job. Respond ONLY with JSON: {"picks":[{"email":"...","score":0-100,"reason":"1-2 sentences: skill/project fit, location fit if onsite, activity"}]} - best 5, highest first. If the job is onsite, strongly prefer candidates whose region matches the job location. Higher rtbr = more active/committed.' },
        { role: 'user', content:
          `JOB: ${JSON.stringify(req)}\n\nCANDIDATES:\n` +
          candidates.map(c =>
            `${c.email} | ${c.name} | ${c.region}${c.subregion ? '/' + c.subregion : ''} | rtbr:${c.rtbr} | resume:${c.hasResume ? 'yes' : 'no'} | projects: ${c.projects.join(' || ').slice(0, 300) || 'none shared'}`
          ).join('\n').slice(0, 9000) },
      ]);

      const byEmail = new Map((info.students || []).map(s => [s.email, s]));
      const lines = (ranked.picks || []).slice(0, 5).map((p, i) => {
        const s = byEmail.get(p.email);
        if (!s) return null;
        const wa = waLink(s.phone);
        const links = [
          s.discordId ? `<@${s.discordId}>` : null,
          wa ? `[WhatsApp](${wa})` : null,
          s.resume ? `[Resume](${s.resume})` : null,
          ...(s.projects || []).slice(0, 2).map((pr, j) => `[Project ${j + 1}](${pr.link})`),
        ].filter(Boolean).join(' · ');
        return `**${i + 1}. ${s.name}** — ${p.score}/100\n${links}\n_${p.reason}_`;
      }).filter(Boolean);

      await msg.channel.send({
        embeds: [{
          title: `🎯 Best candidates — ${req.role || 'the role'}`,
          description:
            `**Requirements:** ${(req.skills || []).join(', ')}${req.onsite ? ` · 📍 onsite ${req.location || ''}` : ' · remote/hybrid'}\n\n` +
            (lines.join('\n\n') || 'No good matches found.'),
          color: 0xe91e63,
          footer: { text: 'Ranked by skill/project fit + location (onsite) + RTBR activity. Verify before referring.' },
        }],
        allowedMentions: { parse: [] },
      });
    } catch (err) { await msg.reply('❌ ' + err.message); }
  });
};
