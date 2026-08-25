'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  attendanceWindowUtcBounds,
  discordSnowflakeAt,
  firstQualifyingMessages,
  isChannelWindowOpen,
  isInDawnWindow,
  isVerifiedDawnEmail,
  membershipTransition,
  parseAttendanceWindow,
  parseChannelWindow,
} = require('./dawn-attendance');

test('Dawn attendance window includes 05:00 through before 07:00 in cohort time', () => {
  assert.equal(isInDawnWindow('2026-08-12T22:59:59.000Z', 'Asia/Dhaka', '2026-08-13'), false);
  assert.equal(isInDawnWindow('2026-08-12T23:00:00.000Z', 'Asia/Dhaka', '2026-08-13'), true);
  assert.equal(isInDawnWindow('2026-08-13T00:59:59.000Z', 'Asia/Dhaka', '2026-08-13'), true);
  assert.equal(isInDawnWindow('2026-08-13T01:00:00.000Z', 'Asia/Dhaka', '2026-08-13'), false);
});

test('Dawn attendance range is configurable but bounded to one local day', () => {
  assert.equal(parseAttendanceWindow('always'), null);
  assert.equal(parseAttendanceWindow('22:00-02:00'), null);
  assert.equal(parseAttendanceWindow('05:00-07:00').label, '05:00-07:00');
  assert.equal(parseAttendanceWindow('05:00-12:00'), null);
  const bounds = attendanceWindowUtcBounds('2026-08-16', 'Asia/Dhaka', '05:00-07:00');
  assert.equal(new Date(bounds.startMs).toISOString(), '2026-08-15T23:00:00.000Z');
  assert.equal(new Date(bounds.endMs).toISOString(), '2026-08-16T01:00:00.000Z');
  assert.match(discordSnowflakeAt(bounds.endMs), /^\d{15,20}$/);
});

test('Dawn channel sending window defaults to always and supports overnight ranges', () => {
  assert.deepEqual(parseChannelWindow(''), { mode: 'always', label: 'always open' });
  const daytime = parseChannelWindow('05:30-08:00');
  assert.equal(isChannelWindowOpen(daytime, 6 * 60), true);
  assert.equal(isChannelWindowOpen(daytime, 9 * 60), false);
  const overnight = parseChannelWindow('22:00-02:00');
  assert.equal(isChannelWindowOpen(overnight, 23 * 60), true);
  assert.equal(isChannelWindowOpen(overnight, 60), true);
  assert.equal(parseChannelWindow('07:00-07:00'), null);
});

test('Dawn batch chooses each eligible member first non-empty message only', () => {
  const messages = [
    { authorId: '1', createdAt: '2026-08-13T00:10:00.000Z', content: 'later' },
    { authorId: '1', createdAt: '2026-08-12T23:30:00.000Z', content: 'Salam at 5:30' },
    { authorId: '2', createdAt: '2026-08-12T23:05:00.000Z', content: '' },
    { authorId: '3', createdAt: '2026-08-12T23:05:00.000Z', content: 'not a member' },
    { authorId: '2', createdAt: '2026-08-12T22:59:59.000Z', content: 'too early' },
  ];
  const found = firstQualifyingMessages(messages, ['1', '2'], 'Asia/Dhaka', '2026-08-13');
  assert.equal(found.size, 1);
  assert.equal(found.get('1').content, 'Salam at 5:30');
});

test('Dawn membership lifecycle distinguishes join, removal, and rejoin', () => {
  const joined = membershipTransition({}, true, '2026-08-13');
  assert.equal(joined.event, 'Joined');
  assert.equal(joined.rolePresent, true);
  assert.equal(membershipTransition({ ...joined }, true, '2026-08-13').changed, false);
  const removed = membershipTransition({ ...joined }, false, '2026-08-16');
  assert.equal(removed.event, 'Removed');
  const rejoined = membershipTransition({ ...removed }, true, '2026-08-20');
  assert.equal(rejoined.event, 'Rejoined');
});

test('Dawn sync distinguishes verified contacts from provisional roster identities', () => {
  assert.equal(isVerifiedDawnEmail('student@example.com'), true);
  assert.equal(isVerifiedDawnEmail('discord.123456789012345678@pending.jp-admin.invalid'), false);
  assert.equal(isVerifiedDawnEmail(''), false);
});
