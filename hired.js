// ============================================================
//  hired.js - #successfully-hired pipeline
//  Supervisor mentions a student in the hired channel ->
//  Bot_Map Status=hired + green rows in Sheet + confirmation.
//  In index.js:  require('./hired')(client);
// ============================================================

const { cohorts } = require('./config');
const { getRoster, clearCache } = require('./roster');
const { assignHiredRole } = require('./hired-role');

module.exports = function registerHired(client) {
  client.once('clientReady', () => {
    setTimeout(async () => {
      for (const cohort of cohorts) {
        try {
          const roster = await getRoster(cohort);
          const hiredIds = roster.filter(student => student.status === 'hired').map(student => student.discordId);
          if (!hiredIds.some(Boolean)) continue;
          const guild = await client.guilds.fetch(cohort.guildId);
          const result = await assignHiredRole(guild, hiredIds);
          console.log(`[hired] ${cohort.name}: startup role sync assigned ${result.assigned.length}, already ${result.already.length}, issues ${result.missing.length + result.failed.length}`);
        } catch (error) {
          console.error(`[hired] ${cohort.name}: startup role sync failed:`, error.message);
        }
      }
    }, 60000);
  });

  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;

    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort) return;

    if (msg.content.trim().toLowerCase() === '!synchiredroles') {
      if (msg.channelId !== cohort.channels.supervisor || !cohort.supervisorIds.includes(msg.author.id)) return;
      try {
        await msg.reply('🔄 Synchronizing the Discord **Hired** role from explicit `Bot_Map` hired statuses...');
        const roster = await getRoster(cohort, true);
        const hired = roster.filter(student => student.status === 'hired');
        const withoutDiscordId = hired.filter(student => !student.discordId);
        const result = await assignHiredRole(msg.guild, hired.map(student => student.discordId));
        const lines = [
          `✅ **Hired role sync — ${cohort.name}**`,
          `• Explicitly hired in Bot_Map: **${hired.length}**`,
          `• Newly assigned: **${result.assigned.length}**`,
          `• Already assigned: **${result.already.length}**`,
          `• Missing Discord ID: **${withoutDiscordId.length}**`,
          `• Not in this server: **${result.missing.length}**`,
          `• Failed: **${result.failed.length}**`,
          '',
          'Colored inactive/left students are excluded from active checks, but only explicit `Status = hired` rows receive this role.',
        ];
        if (result.failed.length) {
          lines.push('', ...result.failed.slice(0, 10).map(item => `• ${item.id} — ${item.error}`));
        }
        await msg.channel.send({ content: lines.join('\n'), allowedMentions: { parse: [] } });
      } catch (err) {
        await msg.reply(`❌ Hired-role sync failed: ${String(err.message || err).slice(0, 300)}`);
      }
      return;
    }

    if (!cohort.channels.hired) return;
    if (msg.channelId !== cohort.channels.hired) return;

    // channel permissions already restrict posting, this is a code-level backup
    if (!cohort.supervisorIds.includes(msg.author.id)) return;

    if (msg.mentions.users.size === 0) return; // announcement text without mentions - ignore

    try {
      const roster = await getRoster(cohort, true);

      const students = [], unknown = [];
      for (const [id, user] of msg.mentions.users) {
        const s = roster.find(r => r.discordId === id);
        if (s) students.push(s);
        else unknown.push(user.username);
      }

      if (students.length === 0) {
        if (unknown.length) {
          await msg.reply(`⚠️ Not in the roster: ${unknown.join(', ')} — nothing marked.`);
        }
        return;
      }

      // Tell the Sheet
      const res = await fetch(cohort.appsScriptUrl, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: cohort.apiKey,
          action: 'markHired',
          emails: students.map(s => s.email),
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      clearCache(cohort); // so every module sees the new status immediately

      let roleResult;
      try {
        roleResult = await assignHiredRole(msg.guild, students.map(s => s.discordId));
      } catch (roleError) {
        roleResult = { assigned: [], already: [], missing: [], failed: [{ error: roleError.message }] };
      }

      const lines = students.map(s => `🎉 **${s.name}** — congratulations on the new role!`);
      await msg.reply({
        embeds: [{
          title: `🏆 Hired — ${cohort.name}`,
          description: lines.join('\n'),
          color: 0x2ecc71,
          footer: {
            text: `Marked hired and excluded from active checks. Discord role assigned: ${roleResult.assigned.length}; role issues: ${roleResult.missing.length + roleResult.failed.length}.`,
          },
        }],
      });

      if (roleResult.failed.length || roleResult.missing.length) {
        const admin = await client.channels.fetch(cohort.channels.supervisor);
        await admin.send({
          content: `⚠️ Sheet status was updated, but the Discord **Hired** role needs review for ${roleResult.failed.length + roleResult.missing.length} member(s). Run \`!synchiredroles\` after fixing member IDs or role hierarchy.`,
          allowedMentions: { parse: [] },
        });
      }

      if (unknown.length) {
        await msg.channel.send(`⚠️ Also mentioned but not in roster (skipped): ${unknown.join(', ')}`);
      }
    } catch (err) {
      console.error('[hired] failed:', err.message);
      await msg.reply('❌ Could not update the Sheet: ' + err.message);
    }
  });
};
