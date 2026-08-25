const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CHANNEL_NAME,
  LIMITS,
  ROLE_NAME,
  defaultProfile,
  enrollmentPayload,
  isDawnAttendanceDay,
  localMinutes,
  weekStartKey,
} = require('./dawn-discipline');

test('Dawn Focus identity and permit policy remain stable', () => {
  assert.equal(CHANNEL_NAME, 'dawn-focus-circle');
  assert.equal(ROLE_NAME, 'Dawn Focus Circle');
  assert.deepEqual(LIMITS, { medical: 2, exam: 2, recommit: 1 });
  assert.deepEqual(defaultProfile(), {
    status: 'active', missed: 0, missedDates: [], pending: false, lastReviewedDate: '',
    everJoined: false, rolePresent: null, lastMembershipEvent: null,
    appealRequired: false,
    permits: { medical: 0, exam: 0, recommit: 0 },
  });
});

test('Dawn attendance is limited to Sunday through Thursday', () => {
  assert.equal(isDawnAttendanceDay('Asia/Dhaka', new Date('2026-08-13T00:00:00Z')), true);
  assert.equal(isDawnAttendanceDay('Asia/Dhaka', new Date('2026-08-14T00:00:00Z')), false);
  assert.equal(isDawnAttendanceDay('Asia/Dhaka', new Date('2026-08-15T00:00:00Z')), false);
});

test('Dawn enrollment markets benefits and states honesty and permit terms', () => {
  const payload = enrollmentPayload({ name: 'SCPC-13', guildId: '123' });
  const text = payload.embeds[0].description;
  assert.match(text, /exclusive communication workshops/i);
  assert.match(text, /AI learning/i);
  assert.match(text, /2 medical-emergency permits/i);
  assert.match(text, /Allah is watching/i);
  assert.deepEqual(payload.allowedMentions, { parse: ['everyone'] });
});

test('Dawn time helpers use cohort-local time and Sunday week starts', () => {
  assert.equal(localMinutes('Asia/Dhaka', new Date('2026-08-09T00:15:00.000Z')), 6 * 60 + 15);
  assert.equal(weekStartKey('2026-08-13'), '2026-08-09');
});

test('Dawn channel repair uses normal text access without per-miss member lockouts', () => {
  const source = fs.readFileSync(path.join(__dirname, 'dawn-discipline.js'), 'utf8');
  assert.match(source, /type: ChannelType\.GuildText/);
  assert.match(source, /CreatePublicThreads: false/);
  assert.match(source, /action: 'repairDawnAttendance'/);
  assert.match(source, /action: 'syncDawnMembers'/);
  assert.match(source, /repair\|sync\|add/);
  assert.match(source, /Offline role removals reconciled/);
  assert.match(source, /const setupPromises = new Map\(\)/);
  assert.match(source, /guild\.members\.list\(\{ limit: 1000 \}\)/);
  assert.doesNotMatch(source, /guild\.members\.fetch\(\)/);
  assert.doesNotMatch(source, /message\.guild\.members\.fetch\(\)/);
  assert.doesNotMatch(source, /Missed Dawn Focus check-in window/);
});

test('Dawn review anchors history to the configured window and fails closed on read errors', () => {
  const source = fs.readFileSync(path.join(__dirname, 'dawn-discipline.js'), 'utf8');
  assert.match(source, /before = discordSnowflakeAt\(bounds\.endMs\)/);
  assert.match(source, /timestamp >= bounds\.startMs && timestamp < bounds\.endMs/);
  assert.match(source, /exceeded 1,000 messages/);
  assert.doesNotMatch(source, /fetchDawnWindowMessages\([^\n]+\)\.catch\(\(\) => \[\]\)/);
  assert.match(source, /newly recovered presence must undo today's false miss/);
});
