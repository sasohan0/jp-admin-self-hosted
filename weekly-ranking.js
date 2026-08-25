function dateKey(date, timezone) {
  return date.toLocaleDateString('en-CA', { timeZone: timezone });
}

function shiftDateKey(key, days) {
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function currentWorkWeek(date, timezone) {
  const end = dateKey(date, timezone);
  const weekday = new Date(`${end}T00:00:00Z`).getUTCDay();
  const start = shiftDateKey(end, -weekday);
  const keys = [];
  for (let key = start; key <= end; key = shiftDateKey(key, 1)) keys.push(key);
  return { start, end, keys };
}

function rankWeeklyStudents(students) {
  return [...students].sort((a, b) =>
    (Number(b.jobs) || 0) - (Number(a.jobs) || 0) ||
    (Number(b.attendance) || 0) - (Number(a.attendance) || 0) ||
    (Number(b.interviews) || 0) - (Number(a.interviews) || 0) ||
    (Number(b.outreach) || 0) - (Number(a.outreach) || 0) ||
    (Number(b.communicationPractices) || 0) - (Number(a.communicationPractices) || 0) ||
    String(a.name || '').localeCompare(String(b.name || ''))
  );
}

function metricProgress(student, targets, key) {
  const value = Number(student[key]) || 0;
  const target = Number(targets?.[key]) || 0;
  return target > 0 ? `${value}/${target}` : String(value);
}

function weeklyLine(student, position, targets) {
  const medal = position === 1 ? '🥇' : position === 2 ? '🥈' : position === 3 ? '🥉' : `**${position}.**`;
  const rtbr = Number(student.rtbrRank) > 0
    ? `#${Number(student.rtbrRank)} · ${Number(student.rtbrPoints) || 0} pts`
    : `${Number(student.rtbrPoints) || 0} pts`;
  return `${medal} **${student.name}** — Apps **${metricProgress(student, targets, 'jobs')}** | Attendance **${metricProgress(student, targets, 'attendance')}** | Total interviews **${metricProgress(student, targets, 'interviews')}** | Outreach ${metricProgress(student, targets, 'outreach')} | Communication ${metricProgress(student, targets, 'communicationPractices')} | Workshops ${metricProgress(student, targets, 'workshops')} | RTBR **${rtbr}**`;
}

module.exports = { currentWorkWeek, dateKey, metricProgress, rankWeeklyStudents, shiftDateKey, weeklyLine };
