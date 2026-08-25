// ============================================================
//  say.js - !say <#channel|id> <message>
//  Send any one-off announcement/report as the bot, anywhere.
//  Supports @everyone and user mentions in the message.
// ============================================================
const { cohorts } = require('./config');

module.exports = function registerSay(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const content = msg.content.trim();
    if (!content.toLowerCase().startsWith('!say ')) return;
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;

    const rest = content.slice(5).trim();
    const m = rest.match(/^(?:<#(\d+)>|(\d{15,20}))\s+([\s\S]+)/);
    if (!m) return msg.reply('Usage: `!say #channel your message...` (supports @everyone, mentions, markdown, multi-line)');
    const channelId = m[1] || m[2];
    const text = m[3];

    try {
      const ch = await client.channels.fetch(channelId);
      await ch.send({ content: text.slice(0, 2000), allowedMentions: { parse: ['everyone', 'users', 'roles'] } });
      await msg.react('✅').catch(() => {});
    } catch (err) {
      await msg.reply('❌ ' + err.message);
    }
  });
};
