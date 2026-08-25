const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  encodeAdminProfileCustomId,
  encodeSurveyCustomId,
  hasLegacyVerificationButton,
  hasCompletePrivateProfile,
  normalizeMissingFields,
  parseAdminProfileCustomId,
  parseEditProfileTargetId,
  parseSurveyCustomId,
  selectAttentionProfiles,
} = require('./student-data-survey');

test('portal-admitted members with complete private data do not receive a duplicate survey', () => {
  assert.equal(hasCompletePrivateProfile({
    name: 'Student', email: 'student@example.com', phone: '01700000000',
    region: 'Dhaka', subregion: 'Mirpur',
  }), true);
  assert.equal(hasCompletePrivateProfile({
    name: 'Student', email: 'student@example.com', phone: '',
    region: 'Dhaka', subregion: 'Mirpur',
  }), false);
  assert.equal(hasCompletePrivateProfile({
    name: 'Student', email: 'discord.785818245977735169@pending.jp-admin.invalid',
    phone: '01700000000', region: 'Dhaka', subregion: 'Mirpur',
  }), false);
});

test('private survey fields are allow-listed and kept in stable modal order', () => {
  assert.deepEqual(
    normalizeMissingFields(['phone', 'unknown', 'email', 'phone']),
    ['email', 'phone'],
  );
});

test('private survey custom IDs preserve guild and requested fields', () => {
  const id = encodeSurveyCustomId(
    'jp_profile_start:',
    '1527624228830969967',
    ['subregion', 'name', 'phone'],
  );
  assert.deepEqual(parseSurveyCustomId(id, 'jp_profile_start:'), {
    guildId: '1527624228830969967',
    fields: ['name', 'phone', 'subregion'],
  });
  assert.equal(parseSurveyCustomId(id, 'wrong:'), null);
});

test('attention survey includes missing-email profiles and only zero-job incomplete profiles', () => {
  const profiles = [
    { discordId: '1', username: 'missing-email' },
    { discordId: '2', username: 'zero-jobs' },
    { discordId: '3', username: 'has-jobs' },
  ];
  const roster = [
    { discordId: '1', email: '' },
    { discordId: '2', email: 'zero@example.com' },
    { discordId: '3', email: 'jobs@example.com' },
  ];
  const activity = [
    { email: 'zero@example.com', jobPts: 0 },
    { email: 'jobs@example.com', jobPts: 5 },
  ];
  assert.deepEqual(
    selectAttentionProfiles(profiles, roster, activity).map(item => item.discordId),
    ['1', '2'],
  );
});

test('channel profile button is bound to one guild and requests the canonical fields', () => {
  assert.deepEqual(parseSurveyCustomId(
    'jp_profile_channel:1527624228830969967',
    'jp_profile_channel:',
  ), {
    guildId: '1527624228830969967',
    fields: ['name', 'email', 'phone', 'region', 'subregion'],
  });
});

test('legacy welcome verification panels can be discovered for removal', () => {
  assert.equal(hasLegacyVerificationButton({
    components: [{ components: [{ customId: 'jp_roster_verify_start' }] }],
  }), true);
  assert.equal(hasLegacyVerificationButton({ components: [] }), false);
});

test('supervisor profile editor IDs are bound to one guild and one student', () => {
  const prefix = 'jp_profile_admin_edit:';
  const id = encodeAdminProfileCustomId(
    prefix,
    '1527624228830969967',
    '688079587728556043',
  );
  assert.deepEqual(parseAdminProfileCustomId(id, prefix), {
    guildId: '1527624228830969967',
    discordId: '688079587728556043',
  });
  assert.equal(parseAdminProfileCustomId(`${id}:unexpected`, prefix), null);
  assert.equal(parseAdminProfileCustomId(id, 'wrong:'), null);
});

test('manual profile correction accepts a raw Discord ID without requiring a ping', () => {
  assert.equal(
    parseEditProfileTargetId('!editprofile 785818245977735169'),
    '785818245977735169',
  );
  assert.equal(
    parseEditProfileTargetId('!editprofile <@!785818245977735169>'),
    '785818245977735169',
  );
  assert.equal(parseEditProfileTargetId('!editprofile student-name'), '');
});

test('manual profile modal does not wait for a backend read before opening', () => {
  const source = fs.readFileSync(require.resolve('./student-data-survey'), 'utf8');
  const handler = source.slice(
    source.indexOf('const adminEdit = parseAdminProfileCustomId'),
    source.indexOf('[DASHBOARD_SEND_ID, DASHBOARD_REFRESH_ID]'),
  );
  assert.match(handler, /interaction\.showModal/);
  assert.doesNotMatch(handler, /await getRoster|members\.fetch/);
  assert.match(handler, /ADMIN_SUBMIT_PREFIX, cohort\.guildId, adminEdit\.discordId/);
  assert.doesNotMatch(handler, /ADMIN_SUBMIT_PREFIX, cohort\.guildId, member\.id/);
});
