const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  catalogEntries,
  categoryPayload,
  commandCenterPayload,
  helpPayloads,
  searchCommands,
  searchPayload,
} = require('./help');

test('generated mentor reference contains every authoritative command', () => {
  const reference = fs.readFileSync(path.join(__dirname, 'MENTOR_COMMAND_REFERENCE.md'), 'utf8');
  const entries = catalogEntries();
  assert.match(reference, new RegExp(`all ${entries.length} commands`, 'i'));
  for (const entry of entries) {
    const rendered = entry.command.replace(/\|/g, '\\|');
    assert.ok(reference.includes(`\`${rendered}\``), `missing ${entry.command}`);
  }
});

test('help output retains every command while respecting Discord embed limits', () => {
  const payloads = helpPayloads();
  assert.ok(payloads.length >= 2);
  for (const payload of payloads) {
    const embed = payload.embeds[0];
    assert.ok(embed.fields.length <= 25);
    assert.ok(embed.fields.every(field => field.value.length <= 1024));
    const total = embed.title.length + embed.footer.text.length +
      embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
    assert.ok(total <= 6000);
  }
  const fullText = payloads.flatMap(payload => payload.embeds[0].fields)
    .map(field => field.value).join('\n');
  assert.match(fullText, /!contentsync run resources\|jobhunting one\|all/);
  assert.match(fullText, /!dawn setup\|invite\|status/);
  assert.match(fullText, /!activitycheck attendance \[YYYY-MM-DD\]\|jobs\|interviews\|all/);
});

test('command search finds commands by syntax, description, and category words', () => {
  const attendance = searchCommands('attendance repair');
  assert.ok(attendance.total >= 1);
  assert.ok(attendance.matches.some(item => item.command === '!repairattendance'));

  const target = searchCommands('job target');
  assert.ok(target.matches.some(item => item.command.includes('!targets') || item.command.includes('!target')));

  const none = searchCommands('definitely-not-a-real-command');
  assert.equal(none.total, 0);
  assert.deepEqual(none.matches, []);
});

test('command center builders stay within Discord component and embed limits', () => {
  const cohort = { guildId: '1534781682920456192', name: 'SCPC-13' };
  const center = commandCenterPayload(cohort);
  assert.equal(center.components.length, 2);
  assert.ok(center.components[0].components[0].options.length <= 25);
  assert.ok(center.embeds[0].description.length <= 4096);

  const category = categoryPayload(1);
  assert.ok(category.embeds[0].fields.length <= 25);
  assert.ok(category.embeds[0].fields.every(field => field.value.length <= 1024));

  const results = searchPayload('student');
  assert.ok(results.embeds[0].fields.length <= 25);
  assert.ok(results.embeds[0].fields.every(field => field.value.length <= 1024));
});
