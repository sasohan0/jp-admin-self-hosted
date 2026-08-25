// ============================================================
//  students.js - !students region directory
//   !students                    -> counts grouped by region/sub
//   !students <region>           -> list with contacts
//   !students <region> <sub>     -> narrower list
//  Each entry: name, @discord, one-click WhatsApp, resume link.
//  Data: Bot_Map (Region/Subregion) + All Data (phone) + Resumes.
// ============================================================
const { cohorts } = require('./config');
const { waLink } = require('./contact');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(cohort, params) {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const res = await fetch(`${cohort.appsScriptUrl}?key=${encodeURIComponent(cohort.apiKey)}&${qs}`, { redirect: 'follow' });
  return res.json();
}

function isStudentsCommand(content) {
  return /^!students(?:\s|$)/i.test(String(content || '').trim());
}

module.exports = function registerStudents(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const content = msg.content.trim();
    if (!isStudentsCommand(content)) return;
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;

    const args = content.split(/\s+/).slice(1).map(a => a.toLowerCase());
    const [region, subregion] = args;

    try {
      const data = await api(cohort, { action: 'studentinfo' });
      if (data.error) throw new Error(data.error);
      const all = (data.students || []).filter(s => s.status !== 'left');

      // ---- no args: grouped counts ----
      if (!region) {
        const groups = {};
        let unset = 0;
        for (const s of all) {
          if (!s.region) { unset++; continue; }
          const r = s.region.toLowerCase();
          const g = groups[r] || (groups[r] = { name: s.region, count: 0, subs: {} });
          g.count++;
          if (s.subregion) {
            const sub = s.subregion.toLowerCase();
            g.subs[sub] = g.subs[sub] || { name: s.subregion, count: 0 };
            g.subs[sub].count++;
          }
        }
        const lines = Object.values(groups)
          .sort((a, b) => b.count - a.count)
          .map(g => `**${g.name}** — ${g.count}` +
            (Object.keys(g.subs).length
              ? ` (${Object.values(g.subs).sort((a, b) => b.count - a.count).map(s => `${s.name}: ${s.count}`).join(', ')})`
              : ''));
        if (unset) lines.push(`_No region set: ${unset} students (fill Region/Subregion columns in Bot_Map)_`);
        await msg.channel.send({
          embeds: [{
            title: `🗺 Students by Region — ${cohort.name}`,
            description: lines.join('\n').slice(0, 4000) || 'No region data yet — fill the Region/Subregion columns in Bot_Map.',
            color: 0x3498db,
            footer: { text: 'Filter: !students <region> [subregion]' },
          }],
        });
        return;
      }

      // ---- filtered list ----
      const matched = all.filter(s =>
        s.region && s.region.toLowerCase() === region &&
        (!subregion || (s.subregion && s.subregion.toLowerCase() === subregion))
      ).sort((a, b) => a.name.localeCompare(b.name));

      if (!matched.length) {
        return msg.reply(`📭 No students found for **${region}${subregion ? ' / ' + subregion : ''}**. Check spelling against Bot_Map values.`);
      }

      const lines = matched.map(s => {
        const parts = [`**${s.name}**${s.hired === 'hired' ? ' 💼' : ''}`];
        parts.push(s.discordId ? `<@${s.discordId}>` : '_no discord_');
        const wa = waLink(s.phone);
        parts.push(wa ? `[WhatsApp](${wa})` : '_no phone_');
        parts.push(s.resume ? `[Resume](${s.resume})` : '_no resume_');
        if (s.subregion && !subregion) parts.push(`(${s.subregion})`);
        return `• ${parts.join(' · ')}`;
      });

      // embeds support markdown links; chunk descriptions at ~3900 chars
      const chunks = [];
      let cur = '';
      for (const l of lines) {
        if (cur.length + l.length + 1 > 3900) { chunks.push(cur); cur = ''; }
        cur += (cur ? '\n' : '') + l;
      }
      if (cur) chunks.push(cur);

      for (let i = 0; i < chunks.length; i++) {
        await msg.channel.send({
          embeds: [{
            title: i === 0 ? `📍 ${matched.length} students — ${region}${subregion ? ' / ' + subregion : ''}` : undefined,
            description: chunks[i],
            color: 0x3498db,
          }],
          allowedMentions: { parse: [] }, // directory view - no pings
        });
        await sleep(900);
      }
    } catch (err) {
      await msg.reply('❌ ' + err.message);
    }
  });
};

module.exports.isStudentsCommand = isStudentsCommand;
