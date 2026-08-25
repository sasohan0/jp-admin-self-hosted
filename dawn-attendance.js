'use strict';

const WINDOW_START_MINUTE = 5 * 60;
const WINDOW_END_MINUTE = 7 * 60;

function normalizeClock(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return '';
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return '';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseChannelWindow(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'always') return { mode: 'always', label: 'always open' };
  const parts = raw.split('-');
  if (parts.length !== 2) return null;
  const start = normalizeClock(parts[0]);
  const end = normalizeClock(parts[1]);
  if (!start || !end || start === end) return null;
  return {
    mode: 'range',
    start,
    end,
    startMinute: Number(start.slice(0, 2)) * 60 + Number(start.slice(3)),
    endMinute: Number(end.slice(0, 2)) * 60 + Number(end.slice(3)),
    label: `${start}-${end}`,
  };
}

function parseAttendanceWindow(value) {
  const window = parseChannelWindow(value);
  if (!window || window.mode !== 'range' || window.startMinute >= window.endMinute) return null;
  const duration = window.endMinute - window.startMinute;
  if (duration < 15 || duration > 6 * 60) return null;
  return window;
}

function isChannelWindowOpen(window, minute) {
  if (!window || window.mode === 'always') return true;
  if (window.startMinute < window.endMinute) {
    return minute >= window.startMinute && minute < window.endMinute;
  }
  return minute >= window.startMinute || minute < window.endMinute;
}

function localDateKey(timezone, value = new Date()) {
  return new Date(value).toLocaleDateString('en-CA', { timeZone: timezone });
}

function localMinutes(timezone, value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(value));
  const hour = Number(parts.find(part => part.type === 'hour').value);
  const minute = Number(parts.find(part => part.type === 'minute').value);
  return hour * 60 + minute;
}

function isInDawnWindow(value, timezone, dateKey, startMinute = WINDOW_START_MINUTE,
  endMinute = WINDOW_END_MINUTE) {
  return localDateKey(timezone, value) === dateKey &&
    localMinutes(timezone, value) >= startMinute &&
    localMinutes(timezone, value) < endMinute;
}

function firstQualifyingMessages(messages, memberIds, timezone, dateKey,
  startMinute = WINDOW_START_MINUTE, endMinute = WINDOW_END_MINUTE) {
  const eligible = new Set([...memberIds].map(String));
  const first = new Map();
  for (const message of messages || []) {
    const authorId = String(message.authorId || message.author?.id || '');
    if (!eligible.has(authorId) || message.bot || message.author?.bot) continue;
    const timestamp = message.createdAt || message.createdTimestamp;
    if (!timestamp || !isInDawnWindow(timestamp, timezone, dateKey, startMinute, endMinute)) continue;
    const content = String(message.content || '').trim();
    const hasAttachment = Number(message.attachmentCount || message.attachments?.size || 0) > 0;
    if (!content && !hasAttachment) continue;
    const previous = first.get(authorId);
    if (!previous || new Date(timestamp).getTime() < new Date(previous.createdAt || previous.createdTimestamp).getTime()) {
      first.set(authorId, message);
    }
  }
  return first;
}

function localMinuteUtcMs(dateKey, minute, timezone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey)) || !Number.isInteger(minute) || minute < 0 || minute >= 24 * 60) {
    return NaN;
  }
  let candidate = Date.parse(`${dateKey}T00:00:00.000Z`) + minute * 60 * 1000;
  for (let attempt = 0; attempt < 4; attempt++) {
    const actualDate = localDateKey(timezone, candidate);
    const actualMinute = localMinutes(timezone, candidate);
    const dayDelta = Math.round((Date.parse(`${actualDate}T00:00:00.000Z`) -
      Date.parse(`${dateKey}T00:00:00.000Z`)) / (24 * 60 * 60 * 1000));
    const difference = dayDelta * 24 * 60 + actualMinute - minute;
    if (!difference && actualDate === dateKey) return candidate;
    candidate -= difference * 60 * 1000;
  }
  return localDateKey(timezone, candidate) === dateKey && localMinutes(timezone, candidate) === minute
    ? candidate
    : NaN;
}

function attendanceWindowUtcBounds(dateKey, timezone, window) {
  const parsed = typeof window === 'string' ? parseAttendanceWindow(window) : window;
  if (!parsed?.startMinute && parsed?.startMinute !== 0) return null;
  const startMs = localMinuteUtcMs(dateKey, parsed.startMinute, timezone);
  const endMs = localMinuteUtcMs(dateKey, parsed.endMinute, timezone);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return { startMs, endMs };
}

function discordSnowflakeAt(timestampMs) {
  const discordEpoch = 1420070400000n;
  const value = BigInt(Math.trunc(Number(timestampMs))) - discordEpoch;
  if (value <= 0n) return '';
  return (value << 22n).toString();
}

function membershipTransition(existing = {}, isMember, dateKey) {
  const wasPresent = typeof existing.rolePresent === 'boolean' ? existing.rolePresent : null;
  if (wasPresent === Boolean(isMember)) return { changed: false, event: '' };
  if (isMember) {
    return {
      changed: true,
      event: existing.everJoined || existing.status === 'removed' ? 'Rejoined' : 'Joined',
      everJoined: true,
      rolePresent: true,
      status: 'active',
      date: dateKey,
    };
  }
  return {
    changed: true,
    event: 'Removed',
    everJoined: true,
    rolePresent: false,
    status: 'removed',
    date: dateKey,
  };
}

function isVerifiedDawnEmail(value) {
  const email = String(value || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
    !/^discord\.\d+@pending\.jp-admin\.invalid$/i.test(email);
}

module.exports = {
  WINDOW_END_MINUTE,
  WINDOW_START_MINUTE,
  attendanceWindowUtcBounds,
  discordSnowflakeAt,
  firstQualifyingMessages,
  isChannelWindowOpen,
  isVerifiedDawnEmail,
  isInDawnWindow,
  localDateKey,
  localMinutes,
  membershipTransition,
  normalizeClock,
  parseAttendanceWindow,
  parseChannelWindow,
};
