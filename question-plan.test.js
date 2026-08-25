const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPeriodPlan, parseGapChannel, parseGapMinutes, parsePeriodValue } = require('./question-plan');

test('question period fields accept time and count together', () => {
  assert.deepEqual(parsePeriodValue('7:00,2'), { time: '07:00', count: 2 });
  assert.deepEqual(parsePeriodValue('13:30 / 3'), { time: '13:30', count: 3 });
  assert.equal(parsePeriodValue('25:00,2'), null);
  assert.equal(parsePeriodValue('07:00,12'), null);
});

test('question channel and gap are validated', () => {
  assert.deepEqual(parseGapChannel('10,discussion'), { gap: 10, channel: 'discussion' });
  assert.deepEqual(parseGapChannel('15|dawn'), { gap: 15, channel: 'dawn' });
  assert.equal(parseGapChannel('0,workshop'), null);
});

test('standalone question gap is validated', () => {
  assert.equal(parseGapMinutes('10'), 10);
  assert.equal(parseGapMinutes('0'), null);
  assert.equal(parseGapMinutes('181'), null);
});

test('two questions are planned in each period and qwindow controls safe spacing', () => {
  const events = buildPeriodPlan({
    morning: { time: '07:00', count: 2 },
    afternoon: { time: '13:00', count: 2 },
    evening: { time: '18:00', count: 2 },
  }, 6, 5);
  assert.deepEqual(events.map(item => item.minute), [420, 428, 780, 788, 1080, 1088]);
});
