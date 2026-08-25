// ============================================================
// cohort-sheet-command.js
// Private one-command Google Sheet bootstrap/cleanup for a cohort.
// ============================================================

const { cohorts } = require('./config');

function parseSetupCohortSheetCommand(content) {
  const raw = String(content || '').trim();
  const parts = raw.split(/\s+/);
  if (String(parts.shift() || '').toLowerCase() !== '!setupcohortsheet') return null;

  let mode = 'repair';
  let confirmed = false;
  if (['repair', 'cleanup', 'fresh'].includes(String(parts[0] || '').toLowerCase())) {
    mode = parts.shift().toLowerCase();
  }
  if (String(parts[0] || '').toLowerCase() === 'confirm') {
    confirmed = true;
    parts.shift();
  }
  return {
    mode,
    confirmed,
    spreadsheetReference: parts.join(' ').trim(),
  };
}

async function backendPost(cohort, body) {
  const response = await fetch(cohort.appsScriptUrl, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ key: cohort.apiKey }, body)),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Apps Script returned non-JSON (HTTP ${response.status})`);
  }
  if (!response.ok || data.error) {
    throw new Error(data.error || `Apps Script HTTP ${response.status}`);
  }
  return data;
}

function listDeletedTabs(names) {
  if (!Array.isArray(names) || !names.length) return 'none';
  return names.join(', ').slice(0, 900);
}

function formatSetupError(err) {
  const message = String(err?.message || err || 'Unknown error');
  if (/DriveApp|getFileById|permission.+drive/i.test(message)) {
    return 'This cohort is still running the old Drive-permission backup method. Deploy the current Apps Script source on the existing `/exec` URL, then retry this command.';
  }
  return message.slice(0, 350);
}

function registerCohortSheetCommand(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const parsed = parseSetupCohortSheetCommand(msg.content);
    if (!parsed) return;

    const cohort = cohorts.find(item => item.guildId === msg.guildId);
    if (!cohort) return;
    if (!cohort.supervisorIds.includes(msg.author.id)) {
      await msg.reply('⛔ Only configured supervisors can set up a cohort workbook.');
      return;
    }
    if (msg.channelId !== cohort.channels.supervisor) {
      await msg.reply(`Run this private command in <#${cohort.channels.supervisor}>.`);
      return;
    }
    if (['cleanup', 'fresh'].includes(parsed.mode) && !parsed.confirmed) {
      await msg.reply(
        parsed.mode === 'cleanup'
          ? 'Cleanup copies every current tab to a safety workbook, then deletes only obsolete Form-response tabs. Confirm with `!setupcohortsheet cleanup confirm`.'
          : 'Fresh setup copies every current tab to a safety workbook and rebuilds empty operational tabs only when no operational history exists. Confirm with `!setupcohortsheet fresh confirm [Google Sheet URL]`.',
      );
      return;
    }

    await msg.reply({
      content: parsed.mode === 'repair'
        ? '🧰 Creating or repairing the required cohort tabs without clearing data...'
        : parsed.mode === 'cleanup'
          ? '🧹 Backing up the workbook, then removing obsolete Form-response tabs...'
          : '🆕 Backing up and preparing a clean new-cohort workbook...',
      allowedMentions: { parse: [] },
    });

    try {
      const result = await backendPost(cohort, {
        action: 'setupCohortWorkbook',
        mode: parsed.mode,
        spreadsheetReference: parsed.spreadsheetReference,
        guildId: cohort.guildId,
      });
      const tracking = result.tracking || {};
      const jobs = tracking.jobs || {};
      const outreach = tracking.outreach || {};
      await msg.channel.send({
        embeds: [{
          title: `✅ Cohort workbook ready — ${cohort.name}`,
          color: 0x2ecc71,
          fields: [
            { name: 'Mode', value: result.mode || parsed.mode, inline: true },
            { name: 'Backend', value: result.version || 'unknown', inline: true },
            { name: 'Required tabs', value: String(result.requiredTabs || 0), inline: true },
            {
              name: 'Safety backup',
              value: result.backupCreated || 'Not needed for repair mode',
            },
            {
              name: 'Obsolete Form tabs removed',
              value: listDeletedTabs(result.obsoleteResponseTabsDeleted),
            },
            {
              name: 'Tracking views',
              value: `Jobs: ${jobs.students || 0} students / ${jobs.dateColumns || 0} dates\n` +
                `Outreach: ${outreach.students || 0} students / ${outreach.dateColumns || 0} dates`,
            },
          ],
          footer: {
            text: 'Next: check/import All Data → !syncmembers → !missingdata if anyone has incomplete profile fields.',
          },
        }],
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      console.error('[cohort-sheet] setup failed:', err);
      await msg.reply({
        content: `❌ Cohort workbook setup stopped safely: ${formatSetupError(err)}`,
        allowedMentions: { parse: [] },
      });
    }
  });
}

module.exports = registerCohortSheetCommand;
module.exports.parseSetupCohortSheetCommand = parseSetupCohortSheetCommand;
module.exports.formatSetupError = formatSetupError;

