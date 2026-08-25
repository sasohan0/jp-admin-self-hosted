const test = require('node:test');
const assert = require('node:assert/strict');
const { chunkLines } = require('./message-chunks');

test('never emits a Discord message over the requested limit', () => {
  const chunks = chunkLines([
    'short first line',
    `very-long-tracker-label ${'x'.repeat(4500)}`,
    'final result still appears',
  ], 1900);

  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every(chunk => chunk.length <= 1900));
  assert.match(chunks.at(-1), /final result still appears/);
});

test('does not emit empty chunks when the first line is oversized', () => {
  const chunks = chunkLines(['y'.repeat(2100)], 1900);
  assert.deepEqual(chunks.map(chunk => chunk.length), [1900, 200]);
});
