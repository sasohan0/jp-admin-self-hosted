const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mirroredResourceParts,
  parseResourceSyncCommand,
  resourceSyncStateKey,
} = require('./resources');

test('resource sync command accepts only explicit private controls', () => {
  assert.equal(parseResourceSyncCommand('!resourcesync'), 'status');
  assert.equal(parseResourceSyncCommand(' !ResourceSync ON '), 'on');
  assert.equal(parseResourceSyncCommand('!resourcesync off'), 'off');
  assert.equal(parseResourceSyncCommand('!resourcesync backfill'), null);
});

test('resource sync state is namespaced by both source and destination guild', () => {
  assert.equal(resourceSyncStateKey(
    { guildId: '1527624228830969967' },
    { guildId: '1534781682920456192' },
  ), 'resource_sync_1527624228830969967_1534781682920456192');
});

test('mirrored resources preserve text and attachments without mention metadata', () => {
  const message = {
    content: 'Read https://example.com',
    attachments: new Map([
      ['1', { url: 'https://cdn.example.com/file.pdf' }],
    ]),
  };
  const result = mirroredResourceParts(message, { name: 'STRIDE' });
  assert.equal(result.content, message.content);
  assert.deepEqual(result.attachments, ['https://cdn.example.com/file.pdf']);
  assert.match(result.chunks.join('\n'), /Shared resource from STRIDE/);
  assert.match(result.chunks.join('\n'), /file\.pdf/);
});

test('resource writes carry immutable Discord source IDs for backend deduplication', () => {
  const source = require('node:fs').readFileSync(require.resolve('./resources'), 'utf8');
  assert.match(source, /sourceMessageId: msg\.id/);
  assert.match(source, /sourceMessageId: message\.id/);
});
