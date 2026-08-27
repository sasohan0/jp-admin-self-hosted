'use strict';

const DEFAULT_HISTORY_DAYS = 3;
const MAX_HISTORY_DAYS = 30;

function normalizeHistoryDays(value, fallback = DEFAULT_HISTORY_DAYS) {
  const candidate = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > MAX_HISTORY_DAYS) {
    throw new Error(`history days must be a whole number from 1 to ${MAX_HISTORY_DAYS}`);
  }
  return candidate;
}

function parseHistoryCommand(input, command) {
  const normalized = String(input || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const root = String(command || '').trim().toLowerCase();
  if (!root || (normalized !== root && !normalized.startsWith(`${root} `))) return null;
  if (normalized === root) return { days: DEFAULT_HISTORY_DAYS };

  const value = normalized.slice(root.length).trim();
  const match = value.match(/^(\d{1,3})\s*(?:d|day|days)?$/);
  if (!match) return { error: `Usage: \`${root} [1-${MAX_HISTORY_DAYS} days]\`` };
  try {
    return { days: normalizeHistoryDays(match[1]) };
  } catch {
    return { error: `Usage: \`${root} [1-${MAX_HISTORY_DAYS} days]\`` };
  }
}

function localDateKey(timestamp, timezone = 'UTC') {
  return new Date(Number(timestamp)).toLocaleDateString('en-CA', { timeZone: timezone || 'UTC' });
}

function historyWindow(days, timezone = 'UTC', nowMs = Date.now()) {
  const normalizedDays = normalizeHistoryDays(days);
  const endDate = localDateKey(nowMs, timezone);
  const [year, month, day] = endDate.split('-').map(Number);
  const startDate = new Date(Date.UTC(year, month - 1, day - (normalizedDays - 1)))
    .toISOString().slice(0, 10);
  return { days: normalizedDays, timezone: timezone || 'UTC', startDate, endDate, nowMs };
}

function messageWindowPosition(message, window) {
  const timestamp = Number(message?.createdTimestamp);
  const date = localDateKey(Number.isFinite(timestamp) ? timestamp : window.nowMs, window.timezone);
  if (date < window.startDate) return -1;
  if (date > window.endDate) return 1;
  return 0;
}

function historyWindowLabel(window) {
  return `${window.days} calendar day${window.days === 1 ? '' : 's'} (${window.startDate} through ${window.endDate})`;
}

module.exports = {
  DEFAULT_HISTORY_DAYS,
  MAX_HISTORY_DAYS,
  historyWindow,
  historyWindowLabel,
  localDateKey,
  messageWindowPosition,
  normalizeHistoryDays,
  parseHistoryCommand,
};
