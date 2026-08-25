const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildGvizUrl,
  buildCsvUrl,
  parseHtmlViewTabs,
  extractGvizJson,
  parseCsvTracker,
  parseDateValue,
  parseSheetLink,
  parseTrackerTable,
  readTracker,
  selectTrackerCandidate,
} = require('./job-tracker');

test('extracts a spreadsheet ID and selected gid from a shared link', () => {
  const ref = parseSheetLink('See https://docs.google.com/spreadsheets/d/1234567890abcdefghijkl/edit#gid=987654321');
  assert.deepEqual(ref, { sheetId: '1234567890abcdefghijkl', gid: '987654321' });
  assert.match(buildGvizUrl(ref), /gid=987654321/);
  assert.match(buildCsvUrl(ref), /gid=987654321/);
});

test('a link without gid intentionally uses the default tracker tab', () => {
  const ref = parseSheetLink('https://docs.google.com/spreadsheets/d/1234567890abcdefghijkl/edit?usp=sharing');
  assert.deepEqual(ref, { sheetId: '1234567890abcdefghijkl', gid: '' });
  assert.doesNotMatch(buildGvizUrl(ref), /[?&]gid=/);
  assert.doesNotMatch(buildCsvUrl(ref), /[?&]gid=/);
});

test('fresh tracker requests carry a unique Visualization request id', () => {
  const url = buildGvizUrl('1234567890abcdefghijkl', { requestId: 12345 });
  assert.match(decodeURIComponent(url), /reqId:12345/);
});

test('discovers public tracker tab names and gids from htmlview', () => {
  const html = `
    items.push({name: "Sheet1", pageUrl: "x&gid=0", gid: "0", initialSheet: true});
    items.push({name: "Job Applications", pageUrl: "x&gid=98765", gid: "98765", initialSheet: false});
  `;
  assert.deepEqual(parseHtmlViewTabs(html), [
    { name: 'Sheet1', gid: '0' },
    { name: 'Job Applications', gid: '98765' },
  ]);
});

test('normalizes typed, text, serial, and human-readable dates', () => {
  assert.equal(parseDateValue('Date(2026,6,17)', '', 'Asia/Dhaka'), '2026-07-17');
  assert.equal(parseDateValue('17/07/2026', '', 'Asia/Dhaka'), '2026-07-17');
  assert.equal(parseDateValue('07/17/2026', 'M/d/yyyy', 'Asia/Dhaka'), '2026-07-17');
  assert.equal(parseDateValue('17 July 2026', '', 'Asia/Dhaka'), '2026-07-17');
  assert.equal(parseDateValue('17-Jul-2026', '', 'Asia/Dhaka'), '2026-07-17');
  assert.equal(parseDateValue('17 Jul', '', 'Asia/Dhaka', '2026-07-17'), '2026-07-17');
  assert.equal(parseDateValue('Jul 17', '', 'Asia/Dhaka', '2026-07-17'), '2026-07-17');
  assert.equal(parseDateValue(46220, '', 'Asia/Dhaka'), '2026-07-17');
});

test('converts zoned timestamps to the cohort calendar date', () => {
  assert.equal(parseDateValue('2026-07-16T20:30:00Z', '', 'Asia/Dhaka'), '2026-07-17');
});

test('prefers Date Applied over an unrelated update timestamp', () => {
  const result = parseTrackerTable({ table: {
    cols: [
      { id: 'A', label: 'Last Updated', type: 'datetime' },
      { id: 'B', label: 'Date Applied', type: 'string', pattern: 'dd/MM/yyyy' },
      { id: 'C', label: 'Company Name', type: 'string' },
    ],
    rows: [
      { c: [{ v: 'Date(2026,6,18)' }, { v: '17/07/2026' }, { v: 'Acme' }] },
      { c: [{ v: 'Date(2026,6,18)' }, { v: '17/07/2026' }, { v: 'Acme' }] },
      { c: [{ v: 'Date(2026,6,18)' }, { v: '18/07/2026' }, { v: 'Beta' }] },
    ],
  } }, { timezone: 'Asia/Dhaka' });

  assert.equal(result.dateColumn, 'Date Applied');
  assert.deepEqual(result.counts, { '2026-07-17': 2, '2026-07-18': 1 });
  assert.deepEqual(result.companiesByDay['2026-07-17'], ['acme', 'acme']);
});

test('recognizes common alternate and Bangla application-date headings', () => {
  for (const label of ['Apply Date', 'Date of Application', 'আবেদনের তারিখ']) {
    const result = parseTrackerTable({ table: {
      cols: [{ id: 'A', label, type: 'string' }],
      rows: [{ c: [{ v: '18/07/2026' }] }],
    } });
    assert.equal(result.counts['2026-07-18'], 1, label);
  }
});

test('finds a date header embedded below tracker title rows', () => {
  const result = parseTrackerTable({ table: {
    cols: [
      { id: 'A', label: 'Column 1', type: 'string' },
      { id: 'B', label: 'Column 2', type: 'string' },
    ],
    rows: [
      { c: [{ v: 'My Job Tracker' }, null] },
      { c: [{ v: 'Company Name' }, { v: 'Apply Date' }] },
      { c: [{ v: 'Acme' }, { v: '18/07/2026' }] },
    ],
  } });
  assert.equal(result.headerRow, 2);
  assert.equal(result.dateColumn, 'Apply Date');
  assert.equal(result.counts['2026-07-18'], 1);
});

test('returns a safe snapshot candidate when an application table has no date column', () => {
  const result = parseTrackerTable({ table: {
    cols: [
      { id: 'A', label: 'Company Name', type: 'string' },
      { id: 'B', label: 'Job Position', type: 'string' },
    ],
    rows: [
      { c: [{ v: 'Acme' }, { v: 'Frontend Developer' }] },
      { c: [{ v: 'Beta' }, { v: 'Backend Developer' }] },
      { c: [null, null] },
    ],
  } });
  assert.equal(result.dateUnavailable, true);
  assert.equal(result.trackerMode, 'snapshot');
  assert.equal(result.totalApplicationRows, 2);
});

test('reports an empty selected tracker tab with an actionable gid hint', () => {
  assert.throws(() => parseTrackerTable({ table: {
    cols: [{ id: 'A', label: '', type: 'string' }], rows: [],
  } }), /selected tracker tab is empty.*gid/i);
});

test('reports non-empty dates that still cannot be parsed', () => {
  const result = parseTrackerTable({ table: {
    cols: [{ id: 'A', label: 'Application Date', type: 'string' }],
    rows: [
      { c: [{ v: '2026-07-17' }] },
      { c: [{ v: 'next someday' }] },
      { c: [null] },
    ],
  } });
  assert.equal(result.datedRows, 1);
  assert.equal(result.invalidDateRows, 1);
  assert.deepEqual(result.invalidDateSamples, ['next someday']);
});

test('bounds and redacts invalid date samples for private diagnostics', () => {
  const result = parseTrackerTable({ table: {
    cols: [{ id: 'A', label: 'Date Applied', type: 'string' }],
    rows: [
      { c: [{ v: 'send to person@example.com' }] },
      { c: [{ v: 'https://example.com/private-path' }] },
      { c: [{ v: 'x'.repeat(100) }] },
      { c: [{ v: 'fourth sample is intentionally omitted' }] },
    ],
  } });
  assert.equal(result.invalidDateRows, 4);
  assert.deepEqual(result.invalidDateSamples, [
    'send to [email]', '[url]', `${'x'.repeat(57)}...`,
  ]);
});

test('rejects parseable but unrelated or generic columns as application dates', () => {
  const unsafeTables = [
    { cols: [{ id: 'A', label: 'Task Received', type: 'date' }] },
    { cols: [{ id: 'A', label: 'Column 1', type: 'string' }] },
    { cols: [{ id: 'A', label: 'Applied instead of Full-Time', type: 'string' }] },
    { cols: [{ id: 'A', label: `Email ${'person@example.com '.repeat(20)}Applied`, type: 'string' }] },
  ];

  for (const table of unsafeTables) {
    assert.throws(() => parseTrackerTable({ table: {
      cols: table.cols,
      rows: [{ c: [{ v: '2026-07-16' }] }],
    } }), /no application table or date column found/);
  }
});

test('retries with an explicit header count when Google infers unsafe headings', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const explicitHeaders = new URL(url).searchParams.get('headers');
    const table = explicitHeaders === '1'
      ? {
          cols: [{ id: 'A', label: 'Date Applied', type: 'string' }],
          rows: [{ c: [{ v: '16/07/2026' }] }],
        }
      : {
          cols: [{ id: 'A', label: 'Column 1', type: 'string' }],
          rows: [{ c: [{ v: '16/07/2026' }] }],
        };
    return {
      ok: true,
      text: async () => `google.visualization.Query.setResponse(${JSON.stringify({ status: 'ok', table })});`,
    };
  };

  const result = await readTracker('1234567890abcdefghijkl', {
    fetchImpl, retries: 0, headerCounts: [undefined, 1], timezone: 'Asia/Dhaka',
  });
  assert.equal(result.dateColumn, 'Date Applied');
  assert.equal(result.counts['2026-07-16'], 1);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /headers=1/);
});

test('continues past a date-less parse to find a dated explicit-header result', async () => {
  const fetchImpl = async url => {
    const explicitHeaders = new URL(url).searchParams.get('headers');
    const table = explicitHeaders === '1'
      ? {
          cols: [{ id: 'A', label: 'Date Applied', type: 'string' }],
          rows: [{ c: [{ v: '18/07/2026' }] }],
        }
      : {
          cols: [{ id: 'A', label: 'Company Name', type: 'string' }],
          rows: [{ c: [{ v: 'Acme' }] }],
        };
    return {
      ok: true,
      text: async () => `google.visualization.Query.setResponse(${JSON.stringify({ status: 'ok', table })});`,
    };
  };
  const result = await readTracker('1234567890abcdefghijkl', {
    fetchImpl, retries: 0, headerCounts: [undefined, 1], timezone: 'Asia/Dhaka',
  });
  assert.equal(result.dateUnavailable, false);
  assert.equal(result.counts['2026-07-18'], 1);
});

test('auto-discovers a dated application tab when a legacy DEFAULT tab is date-less', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.includes('/htmlview')) {
      return {
        ok: true,
        text: async () =>
          'items.push({name: "Sheet1", pageUrl: "x&gid=0", gid: "0"});' +
          'items.push({name: "Applications", pageUrl: "x&gid=24680", gid: "24680"});',
      };
    }
    const gid = new URL(url).searchParams.get('gid');
    const table = gid === '24680'
      ? {
          cols: [
            { id: 'A', label: 'Date Applied', type: 'string' },
            { id: 'B', label: 'Company', type: 'string' },
          ],
          rows: [{ c: [{ v: '27/07/2026' }, { v: 'Acme' }] }],
        }
      : {
          cols: [{ id: 'A', label: 'Company', type: 'string' }],
          rows: [{ c: [{ v: 'Old row' }] }],
        };
    return {
      ok: true,
      text: async () =>
        `google.visualization.Query.setResponse(${JSON.stringify({ status: 'ok', table })});`,
    };
  };
  const result = await readTracker('1234567890abcdefghijkl', {
    fetchImpl,
    retries: 0,
    headerCounts: [undefined],
    timezone: 'Asia/Dhaka',
  });
  assert.equal(result.counts['2026-07-27'], 1);
  assert.equal(result.resolvedGid, '24680');
  assert.equal(result.resolvedTabName, 'Applications');
  assert.equal(result.tabDiscovered, true);
  assert.ok(calls.some(url => url.includes('/htmlview')));
});

test('deep inspection finds target-date rows on another tab without replacing an explicit gid', async () => {
  const fetchImpl = async url => {
    if (url.includes('/htmlview')) {
      return {
        ok: true,
        text: async () =>
          'items.push({name: "Old Applications", pageUrl: "x&gid=111", gid: "111"});' +
          'items.push({name: "Current Applications", pageUrl: "x&gid=222", gid: "222"});',
      };
    }
    const gid = new URL(url).searchParams.get('gid');
    const date = gid === '222' ? '02/08/2026' : '31/07/2026';
    const rows = gid === '222'
      ? [{ c: [{ v: date }, { v: 'Acme' }] }, { c: [{ v: date }, { v: 'Beta' }] }]
      : [{ c: [{ v: date }, { v: 'Old' }] }];
    const table = {
      cols: [
        { id: 'A', label: 'Date Applied', type: 'string' },
        { id: 'B', label: 'Company', type: 'string' },
      ],
      rows,
    };
    return {
      ok: true,
      text: async () => `google.visualization.Query.setResponse(${JSON.stringify({ status: 'ok', table })});`,
    };
  };

  const result = await readTracker({
    sheetId: '1234567890abcdefghijkl',
    gid: '111',
  }, {
    fetchImpl,
    retries: 0,
    headerCounts: [undefined],
    exhaustive: true,
    targetDate: '2026-08-02',
  });
  assert.equal(result.counts['2026-08-02'], 2);
  assert.equal(result.resolvedGid, '222');
  assert.equal(result.tabDiscovered, true);
  assert.equal(result.shouldPersistResolvedGid, false);
  assert.equal(result.inspectedTabs, 2);
});

test('weekly tab selection chooses the candidate covering the requested date range', () => {
  const selected = selectTrackerCandidate([
    { primary: true, gid: '1', parsed: { counts: { '2026-07-26': 2 }, datedRows: 20 } },
    { primary: false, gid: '2', parsed: { counts: { '2026-08-01': 3 }, datedRows: 3 } },
  ], '', '1', ['2026-07-26', '2026-08-01']);
  assert.equal(selected.gid, '2');
});

test('retries one transient tracker timeout before reporting failure', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) {
      const err = new Error('slow');
      err.name = 'AbortError';
      throw err;
    }
    const table = {
      cols: [{ id: 'A', label: 'Date', type: 'string' }],
      rows: [{ c: [{ v: '2026-07-16' }] }],
    };
    return {
      ok: true,
      text: async () => `google.visualization.Query.setResponse(${JSON.stringify({ status: 'ok', table })});`,
    };
  };

  const result = await readTracker('1234567890abcdefghijkl', {
    fetchImpl, retries: 1, headerCounts: [undefined],
  });
  assert.equal(result.counts['2026-07-16'], 1);
  assert.equal(calls, 2);
});

test('falls back to the public CSV export while preserving gid when gviz fails', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.includes('/gviz/tq')) throw Object.assign(new Error('slow'), { name: 'AbortError' });
    return {
      ok: true,
      text: async () => 'Company Name,Date Applied\nAcme,22/07/2026\n"Beta, Ltd",22/07/2026',
    };
  };
  const result = await readTracker({
    sheetId: '1234567890abcdefghijkl',
    gid: '987654321',
  }, {
    fetchImpl,
    retries: 0,
    headerCounts: [undefined],
  });
  assert.equal(result.counts['2026-07-22'], 2);
  assert.match(calls[1], /export\?/);
  assert.match(calls[1], /gid=987654321/);
});

test('parses quoted commas in CSV tracker rows', () => {
  const result = parseCsvTracker('Company Name,Date\n"Acme, Ltd",2026-07-22');
  assert.equal(result.counts['2026-07-22'], 1);
  assert.deepEqual(result.companiesByDay['2026-07-22'], ['acme, ltd']);
});

test('extracts the JSON object from a gviz response wrapper', () => {
  const data = extractGvizJson('/*O_o*/\ngoogle.visualization.Query.setResponse({"status":"ok","table":{"cols":[],"rows":[]}});');
  assert.equal(data.status, 'ok');
});
