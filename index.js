// ============================================================
// index.js - JP ADMIN entry point
// ============================================================
require('dotenv').config();

const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { cohorts, mode } = require('./config');
const { discoverChannels } = require('./discover');
const { registerReporter } = require('./reporter');
const { setupAttendance } = require('./attendance');
const { loadManagedCohortsWithRetry } = require('./managed-cohorts');
const { setAppHandler, setHealthProvider, startKeepAlive } = require('./keepalive');
const { runtimeHealth } = require('./runtime-health');

function validateRuntimeConfig() {
  const errors = [];
  if (!process.env.DISCORD_TOKEN) errors.push('DISCORD_TOKEN is missing');
  if (!cohorts.length && mode !== 'installer') errors.push('no cohort is configured');
  if (mode === 'installer') {
    if (!process.env.COHORT_API_URL) errors.push('COHORT_API_URL is missing for installer mode');
    if (!process.env.COHORT_API_KEY) errors.push('COHORT_API_KEY is missing for installer mode');
  }
  for (const cohort of cohorts) {
    const label = cohort.name || '(unnamed cohort)';
    if (!cohort.name) errors.push('COHORT_NAME is missing');
    if (!cohort.guildId) errors.push(`${label}: guild/server ID is missing`);
    if (!cohort.appsScriptUrl) errors.push(`${label}: Apps Script URL is missing`);
    if (!cohort.apiKey) errors.push(`${label}: Apps Script API key is missing`);
    if (!cohort.supervisorIds?.length) errors.push(`${label}: at least one supervisor ID is required`);
  }
  if (errors.length) throw new Error('Invalid bot configuration:\n- ' + errors.join('\n- '));
}

async function initializeReadyFeatures(client) {
  if (client.__jpReadyFeaturesStarted) return;
  client.__jpReadyFeaturesStarted = true;
  try {
    console.log(`✅ Logged in as ${client.user.tag}`);
    await discoverChannels(client);
    setupAttendance(client);
    require('./questions')(client);
    require('./jobs')(client);
    require('./weekly-report')(client);
    require('./workshop')(client);
    require('./rtbr')(client);
    require('./resources')(client);
    require('./activity-reconciliation')(client);
  } catch (error) {
    client.__jpReadyFeaturesStarted = false;
    throw error;
  }
}

function registerClient(client) {
  if (client.__jpFeatureHandlersRegistered) return;
  client.__jpFeatureHandlersRegistered = true;
  if (client.isReady?.()) {
    initializeReadyFeatures(client).catch(error => console.error('[ready] Feature initialization failed:', error.message));
  } else {
    client.once('clientReady', () => initializeReadyFeatures(client)
      .catch(error => console.error('[ready] Feature initialization failed:', error.message)));
  }

  registerReporter(client);
  require('./sync-command')(client);
  require('./student-data-survey')(client);
  require('./cohort-sheet-command')(client);
  require('./hired')(client);
  require('./perms')(client);
  require('./formcontrol')(client);
  require('./outreach')(client);
  require('./missing')(client);
  require('./interview')(client);
  require('./announce')(client);
  require('./onboarding')(client);
  require('./forwarder')(client);
  require('./setup-command')(client);
  require('./self-hosted-setup').registerSelfHostedSetup(client);
  require('./resume')(client);
  require('./students')(client);
  require('./help')(client);
  require('./locations')(client);
  require('./projects')(client);
  require('./match')(client);
  require('./suggest')(client);
  require('./dm-nudges')(client);
  require('./groqstatus')(client);
  require('./exclude')(client);
  require('./say')(client);
  require('./cohort-admin')(client);
  require('./agent')(client);
  require('./forms')(client);
  require('./doctor')(client);
  require('./engagement')(client);
  require('./student-reports')(client);
  require('./cohort-status')(client);
  require('./cohort-manager')(client);
  require('./backend-control')(client);
  require('./work-calendar')(client);
  require('./control-center')(client);
  require('./intake-config')(client);
  require('./content-sync')(client);
  require('./activity-automation')(client);
  require('./dawn-discipline')(client);
  require('./group-activities')(client);
  require('./leave')(client);
  require('./followup')(client);
  require('./appeals')(client);
  require('./warning-controls')(client);
  require('./inactive-controls')(client);
  require('./student-access')(client);
  require('./mailer')(client);

  const { registerScheduler } = require('./scheduler');
  registerScheduler(client);
  const { registerSettings } = require('./settings');
  registerSettings(client);
  const { registerAutomations } = require('./automations');
  registerAutomations(client);
}

async function main() {
  runtimeHealth.update({ phase: 'loading_registry' });
  if (!process.env.DISCORD_TOKEN) {
    throw new Error('Invalid bot configuration:\n- DISCORD_TOKEN is missing');
  }
  const managed = await loadManagedCohortsWithRetry({
    onRetry(error, state) {
      console.error(
        `[startup] Managed registry temporarily unavailable after attempt ${state.attempt}; ` +
        `retrying in ${Math.round(state.retryDelayMs / 1000)} seconds: ${error.message}`,
      );
    },
  });
  validateRuntimeConfig();
  runtimeHealth.update({ phase: 'configuring' });

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Reaction],
  });

  // The bot intentionally registers one small listener per feature module.
  client.setMaxListeners(75);

  let operatingController = null;
  const activateConfiguredClient = async () => {
    if (client.__jpConfiguredRuntimeStarted) return;
    client.__jpConfiguredRuntimeStarted = true;
    const { createIntakePortalHandler } = require('./intake-portal');
    setAppHandler(createIntakePortalHandler());
    console.log(`[config] Cohort deployment: ${cohorts.map(cohort => cohort.name).join(', ')}`);
    if (managed.enabled) {
      console.log(`[config] Managed cohort registry: ${managed.source}, ${managed.count} active`);
    }
    registerClient(client);

    const { startOperatingWindow } = require('./operating-window');
    const { readBackendSchedule, setOperatingController } = require('./backend-control');
    let backendSchedule;
    let scheduleProvider;
    if (require('./managed-cohorts').controlCohort()) {
      scheduleProvider = readBackendSchedule;
      try {
        backendSchedule = await readBackendSchedule();
        console.log('[window] Loaded the protected control cohort backend schedule');
      } catch (err) {
        console.error(`[window] Could not load backend schedule; using BOT_ACTIVE_WINDOW fallback: ${err.message}`);
      }
    }
    operatingController = startOperatingWindow(client, process.env.DISCORD_TOKEN, {
      schedule: backendSchedule,
      scheduleProvider,
      health: runtimeHealth,
    });
    setOperatingController(operatingController);
  };

  if (mode === 'installer') {
    const {
      checkBackend,
      registerSelfHostedSetup,
      registerSelfHostedSlashCommands,
      restoreSelfHostedCohort,
    } = require('./self-hosted-setup');
    registerSelfHostedSetup(client, { onConfigured: activateConfiguredClient });
    client.once('clientReady', async () => {
      console.log(`✅ Installer logged in as ${client.user.tag}`);
      try {
        await registerSelfHostedSlashCommands(client);
        const restored = await restoreSelfHostedCohort(client);
        if (restored) {
          await checkBackend(restored);
          await activateConfiguredClient();
        }
        else console.log('[installer] Waiting for the server owner or an administrator to run /setup (or !setup)');
      } catch (error) {
        console.error('[installer] Saved setup or backend is not ready:', error.message);
      }
    });
    await client.login(process.env.DISCORD_TOKEN);
    return;
  }

  await activateConfiguredClient();
}

// Keep the Render health endpoint available even if managed registry loading or
// Discord login fails. The process deliberately does not connect to Discord
// with stale cohort routing after a managed-registry failure.
setHealthProvider(() => runtimeHealth.snapshot());
startKeepAlive();
main().catch(err => {
  console.error('[startup] Bot did not connect:', err.message);
  runtimeHealth.update({ phase: 'startup_failed', issue: 'startup_failed' });
  process.exitCode = 1;
});

module.exports = { main, registerClient, initializeReadyFeatures, validateRuntimeConfig };
