// ============================================================
//  resume.js - auto-track latest resumes from #updated-resume
//  Any student message with an attachment or a link updates
//  their resume record (message jump link = permanent pointer).
//  In index.js:  require('./resume')(client);
// ============================================================
const { cohorts } = require('./config');
const { getRoster, isExcluded } = require('./roster');
const { report } = require('./reporter');

module.exports = function registerResume(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.channels.resumeUpdates) return;
    if (msg.channelId !== cohort.channels.resumeUpdates) return;

    const hasAttachment = msg.attachments.size > 0;
    const linkMatch = msg.content.match(/https?:\/\/\S+/);
    if (!hasAttachment && !linkMatch) return; // plain chat - ignore

    try {
      const roster = await getRoster(cohort);
      const s = roster.find(r => r.discordId === msg.author.id);
      if (!s || isExcluded(cohort, s)) return;

      const jumpLink = `https://discord.com/channels/${msg.guildId}/${msg.channelId}/${msg.id}`;
      const fileUrl = hasAttachment ? msg.attachments.first().url : (linkMatch ? linkMatch[0] : '');

      const res = await fetch(cohort.appsScriptUrl, {
        method: 'POST', redirect: 'follow',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: cohort.apiKey, action: 'saveResume',
          email: s.email, link: jumpLink, fileUrl,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      await msg.react('📄').catch(() => {});
      report(cohort.name, `Resume updated: ${s.name}`);
    } catch (err) {
      console.error('[resume] save failed:', err.message);
    }
  });
};
