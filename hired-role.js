const HIRED_ROLE_NAME = 'Hired';
const HIRED_ROLE_ALIASES = new Set(['hired', 'successfully hired']);

function normalizeRoleName(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

function findHiredRole(roles) {
  return [...roles].find(role => HIRED_ROLE_ALIASES.has(normalizeRoleName(role.name))) || null;
}

async function ensureHiredRole(guild) {
  const roles = await guild.roles.fetch();
  let role = findHiredRole(roles.values());
  if (!role) {
    role = await guild.roles.create({
      name: HIRED_ROLE_NAME,
      colors: { primaryColor: 0x2ecc71 },
      reason: 'JP ADMIN hired-student role',
    });
  }

  const botMember = guild.members.me || await guild.members.fetchMe();
  if (!botMember || role.position >= botMember.roles.highest.position) {
    throw new Error(`move the bot role above @${role.name}, then retry`);
  }
  return role;
}

async function assignHiredRole(guild, discordIds) {
  const role = await ensureHiredRole(guild);
  const uniqueIds = [...new Set((discordIds || []).map(String).filter(Boolean))];
  const result = { role, assigned: [], already: [], missing: [], failed: [] };

  for (const id of uniqueIds) {
    try {
      const member = await guild.members.fetch(id);
      if (!member) { result.missing.push(id); continue; }
      if (member.roles.cache.has(role.id)) result.already.push(id);
      else {
        await member.roles.add(role, 'JP ADMIN: student marked hired');
        result.assigned.push(id);
      }
    } catch (error) {
      if (error?.code === 10007) result.missing.push(id);
      else result.failed.push({ id, error: String(error?.message || error).slice(0, 160) });
    }
  }
  try {
    const { clearStatusRolesForIds } = require('./student-access');
    result.statusRoles = await clearStatusRolesForIds(guild, [...result.assigned, ...result.already]);
  } catch (error) {
    result.statusRoles = {
      cleared: [], missing: [],
      failed: [{ id: '', error: String(error.message || error).slice(0, 160) }],
    };
  }
  return result;
}

module.exports = { HIRED_ROLE_NAME, normalizeRoleName, findHiredRole, ensureHiredRole, assignHiredRole };
