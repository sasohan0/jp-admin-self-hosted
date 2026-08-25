const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('./questions'), 'utf8');

test('scheduled and manual questions both use the runtime qwindow setting', () => {
  assert.match(source, /windowMin, gapMin/);
  assert.match(source, /getNumber\(cohort, 'qwindow'\)/);
  assert.match(source, /const windowMin = await getNumber\(cohort, 'qwindow'\)/);
  assert.doesNotMatch(source, /inDiscussion \? qcfg\(cohort\)\.discussionWindowMin/);
});

test('question control offers three editable periods and clickable controls', () => {
  for (const key of ['qmorningtime', 'qafternoontime', 'qeveningtime', 'qmorningcount', 'qafternooncount', 'qeveningcount']) {
    assert.match(source, new RegExp(key));
  }
  assert.match(source, /setCustomId\('qctl:edit'\)/);
  assert.match(source, /setCustomId\('qctl:replan'\)/);
  assert.match(source, /setCustomId\('qctl:drop'\)/);
  assert.match(source, /ChannelSelectMenuBuilder/);
  assert.match(source, /setCustomId\('qctl:channel'\)/);
  assert.match(source, /channel_questions/);
  assert.match(source, /subcommand === 'channel'/);
  assert.match(source, /\['amount', 'amounts'\]\.includes\(subcommand\)/);
});
