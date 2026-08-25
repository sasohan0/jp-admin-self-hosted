'use strict';

// Silent, idempotent maintenance for channel activity. Unlike student-facing
// reports this runs every calendar day, including holidays and weekends.
const { cohorts } = require('./config');
const { runQuotaTask } = require('./quota-queue');
const { scheduleAtSettingEveryDay } = require('./runtime-schedule');
const { backfillInterviewHistory } = require('./interview');
const { backfillHistory: backfillOutreachHistory } = require('./outreach');
const { rosterForBackfill } = require('./roster');

async function notifyAdmin(client, cohort, text) {
  const channel = await client.channels.fetch(cohort.channels.supervisor).catch(() => null);
  if (!channel?.isTextBased()) return;
  await channel.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
}

async function reconcileActivities(client, cohort) {
  const results = {};
  const failures = [];
  let rosterState;
  try {
    // One refresh supplies both history scans. Previously each scan could run
    // another full multi-tab roster write after the 60-second reuse window.
    rosterState = await rosterForBackfill(client, cohort);
  } catch (error) {
    failures.push(`roster: ${String(error.message).slice(0, 220)}`);
  }
  if (!rosterState) {
    await notifyAdmin(
      client,
      cohort,
      `❌ **10:50 PM activity reconciliation had an issue:**\n${failures.map(item => `• ${item}`).join('\n')}\nNo history was partially written. Rerun the backfill commands after checking \`!doctor post\`.`,
    );
    return { results, failures };
  }
  try {
    results.interviews = await backfillInterviewHistory(client, cohort, {
      maxMessages: 1000,
      rosterState,
    });
  } catch (error) {
    failures.push(`interviews: ${String(error.message).slice(0, 220)}`);
  }
  try {
    results.outreach = await backfillOutreachHistory(client, cohort, {
      maxMessages: 1000,
      writeHistoricalSummary: false,
      rosterState,
    });
  } catch (error) {
    failures.push(`outreach: ${String(error.message).slice(0, 220)}`);
  }
  if (failures.length) {
    await notifyAdmin(
      client,
      cohort,
      `❌ **10:50 PM activity reconciliation had an issue:**\n${failures.map(item => `• ${item}`).join('\n')}\nRerun \`!backfillinterviews\` or \`!backfilloutreach\` in this channel.`,
    );
  }
  console.log(
    `[activity-reconcile] ${cohort.name}: interviews=${results.interviews?.recognized || 0} ` +
    `outreach=${results.outreach?.dailyEvents || 0} failures=${failures.length}`,
  );
  return { results, failures };
}

module.exports = function registerActivityReconciliation(client) {
  for (const cohort of cohorts) {
    scheduleAtSettingEveryDay(
      cohort,
      'activityreconcile',
      'activityreconciletime',
      () => runQuotaTask(
        `activity-reconcile:${cohort.guildId}`,
        () => reconcileActivities(client, cohort),
      ),
    );
    console.log(`[activity-reconcile] ${cohort.name}: daily calendar-day reconciliation active`);
  }
};

module.exports.reconcileActivities = reconcileActivities;
