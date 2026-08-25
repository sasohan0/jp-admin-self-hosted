// Batches Discord join events into a full cohort roster reconciliation.
// A full sync is intentional: it keeps Discord membership authoritative while
// avoiding one Apps Script execution for every member in a join burst.

function createJoinRosterSyncQueue(options = {}) {
  const sync = options.sync;
  if (typeof sync !== 'function') throw new Error('sync function is required');
  const delayMs = Math.max(0, Number(options.delayMs ?? 30000));
  const retryDelays = Array.isArray(options.retryDelays)
    ? options.retryDelays.map(Number).filter(value => value >= 0)
    : [30000, 60000, 120000];
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const onSuccess = options.onSuccess || (() => {});
  const onError = options.onError || (() => {});
  const states = new Map();

  function stateFor(guildId) {
    if (!states.has(guildId)) {
      states.set(guildId, {
        timer: null,
        running: false,
        pending: false,
        failures: 0,
        client: null,
        cohort: null,
      });
    }
    return states.get(guildId);
  }

  function arm(state, waitMs) {
    if (state.timer || state.running) return;
    state.timer = setTimer(async () => {
      state.timer = null;
      state.running = true;
      state.pending = false;
      try {
        const result = await sync(state.client, state.cohort);
        state.failures = 0;
        await onSuccess(state.cohort, result);
      } catch (error) {
        state.failures += 1;
        await onError(state.cohort, error, state.failures);
        state.pending = state.failures <= retryDelays.length;
      } finally {
        state.running = false;
        if (state.pending) {
          const retryIndex = Math.max(0, state.failures - 1);
          arm(state, state.failures ? retryDelays[retryIndex] : delayMs);
        }
      }
    }, waitMs);
  }

  function schedule(client, cohort, options = {}) {
    if (!cohort?.guildId) return false;
    const state = stateFor(cohort.guildId);
    state.client = client;
    state.cohort = cohort;
    if (state.running) {
      state.pending = true;
      return true;
    }
    // Do not move an existing timer. The first join starts a short batching
    // window, so a steady arrival stream cannot postpone reconciliation.
    arm(state, options.immediate ? 0 : delayMs);
    return true;
  }

  function cancel(guildId) {
    const state = states.get(guildId);
    if (!state) return false;
    if (state.timer) clearTimer(state.timer);
    states.delete(guildId);
    return true;
  }

  return { cancel, schedule, states };
}

module.exports = { createJoinRosterSyncQueue };
