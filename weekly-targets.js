const { getNumber, getSetting } = require('./settings');
const { calendarDecision, loadWorkCalendar } = require('./work-calendar');

function parseSchedule(rawSchedule) {
  if (!rawSchedule) return null;
  try {
    const parsed = JSON.parse(rawSchedule);
    return Array.isArray(parsed) && parsed.length ? new Set(parsed.map(Number)) : null;
  } catch {
    return null;
  }
}

function scheduledDayCount(start, end, rawSchedule, calendar = null) {
  const allowed = parseSchedule(rawSchedule);
  let count = 0;
  const last = new Date(`${end}T00:00:00Z`);
  for (let date = new Date(`${start}T00:00:00Z`); date <= last; date.setUTCDate(date.getUTCDate() + 1)) {
    const key = date.toISOString().slice(0, 10);
    const decision = calendar ? calendarDecision(calendar, key) : null;
    const weeklyScheduleAllows = !allowed || allowed.has(date.getUTCDay());
    if (!decision ? weeklyScheduleAllows : decision.working && (decision.source === 'override' || weeklyScheduleAllows)) count++;
  }
  return count;
}

function buildWeeklyTargets(values) {
  return {
    applications: values.dailyApplications * values.jobDays,
    attendance: values.weeklyAttendance,
    interviews: values.weeklyInterviews,
    outreach: values.dailyOutreach * values.outreachDays,
    communicationPractices: values.weeklyCommunication,
    workshops: values.weeklyWorkshops,
    dailyApplications: values.dailyApplications,
    dailyOutreach: values.dailyOutreach,
    jobDays: values.jobDays,
    outreachDays: values.outreachDays,
  };
}

async function getWeeklyTargets(cohort, range) {
  const [
    dailyApplications,
    dailyOutreach,
    weeklyAttendance,
    weeklyInterviews,
    weeklyCommunication,
    weeklyWorkshops,
    jobSchedule,
    outreachSchedule,
    calendar,
  ] = await Promise.all([
    getNumber(cohort, 'jobstarget'),
    getNumber(cohort, 'outreachdaily'),
    getNumber(cohort, 'weeklyattendance'),
    getNumber(cohort, 'weeklyinterviews'),
    getNumber(cohort, 'weeklycommunication'),
    getNumber(cohort, 'weeklyworkshops'),
    getSetting(cohort, 'sched_jobs'),
    getSetting(cohort, 'sched_outreach'),
    loadWorkCalendar(cohort),
  ]);
  return buildWeeklyTargets({
    dailyApplications,
    dailyOutreach,
    weeklyAttendance,
    weeklyInterviews,
    weeklyCommunication,
    weeklyWorkshops,
    jobDays: scheduledDayCount(range.start, range.end, jobSchedule, calendar),
    outreachDays: scheduledDayCount(range.start, range.end, outreachSchedule, calendar),
  });
}

function progress(value, target) {
  const actual = Number(value) || 0;
  return Number(target) > 0 ? `${actual}/${target}` : String(actual);
}

function targetSummaryLine(targets) {
  return `Applications ${targets.applications} (${targets.dailyApplications}/scheduled day) | Attendance ${targets.attendance} | Interviews ${targets.interviews} | Outreach ${targets.outreach} (${targets.dailyOutreach}/scheduled day) | Communication ${targets.communicationPractices} | Workshops ${targets.workshops}`;
}

module.exports = {
  buildWeeklyTargets,
  getWeeklyTargets,
  parseSchedule,
  progress,
  scheduledDayCount,
  targetSummaryLine,
};
