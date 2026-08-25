// ============================================================
//  groqstatus.js - !groqstatus: live API quota check
// ============================================================
const { cohorts } = require('./config');
const { getStatus } = require('./groq');

module.exports = function registerGroqStatus(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot || msg.content.trim().toLowerCase() !== '!groqstatus') return;
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;

    await msg.reply('🔍 Probing Groq API...');
    const s = await getStatus();
    const pct = (rem, lim) => (rem && lim) ? ` (${Math.round(rem / lim * 100)}% left)` : '';
    await msg.channel.send({
      embeds: [{
        title: '🧠 Groq API Status',
        color: 0x00b8d4,
        fields: [
          { name: 'Keys configured', value: `${s.keysConfigured} (using #${s.keyNumber || 1})`, inline: true },
          { name: 'Requests remaining', value: `${s.remainingRequests || '?'} / ${s.limitRequests || '?'}${pct(s.remainingRequests, s.limitRequests)}`, inline: true },
          { name: 'Tokens remaining', value: `${s.remainingTokens || '?'} / ${s.limitTokens || '?'}${pct(s.remainingTokens, s.limitTokens)}`, inline: true },
          { name: 'Requests reset in', value: s.resetRequests || '?', inline: true },
        ],
        footer: { text: 'Add more keys anytime: GROQ_API_KEYS=key1,key2 in Render env. Auto-rotates on 429.' },
      }],
    });
  });
};
