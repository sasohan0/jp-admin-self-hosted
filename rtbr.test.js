'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRtbrPayload } = require('./rtbr');

test('RTBR payload ranks by total and limits the published list', () => {
  const payload = buildRtbrPayload([
    { name: 'Second', total: 10, questions: 2, interviewCount: 0, interviews: 0, jobApplications: 8, jobPts: 8, workshopCount: 0, workshop: 0 },
    { name: 'First', total: 20, questions: 3, interviewCount: 1, interviews: 15, jobApplications: 2, jobPts: 2, workshopCount: 0, workshop: 0 },
    { name: 'Third', total: 5, questions: 0, interviewCount: 0, interviews: 0, jobApplications: 5, jobPts: 5, workshopCount: 0, workshop: 0 },
  ], { days: 7, topCount: 2, jobTarget: 10 });
  assert.match(payload.embeds[0].title, /Priority for Referral/);
  assert.ok(payload.embeds[0].description.indexOf('First') < payload.embeds[0].description.indexOf('Second'));
  assert.doesNotMatch(payload.embeds[0].description, /Third/);
  assert.match(payload.embeds[0].description, /1 interviews\/15 pts/);
  assert.deepEqual(payload.allowedMentions, { parse: ['everyone'] });
});

test('RTBR payload is empty when backend has no scored students', () => {
  assert.equal(buildRtbrPayload([], { days: 7 }), null);
  assert.equal(buildRtbrPayload([{ name: 'Invalid' }], { days: 7 }), null);
});
