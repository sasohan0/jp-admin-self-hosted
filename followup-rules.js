'use strict';

const { calendarDecision, shiftDateKey, validDateKey } = require('./work-calendar');

const KIND_ALIASES = Object.freeze({
  dawnjoin: 'dawnjoin',
  'dawn-join': 'dawnjoin',
  dawnmembers: 'dawnjoin',
  jobsheet: 'jobsheet',
  jobsheets: 'jobsheet',
  tracker: 'jobsheet',
  trackers: 'jobsheet',
  profile: 'profile',
  onboarding: 'profile',
  completion: 'profile',
  attendance: 'attendance',
  absent: 'attendance',
  interview: 'interview',
  interviews: 'interview',
  jobs: 'jobs',
  applications: 'jobs',
  outreach: 'outreach',
  dawn: 'dawn',
  communication: 'communication',
  workshop: 'workshop',
  workshops: 'workshop',
});

const DEFAULT_THRESHOLDS = Object.freeze({
  dawnjoin: 1,
  jobsheet: 1,
  profile: 1,
  attendance: 1,
  interview: 5,
  jobs: 1,
  outreach: 1,
  dawn: 1,
  communication: 7,
  workshop: 7,
});

function parseFollowupCommand(content) {
  const text = String(content || '').trim();
  if (!/^!followup(?:\s|$)/i.test(text)) return null;
  const rest = text.replace(/^!followup\s*/i, '').trim();
  if (!rest || /^help$/i.test(rest)) return { action: 'help' };
  const tokens = rest.split(/\s+/);
  const rawKind = String(tokens.shift() || '').toLowerCase();
  const kind = KIND_ALIASES[rawKind] || '';
  if (!kind) return { action: 'invalid', rawKind };
  let threshold = DEFAULT_THRESHOLDS[kind];
  let channelId = '';
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const channel = token.match(/^<#(\d{15,22})>$/)?.[1];
    if (channel) {
      channelId = channel;
      continue;
    }
    if (/^days?$/i.test(token) && /^\d+$/.test(tokens[index + 1] || '')) {
      threshold = Number(tokens[++index]);
      continue;
    }
    if (/^\d+$/.test(token)) threshold = Number(token);
  }
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 31) {
    return { action: 'invalid-threshold', kind };
  }
  return { action: 'preview', kind, threshold, channelId };
}

function workingDatesBetween(calendar, start, end) {
  if (!validDateKey(start) || !validDateKey(end) || start > end) return [];
  const result = [];
  for (let date = start, guard = 0; date <= end && guard < 370; date = shiftDateKey(date, 1), guard++) {
    if (calendarDecision(calendar, date).working) result.push(date);
  }
  return result;
}

function currentGuildStudents(students, memberIds) {
  const ids = memberIds instanceof Set ? memberIds : new Set(memberIds || []);
  return (students || []).filter(student => student.discordId && ids.has(String(student.discordId)));
}

function byEmail(items) {
  return new Map((items || []).map(item => [String(item.email || '').trim().toLowerCase(), item]));
}

function quotaGapStudents({ students, roster, dates, target, daysKey, minMissedDays = 1 }) {
  const data = byEmail(students);
  const safeTarget = Math.max(1, Number(target) || 1);
  const today = dates[dates.length - 1] || '';
  return (roster || []).map(student => {
    const metrics = data.get(String(student.email || '').trim().toLowerCase()) || {};
    const counts = metrics[daysKey] || {};
    const leaveDays = metrics.leaveDays || {};
    const accountableDates = dates.filter(date => !leaveDays[date]);
    const missedDates = accountableDates.filter(date => Number(counts[date] || 0) < safeTarget);
    const total = accountableDates.reduce((sum, date) => sum + Number(counts[date] || 0), 0);
    const goal = accountableDates.length * safeTarget;
    const todayCount = Number(counts[today] || 0);
    const todayOnLeave = Boolean(leaveDays[today]);
    return {
      ...student,
      counts,
      leaveDays,
      accountableDates,
      missedDates,
      missedDays: missedDates.length,
      total,
      goal,
      weekGap: Math.max(0, goal - total),
      today,
      todayCount,
      todayGap: todayOnLeave ? 0 : Math.max(0, safeTarget - todayCount),
      todayOnLeave,
      target: safeTarget,
    };
  }).filter(student => student.missedDays >= minMissedDays);
}

function zeroActivityStudents(students, roster, field) {
  const data = byEmail(students);
  return (roster || []).filter(student =>
    Number(data.get(String(student.email || '').trim().toLowerCase())?.[field] || 0) === 0);
}

function targetGapStudents(students, roster, field, target) {
  const data = byEmail(students);
  const safeTarget = Math.max(0, Number(target) || 0);
  return (roster || []).map(student => {
    const count = Number(data.get(String(student.email || '').trim().toLowerCase())?.[field] || 0);
    return { ...student, count, target: safeTarget, gap: Math.max(0, safeTarget - count) };
  }).filter(student => student.gap > 0);
}

function newWarningIncident(previous, discordId, absentDates, limit = 3, incidentKey = '', warningDate = '') {
  const state = previous && typeof previous === 'object' ? { ...previous } : {};
  const id = String(discordId || '');
  const current = state[id] && typeof state[id] === 'object' ? { ...state[id] } : {};
  const dates = [...new Set((absentDates || []).map(String).filter(Boolean))].sort();
  const legacyUsed = Array.isArray(current.usedDates)
    ? current.usedDates.map(String)
    : String(current.lastIncident || '').split(',').filter(Boolean);
  const used = new Set(legacyUsed);
  const unused = dates.filter(date => !used.has(date));
  const availablePairs = Math.floor(unused.length / 2);
  const currentCount = Math.max(0, Number(current.count || 0));
  const normalizedIncidentKey = String(incidentKey || '').trim();
  if (normalizedIncidentKey && current.lastEvaluatedDate === normalizedIncidentKey) {
    return {
      state,
      record: current,
      duplicate: true,
      added: 0,
      incidentDates: [],
      remaining: Math.max(0, limit - currentCount),
    };
  }
  // One scheduled/manual warning run is one mentor-facing incident. Historical
  // backlog must never jump a student from 0/3 straight to inactive in a
  // single run, even when six older blank attendance cells are visible.
  const added = Math.min(availablePairs > 0 ? 1 : 0, Math.max(0, limit - currentCount));
  const consumed = unused.slice(0, added * 2);
  consumed.forEach(date => used.add(date));
  const count = Math.min(limit, currentCount + added);
  const token = consumed.join(',') || String(current.lastIncident || '');
  const duplicate = added === 0;
  state[id] = {
    count,
    lastIncident: token,
    usedDates: [...used].sort().slice(-30),
    updatedAt: new Date().toISOString(),
    inactive: count >= limit,
    inactiveSource: count >= limit ? 'attendance-warning' : '',
    lastEvaluatedDate: normalizedIncidentKey || String(current.lastEvaluatedDate || ''),
    lastWarningDate: added > 0
      ? String(warningDate || normalizedIncidentKey || '').trim()
      : String(current.lastWarningDate || ''),
  };
  return {
    state,
    record: state[id],
    duplicate,
    added,
    incidentDates: consumed,
    remaining: Math.max(0, limit - count),
  };
}

function undoLatestWarningIncident(previous, discordId) {
  const state = previous && typeof previous === 'object' ? { ...previous } : {};
  const id = String(discordId || '').trim();
  const current = state[id] && typeof state[id] === 'object' ? { ...state[id] } : null;
  const previousCount = Math.max(0, Number(current?.count || 0));
  if (!current || previousCount < 1) {
    return { state, changed: false, previousCount, count: previousCount, wasInactive: false };
  }
  const latestDates = String(current.lastIncident || '').split(',').map(value => value.trim()).filter(Boolean);
  const latest = new Set(latestDates);
  const usedDates = (Array.isArray(current.usedDates) ? current.usedDates : [])
    .map(String).filter(date => !latest.has(date)).sort();
  const count = Math.max(0, previousCount - 1);
  state[id] = {
    ...current,
    count,
    usedDates,
    lastIncident: usedDates.slice(-2).join(','),
    inactive: false,
    inactiveSource: '',
    lastWarningDate: '',
    warningRevertedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return {
    state,
    changed: true,
    previousCount,
    count,
    removedDates: latestDates,
    // Never clear an unrelated manual/hired status. Only the warning workflow
    // is authorized to reverse warning-driven inactivity.
    wasInactive: Boolean(current.inactive && current.inactiveSource === 'attendance-warning'),
  };
}

function consecutiveAbsencePairDates(absentDates, recordedSessions, startDate = '') {
  const absent = new Set((absentDates || []).map(String));
  const result = [];
  let streak = [];
  for (const date of [...new Set((recordedSessions || []).map(String))].sort()) {
    if (startDate && date < startDate) continue;
    if (!absent.has(date)) {
      streak = [];
      continue;
    }
    streak.push(date);
    if (streak.length === 2) {
      result.push(...streak);
      streak = [];
    }
  }
  return result;
}

function rebaseWarningState(previous, startDate, absentDatesById = {}, recordedSessions = []) {
  const state = {};
  const changedIds = [];
  const reactivateIds = [];
  for (const [id, raw] of Object.entries(previous || {})) {
    const record = raw && typeof raw === 'object' ? { ...raw } : {};
    const priorUsed = Array.isArray(record.usedDates)
      ? record.usedDates.map(String)
      : String(record.lastIncident || '').split(',').map(item => item.trim()).filter(Boolean);
    const supplied = Array.isArray(absentDatesById[id])
      ? absentDatesById[id].map(String)
      : null;
    const rawEligible = [...new Set((supplied || priorUsed)
      .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= startDate))].sort();
    const eligible = supplied && recordedSessions.length
      ? consecutiveAbsencePairDates(rawEligible, recordedSessions, startDate)
      : rawEligible.slice(0, Math.floor(rawEligible.length / 2) * 2);
    const priorCount = Math.max(0, Math.min(3, Number(record.count || 0)));
    const count = Math.min(priorCount, Math.floor(eligible.length / 2), 3);
    const usedDates = eligible.slice(0, count * 2);
    const inactive = count >= 3;
    const next = {
      ...record,
      count,
      usedDates,
      lastIncident: usedDates.slice(-2).join(','),
      inactive,
      inactiveSource: inactive ? 'attendance-warning' : '',
      warningStartDate: startDate,
      updatedAt: new Date().toISOString(),
    };
    state[id] = next;
    if (JSON.stringify({ count: priorCount, usedDates: priorUsed, inactive: Boolean(record.inactive) }) !==
        JSON.stringify({ count, usedDates, inactive })) changedIds.push(id);
    if (Boolean(record.inactive) && !inactive) reactivateIds.push(id);
  }
  return { state, changedIds, reactivateIds };
}

module.exports = {
  consecutiveAbsencePairDates,
  currentGuildStudents,
  DEFAULT_THRESHOLDS,
  KIND_ALIASES,
  newWarningIncident,
  undoLatestWarningIncident,
  rebaseWarningState,
  parseFollowupCommand,
  quotaGapStudents,
  targetGapStudents,
  workingDatesBetween,
  zeroActivityStudents,
};
