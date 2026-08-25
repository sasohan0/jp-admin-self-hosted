const MONTHS = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function localDateKey(date = new Date(), timezone = 'Asia/Dhaka') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseDateKey(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  ) return null;
  return date;
}

function dateKey(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function shiftDateKey(value, days) {
  const date = parseDateKey(value);
  if (!date) return '';
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return dateKey(date);
}

function sundayWeekStart(value) {
  const date = parseDateKey(value);
  if (!date) return '';
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return dateKey(date);
}

function absenceCommandQuery(input) {
  const content = String(input || '').trim();
  const match = content.match(/^!(?:absent|absences)\b/i);
  if (!match) return null;
  return content.slice(match[0].length).trim();
}

function parseAbsencePeriod(input, options = {}) {
  const timezone = options.timezone || 'Asia/Dhaka';
  const today = localDateKey(options.now || new Date(), timezone);
  const query = String(input || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const currentStart = sundayWeekStart(today);

  if (!query || query === 'current' || query === 'this week') {
    return {
      kind: 'current',
      start: currentStart,
      end: today,
      label: `Current week (${currentStart} to ${today})`,
    };
  }

  if (query === 'previous' || query === 'last week' || query === 'previous week') {
    const start = shiftDateKey(currentStart, -7);
    const end = shiftDateKey(currentStart, -1);
    return {
      kind: 'previous',
      start,
      end,
      label: `Previous week (${start} to ${end})`,
    };
  }

  if (parseDateKey(query)) {
    const start = sundayWeekStart(query);
    const end = shiftDateKey(start, 6);
    return {
      kind: 'date',
      start,
      end,
      label: `Week containing ${query} (${start} to ${end})`,
    };
  }

  const monthMatch = query.match(
    /^([a-z]+)\s+week\s+([1-5])(?:\s+(\d{4}))?$/,
  );
  if (monthMatch && Object.prototype.hasOwnProperty.call(MONTHS, monthMatch[1])) {
    const month = MONTHS[monthMatch[1]];
    const year = Number(monthMatch[3]) || Number(today.slice(0, 4));
    const week = Number(monthMatch[2]);
    const startDay = (week - 1) * 7 + 1;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    if (startDay > lastDay) {
      throw new Error(`${MONTH_LABELS[month]} ${year} has no week ${week} in the 1–7, 8–14 format.`);
    }
    const endDay = Math.min(startDay + 6, lastDay);
    const start = dateKey(new Date(Date.UTC(year, month, startDay)));
    const end = dateKey(new Date(Date.UTC(year, month, endDay)));
    return {
      kind: 'month-week',
      start,
      end,
      label: `${MONTH_LABELS[month]} ${year} week ${week} (${start} to ${end})`,
    };
  }

  throw new Error(
    'Use `current`, `previous`, `YYYY-MM-DD`, or a month period such as `july week 1`.',
  );
}

function tsvValue(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

function absenceTsvLines(students) {
  const lines = [
    'Name\tEmail\tPhone\tDiscord Username\tAbsent Days\tLongest Streak\tAbsent Dates',
  ];
  for (const student of students || []) {
    lines.push([
      student.name,
      student.email,
      student.phone,
      student.username,
      student.absentDays,
      student.longestStreak,
      (student.absentDates || []).join(', '),
    ].map(tsvValue).join('\t'));
  }
  return lines;
}

function copyableCodeBlocks(lines, maxLength = 1900) {
  const prefix = '```text\n';
  const suffix = '\n```';
  const available = maxLength - prefix.length - suffix.length;
  const blocks = [];
  const originalLines = (lines || []).map(line => String(line || ''));
  if (!originalLines.length) return blocks;
  const header = originalLines[0].slice(0, available);
  const rowLimit = Math.max(1, available - header.length - 1);
  let current = header;

  for (const original of originalLines.slice(1)) {
    const line = original.slice(0, rowLimit);
    if (current && current.length + line.length + 1 > available) {
      blocks.push(prefix + current + suffix);
      current = header;
    }
    current += (current ? '\n' : '') + line;
  }
  if (current) blocks.push(prefix + current + suffix);
  return blocks;
}

module.exports = {
  absenceCommandQuery,
  absenceTsvLines,
  copyableCodeBlocks,
  localDateKey,
  parseAbsencePeriod,
  shiftDateKey,
  sundayWeekStart,
};
