// Preserve #resources in each cohort Sheet, repost saved material, and
// optionally mirror new supervisor-authored resources from the protected
// control cohort to explicitly enabled destination cohorts.
const { cohorts } = require('./config');
const { report, reportError } = require('./reporter');
const { isOn } = require('./automations');
const { isScheduledToday } = require('./scheduler');
const { scheduleAtSetting } = require('./runtime-schedule');
const { appsScriptGet, appsScriptPost } = require('./apps-script-api');
const { controlCohort } = require('./managed-cohorts');
const { chunkLines } = require('./message-chunks');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const resourceSyncCache = new Map();
const RESOURCE_SYNC_CACHE_MS = 5 * 60 * 1000;

function resourceSyncStateKey(source, destination) {
  return `resource_sync_${source.guildId}_${destination.guildId}`;
}

async function resourceSyncEnabled(source, destination, force = false) {
  const hit = resourceSyncCache.get(destination.guildId);
  if (!force && hit && Date.now() - hit.at < RESOURCE_SYNC_CACHE_MS) return hit.enabled;
  const data = await appsScriptGet(destination, {
    action: 'getstate',
    k: resourceSyncStateKey(source, destination),
  }, { label: 'Resource sync setting' });
  const enabled = String(data.value || '') === '1';
  resourceSyncCache.set(destination.guildId, { at: Date.now(), enabled });
  return enabled;
}

async function setResourceSyncEnabled(source, destination, enabled) {
  await appsScriptPost(destination, {
    action: 'setState',
    k: resourceSyncStateKey(source, destination),
    v: enabled ? '1' : '0',
  }, { idempotent: true, label: 'Resource sync setting write' });
  resourceSyncCache.set(destination.guildId, { at: Date.now(), enabled });
}

function resourceDate(cohort, timestamp) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: cohort.timezone || 'Asia/Dhaka',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(timestamp));
}

function mirroredResourceParts(msg, source) {
  const attachments = [...msg.attachments.values()].map(item => item.url).filter(Boolean);
  const lines = [
    `📚 **Shared resource from ${source.name}**`,
    '',
    String(msg.content || '').trim(),
    ...attachments,
  ];
  return {
    attachments,
    chunks: chunkLines(lines, 1900),
    content: String(msg.content || '').trim(),
  };
}

async function mirrorResource(client, source, destination, msg) {
  const channel = await client.channels.fetch(destination.channels.resources);
  const resource = mirroredResourceParts(msg, source);
  for (const content of resource.chunks) {
    await channel.send({ content, allowedMentions: { parse: [] } });
  }
  await appsScriptPost(destination, {
    action: 'saveResources',
    items: [{
      date: resourceDate(destination, msg.createdTimestamp),
      content: resource.content,
      attachments: resource.attachments,
      sourceMessageId: msg.id,
    }],
  }, { label: 'Mirrored resource backup' });
  report(destination.name, `Resource mirrored from ${source.name}`);
}

function parseResourceSyncCommand(content) {
  const match = String(content || '').trim().toLowerCase()
    .match(/^!resourcesync(?:\s+(status|on|off))?$/);
  return match ? (match[1] || 'status') : null;
}

async function handleResourceSyncCommand(client, msg, cohort, action) {
  if (!cohort.supervisorIds.includes(msg.author.id)) return;
  if (msg.channelId !== cohort.channels.supervisor) {
    await msg.reply(`Run this private command in <#${cohort.channels.supervisor}>.`);
    return;
  }
  const source = controlCohort();
  if (!source) {
    await msg.reply('Resource sync requires the managed multi-cohort deployment.');
    return;
  }
  if (cohort.guildId === source.guildId) {
    const destinations = cohorts.filter(item => item.guildId !== source.guildId);
    const lines = [];
    for (const destination of destinations) {
      const enabled = await resourceSyncEnabled(source, destination, true);
      lines.push(`${enabled ? '🟢' : '🔴'} ${destination.name}`);
    }
    await msg.reply({
      content: lines.length
        ? `**${source.name} resource destinations**\n${lines.join('\n')}\n\n` +
          'Enable or disable sync from each destination server\'s private bot-admin.'
        : 'No destination cohort is active.',
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (action === 'on' || action === 'off') {
    await setResourceSyncEnabled(source, cohort, action === 'on');
  }
  const enabled = await resourceSyncEnabled(source, cohort, true);
  await msg.reply({
    content:
      `${enabled ? '🟢 ON' : '🔴 OFF'} — new supervisor-authored posts in ` +
      `${source.name} <#${source.channels.resources}> ${enabled ? 'are' : 'are not'} copied to ` +
      `<#${cohort.channels.resources}> and saved in this cohort's Resources tab.`,
    allowedMentions: { parse: [] },
  });
}

async function mirrorControlResource(client, msg, source) {
  for (const destination of cohorts) {
    if (destination.guildId === source.guildId || !destination.channels.resources) continue;
    try {
      if (await resourceSyncEnabled(source, destination)) {
        await mirrorResource(client, source, destination, msg);
      }
    } catch (err) {
      reportError(destination.name, `Resource sync failed: ${err.message}`);
      const admin = destination.channels.supervisor
        ? await client.channels.fetch(destination.channels.supervisor).catch(() => null)
        : null;
      await admin?.send({
        content: `⚠️ A resource from ${source.name} could not be synchronized: ${String(err.message).slice(0, 220)}`,
        allowedMentions: { parse: [] },
      }).catch(() => {});
    }
  }
}

async function backupResources(client, msg, cohort) {
  await msg.reply('⏳ Backing up the resources channel to the Sheet...');
  const channel = await client.channels.fetch(cohort.channels.resources);
  const items = [];
  let before;
  let loops = 0;
  while (loops < 100) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;
    for (const message of batch.values()) {
      if (message.author.bot || (!message.content.trim() && message.attachments.size === 0)) continue;
      items.push({
        date: resourceDate(cohort, message.createdTimestamp),
        content: message.content,
        attachments: message.attachments.map(attachment => attachment.url),
        sourceMessageId: message.id,
      });
    }
    before = batch.last().id;
    loops++;
    await sleep(400);
  }
  items.reverse();
  for (let index = 0; index < items.length; index += 20) {
    await appsScriptPost(cohort, {
      action: 'saveResources',
      items: items.slice(index, index + 20),
    }, { label: 'Resource backup' });
    await sleep(300);
  }
  await msg.reply(
    `✅ Backed up **${items.length}** resources to the Resources tab.\n` +
    '⚠️ Discord file attachments can expire; external Drive/GitHub/YouTube links are preserved reliably.',
  );
  report(cohort.name, `Resources backed up (${items.length})`);
}

module.exports = function registerResources(client) {
  for (const cohort of cohorts) {
    if (cohort.channels.resources) {
      scheduleAtSetting(cohort, 'resources', 'resourcetime', async () => {
        if (await isOn(cohort, 'resources') && await isScheduledToday(cohort, 'resources')) {
          await postNext(client, cohort);
        }
      });
      console.log(`[resources] ${cohort.name}: runtime-configurable auto-post active`);
    }
  }

  client.on('messageCreate', async msg => {
    if (msg.author.bot) return;
    const cohort = cohorts.find(item => item.guildId === msg.guildId);
    if (!cohort) return;
    const lower = msg.content.trim().toLowerCase();

    const syncAction = parseResourceSyncCommand(msg.content);
    if (syncAction) {
      try { await handleResourceSyncCommand(client, msg, cohort, syncAction); }
      catch (err) {
        await msg.reply({ content: `❌ Resource sync: ${err.message.slice(0, 300)}`, allowedMentions: { parse: [] } });
      }
      return;
    }

    const source = controlCohort();
    if (source && cohort.guildId === source.guildId &&
        msg.channelId === source.channels.resources &&
        source.supervisorIds.includes(msg.author.id) &&
        !lower.startsWith('!') &&
        (msg.content.trim() || msg.attachments.size)) {
      await mirrorControlResource(client, msg, source);
      return;
    }

    if (!['!backupresources', '!postresource'].includes(lower)) return;
    if (!cohort.supervisorIds.includes(msg.author.id)) return;
    if (!cohort.channels.resources) {
      await msg.reply('⚠️ No resources channel configured.');
      return;
    }
    try {
      if (lower === '!backupresources') await backupResources(client, msg, cohort);
      else await postNext(client, cohort, msg);
    } catch (err) {
      await msg.reply(`❌ ${err.message}`);
    }
  });
};

async function postNext(client, cohort, msg) {
  try {
    const result = await appsScriptGet(cohort, {
      action: 'nextresource',
    }, { label: 'Next resource' });
    if (result.error) {
      if (msg) await msg.reply(`📭 ${result.error}`);
      return;
    }
    const channel = await client.channels.fetch(cohort.channels.resources);
    const lines = [
      `📚 **Resource** _(from a previous cohort, ${result.date})_`,
      '',
      result.content || '',
      ...(result.attachments || []),
    ];
    for (const content of chunkLines(lines, 1900)) {
      await channel.send({ content, allowedMentions: { parse: [] } });
    }
    if (msg) await msg.reply('✅ Posted the next resource.');
    report(cohort.name, 'Resource reposted');
  } catch (err) {
    reportError(cohort.name, `Resource post failed: ${err.message}`);
    if (msg) throw err;
  }
}

module.exports.parseResourceSyncCommand = parseResourceSyncCommand;
module.exports.resourceSyncStateKey = resourceSyncStateKey;
module.exports.mirroredResourceParts = mirroredResourceParts;
