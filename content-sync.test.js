const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cursorKey,
  mirrorChunks,
  mirrorText,
  parseContentSyncCommand,
  sourceKey,
  sourceSnapshot,
} = require('./content-sync');

test('content sync parses one/all, automatic, status, and durable source commands', () => {
  assert.deepEqual(parseContentSyncCommand('!contentsync'), {
    action: 'status', kind: '', mode: '',
  });
  assert.deepEqual(parseContentSyncCommand('!contentbackfill run resources all'), {
    action: 'run', kind: 'resources', mode: 'all',
  });
  assert.deepEqual(parseContentSyncCommand('!contentsync auto jobhunting on'), {
    action: 'auto', kind: 'jobhunting', mode: 'on',
  });
  assert.deepEqual(parseContentSyncCommand('!contentsync source 123456789012345678'), {
    action: 'source', source: '123456789012345678', kind: '', mode: '',
  });
  assert.equal(parseContentSyncCommand('!contentsync run unknown all'), null);
});

test('content source snapshot is secret-free and remains usable after retirement', () => {
  const cohort = {
    name: 'STRIDE', guildId: '123', apiKey: 'never-copy', appsScriptUrl: 'secret-url',
    supervisorIds: ['456'], channels: { resources: '789', jobHunting: '987', supervisor: '111' },
  };
  assert.deepEqual(sourceSnapshot(cohort), {
    name: 'STRIDE', guildId: '123', supervisorIds: ['456'],
    channels: { resources: '789', jobHunting: '987' },
  });
  assert.equal(sourceKey({ guildId: '222' }), 'content_source_v1_222');
  assert.equal(cursorKey(cohort, { guildId: '222' }, 'resources'), 'content_cursor_v1_123_222_resources');
});

test('mirrored content visibly and functionally neutralizes broad mentions', () => {
  const message = {
    content: '@everyone review this with @here',
    attachments: new Map([['one', { url: 'https://example.com/file.pdf' }]]),
  };
  const text = mirrorText(message, { name: 'STRIDE' }, 'resources');
  assert.match(text, /@\u200beveryone/);
  assert.match(text, /@\u200bhere/);
  assert.match(text, /file\.pdf/);
  const chunks = mirrorChunks({ ...message, content: 'x'.repeat(1999) }, { name: 'STRIDE' }, 'resources');
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 1900));
});
