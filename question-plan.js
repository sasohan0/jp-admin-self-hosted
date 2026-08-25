'use strict';

const PERIODS = Object.freeze(['morning', 'afternoon', 'evening']);

function normalizeTime(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return '';
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return '';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function timeToMinutes(value) {
  const normalized = normalizeTime(value);
  if (!normalized) return NaN;
  const [hour, minute] = normalized.split(':').map(Number);
  return hour * 60 + minute;
}

function parsePeriodValue(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}:\d{2})\s*[,|/]\s*(\d{1,2})$/);
  if (!match) return null;
  const time = normalizeTime(match[1]);
  const count = Number(match[2]);
  if (!time || count < 0 || count > 10) return null;
  return { time, count };
}

function parseGapChannel(value) {
  const match = String(value || '').trim().toLowerCase().match(/^(\d{1,3})\s*[,|/]\s*(discussion|workshop|dawn)$/);
  if (!match) return null;
  const gap = Number(match[1]);
  if (gap < 1 || gap > 180) return null;
  return { gap, channel: match[2] };
}

function parseGapMinutes(value) {
  const raw = String(value || '').trim();
  if (!/^\d{1,3}$/.test(raw)) return null;
  const gap = Number(raw);
  return gap >= 1 && gap <= 180 ? gap : null;
}

function buildPeriodPlan(periods, windowMinutes, gapMinutes) {
  const window = Math.max(1, Number(windowMinutes) || 1);
  const gap = Math.max(window + 2, Number(gapMinutes) || 1);
  const events = [];
  for (const period of PERIODS) {
    const item = periods[period] || {};
    const start = timeToMinutes(item.time);
    const count = Math.max(0, Math.min(10, Number(item.count) || 0));
    if (!Number.isFinite(start)) throw new Error(`${period} time is invalid`);
    for (let index = 0; index < count; index++) {
      const minute = start + index * gap;
      if (minute >= 24 * 60) throw new Error(`${period} questions extend past midnight`);
      events.push({ period, index, minute });
    }
  }
  return events.sort((a, b) => a.minute - b.minute);
}

module.exports = {
  PERIODS,
  buildPeriodPlan,
  normalizeTime,
  parseGapMinutes,
  parseGapChannel,
  parsePeriodValue,
  timeToMinutes,
};
