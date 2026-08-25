// ============================================================
//  perms.js - !checkperms diagnostic
//  Reports the bot's effective permissions in every configured
//  channel, so "Missing Permissions" is never a mystery again.
//  In index.js:  require('./perms')(client);
// ============================================================

const { cohorts } = require('./config');

const REQUIRED = [
  'ViewChannel',
  'SendMessages',
  'EmbedLinks',
  'ReadMessageHistory',
];
const REQUIRED_GUILD = ['ManageRoles', 'ManageChannels', 'ManageMessages'];

module.exports = function registerPerms(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    if (msg.content.trim().toLowerCase() !== '!checkperms') return;

    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;

    const me = msg.guild.members.me;
    const lines = [];
    const missingGuild = REQUIRED_GUILD.filter(p => !me.permissions.has(p));
    lines.push(missingGuild.length
      ? `❌ **Server-level permissions** — missing: \`${missingGuild.join('`, `')}\``
      : `✅ **Server-level permissions** — Manage Roles, Channels, and Messages available${me.permissions.has('Administrator') ? ' (Administrator)' : ''}`);

    for (const [label, id] of Object.entries(cohort.channels)) {
      if (!id || id.startsWith('PASTE')) continue;
      let channel;
      try {
        channel = await msg.guild.channels.fetch(id);
      } catch {
        lines.push(`⚠️ **${label}** (\`${id}\`) — bot cannot even see this channel (no View access, or wrong ID)`);
        continue;
      }
      const perms = channel.permissionsFor(me);
      const missing = REQUIRED.filter(p => !perms.has(p));
      lines.push(
        missing.length
          ? `❌ **${label}** → #${channel.name} — missing: \`${missing.join('`, `')}\``
          : `✅ **${label}** → #${channel.name} — all good`
      );
    }

    await msg.reply({
      content: `🔍 **Bot permission report:**\n${lines.join('\n')}`,
      allowedMentions: { parse: [] },
    });
  });
};
