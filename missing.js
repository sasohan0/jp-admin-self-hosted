// ============================================================
//  missing.js - full two-way identity audit
//   !audit (alias !findmissing) - check EVERY server member
//     against the Sheet, auto-match via All Data, AND report
//     All Data students with no Discord presence (reverse)
//   !addstudent <email> @user   - manually link one person
//  In index.js:  require('./missing')(client);
// ============================================================

const { cohorts } = require('./config');
const { getRoster, clearCache } = require('./roster');
const { fetchGuildMembers } = require('./discord-members');

async function post(cohort, body) {
  const res = await fetch(cohort.appsScriptUrl, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ key: cohort.apiKey }, body)),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Sheet API returned non-JSON (HTTP ${res.status})`); }
  if (!res.ok) throw new Error(data.error || `Sheet API HTTP ${res.status}`);
  return data;
}

module.exports = function registerMissing(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const content = msg.content.trim();
    const lower = content.toLowerCase();
    if (lower !== '!audit' && lower !== '!findmissing' && !lower.startsWith('!addstudent')) return;

    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;

    // ---------------- !audit ----------------
    if (lower === '!audit' || lower === '!findmissing') {
      await msg.reply('🔎 Auditing all server members against the Sheet (both directions)...');
      try {
        const roster = await getRoster(cohort, true);
        const knownIds = new Set(roster.map(s => s.discordId).filter(Boolean));

        const members = await fetchGuildMembers(msg.guild, { force: true });
        const people = [];
        for (const m of members.values()) {
          if (m.user.bot) continue;
          if (cohort.supervisorIds.includes(m.id)) continue;
          if (knownIds.has(m.id)) continue;
          people.push({
            discordId: m.id,
            username: m.user.username,
            displayName: m.nickname || m.user.globalName || m.user.username,
          });
        }

        const data = await post(cohort, { action: 'matchMissing', people });
        if (data.error) throw new Error(data.error);
        clearCache(cohort);

        const addedText = data.added.length
          ? data.added.map(a => `✅ **${a.name}** (\`${a.username}\`) → added to Bot_Map + Attendance`).join('\n')
          : '— none';
        const manualText = data.manual.length
          ? data.manual.map(m =>
              `❓ \`${m.username}\` (display: **${m.displayName}**)` +
              (m.candidates.length ? `\n   maybe: ${m.candidates.join(' | ')}` : '') +
              `\n   → \`!addstudent their@email.com <@${m.discordId}>\``
            ).join('\n')
          : '— none';
        const missing = data.missingFromDiscord || [];
        const reverseText = missing.length
          ? missing.map(x =>
              `📵 **${x.name}** \`${x.email}\`${x.phone ? ' 📞 ' + x.phone : ''} — ${x.reason}`
            ).join('\n')
          : '— none 🎉';

        await msg.channel.send({
          embeds: [{
            title: `🧩 Server ↔ Sheet Audit — ${cohort.name}`,
            color: (data.manual.length || missing.length) ? 0xe67e22 : 0x2ecc71,
            fields: [
              { name: 'Auto-matched now (' + data.added.length + ')', value: addedText.slice(0, 1024) },
              { name: 'Unknown in Discord — need manual link (' + data.manual.length + ')', value: manualText.slice(0, 1024) },
            ],
            footer: { text: 'After manual links, run !backfilloutreach to credit their message history.' },
          }],
        });
        await msg.channel.send({
          embeds: [{
            title: `📵 In database but NOT in Discord (${missing.length})`,
            description: reverseText.slice(0, 4000),
            color: 0x992d22,
            footer: { text: 'Contact these students (WhatsApp) and invite them to the server.' },
          }],
        });
      } catch (err) {
        console.error('[missing] audit failed:', err);
        await msg.reply('❌ ' + err.message);
      }
      return;
    }

    // ---------------- !addstudent <email> @mention ----------------
    const emailMatch = content.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
    const target = msg.mentions.users.first();
    if (!emailMatch || !target) {
      return msg.reply('Usage: `!addstudent student@email.com @TheirDiscordAccount`');
    }
    try {
      const member = await msg.guild.members.fetch(target.id).catch(() => null);
      if (!member || member.user.bot || cohort.supervisorIds.includes(member.id)) {
        return msg.reply('❌ That account is not an eligible current student in this Discord server.');
      }
      const data = await post(cohort, {
        action: 'addStudent',
        email: emailMatch[0],
        discordId: target.id,
        username: target.username,
        displayName: target.globalName || target.username,
      });
      if (data.error) throw new Error(data.error);
      clearCache(cohort);
      await msg.reply(
        `✅ Linked **${data.name}** \`${emailMatch[0]}\` to <@${target.id}>` +
        `\n• Bot_Map: ${data.botMap} | Attendance: ${data.attendance}` +
        (data.inAllData ? '' : '\n⚠️ Email not found in All Data — added with Discord display name; fix the name in Bot_Map if wrong.') +
        `\n💡 Run \`!backfilloutreach\` to count their past messages.`
      );
    } catch (err) {
      console.error('[missing] addstudent failed:', err);
      await msg.reply('❌ ' + err.message);
    }
  });
};
