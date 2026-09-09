'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { appsScriptGet, appsScriptPost } = require('./apps-script-api');

// Public workflow channels stay out of a new student's way until their
// matching programme is enabled. Core channels (welcome, rules, discussion,
// resources, resumes, projects, jobs, issues and mentor channels) are never
// hidden by this module.
const VISIBILITY_GROUPS = Object.freeze([
  { label: 'outreach', channelKeys: ['outreach'], automationKeys: ['outreach', 'outreachprompt'] },
  { label: 'interviews', channelKeys: ['interviewUpdates'], automationKeys: ['interviewprompt', 'interviewfollowup'] },
  { label: 'communication', channelKeys: ['workshop'], automationKeys: ['workshop', 'communicationprompt'] },
  { label: 'right-to-be-referred', channelKeys: ['rtbr'], automationKeys: ['rtbr'] },
  { label: 'Dawn Focus', channelKeys: ['discipline', 'groupActivities'], automationKeys: ['discipline', 'specialworkshop'] },
]);

function desiredVisibility(states, group) {
  return group.automationKeys.some(key => states[key] === true);
}

function visibilityPlan(states) {
  return VISIBILITY_GROUPS.map(group => ({
    ...group,
    visible: desiredVisibility(states, group),
  }));
}

function baselineKey(cohort) {
  return `automation_channel_visibility_v1_${cohort.guildId}`;
}

function currentEveryoneView(channel, guild) {
  const overwrite = channel.permissionOverwrites.cache.get(guild.roles.everyone.id);
  if (overwrite?.allow?.has(PermissionFlagsBits.ViewChannel)) return 'allow';
  if (overwrite?.deny?.has(PermissionFlagsBits.ViewChannel)) return 'deny';
  return 'inherit';
}

async function loadBaselines(cohort) {
  const result = await appsScriptGet(cohort, { action: 'getstate', k: baselineKey(cohort) }, {
    label: 'Automation channel visibility baseline read',
  });
  try {
    const parsed = JSON.parse(String(result.value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

async function saveBaselines(cohort, baselines) {
  await appsScriptPost(cohort, {
    action: 'setState', k: baselineKey(cohort), v: JSON.stringify(baselines),
  }, { idempotent: true, label: 'Automation channel visibility baseline write' });
}

async function resolveMemberTarget(guild, id) {
  const cached = guild.members.resolve?.(id);
  if (cached) return cached.user;
  const member = await guild.members.fetch(id).catch(() => null);
  return member?.user || null;
}

async function setChannelVisibility(channel, visible, guild, client, cohort, baseline = 'inherit') {
  const restoredView = baseline === 'allow' ? true : baseline === 'deny' ? false : null;
  await channel.permissionOverwrites.edit(guild.roles.everyone, {
    ViewChannel: visible ? restoredView : false,
  }, { reason: `JP ADMIN automation channel ${visible ? 'enabled' : 'held'}` });

  if (!visible) {
    const privilegedIds = [...new Set([...(cohort.supervisorIds || []), client.user.id])];
    for (const id of privilegedIds) {
      const target = id === client.user.id ? client.user : await resolveMemberTarget(guild, id);
      if (!target) continue;
      await channel.permissionOverwrites.edit(target, { ViewChannel: true }, {
        reason: 'JP ADMIN keeps held channels available to supervisors and the bot',
      });
    }
  }
}

async function syncAutomationChannelVisibility(client, cohort, states) {
  const guild = client.guilds.cache.get(cohort.guildId) || await client.guilds.fetch(cohort.guildId);
  await guild.channels.fetch();
  const updated = [];
  const missing = [];
  const failed = [];
  const baselines = await loadBaselines(cohort);
  let baselinesChanged = false;
  const work = [];
  for (const item of visibilityPlan(states)) {
    for (const channelKey of item.channelKeys) {
      const id = cohort.channels?.[channelKey];
      const channel = id ? guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null) : null;
      if (!channel?.permissionOverwrites) {
        missing.push(channelKey);
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(baselines, channel.id)) {
        baselines[channel.id] = currentEveryoneView(channel, guild);
        baselinesChanged = true;
      }
      work.push({ item, channelKey, channel });
    }
  }
  // Persist original overwrites before the first hide. A later start can then
  // restore an intentional pre-existing deny/allow instead of assuming public.
  if (baselinesChanged) await saveBaselines(cohort, baselines);
  for (const { item, channelKey, channel } of work) {
      try {
        await setChannelVisibility(channel, item.visible, guild, client, cohort, baselines[channel.id]);
        updated.push({ channelKey, channelId: channel.id, visible: item.visible });
      } catch (error) {
        failed.push(`${channel.name || channelKey}: ${error.message}`);
      }
  }
  return { updated, missing, failed };
}

module.exports = {
  VISIBILITY_GROUPS,
  baselineKey,
  currentEveryoneView,
  desiredVisibility,
  setChannelVisibility,
  syncAutomationChannelVisibility,
  visibilityPlan,
};
