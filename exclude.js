// ============================================================
// exclude.js - supervisor-controlled active/inactive status.
// Inactive students remain in the Sheet but are removed from warnings,
// mentions, checks, and DMs until reactivated.
// ============================================================
const { cohorts } = require('./config');
const { clearCache, excluded, getRoster, isExcluded, syncMembers } = require('./roster');
const { appsScriptGet, appsScriptPost } = require('./apps-script-api');
const { dateKeyInZone } = require('./work-calendar');

function inactiveMetadataKey(cohort) {
  return `inactive_student_meta_v1_${cohort.guildId}`;
}

async function getInactiveMetadata(cohort) {
  const data = await appsScriptGet(cohort, {
    action: 'getstate', k: inactiveMetadataKey(cohort),
  }, { label: 'Inactive-student metadata read' });
  try {
    const value = JSON.parse(String(data.value || '{}'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

async function saveInactiveMetadata(cohort, metadata) {
  await appsScriptPost(cohort, {
    action: 'setState', k: inactiveMetadataKey(cohort),
    v: JSON.stringify(metadata || {}),
  }, { idempotent: true, label: 'Inactive-student metadata write' });
}

async function saveList(cohort, set) {
  await appsScriptPost(cohort, {
    action: 'setState',
    k: `excl_${cohort.guildId}`,
    v: [...set].join(','),
  }, { idempotent: true, label: 'Student active-status write' });
  excluded[cohort.guildId] = set;
  clearCache(cohort);
}

async function setStudentsInactive(cohort, discordIds, options = {}) {
  await getRoster(cohort);
  const ids = [...new Set((discordIds || []).map(value => String(value || '').trim())
    .filter(id => id && !cohort.supervisorIds.includes(id)))];
  if (!ids.length) return { deactivated: [], failures: [], added: 0, total: 0, metadataChanged: false };
  const result = await appsScriptPost(cohort, {
    action: 'deactivateStudents', guildId: cohort.guildId, discordIds: ids,
    date: String(options.date || dateKeyInZone(cohort.timezone)),
    source: String(options.source || 'manual').slice(0, 80),
    reason: String(options.reason || 'Marked inactive by a mentor').slice(0, 500),
    ...(options.warningState ? { warningState: options.warningState } : {}),
  }, { idempotent: true, label: 'Verified student inactivation' });
  const current = new Set(excluded[cohort.guildId] || []);
  for (const id of result.deactivated || []) current.add(String(id));
  excluded[cohort.guildId] = current;
  clearCache(cohort);
  if (options.client && (result.deactivated || []).length) {
    try {
      const { syncStatusRolesForIds } = require('./student-access');
      result.roleSync = await syncStatusRolesForIds(
        options.client, cohort, result.deactivated, { forceRoster: true });
    } catch (error) {
      result.roleSync = { failed: [{ id: '', error: String(error.message || error).slice(0, 180) }] };
    }
  }
  return result;
}

async function clearAttendanceWarnings(cohort, discordId) {
  const result = await resetAttendanceWarnings(cohort, discordId);
  return result.hadRecord;
}

async function getAttendanceWarningState(cohort) {
  const key = `attendance_warning_state_v1_${cohort.guildId}`;
  const data = await appsScriptGet(cohort, { action: 'getstate', k: key }, {
    label: 'Attendance warning state read',
  });
  let state = {};
  try { state = JSON.parse(String(data.value || '{}')); } catch { state = {}; }
  return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
}

async function saveAttendanceWarningState(cohort, state) {
  const key = `attendance_warning_state_v1_${cohort.guildId}`;
  await appsScriptPost(cohort, { action: 'setState', k: key, v: JSON.stringify(state || {}) }, {
    idempotent: true, label: 'Attendance warning state write',
  });
}

async function resetAttendanceWarnings(cohort, discordId) {
  const id = String(discordId || '').trim();
  const state = await getAttendanceWarningState(cohort);
  const hadRecord = Object.prototype.hasOwnProperty.call(state, id);
  if (!hadRecord) return { hadRecord: false, previousCount: 0 };
  const previousCount = Number(state[id]?.count || 0);
  delete state[id];
  await saveAttendanceWarningState(cohort, state);
  return { hadRecord: true, previousCount };
}

async function setStudentsActive(client, cohort, discordIds, options = {}) {
  const ids = [...new Set((discordIds || []).map(value => String(value || '').trim())
    .filter(id => id && !cohort.supervisorIds.includes(id)))];
  if (!ids.length) return { activated: [], failures: [] };

  // One Discord-primary reconciliation and one final roster verification are
  // enough for a whole button/date/all activation batch.
  if (!options.skipSync) await syncMembers(client, cohort, { force: true });
  const backend = await appsScriptPost(cohort, {
    action: 'activateStudents', discordIds: ids, guildId: cohort.guildId,
  }, { idempotent: true, label: 'Verified student activation batch' });
  const backendResults = new Map((backend.activated || [])
    .map(result => [String(result.discordId || ''), result]));
  const failures = (backend.failures || []).map(item => ({
    discordId: String(item.discordId || ''),
    error: String(item.error || 'Backend activation failed').slice(0, 250),
  }));

  clearCache(cohort);
  const roster = await getRoster(cohort, true);
  const byId = new Map(roster.map(entry => [String(entry.discordId || ''), entry]));
  const activated = [];
  for (const [id, result] of backendResults) {
    const student = byId.get(id);
    if (!student) {
      failures.push({ discordId: id, error: 'Student is not linked in Bot_Map after activation' });
      continue;
    }
    if (isExcluded(cohort, student)) {
      const reason = student.status === 'hired' || student.status === 'left'
        ? `status is ${student.status}`
        : (student.inactiveReasons || []).join('; ') || 'an inactive marker remains';
      failures.push({ discordId: id, error: `Activation could not be verified: ${reason}` });
      continue;
    }
    activated.push({
      ...result,
      active: true,
      student,
      wasInactive: true,
      warningReset: {
        hadRecord: Number(result.previousWarningCount || 0) > 0,
        previousCount: Number(result.previousWarningCount || 0),
      },
    });
  }

  let roleSync = null;
  if (activated.length) {
    try {
      const { syncStatusRolesForIds } = require('./student-access');
      roleSync = await syncStatusRolesForIds(
        client, cohort, activated.map(item => item.student.discordId), { roster });
    } catch (error) {
      roleSync = { failed: [{ id: '', error: String(error.message || error).slice(0, 180) }] };
    }
  }

  return { activated, failures, roleSync };
}

async function setStudentActive(client, cohort, discordId, options = {}) {
  const id = String(discordId || '').trim();
  if (!id) throw new Error('Discord student ID is required');
  const result = await setStudentsActive(client, cohort, [id], options);
  if (result.failures.length) throw new Error(result.failures[0].error);
  if (!result.activated.length) throw new Error('Student activation could not be verified');
  return { ...result.activated[0], roleSync: result.roleSync };
}

function commandTargetId(msg) {
  return msg.mentions.users.first()?.id || msg.content.match(/\b(\d{16,22})\b/)?.[1] || '';
}

module.exports = function registerExclude(client) {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    const lower = msg.content.trim().toLowerCase();
    const command = lower.split(/\s+/)[0];
    const statusCommand = command === '!studentstatus';
    if (!['!exclude', '!include', '!excluded', '!studentstatus'].includes(command)) return;
    const cohort = cohorts.find(item => item.guildId === msg.guildId);
    if (!cohort || !cohort.supervisorIds.includes(msg.author.id)) return;
    if (msg.channelId !== cohort.channels.supervisor) {
      await msg.reply(`Run student status controls in <#${cohort.channels.supervisor}>.`);
      return;
    }

    try {
      // Load the durable exclusion list before editing it. Without this read,
      // the first status command after a Render restart could overwrite an
      // older saved list with only the newly selected student.
      await getRoster(cohort);
      const current = new Set(excluded[cohort.guildId] || []);
      if (lower === '!excluded' || lower === '!studentstatus' || lower === '!studentstatus list') {
        const list = [...current].map(id => `• <@${id}>`).join('\n') || '— nobody manually inactive';
        await msg.channel.send({
          content: `🚫 **Manually inactive students:**\n${list}\n\nUse \`!studentstatus @student active|inactive\`.`,
          allowedMentions: { parse: [] },
        });
        return;
      }

      const targetId = commandTargetId(msg);
      const member = targetId ? await msg.guild.members.fetch(targetId).catch(() => null) : null;
      const target = member?.user || null;
      if (!member || !target) {
        await msg.reply(statusCommand
          ? 'Usage: `!studentstatus @student active|inactive`'
          : `Usage: \`${command === '!exclude' ? '!exclude' : '!include'} @student\``);
        return;
      }
      if (target.bot || cohort.supervisorIds.includes(target.id)) {
        await msg.reply('Choose a current non-bot student in this cohort.');
        return;
      }

      const requestedStatus = statusCommand
        ? (lower.match(/\b(active|inactive)\b/)?.[1] || '')
        : (command === '!exclude' ? 'inactive' : 'active');
      if (!requestedStatus) {
        await msg.reply('Usage: `!studentstatus @student active|inactive`');
        return;
      }

      if (requestedStatus === 'inactive') {
        const result = await setStudentsInactive(cohort, [target.id], {
          client,
          source: 'manual', reason: 'Marked inactive by a mentor',
        });
        if (result.failures?.length || !(result.deactivated || []).includes(target.id)) {
          throw new Error(result.failures?.[0]?.error || 'Student inactivation could not be verified');
        }
        const roleIssues = (result.roleSync?.missing?.length || 0) + (result.roleSync?.failed?.length || 0);
        await msg.reply(`🚫 **${target.username}** is now inactive and excluded from warnings, mentions, checks, and DMs. The mutually exclusive Inactive Student role was reconciled${roleIssues ? ` with **${roleIssues} role issue(s)**; run \`!statusroles\` after fixing hierarchy` : ''}. Undo with \`!studentstatus ${target.id} active\`.`);
        return;
      }
      const result = await setStudentActive(client, cohort, target.id);
      const roleIssues = (result.roleSync?.missing?.length || 0) + (result.roleSync?.failed?.length || 0);
      await msg.reply(`✅ **${target.username}** is verified active in Discord, Bot_Map, Attendance, and all student automations. Their attendance warning counter is now **0/3**${result.warningReset.hadRecord ? ` (reset from ${result.warningReset.previousCount}/3)` : ''}. Active/Inactive roles were reconciled${roleIssues ? ` with **${roleIssues} issue(s)**; run \`!statusroles\`` : ''}.`);
    } catch (error) {
      await msg.reply(`❌ Student status was not changed: ${String(error.message || error).slice(0, 400)}`);
    }
  });
};

module.exports.commandTargetId = commandTargetId;
module.exports.saveList = saveList;
module.exports.setStudentsInactive = setStudentsInactive;
module.exports.clearAttendanceWarnings = clearAttendanceWarnings;
module.exports.getAttendanceWarningState = getAttendanceWarningState;
module.exports.getInactiveMetadata = getInactiveMetadata;
module.exports.resetAttendanceWarnings = resetAttendanceWarnings;
module.exports.saveAttendanceWarningState = saveAttendanceWarningState;
module.exports.saveInactiveMetadata = saveInactiveMetadata;
module.exports.setStudentActive = setStudentActive;
module.exports.setStudentsActive = setStudentsActive;
