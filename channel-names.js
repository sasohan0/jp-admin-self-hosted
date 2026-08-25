// Discord templates often decorate channel names with emoji, separators, or
// numeric prefixes. Normalize those decorations before matching aliases.
function normalizeChannelName(name) {
  return String(name || '').toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^\d+-?/, '')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

module.exports = { normalizeChannelName };
