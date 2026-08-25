// ============================================================
//  projects.js - track #my-best-projects posts per student
//  Message with a link/attachment -> saved to Projects tab
//  (jump link + summary = first 1500 chars of the message).
//  In index.js:  require('./projects')(client);
// ============================================================
const { cohorts } = require('./config');
const { getRoster, isExcluded } = require('./roster');
const { report } = require('./reporter');

module.exports = function registerProjects(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.channels.projects) return;
    if (msg.channelId !== cohort.channels.projects) return;
    if (msg.content.startsWith('!')) return;
    const hasLink = /https?:\/\//.test(msg.content) || msg.attachments.size > 0;
    if (!hasLink && msg.content.length < 80) return; // too thin to be a project post

    try {
      const roster = await getRoster(cohort);
      const s = roster.find(r => r.discordId === msg.author.id);
      if (!s || isExcluded(cohort, s)) return;
      const jumpLink = `https://discord.com/channels/${msg.guildId}/${msg.channelId}/${msg.id}`;
      await fetch(cohort.appsScriptUrl, {
        method: 'POST', redirect: 'follow',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: cohort.apiKey, action: 'saveProject',
          email: s.email, link: jumpLink,
          fileUrl: msg.attachments.size ? msg.attachments.first().url : '',
          summary: msg.content.slice(0, 1500),
        }),
      });
      await msg.react('🚀').catch(() => {});
      report(cohort.name, `Project saved: ${s.name}`);
    } catch (err) { console.error('[projects] save failed:', err.message); }
  });
};
