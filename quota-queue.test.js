const test = require('node:test');
const assert = require('node:assert/strict');
const { runQuotaTask } = require('./quota-queue');

test('quota queue never runs more than two scheduled cohort tasks at once', async () => {
  let active = 0;
  let maximum = 0;
  const release = [];
  const tasks = Array.from({ length: 5 }, (_, index) => runQuotaTask(`task-${index}`, async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => release.push(resolve));
    active--;
    return index;
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(maximum, 2);
  while (release.length || active) {
    release.splice(0).forEach(resolve => resolve());
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4]);
});
