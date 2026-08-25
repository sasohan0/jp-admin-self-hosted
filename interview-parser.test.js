const test = require('node:test');
const assert = require('node:assert/strict');
const {
  looksLikeInterviewAnnouncement,
  parseInterviewAnnouncements,
} = require('./interview-parser');

test('parses one structured interview without AI', () => {
  const parsed = parseInterviewAnnouncements(`
    Interview Serial: 2nd
    Company: Acme Ltd
    Role: Frontend Developer
    Date: 29 July 2026
    Time: 5:00 PM
    Location: Remote
  `);
  assert.deepEqual(parsed, [{
    company: 'Acme Ltd',
    role: 'Frontend Developer',
    date: '29 July 2026',
    time: '5:00 PM',
    location: 'Remote',
  }]);
});

test('keeps multiple structured interviews as separate durable events', () => {
  const parsed = parseInterviewAnnouncements(`
Interview Serial: 1st
Company: One Ltd
Date: 29 July 2026

Interview Serial: 2nd
Company: Two Ltd
Date: 30 July 2026
  `);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].company, 'One Ltd');
  assert.equal(parsed[1].company, 'Two Ltd');
});

test('does not log congratulations or result-only messages', () => {
  assert.equal(looksLikeInterviewAnnouncement('Congratulations on your interview!'), false);
  assert.equal(looksLikeInterviewAnnouncement('Interview result: I was rejected today.'), false);
  assert.deepEqual(parseInterviewAnnouncements('Good luck for your interview tomorrow!'), []);
});

test('accepts the official combined-field template even with a result label', () => {
  const parsed = parseInterviewAnnouncements(`
Interview serial: n/a
Company and position: Digi web Pro, Full-Stack Python Developer
Interview date and time: 11:30 PM (Bangladesh Time), Friday, August 21, 2026
Remote / onsite: remote interview
Current stage / result:
Preparation help needed: need help
  `);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].company, 'Digi web Pro');
  assert.equal(parsed[0].role, 'Full-Stack Python Developer');
  assert.match(parsed[0].date, /August 21, 2026/);
  assert.equal(parsed[0].location, 'remote interview');
});

test('counts a concise faced-interview update but rejects an empty N/A template', () => {
  assert.equal(parseInterviewAnnouncements('I faced interview today 16 Aug at 4:40 PM').length, 1);
  assert.deepEqual(parseInterviewAnnouncements(`
Interview serial: N/A
Company and position: N/A
Interview date and time: N/A
Remote / onsite: N/A
Current stage / result: N/A
  `), []);
});
