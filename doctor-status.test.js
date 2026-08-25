const test = require('node:test');
const assert = require('node:assert/strict');
const { formatRosterDoctor } = require('./doctor');

test('doctor roster reports every captured Discord student and incomplete private profiles', () => {
  const roster = Array.from({ length: 45 }, (_, i) => ({
    email: `student${i}@example.com`,
    discordId: String(i + 1),
    status: 'active',
  }));
  assert.equal(
    formatRosterDoctor(roster, {
      total: 60,
      verified: 45,
      needsVerification: 15,
      incompleteProfiles: 15,
    }),
    '45 verified active students; 60 current Discord students captured in Roster Review; ⚠️ 15 need private profile data; 15 provisional/incomplete identities',
  );
});

test('doctor roster retains a useful pre-v29 fallback', () => {
  assert.equal(
    formatRosterDoctor([{ email: 'a@example.com', discordId: '1', status: 'active' }], {}),
    '1 students loaded, all mapped; Roster Review has not been populated yet',
  );
});
