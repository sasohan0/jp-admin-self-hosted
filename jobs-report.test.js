const test = require('node:test');
const assert = require('node:assert/strict');
const { backfillJobSheetLinks, formatDailyTrackerLine } = require('./jobs');

test('nightly tracker line mentions the mapped student and shows dated, total, and new rows', () => {
  const line = formatDailyTrackerLine({
    s: { name: 'Student One', discordId: '123456789012345678' },
    todayCount: 2,
    totalRows: 41,
    newRows: 3,
    baseline: false,
    dateUnavailable: false,
    prev: [1, 4, 0],
  }, 10, 3);
  assert.match(line, /<@123456789012345678>/);
  assert.match(line, /dated today: \*\*2\*\*/);
  assert.match(line, /total tracker rows: \*\*41\*\*/);
  assert.match(line, /new rows: \*\*3\*\*/);
  assert.match(line, /new-row count is higher than dated-today/);
});

test('nightly tracker line labels snapshot-only counts as estimates', () => {
  const line = formatDailyTrackerLine({
    s: { name: 'Student Two', discordId: '223456789012345678' },
    todayCount: 5,
    totalRows: 20,
    newRows: null,
    baseline: true,
    dateUnavailable: true,
    prev: [0, 0, 0],
  }, 10, 3);
  assert.match(line, /estimated today/);
  assert.match(line, /new-row baseline created/);
});

test('job history reconciliation recovers the newest tracker per durable roster member', async () => {
  const batch = new Map([
    ['new', {
      id: 'new', author: { id: 'student-1', bot: false },
      content: 'https://docs.google.com/spreadsheets/d/newSheet123456789abcdefghijk/edit?gid=77',
    }],
    ['old', {
      id: 'old', author: { id: 'student-1', bot: false },
      content: 'https://docs.google.com/spreadsheets/d/oldSheet123456789abcdefghijk/edit?gid=11',
    }],
    ['unknown', {
      id: 'unknown', author: { id: 'not-in-roster', bot: false },
      content: 'https://docs.google.com/spreadsheets/d/ignoredSheet123456789abcdef/edit?gid=9',
    }],
  ]);
  batch.last = () => [...batch.values()].at(-1);
  let fetches = 0;
  let payload;
  const result = await backfillJobSheetLinks({}, { guildId: 'g1', channels: { jobTracking: 'c1' } }, {
    roster: [{ discordId: 'student-1', email: 'student@example.com' }],
    channel: {
      messages: {
        fetch: async () => fetches++ === 0 ? batch : new Map(),
      },
    },
    sleep: async () => {},
    post: async (cohort, body) => {
      payload = body;
      return { saved: body.items.length };
    },
  });

  assert.equal(result.saved, 1);
  assert.equal(result.messages, 3);
  assert.deepEqual(payload, {
    action: 'saveJobSheets',
    items: [{ email: 'student@example.com', sheetId: 'newSheet123456789abcdefghijk', gid: '77' }],
  });
});
