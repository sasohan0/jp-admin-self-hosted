const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { confirmationButtons } = require('./workshop');

test('daily and Dawn workshop announcements require an explicit confirmation button', () => {
  const daily = confirmationButtons('daily', '2026-08-12').toJSON();
  const special = confirmationButtons('special', '2026-08-20').toJSON();
  assert.equal(daily.components[0].custom_id, 'wctl:send:daily:2026-08-12');
  assert.equal(special.components[0].custom_id, 'wctl:send:special:2026-08-20');
});

test('scheduled workshop flow creates private approval and gates later events on approval', () => {
  const source = fs.readFileSync(require.resolve('./workshop'), 'utf8');
  assert.match(source, /once\('approval', \(\) => requestApproval/);
  assert.match(source, /getSetting\(cohort, 'workshoplastsent'\)/);
  assert.match(source, /No public schedule\/reminder\/poll is sent until a supervisor confirms/);
  assert.match(source, /ROLE_NAME/);
  assert.match(source, /allowedMentions: \{ roles: \[role\.id\] \}/);
  assert.match(source, /Daily workshop automation is OFF/);
  assert.match(source, /Dawn special-workshop automation is OFF/);
});
