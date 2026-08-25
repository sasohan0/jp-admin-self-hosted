const test = require('node:test');
const assert = require('node:assert/strict');
const { fieldChunks } = require('./control-center');

test('control center splits long fields without truncating configurable clocks', () => {
  const lines = Array.from({ length: 30 }, (_, index) => `clock-${index} ${'x'.repeat(60)}`);
  const fields = fieldChunks('Clock times', lines, 200);
  assert.ok(fields.length > 1);
  assert.equal(fields.map(field => field.value).join('\n').replace(/\n/g, ''), lines.join(''));
  assert.ok(fields.every(field => field.value.length <= 200));
});
