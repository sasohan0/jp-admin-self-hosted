const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { backfillInterviewHistory, messageSignature } = require('./interview');

test('interview in-process identity is bound to guild, channel, message, and text', () => {
  const base = { guildId: '1', channelId: '2', id: '3', content: 'Interview at Acme' };
  assert.equal(messageSignature(base), '1:2:3:Interview at Acme');
  assert.notEqual(messageSignature(base), messageSignature({ ...base, content: 'Interview at Beta' }));
});

test('interview handler ignores embed-only updates and writes stable message event IDs', () => {
  const source = fs.readFileSync(require.resolve('./interview'), 'utf8');
  const backfillSource = source.slice(
    source.indexOf('async function backfillInterviewHistory'),
    source.indexOf('function messageSignature'),
  );
  assert.match(source, /oldMessage\.content === newMessage\.content/);
  assert.match(source, /action: 'logInterviews'/);
  assert.match(source, /messageId: msg\.id/);
  assert.match(source, /eventIndex/);
  assert.match(source, /saved\.messagePreviouslySeen/);
  assert.match(source, /const interviews = deterministic\.length/);
  assert.match(source, /resolveChannel\(\s*cohort, 'channel_interview'/);
  assert.match(source, /action: 'logInterviews'/);
  assert.match(source, /parseHistoryCommand\(command, '!backfillinterviews'\)/);
  assert.match(source, /messageWindowPosition\(message, window\)/);
  assert.doesNotMatch(backfillSource, /repairInterviewDuplicates|action: 'backfillInterviews'/);
  assert.match(source, /Interview update recorded in \*\*Interview_Log\*\*/);
});

test('interview backfill writes only messages inside the requested calendar window', async () => {
  const recent = {
    id: 'recent',
    content: 'Interview Serial: 1st | Company: Acme | Date: August 27 | Role: Developer',
    createdTimestamp: Date.parse('2026-08-26T10:00:00Z'),
    author: { id: 'student-1', bot: false },
    url: 'https://discord.test/recent',
  };
  const old = {
    id: 'old',
    content: 'Interview Serial: 1st | Company: Old Corp | Date: August 24 | Role: Developer',
    createdTimestamp: Date.parse('2026-08-24T10:00:00Z'),
    author: { id: 'student-1', bot: false },
    url: 'https://discord.test/old',
  };
  const batch = new Map([[recent.id, recent], [old.id, old]]);
  batch.last = () => old;
  let fetches = 0;
  const channel = {
    isTextBased: () => true,
    messages: { fetch: async () => { fetches++; return batch; } },
  };
  const writes = [];
  const result = await backfillInterviewHistory({}, {
    guildId: 'guild-1',
    timezone: 'Asia/Dhaka',
    channels: { interviewUpdates: 'channel-1' },
  }, {
    days: 3,
    nowMs: Date.parse('2026-08-27T06:00:00Z'),
    channel,
    rosterState: {
      roster: [{ discordId: 'student-1', email: 'student@example.com', name: 'Student' }],
      refreshed: false,
    },
    post: async (_cohort, payload) => {
      writes.push(payload);
      return { created: 1 };
    },
  });

  assert.equal(fetches, 1);
  assert.equal(result.messages, 1);
  assert.equal(result.recognized, 1);
  assert.deepEqual([result.window.startDate, result.window.endDate], ['2026-08-25', '2026-08-27']);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].action, 'logInterviews');
  assert.equal(writes[0].messageId, 'recent');
});
