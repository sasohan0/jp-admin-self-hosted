// Split report lines into Discord-safe message bodies. A single malformed
// tracker label or company value must never abort the remainder of an audit.
function splitLongText(value, maxLen) {
  const parts = [];
  let rest = String(value || '');
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf(' ', maxLen);
    if (cut < Math.floor(maxLen * 0.6)) cut = maxLen;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

function chunkLines(lines, maxLen = 1900) {
  if (!Number.isInteger(maxLen) || maxLen < 1) throw new Error('maxLen must be a positive integer');
  const chunks = [];
  let current = '';

  for (const rawLine of lines || []) {
    for (const line of splitLongText(rawLine, maxLen)) {
      if (current && current.length + line.length + 1 > maxLen) {
        chunks.push(current);
        current = '';
      }
      current += (current ? '\n' : '') + line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

module.exports = { chunkLines };
