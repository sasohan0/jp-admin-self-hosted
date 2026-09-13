// ============================================================
//  sync-command.js - supervisor-only Discord-primary roster sync
//  In index.js: require('./sync-command')(client);
// ============================================================

const { cohorts } = require('./config');
const { chunkLines } = require('./message-chunks');
const { syncMembers } = require('./roster');

function manualLines(items) {
  return (items || []).map(item => {
    const reason = item.reason ? ` — ${item.reason}` : '';
    return `• ${item.displayName || item.username || 'Unknown'} | @${item.username || 'unknown'} | ID ${item.discordId}${reason}`;
  });
}

async function sendChunks(channel, heading, lines) {
  if (!lines.length) return;
  const chunks = chunkLines(lines, 1800);
  for (let i = 0; i < chunks.length; i++) {
    await channel.send({
      content: `${i === 0 ? heading + '\n' : ''}\`\`\`text\n${chunks[i]}\n\`\`\``,
      allowedMentions: { parse: [] },
    });
  }
}

module.exports = function registerSyncCommand(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot || msg.content.trim().toLowerCase() !== '!syncmembers') return;

    const cohort = cohorts.find(c => c.guildId === msg.guildId);
    if (!cohort) return;
    if (!cohort.supervisorIds.includes(msg.author.id)) {
      return msg.reply('⛔ Only configured supervisors can run this command.');
    }
    if (msg.channelId !== cohort.channels.supervisor) {
      return msg.reply(`Run roster synchronization in <#${cohort.channels.supervisor}>.`);
    }

    await msg.reply({
      content: '🔄 Rebuilding the active roster from current Discord members. Existing stale/duplicate mappings will be preserved in Bot_Map Archive.',
      allowedMentions: { parse: [] },
    });
    try {
      const r = await syncMembers(client, cohort, { force: true });
      const { syncAllStatusRoles } = require('./student-access');
      const statusRoles = await syncAllStatusRoles(client, cohort).catch(error => ({
        active: 0, inactive: 0, cleared: 0, unchanged: 0,
        missing: [], failed: [{ id: '', error: String(error.message || error) }],
      }));
      const needsReview = r.unmatched || [];
      const rosterReview = r.rosterReview || {};
      let surveyDelivery = null;
      if (needsReview.length) {
        surveyDelivery = await require('./student-data-survey')
          .deliverNewPrivateSurveys(client, cohort)
          .catch(error => ({ error: String(error.message || error) }));
      }

      await msg.channel.send({
        embeds: [{
          title: `🔗 Discord-primary Roster Sync — ${cohort.name}`,
          color: needsReview.length ? 0xe67e22 : 0x2ecc71,
          fields: [
            { name: '👥 Eligible Discord students', value: String(r.eligibleMembers), inline: true },
            { name: '✅ Trackable Discord students', value: String(r.activeRows), inline: true },
            { name: '📋 Discord members captured', value: String(rosterReview.total || r.eligibleMembers), inline: true },
            {
              name: 'Bot_Map replacement',
              value: r.replacementSkipped ? `Skipped safely: ${r.skipReason}`.slice(0, 1024) : 'Completed',
              inline: false,
            },
            { name: '🆕 Newly linked', value: String(r.linkedNow || 0), inline: true },
            { name: '🔒 Awaiting verified identity', value: String(r.identityPending || needsReview.length), inline: true },
            { name: '💾 Existing links kept', value: String(r.kept || 0), inline: true },
            { name: '🧹 Duplicate rows merged', value: String(r.duplicatesMerged || 0), inline: true },
            { name: '📦 Stale rows archived', value: String(r.archived || 0), inline: true },
            { name: '📝 New identity matches needing review', value: String(needsReview.length), inline: true },
            { name: '📞 Missing phone', value: String(r.missingPhone || 0), inline: true },
            {
              name: '📇 All Data',
              value: `${Math.max(0, Number(r.allDataRows || 0) + Number(r.allDataSync?.added || 0) - Number(r.allDataSync?.merged || 0))} master records after sync (Discord still controls active status)`,
              inline: true,
            },
            { name: '📝 Form responses', value: `${r.enrollmentRows || 0} identity references (not automatically active)`, inline: true },
            { name: '🗄️ Archive identity rows checked', value: String(r.archiveIdentityRowsRead || 0), inline: true },
            {
              name: 'Tracking coverage repaired',
              value: [
                `Attendance + jobs + outreach rows: ${r.activeRows || 0}`,
                `Job_Sheets roster rows added: ${r.matrixUpdates?.jobSheets?.added || 0}`,
                `All Data students added: ${r.allDataSync?.added || 0}`,
              ].join('\n'),
            },
            {
              name: 'Discord status roles',
              value: `Active/inactive/cleared changes: ${statusRoles.active || 0}/${statusRoles.inactive || 0}/${statusRoles.cleared || 0}\nAlready correct: ${statusRoles.unchanged || 0} · issues: ${(statusRoles.missing?.length || 0) + (statusRoles.failed?.length || 0)}`,
            },
            {
              name: 'Form identity source tabs',
              value: (r.enrollmentSourceTabs || []).length
                ? r.enrollmentSourceTabs.join(', ').slice(0, 1024)
                : 'No enrollment/Form identity tab detected',
            },
            {
              name: 'Private data request',
              value: surveyDelivery?.error
                ? `Could not send automatically: ${surveyDelivery.error}`.slice(0, 1024)
                : surveyDelivery?.attempted
                  ? `${surveyDelivery.sent.length} DM(s) sent; ${surveyDelivery.dmClosed.length} blocked`
                  : needsReview.length
                    ? 'Already delivered earlier; use !missingdata to review/retry'
                    : 'Not required',
            },
          ],
          footer: {
            text: r.replacementSkipped
              ? 'Roster Review is complete. Collect private profiles, then rerun !syncmembers.'
              : needsReview.length
              ? 'Only verified real-email/phone profiles enter tracking. Complete pending profiles through the private survey; manual edits in Roster Review columns E:I are preserved.'
              : 'Discord membership is now the active-student source of truth; Roster Review columns E:I remain supervisor-editable.',
          },
        }],
        allowedMentions: { parse: [] },
      });

      await sendChunks(
        msg.channel,
        '**Needs private student data (all are also recorded in Roster Review; no pings):**',
        manualLines(needsReview),
      );
    } catch (err) {
      console.error('[sync] failed:', err);
      await msg.channel.send({
        content: `❌ Sync failed safely; Bot_Map was not replaced: ${err.message}`,
        allowedMentions: { parse: [] },
      });
    }
  });
};
