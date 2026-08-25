'use strict';

// Reuse supervisor-authored resources and job-hunting material from the
// protected control cohort. Each destination owns an independent cursor, so a
// supervisor can copy one item periodically or finish the backlog at once.

const { cohorts } = require('./config');
const { controlCohort } = require('./managed-cohorts');
const { appsScriptGet, appsScriptPost } = require('./apps-script-api');
const { isOn } = require('./automations');
const { isScheduledToday } = require('./scheduler');
const { scheduleAtSetting } = require('./runtime-schedule');
const { chunkLines } = require('./message-chunks');

const KINDS = {
  resources: { sourceKey: 'resources', destinationKey: 'resources', label: 'Resources' },
  jobhunting: { sourceKey: 'jobHunting', destinationKey: 'jobHunting', label: 'Job hunting' },
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseContentSyncCommand(content) {
  const raw = String(content || '').trim();
  const source = raw.match(/^!content(?:sync|backfill)\s+source(?:\s+(control|\d{15,20}))?$/i);
  if (source) return { action: 'source', source: (source[1] || '').toLowerCase(), kind: '', mode: '' };
  const match = raw.match(/^!content(?:sync|backfill)(?:\s+(status|run|auto))?(?:\s+(resources|jobhunting))?(?:\s+(one|all|on|off))?$/i);
  if (!match) return null;
  return {
    action: (match[1] || 'status').toLowerCase(),
    kind: (match[2] || '').toLowerCase(),
    mode: (match[3] || '').toLowerCase(),
  };
}

function sourceKey(destination) {
  return `content_source_v1_${destination.guildId}`;
}

function sourceSnapshot(cohort) {
  return {
    name: cohort.name,
    guildId: cohort.guildId,
    supervisorIds: [...(cohort.supervisorIds || [])],
    channels: {
      resources: cohort.channels?.resources || '',
      jobHunting: cohort.channels?.jobHunting || '',
    },
  };
}

function cursorKey(source, destination, kind) {
  return `content_cursor_v1_${source.guildId}_${destination.guildId}_${kind}`;
}

function autoKey(source, destination, kind) {
  return `content_auto_v1_${source.guildId}_${destination.guildId}_${kind}`;
}

async function getState(cohort, key) {
  const data = await appsScriptGet(cohort, { action: 'getstate', k: key }, { label: 'Content-sync state' });
  return String(data.value || '');
}

async function setState(cohort, key, value) {
  await appsScriptPost(cohort, { action: 'setState', k: key, v: String(value) }, {
    idempotent: true,
    label: 'Content-sync state write',
  });
}

async function configuredSource(destination) {
  const raw = await getState(destination, sourceKey(destination));
  if (raw) {
    try {
      const source = JSON.parse(raw);
      if (source?.guildId && Array.isArray(source.supervisorIds) && source.channels) return source;
    } catch { /* fall through to the protected control cohort */ }
  }
  return controlCohort();
}

async function sourceMessages(channel, supervisors, cursor = '') {
  const messages = [];
  let before;
  for (let page = 0; page < 100; page++) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    for (const message of batch.values()) {
      if (cursor && BigInt(message.id) <= BigInt(cursor)) continue;
      if (message.author.bot || !supervisors.includes(message.author.id)) continue;
      if (!message.content.trim() && !message.attachments.size) continue;
      messages.push(message);
    }
    if (cursor && BigInt(batch.last().id) <= BigInt(cursor)) break;
    before = batch.last().id;
    if (batch.size < 100) break;
    await sleep(300);
  }
  return messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp || a.id.localeCompare(b.id));
}

function mirrorText(message, source, kind) {
  const heading = kind === 'resources' ? '📚 Shared resource' : '🧭 Job-hunting guidance';
  const attachmentUrls = [...message.attachments.values()].map(item => item.url).filter(Boolean);
  return [
    `${heading} from **${source.name}**`,
    message.content.trim().replace(/@(everyone|here)/gi, '@\u200b$1'),
    ...attachmentUrls,
  ].filter(Boolean).join('\n');
}

function mirrorChunks(message, source, kind) {
  return chunkLines(mirrorText(message, source, kind).split('\n'), 1900);
}

async function runContentSync(client, destination, kind, mode = 'one') {
  const spec = KINDS[kind];
  if (!spec) throw new Error('Choose resources or jobhunting');
  const source = await configuredSource(destination);
  if (!source || source.guildId === destination.guildId) {
    throw new Error('The protected source cohort cannot be the destination');
  }
  const sourceId = source.channels?.[spec.sourceKey];
  const destinationId = destination.channels?.[spec.destinationKey];
  if (!sourceId || !destinationId) {
    throw new Error(`${spec.label} channel is missing in the source or destination cohort`);
  }
  const sourceChannel = await client.channels.fetch(sourceId);
  const destinationChannel = await client.channels.fetch(destinationId);
  if (!sourceChannel?.isTextBased() || !destinationChannel?.isTextBased()) {
    throw new Error(`${spec.label} channel is not readable`);
  }
  const cursorStateKey = cursorKey(source, destination, kind);
  const cursor = await getState(destination, cursorStateKey);
  const candidates = await sourceMessages(sourceChannel, source.supervisorIds, cursor);
  const selected = mode === 'all' ? candidates : candidates.slice(0, 1);
  let copied = 0;
  for (const message of selected) {
    for (const content of mirrorChunks(message, source, kind)) {
      await destinationChannel.send({ content, allowedMentions: { parse: [] } });
    }
    await setState(destination, cursorStateKey, message.id);
    copied++;
    if (mode === 'all') await sleep(900);
  }
  return { copied, remaining: Math.max(0, candidates.length - selected.length), source, destination, kind };
}

module.exports = function registerContentSync(client) {
  for (const cohort of cohorts) {
    scheduleAtSetting(cohort, `contentsync:${cohort.guildId}`, 'contenttime', async () => {
      if (!(await isOn(cohort, 'contentsync')) || !(await isScheduledToday(cohort, 'contentsync'))) return;
      const source = await configuredSource(cohort);
      if (!source || source.guildId === cohort.guildId) return;
      for (const kind of Object.keys(KINDS)) {
        if (await getState(cohort, autoKey(source, cohort, kind)) !== '1') continue;
        try { await runContentSync(client, cohort, kind, 'one'); }
        catch (error) { console.error(`[content-sync] ${cohort.name}/${kind}:`, error.message); }
      }
    });
  }

  client.on('messageCreate', async message => {
    if (message.author.bot) return;
    const command = parseContentSyncCommand(message.content);
    if (!command) return;
    const cohort = cohorts.find(item => item.guildId === message.guildId);
    if (!cohort || !cohort.supervisorIds.includes(message.author.id)) return;
    if (message.channelId !== cohort.channels.supervisor) {
      await message.reply(`Run this command in <#${cohort.channels.supervisor}>.`);
      return;
    }
    try {
      const source = await configuredSource(cohort);
      if (!source) throw new Error('Managed control cohort is not configured');
      if (command.action === 'source') {
        if (!command.source) throw new Error('Use `!contentsync source <server-id|control>`');
        const chosen = command.source === 'control'
          ? controlCohort()
          : cohorts.find(item => item.guildId === command.source);
        if (!chosen) throw new Error('That source must be an active cohort while it is selected');
        if (chosen.guildId === cohort.guildId) throw new Error('The content source and destination must be different cohorts');
        if (!chosen.channels?.resources && !chosen.channels?.jobHunting) {
          throw new Error('No reusable Resources or Job Hunting channel was discovered in that source');
        }
        await setState(cohort, sourceKey(cohort), JSON.stringify(sourceSnapshot(chosen)));
        await message.reply({
          content: `✅ **${chosen.name}** is now the reusable-content source for **${cohort.name}**. This source remains saved if the old cohort is later retired.`,
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (command.action === 'status') {
        const lines = [`Source: **${source.name}** · server \`${source.guildId}\``];
        for (const kind of Object.keys(KINDS)) {
          const cursor = await getState(cohort, cursorKey(source, cohort, kind));
          const automatic = await getState(cohort, autoKey(source, cohort, kind));
          lines.push(`• **${KINDS[kind].label}** — periodic ${automatic === '1' ? 'ON' : 'OFF'} · cursor ${cursor ? `\`${cursor}\`` : 'not started'}`);
        }
        await message.reply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
        return;
      }
      if (!command.kind) throw new Error('Choose `resources` or `jobhunting`');
      if (command.action === 'auto') {
        if (!['on', 'off'].includes(command.mode)) throw new Error('Use `!contentsync auto <resources|jobhunting> <on|off>`');
        await setState(cohort, autoKey(source, cohort, command.kind), command.mode === 'on' ? '1' : '0');
        await message.reply(`Periodic **${KINDS[command.kind].label}** copying is now **${command.mode.toUpperCase()}** for ${cohort.name}.`);
        return;
      }
      if (command.action === 'run') {
        if (!['one', 'all'].includes(command.mode)) throw new Error('Use `!contentsync run <resources|jobhunting> <one|all>`');
        await message.reply(`⏳ Copying ${command.mode === 'all' ? 'the remaining backlog' : 'the next item'}...`);
        const result = await runContentSync(client, cohort, command.kind, command.mode);
        await message.reply(`✅ Copied **${result.copied}** item(s); approximately **${result.remaining}** remain.`);
        return;
      }
      throw new Error('Use `!contentsync status`, `!contentsync source <server-id|control>`, `!contentsync run <kind> <one|all>`, or `!contentsync auto <kind> <on|off>`');
    } catch (error) {
      await message.reply({ content: `❌ Content sync failed: ${String(error.message).slice(0, 300)}`, allowedMentions: { parse: [] } });
    }
  });
};

module.exports.KINDS = KINDS;
module.exports.autoKey = autoKey;
module.exports.cursorKey = cursorKey;
module.exports.mirrorText = mirrorText;
module.exports.mirrorChunks = mirrorChunks;
module.exports.parseContentSyncCommand = parseContentSyncCommand;
module.exports.runContentSync = runContentSync;
module.exports.sourceKey = sourceKey;
module.exports.sourceSnapshot = sourceSnapshot;
