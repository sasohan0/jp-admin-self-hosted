const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { backfillHistory } = require('./outreach');

test('outreach channel override controls live logging and backfill reads', () => {
  const source = fs.readFileSync(require.resolve('./outreach'), 'utf8');
  assert.match(source, /const outreachChannelId = await resolveChannel\(/);
  assert.match(source, /msg\.channelId === outreachChannelId/);
  assert.match(source, /await resolveChannel\(cohort, 'channel_outreach'/);
  assert.match(source, /client\.channels\.fetch\(channelId\)/);
});

test('outreach history uses bounded backend batches to avoid long-held locks', () => {
  const source = fs.readFileSync(require.resolve('./outreach'), 'utf8');
  assert.match(source, /const OUTREACH_BACKFILL_BATCH_SIZE = 25/);
  assert.match(source, /i \+= OUTREACH_BACKFILL_BATCH_SIZE/);
  assert.match(source, /events\.slice\(i, i \+ OUTREACH_BACKFILL_BATCH_SIZE\)/);
});

test('outreach backfill defaults to a recent date window without overwriting legacy summaries', () => {
  const source = fs.readFileSync(require.resolve('./outreach'), 'utf8');
  assert.match(source, /parseHistoryCommand\(cmd, '!backfilloutreach'\)/);
  assert.match(source, /historyWindow\(options\.days/);
  assert.match(source, /messageWindowPosition\(m, window\)/);
  assert.match(source, /options\.writeHistoricalSummary === true/);
});

test('outreach backfill stops at the date boundary and writes only in-window events', async () => {
  const recent = {
    id: 'recent',
    createdTimestamp: Date.parse('2026-08-26T06:00:00Z'),
    author: { id: 'student-1', bot: false },
    url: 'https://discord.test/recent',
  };
  const old = {
    id: 'old',
    createdTimestamp: Date.parse('2026-08-23T06:00:00Z'),
    author: { id: 'student-1', bot: false },
    url: 'https://discord.test/old',
  };
  const batch = new Map([[recent.id, recent], [old.id, old]]);
  batch.last = () => old;
  let fetches = 0;
  const writes = [];
  const result = await backfillHistory({}, {
    guildId: 'guild-1', timezone: 'Asia/Dhaka', channels: { outreach: 'channel-1' },
  }, {
    days: 3,
    nowMs: Date.parse('2026-08-27T06:00:00Z'),
    roster: [{ discordId: 'student-1', email: 'student@example.com', name: 'Student' }],
    channel: { messages: { fetch: async () => { fetches++; return batch; } } },
    sleep: async () => {},
    post: async (_cohort, payload) => {
      writes.push(payload);
      return { reconciled: payload.entries.length };
    },
  });

  assert.equal(fetches, 1);
  assert.equal(result.messages, 1);
  assert.equal(result.dailyEvents, 1);
  assert.deepEqual([result.window.startDate, result.window.endDate], ['2026-08-25', '2026-08-27']);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].action, 'backfillOutreachDaily');
  assert.deepEqual(writes[0].entries.map(entry => entry.messageId), ['recent']);
});
