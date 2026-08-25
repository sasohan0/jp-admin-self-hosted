'use strict';

const APPEAL_SCOPES = Object.freeze({
  bootcamp: 'Bootcamp tracking',
  dawn: 'Dawn Focus Circle',
});

const APPEAL_CAUSES = Object.freeze({
  medical: 'Medical emergency',
  exam: 'Final examination',
  bereavement: 'Unfortunate death or bereavement',
  other: 'Other serious reason',
});

function parseAppealCommand(content) {
  const text = String(content || '').trim();
  if (!/^!appeals?(?:\s|$)/i.test(text)) return null;
  if (/^!appeals?(?:\s+(?:pending|list))?$/i.test(text)) return { action: 'list', status: 'pending' };
  if (/^!appeals?\s+all$/i.test(text)) return { action: 'list', status: '' };
  const decision = text.match(/^!appeal\s+(approve|decline|reject)\s+(\S+)(?:\s*\|\s*(.*))?$/i);
  if (!decision) return { action: 'help' };
  return {
    action: decision[1].toLowerCase() === 'approve' ? 'approved' : 'declined',
    requestId: decision[2],
    note: String(decision[3] || '').trim(),
  };
}

function validAppealCause(value) {
  return Object.prototype.hasOwnProperty.call(APPEAL_CAUSES, String(value || '').trim());
}

function sanitizeAppealText(value, maximum) {
  return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim().slice(0, maximum);
}

module.exports = {
  APPEAL_CAUSES,
  APPEAL_SCOPES,
  parseAppealCommand,
  sanitizeAppealText,
  validAppealCause,
};
