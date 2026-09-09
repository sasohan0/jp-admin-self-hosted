const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'Code-v19-FINAL.gs'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} helper missing`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name} helper`);
}

const EXPECTED_ACTIONS = [
  'absences', 'activateStudent', 'addQuestions', 'addStudent', 'arrangeSheetTabs', 'attendance', 'attendanceaudit', 'backfillInterviews', 'backfillOutreach', 'backfillOutreachDaily', 'cleanBank',
  'closeform', 'createForms', 'fillLocations', 'formstatus', 'getstate',
  'getstates', 'health', 'jobaudit', 'jobsheets', 'listforms', 'logInterview', 'logInterviews', 'performance',
  'logOutreach', 'logScore', 'logWorkshop', 'markHired', 'matchMissing',
  'missingprofiles', 'nextquestion', 'nextresource', 'openform', 'outreachstatus', 'pipelineaudit', 'roster',
  'rosterreview', 'rtbr', 'saveIds', 'saveJobCounts', 'saveJobSheet', 'saveJobSheets',
  'saveJobSnapshots', 'saveDawnAttendance', 'saveDawnMembershipEvent', 'repairDawnAttendance', 'syncDawnMembers', 'syncDiscordRoster',
  'saveProject', 'saveResources', 'saveResume', 'scores', 'setactiveform',
  'setState', 'setupCohortWorkbook', 'setupTrackingSheets', 'studentinfo',
  'submitStudentProfile', 'submitIntakeApplication', 'updateIntakeApplicationStatus',
  'getIntakeRoleProfiles',
  'recordProfileSurveyDeliveries', 'repairAttendanceRoster',
  'repairActivityPipelines', 'repairInterviewDuplicates',
  'renderUptimeSchedule', 'setRenderUptimeSchedule',
  'leaverequests', 'leavecalendar', 'dawnabsences',
  'submitLeaveRequest', 'decideLeaveRequest',
  'appeals', 'submitAppeal', 'decideAppeal',
  'mailerstatus', 'sendCohortEmailBatch',
];

test('Apps Script v59 source parses and exposes every bot API action', () => {
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /const VERSION = 'v59'/);
  assert.match(source, /body\.action === 'saveDawnAttendance'/);
  assert.match(source, /body\.action === 'saveDawnMembershipEvent'/);
  assert.match(source, /body\.action === 'repairDawnAttendance'/);
  assert.match(source, /body\.action === 'syncDawnMembers'/);
  assert.match(source, /const rowDate = submittedDate;/);
  for (const action of EXPECTED_ACTIONS) {
    assert.match(source, new RegExp(`action === '${action}'`), `missing action ${action}`);
  }
});

test('backend creates editable template field types and persists semantic schemas', () => {
  assert.match(source, /form\.addCheckboxItem\(\)/);
  assert.match(source, /form\.addTimeItem\(\)/);
  assert.match(source, /requireTextIsEmail\(\)/);
  assert.match(source, /item\.showOtherOption\(true\)/);
  assert.match(source, /function formDefinition\(/);
  assert.match(source, /function saveFormSchema\(/);
  assert.match(source, /JP_ENROLLMENT_FORM_SCHEMA/);
  assert.match(source, /JP_ATTENDANCE_FORM_SCHEMA/);
  assert.match(source, /fieldCandidates\('attendance', 'studentEmail'/);
});

test('backend preserves job tracker gid and idempotent score inputs', () => {
  assert.match(source, /saveJobSheet\(email, sheetId, gid\)/);
  assert.match(source, /'GID'/);
  assert.match(source, /gid: data\[i\]/);
  assert.match(source, /function saveJobCounts\(/);
  assert.match(source, /function saveJobSnapshots\(/);
  assert.match(source, /JOB_SNAPSHOT_PREFIX/);
  assert.match(source, /Math\.max\(0, rowCount - baseRowCount\)/);
  assert.match(source, /function saveWorkshopAttendance\(/);
  assert.match(source, /function logScore\(body\)[\s\S]{0,1800}updated: true, duplicate: true/);
  assert.match(source, /function saveProject\(/);
  assert.match(source, /function saveResources\(/);
  assert.match(source, /'Source Message ID'/);
});

test('backend preserves daily jobs while adding weekly metrics and serialized interviews', () => {
  assert.match(source, /function ensureJobsDailySchema\(/);
  assert.match(source, /\['Date','Email','Count','Name'\]/);
  assert.match(source, /function ensureInterviewLogSchema\(/);
  assert.match(source, /'Serial','Interview Date','Role','Details','Discord Message','Logged At'/);
  assert.match(source, /'Discord Message ID','Event Index'/);
  assert.match(source, /function logInterviews\(/);
  assert.match(source, /function backfillInterviews\(/);
  assert.match(source, /email \+ '\|' \+ messageId \+ '\|' \+ eventIndex/);
  assert.match(source, /messagePreviouslySeen/);
  assert.match(source, /function repairInterviewDuplicates\(/);
  assert.match(source, /function getPerformanceReport\(/);
  assert.match(source, /communicationPractices/);
  assert.match(source, /communicationDays/);
  assert.match(source, /workshopDays/);
  assert.match(source, /interviewHistory/);
  assert.match(source, /function computeRtbr\(days, jobTarget\)/);
  assert.match(source, /e\.parameter\.jobTarget/);
  assert.match(source, /const key = normalizeSheetDate\(value\)/);
  assert.match(source, /e\.jobDays\[key\] = c/);
  assert.match(source, /function getJobAuditBundle\(/);
  assert.match(source, /excludedIds: excludedDiscordIds\(guildId\)/);
  assert.match(source, /function getActivityPipelineAudit\(/);
  assert.match(source, /function repairActivityPipelines\(/);
});

test('intake restoration maps normalized stored keys back to canonical role fields', () => {
  const helper = extractFunction('getIntakeRoleProfiles');
  assert.match(helper, /jobfocus: 'jobFocus'/);
  assert.match(helper, /englishcommunication: 'englishCommunication'/);
  assert.match(helper, /genderpreference: 'genderPreference'/);
  assert.match(helper, /studystage: 'studyStage'/);
});

test('RTBR counts native Sheet Date cells and exposes raw activity beside points', () => {
  const compute = new Function(
    'CONFIG', 'Utilities', 'todayStr', 'normalizeSheetDate', 'normalizeStudentEmail',
    'getSpreadsheet', 'readBotMap',
    `${extractFunction('computeRtbr')}; return computeRtbr;`,
  )(
    {
      TZ: 'Asia/Dhaka',
      SHEETS: {
        scores: 'Scores', interviewLog: 'Interview_Log', jobsDaily: 'Jobs_Daily',
        workshopAtt: 'Workshop_Attendance',
      },
    },
    { formatDate: date => new Date(date).toISOString().slice(0, 10) },
    () => '2026-08-20',
    value => value instanceof Date
      ? value.toISOString().slice(0, 10)
      : String(value || '').slice(0, 10),
    value => String(value || '').trim().toLowerCase(),
    () => ({
      getSheetByName(name) {
        const rows = {
          Scores: [['Date', 'Email', 'Name', '', '', 'Score'], [new Date('2026-08-19T00:00:00Z'), 'student@example.com', 'Student', '', '', 4]],
          Interview_Log: [['Date', 'Email', 'Name'], [new Date('2026-08-19T00:00:00Z'), 'student@example.com', 'Student']],
          Jobs_Daily: [['Date', 'Email', 'Count'], [new Date('2026-08-19T00:00:00Z'), 'student@example.com', 10]],
          Workshop_Attendance: [['Date', '', 'Email', 'Name'], [new Date('2026-08-19T00:00:00Z'), '', 'student@example.com', 'Student']],
        }[name];
        return rows ? { getDataRange: () => ({ getValues: () => rows }) } : null;
      },
    }),
    () => [{ email: 'student@example.com', name: 'Student', discordId: '1', active: true, status: '' }],
  );
  const result = compute(7, 10).students[0];
  assert.equal(result.interviewCount, 1);
  assert.equal(result.jobApplications, 10);
  assert.equal(result.workshopCount, 1);
  assert.equal(result.total, 36);
});

test('backend builds rebuildable tracking matrices and keeps future writes synchronized', () => {
  assert.match(source, /jobsMatrix: 'Jobs Applied'/);
  assert.match(source, /outreachMatrix: 'Outreach Update'/);
  assert.match(source, /interviewMatrix: 'Interview Updates'/);
  assert.match(source, /function setupTrackingSheets\(/);
  assert.match(source, /function rebuildTrackingMatrix\(/);
  assert.match(source, /function syncTrackingMatrixCounts\(/);
  assert.match(source, /function syncInterviewMatrixDate\(/);
  assert.match(source, /CONFIG\.SHEETS\.interviewMatrix, dateKey, counts, true, guildId, false/);
  assert.match(source, /function incrementOutreachMatrix\(/);
  assert.match(source, /rawLogsPreserved: true/);
  assert.match(source, /setFrozenColumns\(3\)/);
  assert.match(source, /function refreshTrackingMatrixAlerts\(/);
  assert.match(source, /TRACKING_ALERT_DAYS = 3/);
  assert.match(source, /TRACKING_ALERT_MIN_TOTAL = 10/);
  assert.match(source, /TRACKING_ALERT_COLOR = '#f4cccc'/);
  assert.match(source, /trackingAlertExcludedIds\(guildId\)/);
  assert.match(source, /body\.guildId \|\| ''/);
});

test('attendance remarks and inactive row styling are durable across repairs', () => {
  assert.match(source, /remarksCol: 7/);
  assert.match(source, /firstDateCol: 8/);
  assert.match(source, /function ensureAttendanceSheet\(/);
  assert.match(source, /insertColumnBefore\(CONFIG\.MATRIX\.remarksCol\)/);
  assert.match(source, /Manual mentor remarks\. Bot attendance checks and roster repairs preserve this column\./);
  assert.match(source, /const TRACKING_INACTIVE_COLOR = '#e06666'/);
  assert.match(source, /function refreshAttendanceInactiveRows\(/);
  assert.match(source, /function refreshStudentStatusStyles\(/);
  assert.match(source, /refreshStudentStatusStyles\(guildId\)/);
  assert.match(source, /attendance\.getRange\(row, 1, 1, attendance\.getLastColumn\(\)\)\.setBackground\('#ffffff'\)/);
});

test('backend arranges known tabs without deleting or hiding custom tabs', () => {
  assert.match(source, /function arrangeSheetTabs\(/);
  assert.match(source, /function renameResponseSheetTabs\(/);
  assert.match(source, /target: 'Enrollment Responses'/);
  assert.match(source, /target: 'Attendance Responses'/);
  assert.match(source, /label: 'Manual review'/);
  assert.match(source, /label: 'Forms and reference'/);
  assert.match(source, /label: 'Bot-maintained data'/);
  assert.match(source, /moveActiveSheet\(position\+\+\)/);
  assert.match(source, /preservedUnknown/);
  assert.doesNotMatch(source, /arrangeSheetTabs[\s\S]{0,2200}\.hideSheet\(/);
  assert.doesNotMatch(source, /arrangeSheetTabs[\s\S]{0,2200}\.deleteSheet\(/);
});

test('Discord is the active roster source and Form rows only enrich identity data', () => {
  const ensureStart = source.indexOf('function ensureBotMap()');
  const ensureEnd = source.indexOf('function readBotMap()', ensureStart);
  const ensureBlock = source.slice(ensureStart, ensureEnd);
  assert.ok(ensureStart >= 0 && ensureEnd > ensureStart);
  assert.doesNotMatch(ensureBlock, /responseSheetName|enrollment/i);
  assert.match(source, /function syncDiscordRoster\(/);
  assert.match(source, /function enrollmentIdentityRecords\(/);
  assert.match(source, /function readBotMapArchiveEntries\(/);
  assert.match(source, /function writeRosterReview\(/);
  assert.match(source, /function getRosterReviewStatus\(/);
  assert.match(source, /archiveIdIndex/);
  assert.match(source, /existingByEmail\[email\][\s\S]{0,100}archiveByEmail\[email\]/);
  assert.match(source, /all\.region \|\| form\.region \|\| merged\.values\[5\]/);
  assert.match(source, /reserved\[sheet\.getName\(\)\]/);
  assert.match(source, /Username \+ matching student name/);
  assert.match(source, /username matched, but student name did not/);
  assert.match(source, /CONFIG\.SHEETS\.botMapArchive/);
  assert.match(source, /CONFIG\.SHEETS\.botMapArchive \|\| 'Bot_Map Archive'/);
  assert.match(source, /function configuredSheetMap\(/);
  assert.match(source, /Enrollment saved to All Data; awaiting Discord roster link/);
  assert.match(source, /BOT_MAP_HEADERS[\s\S]*'Phone', 'Match Source', 'Review Note'/);
});

test('setup initializes every operational tab and defines its enrollment-tab diagnostic', () => {
  const setupStart = source.indexOf('function setup()');
  const setupEnd = source.indexOf('function inspectCohortCopy()', setupStart);
  const setupBlock = source.slice(setupStart, setupEnd);
  assert.match(setupBlock, /ensureOperationalTabs\(\)/);
  assert.match(setupBlock, /const rosterSheet =/);
  assert.doesNotMatch(setupBlock, /deleteAllProperties/);
});

test('student email normalization removes invisible and embedded whitespace', () => {
  const helper = source.match(/function normalizeStudentEmail\([^)]*\) \{[\s\S]*?\n\}/);
  assert.ok(helper, 'normalizeStudentEmail helper missing');
  const normalize = new Function(`${helper[0]}; return normalizeStudentEmail;`)();
  assert.equal(normalize(' MAILTO: Student\u200B @Example.COM '), 'student@example.com');
});

test('backend activation and leave workflow are verified and idempotent', () => {
  const activation = extractFunction('activateTrackedStudents');
  assert.match(activation, /Bot_Map; run Discord roster sync first/);
  assert.match(activation, /setBackground\('#ffffff'\)/);
  assert.match(activation, /ST_excl_/);
  assert.match(activation, /ST_attendance_warning_state_v1_/);
  assert.match(activation, /ST_inactive_student_meta_v1_/);
  assert.match(extractFunction('deactivateTrackedStudents'), /ST_inactive_student_meta_v1_/);
  assert.match(extractFunction('deactivateTrackedStudents'), /request\.warningState/);
  assert.match(source, /body\.action === 'activateStudents'/);
  assert.match(source, /body\.action === 'deactivateStudents'/);
  assert.match(extractFunction('submitLeaveRequest'), /created = false/);
  assert.match(extractFunction('submitLeaveRequest'), /duplicateReason/);
  assert.match(extractFunction('decideLeaveRequest'), /decisionChanged = false/);
  assert.match(extractFunction('decideLeaveRequest'), /decisionChanged = true/);
});

test('approved leave is durable and P/L are both excused attendance states', () => {
  assert.match(source, /leaveRequests: 'Leave_Requests'/);
  assert.match(source, /function submitLeaveRequest\(/);
  assert.match(source, /function decideLeaveRequest\(/);
  assert.match(source, /function markApprovedLeave\(/);
  assert.match(source, /setValue\('L'\)/);
  assert.match(source, /status === 'P' \|\| status === 'L'/);
  assert.match(source, /function getLeaveCalendar\(/);
  assert.match(source, /function getDawnAbsenceReport\(/);
});

test('cohort mailer uses BCC, quota checks, and an idempotent private ledger', () => {
  assert.match(source, /mailerLog: 'Mailer_Log'/);
  assert.match(source, /function ensureMailerLog\(/);
  assert.match(source, /function sendCohortEmailBatch\(/);
  assert.match(source, /function reserveMailerBatch\(/);
  assert.match(source, /MailApp\.getRemainingDailyQuota\(\)/);
  assert.match(source, /GmailApp\.createDraft\([\s\S]*?\)\.send\(\)/);
  assert.match(source, /gmailMessageId: gmailMessageId/);
  assert.match(source, /function authorizeGmailMailer\(/);
  assert.match(source, /bcc: mail\.bcc\.join\(','\)/);
  assert.match(source, /MAIL_RECIPIENTS_PER_MESSAGE_LIMIT = 50/);
  assert.match(source, /totalRecipients\.length > MAIL_RECIPIENTS_PER_MESSAGE_LIMIT/);
  assert.match(source, /\['sent', 'pending'\]/);
  assert.doesNotMatch(extractFunction('sendCohortEmailBatch'), /studentBcc\.join\([^)]*\).*\bto\b/);
});

test('bootcamp and Dawn appeals use one private durable decision ledger', () => {
  assert.match(source, /appealLogs: 'Appeal_Logs'/);
  assert.match(source, /function ensureAppealLogs\(/);
  assert.match(source, /function submitAppeal\(/);
  assert.match(source, /function decideAppeal\(/);
  assert.match(source, /function getAppeals\(/);
  assert.match(source, /'bootcamp'.*'dawn'/s);
  assert.match(source, /'medical'.*'exam'.*'bereavement'.*'other'/s);
  assert.match(source, /CONFIG\.SHEETS\.appealLogs \|\| 'Appeal_Logs'/);
});

test('Dawn attendance uses one canonical fallback tab and can migrate generic orphan tabs', () => {
  assert.match(source, /function dawnAttendanceName\(/);
  assert.match(source, /CONFIG\.SHEETS\.dawnAttendance \|\| 'Dawn_Attendance'/);
  assert.match(source, /function repairDawnAttendance\(/);
  assert.match(source, /function syncDawnMembers\(/);
  assert.match(source, /mergeDuplicateDawnAttendanceRows\(newEmail\)/);
  assert.match(source, /function isGenericDawnAttendanceTab\(/);
  assert.match(source, /source\.hideSheet\(\)/);
  assert.match(source, /function mergeDawnAttendanceCell\(/);
});

test('backend uptime schedule is authenticated, durable, and trigger-safe', () => {
  const getHandler = extractFunction('doGetInner');
  const postHandler = extractFunction('doPostInner');
  assert.match(source, /JP_RENDER_UPTIME_SCHEDULE_V1/);
  assert.match(source, /function normalizeRenderUptimeSchedule_\(/);
  assert.match(getHandler, /e\.parameter\.action === 'renderUptimeSchedule'/);
  assert.doesNotMatch(postHandler, /e\.parameter\.action === 'renderUptimeSchedule'/);
  assert.match(postHandler, /body\.action === 'setRenderUptimeSchedule'/);
  assert.match(source, /getHandlerFunction\(\) === 'pingRenderServicesOnSchedule_'/);
  assert.match(source, /for \(let i = 1; i < triggers\.length; i\+\+\) ScriptApp\.deleteTrigger/);
});

test('attendance trusts Form Timestamp and fails closed before matrix writes', () => {
  const analyze = extractFunction('analyzeAttendanceResponses');
  const report = extractFunction('getTodayAttendance');
  assert.match(analyze, /const rowDate = submittedDate/);
  assert.doesNotMatch(analyze, /const rowDate = .*claimedDate/);
  assert.ok(report.indexOf('analysis.identityIssues.length') < report.indexOf('syncAttendanceMatrix'));
  assert.match(report, /blocked: true/);
  assert.match(report, /activeAttendanceRoster\(fullRoster, guildId\)/);
  const activeRoster = extractFunction('activeAttendanceRoster');
  assert.match(activeRoster, /excludedDiscordIds\(guildId\)/);
  assert.match(activeRoster, /excluded\[String\(student\.discordId\)\]/);
  const getHandler = extractFunction('doGetInner');
  assert.match(getHandler, /getTodayAttendance\(e\.parameter\.guildId \|\| ''\)/);
});

test('attendance history ignores future/blank template dates and merges duplicate rows', () => {
  const helpers = [
    extractFunction('matrixHeaderDateKey'),
    extractFunction('attendanceStatusKind'),
    extractFunction('mergeAttendanceStatus'),
    extractFunction('isAttendanceExcused'),
    extractFunction('attendanceStatusForRows'),
    extractFunction('recentAttendanceHistoryFromData'),
  ].join('\n');
  const api = new Function(`${helpers}; return { attendanceStatusForRows, recentAttendanceHistoryFromData };`)();
  const result = api.recentAttendanceHistoryFromData([
    ['Name', 'Email', 'Phone', 'Experience', 'Job Holder', 'Job Focus', '12/8/26', '13/8/26', '16/8/26', '17/8/26', '24/8/26'],
    ['Student', 'student@example.com', '', '', '', '', '', 'P', '', '', ''],
    ['Duplicate', 'student@example.com', '', '', '', '', 'P', '', '', '', ''],
    ['Other', 'other@example.com', '', '', '', '', 'P', 'P', 'A', '', ''],
  ], '2026-08-16', 1, 6, 7);
  assert.deepEqual(result['student@example.com'], { missed: 1, total: 3, streak: 1 });
  assert.equal(api.attendanceStatusForRows([
    ['', '', '', '', '', '', ''],
    ['', '', '', '', '', '', 'P'],
  ], { indexes: [6], key: '2026-08-12' }), 'P');
});

test('attendance interview summary respects an explicit no-interview answer', () => {
  const helpers = [
    extractFunction('attendanceInterviewAnswerIsContradictory'),
    extractFunction('attendanceInterviewAnswerIsPositive'),
  ].join('\n');
  const fn = new Function(`${helpers}; return attendanceInterviewAnswerIsPositive;`)();
  assert.equal(fn('Yes', 'No interview faced today'), false);
  assert.equal(fn('Yes', 'I will share right now'), true);
  assert.equal(fn('No', 'Yes'), false);
});

test('form creation can build attendance only for portal-based enrollment cohorts', () => {
  assert.match(source, /function createCohortForms\(cohortName, spec, requestedKinds\)/);
  assert.match(source, /const createEnrollment = kinds\.indexOf\('enrollment'\) !== -1/);
  assert.match(source, /const createAttendance = kinds\.indexOf\('attendance'\) !== -1/);
  assert.match(source, /createCohortForms\(body\.cohort \|\| 'Cohort', body\.spec \|\| null, body\.kinds \|\| null\)/);
});

test('OAuth intake is append-structured, idempotent, and activates only through the profile pipeline', () => {
  assert.match(source, /intakeResponses: 'Intake Responses'/);
  assert.match(source, /function ensureIntakeResponseSchema\(/);
  assert.match(source, /headers\.findIndex[\s\S]*endsWith\('\s\[' \+ key \+ '\]'\)/);
  assert.match(source, /function submitIntakeApplication\(/);
  assert.match(source, /function updateIntakeApplicationStatus\(/);
  assert.match(source, /Submission ID.*Submitted At.*Admission Status/s);
  assert.match(source, /String\(data\[i\]\[idColumn\].*=== submissionId/s);
  assert.match(source, /upsertAllDataFromIntake\(profile\)/);
  assert.match(source, /function saveOnboardingFromIntake\(/);
  assert.match(source, /saveOnboardingFromIntake\(body\.guildId, discordId, body\.onboarding \|\| \{\}\)/);
  const intake = extractFunction('submitIntakeApplication');
  assert.doesNotMatch(intake, /appendToBotMap|upsertActiveIdentityRows|upsertJobSheetRosterRows/);
});

test('Discord-only students receive stable provisional identities without appearing profile-complete', () => {
  const helpers = [
    extractFunction('normalizeStudentEmail'),
    extractFunction('normalizeDiscordId'),
    extractFunction('provisionalStudentEmail'),
    extractFunction('isProvisionalStudentEmail'),
    extractFunction('validStudentProfileEmail'),
  ].join('\n');
  const api = new Function(`${helpers}; return { provisionalStudentEmail, isProvisionalStudentEmail, validStudentProfileEmail };`)();
  const email = api.provisionalStudentEmail('123456789012345678');
  assert.equal(email, 'discord.123456789012345678@pending.jp-admin.invalid');
  assert.equal(api.isProvisionalStudentEmail(email), true);
  assert.equal(api.validStudentProfileEmail(email), '');
  assert.equal(api.validStudentProfileEmail('student@example.com'), 'student@example.com');
});

test('roster sync preserves supervisor review fields and provisions every Discord student', () => {
  assert.match(source, /previous\[4\] \|\| values\[0\]/);
  assert.match(source, /previous\[5\] \|\| values\[1\]/);
  assert.match(source, /previous\[6\] \|\| values\[7\]/);
  assert.match(source, /previous\[7\] \|\| values\[5\]/);
  assert.match(source, /previous\[8\] \|\| values\[6\]/);
  assert.match(source, /Discord provisional profile/);
  assert.match(source, /function syncAllDataRosterEntries\(/);
  assert.match(source, /function upsertJobSheetRosterRows\(/);
  assert.match(source, /function migrateStudentEmail\(/);
  assert.match(source, /linkedEmail \|\| \(linkedById && suppliedEmail\) \|\| reviewEmail/);
  assert.match(source, /PROFILE INCOMPLETE/);
});

test('roster candidate selection never trusts a submitted username without name corroboration', () => {
  const helper = source.match(/function chooseRosterCandidate\([^)]*\) \{[\s\S]*?\n\}/);
  assert.ok(helper, 'chooseRosterCandidate helper missing');
  const choose = new Function(`${helper[0]}; return chooseRosterCandidate;`)();
  assert.deepEqual(choose(['id@example.com'], [], [], []), {
    email: 'id@example.com',
    source: 'Existing or archived Discord ID',
  });
  assert.deepEqual(choose([], ['form@example.com'], [], []), {
    email: 'form@example.com',
    source: 'Username + matching student name',
  });
  assert.match(choose([], [], [], ['wrong@example.com']).error, /private data survey/);
  assert.match(choose([], [], ['one@example.com', 'two@example.com'], []).error, /multiple/);
});

test('name identity keys handle common Bangladesh name prefixes and Discord decoration', () => {
  const norm = source.match(/function normName\([^)]*\) \{[\s\S]*?\n\}/);
  const helper = source.match(/function identityNameKeys\([^)]*\) \{[\s\S]*?\n\}/);
  assert.ok(norm && helper, 'identity name helpers missing');
  const keys = new Function(`${norm[0]}; ${helper[0]}; return identityNameKeys;`)();
  assert.ok(keys('Md. Sajeda Begum [Web]').includes('core:sajeda begum'));
  assert.ok(keys('sajeda.begum').includes('compact:sajedabegum'));
});

test('cohort workbook setup is backup-first and fresh mode clears formatting only when history is empty', () => {
  assert.match(source, /function setupCohortWorkbook\(/);
  assert.match(source, /function createWorkbookBackup\(/);
  assert.match(source, /SpreadsheetApp\.create\(backupName\)/);
  assert.match(source, /sourceSheet\.copyTo\(backup\)/);
  assert.doesNotMatch(source, /DriveApp\./);
  assert.match(source, /Fresh setup refused because operational history exists/);
  assert.match(source, /function cleanResetTab\(/);
  assert.match(source, /clearConditionalFormatRules\(\)/);
  assert.match(source, /function obsoleteResponseTabNames\(/);
  assert.match(source, /if \(sheet\.getFormUrl\(\)\) return false/);
});

test('private student data survey fills missing fields without publishing private values', () => {
  assert.match(source, /function getMissingStudentProfiles\(/);
  assert.match(source, /function submitStudentProfile\(/);
  assert.match(source, /function upsertAllDataFromStudentProfile\(/);
  assert.match(source, /function checkProfileSubmissionAttemptLimit\(/);
  assert.match(source, /Private student data survey/);
  assert.match(source, /never silently overwritten/);
  assert.match(source, /function onboardingProfileDefaults\(/);
  assert.match(source, /Created from Discord-bound private profile survey/);
  assert.match(source, /existing value retained/);
  assert.doesNotMatch(source, /submitted phone does not match/);
  assert.doesNotMatch(source, /Run !syncmembers first; this Discord member is not in Roster Review/);
  assert.doesNotMatch(source, /This student record is marked .*supervisor must review/);
  assert.match(source, /updateRosterReviewVerification/);
  assert.match(source, /function recordProfileSurveyDeliveries\(/);
  assert.match(source, /'Survey Delivery', 'Survey Sent At'/);
  assert.match(source, /'COMPLETED'/);
  assert.match(source, /adminOverride === true/);
  assert.match(source, /Supervisor private profile correction/);
  assert.match(source, /Discord join private profile intake/);
  assert.match(source, /upsertJobSheetRosterRows\(activeEntry\)/);
});

test('tracking matrix alert evaluates the actual Apps Script helper', () => {
  const helper = source.match(/function trackingAlertShouldFlag\([^)]*\) \{[\s\S]*?\n\}/);
  assert.ok(helper, 'trackingAlertShouldFlag helper missing');
  const shouldFlag = new Function(`${helper[0]}; return trackingAlertShouldFlag;`)();
  assert.equal(shouldFlag([3, 3], 10, 3), false, 'requires three recorded dates');
  assert.equal(shouldFlag([3, 3, 3], 10, 3), true);
  assert.equal(shouldFlag([4, 3, 3], 10, 3), false);
  assert.equal(shouldFlag(['', 2, 1], 10, 3), true);
});

test('job sheet GID cells explain and preserve default-tab behavior', () => {
  assert.match(source, /gidDisplay = gid \|\| 'DEFAULT'/);
  assert.match(source, /getRangeList\(blankGidCells\)\.setValue\('DEFAULT'\)/);
  assert.match(source, /DEFAULT means the posted link had no gid/);
});

test('attendance resolves roster identity aliases and excludes colored rows from active reports', () => {
  assert.match(source, /function resolveRosterIdentity\(/);
  assert.match(source, /function attendanceIdentityValues\(/);
  assert.match(source, /function matrixInactiveEmails\(/);
  assert.match(source, /function isNeutralIdentityColor\(/);
  assert.match(source, /function syncAttendanceMatrix\(/);
  assert.match(extractFunction('syncAttendanceMatrix'), /const matrixHeader = matrixDateHeader\(dateKey\)/);
  assert.match(source, /getRangeList\(ranges\)\.setValue\('P'\)/);
  assert.match(source, /identityIssues: identityIssues/);
  assert.match(source, /function getAttendanceAudit\(/);
  assert.match(source, /function repairAttendanceRoster\(/);
  assert.match(source, /function ensureAttendanceRosterRows\(/);
  assert.match(source, /function matrixPresentOnDate\(/);
  assert.match(source, /notPresentStudents: notPresentStudents/);
  assert.match(source, /unique name alias/);
  const todayAttendance = extractFunction('getTodayAttendance');
  assert.match(todayAttendance, /blockReason:\s*'invalid-timestamps'/);
  assert.doesNotMatch(todayAttendance, /if \(analysis\.identityIssues\.length \|\|/);
  assert.match(todayAttendance, /syncAttendanceMatrix\(today, presentSet, roster\)/);
  assert.match(todayAttendance, /identityIssues:\s*analysis\.identityIssues/);
  assert.match(source, /s\.active === false/);
  assert.doesNotMatch(source, /function onFormSubmit\(e\) \{\s*Utilities\.sleep/);
  const submitFunction = source.match(/function onFormSubmit\(e\) \{[\s\S]*?\n\}/);
  assert.ok(submitFunction);
  assert.doesNotMatch(submitFunction[0], /processAttendanceRow/);
});

test('visually white theme fills stay active while colored status rows remain inactive', () => {
  const helpers = [
    extractFunction('normalizeSheetColor'),
    extractFunction('isNeutralIdentityColor'),
  ].join('\n');
  const neutral = new Function(`${helpers}; return isNeutralIdentityColor;`)();
  assert.equal(neutral('#ffffff'), true);
  assert.equal(neutral('#f3f3f3'), true);
  assert.equal(neutral('#f4cccc'), false);
  assert.equal(neutral('#fce5cd'), false);
  assert.equal(neutral('#d9ead3'), false);
});

test('outreach writes are message-idempotent and backfill reconciles daily events', () => {
  assert.match(source, /function ensureOutreachDailySchema\(/);
  assert.match(source, /function reconcileOutreachSummary\(/);
  assert.match(source, /function reconcileAllOutreachSummaries\(/);
  assert.match(source, /function syncOutreachMatrixDate\(/);
  assert.match(source, /function backfillOutreachDaily\(/);
  assert.match(source, /normalizeDiscordId\(dailyData\[i\]\[2\]\) !== messageId/);
  assert.match(source, /duplicate-reconciled/);
  assert.match(source, /Object\.keys\(affectedEmails\)/);
  assert.match(source, /Object\.keys\(affectedDates\)/);
  assert.match(source, /reconciled: Object\.keys\(seenPayload\)\.length/);
  assert.match(source, /outreachSummaries: outreachSummaries/);
  assert.match(source, /attachedToExisting/);
  assert.match(source, /Discord Message ID/);
});

test('attendance identity matching prefers email and accepts one unique name alias', () => {
  const helpers = [
    'normalizeStudentEmail', 'normalizeIdentityToken',
    'resolveRosterIdentity',
  ].map(extractFunction).join('\n');
  const discordIdStub =
    "function normalizeDiscordId(value) { const match = String(value || '').match(/\\d+/); " +
    "return match && match[0].length >= 16 ? match[0] : ''; }";
  const nameKeyStub =
    "function identityNameKeys(value) { const key = String(value || '').toLowerCase()" +
    ".replace(/[^a-z ]/g, ' ').replace(/\\b(md|mst)\\b/g, ' ')" +
    ".replace(/\\s+/g, ' ').trim(); return key ? ['core:' + key] : []; }";
  const resolve = new Function(
    `${discordIdStub}\n${nameKeyStub}\n${helpers}; return resolveRosterIdentity;`,
  )();
  const roster = [
    {
      email: 'sajeda@example.com',
      discordId: '100000000000000001',
      username: 'sajeda.dev',
      name: 'Md. Sajeda Begum',
    },
    {
      email: 'other@example.com',
      discordId: '100000000000000002',
      username: 'other',
      name: 'Another Student',
    },
  ];
  assert.equal(resolve([' Sajeda Begum '], roster).student.email, 'sajeda@example.com');
  assert.equal(
    resolve(['SAJEDA @EXAMPLE.COM', 'Another Student'], roster).student.email,
    'sajeda@example.com',
    'strong email must win over a stale weaker field',
  );
});

test('backend reports week-bounded absences and marks only qualifying blank attendance cells', () => {
  assert.match(source, /function getAbsenceReport\(/);
  assert.match(source, /function refreshAttendanceAbsenceFlags\(/);
  assert.match(source, /function qualifyingAbsenceIndexes\(/);
  assert.match(source, /run\.length >= 3/);
  assert.match(source, /value === '' \|\| value === '❌'/);
  assert.match(source, /recordedSessions:/);
  assert.match(source, /username: student\.username/);
  assert.match(source, /phone: student\.phone/);
});

test('question scores are idempotent per Discord question message', () => {
  assert.match(source, /Discord Question Message ID/);
  assert.match(source, /const messageId = String\(body\.messageId/);
  assert.match(source, /existingMessageId === messageId/);
  assert.match(source, /String\(data\[i\]\[0\].*String\(row\[0\]\)/s);
});

test('backend supports copied-sheet isolation and dynamic form response tabs', () => {
  assert.match(source, /function initializeNewCohortCopy\(/);
  assert.match(source, /function prepareNewBatchReset\(/);
  assert.match(source, /function resetForNewStudentBatch\(/);
  assert.match(source, /approvalValidMinutes: 15/);
  assert.match(source, /Used On markers will reset/);
  assert.match(source, /Posted markers will reset/);
  assert.match(source, /JP_SPREADSHEET_ID/);
  assert.match(source, /JP_ENROLLMENT_RESPONSE_SHEET/);
  assert.match(source, /JP_ATTENDANCE_RESPONSE_SHEET/);
  assert.match(source, /function registerResponseSheets\(/);
  assert.match(source, /function processEnrollmentRow\(/);
  assert.match(source, /function processAttendanceRow\(/);
  assert.match(source, /function formsLinkedToSpreadsheet\(/);
  assert.match(source, /sheet\.getFormUrl\(\)/);
  assert.doesNotMatch(source, /getFormUrls\(/);
});

test('repository copy never contains a deployable Apps Script secret', () => {
  assert.match(source, /SECRET_KEY: 'PASTE_NEW_PRIVATE_SECRET_HERE'/);
  assert.doesNotMatch(source, /SECRET_KEY:\s*'[a-f0-9]{64}'/i);
});

test('manual health check prints a share-safe diagnostic result', () => {
  const healthFunction = source.match(/function healthCheck\(\) \{[\s\S]*?\n\}/);
  assert.ok(healthFunction, 'healthCheck function missing');
  assert.match(healthFunction[0], /console\.log\(JSON\.stringify\(result, null, 2\)\)/);
  assert.match(healthFunction[0], /secretConfigured: secretConfigured\(\)/);
  assert.doesNotMatch(healthFunction[0], /CONFIG\.SECRET_KEY/);
});

test('first-run authorization helper verifies every required Google service without side effects', () => {
  const helper = extractFunction('authorizeAllRequiredServices');
  assert.match(helper, /SpreadsheetApp\.flush\(\)/);
  assert.match(helper, /FormApp\.getActiveForm\(\)/);
  assert.match(helper, /ScriptApp\.getProjectTriggers\(\)/);
  assert.match(helper, /MailApp\.getRemainingDailyQuota\(\)/);
  assert.match(helper, /GmailApp\.getAliases\(\)/);
  assert.match(helper, /UrlFetchApp\.getRequest\(/);
  assert.match(helper, /console\.log\(JSON\.stringify\(result, null, 2\)\)/);
  assert.doesNotMatch(helper, /\.send\(|createDraft\(|FormApp\.create\(|delete[A-Z]?\(/);
});
