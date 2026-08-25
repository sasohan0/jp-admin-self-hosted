const test = require('node:test');
const assert = require('node:assert/strict');
const {
  editableAnnouncementChannelIds,
  INTROS,
  parseDiscordMessageLink,
  parseEditCustomId,
} = require('./announce');

test('parses Discord message links for the pinned announcement editor', () => {
  assert.deepEqual(
    parseDiscordMessageLink('!editannouncement https://discord.com/channels/111/222/333'),
    { guildId: '111', channelId: '222', messageId: '333' }
  );
  assert.equal(parseDiscordMessageLink('not a message link'), null);
});

test('warning channel has an editable explanation of its quiet-success behavior', () => {
  assert.match(INTROS.warning, /silence does not mean the check failed/i);
  const ids = editableAnnouncementChannelIds({ channels: { warning: '77' } });
  assert.equal(ids.has('77'), true);
});

test('announcement editor allows rules and intro channels but not private admin', () => {
  const ids = editableAnnouncementChannelIds({
    channels: { rules: '10', discussion: '11', workshop: '12', supervisor: '99', welcome: '98' },
  });
  assert.equal(ids.has('10'), true);
  assert.equal(ids.has('11'), true);
  assert.equal(ids.has('12'), true);
  assert.equal(ids.has('99'), false);
  assert.equal(ids.has('98'), false);
});

test('announcement editor custom IDs accept only numeric channel and message IDs', () => {
  assert.deepEqual(parseEditCustomId('announcement_edit:222:333', 'announcement_edit:'), {
    channelId: '222', messageId: '333',
  });
  assert.equal(parseEditCustomId('announcement_edit:bad:333', 'announcement_edit:'), null);
});
