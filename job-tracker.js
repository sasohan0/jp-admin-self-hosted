// ============================================================
//  job-tracker.js - resilient public Google Sheet reader
//
//  Google Visualization may return dates as Date(y,m,d), ISO
//  timestamps, formatted strings, or spreadsheet serials. This
//  module normalizes those representations to yyyy-mm-dd and
//  reports rows whose non-empty dates still cannot be parsed.
// ============================================================

const SHEET_LINK_RE = /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/i;

function parseSheetLink(text) {
  const source = String(text || '');
  const match = source.match(SHEET_LINK_RE);
  if (!match) return null;
  const gid = source.match(/[?#&]gid=(\d+)/i)?.[1] || '';
  return { sheetId: match[1], gid };
}

function normalizeTrackerRef(ref) {
  if (typeof ref === 'string') return { sheetId: ref, gid: '' };
  return {
    sheetId: String(ref?.sheetId || ''),
    gid: String(ref?.gid || '').replace(/\D/g, ''),
  };
}

function buildGvizUrl(ref, options = {}) {
  const { sheetId, gid } = normalizeTrackerRef(ref);
  if (!/^[a-zA-Z0-9_-]{20,}$/.test(sheetId)) throw new Error('invalid sheet ID');
  const requestId = String(options.requestId || '').replace(/\D/g, '');
  const params = new URLSearchParams({
    tqx: requestId ? `out:json;reqId:${requestId}` : 'out:json',
  });
  if (gid) params.set('gid', gid);
  if (Number.isInteger(options.headers) && options.headers >= 0) {
    params.set('headers', String(options.headers));
  }
  return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?${params}`;
}

function buildCsvUrl(ref, options = {}) {
  const { sheetId, gid } = normalizeTrackerRef(ref);
  if (!/^[a-zA-Z0-9_-]{20,}$/.test(sheetId)) throw new Error('invalid sheet ID');
  const params = new URLSearchParams({ format: 'csv' });
  if (gid) params.set('gid', gid);
  if (options.cacheBust) params.set('_', String(options.cacheBust).replace(/\D/g, ''));
  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?${params}`;
}

function buildHtmlViewUrl(ref) {
  const { sheetId } = normalizeTrackerRef(ref);
  if (!/^[a-zA-Z0-9_-]{20,}$/.test(sheetId)) throw new Error('invalid sheet ID');
  return `https://docs.google.com/spreadsheets/d/${sheetId}/htmlview`;
}

function parseHtmlViewTabs(text) {
  const source = String(text || '');
  const tabs = [];
  const seen = new Set();
  const pattern = /items\.push\(\{name:\s*"((?:\\.|[^"])*)"[\s\S]*?gid:\s*"(\d+)"/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const gid = String(match[2] || '');
    if (!gid || seen.has(gid)) continue;
    seen.add(gid);
    tabs.push({
      name: String(match[1] || '').replace(/\\"/g, '"').replace(/\\\\/g, '\\').slice(0, 120),
      gid,
    });
    if (tabs.length >= 30) break;
  }
  return tabs;
}

function dateKeyInTimezone(date, timezone) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function validKey(year, month, day) {
  year = Number(year); month = Number(month); day = Number(day);
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function patternOrder(pattern) {
  const p = String(pattern || '').toLowerCase().replace(/[^dmy]/g, '');
  if (p.startsWith('ymd')) return 'ymd';
  if (p.startsWith('dmy')) return 'dmy';
  if (p.startsWith('mdy')) return 'mdy';
  return '';
}

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function parseDateValue(value, pattern, timezone, referenceDate) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return dateKeyInTimezone(value, timezone);

  if (typeof value === 'number') {
    // Google/Excel serial date (1899-12-30 epoch), or Unix seconds/milliseconds.
    if (value >= 20000 && value <= 100000) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000);
      return validKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    if (value >= 1e12) return dateKeyInTimezone(new Date(value), timezone);
    if (value >= 1e9) return dateKeyInTimezone(new Date(value * 1000), timezone);
    return null;
  }

  const raw = String(value).trim();
  if (!raw) return null;

  // Native gviz representation. Month is zero-based.
  let m = raw.match(/^Date\((\d{4}),(\d{1,2}),(\d{1,2})(?:,|\))/);
  if (m) return validKey(m[1], Number(m[2]) + 1, m[3]);

  // ISO date-only/local timestamps retain their written calendar date. Zoned
  // timestamps are converted to the cohort timezone before comparison.
  m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(.*)$/);
  if (m) {
    const suffix = m[4] || '';
    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(suffix)) {
      const parsed = new Date(raw);
      return dateKeyInTimezone(parsed, timezone);
    }
    return validKey(m[1], m[2], m[3]);
  }

  // Numeric dates. Ambiguous values default to day/month/year, matching the
  // cohort's Bangladesh locale, unless the Sheet column pattern says otherwise.
  m = raw.match(/^(\d{1,4})[\/.\-](\d{1,2})[\/.\-](\d{1,4})(?:\D.*)?$/);
  if (m) {
    let a = Number(m[1]), b = Number(m[2]), c = Number(m[3]);
    let order = patternOrder(pattern);
    if (m[1].length === 4) order = 'ymd';
    else if (m[3].length === 4) {
      if (a > 12) order = 'dmy';
      else if (b > 12) order = 'mdy';
      else order = order || 'dmy';
    }
    if (order === 'ymd') return validKey(a, b, c);
    if (order === 'mdy') return validKey(c < 100 ? 2000 + c : c, a, b);
    return validKey(c < 100 ? 2000 + c : c, b, a);
  }

  // Human-readable month names: "17 July 2026" or "July 17, 2026".
  m = raw.toLowerCase().match(/^(\d{1,2})\s+([a-z]+)[,\s]+(\d{4})/);
  if (m && MONTHS[m[2]]) return validKey(m[3], MONTHS[m[2]], m[1]);
  m = raw.toLowerCase().match(/^([a-z]+)\s+(\d{1,2})[,]?\s+(\d{4})/);
  if (m && MONTHS[m[1]]) return validKey(m[3], MONTHS[m[1]], m[2]);

  // Common compact/manual entries such as 17-Jul-2026, 17 Jul, or Jul 17.
  m = raw.toLowerCase().match(/^(\d{1,2})[\s./-]+([a-z]+)[\s,./-]+(\d{4})/);
  if (m && MONTHS[m[2]]) return validKey(m[3], MONTHS[m[2]], m[1]);
  const referenceYear = Number(String(referenceDate || '').match(/^(\d{4})-/)?.[1]) ||
    Number(dateKeyInTimezone(new Date(), timezone)?.slice(0, 4));
  m = raw.toLowerCase().match(/^(\d{1,2})[\s./-]+([a-z]+)$/);
  if (m && MONTHS[m[2]]) return validKey(referenceYear, MONTHS[m[2]], m[1]);
  m = raw.toLowerCase().match(/^([a-z]+)[\s./-]+(\d{1,2})$/);
  if (m && MONTHS[m[1]]) return validKey(referenceYear, MONTHS[m[1]], m[2]);

  return null;
}

function parseDateCell(cell, column, timezone, referenceDate) {
  if (!cell) return null;
  return parseDateValue(cell.v, column?.pattern, timezone, referenceDate) ||
    parseDateValue(cell.f, column?.pattern, timezone, referenceDate);
}

function isNonEmpty(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function dateHeaderConfidence(value) {
  const label = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!label || label.length > 120) return 0;
  // Availability/preference headings such as "Applied instead of Full-Time"
  // contain both "applied" and "time", but they are not application dates.
  // Keep legitimate labels such as "Full-Time Application Date" valid when
  // they explicitly include date or timestamp.
  if (/\b(?:full|part)[\s-]*time\b/.test(label) && !/\b(?:date|timestamp)\b/.test(label)) return 0;
  if (/^(date\s*(applied|of\s*application)|apply\s*date|applied\s*(date|on|at)|application\s*(date|time|timestamp)|job\s*application\s*(date|time)|আবেদনের\s*তারিখ|আবেদন\s*তারিখ|চাকরিতে\s*আবেদনের\s*তারিখ)$/.test(label)) return 4;
  if (/(application|applied).*(date|time|timestamp)|(date|time|timestamp).*(application|applied)/.test(label)) return 3;
  if (/^(date|date\s*\/\s*time|date\s+and\s+time|timestamp|submitted\s*(at|on)?|created\s*(at|on)?)$/.test(label)) return 2;
  return 0;
}

function applicationHeaderConfidence(value) {
  const label = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!label || label.length > 120) return 0;
  if (/company|employer|organisation|organization|কোম্পানি|প্রতিষ্ঠান/.test(label)) return 4;
  if (/job\s*(title|role|position|post)|position|vacancy|role|পজিশন|পদ/.test(label)) return 3;
  if (/apply\s*(link|url)|job\s*(link|url)|posting\s*(link|url)|source\s*(link|url)/.test(label)) return 3;
  if (/application\s*status|apply\s*status|job\s*status/.test(label)) return 2;
  return 0;
}

function displayColumnLabel(col, index) {
  const raw = String(col?.label || col?.id || `column ${index + 1}`).trim().replace(/\s+/g, ' ');
  return raw.length > 80 ? `${raw.slice(0, 77)}...` : raw;
}

function displayCellSample(value) {
  const safe = String(value ?? '')
    .trim()
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\s+/g, ' ');
  return safe.length > 60 ? `${safe.slice(0, 57)}...` : safe;
}

function chooseDateColumn(table, timezone, referenceDate) {
  const cols = table.cols || [];
  const rows = table.rows || [];
  const candidates = cols.map((col, index) => {
    const rawLabel = String(col.label || '').trim();
    const label = rawLabel.toLowerCase().replace(/\s+/g, ' ');
    const confidence = dateHeaderConfidence(label);
    const typedDate = col.type === 'date' || col.type === 'datetime';
    const unrelated = /update|deadline|interview|follow.?up|response|task\s*received/.test(label);
    let score = confidence * 55;
    if (typedDate) score += 45;
    if (unrelated && confidence < 3) score -= 250;

    let populated = 0, parsed = 0;
    for (const row of rows.slice(0, 50)) {
      const cell = row.c?.[index];
      if (!cell || (!isNonEmpty(cell.v) && !isNonEmpty(cell.f))) continue;
      populated++;
      if (parseDateCell(cell, col, timezone, referenceDate)) parsed++;
    }
    if (parsed) score += 25 + Math.round(55 * parsed / Math.max(populated, 1));

    // Content that merely resembles a date is not enough: job trackers often
    // contain deadlines, task dates, URLs, and numeric IDs. Require an
    // application/date header, or an unnamed column that Google typed as a
    // date with strong parse evidence. Ambiguous columns are reported as
    // unreadable instead of silently producing a wrong zero.
    const unnamedTypedDate = !rawLabel && typedDate && parsed > 0 && parsed / Math.max(populated, 1) >= 0.8;
    const eligible = !unrelated && (confidence > 0 || unnamedTypedDate);
    return {
      index, score, parsed, populated, eligible,
      label: displayColumnLabel(col, index),
    };
  }).filter(c => c.eligible);

  candidates.sort((a, b) => b.score - a.score || b.parsed - a.parsed);
  return candidates[0] || null;
}

function promoteEmbeddedHeader(table) {
  const rows = table.rows || [];
  let best = null;
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 40); rowIndex++) {
    const labels = (rows[rowIndex].c || []).map(cell => String(cell?.v ?? cell?.f ?? '').trim());
    const dateScore = labels.reduce((sum, label) => sum + dateHeaderConfidence(label), 0);
    const applicationScore = labels.reduce((sum, label) => sum + applicationHeaderConfidence(label), 0);
    const populated = labels.filter(Boolean).length;
    if (!dateScore && applicationScore < 3) continue;
    const score = dateScore * 100 + applicationScore * 10 + populated;
    if (!best || score > best.score) best = { rowIndex, labels, score };
  }
  if (!best) return null;
  const width = Math.max((table.cols || []).length, best.labels.length);
  const cols = [];
  for (let i = 0; i < width; i++) {
    cols.push(Object.assign({}, table.cols?.[i] || {}, {
      label: best.labels[i] || table.cols?.[i]?.label || '',
    }));
  }
  return { cols, rows: rows.slice(best.rowIndex + 1), headerRow: best.rowIndex + 1 };
}

function applicationColumnIndexes(cols) {
  const indexes = [];
  for (let i = 0; i < cols.length; i++) {
    if (applicationHeaderConfidence(cols[i]?.label)) indexes.push(i);
  }
  return indexes;
}

function rowHasApplicationData(row, indexes, dateCol) {
  const candidates = [...indexes];
  if (dateCol >= 0 && !candidates.includes(dateCol)) candidates.push(dateCol);
  return candidates.some(index => {
    const cell = row.c?.[index];
    return cell && (isNonEmpty(cell.v) || isNonEmpty(cell.f));
  });
}

function parseTrackerTable(data, options = {}) {
  if (data?.status === 'error') {
    const message = (data.errors || []).map(e => e.detailed_message || e.message).filter(Boolean).join('; ');
    throw new Error(message || 'Google Sheets query failed');
  }
  let table = data?.table;
  if (!table) throw new Error('invalid Google Sheets response');
  const hasVisibleContent = (table.cols || []).some(col => isNonEmpty(col?.label)) ||
    (table.rows || []).some(row => (row.c || []).some(cell => cell && (isNonEmpty(cell.v) || isNonEmpty(cell.f))));
  if (!hasVisibleContent) throw new Error('selected tracker tab is empty (check the saved gid)');
  const timezone = options.timezone || 'Asia/Dhaka';
  let selected = chooseDateColumn(table, timezone, options.targetDate);
  let headerRow = null;
  if (!selected) {
    const promoted = promoteEmbeddedHeader(table);
    if (promoted) {
      table = promoted;
      headerRow = promoted.headerRow;
      selected = chooseDateColumn(table, timezone, options.targetDate);
    }
  }
  const cols = table.cols || [];
  const applicationCols = applicationColumnIndexes(cols);
  if (!selected) {
    if (!applicationCols.length) {
      throw new Error('no application table or date column found');
    }
    const totalApplicationRows = (table.rows || []).filter(row => rowHasApplicationData(row, applicationCols, -1)).length;
    return {
      counts: {}, companiesByDay: {}, datedRows: 0, invalidDateRows: 0, invalidDateSamples: [],
      dateColumn: '', dateUnavailable: true, trackerMode: 'snapshot', totalApplicationRows, headerRow,
    };
  }

  const dateCol = selected.index;
  const companyCol = cols.findIndex(c => /company|employer|organization|organisation/i.test(String(c.label || '')));
  const counts = {};
  const companiesByDay = {};
  let datedRows = 0, invalidDateRows = 0;
  const invalidDateSamples = [];
  let totalApplicationRows = 0;

  for (const row of table.rows || []) {
    if (rowHasApplicationData(row, applicationCols, dateCol)) totalApplicationRows++;
    const cell = row.c?.[dateCol];
    if (!cell || (!isNonEmpty(cell.v) && !isNonEmpty(cell.f))) continue;
    const key = parseDateCell(cell, cols[dateCol], timezone, options.targetDate);
    if (!key) {
      invalidDateRows++;
      const sample = displayCellSample(cell.v ?? cell.f);
      if (sample && invalidDateSamples.length < 3 && !invalidDateSamples.includes(sample)) {
        invalidDateSamples.push(sample);
      }
      continue;
    }
    datedRows++;
    counts[key] = (counts[key] || 0) + 1;
    if (companyCol !== -1) {
      const companyCell = row.c?.[companyCol];
      const name = String(companyCell?.v ?? companyCell?.f ?? '')
        .trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 100);
      if (name) (companiesByDay[key] = companiesByDay[key] || []).push(name);
    }
  }

  return {
    counts, companiesByDay, datedRows, invalidDateRows, invalidDateSamples,
    dateColumn: String(selected.label), dateUnavailable: false, trackerMode: 'dated',
    totalApplicationRows, headerRow,
  };
}

function extractGvizJson(text) {
  const source = String(text || '');
  if (/<html|<doctype/i.test(source) || /sign in/i.test(source) && !/setResponse/.test(source)) {
    throw new Error('tracker is not public');
  }
  const marker = 'google.visualization.Query.setResponse(';
  const markerAt = source.indexOf(marker);
  const start = markerAt === -1 ? source.indexOf('{') : markerAt + marker.length;
  const end = markerAt === -1 ? source.lastIndexOf('}') + 1 : source.lastIndexOf(')');
  if (start < 0 || end <= start) throw new Error('invalid Google Sheets response');
  return JSON.parse(source.slice(start, end));
}

function parseCsvRows(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}

function parseCsvTracker(text, options = {}) {
  if (/<html|<doctype/i.test(String(text || ''))) throw new Error('tracker is not public');
  const rows = parseCsvRows(text).filter(row => row.some(isNonEmpty));
  if (!rows.length) throw new Error('selected tracker tab is empty (check the saved gid)');
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const table = {
    cols: Array.from({ length: width }, (_, index) => ({
      id: String.fromCharCode(65 + (index % 26)),
      label: String(rows[0][index] || ''),
      type: 'string',
    })),
    rows: rows.slice(1).map(values => ({
      c: Array.from({ length: width }, (_, index) => {
        const value = values[index] ?? '';
        return isNonEmpty(value) ? { v: value } : null;
      }),
    })),
  };
  return parseTrackerTable({ table }, options);
}

async function readCsvFallback(ref, options) {
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.csvTimeoutMs || 12000);
  try {
    const res = await fetchImpl(buildCsvUrl(ref, { cacheBust: Date.now() }), {
      redirect: 'follow',
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseCsvTracker(await res.text(), options);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGvizData(ref, options, headers, retries) {
  const fetchImpl = options.fetchImpl || fetch;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 20000);
    try {
      const res = await fetchImpl(buildGvizUrl(ref, {
        headers,
        requestId: Date.now() + attempt,
      }), {
        redirect: 'follow',
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.retryable = res.status === 429 || res.status >= 500;
        throw err;
      }
      return extractGvizJson(await res.text());
    } catch (err) {
      lastError = err;
      const retryable = err.name === 'AbortError' || err.retryable || err.name === 'TypeError';
      if (!retryable || attempt === retries) throw err;
      await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function discoverTrackerTabs(ref, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.tabTimeoutMs || 12000);
  try {
    const response = await fetchImpl(buildHtmlViewUrl(ref), {
      redirect: 'follow',
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseHtmlViewTabs(await response.text());
  } finally {
    clearTimeout(timer);
  }
}

async function readTrackerRef(ref, options, headerCounts) {
  let lastError;
  let snapshotFallback = null;
  for (let i = 0; i < headerCounts.length; i++) {
    try {
      const data = await fetchGvizData(
        ref, options, headerCounts[i], i === 0 ? (options.retries ?? 1) : 0);
      try {
        const parsed = parseTrackerTable(data, options);
        if (!parsed.dateUnavailable) return parsed;
        snapshotFallback = snapshotFallback || parsed;
        continue;
      } catch (err) {
        lastError = err;
        if (!/^no application table or date column found/.test(err.message)) throw err;
      }
    } catch (err) {
      lastError = err;
      if (i === 0) break;
    }
  }
  if (snapshotFallback) return snapshotFallback;
  try {
    return await readCsvFallback(ref, options);
  } catch (csvError) {
    if (!lastError) lastError = csvError;
  }
  throw lastError || new Error('tracker read failed');
}

function selectTrackerCandidate(candidates, targetDate, primaryGid, targetDates = []) {
  const usable = (candidates || []).filter(candidate => candidate?.parsed && !candidate.parsed.error);
  if (!usable.length) return null;
  const dated = usable.filter(candidate => !candidate.parsed.dateUnavailable);
  const wantedDates = [...new Set([targetDate, ...(targetDates || [])].filter(Boolean))];
  const requestedCount = candidate => wantedDates.reduce(
    (sum, date) => sum + Number(candidate.parsed.counts?.[date] || 0), 0);
  if (wantedDates.length) {
    const withTarget = dated.filter(candidate => requestedCount(candidate) > 0);
    if (withTarget.length) {
      withTarget.sort((a, b) =>
        requestedCount(b) - requestedCount(a) ||
        Number(b.parsed.datedRows || 0) - Number(a.parsed.datedRows || 0));
      return withTarget[0];
    }
  }
  const primary = usable.find(candidate => candidate.primary || String(candidate.gid || '') === String(primaryGid || ''));
  if (primary && !primary.parsed.dateUnavailable) return primary;
  if (dated.length) {
    dated.sort((a, b) => Number(b.parsed.datedRows || 0) - Number(a.parsed.datedRows || 0));
    return dated[0];
  }
  return primary || usable.sort((a, b) =>
    Number(b.parsed.totalApplicationRows || 0) - Number(a.parsed.totalApplicationRows || 0))[0];
}

async function readTracker(ref, options = {}) {
  const headerCounts = Array.isArray(options.headerCounts)
    ? options.headerCounts
    : [undefined, 1, 2, 3, 0];
  const normalized = normalizeTrackerRef(ref);
  let primary;
  let primaryError;
  try {
    primary = await readTrackerRef(normalized, options, headerCounts);
    const requestedDates = [...new Set([options.targetDate, ...(options.targetDates || [])].filter(Boolean))];
    const targetMissing = requestedDates.length && !primary.dateUnavailable &&
      requestedDates.reduce((sum, date) => sum + Number(primary.counts?.[date] || 0), 0) === 0;
    const needsDiscovery = options.exhaustive ||
      (options.discoverWhenTargetMissing && targetMissing) ||
      (primary.dateUnavailable && !normalized.gid);
    if (!needsDiscovery) {
      return Object.assign(primary, { resolvedGid: normalized.gid, tabDiscovered: false });
    }
  } catch (err) {
    primaryError = err;
  }

  // Old cohorts often saved links before GID support, so every row says
  // DEFAULT even when the application table is on another public tab. Only
  // discover tabs when the default tab is unusable/date-less; a valid default
  // remains authoritative and avoids unnecessary requests.
  const shouldDiscover = options.discoverTabs !== false && (
    options.exhaustive || options.discoverWhenTargetMissing || !normalized.gid
  );
  if (shouldDiscover) {
    try {
      const tabs = await discoverTrackerTabs(normalized, options);
      const candidates = [];
      if (primary) {
        candidates.push({
          parsed: primary,
          gid: normalized.gid,
          name: normalized.gid ? 'saved tab' : 'default tab',
          primary: true,
        });
      }
      const maxTabs = Number.isInteger(options.maxTabs) ? options.maxTabs : 20;
      for (const tab of tabs.slice(0, Math.max(1, maxTabs))) {
        if (String(tab.gid) === String(normalized.gid || '0')) continue;
        try {
          const parsed = await readTrackerRef(
            { sheetId: normalized.sheetId, gid: tab.gid }, options, headerCounts);
          candidates.push({ parsed, gid: tab.gid, name: tab.name, primary: false });
          const requestedDates = [...new Set([options.targetDate, ...(options.targetDates || [])].filter(Boolean))];
          const hasRequestedRows = requestedDates.reduce(
            (sum, date) => sum + Number(parsed.counts?.[date] || 0), 0) > 0;
          if (!options.exhaustive && requestedDates.length && !parsed.dateUnavailable && hasRequestedRows) {
            break;
          }
          if (options.tabPaceMs) {
            await new Promise(resolve => setTimeout(resolve, options.tabPaceMs));
          }
        } catch {
          // Continue through bounded public tabs; the primary error is more
          // useful if no alternate application table succeeds.
        }
      }
      const selected = selectTrackerCandidate(
        candidates, options.targetDate, normalized.gid, options.targetDates);
      if (selected) {
        const discovered = !selected.primary;
        return Object.assign(selected.parsed, {
          resolvedGid: selected.gid,
          resolvedTabName: selected.name,
          tabDiscovered: discovered,
          shouldPersistResolvedGid: discovered && !normalized.gid,
          inspectedTabs: candidates.length,
        });
      }
    } catch {
      // Tab discovery is a fallback, never a new reason to fail a readable
      // default tab or hide the original actionable error.
    }
  }

  if (primary) {
    return Object.assign(primary, { resolvedGid: normalized.gid, tabDiscovered: false });
  }
  const message = primaryError?.name === 'AbortError'
    ? 'request timed out'
    : primaryError?.message || 'tracker read failed';
  return { error: String(message).slice(0, 180) };
}

module.exports = {
  buildHtmlViewUrl,
  buildCsvUrl,
  buildGvizUrl,
  chooseDateColumn,
  applicationHeaderConfidence,
  extractGvizJson,
  promoteEmbeddedHeader,
  parseDateValue,
  parseCsvRows,
  parseCsvTracker,
  parseHtmlViewTabs,
  parseSheetLink,
  parseTrackerTable,
  selectTrackerCandidate,
  discoverTrackerTabs,
  readTracker,
};
