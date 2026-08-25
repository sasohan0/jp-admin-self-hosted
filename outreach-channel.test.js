const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('outreach channel override controls live logging and backfill reads', () => {
  const source = fs.readFileSync(require.resolve('./outreach'), 'utf8');
  assert.match(source, /const outreachChannelId = await resolveChannel\(/);
  assert.match(source, /msg\.channelId === outreachChannelId/);
  assert.match(source, /const channelId = await resolveChannel\(cohort, 'channel_outreach'/);
  assert.match(source, /client\.channels\.fetch\(channelId\)/);
});

