'use strict';

function clean(value, limit = 300) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, limit);
}

function labeledValue(text, labels) {
  const pattern = new RegExp(
    `(?:^|[\\n|•;])\\s*(?:${labels.join('|')})\\s*[:\\-]\\s*([^\\n|•;]+)`,
    'i',
  );
  return clean(text.match(pattern)?.[1] || '');
}

function meaningful(value) {
  const normalized = clean(value).toLowerCase();
  return Boolean(normalized) && !/^(?:n\/?a|na|none|not applicable|-+)$/i.test(normalized);
}

function splitCompanyAndRole(value) {
  const source = clean(value);
  if (!meaningful(source)) return { company: '', role: '' };
  const parts = source.split(/\s+(?:-|—|–)\s+|\s*,\s*/).filter(Boolean);
  if (parts.length < 2) return { company: source, role: '' };
  return { company: clean(parts.shift()), role: clean(parts.join(' - ')) };
}

function looksLikeInterviewAnnouncement(text) {
  const source = clean(text, 4000);
  if (!source || !/\binterview\b/i.test(source)) return false;
  const structured = /\b(?:interview\s*serial|company(?:\s+and\s+position)?|organisation|organization|role|position|interview\s+date(?:\s+and\s+time)?|date|time|location|remote\s*\/\s*onsite)\s*[:\-]/i.test(source);
  const scheduled = /\b(?:scheduled|upcoming|call|invited|shortlisted|received|got|faced|completed|attended|today|tomorrow|next\s+(?:round|week)|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i.test(source);
  const resultOnly = /\b(?:failed|rejected|result|feedback|passed)\b/i.test(source) &&
    !structured && !/\b(?:next\s+round|another\s+interview|scheduled|upcoming|faced|completed|attended)\b/i.test(source);
  const congratulation = /^\s*(?:congratulations?|congrats|best of luck|good luck)\b/i.test(source);
  return !congratulation && !resultOnly && (structured || scheduled);
}

function splitInterviewSections(text) {
  const source = String(text || '').trim();
  const starts = [...source.matchAll(/(?:^|\n)\s*(?:interview\s*)?(?:serial|no\.?|number)\s*[:#-]?\s*(?:\d+|first|second|third|fourth|fifth|1st|2nd|3rd|\d+th)\b/gi)];
  if (starts.length < 2) return [source];
  const sections = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].index;
    const end = i + 1 < starts.length ? starts[i + 1].index : source.length;
    sections.push(source.slice(start, end).trim());
  }
  return sections.filter(Boolean).slice(0, 10);
}

function parseInterviewAnnouncements(text) {
  if (!looksLikeInterviewAnnouncement(text)) return [];
  const sections = splitInterviewSections(text);
  return sections.map(section => {
    const combinedCompany = labeledValue(section, ['company\\s+and\\s+position']);
    const separated = splitCompanyAndRole(combinedCompany);
    const combinedDate = labeledValue(section, ['interview\\s+date\\s+and\\s+time']);
    const item = {
      company: labeledValue(section, ['company(?:\\s+name)?', 'organisation', 'organization']) || separated.company,
      role: labeledValue(section, ['role', 'position', 'job\\s+title']) || separated.role,
      date: labeledValue(section, ['interview\\s+date(?:\\s+and\\s+time)?', 'date']) || combinedDate,
      time: labeledValue(section, ['interview\\s+time', 'time']),
      location: labeledValue(section, ['remote\\s*\\/\\s*onsite', 'location', 'mode', 'venue']),
    };
    for (const key of Object.keys(item)) if (!meaningful(item[key])) item[key] = '';
    return item;
  }).filter(item =>
    item.company || item.role || item.date || item.time || item.location ||
    (/\b(?:faced|completed|attended|scheduled|received|got)\b/i.test(text) && !/\bn\/?a\b/i.test(text))
  );
}

module.exports = {
  looksLikeInterviewAnnouncement,
  meaningful,
  parseInterviewAnnouncements,
  splitCompanyAndRole,
  splitInterviewSections,
};
