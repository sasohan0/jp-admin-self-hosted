// ============================================================
//  state.js - per-guild setup date + warm-up gate
//  !setupserver stores setup_<guildId> in the Sheet; features
//  marked "delayed" stay silent for warmupDays after setup.
//  Servers with no recorded setup date are treated as mature.
// ============================================================
const cache = {}; // guildId -> { at, date }
const { appsScriptGet, appsScriptPost } = require('./apps-script-api');

async function getSetupDate(cohort) {
  const hit = cache[cohort.guildId];
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.date;
  try {
    const date = (await appsScriptGet(cohort, {
      action: 'getstate',
      k: `setup_${cohort.guildId}`,
    }, { label: 'Setup state read' })).value || '';
    cache[cohort.guildId] = { at: Date.now(), date };
    return date;
  } catch { return ''; }
}

async function setSetupDate(cohort, dateStr) {
  await appsScriptPost(cohort, {
    action: 'setState',
    k: `setup_${cohort.guildId}`,
    v: dateStr,
  }, { idempotent: true, label: 'Setup state write' });
  cache[cohort.guildId] = { at: Date.now(), date: dateStr };
}

// true while inside the warm-up window (default 3 days after setup)
async function isWarmup(cohort, days = 3) {
  const date = await getSetupDate(cohort);
  if (!date) return false; // no setup recorded = mature server
  const elapsed = (Date.now() - new Date(date + 'T00:00:00').getTime()) / 86400000;
  return elapsed < days;
}

module.exports = { getSetupDate, setSetupDate, isWarmup };
