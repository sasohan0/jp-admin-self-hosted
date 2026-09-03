'use strict';

function createRuntimeHealth(options = {}) {
  const startedAt = options.startedAt || new Date();
  const revision = String(options.revision || process.env.RENDER_GIT_COMMIT || 'local').slice(0, 12);
  const state = {
    phase: 'starting',
    expectedOnline: null,
    discordReady: false,
    lastReadyAt: null,
    lastDisconnectAt: null,
    issue: null,
    consecutiveFailures: 0,
  };

  function update(patch = {}) {
    Object.assign(state, patch);
    return snapshot();
  }

  function markReady(at = new Date()) {
    return update({
      phase: 'running',
      discordReady: true,
      lastReadyAt: at.toISOString(),
      issue: null,
      consecutiveFailures: 0,
    });
  }

  function markDisconnected(issue = 'discord_disconnected', at = new Date()) {
    return update({
      discordReady: false,
      lastDisconnectAt: at.toISOString(),
      issue,
    });
  }

  function markFailure(issue = 'discord_connection_failed') {
    return update({
      discordReady: false,
      issue,
      consecutiveFailures: state.consecutiveFailures + 1,
    });
  }

  function snapshot(at = new Date()) {
    const scheduledOffline = state.phase === 'running' && state.expectedOnline === false;
    const ok = state.discordReady || scheduledOffline;
    return {
      ok,
      status: state.discordReady ? 'ready' : scheduledOffline ? 'scheduled_offline' : state.phase,
      phase: state.phase,
      revision,
      uptimeSeconds: Math.max(0, Math.floor((at.getTime() - startedAt.getTime()) / 1000)),
      discord: {
        expectedOnline: state.expectedOnline,
        ready: state.discordReady,
        lastReadyAt: state.lastReadyAt,
        lastDisconnectAt: state.lastDisconnectAt,
        consecutiveFailures: state.consecutiveFailures,
        issue: state.issue,
      },
      checkedAt: at.toISOString(),
    };
  }

  return { markDisconnected, markFailure, markReady, snapshot, update };
}

const runtimeHealth = createRuntimeHealth();

module.exports = { createRuntimeHealth, runtimeHealth };
