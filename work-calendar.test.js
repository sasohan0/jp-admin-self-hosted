const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  DEFAULT_WORKDAYS,
  calendarDecision,
  calendarDateOptions,
  dateKeyInZone,
  parseCalendarCommand,
  parseCalendarDays,
  parseStoredDays,
  parseStoredOverrides,
  previousWorkingDates,
  resolveDateArgument,
  statusPayload,
} = require('./work-calendar');

test('calendar commands accept weekly days, date overrides, aliases, and announcement context', () => {
  assert.deepEqual(parseCalendarCommand('!calendar'), { action: 'status' });
  assert.deepEqual(parseCalendarCommand('!calendar week sun-thu | Friday and Saturday are holidays'), {
    action: 'week', head: 'sun-thu', context: 'Friday and Saturday are holidays',
  });
  assert.deepEqual(parseCalendarCommand('!holiday 2026-08-15 | National holiday'), {
    action: 'holiday', head: '2026-08-15', context: 'National holiday',
  });
  assert.deepEqual(parseCalendarCommand('!workingday tomorrow | Replacement session'), {
    action: 'working', head: 'tomorrow', context: 'Replacement session',
  });
  assert.deepEqual(parseCalendarCommand('!calendar nonsense'), { action: 'invalid' });
  assert.equal(parseCalendarCommand('!attendance'), null);
});

test('weekly calendar defaults to Sunday through Thursday and accepts wraparound ranges', () => {
  assert.deepEqual(parseStoredDays(''), DEFAULT_WORKDAYS);
  assert.deepEqual(parseCalendarDays('sun-thu'), [0, 1, 2, 3, 4]);
  assert.deepEqual(parseCalendarDays('fri-tue'), [0, 1, 2, 5, 6]);
  assert.deepEqual(parseCalendarDays('everyday'), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(parseCalendarDays('sun-funday'), null);
});

test('date overrides win over regular Friday and Saturday holidays', () => {
  const calendar = {
    workdays: [...DEFAULT_WORKDAYS],
    overrides: {
      '2026-08-14': { type: 'working', context: 'Special class' },
      '2026-08-16': { type: 'holiday', context: 'Cohort holiday' },
    },
  };
  assert.equal(calendarDecision(calendar, '2026-08-14').working, true); // Friday override
  assert.equal(calendarDecision(calendar, '2026-08-15').working, false); // Saturday default
  assert.equal(calendarDecision(calendar, '2026-08-16').working, false); // Sunday override
  assert.equal(calendarDecision(calendar, '2026-08-17').working, true);
});

test('previous working dates skip regular holidays and respect overrides', () => {
  const calendar = {
    workdays: [...DEFAULT_WORKDAYS],
    overrides: { '2026-08-14': { type: 'working', context: '' } },
  };
  assert.deepEqual(previousWorkingDates(calendar, '2026-08-16', 3), [
    '2026-08-12', '2026-08-13', '2026-08-14',
  ]);
});

test('calendar dates use the cohort timezone and reject impossible dates', () => {
  const instant = new Date('2026-08-11T19:30:00Z');
  assert.equal(dateKeyInZone('Asia/Dhaka', instant), '2026-08-12');
  assert.equal(resolveDateArgument('today', 'Asia/Dhaka', instant), '2026-08-12');
  assert.equal(resolveDateArgument('tomorrow', 'Asia/Dhaka', instant), '2026-08-13');
  assert.equal(resolveDateArgument('2026-02-30', 'Asia/Dhaka', instant), '');
});

test('stored override parsing ignores malformed records and bounds context', () => {
  const parsed = parseStoredOverrides(JSON.stringify({
    '2026-08-15': { type: 'holiday', context: 'Closed' },
    bad: { type: 'working' },
    '2026-08-16': { type: 'unknown' },
  }));
  assert.deepEqual(parsed, { '2026-08-15': { type: 'holiday', context: 'Closed' } });
});

test('calendar status never pings users or everyone', () => {
  const payload = statusPayload(
    { name: 'TEST' },
    { workdays: [...DEFAULT_WORKDAYS], overrides: {} },
    '2026-08-14',
  );
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.match(payload.embeds[0].fields[1].value, /Fri, Sat/);
});

test('calendar date selector exposes the next 25 cohort dates and their effective state', () => {
  const calendar = {
    workdays: [...DEFAULT_WORKDAYS],
    overrides: { '2026-08-16': { type: 'holiday', context: 'Special closure' } },
  };
  const options = calendarDateOptions(calendar, '2026-08-14');
  assert.equal(options.length, 25);
  assert.equal(options[0].value, '2026-08-14');
  assert.match(options[0].label, /^Today/);
  assert.equal(options[2].value, '2026-08-16');
  assert.match(options[2].description, /Holiday · override/);
});

test('every scheduled automation is calendar-gated while live activity collection stays event-driven', () => {
  const scheduler = fs.readFileSync(require.resolve('./scheduler'), 'utf8');
  const outreach = fs.readFileSync(require.resolve('./outreach'), 'utf8');
  const interview = fs.readFileSync(require.resolve('./interview'), 'utf8');
  const questions = fs.readFileSync(require.resolve('./questions'), 'utf8');
  const workshop = fs.readFileSync(require.resolve('./workshop'), 'utf8');
  const hired = fs.readFileSync(require.resolve('./hired'), 'utf8');
  const runtimeSchedule = fs.readFileSync(require.resolve('./runtime-schedule'), 'utf8');
  assert.match(scheduler, /await getCalendarDay\(cohort\)/);
  assert.match(scheduler, /if \(!calendar\.working\) return false/);
  assert.match(questions, /drop suppressed \(holiday\/not scheduled\)/);
  assert.match(workshop, /poll close suppressed \(holiday\/not scheduled\)/);
  assert.match(workshop, /runPoll\(client, cohort, \{ name: 'Manual' \}, true\)/);
  assert.match(outreach, /logOutreach/);
  assert.doesNotMatch(outreach.slice(outreach.indexOf("client.on('messageCreate'"), outreach.indexOf('// ---------- supervisor commands ----------')), /isScheduledToday/);
  assert.match(interview, /client\.on\('messageCreate'/);
  assert.match(hired, /client\.on\('messageCreate'/);
  assert.doesNotMatch(hired, /isScheduledToday/);
  assert.match(runtimeSchedule, /await getCalendarDay\(cohort, now\)/);
  for (const file of [
    'activity-automation.js', 'attendance.js', 'content-sync.js', 'dawn-discipline.js',
    'dm-nudges.js', 'jobs.js', 'outreach.js', 'questions.js', 'resources.js',
    'rtbr.js', 'suggest.js', 'weekly-report.js', 'workshop.js',
  ]) {
    const scheduledModule = fs.readFileSync(require.resolve(`./${file}`), 'utf8');
    assert.match(scheduledModule, /isScheduledToday/, `${file} must use the global calendar gate`);
  }
});
