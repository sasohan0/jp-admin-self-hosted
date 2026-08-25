// ============================================================
//  locations.js - !filllocations [tab | column]
//  Auto-fills Bot_Map Region/Subregion from an existing tab.
//  Defaults: backend-selected enrollment response tab, region/location column.
//  Examples:
//    !filllocations
//    !filllocations Form Responses 2 | Current Location
//    !filllocations All Data | address
//  In index.js:  require('./locations')(client);
// ============================================================
const { cohorts } = require('./config');
const { clearCache } = require('./roster');

module.exports = function registerLocations(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const content = msg.content.trim();
    if (!content.toLowerCase().startsWith('!filllocations')) return;
    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;

    // syntax: !filllocations <tab name> | <column name>   (both optional)
    const rest = content.slice('!filllocations'.length).trim();
    let tab = '', column = '';
    if (rest.includes('|')) {
      [tab, column] = rest.split('|').map(s => s.trim());
    } else {
      tab = rest;
    }

    await msg.reply(`⏳ Filling Bot_Map locations from **${tab || 'the active enrollment response tab'}** (column ~ "${column || 'region/location'}")...`);
    try {
      const res = await fetch(cohort.appsScriptUrl, {
        method: 'POST', redirect: 'follow',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: cohort.apiKey, action: 'fillLocations', tab, column }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      clearCache(cohort);

      const fields = [
        { name: '✅ Updated', value: String(data.updated), inline: true },
        { name: '❓ Uncertain parses', value: String(data.unsure), inline: true },
        { name: '📭 Emails not in Bot_Map', value: String(data.unmatchedCount), inline: true },
      ];
      if (data.unsureSamples && data.unsureSamples.length) {
        fields.push({
          name: 'Uncertain samples (verify in Bot_Map)',
          value: data.unsureSamples.map(s => `• ${s}`).join('\n').slice(0, 1024),
        });
      }
      await msg.channel.send({
        embeds: [{
          title: `🗺 Location Fill — ${data.tab}`,
          color: data.unsure ? 0xe67e22 : 0x2ecc71,
          fields,
          footer: { text: 'Check results: !students — re-running is safe (latest form answer wins).' },
        }],
      });
    } catch (err) {
      await msg.reply('❌ ' + err.message);
    }
  });
};
