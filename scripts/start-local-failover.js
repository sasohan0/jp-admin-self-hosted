'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const envPath = path.resolve(root, process.env.LOCAL_FAILOVER_ENV || '.env.failover');
require('dotenv').config({ path: envPath });

const healthUrl = String(process.env.LOCAL_FAILOVER_HEALTH_URL || '').trim();
const expectedCohort = String(process.env.LOCAL_FAILOVER_EXPECTED_COHORT || '').trim();
const expectedBotId = String(process.env.LOCAL_FAILOVER_BOT_ID || '').trim();
const checkEveryMs = Math.max(3000, Number(process.env.LOCAL_FAILOVER_CHECK_MS || 5000));
let child = null;
let stopping = false;

function fail(message) {
  console.error(`[failover] Refused to start: ${message}`);
  process.exitCode = 1;
}

async function primaryStatus() {
  try {
    const response = await fetch(`${healthUrl}${healthUrl.includes('?') ? '&' : '?'}failover=${Date.now()}`, {
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch {}
    return { healthy: response.ok && (!parsed || parsed.ok !== false), status: response.status };
  } catch {
    return { healthy: false, status: 0 };
  }
}

async function validateIdentity() {
  if (process.env.LOCAL_FAILOVER !== 'true') throw new Error('LOCAL_FAILOVER=true is required');
  if (!healthUrl.startsWith('https://')) throw new Error('LOCAL_FAILOVER_HEALTH_URL must be an HTTPS URL');
  if (!expectedCohort) throw new Error('LOCAL_FAILOVER_EXPECTED_COHORT is required');
  if (!/^\d{17,20}$/.test(expectedBotId)) throw new Error('LOCAL_FAILOVER_BOT_ID is required');
  if (!process.env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is missing from the failover environment file');

  const { cohorts, mode } = require('../config');
  if (mode === 'legacy') throw new Error('legacy EJP configuration is never allowed for local failover');
  if (cohorts.length !== 1 || cohorts[0].name !== expectedCohort) {
    throw new Error(`configured cohort must be exactly ${expectedCohort}`);
  }
  const cohort = cohorts[0];
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(cohort.appsScriptUrl || '')) {
    throw new Error('COHORT_API_URL is missing or is not a deployed Apps Script /exec URL');
  }
  if (String(cohort.apiKey || '').length < 16) throw new Error('COHORT_API_KEY is missing or too short');
  if (!cohort.supervisorIds?.length || !cohort.supervisorIds.every(id => /^\d{15,20}$/.test(id))) {
    throw new Error('COHORT_SUPERVISOR_IDS must contain your Discord User ID');
  }
  const response = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
    signal: AbortSignal.timeout(10000),
  });
  const bot = await response.json();
  if (!response.ok || bot.id !== expectedBotId) throw new Error('Discord token does not belong to the expected failover bot application');
  let currentNonBotSupervisorCount = 0;
  for (const supervisorId of cohort.supervisorIds) {
    const memberResponse = await fetch(
      `https://discord.com/api/v10/guilds/${cohort.guildId}/members/${supervisorId}`,
      { headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` }, signal: AbortSignal.timeout(10000) },
    );
    const member = await memberResponse.json().catch(() => ({}));
    if (memberResponse.ok && !member.user?.bot) currentNonBotSupervisorCount += 1;
  }
  if (currentNonBotSupervisorCount === 0) {
    throw new Error(`COHORT_SUPERVISOR_IDS must include a current non-bot Discord account in ${expectedCohort}`);
  }
}

function stopLocal(reason) {
  if (stopping) return;
  stopping = true;
  console.log(`[failover] ${reason}; stopping the local bot before primary operation continues`);
  if (child && !child.killed) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1000).unref();
}

async function main() {
  await validateIdentity();
  const primary = await primaryStatus();
  if (primary.healthy) throw new Error('Render primary is already healthy');
  console.log(`[failover] Primary unavailable (HTTP ${primary.status || 'network'}); starting guarded local bot for ${expectedCohort}`);
  child = spawn(process.execPath, ['index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: process.env.LOCAL_FAILOVER_PORT || '3100',
      LOCAL_FAILOVER_CHILD: 'true',
      // A failover is an emergency replacement, not a scheduled cost-saving
      // service. Keep its gateway online across midnight until Render recovers.
      BOT_ACTIVE_WINDOW: 'always',
    },
    stdio: 'inherit',
  });
  child.once('exit', code => {
    if (!stopping) {
      console.error(`[failover] Local bot exited with status ${code}`);
      process.exitCode = code || 1;
    }
  });
  const timer = setInterval(async () => {
    const status = await primaryStatus();
    if (status.healthy) {
      clearInterval(timer);
      stopLocal('Render primary is healthy again');
    }
  }, checkEveryMs);
}

process.on('SIGINT', () => stopLocal('Operator requested shutdown'));
process.on('SIGTERM', () => stopLocal('Operator requested shutdown'));

main().catch(error => fail(error.message));
