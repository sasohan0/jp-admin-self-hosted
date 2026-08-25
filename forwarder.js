// ============================================================
//  forwarder.js - optional, command-controlled job forwarder
//   !forwarder status | start | stop
//   !forwarder set <sourceChannelId> <destChannelId>
//  Settings persist in the primary cohort's Apps Script state.
//  Edits to messages forwarded during this process sync too.
// ============================================================
const { PermissionsBitField } = require('discord.js');
const { cohorts, forwarder: fwdDefaults } = require('./config');
const { resolveForwarderRoute, cleanId, forwarderRuntimeStatus } = require('./forwarder-route');
const { report, reportError } = require('./reporter');
const { appsScriptGet, appsScriptPost } = require('./apps-script-api');

const state = {
  enabled: false,
  loaded: false,
  routeReady: false,
  source: '',
  dest: '',
  owner: '',
  lastError: '',
  lastValidatedAt: '',
};
const fwdMap = new Map(); // originalMsgId -> forwarded Message (edit sync, capped)
const primary = () =>
  cohorts.find(cohort => cohort.guildId === fwdDefaults.hubGuildId) ||
  cohorts[0];
const scopedKey = (suffix) => `fwd_${primary().guildId}_${suffix}`;

async function post(body) {
  const cohort = primary();
  return appsScriptPost(cohort, body, {
    idempotent: body?.action === 'setState',
    label: 'Forwarder state write',
  });
}

async function getState(key) {
  const cohort = primary();
  return (await appsScriptGet(cohort, {
    action: 'getstate',
    k: key,
  }, { label: 'Forwarder state read' })).value;
}

async function setState(key, value) {
  return post({ action: 'setState', k: key, v: value });
}

const SOURCE_PERMISSIONS = [
  ['View Channel', PermissionsBitField.Flags.ViewChannel],
  ['Read Message History', PermissionsBitField.Flags.ReadMessageHistory],
];
const DESTINATION_PERMISSIONS = [
  ['View Channel', PermissionsBitField.Flags.ViewChannel],
  ['Send Messages', PermissionsBitField.Flags.SendMessages],
  ['Embed Links', PermissionsBitField.Flags.EmbedLinks],
  ['Attach Files', PermissionsBitField.Flags.AttachFiles],
];

function missingPermissions(channel, user, required) {
  if (typeof channel.permissionsFor !== 'function') return [];
  const permissions = channel.permissionsFor(user);
  if (!permissions) return required.map(([name]) => name);
  return required.filter(([, flag]) => !permissions.has(flag)).map(([name]) => name);
}

async function validateRoute(client, sourceId = state.source, destinationId = state.dest) {
  if (!sourceId || !destinationId) throw new Error('Set both source and destination channel IDs first.');
  if (sourceId === destinationId) throw new Error('Source and destination channels must be different.');

  let source;
  let destination;
  try { source = await client.channels.fetch(sourceId); }
  catch { throw new Error(`The bot cannot access source channel ${sourceId}.`); }
  try { destination = await client.channels.fetch(destinationId); }
  catch { throw new Error(`The bot cannot access destination channel ${destinationId}. Invite this bot to that server and grant channel access.`); }

  if (!source?.isTextBased?.() || typeof source.messages?.fetch !== 'function') {
    throw new Error('The source must be a Discord text channel.');
  }
  if (source.guildId !== primary().guildId) {
    throw new Error(`The source must belong to the configured ${primary().name} server.`);
  }
  if (!destination?.isTextBased?.() || typeof destination.send !== 'function') {
    throw new Error('The destination must be a Discord text channel.');
  }

  const sourceMissing = missingPermissions(source, client.user, SOURCE_PERMISSIONS);
  if (sourceMissing.length) throw new Error(`Source channel is missing: ${sourceMissing.join(', ')}.`);
  const destinationMissing = missingPermissions(destination, client.user, DESTINATION_PERMISSIONS);
  if (destinationMissing.length) throw new Error(`Destination channel is missing: ${destinationMissing.join(', ')}.`);

  return { source, destination };
}

async function checkRoute(client, sourceId = state.source, destinationId = state.dest) {
  try {
    const route = await validateRoute(client, sourceId, destinationId);
    state.routeReady = true;
    state.lastError = '';
    state.lastValidatedAt = new Date().toISOString();
    return route;
  } catch (error) {
    state.routeReady = false;
    state.lastError = error.message;
    state.lastValidatedAt = new Date().toISOString();
    throw error;
  }
}

async function loadState(client) {
  try {
    let [enabledValue, persistedSource, persistedDestination] = await Promise.all([
      getState(scopedKey('enabled')),
      getState(scopedKey('source')),
      getState(scopedKey('dest')),
    ]);
    // One-time compatibility migration from the original unnamespaced EJP
    // keys. Only the selected hub cohort can claim these values.
    if (!enabledValue && !persistedSource && !persistedDestination) {
      [enabledValue, persistedSource, persistedDestination] = await Promise.all([
        getState('fwd_enabled'),
        getState('fwd_source'),
        getState('fwd_dest'),
      ]);
      if (enabledValue || persistedSource || persistedDestination) {
        await Promise.all([
          setState(scopedKey('enabled'), enabledValue || '0'),
          setState(scopedKey('source'), persistedSource || ''),
          setState(scopedKey('dest'), persistedDestination || ''),
        ]);
      }
    }
    const route = resolveForwarderRoute({
      persistedSource,
      persistedDestination,
      defaultSource: fwdDefaults.sourceChannelId,
      defaultDestination: fwdDefaults.destinationChannelId,
      deprecatedDestinationIds: fwdDefaults.deprecatedDestinationChannelIds,
    });

    state.enabled = enabledValue === '1';
    state.loaded = true;
    state.source = route.source;
    state.dest = route.destination;
    state.owner = cleanId(fwdDefaults.targetUserId);

    if (route.migratedDestination) {
      await setState(scopedKey('dest'), state.dest);
      console.log(`[forwarder] migrated deprecated destination to ${state.dest}`);
    }

    if (state.enabled) {
      try {
        if (!state.owner) throw new Error('No forwarding owner is configured.');
        await checkRoute(client);
      } catch (err) {
        reportError(primary().name, `Forwarder waiting for route access: ${err.message}`);
      }
    }

    console.log(`[forwarder] loaded: desired=${state.enabled} ready=${state.routeReady} ${state.source || '(unset)'} -> ${state.dest || '(unset)'}`);
  } catch (err) {
    state.loaded = false;
    state.routeReady = false;
    state.lastError = err.message;
    console.error('[forwarder] state load failed:', err.message);
  }
}

async function reconcile(client) {
  if (!state.loaded) return loadState(client);
  if (!state.enabled) return;
  try {
    if (!state.owner) throw new Error('No forwarding owner is configured.');
    await checkRoute(client);
  } catch (error) {
    console.warn(`[forwarder] route still waiting: ${error.message}`);
  }
}

async function getForwarderHealth(client, cohort) {
  if (!cohort || cohort.guildId !== primary().guildId) {
    return { applicable: false, hub: primary().name };
  }
  if (state.loaded && state.source && state.dest) {
    try { await checkRoute(client); } catch {}
  }
  return {
    applicable: true,
    status: forwarderRuntimeStatus({
      desiredEnabled: state.enabled,
      stateLoaded: state.loaded,
      routeReady: state.routeReady,
    }),
    source: state.source,
    destination: state.dest,
    lastError: state.lastError,
    lastValidatedAt: state.lastValidatedAt,
  };
}

function buildPayload(msg, edited) {
  let text = `**Forwarded Job Post${edited ? ' (edited)' : ''}:**\n${msg.content || ''}`;
  if (text.length > 2000) text = text.slice(0, 1997) + '...';
  const payload = {
    content: text,
    allowedMentions: { parse: [] },
  };
  if (msg.attachments?.size > 0) payload.files = msg.attachments.map(attachment => attachment.url);
  return payload;
}

module.exports = function registerForwarder(client) {
  client.once('clientReady', async () => {
    await loadState(client);
    const timer = setInterval(() => reconcile(client).catch(error => {
      console.error('[forwarder] reconcile failed:', error.message);
    }), 5 * 60 * 1000);
    timer.unref?.();
  });

  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const content = msg.content.trim();
    const lower = content.toLowerCase();

    if (lower.startsWith('!forwarder')) {
      const cohort = cohorts.find(item => item.guildId === msg.guildId);
      if (!cohort || cohort !== primary() || !cohort.supervisorIds.includes(msg.author.id)) return;
      if (cohort.channels.supervisor && msg.channelId !== cohort.channels.supervisor) {
        await msg.reply(`Run forwarder controls in <#${cohort.channels.supervisor}>.`);
        return;
      }

      const parts = content.split(/\s+/);
      const sub = (parts[1] || 'status').toLowerCase();
      try {
        if (sub === 'start') {
          if (!state.owner) throw new Error('No forwarding owner is configured for this service.');
          await checkRoute(client);
          state.enabled = true;
          state.loaded = true;
          await setState(scopedKey('enabled'), '1');
          await msg.reply(`Forwarder ON: <#${state.source}> -> <#${state.dest}>`);
        } else if (sub === 'stop') {
          state.enabled = false;
          state.routeReady = false;
          await setState(scopedKey('enabled'), '0');
          await msg.reply('Forwarder OFF.');
        } else if (sub === 'set') {
          const sourceId = cleanId(parts[2]);
          const destinationId = cleanId(parts[3]);
          if (!sourceId || !destinationId) {
            await msg.reply('Usage: `!forwarder set <sourceChannelId> <destinationChannelId>`');
            return;
          }
          await checkRoute(client, sourceId, destinationId);
          state.source = sourceId;
          state.dest = destinationId;
          state.enabled = false;
          state.routeReady = false;
          fwdMap.clear();
          await Promise.all([
            setState(scopedKey('source'), sourceId),
            setState(scopedKey('dest'), destinationId),
            setState(scopedKey('enabled'), '0'),
          ]);
          await msg.reply(`Forwarder route saved: <#${sourceId}> -> <#${destinationId}>. It is OFF; run \`!forwarder start\` when ready.`);
        } else if (sub === 'status') {
          let access = 'not configured';
          if (state.source && state.dest) {
            try {
              await checkRoute(client);
              access = 'ready';
            } catch (err) {
              access = `not ready - ${err.message}`;
            }
          }
          await msg.reply(
            `Forwarder is **${forwarderRuntimeStatus({ desiredEnabled: state.enabled, stateLoaded: state.loaded, routeReady: state.routeReady })}**` +
            (state.source && state.dest ? `\nRoute: \`${state.source}\` -> \`${state.dest}\`` : '\nNo route set.') +
            `\nAccess: ${access}` +
            '\nCommands: `!forwarder start|stop|set <sourceId> <destinationId>`'
          );
        } else {
          await msg.reply('Usage: `!forwarder status|start|stop|set <sourceId> <destinationId>`');
        }
      } catch (err) {
        await msg.reply(`Forwarder error: ${err.message}`);
      }
      return;
    }

    const sourceCohort = cohorts.find(item => item.guildId === msg.guildId);
    if (!sourceCohort || sourceCohort !== primary()) return;
    if (!state.enabled || msg.channelId !== state.source || msg.author.id !== state.owner) return;

    try {
      const { destination } = await checkRoute(client);
      const sent = await destination.send(buildPayload(msg, false));
      fwdMap.set(msg.id, sent);
      if (fwdMap.size > 500) fwdMap.delete(fwdMap.keys().next().value);
      report(sourceCohort.name, 'Forwarded a job post');
    } catch (err) {
      reportError(sourceCohort.name, `Forward failed: ${err.message}`);
    }
  });

  client.on('messageUpdate', async (_oldMsg, newMsg) => {
    const sourceCohort = cohorts.find(item => item.guildId === newMsg.guildId);
    if (!sourceCohort || sourceCohort !== primary() || !state.enabled) return;
    if (newMsg.channelId !== state.source || newMsg.author?.id !== state.owner) return;
    const forwarded = fwdMap.get(newMsg.id);
    if (!forwarded || !newMsg.content) return;
    try {
      await forwarded.edit({
        content: buildPayload(newMsg, true).content,
        allowedMentions: { parse: [] },
      });
      report(sourceCohort.name, 'Synced an edited job post');
    } catch (err) {
      reportError(sourceCohort.name, `Forward edit sync failed: ${err.message}`);
    }
  });
};

module.exports.getForwarderHealth = getForwarderHealth;
