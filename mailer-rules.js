'use strict';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEMPLATE_TYPES = Object.freeze(['absent', 'warning1', 'warning2', 'inactive']);
const DEFAULT_SENDER_NAME = 'Job Placement — Programming Hero';
const MANDATORY_CC = Object.freeze(['solih@programming-hero.com']);

const DEFAULT_TEMPLATES = Object.freeze({
  absent: {
    subject: 'Action required today: Missed {{cohort}} session on {{date}}',
    body: `Dear Student,

Our attendance record shows that you missed the {{cohort}} bootcamp session on {{date}}. Regular attendance is required because every session contains placement guidance, tasks, and follow-up actions.

Please do these steps now:
1. If a medical, examination, family, or other serious issue prevented you from attending, open #issues in Discord and submit a leave request with the exact date and reason.
2. Contact your mentor on Discord as soon as possible and explain the situation. If this attendance record is incorrect, mention that clearly.
3. Review the missed announcements and tasks in Discord and complete them before the next session.
4. Join the next session on time.

Do not ignore this email. Continued unapproved absence can create an official warning.

Regards,
{{mentor_name}}
Job Placement Mentor
{{mentor_phone}}
Programming Hero`,
  },
  warning1: {
    subject: 'Urgent: Attendance Warning 1 of 3 — {{cohort}}',
    body: `Dear Student,

This is your first official attendance warning in {{cohort}}. The system found two consecutive bootcamp sessions missed without approved leave. You are still active, but only two warnings remain before deactivation.

Take action today:
1. Contact your mentor on Discord immediately and explain the exact missed dates and cause.
2. If the absence had a valid reason, submit the leave/issue details in #issues.
3. Catch up on every missed task and return to the next session on time.
4. If the record is wrong, reply to this email and contact your mentor in Discord.

Regular activity must resume now.

Regards,
{{mentor_name}}
Job Placement Mentor
{{mentor_phone}}
Programming Hero`,
  },
  warning2: {
    subject: 'Final warning: Attendance Warning 2 of 3 — Immediate action required',
    body: `Dear Student,

This is your second official attendance warning in {{cohort}}. You have now had two separate incidents of consecutive unapproved absence. Only one warning remains before your placement support is deactivated.

Take action immediately:
1. Contact your mentor in Discord today with the exact dates and a clear explanation.
2. Submit any valid leave/issue request in #issues.
3. Complete missed work and confirm how you will attend consistently from the next session.
4. If the record is incorrect, reply to this email and contact your mentor without delay.

This is the final opportunity to restore regular participation before deactivation.

Regards,
{{mentor_name}}
Job Placement Mentor
{{mentor_phone}}
Programming Hero`,
  },
  inactive: {
    subject: 'Deactivated: Appeal required within 24 hours — {{cohort}}',
    body: `Dear Student,

Your {{cohort}} job placement support is now inactive after reaching Attendance Warning 3 of 3. While inactive, your attendance, applications, outreach, interviews, RTBR/leaderboard points, and other bootcamp activity are not tracked for credit.

If a serious unavoidable situation caused these absences, take these steps within 24 hours:
1. Open #eliminated-student in Discord and use the Appeal button on your deactivation notice.
2. Select the valid cause, provide the exact affected dates, and explain what happened honestly and in detail.
3. State how you will resume consistent participation.
4. Contact your mentor on Discord immediately after submitting the appeal.

Valid causes may include a medical emergency, final examination, bereavement, or another serious unavoidable event. Reactivation happens only after mentor approval. If you cannot access the appeal notice, reply to this email and contact your mentor in Discord.

Regards,
{{mentor_name}}
Job Placement Mentor
{{mentor_phone}}
Programming Hero`,
  },
});

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase().replace(/^mailto:/, '').replace(/\s+/g, '');
  return EMAIL_RE.test(email) ? email : '';
}

function normalizeEmailList(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[;,\s]+/);
  return [...new Set(values.map(normalizeEmail).filter(Boolean))];
}

function defaultMailerConfig(cohortName = 'Bootcamp') {
  return {
    enabled: false,
    to: [], cc: [...MANDATORY_CC], bcc: [], replyTo: '',
    senderName: DEFAULT_SENDER_NAME,
    mentorName: 'Solih Ahmad Sohan',
    mentorPhone: '+8801746877767',
    templates: JSON.parse(JSON.stringify(DEFAULT_TEMPLATES)),
  };
}

function normalizeMailerConfig(value, cohortName = 'Bootcamp') {
  const defaults = defaultMailerConfig(cohortName);
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const templates = {};
  for (const type of TEMPLATE_TYPES) {
    const item = input.templates?.[type] || {};
    templates[type] = {
      subject: String(item.subject || defaults.templates[type].subject).trim().slice(0, 180),
      body: String(item.body || defaults.templates[type].body).trim().slice(0, 12000),
    };
  }
  const configuredSender = String(input.senderName || '').trim();
  const legacySender = `${String(cohortName || 'Bootcamp').trim()} Job Placement`;
  return {
    enabled: input.enabled === true,
    to: normalizeEmailList(input.to),
    cc: normalizeEmailList([...MANDATORY_CC, ...normalizeEmailList(input.cc)]),
    bcc: normalizeEmailList(input.bcc),
    replyTo: normalizeEmail(input.replyTo),
    senderName: (!configuredSender || configuredSender === legacySender
      ? defaults.senderName : configuredSender).slice(0, 120),
    mentorName: String(input.mentorName || defaults.mentorName).trim().slice(0, 120),
    mentorPhone: String(input.mentorPhone || defaults.mentorPhone).trim().slice(0, 80),
    templates,
  };
}

function renderTemplate(value, variables = {}) {
  return String(value || '').replace(/{{\s*([a-z0-9_]+)\s*}}/gi,
    (match, key) => Object.prototype.hasOwnProperty.call(variables, key)
      ? String(variables[key] ?? '') : match);
}

function warningForDate(record, date) {
  if (!record || Number(record.count || 0) < 1 || Number(record.count || 0) > 3) return false;
  const requested = String(date || '');
  const issued = String(record.lastWarningDate || '').trim();
  if (issued) return issued === requested;
  const evaluated = String(record.lastEvaluatedDate || '').trim();
  if (evaluated === requested) return true;
  // Compatibility for warnings issued by the former manual command, which
  // evaluated yesterday even though the mentor ran it today. Keep this narrow
  // so an unrelated historical state edit cannot create a warning email.
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(requested)
    ? new Date(`${requested}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return false;
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return evaluated === parsed.toISOString().slice(0, 10) &&
    String(record.updatedAt || '').slice(0, 10) === requested;
}

function buildMailerAudience({ roster = [], absentStudents = [], warningState = {}, date = '', isInactive }) {
  const absentIds = new Set(absentStudents.map(student => String(student.discordId || '')).filter(Boolean));
  const absentEmails = new Set(absentStudents.map(student => normalizeEmail(student.email)).filter(Boolean));
  const groups = {
    absent: [], warning1: [], warning2: [], inactive: [],
    skippedNoEmail: [], skippedInactive: [], skippedDuplicateEmail: [],
  };
  const warningRecipientIds = new Set();
  const seen = new Set();
  for (const student of roster) {
    const id = String(student.discordId || '');
    const email = normalizeEmail(student.email);
    if (!id || student.status === 'hired' || student.status === 'left') continue;
    const record = warningState[id] || {};
    if (!warningForDate(record, date)) continue;
    // A present or approved-leave mark on the mail date breaks the streak.
    // Never send a warning/inactive email solely from an older absence pair.
    if (!absentIds.has(id) && !(email && absentEmails.has(email))) continue;
    const type = Number(record.count) >= 3 ? 'inactive' : `warning${Number(record.count)}`;
    if (!email) {
      groups.skippedNoEmail.push({ ...student, mailType: type });
      warningRecipientIds.add(id);
      continue;
    }
    const key = `${type}:${email}`;
    if (!seen.has(key)) groups[type].push({ ...student, email });
    else groups.skippedDuplicateEmail.push({ ...student, email, mailType: type });
    seen.add(key);
    warningRecipientIds.add(id);
  }
  for (const student of roster) {
    const id = String(student.discordId || '');
    const email = normalizeEmail(student.email);
    if (!id || warningRecipientIds.has(id) || student.status === 'hired' || student.status === 'left') continue;
    if (!absentIds.has(id) && !(email && absentEmails.has(email))) continue;
    if (typeof isInactive === 'function' && isInactive(student)) {
      groups.skippedInactive.push({ ...student, email, mailType: 'absent' });
      continue;
    }
    if (!email) {
      groups.skippedNoEmail.push({ ...student, mailType: 'absent' });
      continue;
    }
    const key = `absent:${email}`;
    if (!seen.has(key)) groups.absent.push({ ...student, email });
    else groups.skippedDuplicateEmail.push({ ...student, email, mailType: 'absent' });
    seen.add(key);
  }
  return groups;
}

function templateVariables(config, cohort, date, type) {
  return {
    cohort: cohort.name,
    date,
    warning_count: type === 'warning1' ? '1' : type === 'warning2' ? '2' : type === 'inactive' ? '3' : '',
    warnings_remaining: type === 'warning1' ? '2' : type === 'warning2' ? '1' : '0',
    mentor_name: config.mentorName,
    mentor_phone: config.mentorPhone,
  };
}

module.exports = {
  DEFAULT_SENDER_NAME,
  DEFAULT_TEMPLATES,
  MANDATORY_CC,
  TEMPLATE_TYPES,
  buildMailerAudience,
  defaultMailerConfig,
  normalizeEmail,
  normalizeEmailList,
  normalizeMailerConfig,
  renderTemplate,
  templateVariables,
  warningForDate,
};
