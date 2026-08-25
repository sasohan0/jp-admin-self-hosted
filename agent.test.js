const test = require('node:test');
const assert = require('node:assert/strict');
const { catalogEntries } = require('./help');
const {
  buildCommandReference,
  deterministicPlan,
  extractTimeRange,
  rankNaturalCommands,
  supportedSuggestions,
} = require('./agent-intent');

const entries = catalogEntries();

test('JP reference is generated from the authoritative help catalog', () => {
  const reference = buildCommandReference(entries);
  assert.match(reference, /!dawn attendance/);
  assert.match(reference, /!onboardingreminder/);
  assert.match(reference, /!rtbr/);
  assert.equal(reference.split('\n').length, entries.length);
});

test('JP asks which Dawn window is intended and resolves natural follow-up times', () => {
  const ambiguous = deterministicPlan('change the dawn window');
  assert.match(ambiguous.question, /send messages.*Dawn attendance/i);
  const attendance = deterministicPlan('change dawn attendance window. Answer: 5 am to 7 am');
  assert.deepEqual(attendance.commands, ['!dawn attendance 05:00-07:00']);
  const sending = deterministicPlan('keep the dawn channel open always');
  assert.deepEqual(sending.commands, ['!dawn window always']);
});

test('JP builds cohort-local target and automation commands from natural requests', () => {
  assert.deepEqual(deterministicPlan('please set the daily job application target to 10').commands, ['!target applications 10']);
  assert.match(deterministicPlan('change outreach quota').question, /What should the outreach target/i);
  assert.deepEqual(deterministicPlan('turn off the question automation').commands, ['!automation stop questions']);
  assert.deepEqual(deterministicPlan('find students missing onboarding and profile').commands, ['!completioncheck']);
});

test('JP resolves a student-status follow-up containing a raw Discord ID', () => {
  const missing = deterministicPlan('make an inactive student active');
  assert.match(missing.question, /Discord ID or @mention/i);
  const resolved = deterministicPlan('make an inactive student active. Answer: 1296692725575454762');
  assert.deepEqual(resolved.commands, ['!studentstatus 1296692725575454762 active']);
  assert.deepEqual(
    deterministicPlan('exclude member <@1296692725575454762>').commands,
    ['!studentstatus 1296692725575454762 inactive'],
  );
});

test('JP resolves the active/inactive management dashboard naturally', () => {
  assert.deepEqual(
    deterministicPlan('show active and inactive student counts and manage the lists').commands,
    ['!studentstatuspanel'],
  );
});

test('natural command ranking ignores conversational filler', () => {
  const matches = rankNaturalCommands('how can I repair missing attendance students', entries, 5);
  assert.ok(matches.some(item => item.command === '!repairattendance'));
});

test('JP time parsing accepts mobile-friendly natural ranges', () => {
  assert.equal(extractTimeRange('from 5.30 am to 7 am'), '05:30-07:00');
  assert.equal(extractTimeRange('4 PM - 11 PM'), '16:00-23:00');
  assert.equal(extractTimeRange('no useful time here'), null);
});

test('AI suggestions are capped, deduplicated, and reject invented command roots', () => {
  assert.deepEqual(supportedSuggestions(['!rtbr', '!not-a-command now', '!rtbr', '!attendance'], entries), ['!rtbr', '!attendance']);
});
