'use strict';

// Bot_Map/manual exclusion is the durable status source. Discord roles are a
// synchronized, mutually-exclusive access projection of that status.

const { cohorts } = require('./config');
const { appsScriptGet, appsScriptPost } = require('./apps-script-api');
const { getRoster, isExcluded } = require('./roster');

const ACTIVE_ROLE_NAME = 'Active Student';
const INACTIVE_ROLE_NAME = 'Inactive Student';
const ACTIVE_ROLE_ALIASES = new Set(['active', 'active student', 'active students']);
const INACTIVE_ROLE_ALIASES = new Set(['inactive', 'inactive student', 'inactive students']);

function normalizeRoleName(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

function findRoleByAliases(roles, aliases) {
  return [...roles].find(role => aliases.has(normalizeRoleName(role?.name))) || null;
}

function accessRulesKey(cohort) {
  return `student_access_rules_v1_${cohort.guildId}`;
}

function normalizeAccessRules(value) {
  const byPair = new Map();
  for (const item of (Array.isArray(value) ? value : [])) {
    const roleId = String(item?.roleId || '').trim();
    const channelId = String(item?.channelId || '').trim();
    const view = String(item?.view || '').trim().toLowerCase();
    if (!/^\d{15,22}$/.test(roleId) || !/^\d{15,22}$/.test(channelId) ||
        !['allow', 'deny'].includes(view)) continue;
    byPair.set(`${roleId}:${channelId}`, { roleId, channelId, view });
  }
  return [...byPair.values()];
}

function upsertAccessRule(rules, rule) {
  return normalizeAccessRules([...(rules || []).filter(item =>
    !(String(item.roleId) === String(rule.roleId) &&
      String(item.channelId) === String(rule.channelId))), rule]);
}

function removeAccessRule(rules, roleId, channelId) {
  return normalizeAccessRules(rules).filter(item =>
    !(item.roleId === String(roleId) && item.channelId === String(channelId)));
}

function normalizeAccessAction(value) {
  const action = String(value || '').trim().toLowerCase();
  if (action === 'block') return 'deny';
  if (action === 'unblock') return 'remove';
  return action;
}

async function ensureManagedStatusRoles(guild) {
  const roles = await guild.roles.fetch();
  let active = findRoleByAliases(roles.values(), ACTIVE_ROLE_ALIASES);
  let inactive = findRoleByAliases(roles.values(), INACTIVE_ROLE_ALIASES);
  if (!active) {
    active = await guild.roles.create({
      name: ACTIVE_ROLE_NAME, colors: { primaryColor: 0x3498db },
      reason: 'JP ADMIN active-student access role',
    });
  }
  if (!inactive) {
    inactive = await guild.roles.create({
      name: INACTIVE_ROLE_NAME, colors: { primaryColor: 0xe74c3c },
      reason: 'JP ADMIN inactive-student access role',
    });
  }
  const botMember = guild.members.me || await guild.members.fetchMe();
  if (!botMember || active.position >= botMember.roles.highest.position ||
      inactive.position >= botMember.roles.highest.position) {
    throw new Error(`move the bot role above @${active.name} and @${inactive.name}, then retry`);
  }
  return { active, inactive };
}

async function setMemberStatusRole(member, status, roles) {
  const target = String(status || '').toLowerCase();
  const hasActive = member.roles.cache.has(roles.active.id);
  const hasInactive = member.roles.cache.has(roles.inactive.id);
  const changed = [];
  if (target === 'active') {
    if (hasInactive) {
      await member.roles.remove(roles.inactive, 'JP ADMIN: student status is active');
      changed.push('removed-inactive');
    }
    if (!hasActive) {
      await member.roles.add(roles.active, 'JP ADMIN: student status is active');
      changed.push('added-active');
    }
  } else if (target === 'inactive') {
    if (hasActive) {
      await member.roles.remove(roles.active, 'JP ADMIN: student status is inactive');
      changed.push('removed-active');
    }
    if (!hasInactive) {
      await member.roles.add(roles.inactive, 'JP ADMIN: student status is inactive');
      changed.push('added-inactive');
    }
  } else {
    if (hasActive) {
      await member.roles.remove(roles.active, 'JP ADMIN: student is no longer active/inactive tracked');
      changed.push('removed-active');
    }
    if (hasInactive) {
      await member.roles.remove(roles.inactive, 'JP ADMIN: student is no longer active/inactive tracked');
      changed.push('removed-inactive');
    }
  }
  return changed;
}

async function syncStatusRolesForIds(client, cohort, discordIds, options = {}) {
  const guild = options.guild || await client.guilds.fetch(cohort.guildId);
  const roles = options.roles || await ensureManagedStatusRoles(guild);
  const roster = options.roster || await getRoster(cohort, Boolean(options.forceRoster));
  const byId = new Map(roster.map(student => [String(student.discordId || ''), student]));
  const ids = [...new Set((discordIds || []).map(String).filter(Boolean))];
  const result = { active: 0, inactive: 0, cleared: 0, unchanged: 0, missing: [], failed: [] };
  for (const id of ids) {
    if (cohort.supervisorIds.includes(id)) continue;
    const student = byId.get(id);
    if (!student) {
      result.failed.push({ id, error: 'not linked in the current Bot_Map roster' });
      continue;
    }
    let status = 'active';
    if (student.status === 'hired' || student.status === 'left') status = 'cleared';
    else if (isExcluded(cohort, student)) status = 'inactive';
    try {
      const member = await guild.members.fetch(id);
      const changes = await setMemberStatusRole(member, status, roles);
      if (!changes.length) result.unchanged++;
      else result[status]++;
    } catch (error) {
      if (error?.code === 10007) result.missing.push(id);
      else result.failed.push({ id, error: String(error?.message || error).slice(0, 180) });
    }
  }
  return { ...result, roles };
}

async function syncAllStatusRoles(client, cohort, options = {}) {
  const roster = options.roster || await getRoster(cohort, true);
  return syncStatusRolesForIds(client, cohort,
    roster.map(student => student.discordId).filter(Boolean), { ...options, roster });
}

async function clearStatusRolesForIds(guild, discordIds) {
  const roles = await ensureManagedStatusRoles(guild);
  const result = { cleared: [], missing: [], failed: [] };
  for (const id of [...new Set((discordIds || []).map(String).filter(Boolean))]) {
    try {
      const member = await guild.members.fetch(id);
      await setMemberStatusRole(member, 'cleared', roles);
      result.cleared.push(id);
    } catch (error) {
      if (error?.code === 10007) result.missing.push(id);
      else result.failed.push({ id, error: String(error?.message || error).slice(0, 180) });
    }
  }
  return result;
}

async function loadAccessRules(cohort) {
  const result = await appsScriptGet(cohort, { action: 'getstate', k: accessRulesKey(cohort) }, {
    label: 'Student access-rule read',
  });
  try { return normalizeAccessRules(JSON.parse(String(result.value || '[]'))); }
  catch { return []; }
}

async function saveAccessRules(cohort, rules) {
  const normalized = normalizeAccessRules(rules);
  await appsScriptPost(cohort, {
    action: 'setState', k: accessRulesKey(cohort), v: JSON.stringify(normalized),
  }, { idempotent: true, label: 'Student access-rule write' });
  return normalized;
}

async function applyAccessRules(guild, rules) {
  const result = { applied: [], missing: [], failed: [] };
  for (const rule of normalizeAccessRules(rules)) {
    const role = await guild.roles.fetch(rule.roleId).catch(() => null);
    const channel = await guild.channels.fetch(rule.channelId).catch(() => null);
    if (!role || !channel || !channel.permissionOverwrites) {
      result.missing.push(rule);
      continue;
    }
    try {
      await channel.permissionOverwrites.edit(role, {
        ViewChannel: rule.view === 'allow' ? true : false,
      }, { reason: 'JP ADMIN configured role/channel access rule' });
      result.applied.push(rule);
    } catch (error) {
      result.failed.push({ ...rule, error: String(error?.message || error).slice(0, 180) });
    }
  }
  return result;
}

async function clearAccessOverwrite(guild, roleId, channelId) {
  const role = await guild.roles.fetch(roleId).catch(() => null);
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!role || !channel || !channel.permissionOverwrites) throw new Error('role or channel no longer exists');
  await channel.permissionOverwrites.edit(role, { ViewChannel: null }, {
    reason: 'JP ADMIN removed configured role/channel access rule',
  });
}

function mentionedId(content, kind) {
  const pattern = kind === 'role' ? /<@&(\d{15,22})>/ : /<#(\d{15,22})>/;
  return String(content || '').match(pattern)?.[1] || '';
}

async function defaultJobPostRules(guild, cohort) {
  const roles = await ensureManagedStatusRoles(guild);
  const channelId = cohort.channels.jobPosts || '';
  if (!channelId) throw new Error('job-posts/job-opportunities channel is not configured or discoverable');
  return [{ roleId: roles.inactive.id, channelId, view: 'deny' }];
}

function accessRuleLines(guild, rules) {
  if (!rules.length) return ['— no configured role/channel visibility rules'];
  return rules.map(rule => {
    const role = guild.roles.cache.get(rule.roleId);
    const channel = guild.channels.cache.get(rule.channelId);
    return `• ${rule.view === 'deny' ? '🚫' : '✅'} ${role ? `@${role.name}` : `role ${rule.roleId}`} → ${channel ? `#${channel.name}` : `channel ${rule.channelId}`}`;
  });
}

module.exports = function registerStudentAccess(client) {
  client.on('guildMemberAdd', member => {
    const cohort = cohorts.find(item => item.guildId === member.guild.id);
    if (!cohort || member.user.bot || cohort.supervisorIds.includes(member.id)) return;
    const timer = setTimeout(async () => {
      try {
        await syncStatusRolesForIds(client, cohort, [member.id], { forceRoster: true });
      } catch (error) {
        console.error(`[student-access] ${cohort.name}: join status-role sync failed:`, error.message);
      }
    }, 90_000);
    timer.unref?.();
  });

  client.once('clientReady', () => {
    const timer = setTimeout(async () => {
      for (const cohort of cohorts) {
        try {
          const guild = await client.guilds.fetch(cohort.guildId);
          const status = await syncAllStatusRoles(client, cohort);
          const rules = await loadAccessRules(cohort);
          const access = rules.length ? await applyAccessRules(guild, rules) : { applied: [], failed: [], missing: [] };
          console.log(`[student-access] ${cohort.name}: status-role changes ${status.active}/${status.inactive}/${status.cleared}; access rules ${access.applied.length}`);
        } catch (error) {
          console.error(`[student-access] ${cohort.name}: startup reconciliation failed:`, error.message);
        }
      }
    }, 75_000);
    timer.unref?.();
  });

  client.on('messageCreate', async msg => {
    if (msg.author.bot) return;
    const content = msg.content.trim();
    const command = content.toLowerCase().split(/\s+/)[0];
    if (!['!statusroles', '!accessrules'].includes(command)) return;
    const cohort = cohorts.find(item => item.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;
    if (msg.channelId !== cohort.channels.supervisor) {
      await msg.reply(`Run access controls in <#${cohort.channels.supervisor}>.`);
      return;
    }
    try {
      if (command === '!statusroles') {
        await msg.reply('🔄 Reconciling every current student with the mutually exclusive **Active Student / Inactive Student** roles...');
        const result = await syncAllStatusRoles(client, cohort);
        await msg.channel.send({
          content: [
            `✅ **Student status-role sync — ${cohort.name}**`,
            `• Changed to active: **${result.active}**`,
            `• Changed to inactive: **${result.inactive}**`,
            `• Cleared from hired/left students: **${result.cleared}**`,
            `• Already correct: **${result.unchanged}**`,
            `• Not in server: **${result.missing.length}**`,
            `• Failed: **${result.failed.length}**`,
            result.failed.length ? `\n${result.failed.slice(0, 8).map(item => `• ${item.id}: ${item.error}`).join('\n')}` : '',
          ].filter(Boolean).join('\n'),
          allowedMentions: { parse: [] },
        });
        return;
      }

      const args = content.split(/\s+/);
      const action = normalizeAccessAction(args[1] || 'list');
      let rules = await loadAccessRules(cohort);
      if (['list', 'status'].includes(action)) {
        await msg.channel.send({
          content: [
            `🔐 **Role/channel access rules — ${cohort.name}**`,
            ...accessRuleLines(msg.guild, rules), '',
            '`!accessrules block @role #channel` · `unblock` · `allow` · `defaults` · `apply`',
          ].join('\n'),
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (action === 'defaults') {
        const defaults = await defaultJobPostRules(msg.guild, cohort);
        for (const rule of defaults) rules = upsertAccessRule(rules, rule);
        await saveAccessRules(cohort, rules);
        const applied = await applyAccessRules(msg.guild, defaults);
        await msg.reply(`✅ Default restriction saved and applied: inactive students cannot view <#${cohort.channels.jobPosts}>. Hired students remain unchanged unless you add a separate rule. Applied **${applied.applied.length}**, issues **${applied.missing.length + applied.failed.length}**.`);
        return;
      }
      if (action === 'apply') {
        const applied = await applyAccessRules(msg.guild, rules);
        await msg.reply(`✅ Reapplied **${applied.applied.length}** rule(s). Missing: **${applied.missing.length}** · failed: **${applied.failed.length}**.`);
        return;
      }
      if (!['allow', 'deny', 'remove'].includes(action)) {
        await msg.reply('Use `!accessrules list|defaults|apply|block @role #channel|unblock @role #channel|allow @role #channel`. `deny` and `remove` remain supported aliases.');
        return;
      }
      const roleId = mentionedId(content, 'role');
      const channelId = mentionedId(content, 'channel');
      if (!roleId || !channelId) {
        await msg.reply(`Usage: \`!accessrules ${action} @role #channel\``);
        return;
      }
      if (action === 'remove') {
        await clearAccessOverwrite(msg.guild, roleId, channelId);
        await saveAccessRules(cohort, removeAccessRule(rules, roleId, channelId));
        await msg.reply(`✅ Removed the JP ADMIN View Channel rule for <@&${roleId}> in <#${channelId}>. Discord/category inheritance now applies.`);
        return;
      }
      const rule = { roleId, channelId, view: action };
      await saveAccessRules(cohort, upsertAccessRule(rules, rule));
      const applied = await applyAccessRules(msg.guild, [rule]);
      if (!applied.applied.length) throw new Error(applied.failed[0]?.error || 'role/channel no longer exists');
      await msg.reply(`${action === 'deny' ? '🚫' : '✅'} <@&${roleId}> is now ${action === 'deny' ? 'hidden from' : 'allowed to view'} <#${channelId}>.`);
    } catch (error) {
      await msg.reply(`❌ Student access control failed: ${String(error.message || error).slice(0, 350)}`);
    }
  });
};

module.exports.ACTIVE_ROLE_NAME = ACTIVE_ROLE_NAME;
module.exports.INACTIVE_ROLE_NAME = INACTIVE_ROLE_NAME;
module.exports.applyAccessRules = applyAccessRules;
module.exports.clearStatusRolesForIds = clearStatusRolesForIds;
module.exports.defaultJobPostRules = defaultJobPostRules;
module.exports.ensureManagedStatusRoles = ensureManagedStatusRoles;
module.exports.normalizeAccessRules = normalizeAccessRules;
module.exports.normalizeAccessAction = normalizeAccessAction;
module.exports.removeAccessRule = removeAccessRule;
module.exports.setMemberStatusRole = setMemberStatusRole;
module.exports.syncAllStatusRoles = syncAllStatusRoles;
module.exports.syncStatusRolesForIds = syncStatusRolesForIds;
module.exports.upsertAccessRule = upsertAccessRule;
