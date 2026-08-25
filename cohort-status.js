// Private server-specific cohort health summary. It never prints backend URLs or keys.
const { findCohort } = require('./config');
const { runQuotaTask } = require('./quota-queue');
const { appsScriptGet } = require('./apps-script-api');

async function inspectCohort(client, cohort) {
  let guildOk = false;
  try {
    const guild = await client.guilds.fetch(cohort.guildId);
    guildOk = Boolean(guild);
  } catch { /* reported below */ }

  let backend = 'unreachable';
  try {
    const data = await appsScriptGet(cohort, { action: 'health' }, {
      label: 'Cohort health check',
    });
    backend = `${data.version || 'unknown'} · ${data.cohort || 'unknown'}`;
  } catch { /* redacted operational status only */ }

  const channelCount = Object.values(cohort.channels || {}).filter(value => /^\d{15,20}$/.test(String(value))).length;
  return { cohort, guildOk, backend, channelCount };
}

function formatCohortLine(result) {
  return [
    `**${result.cohort.name}**`,
    `Discord ${result.guildOk ? '✅' : '❌'}`,
    `Sheet ${result.backend === 'unreachable' ? '❌ unreachable' : `✅ ${result.backend}`}`,
    `channels ${result.channelCount}`,
  ].join(' · ');
}

module.exports = function registerCohortStatus(client) {
  client.on('messageCreate', async msg => {
    if (msg.author.bot || msg.content.trim().toLowerCase() !== '!cohortstatus') return;
    const current = findCohort(msg.guildId);
    if (!current || msg.channelId !== current.channels.supervisor) return;
    if (!current.supervisorIds.includes(msg.author.id)) return;

    await msg.reply(`Checking ${current.name} without exposing backend credentials...`);
    const result = await runQuotaTask(
      `cohort-status:${current.guildId}`,
      () => inspectCohort(client, current),
    );
    await msg.channel.send({
      embeds: [{
        title: `${current.name} · server status`,
        description: formatCohortLine(result),
        color: result.guildOk && result.backend !== 'unreachable' ? 0x2ecc71 : 0xe67e22,
        footer: { text: 'Server-specific check · URLs and keys intentionally hidden' },
      }],
      allowedMentions: { parse: [] },
    });
  });
};

module.exports.formatCohortLine = formatCohortLine;
