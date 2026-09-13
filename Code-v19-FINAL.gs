// ============================================================
//  JP ADMIN SHEET + BOT API (v60 - verified roster identity)
//  Safe for a copied/bound spreadsheet and multiple newly-created
//  Forms. Includes persistent response-tab routing, tracker GIDs,
//  idempotent daily score inputs, and private onboarding state.
// ============================================================

const VERSION = 'v60';
const MAIL_RECIPIENTS_PER_MESSAGE_LIMIT = 50;

const JOB_SNAPSHOT_PREFIX = 'JP_JOBSNAP_';
const PROFILE_SUBMISSION_ATTEMPT_PREFIX = 'JP_PROFILE_SUBMIT_ATTEMPT_';
const RENDER_UPTIME_SCHEDULE_KEY = 'JP_RENDER_UPTIME_SCHEDULE_V1';
const INTAKE_BASE_HEADERS = [
  'Submission ID', 'Submitted At', 'Updated At', 'Admission Status',
  'Admission Detail', 'Cohort', 'Discord ID', 'Discord Username',
  'Discord Display Name',
];

const CONFIG = {
  COHORT: 'STRIDE',
  FORM_ID: '', // leave blank when !createforms will create the attendance form
  SECRET_KEY: 'PASTE_NEW_PRIVATE_SECRET_HERE',
  SPREADSHEET_ID: '', // optional; setup() stores the bound Sheet ID automatically
  TZ: 'Asia/Dhaka',
  SHEETS: {
    roster: 'Form Responses 1',
    daily: 'Form Responses 2',
    matrix: 'Attendance',
    botMap: 'Bot_Map',          // created automatically
    botMapArchive: 'Bot_Map Archive', // stale/duplicate mappings preserved here
    rosterReview: 'Roster Review', // every current eligible Discord member
    outreachLog: 'Outreach_Log', // created automatically
    allData: 'All Data',         // master student database (name/email/phone)
    questionBank: 'Question_Bank', // created automatically
    scores: 'Scores',              // created automatically
    jobSheets: 'Job_Sheets',       // created automatically
    interviewLog: 'Interview_Log', // created automatically
    interviewMatrix: 'Interview Updates', // supervisor-friendly date matrix
    jobsDaily: 'Jobs_Daily',       // created automatically
    jobsMatrix: 'Jobs Applied',    // supervisor-friendly date matrix
    workshopAtt: 'Workshop_Attendance', // created automatically
    resources: 'Resources',        // created automatically
    resumes: 'Resumes',            // created automatically
    projects: 'Projects',          // created automatically
    outreachDaily: 'Outreach_Daily', // created automatically
    dawnAttendance: 'Dawn_Attendance', // created automatically
    outreachMatrix: 'Outreach Update', // supervisor-friendly date matrix
    intakeResponses: 'Intake Responses', // structured OAuth enrollment responses
    leaveRequests: 'Leave_Requests', // student leave requests and supervisor decisions
    appealLogs: 'Appeal_Logs', // bootcamp and Dawn removal appeals
    mailerLog: 'Mailer_Log', // private idempotent attendance/warning email audit
  },
  FORM_OPEN_HOUR: 21,
  FORM_CLOSE_HOUR: 22,
  MATRIX: {
    emailCol: 2, experienceCol: 4, jobHolderCol: 5, jobFocusCol: 6,
    remarksCol: 7,
    firstDateCol: 8, // Remarks is G; date columns start at H
  },
  RECENT_SESSIONS: 7, // how many recent sessions the inactivity report covers
};

const ATTENDANCE_HEADERS = [
  'Name', 'Email', 'Phone', 'Experience', 'Job Holder', 'Job Focus', 'Remarks',
];

const PROPERTY_KEYS = {
  spreadsheetId: 'JP_SPREADSHEET_ID',
  enrollmentSheet: 'JP_ENROLLMENT_RESPONSE_SHEET',
  attendanceSheet: 'JP_ATTENDANCE_RESPONSE_SHEET',
  attendanceFormId: 'CREATED_ATTENDANCE_FORM_ID',
  enrollmentSchema: 'JP_ENROLLMENT_FORM_SCHEMA',
  attendanceSchema: 'JP_ATTENDANCE_FORM_SCHEMA',
  cohort: 'JP_CONFIGURED_COHORT',
  newBatchResetApproval: 'JP_NEW_BATCH_RESET_APPROVAL',
};

function secretConfigured() {
  const secret = String(CONFIG.SECRET_KEY || '').trim();
  return secret.length >= 32 && !/^(change|paste|replace)/i.test(secret);
}

function validateConfig() {
  if (!String(CONFIG.COHORT || '').trim()) throw new Error('CONFIG.COHORT is empty');
  if (!secretConfigured()) throw new Error('CONFIG.SECRET_KEY must be a private random value of at least 32 characters');
}

function botMapArchiveName() {
  return String(CONFIG.SHEETS.botMapArchive || 'Bot_Map Archive');
}

function rosterReviewName() {
  return String(CONFIG.SHEETS.rosterReview || 'Roster Review');
}

function intakeResponsesName() {
  return String(CONFIG.SHEETS.intakeResponses || 'Intake Responses');
}

function dawnAttendanceName() {
  return String(CONFIG.SHEETS.dawnAttendance || 'Dawn_Attendance').trim() || 'Dawn_Attendance';
}

function leaveRequestsName() {
  return String(CONFIG.SHEETS.leaveRequests || 'Leave_Requests').trim() || 'Leave_Requests';
}

function appealLogsName() {
  return String(CONFIG.SHEETS.appealLogs || 'Appeal_Logs').trim() || 'Appeal_Logs';
}

function mailerLogName() {
  return String(CONFIG.SHEETS.mailerLog || 'Mailer_Log').trim() || 'Mailer_Log';
}

function configuredSheetMap() {
  const sheets = {};
  for (const key in CONFIG.SHEETS) sheets[key] = CONFIG.SHEETS[key];
  sheets.botMapArchive = botMapArchiveName();
  sheets.rosterReview = rosterReviewName();
  sheets.intakeResponses = intakeResponsesName();
  sheets.dawnAttendance = dawnAttendanceName();
  sheets.leaveRequests = leaveRequestsName();
  sheets.appealLogs = appealLogsName();
  sheets.mailerLog = mailerLogName();
  return sheets;
}

// Active-spreadsheet helpers are unreliable in Web App executions. setup()
// records the bound container ID; every API call then opens it explicitly.
function getSpreadsheet() {
  const props = PropertiesService.getScriptProperties();
  const id = String(CONFIG.SPREADSHEET_ID || props.getProperty(PROPERTY_KEYS.spreadsheetId) || '').trim();
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active; // manual editor execution before setup()
  throw new Error('Spreadsheet ID is not initialized; run setup() once from the bound Sheet');
}

function responseSheetName(kind) {
  const props = PropertiesService.getScriptProperties();
  if (kind === 'enrollment') {
    return props.getProperty(PROPERTY_KEYS.enrollmentSheet) || CONFIG.SHEETS.roster;
  }
  return props.getProperty(PROPERTY_KEYS.attendanceSheet) || CONFIG.SHEETS.daily;
}

function findHeader(headers, candidates) {
  const normalized = headers.map(function (h) { return String(h || '').trim().toLowerCase(); });
  for (const candidate of candidates) {
    const exact = normalized.indexOf(String(candidate).toLowerCase());
    if (exact !== -1) return exact;
  }
  for (let i = 0; i < normalized.length; i++) {
    if (candidates.some(function (candidate) { return normalized[i].indexOf(String(candidate).toLowerCase()) !== -1; })) return i;
  }
  return -1;
}

function formSchema(kind) {
  const key = kind === 'enrollment' ? PROPERTY_KEYS.enrollmentSchema : PROPERTY_KEYS.attendanceSchema;
  const raw = PropertiesService.getScriptProperties().getProperty(key) || '{}';
  try { return JSON.parse(raw); }
  catch (err) { return {}; }
}

function fieldCandidates(kind, fieldKey, fallbacks) {
  const schema = formSchema(kind);
  const candidates = [];
  if (schema[fieldKey]) candidates.push(schema[fieldKey]);
  return candidates.concat(fallbacks || []);
}

// ============================================================
//  ONE-TIME SETUP - run manually once (and once per new copy)
// ============================================================
// Run this FIRST on a newly copied cohort backend. It clears copied Script
// Properties (old form IDs, automation switches, onboarding answers, forwarder
// route) without deleting any Sheet rows or tabs.
function initializeNewCohortCopy() {
  validateConfig();
  if (/^EJP-?13$/i.test(String(CONFIG.COHORT).trim())) {
    throw new Error('Refusing to initialize a new copy while CONFIG.COHORT is still EJP-13');
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Run this function from the bound copied Sheet');
  const props = PropertiesService.getScriptProperties();
  props.deleteAllProperties();
  props.setProperty(PROPERTY_KEYS.spreadsheetId, ss.getId());
  props.setProperty(PROPERTY_KEYS.cohort, CONFIG.COHORT);
  console.log('✅ Cleared copied runtime bindings for new cohort ' + CONFIG.COHORT + '; Sheet rows were not changed');
  return { cohort: CONFIG.COHORT, spreadsheetIdStored: true, sheetRowsChanged: false };
}

function setup() {
  validateConfig();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Run setup() from Extensions > Apps Script in the bound STRIDE Sheet');
  const props = PropertiesService.getScriptProperties();
  const configuredCohort = props.getProperty(PROPERTY_KEYS.cohort);
  if (configuredCohort && configuredCohort !== CONFIG.COHORT) {
    throw new Error('Copied backend is still bound to ' + configuredCohort + '; run initializeNewCohortCopy() first');
  }
  props.setProperty(PROPERTY_KEYS.spreadsheetId, ss.getId());
  props.setProperty(PROPERTY_KEYS.cohort, CONFIG.COHORT);

  // Replace only this project's attendance trigger. Do not delete unrelated
  // triggers that an operator may have intentionally added.
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'onFormSubmit') ScriptApp.deleteTrigger(trigger);
  });

  // Only ONE trigger: form submissions. Form open/close is fully
  // manual via the bot commands !openform / !closeform.
  ScriptApp.newTrigger('onFormSubmit')
    .forSpreadsheet(ss)
    .onFormSubmit().create();

  ensureOperationalTabs();
  arrangeSheetTabs();
  const rosterSheet = ss.getSheetByName(responseSheetName('enrollment'));
  console.log('✅ Trigger installed + backend initialized for ' + CONFIG.COHORT +
    (rosterSheet ? '' : ' (waiting for enrollment form/response tab)'));
}

// Read-only inspection for a copied Sheet. It reports row counts only and is
// safe to share; use it before deciding which old cohort tabs need archiving.
function inspectCohortCopy() {
  validateConfig();
  const ss = getSpreadsheet();
  const rows = {};
  const configuredSheets = configuredSheetMap();
  for (const key in configuredSheets) {
    const name = configuredSheets[key];
    const sheet = ss.getSheetByName(name);
    rows[name] = sheet ? Math.max(0, sheet.getLastRow() - 1) : null;
  }
  const result = {
    version: VERSION,
    cohort: CONFIG.COHORT,
    spreadsheet: ss.getName(),
    rows: rows,
    configuredResponseSheets: {
      enrollment: responseSheetName('enrollment'),
      attendance: responseSheetName('attendance'),
    },
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

// ============================================================
//  GUARDED NEW-BATCH RESET
//  Run prepareNewBatchReset() first, review its output, then run
//  resetForNewStudentBatch() within 15 minutes. This is editor-only
//  and deliberately is not exposed through doGet/doPost.
// ============================================================
function prepareNewBatchReset() {
  validateConfig();
  if (/^EJP-?13$/i.test(String(CONFIG.COHORT).trim())) {
    throw new Error('Refusing to prepare a new-batch reset while CONFIG.COHORT is still EJP-13');
  }
  const ss = getSpreadsheet();
  const inspection = inspectCohortCopy();
  const approval = {
    cohort: CONFIG.COHORT,
    spreadsheetId: ss.getId(),
    createdAt: Date.now(),
  };
  PropertiesService.getScriptProperties().setProperty(
    PROPERTY_KEYS.newBatchResetApproval, JSON.stringify(approval));
  const result = {
    approvalValidMinutes: 15,
    willClearStudentRows: [
      responseSheetName('enrollment'), responseSheetName('attendance'),
      CONFIG.SHEETS.matrix, CONFIG.SHEETS.botMap, CONFIG.SHEETS.outreachLog,
      rosterReviewName(),
      CONFIG.SHEETS.allData, CONFIG.SHEETS.scores, CONFIG.SHEETS.jobSheets,
      CONFIG.SHEETS.interviewLog, CONFIG.SHEETS.jobsDaily,
      CONFIG.SHEETS.jobsMatrix,
      CONFIG.SHEETS.interviewMatrix,
      CONFIG.SHEETS.workshopAtt, CONFIG.SHEETS.resumes,
      CONFIG.SHEETS.projects, CONFIG.SHEETS.outreachDaily,
      CONFIG.SHEETS.outreachMatrix,
      dawnAttendanceName(),
      leaveRequestsName(),
      appealLogsName(),
      mailerLogName(),
    ],
    willPreserve: [
      CONFIG.SHEETS.questionBank + ' questions (Used On markers will reset)',
      CONFIG.SHEETS.resources + ' content (Posted markers will reset)',
      'tab formatting and header structures',
    ],
    currentRows: inspection.rows,
    next: 'Run resetForNewStudentBatch() within 15 minutes only if this plan is correct.',
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function clearRowsBelowHeader(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const rows = sheet.getLastRow() - 1;
  sheet.getRange(2, 1, rows, Math.max(1, sheet.getLastColumn())).clearContent();
  return rows;
}

function resetTabToHeaders(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  const oldRows = Math.max(0, sheet.getLastRow() - 1);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  return oldRows;
}

function resetForNewStudentBatch() {
  validateConfig();
  const ss = getSpreadsheet();
  const props = PropertiesService.getScriptProperties();
  let approval;
  try { approval = JSON.parse(props.getProperty(PROPERTY_KEYS.newBatchResetApproval) || '{}'); }
  catch (e) { approval = {}; }
  const age = Date.now() - Number(approval.createdAt || 0);
  if (approval.cohort !== CONFIG.COHORT || approval.spreadsheetId !== ss.getId() ||
      age < 0 || age > 15 * 60 * 1000) {
    throw new Error('Reset approval is missing or expired; run prepareNewBatchReset() and review its output first');
  }

  return withScriptLock(function () {
    // Consume approval before mutation so an interrupted reset cannot be
    // repeated accidentally without another explicit preview.
    props.deleteProperty(PROPERTY_KEYS.newBatchResetApproval);
    const cleared = {};

    const enrollment = ss.getSheetByName(responseSheetName('enrollment'));
    const attendance = ss.getSheetByName(responseSheetName('attendance'));
    cleared[responseSheetName('enrollment')] = clearRowsBelowHeader(enrollment);
    cleared[responseSheetName('attendance')] = clearRowsBelowHeader(attendance);

    cleared[CONFIG.SHEETS.matrix] = resetTabToHeaders(
      ss, CONFIG.SHEETS.matrix, ATTENDANCE_HEADERS);
    cleared[CONFIG.SHEETS.botMap] = resetTabToHeaders(
      ss, CONFIG.SHEETS.botMap, BOT_MAP_HEADERS);
    cleared[botMapArchiveName()] = resetTabToHeaders(
      ss, botMapArchiveName(), ['Archived At', 'Reason'].concat(BOT_MAP_HEADERS));
    cleared[rosterReviewName()] = resetTabToHeaders(
      ss, rosterReviewName(), ROSTER_REVIEW_HEADERS);
    cleared[CONFIG.SHEETS.outreachLog] = resetTabToHeaders(ss, CONFIG.SHEETS.outreachLog,
      ['Email', 'Name', 'Discord ID', 'First Post', 'Last Post', 'Total Posts']);

    const allData = ss.getSheetByName(CONFIG.SHEETS.allData);
    cleared[CONFIG.SHEETS.allData] = clearRowsBelowHeader(allData);
    cleared[CONFIG.SHEETS.scores] = resetTabToHeaders(ss, CONFIG.SHEETS.scores,
      ['Date', 'Email', 'Name', 'Category', 'QuestionID', 'Score', 'Cheat']);
    cleared[CONFIG.SHEETS.jobSheets] = resetTabToHeaders(ss, CONFIG.SHEETS.jobSheets,
      ['Email', 'Name', 'Sheet ID', 'Link Updated', 'GID']);
    cleared[CONFIG.SHEETS.interviewLog] = resetTabToHeaders(ss, CONFIG.SHEETS.interviewLog,
      ['Date','Email','Name','Company','Serial','Interview Date','Role','Details','Discord Message','Logged At']);
    cleared[CONFIG.SHEETS.jobsDaily] = resetTabToHeaders(ss, CONFIG.SHEETS.jobsDaily,
      ['Date', 'Email', 'Count', 'Name']);
    cleared[CONFIG.SHEETS.jobsMatrix] = resetTabToHeaders(ss, CONFIG.SHEETS.jobsMatrix,
      ['Name', 'Email', 'Phone']);
    cleared[CONFIG.SHEETS.interviewMatrix] = resetTabToHeaders(
      ss, CONFIG.SHEETS.interviewMatrix, ['Name', 'Email', 'Phone']);
    cleared[CONFIG.SHEETS.workshopAtt] = resetTabToHeaders(ss, CONFIG.SHEETS.workshopAtt,
      ['Date', 'Slot', 'Email', 'Name']);
    cleared[CONFIG.SHEETS.resumes] = resetTabToHeaders(ss, CONFIG.SHEETS.resumes,
      ['Email', 'Name', 'Resume Link', 'File URL', 'Updated']);
    cleared[CONFIG.SHEETS.projects] = resetTabToHeaders(ss, CONFIG.SHEETS.projects,
      ['Email', 'Name', 'Project Link', 'File URL', 'Summary', 'Updated']);
    cleared[CONFIG.SHEETS.outreachDaily] = resetTabToHeaders(ss, CONFIG.SHEETS.outreachDaily,
      ['Date', 'Email', 'Discord Message ID', 'Discord Message', 'Logged At']);
    cleared[CONFIG.SHEETS.outreachMatrix] = resetTabToHeaders(ss, CONFIG.SHEETS.outreachMatrix,
      ['Name', 'Email', 'Phone']);
    cleared[leaveRequestsName()] = resetTabToHeaders(ss, leaveRequestsName(), leaveRequestHeaders());
    cleared[appealLogsName()] = resetTabToHeaders(ss, appealLogsName(), appealLogHeaders());
    cleared[mailerLogName()] = resetTabToHeaders(ss, mailerLogName(), mailerLogHeaders());

    const bank = ensureQuestionBank();
    if (bank.getLastRow() > 1) bank.getRange(2, 6, bank.getLastRow() - 1, 1).clearContent();
    const resources = ensureTab(CONFIG.SHEETS.resources,
      ['Date', 'Content', 'Attachments', 'Posted In New Server']);
    if (resources.getLastRow() > 1) resources.getRange(2, 4, resources.getLastRow() - 1, 1).clearContent();

    // Any copied/previous active attendance Form must not control STRIDE.
    props.deleteProperty(PROPERTY_KEYS.attendanceFormId);
    props.deleteProperty(PROPERTY_KEYS.enrollmentSheet);
    props.deleteProperty(PROPERTY_KEYS.attendanceSheet);
    const oldProperties = props.getProperties();
    for (const propertyName in oldProperties) {
      if (propertyName.indexOf(JOB_SNAPSHOT_PREFIX) === 0) props.deleteProperty(propertyName);
    }
    SpreadsheetApp.flush();

    const result = {
      cohort: CONFIG.COHORT,
      clearedRows: cleared,
      preservedQuestionRows: Math.max(0, bank.getLastRow() - 1),
      preservedResourceRows: Math.max(0, resources.getLastRow() - 1),
      next: 'Run inspectCohortCopy(); if student-data rows are zero, run setup().',
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  });
}

// ============================================================
//  ONE-COMMAND COHORT WORKBOOK SETUP
//  repair  -> create/repair required tabs without clearing data
//  cleanup -> full Drive backup, then remove only obsolete Form-response tabs
//  fresh   -> full Drive backup, require empty operational history, rebuild
//             bot-owned tabs with clean formatting, and remove obsolete Forms
// ============================================================
function spreadsheetIdFromReference(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/) ||
    raw.match(/^([A-Za-z0-9_-]{20,})$/);
  return match ? match[1] : '';
}

function bindSpreadsheetForSetup(reference, mode) {
  const id = spreadsheetIdFromReference(reference);
  const props = PropertiesService.getScriptProperties();
  const current = String(
    CONFIG.SPREADSHEET_ID || props.getProperty(PROPERTY_KEYS.spreadsheetId) || '').trim();
  if (!id) {
    if (!current) {
      throw new Error(
        'Spreadsheet is not bound; include its Google Sheet URL with !setupcohortsheet');
    }
    return { spreadsheet: getSpreadsheet(), id: current, shouldStore: false };
  }
  if (current && current !== id && mode !== 'fresh') {
    throw new Error(
      'This backend is already bound to another Sheet; only fresh confirm may replace that binding');
  }
  const ss = SpreadsheetApp.openById(id);
  return { spreadsheet: ss, id: id, shouldStore: current !== id };
}

function installFormSubmitTrigger(ss) {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'onFormSubmit') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('onFormSubmit').forSpreadsheet(ss).onFormSubmit().create();
  return true;
}

function cleanResetTab(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  sheet.clear();
  sheet.clearConditionalFormatRules();
  ensureSheetSize(sheet, 2, headers.length);
  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setFontWeight('bold')
    .setBackground('#d9eaf7');
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(Math.min(3, headers.length));
  sheet.setTabColor(null);
  return sheet;
}

function operationalRowCounts(ss) {
  const names = [
    CONFIG.SHEETS.botMap, CONFIG.SHEETS.jobsDaily, CONFIG.SHEETS.outreachDaily,
    CONFIG.SHEETS.outreachLog, CONFIG.SHEETS.interviewLog, CONFIG.SHEETS.scores,
    CONFIG.SHEETS.workshopAtt, dawnAttendanceName(),
    CONFIG.SHEETS.jobSheets, intakeResponsesName(), leaveRequestsName(), appealLogsName(),
    mailerLogName(),
  ];
  const rows = {};
  names.forEach(function (name) {
    const sheet = ss.getSheetByName(name);
    rows[name] = sheet ? Math.max(0, sheet.getLastRow() - 1) : 0;
  });
  return rows;
}

function activeResponseTabNamesForCleanup(ss) {
  const props = PropertiesService.getScriptProperties();
  const names = {};
  const enrollment = String(props.getProperty(PROPERTY_KEYS.enrollmentSheet) || '').trim();
  const attendance = String(props.getProperty(PROPERTY_KEYS.attendanceSheet) || '').trim();
  if (enrollment && ss.getSheetByName(enrollment)) names[enrollment] = true;
  if (attendance && ss.getSheetByName(attendance)) names[attendance] = true;
  return names;
}

function obsoleteResponseTabNames(ss) {
  const active = activeResponseTabNamesForCleanup(ss);
  return ss.getSheets().filter(function (sheet) {
    const name = sheet.getName();
    if (active[name]) return false;
    // A response tab can belong to an older but still intentionally linked
    // Form even when it is not the currently selected enrollment/attendance
    // destination. Never classify any Form-linked sheet as obsolete.
    try {
      if (sheet.getFormUrl()) return false;
    } catch (e) {
      // Fail closed when Google cannot determine the form relationship.
      return false;
    }
    return !active[name] &&
      /^(form\s*(responses?|data)|responses?\s*form)/i.test(String(name || '').trim());
  }).map(function (sheet) {
    return sheet.getName();
  });
}

function createWorkbookBackup(ss) {
  const stamp = Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyyMMdd-HHmmss');
  const backupName = ss.getName() + ' - JP ADMIN backup ' + stamp;
  const backup = SpreadsheetApp.create(backupName);
  const placeholder = backup.getSheets()[0];
  placeholder.setName('__JP_ADMIN_BACKUP_PLACEHOLDER_' + stamp + '__');
  ss.getSheets().forEach(function (sourceSheet) {
    const copied = sourceSheet.copyTo(backup);
    copied.setName(sourceSheet.getName());
    if (sourceSheet.isSheetHidden()) copied.hideSheet();
  });
  backup.deleteSheet(placeholder);
  SpreadsheetApp.flush();
  return { name: backup.getName(), id: backup.getId() };
}

function ensureOperationalTabs() {
  ensureBotMap();
  ensureBotMapArchive();
  ensureRosterReview();
  ensureAttendanceSheet();
  ensureTab(CONFIG.SHEETS.jobsMatrix, ['Name', 'Email', 'Phone']);
  ensureTab(CONFIG.SHEETS.outreachMatrix, ['Name', 'Email', 'Phone']);
  ensureTab(CONFIG.SHEETS.interviewMatrix, ['Name', 'Email', 'Phone']);
  ensureJobSheets();
  ensureJobsDailySchema();
  ensureInterviewLogSchema();
  ensureTab(CONFIG.SHEETS.outreachDaily,
    ['Date', 'Email', 'Discord Message ID', 'Discord Message', 'Logged At']);
  ensureOutreachLog();
  ensureTab(CONFIG.SHEETS.workshopAtt, ['Date', 'Slot', 'Email', 'Name']);
  ensureTab(dawnAttendanceName(), ['Name', 'Email', 'Phone']);
  ensureLeaveRequests();
  ensureAppealLogs();
  ensureMailerLog();
  ensureScores();
  ensureQuestionBank();
  ensureTab(CONFIG.SHEETS.resources,
    ['Date', 'Content', 'Attachments', 'Posted In New Server', 'Source Message ID']);
  ensureTab(CONFIG.SHEETS.resumes, ['Email', 'Name', 'Resume Link', 'File URL', 'Updated']);
  ensureTab(CONFIG.SHEETS.projects,
    ['Email', 'Name', 'Project Link', 'File URL', 'Summary', 'Updated']);
  ensureTab(CONFIG.SHEETS.allData, ['fullName', 'email', 'phone']);
  ensureTab(intakeResponsesName(), INTAKE_BASE_HEADERS);
}

function resetFreshOperationalTabs(ss) {
  const schemas = {};
  schemas[CONFIG.SHEETS.matrix] = ATTENDANCE_HEADERS;
  schemas[CONFIG.SHEETS.botMap] = BOT_MAP_HEADERS;
  schemas[botMapArchiveName()] = ['Archived At', 'Reason'].concat(BOT_MAP_HEADERS);
  schemas[rosterReviewName()] = ROSTER_REVIEW_HEADERS;
  schemas[CONFIG.SHEETS.jobsMatrix] = ['Name', 'Email', 'Phone'];
  schemas[CONFIG.SHEETS.outreachMatrix] = ['Name', 'Email', 'Phone'];
  schemas[CONFIG.SHEETS.interviewMatrix] = ['Name', 'Email', 'Phone'];
  schemas[CONFIG.SHEETS.jobSheets] = ['Email', 'Name', 'Sheet ID', 'Link Updated', 'GID'];
  schemas[CONFIG.SHEETS.jobsDaily] = ['Date', 'Email', 'Count', 'Name'];
  schemas[CONFIG.SHEETS.outreachDaily] =
    ['Date', 'Email', 'Discord Message ID', 'Discord Message', 'Logged At'];
  schemas[CONFIG.SHEETS.outreachLog] =
    ['Email', 'Name', 'Discord ID', 'First Post', 'Last Post', 'Total Posts'];
  schemas[CONFIG.SHEETS.interviewLog] =
    ['Date', 'Email', 'Name', 'Company', 'Serial', 'Interview Date', 'Role',
      'Details', 'Discord Message', 'Logged At', 'Discord Message ID', 'Event Index'];
  schemas[CONFIG.SHEETS.workshopAtt] = ['Date', 'Slot', 'Email', 'Name'];
  schemas[dawnAttendanceName()] = ['Name', 'Email', 'Phone'];
  schemas[leaveRequestsName()] = leaveRequestHeaders();
  schemas[appealLogsName()] = appealLogHeaders();
  schemas[mailerLogName()] = mailerLogHeaders();
  schemas[CONFIG.SHEETS.scores] =
    ['Date', 'Email', 'Name', 'Category', 'QuestionID', 'Score', 'Cheat',
      'Discord Question Message ID'];
  schemas[CONFIG.SHEETS.resumes] = ['Email', 'Name', 'Resume Link', 'File URL', 'Updated'];
  schemas[CONFIG.SHEETS.projects] =
    ['Email', 'Name', 'Project Link', 'File URL', 'Summary', 'Updated'];
  schemas[intakeResponsesName()] = INTAKE_BASE_HEADERS;
  Object.keys(schemas).forEach(function (name) {
    cleanResetTab(ss, name, schemas[name]);
  });

  [CONFIG.SHEETS.allData, CONFIG.SHEETS.questionBank, CONFIG.SHEETS.resources]
    .forEach(function (name) {
      const sheet = ss.getSheetByName(name);
      if (!sheet) return;
      sheet.clearConditionalFormatRules();
      if (sheet.getLastRow() && sheet.getLastColumn()) {
        sheet.getDataRange().setBackground('#ffffff');
      }
      sheet.setTabColor(null);
    });
}

function setupCohortWorkbook(mode, spreadsheetReference, guildId) {
  validateConfig();
  mode = String(mode || 'repair').trim().toLowerCase();
  if (['repair', 'cleanup', 'fresh'].indexOf(mode) === -1) {
    throw new Error('Workbook mode must be repair, cleanup, or fresh');
  }
  const binding = bindSpreadsheetForSetup(spreadsheetReference, mode);
  const ss = binding.spreadsheet;
  return withScriptLock(function () {
    const before = operationalRowCounts(ss);
    if (mode === 'fresh') {
      const populated = Object.keys(before).filter(function (name) { return before[name] > 0; });
      if (populated.length) {
        throw new Error(
          'Fresh setup refused because operational history exists in: ' + populated.join(', ') +
          '. Use repair/cleanup, or reset the new cohort before importing activity.');
      }
    }
    if (binding.shouldStore) {
      const props = PropertiesService.getScriptProperties();
      props.setProperty(PROPERTY_KEYS.spreadsheetId, binding.id);
      props.setProperty(PROPERTY_KEYS.cohort, CONFIG.COHORT);
    }

    const obsolete = mode === 'repair' ? [] : obsoleteResponseTabNames(ss);
    const backup = mode === 'repair' ? null : createWorkbookBackup(ss);
    if (mode === 'fresh') resetFreshOperationalTabs(ss);
    ensureOperationalTabs();

    const deleted = [];
    obsolete.forEach(function (name) {
      const sheet = ss.getSheetByName(name);
      if (!sheet || ss.getSheets().length <= 1) return;
      ss.deleteSheet(sheet);
      deleted.push(name);
    });

    installFormSubmitTrigger(ss);
    const tracking = setupTrackingSheetsCore(
      mode === 'fresh' ? 'empty' : 'existing', guildId || '');
    const tabs = arrangeSheetTabs();
    SpreadsheetApp.flush();
    return {
      version: VERSION,
      cohort: CONFIG.COHORT,
      mode: mode,
      spreadsheet: ss.getName(),
      spreadsheetIdStored: true,
      triggerInstalled: true,
      backupCreated: backup ? backup.name : '',
      obsoleteResponseTabsDeleted: deleted,
      operationalRowsBefore: before,
      tracking: tracking,
      tabs: tabs,
      requiredTabs: Object.keys(configuredSheetMap()).length,
      next: 'Import/check All Data, run !syncmembers, then use !missingdata for private profile completion.',
    };
  });
}

// ============================================================
//  BOT_MAP - active Discord student identity book
//  Discord membership is the active-roster source of truth. All Data and
//  enrollment responses are identity/contact references only; merely filling
//  a Form never makes somebody active.
// ============================================================
const BOT_MAP_HEADERS = [
  'Email', 'Name', 'Discord Username', 'Discord ID', 'Status',
  'Region', 'Subregion', 'Phone', 'Match Source', 'Review Note',
];
const ROSTER_REVIEW_HEADERS = [
  'Discord ID', 'Discord Username', 'Discord Display Name', 'Match Status',
  'Email', 'Matched Name', 'Phone', 'Region', 'Subregion', 'Match Source',
  'Review Note', 'Last Sync', 'Survey Delivery', 'Survey Sent At',
  'Profile Completed At',
];

function normalizeStudentEmail(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
    .trim()
    .replace(/^mailto:/i, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function provisionalStudentEmail(discordId) {
  const id = normalizeDiscordId(discordId).replace(/\D/g, '');
  return id ? 'discord.' + id + '@pending.jp-admin.invalid' : '';
}

function isProvisionalStudentEmail(value) {
  return /^discord\.\d+@pending\.jp-admin\.invalid$/i.test(normalizeStudentEmail(value));
}

function isSyntheticStudentEmail(value) {
  const email = normalizeStudentEmail(value);
  return isProvisionalStudentEmail(email) || /@discord\.com$/i.test(email) || /\.invalid$/i.test(email);
}

function ensureBotMap() {
  const ss = getSpreadsheet();
  let map = ss.getSheetByName(CONFIG.SHEETS.botMap);
  if (!map) {
    map = ss.insertSheet(CONFIG.SHEETS.botMap);
    map.appendRow(BOT_MAP_HEADERS);
    map.setFrozenRows(1);
  }
  if (map.getMaxColumns() < BOT_MAP_HEADERS.length) {
    map.insertColumnsAfter(map.getMaxColumns(), BOT_MAP_HEADERS.length - map.getMaxColumns());
  }
  map.getRange(1, 1, 1, BOT_MAP_HEADERS.length).setValues([BOT_MAP_HEADERS]);
  map.setFrozenRows(1);
  return map;
}

function ensureRosterReview() {
  const sheet = ensureTab(rosterReviewName(), ROSTER_REVIEW_HEADERS);
  if (sheet.getMaxColumns() < ROSTER_REVIEW_HEADERS.length) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(), ROSTER_REVIEW_HEADERS.length - sheet.getMaxColumns());
  }
  sheet.getRange(1, 1, 1, ROSTER_REVIEW_HEADERS.length)
    .setValues([ROSTER_REVIEW_HEADERS])
    .setFontWeight('bold')
    .setBackground('#d9eaf7');
  sheet.getRange(1, 5, 1, 5).setNotes([[
    'Supervisor-editable. Preserved by !syncmembers. Replace a pending address with the real email when known.',
    'Supervisor-editable. Preserved by !syncmembers.',
    'Supervisor-editable. Preserved by !syncmembers.',
    'Supervisor-editable. Preserved by !syncmembers.',
    'Supervisor-editable. Preserved by !syncmembers.',
  ]]);
  sheet.setFrozenRows(1);
  return sheet;
}

function normalizeSheetColor(value) {
  const raw = String(value || '#ffffff').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(raw)) return raw;
  if (/^#[0-9a-f]{3}$/.test(raw)) {
    return '#' + raw.slice(1).split('').map(function (part) { return part + part; }).join('');
  }
  return '#ffffff';
}

// Google Sheets can return visually white theme/alternating-row fills such as
// #f3f3f3 instead of literal #ffffff. Treat only very bright, near-neutral
// fills as white. Intentional red/orange/yellow/green/gray status fills remain
// inactive even when they are pale.
function isNeutralIdentityColor(value) {
  const color = normalizeSheetColor(value);
  const red = parseInt(color.slice(1, 3), 16);
  const green = parseInt(color.slice(3, 5), 16);
  const blue = parseInt(color.slice(5, 7), 16);
  const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
  return Math.min(red, green, blue) >= 238 && spread <= 12;
}

function attendanceIdentityColorMap() {
  const out = {};
  const sheet = getSpreadsheet().getSheetByName(CONFIG.SHEETS.matrix);
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < CONFIG.MATRIX.emailCol) return out;
  const rowCount = sheet.getLastRow() - 1;
  const emails = sheet.getRange(2, CONFIG.MATRIX.emailCol, rowCount, 1).getValues();
  const colors = sheet.getRange(2, CONFIG.MATRIX.emailCol, rowCount, 1).getBackgrounds();
  for (let i = 0; i < rowCount; i++) {
    const email = validStudentProfileEmail(emails[i][0]);
    if (!email) continue;
    const color = normalizeSheetColor(colors[i][0]);
    if (!out[email]) out[email] = [];
    if (out[email].indexOf(color) === -1) out[email].push(color);
  }
  return out;
}

function readBotMap() {
  const map = ensureBotMap();
  const data = map.getDataRange().getValues();
  const backgrounds = data.length > 1
    ? map.getRange(2, 1, data.length - 1, 1).getBackgrounds()
    : [];
  const matrixColors = attendanceIdentityColorMap();
  const byEmail = {};
  const order = [];
  for (let i = 1; i < data.length; i++) {
    const email = validStudentProfileEmail(data[i][0]);
    const name = String(data[i][1] || '').trim();
    const phone = validStudentProfilePhone(data[i].length > 7 ? data[i][7] : '');
    if (!email || !name || !phone) continue;
    const rowColor = normalizeSheetColor(
      backgrounds[i - 1] && backgrounds[i - 1][0] || '#ffffff');
    const attendanceColors = matrixColors[email] || ['#ffffff'];
    const inactiveReasons = [];
    if (!isNeutralIdentityColor(rowColor)) {
      inactiveReasons.push('Bot_Map email cell color ' + rowColor);
    }
    const inactiveAttendanceColors = attendanceColors.filter(function (color) {
      return !isNeutralIdentityColor(color);
    });
    if (inactiveAttendanceColors.length) {
      inactiveReasons.push(
        'Attendance email cell color ' + inactiveAttendanceColors.join(', '));
    }
    const entry = {
      email: email,
      name: name,
      username: String(data[i][2]).trim(),
      discordId: normalizeDiscordId(data[i][3]),
      status: String(data[i][4]).trim().toLowerCase(), // '' | hired | left
      region: data[i].length > 5 ? String(data[i][5]).trim() : '',
      subregion: data[i].length > 6 ? String(data[i][6]).trim() : '',
      phone: phone,
      matchSource: data[i].length > 8 ? String(data[i][8]).trim() : '',
      reviewNote: data[i].length > 9 ? String(data[i][9]).trim() : '',
      active: inactiveReasons.length === 0,
      inactiveReasons: inactiveReasons,
      botMapColor: rowColor,
      attendanceColors: attendanceColors,
    };
    if (!byEmail[email]) {
      byEmail[email] = entry;
      order.push(email);
      continue;
    }
    const current = byEmail[email];
    ['name', 'username', 'discordId', 'status', 'region', 'subregion', 'phone', 'matchSource', 'reviewNote']
      .forEach(function (key) {
        if (!current[key] && entry[key]) current[key] = entry[key];
      });
    if (current.discordId && entry.discordId && current.discordId !== entry.discordId) {
      current.active = false;
      current.reviewNote = 'Conflicting Discord IDs in duplicate Bot_Map rows';
      current.inactiveReasons.push('Conflicting Discord IDs in duplicate Bot_Map rows');
    }
    current.active = current.active && entry.active;
    entry.inactiveReasons.forEach(function (reason) {
      if (current.inactiveReasons.indexOf(reason) === -1) current.inactiveReasons.push(reason);
    });
    entry.attendanceColors.forEach(function (color) {
      if (current.attendanceColors.indexOf(color) === -1) current.attendanceColors.push(color);
    });
  }
  return order.map(function (email) { return byEmail[email]; });
}

function matrixInactiveEmails() {
  const out = {};
  const colors = attendanceIdentityColorMap();
  Object.keys(colors).forEach(function (email) {
    if (colors[email].some(function (color) { return !isNeutralIdentityColor(color); })) {
      out[email] = true;
    }
  });
  return out;
}

function normalizeIdentityToken(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
    .trim().toLowerCase()
    .replace(/^@/, '')
    .replace(/#\d+$/, '')
    .replace(/\s+/g, ' ');
}

function resolveRosterIdentity(values, roster) {
  const candidates = (values || []).map(function (value) {
    const raw = String(value || '').trim();
    return {
      raw: raw,
      normalized: normalizeIdentityToken(raw),
      email: raw.indexOf('@') !== -1 ? normalizeStudentEmail(raw) : '',
      discordId: normalizeDiscordId(raw),
      nameKeys: identityNameKeys(raw),
    };
  }).filter(function (item) { return item.normalized; });
  const matchTier = function (predicate, method) {
    const matches = {};
    for (const candidate of candidates) {
      for (const student of roster) {
        if (predicate(candidate, student)) matches[student.email] = student;
      }
    }
    const emails = Object.keys(matches);
    if (emails.length === 1) {
      return { student: matches[emails[0]], matchedBy: method, ambiguous: false };
    }
    if (emails.length > 1) {
      return {
        student: null,
        matchedBy: '',
        ambiguous: true,
        submitted: candidates.map(function (item) { return item.raw; }).slice(0, 3),
      };
    }
    return null;
  };

  // Strong identifiers win over weaker aliases. A correct submitted email or
  // Discord ID must not become ambiguous because another optional field is
  // stale. Name aliases are accepted only when they identify one roster row.
  const strong = matchTier(function (candidate, student) {
    return (candidate.email && candidate.email === normalizeStudentEmail(student.email)) ||
      (candidate.discordId && candidate.discordId === normalizeDiscordId(student.discordId));
  }, 'email or Discord ID');
  if (strong) return strong;

  const username = matchTier(function (candidate, student) {
    return candidate.normalized &&
      candidate.normalized === normalizeIdentityToken(student.username);
  }, 'Discord username');
  if (username) return username;

  const name = matchTier(function (candidate, student) {
    if (!candidate.nameKeys.length) return false;
    const studentKeys = identityNameKeys(student.name);
    return candidate.nameKeys.some(function (key) { return studentKeys.indexOf(key) !== -1; });
  }, 'unique name alias');
  if (name) return name;

  return {
    student: null,
    matchedBy: '',
    ambiguous: false,
    submitted: candidates.map(function (item) { return item.raw; }).slice(0, 3),
  };
}

function attendanceIdentityValues(headers, values) {
  const wanted = fieldCandidates('attendance', 'studentEmail',
    ['Student Email', 'Enrollment Email', 'Email Address', 'Email',
      'Discord Username', 'Discord Handle', 'Discord ID',
      'Student Name', 'Your Name', 'Full Name', 'Name']);
  const normalizedHeaders = headers.map(function (header) { return String(header || '').trim().toLowerCase(); });
  const indexes = [];
  for (const candidate of wanted) {
    const needle = String(candidate || '').trim().toLowerCase();
    if (!needle) continue;
    for (let i = 0; i < normalizedHeaders.length; i++) {
      if ((normalizedHeaders[i] === needle || normalizedHeaders[i].indexOf(needle) !== -1) && indexes.indexOf(i) === -1) {
        indexes.push(i);
      }
    }
  }
  return indexes.map(function (index) { return values[index]; });
}

// ============================================================
//  MATRIX PRESENT TODAY - emails with 'P' in today's date column
// ============================================================
function matrixAttendanceStatusOnDate(dateKey) {
  const sheet = getSpreadsheet().getSheetByName(CONFIG.SHEETS.matrix);
  const out = {};
  if (!sheet) return out;
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return out;
  const wanted = normalizeSheetDate(dateKey);
  const columns = [];
  for (let c = CONFIG.MATRIX.firstDateCol - 1; c < data[0].length; c++) {
    if (matrixHeaderDateKey(data[0][c]) === wanted) columns.push(c);
  }
  if (!columns.length) return out;
  const emailCol = CONFIG.MATRIX.emailCol - 1;
  for (let i = 1; i < data.length; i++) {
    const email = normalizeStudentEmail(data[i][emailCol]);
    if (!email) continue;
    for (const column of columns) {
      out[email] = mergeAttendanceStatus(out[email], attendanceStatusKind(data[i][column]));
    }
  }
  return out;
}

function matrixPresentOnDate(dateKey) {
  const statuses = matrixAttendanceStatusOnDate(dateKey);
  const out = {};
  Object.keys(statuses).forEach(function (email) {
    if (statuses[email] === 'P') out[email] = true;
  });
  return out;
}

function matrixLeaveOnDate(dateKey) {
  const statuses = matrixAttendanceStatusOnDate(dateKey);
  const out = {};
  Object.keys(statuses).forEach(function (email) {
    if (statuses[email] === 'L') out[email] = true;
  });
  return out;
}

function isAttendanceExcused(value) {
  const status = attendanceStatusKind(value);
  return status === 'P' || status === 'L';
}

function attendanceStatusKind(value) {
  const raw = String(value || '').replace(/\uFE0F/g, '').trim().toUpperCase();
  if (!raw) return '';
  if (raw === 'P' || raw === 'PRESENT' || /^P\s*[·:\-]/.test(raw) || raw === '✅' || raw === '✔') return 'P';
  if (raw === 'L' || raw === 'LEAVE' || raw === 'APPROVED LEAVE' || /^L\s*[·:\-]/.test(raw)) return 'L';
  if (raw === 'A' || raw === 'ABSENT' || raw === '❌' || raw === '✖' || raw === 'X') return 'A';
  // A non-empty manual mark in a recorded session is not silently treated as
  // present. Supervisors can use P or L when it should be excused.
  return 'A';
}

function mergeAttendanceStatus(current, incoming) {
  const weight = { '': 0, A: 1, L: 2, P: 3 };
  const left = attendanceStatusKind(current);
  const right = attendanceStatusKind(incoming);
  return (weight[right] || 0) > (weight[left] || 0) ? right : left;
}

function matrixPresentToday() {
  return matrixPresentOnDate(todayStr());
}

function sheetColumnName(column) {
  let value = Number(column) || 0;
  let name = '';
  while (value > 0) {
    value--;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function activeAttendanceRoster(roster, guildId) {
  const excluded = {};
  excludedDiscordIds(guildId).forEach(function (id) { excluded[id] = true; });
  return (roster || readBotMap()).filter(function (student) {
    return student.active !== false && student.status !== 'hired' &&
      student.status !== 'left' && validStudentProfileEmail(student.email) &&
      validStudentProfilePhone(student.phone) &&
      !(student.discordId && excluded[String(student.discordId)]);
  });
}

function attendanceRosterAudit(roster, guildId) {
  const active = activeAttendanceRoster(roster, guildId);
  const sheet = ensureAttendanceSheet();
  const data = sheet.getDataRange().getValues();
  const rowsByEmail = {};
  const duplicateEmails = [];
  const orphanRows = [];
  for (let i = 1; i < data.length; i++) {
    const email = normalizeStudentEmail(data[i][CONFIG.MATRIX.emailCol - 1]);
    if (!email) {
      if (data[i].some(function (value) { return String(value || '').trim(); })) {
        orphanRows.push(i + 1);
      }
      continue;
    }
    if (!rowsByEmail[email]) rowsByEmail[email] = [];
    rowsByEmail[email].push(i + 1);
  }
  Object.keys(rowsByEmail).forEach(function (email) {
    if (rowsByEmail[email].length > 1) {
      duplicateEmails.push({ email: email, rows: rowsByEmail[email] });
    }
  });
  const missing = active.filter(function (student) {
    return !rowsByEmail[student.email];
  }).map(function (student) {
    return {
      name: student.name,
      email: student.email,
      phone: student.phone || '',
      username: student.username || '',
      discordId: student.discordId || '',
    };
  });
  return {
    sheet: sheet,
    data: data,
    active: active,
    rowsByEmail: rowsByEmail,
    missing: missing,
    duplicateEmails: duplicateEmails,
    orphanRows: orphanRows,
  };
}

function ensureAttendanceRosterRows(roster) {
  const audit = attendanceRosterAudit(roster);
  const sheet = audit.sheet;
  const data = audit.data;
  let updated = 0;
  for (const student of audit.active) {
    const rows = audit.rowsByEmail[student.email] || [];
    if (!rows.length) continue;
    const rowIndex = rows[0] - 1;
    const identity = [
      student.name || data[rowIndex][0] || '',
      student.email,
      student.phone || data[rowIndex][2] || '',
    ];
    if (String(data[rowIndex][0] || '') !== String(identity[0]) ||
        normalizeStudentEmail(data[rowIndex][1]) !== identity[1] ||
        String(data[rowIndex][2] || '') !== String(identity[2])) {
      data[rowIndex][0] = identity[0];
      data[rowIndex][1] = identity[1];
      data[rowIndex][2] = identity[2];
      updated++;
    }
  }
  if (updated && data.length > 1) {
    sheet.getRange(2, 1, data.length - 1, 3).setValues(data.slice(1).map(function (row) {
      return [row[0] || '', row[1] || '', row[2] || ''];
    }));
  }
  const additions = audit.missing.map(function (student) {
    return [student.name, student.email, student.phone, '', '', ''];
  });
  if (additions.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, additions.length, 6).setValues(additions);
  }
  return {
    activeStudents: audit.active.length,
    added: additions.length,
    updated: updated,
    duplicateEmails: audit.duplicateEmails,
    orphanRows: audit.orphanRows,
  };
}

function syncAttendanceMatrix(dateKey, presentSet, roster) {
  const sheet = ensureAttendanceSheet();
  ensureAttendanceRosterRows(roster);
  const data = sheet.getDataRange().getValues();
  const dateCol = attendanceDateColumn(sheet, dateKey);
  const matrixHeader = matrixDateHeader(dateKey);

  const activeByEmail = {};
  for (const student of roster) {
    if (student.active === false || student.status === 'hired' || student.status === 'left') continue;
    activeByEmail[student.email] = student;
  }
  const rowsByEmail = {};
  for (let i = 1; i < data.length; i++) {
    const email = normalizeStudentEmail(data[i][CONFIG.MATRIX.emailCol - 1]);
    if (!email) continue;
    if (!rowsByEmail[email]) rowsByEmail[email] = [];
    rowsByEmail[email].push(i + 1);
  }

  const columnName = sheetColumnName(dateCol);
  const ranges = [];
  for (const email in presentSet) {
    if (!activeByEmail[email]) continue;
    (rowsByEmail[email] || []).forEach(function (row) { ranges.push(columnName + row); });
  }
  if (ranges.length) {
    sheet.getRangeList(ranges).setValue('P');
    sheet.getRangeList(ranges).setBackground('#ffffff');
  }
  return { marked: ranges.length, dateColumn: matrixHeader };
}

// ============================================================
//  INACTIVITY HISTORY - last N sessions from the Attendance matrix
//  Returns: email -> { missed, total, streak }
//  streak = consecutive missed sessions counting back from the
//  most recent session column.
// ============================================================
function getRecentHistory(reportDateKey) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.SHEETS.matrix);
  if (!sheet) return {};
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return {};

  return recentAttendanceHistoryFromData(
    data,
    reportDateKey || todayStr(),
    CONFIG.MATRIX.emailCol - 1,
    CONFIG.MATRIX.firstDateCol - 1,
    CONFIG.RECENT_SESSIONS);
}

function recentAttendanceHistoryFromData(data, reportDateKey, emailColumn, firstDateColumn, limit) {
  if (!data || data.length < 2) return {};
  const columnsByDate = {};
  for (let c = firstDateColumn; c < data[0].length; c++) {
    const key = matrixHeaderDateKey(data[0][c]);
    if (!key || key > reportDateKey) continue;
    if (!columnsByDate[key]) columnsByDate[key] = [];
    columnsByDate[key].push(c);
  }

  // A pre-created blank or future date column is not a completed session.
  const recordedDates = Object.keys(columnsByDate).filter(function (key) {
    return data.slice(1).some(function (row) {
      return columnsByDate[key].some(function (column) {
        return attendanceStatusKind(row[column]) !== '';
      });
    });
  }).sort().slice(-Math.max(1, Number(limit) || 1));
  if (!recordedDates.length) return {};

  const statusByEmail = {};
  for (let i = 1; i < data.length; i++) {
    const email = String(data[i][emailColumn] || '').trim().toLowerCase();
    if (!email) continue;
    if (!statusByEmail[email]) statusByEmail[email] = {};
    recordedDates.forEach(function (key) {
      columnsByDate[key].forEach(function (column) {
        statusByEmail[email][key] = mergeAttendanceStatus(
          statusByEmail[email][key], data[i][column]);
      });
    });
  }

  const history = {};
  Object.keys(statusByEmail).forEach(function (email) {
    let missed = 0, streak = 0, streakBroken = false;
    for (let index = recordedDates.length - 1; index >= 0; index--) {
      const present = isAttendanceExcused(statusByEmail[email][recordedDates[index]]);
      if (!present) missed++;
      if (!streakBroken) {
        if (present) streakBroken = true;
        else streak++;
      }
    }
    history[email] = { missed: missed, total: recordedDates.length, streak: streak };
  });
  return history;
}

// ============================================================
//  GENERIC TAB HELPER
// ============================================================
function ensureTab(name, headers) {
  const ss = getSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  }
  return sh;
}

// ============================================================
//  TAB ORGANIZATION
//  Important supervisor views first, source/reference tabs next, and
//  bot-maintained data last. Unknown tabs are preserved and remain visible.
// ============================================================
function renameResponseSheetTabs() {
  const ss = getSpreadsheet();
  const props = PropertiesService.getScriptProperties();
  const specs = [
    { kind: 'enrollment', target: 'Enrollment Responses', property: PROPERTY_KEYS.enrollmentSheet },
    { kind: 'attendance', target: 'Attendance Responses', property: PROPERTY_KEYS.attendanceSheet },
  ];
  const renamed = [];
  const conflicts = [];
  specs.forEach(function (spec) {
    const currentName = responseSheetName(spec.kind);
    const sheet = ss.getSheetByName(currentName);
    if (!sheet || currentName === spec.target) return;
    const conflict = ss.getSheetByName(spec.target);
    if (conflict && conflict.getSheetId() !== sheet.getSheetId()) {
      conflicts.push(currentName + ' could not become ' + spec.target + ' because that tab already exists');
      return;
    }
    sheet.setName(spec.target);
    props.setProperty(spec.property, spec.target);
    renamed.push({ from: currentName, to: spec.target });
  });
  return { renamed: renamed, conflicts: conflicts };
}

function arrangeSheetTabs() {
  const ss = getSpreadsheet();
  const responseTabs = renameResponseSheetTabs();
  const activeResponseNames = {};
  activeResponseNames[responseSheetName('enrollment')] = true;
  activeResponseNames[responseSheetName('attendance')] = true;
  const otherResponseTabs = ss.getSheets().map(function (sheet) {
    return sheet.getName();
  }).filter(function (name) {
    return !activeResponseNames[name] && /^(form\s*(responses?|data)|responses?\s*form)/i.test(name);
  });
  const groups = [
    {
      label: 'Manual review',
      color: '#6d9eeb',
      names: [
        CONFIG.SHEETS.matrix,
        CONFIG.SHEETS.jobsMatrix,
        CONFIG.SHEETS.outreachMatrix,
        CONFIG.SHEETS.interviewMatrix,
        CONFIG.SHEETS.interviewLog,
        leaveRequestsName(),
        appealLogsName(),
        mailerLogName(),
        CONFIG.SHEETS.botMap,
        botMapArchiveName(),
        rosterReviewName(),
      ],
    },
    {
      label: 'Forms and reference',
      color: '#93c47d',
      names: [
        responseSheetName('enrollment'),
        responseSheetName('attendance'),
        intakeResponsesName(),
        CONFIG.SHEETS.allData,
        CONFIG.SHEETS.resumes,
        CONFIG.SHEETS.projects,
        CONFIG.SHEETS.resources,
      ],
    },
    {
      label: 'Other form-response tabs (review)',
      color: '#ffd966',
      names: otherResponseTabs,
    },
    {
      label: 'Bot-maintained data',
      color: '#b7b7b7',
      names: [
        CONFIG.SHEETS.jobSheets,
        CONFIG.SHEETS.jobsDaily,
        CONFIG.SHEETS.outreachDaily,
        CONFIG.SHEETS.outreachLog,
        CONFIG.SHEETS.workshopAtt,
        dawnAttendanceName(),
        CONFIG.SHEETS.scores,
        CONFIG.SHEETS.questionBank,
      ],
    },
  ];
  const seen = {};
  const result = {
    groups: [],
    moved: 0,
    preservedUnknown: 0,
    responseTabsRenamed: responseTabs.renamed,
    responseTabConflicts: responseTabs.conflicts,
  };
  let position = 1;
  let firstReviewSheet = null;

  for (const group of groups) {
    const arranged = [];
    for (const name of group.names) {
      const normalized = String(name || '').trim();
      if (!normalized || seen[normalized]) continue;
      seen[normalized] = true;
      const sheet = ss.getSheetByName(normalized);
      if (!sheet) continue;
      if (!firstReviewSheet) firstReviewSheet = sheet;
      ss.setActiveSheet(sheet);
      ss.moveActiveSheet(position++);
      sheet.setTabColor(group.color);
      arranged.push(normalized);
      result.moved++;
    }
    result.groups.push({ label: group.label, color: group.color, tabs: arranged });
  }

  result.preservedUnknown = ss.getSheets().filter(function (sheet) {
    return !seen[sheet.getName()];
  }).length;
  if (firstReviewSheet) ss.setActiveSheet(firstReviewSheet);
  return result;
}

// ============================================================
//  HUMAN-FRIENDLY TRACKING MATRICES
//  Jobs Applied / Outreach Update:
//  Name | Email | Phone | date -> daily count
//
//  Jobs_Daily and Outreach_Daily remain the authoritative raw history.
//  These matrices are rebuildable views with three frozen identity columns.
// ============================================================
const TRACKING_ALERT_DAYS = 3;
const TRACKING_ALERT_MIN_TOTAL = 10;
const TRACKING_ALERT_COLOR = '#f4cccc';
const TRACKING_NORMAL_COLOR = '#ffffff';
const TRACKING_INACTIVE_COLOR = '#e06666';

function matrixDateHeader(dateKey) {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(dateKey || '');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Utilities.formatDate(date, 'UTC', 'd/M/yy');
}

function trackingAlertShouldFlag(values, minimumTotal, days) {
  days = Math.max(1, Math.floor(Number(days) || 0));
  if (!Array.isArray(values) || values.length < days) return false;
  const total = values.slice(-days).reduce(function (sum, value) {
    return sum + Math.max(0, Number(value) || 0);
  }, 0);
  return total < Math.max(0, Number(minimumTotal) || 0);
}

function trackingAlertDateColumns(sheet) {
  if (!sheet || sheet.getLastColumn() < 4) return [];
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const columns = [];
  for (let column = 3; column < headers.length; column++) {
    const key = matrixHeaderDateKey(headers[column]);
    if (key) columns.push({ index: column, key: key });
  }
  columns.sort(function (a, b) { return a.key.localeCompare(b.key); });
  return columns.slice(-TRACKING_ALERT_DAYS);
}

function trackingAlertEligible(student, excludedIds) {
  const status = String(student && student.status || '').trim().toLowerCase();
  const discordId = String(student && student.discordId || '').trim();
  return Boolean(student) && student.active !== false && status !== 'hired' && status !== 'left' &&
    !(discordId && excludedIds && excludedIds[discordId]);
}

function trackingAlertExcludedIds(guildId) {
  const out = {};
  for (const id of excludedDiscordIds(guildId)) out[id] = true;
  return out;
}

function refreshTrackingMatrixAlertRow(sheet, row, student, recentColumns, excludedIds) {
  recentColumns = recentColumns || trackingAlertDateColumns(sheet);
  const ready = recentColumns.length === TRACKING_ALERT_DAYS;
  const values = ready
    ? recentColumns.map(function (column) { return sheet.getRange(row, column.index + 1).getValue(); })
    : [];
  const flagged = ready && trackingAlertEligible(student, excludedIds) &&
    trackingAlertShouldFlag(values, TRACKING_ALERT_MIN_TOTAL, TRACKING_ALERT_DAYS);
  const inactive = trackingStudentInactive(student, excludedIds);
  sheet.getRange(row, 1, 1, sheet.getLastColumn())
    .setBackground(inactive
      ? TRACKING_INACTIVE_COLOR
      : (flagged ? TRACKING_ALERT_COLOR : TRACKING_NORMAL_COLOR));
  return flagged;
}

function refreshTrackingMatrixAlerts(sheetName, guildId) {
  const sheet = getSpreadsheet().getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) {
    return { evaluated: 0, flagged: 0, inactive: 0, recentDates: [], minimumTotal: TRACKING_ALERT_MIN_TOTAL };
  }
  const recentColumns = trackingAlertDateColumns(sheet);
  const excludedIds = trackingAlertExcludedIds(guildId);
  const students = {};
  for (const student of trackingStudents()) students[student.email] = student;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  const backgrounds = [];
  let evaluated = 0;
  let flagged = 0;
  let inactiveCount = 0;
  for (const row of rows) {
    const email = String(row[1] || '').trim().toLowerCase();
    const student = students[email];
    const eligible = trackingAlertEligible(student, excludedIds);
    const inactive = trackingStudentInactive(student, excludedIds);
    const ready = recentColumns.length === TRACKING_ALERT_DAYS;
    const values = ready ? recentColumns.map(function (column) { return row[column.index]; }) : [];
    const shouldFlag = ready && eligible &&
      trackingAlertShouldFlag(values, TRACKING_ALERT_MIN_TOTAL, TRACKING_ALERT_DAYS);
    if (ready && eligible) evaluated++;
    if (shouldFlag) flagged++;
    if (inactive) inactiveCount++;
    backgrounds.push(new Array(sheet.getLastColumn()).fill(inactive
      ? TRACKING_INACTIVE_COLOR
      : (shouldFlag ? TRACKING_ALERT_COLOR : TRACKING_NORMAL_COLOR)));
  }
  sheet.getRange(2, 1, backgrounds.length, sheet.getLastColumn()).setBackgrounds(backgrounds);
  return {
    evaluated: evaluated,
    flagged: flagged,
    inactive: inactiveCount,
    recentDates: recentColumns.map(function (column) { return column.key; }),
    minimumTotal: TRACKING_ALERT_MIN_TOTAL,
  };
}

function refreshStatusOnlyMatrixRows(sheetName, guildId) {
  const sheet = getSpreadsheet().getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return { evaluated: 0, inactive: 0 };
  const excludedIds = trackingAlertExcludedIds(guildId);
  const students = {};
  for (const student of trackingStudents()) students[student.email] = student;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  const backgrounds = [];
  let inactive = 0;
  rows.forEach(function (row) {
    const email = normalizeStudentEmail(row[1]);
    const isInactive = trackingStudentInactive(students[email], excludedIds);
    if (isInactive) inactive++;
    backgrounds.push(new Array(sheet.getLastColumn()).fill(
      isInactive ? TRACKING_INACTIVE_COLOR : TRACKING_NORMAL_COLOR));
  });
  sheet.getRange(2, 1, backgrounds.length, sheet.getLastColumn()).setBackgrounds(backgrounds);
  return { evaluated: rows.length, inactive: inactive };
}

function refreshAttendanceInactiveRows(guildId) {
  const sheet = ensureAttendanceSheet();
  if (sheet.getLastRow() < 2) return { evaluated: 0, inactive: 0, activated: 0 };
  const excludedIds = trackingAlertExcludedIds(guildId);
  const students = {};
  for (const student of readBotMap()) students[student.email] = student;
  const emails = sheet.getRange(
    2, CONFIG.MATRIX.emailCol, sheet.getLastRow() - 1, 1).getValues();
  const range = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn());
  const backgrounds = range.getBackgrounds();
  let inactive = 0;
  let activated = 0;
  for (let row = 0; row < backgrounds.length; row++) {
    const email = normalizeStudentEmail(emails[row][0]);
    const isInactive = trackingStudentInactive(students[email], excludedIds);
    if (isInactive) {
      backgrounds[row] = new Array(sheet.getLastColumn()).fill(TRACKING_INACTIVE_COLOR);
      inactive++;
      continue;
    }
    let cleared = false;
    backgrounds[row] = backgrounds[row].map(function (color) {
      if (normalizeSheetColor(color) !== TRACKING_INACTIVE_COLOR) return color;
      cleared = true;
      return TRACKING_NORMAL_COLOR;
    });
    if (cleared) activated++;
  }
  range.setBackgrounds(backgrounds);
  return { evaluated: backgrounds.length, inactive: inactive, activated: activated };
}

function refreshStudentStatusStyles(guildId) {
  return {
    attendance: refreshAttendanceInactiveRows(guildId),
    jobs: refreshTrackingMatrixAlerts(CONFIG.SHEETS.jobsMatrix, guildId),
    outreach: refreshTrackingMatrixAlerts(CONFIG.SHEETS.outreachMatrix, guildId),
    interviews: refreshStatusOnlyMatrixRows(CONFIG.SHEETS.interviewMatrix, guildId),
  };
}

function trackingStudents() {
  const phones = {};
  for (const student of readAllData()) phones[student.email] = student.phone || '';

  const attendance = getSpreadsheet().getSheetByName(CONFIG.SHEETS.matrix);
  if (attendance && attendance.getLastRow() > 1 && attendance.getLastColumn() >= 3) {
    const rows = attendance.getRange(2, 1, attendance.getLastRow() - 1, 3).getValues();
    for (const row of rows) {
      const email = String(row[1] || '').trim().toLowerCase();
      if (email && !phones[email]) phones[email] = String(row[2] || '').trim();
    }
  }

  return readBotMap().map(function (student) {
    return {
      email: student.email,
      name: student.name,
      phone: phones[student.email] || '',
      username: student.username || '',
      discordId: student.discordId || '',
      status: student.status || '',
      active: student.active !== false,
    };
  }).sort(function (a, b) {
    return String(a.name || a.email).localeCompare(String(b.name || b.email));
  });
}

function readTrackingSource(kind) {
  const sheetName = kind === 'jobs'
    ? CONFIG.SHEETS.jobsDaily
    : (kind === 'interviews' ? CONFIG.SHEETS.interviewLog : CONFIG.SHEETS.outreachDaily);
  const sheet = getSpreadsheet().getSheetByName(sheetName);
  const counts = {};
  const dates = {};
  const names = {};
  if (!sheet || sheet.getLastRow() < 2) {
    return { counts: counts, dates: [], names: names };
  }

  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(function (value) { return String(value || '').trim().toLowerCase(); });
  const countColumn = headers.indexOf('count');
  const nameColumn = headers.indexOf('name');
  for (let i = 1; i < data.length; i++) {
    const date = normalizeSheetDate(data[i][0]);
    const email = String(data[i][1] || '').trim().toLowerCase();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !email) continue;
    dates[date] = true;
    counts[email] = counts[email] || {};
    if (kind === 'jobs') {
      counts[email][date] = Math.max(0, Number(data[i][2]) || 0); // latest authoritative row wins
    } else {
      const amount = kind === 'outreach' && countColumn >= 0
        ? Math.max(0, Number(data[i][countColumn]) || 0)
        : 1;
      counts[email][date] = (counts[email][date] || 0) + amount;
    }
    if (nameColumn >= 0 && data[i][nameColumn]) names[email] = String(data[i][nameColumn]).trim();
  }
  return { counts: counts, dates: Object.keys(dates).sort(), names: names };
}

function ensureSheetSize(sheet, rows, columns) {
  if (sheet.getMaxRows() < rows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
  }
  if (sheet.getMaxColumns() < columns) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), columns - sheet.getMaxColumns());
  }
}

function formatTrackingMatrix(sheet, columns) {
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(3);
  sheet.setColumnWidth(1, 190);
  sheet.setColumnWidth(2, 220);
  sheet.setColumnWidth(3, 135);
  if (columns > 3) {
    for (let column = 4; column <= columns; column++) sheet.setColumnWidth(column, 78);
  }
  sheet.getRange(1, 1, 1, columns)
    .setFontWeight('bold')
    .setBackground('#d9eaf7')
    .setHorizontalAlignment('center');
}

function rebuildTrackingMatrix(sheetName, kind, mode, students) {
  const source = mode === 'existing' ? readTrackingSource(kind) :
    { counts: {}, dates: [], names: {} };
  const byEmail = {};
  for (const student of students) byEmail[student.email] = student;

  for (const email in source.counts) {
    if (byEmail[email]) continue;
    const extra = {
      email: email,
      name: source.names[email] || email,
      phone: '',
      username: '',
      discordId: '',
      status: '',
      active: false,
    };
    students.push(extra);
    byEmail[email] = extra;
  }
  students.sort(function (a, b) {
    return String(a.name || a.email).localeCompare(String(b.name || b.email));
  });

  const headers = ['Name', 'Email', 'Phone'].concat(source.dates.map(matrixDateHeader));
  const rows = students.map(function (student) {
    const daily = source.counts[student.email] || {};
    const values = [student.name, student.email, student.phone];
    for (const date of source.dates) {
      if (Object.prototype.hasOwnProperty.call(daily, date)) values.push(daily[date]);
      else values.push(kind === 'jobs' ? '' : 0);
    }
    return values;
  });

  const sheet = ensureTab(sheetName, ['Name', 'Email', 'Phone']);
  ensureSheetSize(sheet, Math.max(2, rows.length + 1), headers.length);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length) sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  formatTrackingMatrix(sheet, headers.length);

  let filledCells = 0;
  for (const email in source.counts) filledCells += Object.keys(source.counts[email]).length;
  return {
    sheet: sheetName,
    students: rows.length,
    dateColumns: source.dates.length,
    filledCells: filledCells,
  };
}

function trackingRowMap(sheet) {
  const out = {};
  if (sheet.getLastRow() < 2) return out;
  const values = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    const email = String(values[i][0] || '').trim().toLowerCase();
    if (email) out[email] = i + 2;
  }
  return out;
}

function trackingDateColumn(sheet, dateStr, zeroFill) {
  const dateKey = normalizeSheetDate(dateStr);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error('Invalid tracking date: ' + dateStr);
  const headers = sheet.getRange(1, 1, 1, Math.max(3, sheet.getLastColumn())).getValues()[0];
  for (let i = 3; i < headers.length; i++) {
    if (matrixHeaderDateKey(headers[i]) === dateKey) return i + 1;
  }
  const column = Math.max(4, sheet.getLastColumn() + 1);
  ensureSheetSize(sheet, Math.max(2, sheet.getLastRow()), column);
  sheet.getRange(1, column).setValue(matrixDateHeader(dateKey))
    .setFontWeight('bold').setBackground('#d9eaf7').setHorizontalAlignment('center');
  sheet.setColumnWidth(column, 78);
  if (zeroFill && sheet.getLastRow() > 1) {
    sheet.getRange(2, column, sheet.getLastRow() - 1, 1).setValue(0);
  }
  return column;
}

function syncTrackingMatrixCounts(sheetName, dateStr, counts, zeroFill, guildId, alertMode) {
  const sheet = getSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return { skipped: true, reason: 'matrix not set up' };
  const column = trackingDateColumn(sheet, dateStr, zeroFill);
  const students = trackingStudents();
  const studentByEmail = {};
  for (const student of students) studentByEmail[student.email] = student;
  let rowByEmail = trackingRowMap(sheet);
  const additions = [];
  const additionEmails = [];

  for (const email in counts) {
    if (rowByEmail[email]) continue;
    const student = studentByEmail[email] || { email: email, name: email, phone: '' };
    const row = new Array(sheet.getLastColumn()).fill(zeroFill ? 0 : '');
    row[0] = student.name || email;
    row[1] = email;
    row[2] = student.phone || '';
    additions.push(row);
    additionEmails.push(email);
  }
  if (additions.length) {
    const firstRow = sheet.getLastRow() + 1;
    ensureSheetSize(sheet, firstRow + additions.length - 1, sheet.getLastColumn());
    sheet.getRange(firstRow, 1, additions.length, sheet.getLastColumn()).setValues(additions);
    for (let i = 0; i < additionEmails.length; i++) rowByEmail[additionEmails[i]] = firstRow + i;
  }

  if (sheet.getLastRow() > 1) {
    const values = sheet.getRange(2, column, sheet.getLastRow() - 1, 1).getValues();
    for (const email in counts) {
      const row = rowByEmail[email];
      if (row) values[row - 2][0] = Math.max(0, Number(counts[email]) || 0);
    }
    sheet.getRange(2, column, values.length, 1).setValues(values);
  }
  return {
    updated: Object.keys(counts).length,
    dateColumn: matrixDateHeader(dateStr),
    alerts: alertMode === false
      ? refreshStatusOnlyMatrixRows(sheetName, guildId)
      : refreshTrackingMatrixAlerts(sheetName, guildId),
  };
}

function incrementOutreachMatrix(dateStr, student, guildId) {
  const sheet = getSpreadsheet().getSheetByName(CONFIG.SHEETS.outreachMatrix);
  if (!sheet) return { skipped: true, reason: 'matrix not set up' };
  const previousLastColumn = sheet.getLastColumn();
  const column = trackingDateColumn(sheet, dateStr, true);
  let rowByEmail = trackingRowMap(sheet);
  let row = rowByEmail[student.email];
  if (!row) {
    row = sheet.getLastRow() + 1;
    ensureSheetSize(sheet, row, sheet.getLastColumn());
    const values = new Array(sheet.getLastColumn()).fill(0);
    values[0] = student.name || student.email;
    values[1] = student.email;
    values[2] = student.phone || '';
    sheet.getRange(row, 1, 1, values.length).setValues([values]);
  }
  const cell = sheet.getRange(row, column);
  cell.setValue(Math.max(0, Number(cell.getValue()) || 0) + 1);
  const alerts = sheet.getLastColumn() > previousLastColumn
    ? refreshTrackingMatrixAlerts(CONFIG.SHEETS.outreachMatrix, guildId)
    : {
        rowFlagged: refreshTrackingMatrixAlertRow(
          sheet, row, student, trackingAlertDateColumns(sheet), trackingAlertExcludedIds(guildId)),
      };
  return { updated: student.email, count: Number(cell.getValue()) || 0, alerts: alerts };
}

function syncTrackingStudent(email, name, phone) {
  email = String(email || '').trim().toLowerCase();
  if (!email) return;
  const specs = [
    { name: CONFIG.SHEETS.jobsMatrix, zeroFill: false },
    { name: CONFIG.SHEETS.outreachMatrix, zeroFill: true },
    { name: CONFIG.SHEETS.interviewMatrix, zeroFill: true },
  ];
  for (const spec of specs) {
    const sheet = getSpreadsheet().getSheetByName(spec.name);
    if (!sheet) continue;
    const rows = trackingRowMap(sheet);
    let row = rows[email];
    if (!row) {
      row = sheet.getLastRow() + 1;
      ensureSheetSize(sheet, row, Math.max(3, sheet.getLastColumn()));
      const values = new Array(Math.max(3, sheet.getLastColumn())).fill(spec.zeroFill ? 0 : '');
      values[0] = name || email;
      values[1] = email;
      values[2] = phone || '';
      sheet.getRange(row, 1, 1, values.length)
        .setValues([values])
        .setBackground(TRACKING_NORMAL_COLOR);
    } else {
      const identity = sheet.getRange(row, 1, 1, 3).getValues()[0];
      sheet.getRange(row, 1, 1, 3).setValues([[
        name || identity[0],
        email,
        phone || identity[2],
      ]]);
    }
  }
}

function setupTrackingSheetsCore(mode, guildId) {
  mode = String(mode || '').trim().toLowerCase();
  if (mode !== 'existing' && mode !== 'empty') {
    throw new Error('Tracking Sheet mode must be existing or empty');
  }
  const students = trackingStudents();
  const jobs = rebuildTrackingMatrix(
    CONFIG.SHEETS.jobsMatrix, 'jobs', mode,
    students.map(function (student) { return Object.assign({}, student); }));
  const outreach = rebuildTrackingMatrix(
    CONFIG.SHEETS.outreachMatrix, 'outreach', mode,
    students.map(function (student) { return Object.assign({}, student); }));
  const interviews = rebuildTrackingMatrix(
    CONFIG.SHEETS.interviewMatrix, 'interviews', mode,
    students.map(function (student) { return Object.assign({}, student); }));
  jobs.alerts = refreshTrackingMatrixAlerts(CONFIG.SHEETS.jobsMatrix, guildId);
  outreach.alerts = refreshTrackingMatrixAlerts(CONFIG.SHEETS.outreachMatrix, guildId);
  interviews.statusStyles = refreshStatusOnlyMatrixRows(CONFIG.SHEETS.interviewMatrix, guildId);
  const attendanceFlags = refreshAttendanceAbsenceFlags();
  const statusStyles = refreshStudentStatusStyles(guildId);
  const tabs = arrangeSheetTabs();
  SpreadsheetApp.flush();
  return {
    mode: mode,
    rawLogsPreserved: true,
    jobs: jobs,
    outreach: outreach,
    interviews: interviews,
    attendanceFlags: attendanceFlags,
    statusStyles: statusStyles,
    tabs: tabs,
  };
}

function setupTrackingSheets(mode, guildId) {
  return withScriptLock(function () {
    return setupTrackingSheetsCore(mode, guildId);
  });
}

// ============================================================
//  WEEKLY ABSENCE REPORT + ATTENDANCE ❌ FLAGS
//  Reports count recorded session columns, not calendar days.
// ============================================================
function sundayWeekStartKey(dateKey) {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return Utilities.formatDate(date, 'UTC', 'yyyy-MM-dd');
}

function absenceSessionColumns(sheet, start, end) {
  if (!sheet || sheet.getLastColumn() < CONFIG.MATRIX.firstDateCol) return [];
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const byDate = {};
  for (let column = CONFIG.MATRIX.firstDateCol - 1; column < headers.length; column++) {
    const key = matrixHeaderDateKey(headers[column]);
    if (!key || key < start || key > end) continue;
    if (!byDate[key]) byDate[key] = { index: column, indexes: [], key: key };
    byDate[key].indexes.push(column);
  }
  const data = sheet.getDataRange().getValues();
  const columns = Object.keys(byDate).filter(function (key) {
    return data.slice(1).some(function (row) {
      return byDate[key].indexes.some(function (index) {
        return attendanceStatusKind(row[index]) !== '';
      });
    });
  }).map(function (key) { return byDate[key]; });
  columns.sort(function (a, b) { return a.key.localeCompare(b.key); });
  return columns;
}

function trackingStudentInactive(student, excludedIds) {
  const status = String(student && student.status || '').trim().toLowerCase();
  const discordId = String(student && student.discordId || '').trim();
  if (!student || status === 'hired' || status === 'left') return false;
  return student.active === false || Boolean(discordId && excludedIds && excludedIds[discordId]);
}

function attendanceStatusForRows(rows, column) {
  let status = '';
  const indexes = column.indexes || [column.index];
  (rows || []).forEach(function (row) {
    indexes.forEach(function (index) {
      status = mergeAttendanceStatus(status, row[index]);
    });
  });
  return status;
}

function longestAbsenceStreak(rows, columns) {
  let current = 0;
  let longest = 0;
  for (const column of columns) {
    if (isAttendanceExcused(attendanceStatusForRows(rows, column))) current = 0;
    else {
      current++;
      longest = Math.max(longest, current);
    }
  }
  return longest;
}

function getAbsenceReport(start, end, guildId, includeExcluded) {
  start = String(start || '');
  end = String(end || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
    throw new Error('Absence report requires a valid start and end date');
  }
  const maxEnd = shiftDateKey(start, 62);
  if (end > maxEnd) throw new Error('Absence report range cannot exceed 63 days');

  const sheet = getSpreadsheet().getSheetByName(CONFIG.SHEETS.matrix);
  const columns = absenceSessionColumns(sheet, start, end);
  const data = sheet ? sheet.getDataRange().getValues() : [];
  const rowsByEmail = {};
  for (let i = 1; i < data.length; i++) {
    const email = normalizeStudentEmail(data[i][CONFIG.MATRIX.emailCol - 1]);
    if (!email) continue;
    if (!rowsByEmail[email]) rowsByEmail[email] = [];
    rowsByEmail[email].push(data[i]);
  }
  const excluded = {};
  for (const id of excludedDiscordIds(guildId)) excluded[id] = true;
  const students = [];
  for (const student of trackingStudents()) {
    if (!student.active || student.status === 'hired' || student.status === 'left' ||
        (!includeExcluded && student.discordId && excluded[student.discordId])) continue;
    const rows = rowsByEmail[student.email] || [];
    const absentDates = columns.filter(function (column) {
      return !isAttendanceExcused(attendanceStatusForRows(rows, column));
    }).map(function (column) { return column.key; });
    if (!absentDates.length) continue;
    students.push({
      email: student.email,
      name: student.name,
      phone: student.phone,
      username: student.username,
      discordId: student.discordId,
      absentDays: absentDates.length,
      longestStreak: longestAbsenceStreak(rows, columns),
      absentDates: absentDates,
    });
  }
  students.sort(function (a, b) {
    return b.absentDays - a.absentDays ||
      b.longestStreak - a.longestStreak ||
      String(a.name).localeCompare(String(b.name));
  });
  return {
    version: VERSION,
    cohort: CONFIG.COHORT,
    start: start,
    end: end,
    recordedSessions: columns.map(function (column) { return column.key; }),
    students: students,
  };
}

function qualifyingAbsenceIndexes(rows, columns) {
  const qualifying = {};
  let run = [];
  function finishRun() {
    if (run.length >= 3) {
      for (const column of run) qualifying[column.key] = true;
    }
    run = [];
  }
  for (const column of columns) {
    if (isAttendanceExcused(attendanceStatusForRows(rows, column))) finishRun();
    else run.push(column);
  }
  finishRun();
  return qualifying;
}

function refreshAttendanceAbsenceFlags() {
  const sheet = getSpreadsheet().getSheetByName(CONFIG.SHEETS.matrix);
  if (!sheet || sheet.getLastRow() < 2) {
    return { flaggedStudents: 0, markedCells: 0, recordedSessions: 0 };
  }
  const today = todayStr();
  const currentStart = sundayWeekStartKey(today);
  const previousStart = shiftDateKey(currentStart, -7);
  const previousEnd = shiftDateKey(currentStart, -1);
  const previousColumns = absenceSessionColumns(sheet, previousStart, previousEnd);
  const currentColumns = absenceSessionColumns(sheet, currentStart, today);
  const allColumns = previousColumns.concat(currentColumns);
  if (!allColumns.length) {
    return { flaggedStudents: 0, markedCells: 0, recordedSessions: 0 };
  }

  const data = sheet.getDataRange().getValues();
  const active = {};
  for (const student of readBotMap()) {
    if (student.active !== false && student.status !== 'hired' && student.status !== 'left') {
      active[student.email] = true;
    }
  }
  const clearRanges = [];
  const markRanges = [];
  const flaggedEmails = {};
  const rowsByEmail = {};
  for (let rowIndex = 1; rowIndex < data.length; rowIndex++) {
    const email = normalizeStudentEmail(data[rowIndex][CONFIG.MATRIX.emailCol - 1]);
    if (!email) continue;
    if (!rowsByEmail[email]) rowsByEmail[email] = [];
    rowsByEmail[email].push(data[rowIndex]);
  }

  for (let rowIndex = 1; rowIndex < data.length; rowIndex++) {
    const email = normalizeStudentEmail(data[rowIndex][CONFIG.MATRIX.emailCol - 1]);
    const qualifying = active[email] ? Object.assign(
      {},
      qualifyingAbsenceIndexes(rowsByEmail[email], previousColumns),
      qualifyingAbsenceIndexes(rowsByEmail[email], currentColumns),
    ) : {};
    for (const column of allColumns) {
      (column.indexes || [column.index]).forEach(function (index) {
        const value = String(data[rowIndex][index] || '').trim();
        const address = sheetColumnName(index + 1) + (rowIndex + 1);
        if (value === '❌' && !qualifying[column.key]) clearRanges.push(address);
        if (qualifying[column.key] && (value === '' || value === '❌')) {
          markRanges.push(address);
          flaggedEmails[email] = true;
        }
      });
    }
  }

  if (clearRanges.length) {
    sheet.getRangeList(clearRanges).clearContent();
    sheet.getRangeList(clearRanges).setBackground('#ffffff');
  }
  if (markRanges.length) {
    sheet.getRangeList(markRanges).setValue('❌');
    sheet.getRangeList(markRanges).setBackground('#f4cccc');
  }
  return {
    flaggedStudents: Object.keys(flaggedEmails).length,
    markedCells: markRanges.length,
    recordedSessions: allColumns.length,
    range: previousStart + ' to ' + today,
  };
}

// ============================================================
//  LOCATION AUTO-FILL - copy region/subregion into Bot_Map from
//  any tab+column (default: resolved enrollment response, region/location).
//  Latest row per email wins. Region detected by BD division name.
// ============================================================
const BD_DIVISIONS = ['dhaka','chattogram','chittagong','khulna','rajshahi','sylhet','barishal','barisal','rangpur','mymensingh'];

function parseLocation(text) {
  const parts = String(text || '').split(/[,\/|\-]+/).map(function (p) { return p.trim(); }).filter(String);
  if (!parts.length) return null;
  if (parts.length === 1) {
    return { region: parts[0], subregion: '', sure: BD_DIVISIONS.indexOf(parts[0].toLowerCase()) !== -1 };
  }
  let regionIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    if (BD_DIVISIONS.indexOf(parts[i].toLowerCase()) !== -1) { regionIdx = i; break; }
  }
  if (regionIdx === -1) {
    // no division matched: assume "Subregion, Region" convention
    return { region: parts[parts.length - 1], subregion: parts.slice(0, -1).join(', '), sure: false };
  }
  const region = parts[regionIdx];
  const sub = parts.filter(function (_, i) { return i !== regionIdx; }).join(', ');
  return { region: region, subregion: sub, sure: true };
}

function fillLocations(tabName, columnName) {
  tabName = String(tabName || responseSheetName('enrollment'));
  columnName = String(columnName || 'region').toLowerCase();

  const ss = getSpreadsheet();
  const sh = ss.getSheetByName(tabName);
  if (!sh) return { error: 'tab not found: ' + tabName };
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return { error: 'tab is empty' };

  const headers = data[0].map(function (h) { return String(h).toLowerCase(); });
  let locCol = headers.findIndex(function (h) { return h.indexOf(columnName) !== -1; });
  if (locCol === -1 && columnName === 'region') {
    locCol = headers.findIndex(function (h) { return h.indexOf('region') !== -1 || h.indexOf('location') !== -1; });
  }
  const subCol = headers.findIndex(function (h) { return h.indexOf('subregion') !== -1 || h.indexOf('area') !== -1; });
  const emailCol = headers.findIndex(function (h) { return h.indexOf('email') !== -1; });
  if (locCol === -1) return { error: 'no column containing "' + columnName + '" in ' + tabName };
  if (emailCol === -1) return { error: 'no email column found in ' + tabName };

  // latest value per email (top-to-bottom, later rows overwrite)
  const latest = {};
  for (let i = 1; i < data.length; i++) {
    const email = String(data[i][emailCol]).trim().toLowerCase();
    const loc = String(data[i][locCol]).trim();
    const sub = subCol === -1 ? '' : String(data[i][subCol]).trim();
    if (email && loc) latest[email] = { location: loc, subregion: sub };
  }

  const map = ensureBotMap();
  const mData = map.getDataRange().getValues();
  let updated = 0, unsureCount = 0;
  const unmatched = [], unsureSamples = [];

  for (const email in latest) {
    const parsed = parseLocation(latest[email].location);
    if (!parsed) continue;
    if (latest[email].subregion) parsed.subregion = latest[email].subregion;
    let found = false;
    for (let i = 1; i < mData.length; i++) {
      if (String(mData[i][0]).trim().toLowerCase() === email) {
        map.getRange(i + 1, 6, 1, 2).setValues([[parsed.region, parsed.subregion]]);
        updated++;
        found = true;
        if (!parsed.sure) {
          unsureCount++;
          if (unsureSamples.length < 8) unsureSamples.push(latest[email].location + ' → ' + parsed.region + ' / ' + parsed.subregion);
        }
        break;
      }
    }
    if (!found) unmatched.push(email);
  }

  return {
    tab: tabName, updated: updated,
    unsure: unsureCount, unsureSamples: unsureSamples,
    unmatched: unmatched.slice(0, 10), unmatchedCount: unmatched.length,
  };
}

// ============================================================
//  RESUMES - latest resume message per student
//  Link = Discord message jump link (permanent while msg exists)
//  File URL = attachment CDN url (expires after weeks - backup only)
// ============================================================
function saveResume(email, link, fileUrl) {
  email = String(email || '').trim().toLowerCase();
  if (!email || !link) return { error: 'missing email or link' };
  const sh = ensureTab(CONFIG.SHEETS.resumes, ['Email','Name','Resume Link','File URL','Updated']);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === email) {
      sh.getRange(i + 1, 3, 1, 3).setValues([[link, fileUrl || '', todayStr()]]);
      return { updated: email };
    }
  }
  const s = readBotMap().find(function (x) { return x.email === email; });
  sh.appendRow([email, s ? s.name : '', link, fileUrl || '', todayStr()]);
  return { created: email };
}

function saveProject(body) {
  return withScriptLock(function () {
    const sh = ensureTab(CONFIG.SHEETS.projects, ['Email','Name','Project Link','File URL','Summary','Updated']);
    const email = String(body.email || '').trim().toLowerCase();
    const link = String(body.link || '').trim();
    if (!email || !link) return { error: 'missing email or project link' };
    const s = readBotMap().find(function (x) { return x.email === email; });
    const row = [email, s ? s.name : '', link, body.fileUrl || '', String(body.summary || '').slice(0, 1500), todayStr()];
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][2] || '').trim() === link) {
        sh.getRange(i + 1, 1, 1, 6).setValues([row]);
        return { saved: true, updated: true, duplicate: true };
      }
    }
    sh.appendRow(row);
    return { saved: true, created: true };
  });
}

// merged view: Bot_Map + phone (All Data) + resume link
function studentInfo() {
  const phones = {};
  for (const a of readAllData()) phones[a.email] = a.phone;
  const resumes = {};
  const sh = getSpreadsheet().getSheetByName(CONFIG.SHEETS.resumes);
  if (sh) {
    const d = sh.getDataRange().getValues();
    for (let i = 1; i < d.length; i++) {
      resumes[String(d[i][0]).trim().toLowerCase()] = String(d[i][2]).trim();
    }
  }
  const projects = {};
  const psh = getSpreadsheet().getSheetByName(CONFIG.SHEETS.projects);
  if (psh) {
    const pd = psh.getDataRange().getValues();
    for (let i = 1; i < pd.length; i++) {
      const em = String(pd[i][0]).trim().toLowerCase();
      (projects[em] = projects[em] || []).push({ link: String(pd[i][2]), summary: String(pd[i][4]).slice(0, 300) });
    }
  }
  return readBotMap().map(function (s) {
    return Object.assign({}, s, {
      phone: phones[s.email] || s.phone || '',
      resume: resumes[s.email] || '',
      projects: (projects[s.email] || []).slice(-5),
    });
  });
}

function shiftDateKey(key, amount) {
  const m = String(key || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + Number(amount || 0));
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

function matrixHeaderDateKey(value) {
  if (value instanceof Date && !isNaN(value)) return Utilities.formatDate(value, CONFIG.TZ, 'yyyy-MM-dd');
  const raw = String(value || '').trim();
  const m = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})$/);
  if (m) {
    const year = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
    const month = String(Number(m[2])).padStart(2, '0');
    const day = String(Number(m[1])).padStart(2, '0');
    return String(year).padStart(4, '0') + '-' + month + '-' + day;
  }
  const normalized = normalizeSheetDate(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
}

function performanceRange(start, end, days) {
  const endKey = /^\d{4}-\d{2}-\d{2}$/.test(String(end || '')) ? String(end) : todayStr();
  const count = Math.max(1, Math.min(31, Number(days) || 7));
  const startKey = /^\d{4}-\d{2}-\d{2}$/.test(String(start || '')) ? String(start) : shiftDateKey(endKey, -(count - 1));
  if (startKey > endKey) throw new Error('performance start date is after end date');
  return { start: startKey, end: endKey };
}

function getPerformanceReport(start, end, emailFilter, includeHistory, days) {
  const range = performanceRange(start, end, days);
  const wanted = String(emailFilter || '').trim().toLowerCase();
  const students = {};
  for (const s of studentInfo()) {
    if (wanted && s.email !== wanted) continue;
    students[s.email] = {
      email: s.email, name: s.name, discordId: s.discordId, status: s.status,
      phone: s.phone || '', jobs: 0, jobDays: {}, attendance: 0, leaveDays: {},
      interviews: 0, interviewHistory: [], outreach: 0, outreachDays: {}, workshops: 0,
      workshopDays: {}, communicationPractices: 0, communicationDays: {},
      questionAnswers: 0, questionScore: 0,
    };
  }
  function entry(email) { return students[String(email || '').trim().toLowerCase()] || null; }
  function inRange(value) {
    const key = normalizeSheetDate(value);
    return /^\d{4}-\d{2}-\d{2}$/.test(key) && key >= range.start && key <= range.end ? key : '';
  }

  const ss = getSpreadsheet();
  let sh = ss.getSheetByName(CONFIG.SHEETS.jobsDaily);
  if (sh) {
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const e = entry(data[i][1]);
      const key = inRange(data[i][0]);
      if (!e || !key) continue;
      const count = Number(data[i][2]) || 0;
      e.jobs += count;
      e.jobDays[key] = count;
    }
  }

  sh = ss.getSheetByName(CONFIG.SHEETS.matrix);
  if (sh) {
    const data = sh.getDataRange().getValues();
    if (data.length) {
      const dateCols = {};
      for (let c = CONFIG.MATRIX.firstDateCol - 1; c < data[0].length; c++) {
        const key = matrixHeaderDateKey(data[0][c]);
        if (!key || key < range.start || key > range.end) continue;
        if (!dateCols[key]) dateCols[key] = [];
        dateCols[key].push(c);
      }
      const statusByEmail = {};
      for (let i = 1; i < data.length; i++) {
        const email = normalizeStudentEmail(data[i][CONFIG.MATRIX.emailCol - 1]);
        if (!entry(email)) continue;
        if (!statusByEmail[email]) statusByEmail[email] = {};
        Object.keys(dateCols).forEach(function (key) {
          dateCols[key].forEach(function (column) {
            statusByEmail[email][key] = mergeAttendanceStatus(
              statusByEmail[email][key], data[i][column]);
          });
        });
      }
      Object.keys(statusByEmail).forEach(function (email) {
        const e = entry(email);
        Object.keys(statusByEmail[email]).forEach(function (key) {
          const status = attendanceStatusKind(statusByEmail[email][key]);
          if (status === 'P') e.attendance++;
          else if (status === 'L') e.leaveDays[key] = true;
        });
      });
    }
  }

  sh = ss.getSheetByName(CONFIG.SHEETS.interviewLog);
  if (sh) {
    const data = sh.getDataRange().getValues();
    const counters = {};
    for (let i = 1; i < data.length; i++) {
      const email = String(data[i][1] || '').trim().toLowerCase();
      const e = entry(email);
      if (!e) continue;
      counters[email] = Math.max(counters[email] || 0, Number(data[i][4]) || 0);
      const serial = Number(data[i][4]) || (counters[email] = (counters[email] || 0) + 1);
      const key = inRange(data[i][0]);
      if (key) e.interviews++;
      if (includeHistory && wanted) {
        e.interviewHistory.push({
          serial: serial, loggedDate: normalizeSheetDate(data[i][0]), company: String(data[i][3] || ''),
          interviewDate: String(data[i][5] || ''), role: String(data[i][6] || ''),
          details: String(data[i][7] || '').slice(0, 500), messageUrl: String(data[i][8] || ''),
        });
      }
    }
  }

  sh = ss.getSheetByName(CONFIG.SHEETS.outreachDaily);
  if (sh) {
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const e = entry(data[i][1]);
      const key = inRange(data[i][0]);
      if (e && key) {
        e.outreach++;
        e.outreachDays[key] = (e.outreachDays[key] || 0) + 1;
      }
    }
  }

  sh = ss.getSheetByName(CONFIG.SHEETS.workshopAtt);
  if (sh) {
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const e = entry(data[i][2]);
      const key = inRange(data[i][0]);
      if (e && key) {
        e.workshops++;
        e.workshopDays[key] = (e.workshopDays[key] || 0) + 1;
      }
    }
  }

  sh = ss.getSheetByName(CONFIG.SHEETS.scores);
  if (sh) {
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const e = entry(data[i][1]);
      const key = inRange(data[i][0]);
      if (!e || !key) continue;
      e.questionAnswers++;
      e.questionScore += Number(data[i][5]) || 0;
      if (/communication|english|speaking|soft\s*skill/i.test(String(data[i][3] || ''))) {
        e.communicationPractices++;
        e.communicationDays[key] = (e.communicationDays[key] || 0) + 1;
      }
    }
  }

  const out = Object.keys(students).map(function (email) {
    const e = students[email];
    e.questionScore = Math.round(e.questionScore * 10) / 10;
    if (e.interviewHistory.length > 50) e.interviewHistory = e.interviewHistory.slice(-50);
    return e;
  });
  out.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return { version: VERSION, cohort: CONFIG.COHORT, start: range.start, end: range.end, students: out };
}

// ============================================================
//  RIGHT-TO-BE-REFERRED combined score (rolling N days)
//  questions: raw score sum
//  interviews: 15 pts each
//  jobs: per day min(c,target)/target*10 (+2 if c>target); target-aware streak
//        days ending today: +3/day capped 15
//  workshop: 4 pts per attended session
// ============================================================
function computeRtbr(days, jobTarget) {
  days = Math.max(1, Math.min(90, Number(days) || 7));
  jobTarget = Math.max(1, Math.min(100, Number(jobTarget) || 15));
  const todayKey = todayStr();
  const cutoffDate = new Date(todayKey + 'T12:00:00');
  cutoffDate.setDate(cutoffDate.getDate() - (days - 1));
  const cutoffKey = Utilities.formatDate(cutoffDate, CONFIG.TZ, 'yyyy-MM-dd');
  function inWindow(value) {
    // getValues() returns real Date objects for formatted Sheet date cells.
    // Appending T00:00:00 to String(Date) made every such RTBR row invalid.
    const key = normalizeSheetDate(value);
    return /^\d{4}-\d{2}-\d{2}$/.test(key) && key >= cutoffKey && key <= todayKey;
  }
  const students = {};
  function ent(email, name) {
    email = normalizeStudentEmail(email);
    if (!email) return null;
    return students[email] || (students[email] = {
      email: email, name: name || '', questions: 0, interviews: 0,
      interviewCount: 0, jobPts: 0, jobApplications: 0,
      streak: 0, workshop: 0, workshopCount: 0, jobDays: {} });
  }

  const ss = getSpreadsheet();
  const roster = readBotMap();
  for (const student of roster) {
    if (student.active === false || student.status === 'hired' || student.status === 'left') continue;
    const seeded = ent(student.email, student.name);
    if (seeded) seeded.discordId = student.discordId;
  }
  // questions
  let sh = ss.getSheetByName(CONFIG.SHEETS.scores);
  if (sh) {
    const d = sh.getDataRange().getValues();
    for (let i = 1; i < d.length; i++) {
      if (!inWindow(d[i][0])) continue;
      const e = ent(d[i][1], d[i][2]);
      if (!e) continue;
      e.questions += Number(d[i][5]) || 0;
    }
  }
  // interviews
  sh = ss.getSheetByName(CONFIG.SHEETS.interviewLog);
  if (sh) {
    const d = sh.getDataRange().getValues();
    for (let i = 1; i < d.length; i++) {
      if (!inWindow(d[i][0])) continue;
      const e = ent(d[i][1], d[i][2]);
      if (!e) continue;
      e.interviewCount++;
      e.interviews += 15;
    }
  }
  // jobs daily
  sh = ss.getSheetByName(CONFIG.SHEETS.jobsDaily);
  if (sh) {
    const d = sh.getDataRange().getValues();
    for (let i = 1; i < d.length; i++) {
      if (!inWindow(d[i][0])) continue;
      const e = ent(d[i][1], '');
      if (!e) continue;
      const c = Number(d[i][2]) || 0;
      const key = normalizeSheetDate(d[i][0]);
      e.jobPts += Math.min(c, jobTarget) / jobTarget * 10 + (c > jobTarget ? 2 : 0);
      e.jobApplications += c;
      e.jobDays[key] = c;
    }
  }
  // streaks (consecutive days reaching the configured target ending today/yesterday)
  for (const k in students) {
    const e = students[k];
    let streak = 0;
    for (let i = 0; i < days; i++) {
      const d = new Date(todayStr() + 'T00:00:00');
      d.setDate(d.getDate() - i);
      const key = Utilities.formatDate(d, CONFIG.TZ, 'yyyy-MM-dd');
      if ((e.jobDays[key] || 0) >= jobTarget) streak++;
      else if (i > 0) break; // allow today to be incomplete
    }
    e.streak = Math.min(streak * 3, 15);
  }
  // workshop attendance
  sh = ss.getSheetByName(CONFIG.SHEETS.workshopAtt);
  if (sh) {
    const d = sh.getDataRange().getValues();
    for (let i = 1; i < d.length; i++) {
      if (!inWindow(d[i][0])) continue;
      const e = ent(d[i][2], d[i][3]);
      if (!e) continue;
      e.workshopCount++;
      e.workshop += 4;
    }
  }

  // enrich names + drop hired/left
  const map = {};
  for (const s of roster) map[s.email] = s;
  const out = [];
  for (const k in students) {
    const e = students[k];
    const bm = map[k];
    if (bm && (bm.active === false || bm.status === 'hired' || bm.status === 'left')) continue;
    if (bm) { e.name = bm.name; e.discordId = bm.discordId; }
    e.total = Math.round((e.questions + e.interviews + e.jobPts + e.streak + e.workshop) * 10) / 10;
    e.jobPts = Math.round(e.jobPts * 10) / 10;
    delete e.jobDays;
    out.push(e);
  }
  out.sort(function (a, b) { return b.total - a.total; });
  return { days: days, jobTarget: jobTarget, students: out };
}

// ============================================================
//  RESOURCES - next unposted resource for the new server
// ============================================================
function nextResource() {
  return withScriptLock(function () {
    const sh = ensureTab(CONFIG.SHEETS.resources, ['Date','Content','Attachments','Posted In New Server']);
    const d = sh.getDataRange().getValues();
    for (let i = 1; i < d.length; i++) {
      if (String(d[i][3]).trim()) continue;
      sh.getRange(i + 1, 4).setValue(todayStr());
      return { content: String(d[i][1]), attachments: String(d[i][2]).split(' ').filter(String), date: String(d[i][0]) };
    }
    return { error: 'no unposted resources' };
  });
}

function saveResources(items) {
  return withScriptLock(function () {
    const headers = ['Date','Content','Attachments','Posted In New Server','Source Message ID'];
    const sh = ensureTab(CONFIG.SHEETS.resources, headers);
    if (sh.getMaxColumns() < headers.length) {
      sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
    }
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    const data = sh.getDataRange().getValues();
    const existingIds = {};
    const legacy = {};
    for (let i = 1; i < data.length; i++) {
      const sourceId = normalizeDiscordId(data[i][4]);
      if (sourceId) existingIds[sourceId] = true;
      legacy[[String(data[i][0]), String(data[i][1]), String(data[i][2])].join('|')] = true;
    }
    const rows = [];
    let duplicates = 0;
    for (const item of (items || []).slice(0, 500)) {
      const sourceId = normalizeDiscordId(item.sourceMessageId);
      const date = item.date || '';
      const content = String(item.content || '').slice(0, 40000);
      const attachments = (item.attachments || []).join(' ');
      const legacyKey = [String(date), content, attachments].join('|');
      if ((sourceId && existingIds[sourceId]) || (!sourceId && legacy[legacyKey])) { duplicates++; continue; }
      rows.push([date, content, attachments, '', sourceId ? "'" + sourceId : '']);
      if (sourceId) existingIds[sourceId] = true;
      legacy[legacyKey] = true;
    }
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
    return { saved: rows.length, duplicates: duplicates };
  });
}

// ============================================================
//  JOB APPLICATION TRACKERS
//  Job_Sheets: Email | Name | Sheet ID | Link Updated | GID
//  One row per student; latest posted link wins.
// ============================================================
function ensureJobSheets() {
  const ss = getSpreadsheet();
  let sh = ss.getSheetByName(CONFIG.SHEETS.jobSheets);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.SHEETS.jobSheets);
    sh.appendRow(['Email', 'Name', 'Sheet ID', 'Link Updated', 'GID']);
    sh.setFrozenRows(1);
  }
  if (String(sh.getRange(1, 5).getValue()).trim() !== 'GID') {
    sh.getRange(1, 5).setValue('GID'); // upgrade v19 sheets without losing rows
  }
  sh.getRange(1, 5).setNote(
    'DEFAULT means the posted link had no gid and the checker uses the first visible tracker tab. ' +
    'A numeric GID is saved when the posted link includes #gid=... .');
  if (sh.getLastRow() > 1) {
    const rowCount = sh.getLastRow() - 1;
    const sheetIds = sh.getRange(2, 3, rowCount, 1).getValues();
    const gids = sh.getRange(2, 5, rowCount, 1).getValues();
    const blankGidCells = [];
    for (let i = 0; i < rowCount; i++) {
      if (String(sheetIds[i][0] || '').trim() && !String(gids[i][0] || '').trim()) {
        blankGidCells.push('E' + (i + 2));
      }
    }
    if (blankGidCells.length) sh.getRangeList(blankGidCells).setValue('DEFAULT');
  }
  return sh;
}

function jobSnapshotKey(email) {
  return JOB_SNAPSHOT_PREFIX + Utilities.base64EncodeWebSafe(String(email || '').trim().toLowerCase()).replace(/=+$/, '');
}

function clearJobSnapshot(email) {
  if (email) PropertiesService.getScriptProperties().deleteProperty(jobSnapshotKey(email));
}

function saveJobSheet(email, sheetId, gid) {
  email = String(email || '').trim().toLowerCase();
  sheetId = String(sheetId || '').trim();
  gid = String(gid || '').replace(/\D/g, '');
  const gidDisplay = gid || 'DEFAULT';
  if (!email || !sheetId) return { error: 'missing email or sheetId' };
  const sh = ensureJobSheets();
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === email) {
      const oldSheetId = String(data[i][2] || '').trim();
      const oldGid = String(data[i][4] || '').replace(/\D/g, '');
      sh.getRange(i + 1, 3).setValue(sheetId);
      sh.getRange(i + 1, 4).setValue(todayStr());
      sh.getRange(i + 1, 5).setValue(gidDisplay);
      if (oldSheetId !== sheetId || oldGid !== gid) clearJobSnapshot(email);
      return { updated: email };
    }
  }
  const s = readBotMap().find(function (x) { return x.email === email; });
  sh.appendRow([email, s ? s.name : '', sheetId, todayStr(), gidDisplay]);
  return { created: email };
}

function readJobSheets() {
  const sh = ensureJobSheets();
  const data = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const email = String(data[i][0]).trim().toLowerCase();
    const sheetId = String(data[i][2]).trim();
    if (email && sheetId) out.push({
      email: email,
      name: String(data[i][1]),
      sheetId: sheetId,
      gid: data[i].length > 4 ? String(data[i][4]).replace(/\D/g, '') : '',
    });
  }
  return out;
}

function excludedDiscordIds(guildId) {
  const raw = PropertiesService.getScriptProperties().getProperty('ST_excl_' + String(guildId || '')) || '';
  return raw.split(',').map(function (id) { return String(id).trim(); }).filter(Boolean);
}

// One read bundle for the nightly check and private audit. Keeping roster,
// tracker, contact, exclusion, and saved-count reads inside one execution
// prevents a supervisor audit from opening several Apps Script executions at
// the same time.
function getJobAuditBundle(dateStr, guildId) {
  const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '')) ? String(dateStr) : todayStr();
  const contacts = readAllData().map(function (student) {
    return { email: student.email, phone: student.phone || '' };
  });
  const saved = [];
  const sh = getSpreadsheet().getSheetByName(CONFIG.SHEETS.jobsDaily);
  if (sh) {
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (normalizeSheetDate(data[i][0]) !== dateKey) continue;
      const email = String(data[i][1] || '').trim().toLowerCase();
      if (email) saved.push({ email: email, count: Number(data[i][2]) || 0 });
    }
  }
  return {
    version: VERSION,
    date: dateKey,
    roster: readBotMap(),
    sheets: readJobSheets(),
    contacts: contacts,
    saved: saved,
    excludedIds: excludedDiscordIds(guildId),
  };
}

function withScriptLock(work) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return work(); }
  finally { lock.releaseLock(); }
}

function ensureJobsDailySchema() {
  const sh = ensureTab(CONFIG.SHEETS.jobsDaily, ['Date','Email','Count','Name']);
  if (String(sh.getRange(1, 4).getValue()).trim() !== 'Name') sh.getRange(1, 4).setValue('Name');
  if (sh.getLastRow() < 2) return sh;

  const names = {};
  for (const s of readBotMap()) names[s.email] = s.name;
  const data = sh.getDataRange().getValues();
  const values = [];
  let changed = false;
  for (let i = 1; i < data.length; i++) {
    const email = String(data[i][1] || '').trim().toLowerCase();
    const current = String(data[i][3] || '').trim();
    const name = current || names[email] || '';
    values.push([name]);
    if (name !== current) changed = true;
  }
  if (changed && values.length) sh.getRange(2, 4, values.length, 1).setValues(values);
  return sh;
}

function ensureInterviewLogSchema() {
  const headers = ['Date','Email','Name','Company','Serial','Interview Date','Role','Details','Discord Message','Logged At','Discord Message ID','Event Index'];
  const sh = ensureTab(CONFIG.SHEETS.interviewLog, headers);
  if (sh.getMaxColumns() < headers.length) {
    sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
  }
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (sh.getLastRow() < 2) return sh;

  const data = sh.getDataRange().getValues();
  const counters = {};
  const serials = [];
  let changed = false;
  for (let i = 1; i < data.length; i++) {
    const email = String(data[i][1] || '').trim().toLowerCase();
    if (!email) { serials.push([data[i][4] || '']); continue; }
    const existing = Number(data[i][4]) || 0;
    if (existing > 0) counters[email] = Math.max(counters[email] || 0, existing);
    else {
      counters[email] = (counters[email] || 0) + 1;
      changed = true;
    }
    serials.push([existing || counters[email]]);
  }
  if (changed && serials.length) sh.getRange(2, 5, serials.length, 1).setValues(serials);
  return sh;
}

function syncInterviewMatrixDate(dateStr, guildId) {
  const dateKey = normalizeSheetDate(dateStr);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw new Error('Interview matrix requires a valid logged date');
  }
  ensureTab(CONFIG.SHEETS.interviewMatrix, ['Name', 'Email', 'Phone']);
  const log = ensureInterviewLogSchema();
  const data = log.getDataRange().getValues();
  const counts = {};
  for (let i = 1; i < data.length; i++) {
    if (normalizeSheetDate(data[i][0]) !== dateKey) continue;
    const email = normalizeStudentEmail(data[i][1]);
    if (email) counts[email] = (counts[email] || 0) + 1;
  }
  return syncTrackingMatrixCounts(
    CONFIG.SHEETS.interviewMatrix, dateKey, counts, true, guildId, false);
}

function logInterviews(body) {
  return withScriptLock(function () {
    const sh = ensureInterviewLogSchema();
    const email = String(body.email || '').trim().toLowerCase();
    if (!email) return { error: 'missing email' };
    const messageId = normalizeDiscordId(body.messageId);
    const messageUrl = String(body.messageUrl || '').trim().slice(0, 1000);
    const data = sh.getDataRange().getValues();
    let serial = 0;
    let messagePreviouslySeen = false;
    const rowByEvent = {};
    for (let i = 1; i < data.length; i++) {
      const rowEmail = String(data[i][1] || '').trim().toLowerCase();
      if (rowEmail === email) serial = Math.max(serial, Number(data[i][4]) || 0);
      const rowMessageId = normalizeDiscordId(data[i][10]);
      const rowMessageUrl = String(data[i][8] || '').trim();
      const sameMessage = (messageId && rowMessageId === messageId) ||
        (!messageId && messageUrl && rowMessageUrl === messageUrl) ||
        (messageId && !rowMessageId && messageUrl && rowMessageUrl === messageUrl);
      if (rowEmail === email && sameMessage) {
        messagePreviouslySeen = true;
        const eventIndex = Math.max(0, Number(data[i][11]) || 0);
        if (rowByEvent[eventIndex] === undefined) rowByEvent[eventIndex] = i + 1;
      }
    }

    const events = Array.isArray(body.interviews) ? body.interviews.slice(0, 10) : [body];
    let created = 0, updated = 0, duplicates = 0;
    const serials = [];
    for (let index = 0; index < events.length; index++) {
      const event = events[index] || {};
      const eventIndex = Math.max(0, Number(event.eventIndex) || index);
      const company = String(event.company || '').trim().slice(0, 300);
      const interviewDate = String(event.interviewDate || '').trim().slice(0, 100);
      const role = String(event.role || '').trim().slice(0, 300);
      const details = String(event.details || '').slice(0, 1500);
      const existingRow = rowByEvent[eventIndex];
      if (existingRow) {
        const current = sh.getRange(existingRow, 1, 1, 12).getValues()[0];
        const next = [
          body.date || current[0] || todayStr(), email, body.name || current[2] || '', company,
          current[4] || '', interviewDate, role, details, messageUrl || current[8] || '',
          current[9] || new Date(), messageId ? "'" + messageId : current[10] || '', eventIndex,
        ];
        if (JSON.stringify(current.slice(0, 9)) !== JSON.stringify(next.slice(0, 9)) ||
            normalizeDiscordId(current[10]) !== messageId || Number(current[11] || 0) !== eventIndex) {
          sh.getRange(existingRow, 1, 1, 12).setValues([next]);
          updated++;
        } else duplicates++;
        serials.push(Number(current[4]) || 0);
        continue;
      }
      serial++;
      sh.appendRow([
        body.date || todayStr(), email, body.name || '', company, serial,
        interviewDate, role, details, messageUrl, new Date(),
        messageId ? "'" + messageId : '', eventIndex,
      ]);
      rowByEvent[eventIndex] = sh.getLastRow();
      serials.push(serial);
      created++;
    }
    const matrix = syncInterviewMatrixDate(body.date || todayStr(), body.guildId || '');
    return {
      logged: created > 0,
      created: created,
      updated: updated,
      duplicates: duplicates,
      messagePreviouslySeen: messagePreviouslySeen,
      serials: serials,
      matrix: matrix,
    };
  });
}

function logInterview(body) {
  const copy = Object.assign({}, body);
  copy.interviews = [{
    eventIndex: Number(body.eventIndex) || 0,
    company: body.company || '',
    interviewDate: body.interviewDate || '',
    role: body.role || '',
    details: body.details || '',
  }];
  return logInterviews(copy);
}

// Bulk history reconciliation uses immutable Discord message ID + event index.
// It updates edited source messages, appends genuinely missing events in one
// range write, and then rebuilds Interview Updates from authoritative log rows.
function backfillInterviews(entries, guildId) {
  const write = withScriptLock(function () {
    const sh = ensureInterviewLogSchema();
    const data = sh.getDataRange().getValues();
    const rowByKey = {};
    const serialByEmail = {};
    for (let i = 1; i < data.length; i++) {
      const email = normalizeStudentEmail(data[i][1]);
      const messageId = normalizeDiscordId(data[i][10]);
      const eventIndex = Math.max(0, Number(data[i][11]) || 0);
      if (email) serialByEmail[email] = Math.max(serialByEmail[email] || 0, Number(data[i][4]) || 0);
      if (email && messageId) rowByKey[email + '|' + messageId + '|' + eventIndex] = i + 1;
    }

    const additions = [];
    const updates = [];
    const seenPayload = {};
    let duplicates = 0;
    for (const entry of (entries || []).slice(0, 100)) {
      const email = normalizeStudentEmail(entry.email);
      const messageId = normalizeDiscordId(entry.messageId);
      if (!email || !messageId) continue;
      const messageUrl = String(entry.messageUrl || '').trim().slice(0, 1000);
      const loggedDate = normalizeSheetDate(entry.date) || todayStr();
      const parsedLoggedAt = new Date(entry.loggedAt || '');
      const loggedAt = isNaN(parsedLoggedAt.getTime()) ? new Date() : parsedLoggedAt;
      const events = Array.isArray(entry.interviews) ? entry.interviews.slice(0, 10) : [];
      for (let index = 0; index < events.length; index++) {
        const event = events[index] || {};
        const eventIndex = Math.max(0, Number(event.eventIndex) || index);
        const key = email + '|' + messageId + '|' + eventIndex;
        if (seenPayload[key]) { duplicates++; continue; }
        seenPayload[key] = true;
        const existingRow = rowByKey[key];
        const current = existingRow ? sh.getRange(existingRow, 1, 1, 12).getValues()[0] : null;
        const serial = current
          ? (Number(current[4]) || 0)
          : ((serialByEmail[email] || 0) + 1);
        if (!current) serialByEmail[email] = serial;
        const next = [
          current && normalizeSheetDate(current[0]) === loggedDate ? current[0] : loggedDate,
          current && normalizeStudentEmail(current[1]) === email ? current[1] : email,
          String(entry.name || (current && current[2]) || '').trim().slice(0, 300),
          String(event.company || '').trim().slice(0, 300),
          serial,
          String(event.interviewDate || '').trim().slice(0, 100),
          String(event.role || '').trim().slice(0, 300),
          String(event.details || '').slice(0, 1500),
          messageUrl || (current && current[8]) || '',
          current && current[9] ? current[9] : loggedAt,
          current && normalizeDiscordId(current[10]) === messageId ? current[10] : "'" + messageId,
          eventIndex,
        ];
        if (!current) {
          additions.push(next);
          rowByKey[key] = data.length + additions.length;
        } else if (JSON.stringify(current.map(String)) !== JSON.stringify(next.map(String))) {
          updates.push({ row: existingRow, values: next });
        } else duplicates++;
      }
    }
    updates.forEach(function (item) {
      sh.getRange(item.row, 1, 1, 12).setValues([item.values]);
    });
    if (additions.length) {
      sh.getRange(sh.getLastRow() + 1, 1, additions.length, 12).setValues(additions);
    }
    return { created: additions.length, updated: updates.length, duplicates: duplicates };
  });
  const repaired = repairInterviewDuplicates(guildId || '');
  write.matrix = repaired.matrix;
  write.remaining = repaired.remaining;
  write.removed = repaired.removed;
  return write;
}

function repairInterviewDuplicates(guildId) {
  return withScriptLock(function () {
    const sh = ensureInterviewLogSchema();
    const data = sh.getDataRange().getValues();
    const seen = {};
    const remove = [];
    for (let i = 1; i < data.length; i++) {
      const email = String(data[i][1] || '').trim().toLowerCase();
      const messageId = normalizeDiscordId(data[i][10]);
      const eventIndex = Math.max(0, Number(data[i][11]) || 0);
      const messageUrl = String(data[i][8] || '').trim();
      let key = '';
      if (email && messageId) key = 'id|' + email + '|' + messageId + '|' + eventIndex;
      else if (email && messageUrl) key = [
        'legacy', email, messageUrl,
        String(data[i][3] || '').trim().toLowerCase(),
        String(data[i][5] || '').trim().toLowerCase(),
        String(data[i][6] || '').trim().toLowerCase(),
        String(data[i][7] || '').trim().toLowerCase(),
      ].join('|');
      if (!key) continue;
      if (seen[key]) remove.push(i + 1);
      else seen[key] = i + 1;
    }
    remove.sort(function (a, b) { return b - a; }).forEach(function (row) { sh.deleteRow(row); });

    const remaining = sh.getDataRange().getValues();
    const counters = {};
    const serials = [];
    for (let i = 1; i < remaining.length; i++) {
      const email = String(remaining[i][1] || '').trim().toLowerCase();
      if (!email) { serials.push(['']); continue; }
      counters[email] = (counters[email] || 0) + 1;
      serials.push([counters[email]]);
    }
    if (serials.length) sh.getRange(2, 5, serials.length, 1).setValues(serials);
    const matrix = rebuildTrackingMatrix(
      CONFIG.SHEETS.interviewMatrix, 'interviews', 'existing', trackingStudents());
    matrix.statusStyles = refreshStatusOnlyMatrixRows(CONFIG.SHEETS.interviewMatrix, guildId);
    return {
      scanned: Math.max(0, data.length - 1),
      removed: remove.length,
      remaining: Math.max(0, remaining.length - 1),
      matrix: matrix,
    };
  });
}

// One authoritative count per date+student. Manual checks and the scheduled
// check may run on the same date; updating prevents duplicate RTBR points.
function saveJobCounts(dateStr, entries, guildId) {
  return withScriptLock(function () {
    const sh = ensureJobsDailySchema();
    const names = {};
    for (const s of readBotMap()) names[s.email] = s.name;
    const data = sh.getDataRange().getValues();
    const rowByKey = {};
    for (let i = 1; i < data.length; i++) {
      const key = String(data[i][0]).trim() + '|' + String(data[i][1]).trim().toLowerCase();
      if (key !== '|') rowByKey[key] = i + 1;
    }

    const unique = {};
    for (const entry of (entries || [])) {
      const email = String(entry.email || '').trim().toLowerCase();
      if (email) unique[email] = Number(entry.count) || 0;
    }
    const additions = [];
    let updated = 0;
    for (const email in unique) {
      const key = dateStr + '|' + email;
      const row = rowByKey[key];
      if (row) {
        sh.getRange(row, 3, 1, 2).setValues([[unique[email], names[email] || '']]);
        updated++;
      } else {
        additions.push([dateStr, email, unique[email], names[email] || '']);
      }
    }
    if (additions.length) sh.getRange(sh.getLastRow() + 1, 1, additions.length, 4).setValues(additions);
    const matrix = syncTrackingMatrixCounts(
      CONFIG.SHEETS.jobsMatrix, dateStr, unique, false, guildId);
    return {
      saved: Object.keys(unique).length,
      created: additions.length,
      updated: updated,
      matrix: matrix,
    };
  });
}

// Durable bot-owned tracker versioning. Google Drive revision metadata is
// file-level and cannot say which application row belongs to which day. For a
// recognizable application table without a date column, the nightly bot sends
// the current application-row total here. We atomically compare it with the
// previous successful observation and return the non-negative daily delta.
function saveJobSnapshots(dateStr, entries) {
  return withScriptLock(function () {
    dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '')) ? String(dateStr) : todayStr();
    const props = PropertiesService.getScriptProperties();
    const updates = {};
    const results = [];
    for (const item of (entries || []).slice(0, 500)) {
      const email = String(item.email || '').trim().toLowerCase();
      const sheetId = String(item.sheetId || '').trim();
      const gid = String(item.gid || '').replace(/\D/g, '');
      const rowCount = Math.max(0, Math.floor(Number(item.rowCount) || 0));
      if (!email || !sheetId) continue;
      const key = jobSnapshotKey(email);
      let previous = {};
      try { previous = JSON.parse(props.getProperty(key) || '{}'); }
      catch (e) { previous = {}; }
      const sameTracker = previous.sheetId === sheetId && String(previous.gid || '') === gid;
      const baseline = !sameTracker || !Number.isFinite(Number(previous.rowCount));
      const baseRowCount = baseline ? rowCount :
        previous.date === dateStr ? Math.max(0, Number(previous.baseRowCount) || 0) : Math.max(0, Number(previous.rowCount) || 0);
      const count = baseline ? 0 : Math.max(0, rowCount - baseRowCount);
      updates[key] = JSON.stringify({
        sheetId: sheetId, gid: gid, date: dateStr,
        baseRowCount: baseRowCount, rowCount: rowCount, checkedAt: new Date().toISOString(),
      });
      results.push({ email: email, count: count, baseline: baseline, rowCount: rowCount });
    }
    if (Object.keys(updates).length) props.setProperties(updates, false);
    return { saved: results.length, results: results };
  });
}

// A member earns workshop points once per date+slot. Reprocessing the same
// poll is therefore safe and does not inflate RTBR.
function saveWorkshopAttendance(dateStr, slot, entries) {
  return withScriptLock(function () {
    const sh = ensureTab(CONFIG.SHEETS.workshopAtt, ['Date','Slot','Email','Name']);
    const data = sh.getDataRange().getValues();
    const existing = {};
    for (let i = 1; i < data.length; i++) {
      existing[String(data[i][0]).trim() + '|' + String(data[i][1]).trim() + '|' + String(data[i][2]).trim().toLowerCase()] = true;
    }
    const rows = [];
    const seenPayload = {};
    for (const entry of (entries || [])) {
      const email = String(entry.email || '').trim().toLowerCase();
      const key = dateStr + '|' + slot + '|' + email;
      if (!email || existing[key] || seenPayload[key]) continue;
      seenPayload[key] = true;
      rows.push([dateStr, slot, email, entry.name || '']);
    }
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, 4).setValues(rows);
    return { saved: rows.length, duplicatesSkipped: (entries || []).length - rows.length };
  });
}

// ============================================================
//  FORM CREATION - build enrollment + daily attendance forms and
//  bind their responses to THIS spreadsheet. One command setup.
// ============================================================
// spec accepts legacy arrays or durable form definitions:
// { enrollment: { title, description, collectEmail, fields: [...] }, attendance: {...} }
// type: text | paragraph | choice | checkbox | scale | date | time | email
function addItem(form, f) {
  var type = String(f.type || 'text').toLowerCase();
  var item;
  if (type === 'paragraph') item = form.addParagraphTextItem();
  else if (type === 'choice') item = form.addMultipleChoiceItem().setChoiceValues(f.choices || ['Yes', 'No']);
  else if (type === 'checkbox') item = form.addCheckboxItem().setChoiceValues(f.choices || ['Yes']);
  else if (type === 'scale') {
    item = form.addScaleItem().setBounds(f.min || 1, f.max || 5);
    if (f.lowLabel || f.highLabel) item.setLabels(f.lowLabel || '', f.highLabel || '');
  }
  else if (type === 'date') item = form.addDateItem();
  else if (type === 'time') item = form.addTimeItem();
  else if (type === 'email') {
    item = form.addTextItem();
    item.setValidation(FormApp.createTextValidation().requireTextIsEmail().build());
  }
  else item = form.addTextItem();
  item.setTitle(f.title || 'Question');
  if (f.help) item.setHelpText(f.help);
  if (f.required && item.setRequired) item.setRequired(true);
  if (f.other && item.showOtherOption) item.showOtherOption(true);
  return item;
}

var DEFAULT_ENROLLMENT = [
  { key: 'name', title: 'Your Name (আপনার পূর্ণ নাম)', type: 'text', required: true },
  { key: 'enrollmentEmail', title: 'Email (যে ইমেইল দিয়ে কোর্সে এনরোল করেছেন)', type: 'email', required: true, help: 'Please use the same email as your course enrollment. এই ইমেইল দিয়েই আপনার Discord ও attendance record মিলানো হবে।' },
  { key: 'phone', title: 'WhatsApp Number (আপনার WhatsApp নম্বর)', type: 'text', required: true, help: 'Include country code when possible, for example +8801XXXXXXXXX.' },
  { key: 'region', title: 'Current Region (Division) — আপনি বর্তমানে কোন বিভাগ বা দেশে আছেন?', type: 'choice', required: true, choices: ['Dhaka','Chattogram','Rajshahi','Khulna','Barishal','Sylhet','Rangpur','Mymensingh','Abroad'], other: true },
  { key: 'subregion', title: 'Current Dhaka Area — আপনি ঢাকার কোন এলাকায় থাকেন?', type: 'choice', required: false, choices: ['Mirpur','Mohammadpur','Gazipur','Savar','Uttara','Khilgaon','Banasree','Rampura','Jatrabari','Dhanmondi','Gulshan','Banani','Motijheel','Old Dhaka','Other Dhaka'], help: 'Answer only when Dhaka is selected. The web intake makes this conditional and required for Dhaka.' },
  { key: 'genderPreference', title: 'Gender (kept private; never shown as a Discord role)', type: 'choice', required: true, choices: ['Female','Male','Prefer not to say'] },
  { key: 'studyStage', title: 'Current study stage', type: 'choice', required: true, choices: ['Graduated / not currently studying','University final year','University 1st–3rd year','College / HSC / board exams','School','Other'] },
  { key: 'availability', title: 'Current job-search availability', type: 'choice', required: true, choices: ['Full-time job ready now','Searching, but limited availability','Not job searching — study first'] },
  { key: 'jobFocus', title: 'Job Focus / Job preference (আপনার জব প্রেফারেন্স)', type: 'choice', required: true, choices: ['Remote','Onsite','Hybrid (Remote বা Onsite—দুইটিতেই আগ্রহী)'] },
  { key: 'onsiteAreas', title: 'অনসাইটে জব করতে ইচ্ছুক হলে কোন এরিয়াতে করবেন?', type: 'paragraph', help: 'Example: Dhaka, Chattogram, Sylhet. Remote-only হলে N/A লিখুন।' },
  { key: 'remoteReason', title: 'যদি Remote job focused হন, তার কারণ বিস্তারিত লিখুন। Onsite/Hybrid হলে N/A লিখুন।', type: 'paragraph', required: true },
  { key: 'education', title: 'আপনার বর্তমান শিক্ষাগত ব্যাকগ্রাউন্ড', type: 'choice', required: true, choices: ['CSE — Student','CSE — Graduate','Non-CSE — Student','Non-CSE — Graduate','HSC','Diploma'], other: true },
  { key: 'englishCommunication', title: 'আপনার English communication skill-এ নিজেকে কত দিবেন?', type: 'scale', required: true, min: 1, max: 5, lowLabel: 'Basic', highLabel: 'Expert' },
  { key: 'experience', title: 'Experience (আপনার experience level)', type: 'choice', required: true, choices: ['Fresher','Experienced'] },
  { key: 'jobHolder', title: 'Currently Job Holder? (আপনি কি বর্তমানে কোনো চাকরি করছেন?)', type: 'choice', required: true, choices: ['Yes','No'] },
  { key: 'nextExam', title: 'আপনার next exam-এর সম্ভাব্য date কবে?', type: 'text', required: true, help: 'Example: April, next month, specific date, অথবা পরীক্ষা নেই।' },
  { key: 'jobMotivation', title: 'আপনি বর্তমানে কেন job করতে ইচ্ছুক?', type: 'paragraph', required: true },
  { key: 'resume', title: 'আপনার Resume link', type: 'text', required: true, help: 'Google Drive link হলে “Anyone with the link — Viewer” access দিন।' },
  { key: 'linkedin', title: 'আপনার LinkedIn link', type: 'text', required: true },
  { key: 'linkedinRestricted', title: 'আপনার LinkedIn account কি restricted?', type: 'choice', required: true, choices: ['No','Yes'] },
  { key: 'github', title: 'আপনার GitHub link', type: 'text', required: true },
  { key: 'portfolio', title: 'আপনার Portfolio link', type: 'text', help: 'Portfolio না থাকলে N/A লিখতে পারেন।' },
  { key: 'bestProject', title: 'Best project link (আপনার সেরা project)', type: 'text', required: true },
  { key: 'technologies', title: 'আপনার সত্যিকারের production-ready skills নির্বাচন করুন (একাধিক নির্বাচন করা যাবে)', type: 'checkbox', required: true, choices: ['Laravel','Shopify','React Native','WordPress / Elementor','UI / UX','Flutter','PostgreSQL','Prisma','Django','Python','C++','Linux','DevOps','n8n','AI Engineering','AI Agents','Machine Learning','Data Science','Data Analytics','Networking','JavaScript','TypeScript','React.js','Node.js','Still learning / no production-ready skill yet'], other: true, help: 'Only select skills you can genuinely demonstrate. Do not claim a skill you have not learned.' },
  { key: 'positions', title: 'আপনি কোন কোন position-এ apply করতে চান?', type: 'checkbox', required: true, choices: ['Full Stack Developer','Frontend Developer','Backend Developer','Software Engineer'], other: true },
  { key: 'freeTimeSlots', title: 'দিনের কোন সময়ে আপনি minimum ১ ঘণ্টা free থাকেন?', type: 'checkbox', required: true, choices: ['সকাল ১১:০০ — ১:০০','দুপুর ৩:৩০ — ৫:০০','সন্ধ্যা ৭:০০ — ৯:০০'], other: true },
  { key: 'jobSeriousness', title: 'আপনার কি সত্যিই job দরকার এবং এই bootcamp নিয়ে serious?', type: 'choice', required: true, choices: ['হ্যাঁ—আমি নিয়মিত সময় দিতে ও task করতে প্রস্তুত','এখন খুব জরুরি নয়, তবে নিয়মিত continue করতে চাই','এখন job focus করতে পারব না / continue করতে চাই না'] },
  { key: 'specialReferral', title: 'Special referral পেতে আগ্রহী?', type: 'choice', required: true, choices: ['হ্যাঁ—আমি Discord resources দেখে resume, profile ও projects polish করছি','না / এখনো প্রস্তুত নই'] },
  { key: 'rulesCommitment', title: 'After entering Discord, will you read and follow the Rules, Resources and Job Hunting channels?', type: 'choice', required: true, choices: ['Yes — I will read and follow them','I need mentor guidance'] },
  { key: 'discordUsername', title: 'Discord Username (আপনার Discord username লিখুন)', type: 'text', required: true, help: 'Profile থেকে exact username copy করুন। Display name নয়; # tag প্রয়োজন নেই।' },
  { key: 'comments', title: 'আপনার কোনো মতামত, প্রশ্ন বা প্রয়োজনীয় support থাকলে লিখুন', type: 'paragraph' }
];
var DEFAULT_ATTENDANCE = [
  { key: 'attendanceDate', title: 'Date of attendance', type: 'date', required: true },
  { key: 'studentEmail', title: 'Student Email', type: 'email', required: true, help: 'Use the same email you submitted in the enrollment form.' },
  { key: 'experience', title: 'Experience', type: 'choice', required: true, choices: ['Fresher','Experienced'] },
  { key: 'jobHolder', title: 'Job Holder', type: 'choice', required: true, choices: ['Yes','No'] },
  { key: 'jobFocus', title: 'Job Focus', type: 'choice', required: true, choices: ['Hybrid','Remote','Onsite'] },
  { key: 'arrivalTime', title: 'Arrival Time', type: 'time', required: true },
  { key: 'mood', title: 'Overall Mood Today (1 = Very Poor, 5 = Excellent)', type: 'scale', required: true, min: 1, max: 5, lowLabel: 'Very Poor', highLabel: 'Excellent' },
  { key: 'interview', title: 'Faced Any Interview today?', type: 'choice', required: true, choices: ['Yes','No'] },
  { key: 'interviewShared', title: 'Shared Interview update on the Discord channel?', type: 'choice', required: true, choices: ['Yes','I will share right now','No interview faced today'] },
  { title: 'আজকের job preparation / application progress সংক্ষেপে লিখুন', type: 'paragraph' },
  { title: 'কোনো blocker বা mentor support প্রয়োজন হলে লিখুন', type: 'paragraph' }
];

function formDefinition(kind, cohortName, spec) {
  const defaults = kind === 'enrollment' ? DEFAULT_ENROLLMENT : DEFAULT_ATTENDANCE;
  const source = spec && spec[kind];
  const legacyFields = Array.isArray(source) ? source : null;
  const objectSource = source && !Array.isArray(source) ? source : {};
  const fields = legacyFields || (Array.isArray(objectSource.fields) ? objectSource.fields : defaults);
  const defaultTitle = kind === 'enrollment' ? '{cohort} Bootcamp Data Collection Form' : '{cohort} — Daily Attendance';
  const defaultDescription = kind === 'enrollment'
    ? 'Please fill out all details accurately for the bootcamp placement process.'
    : 'Please submit once during the daily attendance window.';
  return {
    title: String(objectSource.title || defaultTitle).replace(/\{cohort\}/gi, cohortName),
    description: String(objectSource.description === undefined ? defaultDescription : objectSource.description),
    collectEmail: objectSource.collectEmail !== false,
    fields: fields,
  };
}

function saveFormSchema(kind, fields) {
  const schema = {};
  (fields || []).forEach(function (field) {
    if (field.key && field.title) schema[String(field.key)] = String(field.title);
  });
  const key = kind === 'enrollment' ? PROPERTY_KEYS.enrollmentSchema : PROPERTY_KEYS.attendanceSchema;
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(schema));
}

function sheetIdSet(ss) {
  const ids = {};
  ss.getSheets().forEach(function (sheet) { ids[String(sheet.getSheetId())] = true; });
  return ids;
}

function waitForNewResponseSheet(ss, previousIds) {
  for (let attempt = 0; attempt < 8; attempt++) {
    SpreadsheetApp.flush();
    Utilities.sleep(500);
    const created = ss.getSheets().filter(function (sheet) { return !previousIds[String(sheet.getSheetId())]; });
    if (created.length) return created[created.length - 1];
  }
  return null;
}

function createCohortForms(cohortName, spec, requestedKinds) {
  validateConfig();
  const ss = getSpreadsheet();
  const ssId = ss.getId();
  const created = [];
  const props = PropertiesService.getScriptProperties();
  const kinds = Array.isArray(requestedKinds) && requestedKinds.length
    ? requestedKinds.map(String)
    : ['enrollment', 'attendance'];
  const createEnrollment = kinds.indexOf('enrollment') !== -1;
  const createAttendance = kinds.indexOf('attendance') !== -1;
  if (!createEnrollment && !createAttendance) throw new Error('Choose enrollment and/or attendance form creation');

  const enrollmentDef = formDefinition('enrollment', cohortName, spec);
  const attendanceDef = formDefinition('attendance', cohortName, spec);
  let enrollmentResponse = null;
  let attendanceResponse = null;

  // ---- 1. Enrollment form ----
  if (createEnrollment) {
    const ef = FormApp.create(enrollmentDef.title);
    ef.setDescription(enrollmentDef.description);
    ef.setCollectEmail(enrollmentDef.collectEmail);
    enrollmentDef.fields.forEach(function (f) { addItem(ef, f); });
    saveFormSchema('enrollment', enrollmentDef.fields);
    const beforeEnrollment = sheetIdSet(ss);
    ef.setDestination(FormApp.DestinationType.SPREADSHEET, ssId);
    enrollmentResponse = waitForNewResponseSheet(ss, beforeEnrollment);
    if (enrollmentResponse) props.setProperty(PROPERTY_KEYS.enrollmentSheet, enrollmentResponse.getName());
    created.push({
      type: 'enrollment', url: ef.getPublishedUrl(), editUrl: ef.getEditUrl(), id: ef.getId(),
      responseSheet: enrollmentResponse ? enrollmentResponse.getName() : '',
    });
  }

  // ---- 2. Daily attendance form ----
  if (createAttendance) {
    const df = FormApp.create(attendanceDef.title);
    df.setDescription(attendanceDef.description);
    df.setCollectEmail(attendanceDef.collectEmail);
    attendanceDef.fields.forEach(function (f) { addItem(df, f); });
    saveFormSchema('attendance', attendanceDef.fields);
    const beforeAttendance = sheetIdSet(ss);
    df.setDestination(FormApp.DestinationType.SPREADSHEET, ssId);
    attendanceResponse = waitForNewResponseSheet(ss, beforeAttendance);
    if (attendanceResponse) props.setProperty(PROPERTY_KEYS.attendanceSheet, attendanceResponse.getName());
    created.push({
      type: 'attendance', url: df.getPublishedUrl(), editUrl: df.getEditUrl(), id: df.getId(),
      responseSheet: attendanceResponse ? attendanceResponse.getName() : '',
    });

    // remember the attendance form id so open/close commands work
    props.setProperty(PROPERTY_KEYS.attendanceFormId, df.getId());
  }

  return { cohort: cohortName, forms: created,
    responseSheets: {
      enrollment: enrollmentResponse ? enrollmentResponse.getName() : responseSheetName('enrollment'),
      attendance: attendanceResponse ? attendanceResponse.getName() : responseSheetName('attendance'),
    },
    note: created.every(function (form) { return form.responseSheet; })
      ? 'Requested response tabs were detected and saved automatically. CONFIG.FORM_ID may remain blank.'
      : 'A requested response tab could not be detected automatically; register the response tab before collecting responses.' };
}

// Manual fallback if Google delays response-tab creation beyond the detection
// window. Run once in the editor with the exact two tab names.
function registerResponseSheets(enrollmentName, attendanceName) {
  const ss = getSpreadsheet();
  if (!ss.getSheetByName(enrollmentName)) throw new Error('Enrollment tab not found: ' + enrollmentName);
  if (!ss.getSheetByName(attendanceName)) throw new Error('Attendance response tab not found: ' + attendanceName);
  const props = PropertiesService.getScriptProperties();
  props.setProperty(PROPERTY_KEYS.enrollmentSheet, enrollmentName);
  props.setProperty(PROPERTY_KEYS.attendanceSheet, attendanceName);
  ensureBotMap();
  return { enrollment: enrollmentName, attendance: attendanceName };
}

// ============================================================
//  BANK CLEANUP - delete questions matching keywords (e.g. C#)
// ============================================================
function cleanBank(keywords) {
  const sh = ensureQuestionBank();
  const data = sh.getDataRange().getValues();
  const kws = (keywords.length ? keywords : ['c#', 'asp.net', '.net', 'dotnet', 'csharp'])
    .map(function (k) { return String(k).toLowerCase(); });
  let removed = 0;
  for (let i = data.length - 1; i >= 1; i--) { // bottom-up so indexes stay valid
    const text = (String(data[i][3]) + ' ' + String(data[i][4])).toLowerCase();
    if (kws.some(function (k) { return text.indexOf(k) !== -1; })) {
      sh.deleteRow(i + 1);
      removed++;
    }
  }
  return { removed: removed };
}

// ============================================================
//  QUESTION BANK + SCORING
//  Question_Bank: ID | Category | Difficulty | Question | Model Answer | Used On
//  Scores:        Date | Email | Name | Category | QuestionID | Score | Cheat
// ============================================================
function ensureQuestionBank() {
  const ss = getSpreadsheet();
  let sh = ss.getSheetByName(CONFIG.SHEETS.questionBank);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.SHEETS.questionBank);
    sh.appendRow(['ID', 'Category', 'Difficulty', 'Question', 'Model Answer', 'Used On']);
    sh.setFrozenRows(1);
  }
  return sh;
}

function ensureScores() {
  const ss = getSpreadsheet();
  let sh = ss.getSheetByName(CONFIG.SHEETS.scores);
  const headers = ['Date', 'Email', 'Name', 'Category', 'QuestionID', 'Score', 'Cheat',
    'Discord Question Message ID'];
  if (!sh) {
    sh = ss.insertSheet(CONFIG.SHEETS.scores);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  } else {
    if (sh.getMaxColumns() < headers.length) {
      sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
    }
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sh;
}

// Attendance gained a dedicated Remarks column in v46. Existing workbooks
// already have their first date in column G, so insert (never overwrite) G
// once and move every historical date/value/format one column to the right.
function ensureAttendanceSheet() {
  const sheet = ensureTab(CONFIG.SHEETS.matrix, ATTENDANCE_HEADERS);
  if (sheet.getMaxColumns() < ATTENDANCE_HEADERS.length) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(), ATTENDANCE_HEADERS.length - sheet.getMaxColumns());
  }
  const existing = sheet.getRange(
    1, 1, 1, Math.max(sheet.getLastColumn(), ATTENDANCE_HEADERS.length))
    .getDisplayValues()[0];
  const remarksHeader = String(existing[CONFIG.MATRIX.remarksCol - 1] || '').trim().toLowerCase();
  if (remarksHeader !== 'remarks') {
    const occupied = String(existing[CONFIG.MATRIX.remarksCol - 1] || '').trim() !== '';
    if (occupied) sheet.insertColumnBefore(CONFIG.MATRIX.remarksCol);
  }
  sheet.getRange(1, 1, 1, ATTENDANCE_HEADERS.length)
    .setValues([ATTENDANCE_HEADERS])
    .setFontWeight('bold')
    .setBackground('#d9eaf7');
  sheet.getRange(1, CONFIG.MATRIX.remarksCol).setNote(
    'Manual mentor remarks. Bot attendance checks and roster repairs preserve this column.');
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(3);
  sheet.setColumnWidth(CONFIG.MATRIX.remarksCol, 260);
  return sheet;
}

function addQuestions(questions) {
  const sh = ensureQuestionBank();
  const stamp = Date.now();
  const rows = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q.question || !q.answer) continue;
    rows.push(['Q' + stamp + '_' + i, String(q.category || 'general').toLowerCase(),
               String(q.difficulty || 'medium').toLowerCase(),
               String(q.question), String(q.answer), '']);
  }
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, 6).setValues(rows);
  return { added: rows.length };
}

// picks the first unused question of the category (empty category = any),
// marks it used, returns it
function nextQuestion(category) {
  return withScriptLock(function () {
    const sh = ensureQuestionBank();
    const data = sh.getDataRange().getValues();
    category = String(category || '').toLowerCase();

    // Collect all unused matching rows, then pick one at random. The lock
    // prevents two overlapping drops from claiming the same question.
    const candidates = [];
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][5]).trim()) continue;
      const cat = String(data[i][1]).trim().toLowerCase();
      if (category && cat !== category) continue;
      candidates.push(i);
    }
    if (!candidates.length) {
      return { error: 'no unused questions' + (category ? ' in category ' + category : '') };
    }
    const i = candidates[Math.floor(Math.random() * candidates.length)];
    sh.getRange(i + 1, 6).setValue(todayStr());
    return { id: String(data[i][0]), category: String(data[i][1]).trim().toLowerCase(),
             difficulty: String(data[i][2]), question: String(data[i][3]),
             modelAnswer: String(data[i][4]) };
  });
}

function logScore(body) {
  return withScriptLock(function () {
    const sh = ensureScores();
    const email = String(body.email || '').trim().toLowerCase();
    const qid = String(body.qid || '').trim();
    const messageId = String(body.messageId || '').trim();
    const row = [body.date || todayStr(), email, body.name || '', body.category || '', qid,
      Number(body.score) || 0, body.cheat ? 'YES' : '', messageId];
    if (email && (messageId || qid)) {
      const data = sh.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        const sameEmail = String(data[i][1] || '').trim().toLowerCase() === email;
        const existingMessageId = String(data[i][7] || '').trim();
        // New rows are keyed by the Discord question message. The date+qid
        // fallback protects legacy rows without preventing a future reuse of
        // the same question-bank entry.
        const sameEvent = messageId
          ? existingMessageId === messageId
          : String(data[i][0] || '') === String(row[0]) && String(data[i][4] || '').trim() === qid;
        if (sameEmail && sameEvent) {
          sh.getRange(i + 1, 1, 1, 8).setValues([row]);
          return { logged: false, updated: true, duplicate: true };
        }
      }
    }
    sh.appendRow(row);
    return { logged: true };
  });
}

// aggregate scores over the last N days
function getScores(days) {
  const sh = ensureScores();
  const data = sh.getDataRange().getValues();
  const cutoff = new Date(todayStr() + 'T00:00:00');
  cutoff.setDate(cutoff.getDate() - (days - 1));

  const agg = {}; // email -> {name,total,answers,cheats,cats:{cat:{sum,count}},days:{}}
  for (let i = 1; i < data.length; i++) {
    const d = new Date(String(data[i][0]) + 'T00:00:00');
    if (isNaN(d) || d < cutoff) continue;
    const email = String(data[i][1]).toLowerCase();
    const a = agg[email] || (agg[email] = {
      email: email, name: String(data[i][2]), total: 0, answers: 0, cheats: 0, cats: {}, days: {} });
    const cat = String(data[i][3]) || 'general';
    const score = Number(data[i][5]) || 0;
    a.total += score; a.answers++;
    if (String(data[i][6]) === 'YES') a.cheats++;
    const c = a.cats[cat] || (a.cats[cat] = { sum: 0, count: 0 });
    c.sum += score; c.count++;
    a.days[String(data[i][0])] = true;
  }
  const active = {};
  for (const student of readBotMap()) {
    if (student.active !== false && student.status !== 'hired' && student.status !== 'left') active[student.email] = true;
  }
  const out = Object.keys(agg).filter(function (email) { return active[email]; }).map(function (k) {
    const a = agg[k];
    a.activeDays = Object.keys(a.days).length;
    delete a.days;
    return a;
  });
  out.sort(function (x, y) { return y.total - x.total; });
  return { days: days, students: out };
}

// ============================================================
//  MISSING-STUDENT MATCHING
//  Links Discord users who never filled the enrollment form,
//  using the 'All Data' master tab (fullName / email / phone).
// ============================================================
function normName(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z\u0980-\u09FF ]/g, ' ') // keep letters (latin+bangla) and spaces
    .replace(/\s+/g, ' ').trim();
}

function identityNameKeys(value) {
  const cleaned = String(value || '')
    .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ')
    .replace(/\b(mr|mrs|ms|miss|sir|bro|vai|bhai)\b/gi, ' ');
  const full = normName(cleaned);
  if (!full || full.replace(/\s+/g, '').length < 4) return [];
  const common = {
    md: true, mohammad: true, mohammed: true, muhammad: true,
    mst: true, mosammat: true, bin: true, binti: true,
  };
  const tokens = full.split(' ').filter(Boolean);
  const coreTokens = tokens.filter(function (token) { return !common[token]; });
  const core = coreTokens.join(' ');
  const keys = ['full:' + full, 'compact:' + full.replace(/\s+/g, '')];
  if (core && core !== full && core.length >= 4) {
    keys.push('core:' + core, 'compact:' + core.replace(/\s+/g, ''));
  } else if (core) {
    keys.push('core:' + core);
  }
  return keys.filter(function (key, index, list) {
    return key.length > key.indexOf(':') + 1 && list.indexOf(key) === index;
  });
}

function readAllData() {
  const sh = getSpreadsheet().getSheetByName(CONFIG.SHEETS.allData);
  if (!sh) return [];
  const data = sh.getDataRange().getValues();
  if (!data.length) return [];
  const h = data[0].map(String);
  const cName = findHeader(h, ['fullName', 'Full Name', 'Name']);
  const cEmail = findHeader(h, ['email', 'Email Address']);
  const cPhone = findHeader(h, ['phone', 'WhatsApp Number', 'Mobile']);
  const cDiscord = findHeader(h, ['Discord Username', 'username', 'Discord Handle']);
  const cRegion = findHeader(h,
    ['Current Region (Division)', 'Region', 'Division', 'Current Location']);
  const cSubregion = findHeader(h,
    ['Current Subregion / Area', 'Subregion', 'Area', 'District']);
  if (cName === -1 || cEmail === -1) return [];
  const byEmail = {};
  const order = [];
  for (let i = 1; i < data.length; i++) {
    const email = validStudentProfileEmail(data[i][cEmail]);
    const name = String(data[i][cName]).trim();
    if (!email || !name) continue;
    const incoming = {
      name: name,
      norm: normName(name),
      nameKeys: identityNameKeys(name),
      email: email,
      phone: cPhone >= 0 ? String(data[i][cPhone]).trim() : '',
      username: cDiscord >= 0 ? String(data[i][cDiscord]).trim() : '',
      region: cRegion >= 0 ? String(data[i][cRegion]).trim() : '',
      subregion: cSubregion >= 0 ? String(data[i][cSubregion]).trim() : '',
      sourceRow: i + 1,
    };
    if (!byEmail[email]) {
      byEmail[email] = incoming;
      order.push(email);
      continue;
    }
    const current = byEmail[email];
    ['name', 'phone', 'username', 'region', 'subregion'].forEach(function (key) {
      if (incoming[key]) current[key] = incoming[key];
    });
    current.norm = normName(current.name);
    current.nameKeys = identityNameKeys(current.name);
    current.sourceRow = incoming.sourceRow;
  }
  return order.map(function (email) { return byEmail[email]; });
}

function upsertAllDataFromEnrollment(email, name, phone) {
  email = normalizeStudentEmail(email);
  const sh = ensureTab(CONFIG.SHEETS.allData, ['fullName', 'email', 'phone']);
  const data = sh.getDataRange().getValues();
  const headers = data[0].map(String);
  const nameCol = findHeader(headers, ['fullName', 'Full Name', 'Name']);
  const emailCol = findHeader(headers, ['email', 'Email Address']);
  const phoneCol = findHeader(headers, ['phone', 'WhatsApp Number', 'Mobile']);
  if (nameCol === -1 || emailCol === -1) {
    throw new Error('All Data must contain name and email columns');
  }
  for (let i = 1; i < data.length; i++) {
    if (normalizeStudentEmail(data[i][emailCol]) !== email) continue;
    if (name && !String(data[i][nameCol] || '').trim()) sh.getRange(i + 1, nameCol + 1).setValue(name);
    if (phoneCol !== -1 && phone && !String(data[i][phoneCol] || '').trim()) {
      sh.getRange(i + 1, phoneCol + 1).setValue(phone);
    }
    return 'updated';
  }
  const row = new Array(Math.max(sh.getLastColumn(), 3)).fill('');
  row[nameCol] = name;
  row[emailCol] = email;
  if (phoneCol !== -1) row[phoneCol] = phone;
  sh.appendRow(row);
  return 'added';
}

function cleanStudentProfileText(value, maxLength) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[=+\-@]+/, '')
    .slice(0, maxLength || 100);
}

function normalizeStudentProfilePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length < 8 || digits.length > 15) {
    throw new Error('Phone / WhatsApp number must contain 8 to 15 digits');
  }
  return digits;
}

function validStudentProfileEmail(value) {
  const email = normalizeStudentEmail(value);
  if (isSyntheticStudentEmail(email)) return '';
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : '';
}

function validStudentProfilePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : '';
}

function ensureAllDataProfileColumns() {
  const sheet = ensureTab(CONFIG.SHEETS.allData, ['fullName', 'email', 'phone']);
  let headers = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn()))
    .getDisplayValues()[0];
  const definitions = {
    name: { title: 'fullName', aliases: ['fullName', 'Full Name', 'Name'] },
    email: { title: 'email', aliases: ['email', 'Email Address'] },
    phone: { title: 'phone', aliases: ['phone', 'WhatsApp Number', 'Mobile'] },
    username: {
      title: 'Discord Username',
      aliases: ['Discord Username', 'username', 'Discord Handle'],
    },
    discordId: { title: 'Discord ID', aliases: ['Discord ID'] },
    region: {
      title: 'Region',
      aliases: ['Current Region (Division)', 'Region', 'Division', 'Current Location'],
    },
    subregion: {
      title: 'Subregion',
      aliases: ['Current Subregion / Area', 'Subregion', 'Area', 'District'],
    },
  };
  const columns = {};
  Object.keys(definitions).forEach(function (key) {
    const definition = definitions[key];
    let column = findHeader(headers, definition.aliases);
    if (column === -1) {
      column = headers.length;
      sheet.getRange(1, column + 1).setValue(definition.title);
      headers.push(definition.title);
    }
    columns[key] = column;
  });
  return { sheet: sheet, columns: columns };
}

function upsertAllDataFromStudentProfile(profile, overwriteExisting) {
  const schema = ensureAllDataProfileColumns();
  const sheet = schema.sheet;
  const columns = schema.columns;
  const data = sheet.getDataRange().getValues();
  const matchingRows = [];
  for (let i = 1; i < data.length; i++) {
    if (normalizeStudentEmail(data[i][columns.email]) === profile.email) {
      matchingRows.push(i + 1);
    }
  }
  if (matchingRows.length > 1) {
    throw new Error('All Data has duplicate rows for this email; ask your mentor to resolve them');
  }
  const rowNumber = matchingRows.length ? matchingRows[0] : sheet.getLastRow() + 1;
  const width = Math.max(sheet.getLastColumn(), Object.keys(columns).reduce(function (max, key) {
    return Math.max(max, columns[key] + 1);
  }, 0));
  const row = matchingRows.length
    ? sheet.getRange(rowNumber, 1, 1, width).getValues()[0]
    : new Array(width).fill('');
  row[columns.email] = profile.email;
  if ((overwriteExisting || !String(row[columns.name] || '').trim()) && profile.name) {
    row[columns.name] = profile.name;
  }
  if ((overwriteExisting || !String(row[columns.phone] || '').trim()) && profile.phone) {
    row[columns.phone] = profile.phone;
  }
  if ((overwriteExisting || !String(row[columns.region] || '').trim()) && profile.region) {
    row[columns.region] = profile.region;
  }
  if ((overwriteExisting || !String(row[columns.subregion] || '').trim()) && profile.subregion) {
    row[columns.subregion] = profile.subregion;
  }
  // Discord itself is authoritative for these two values, so refresh them.
  row[columns.username] = profile.username || row[columns.username] || '';
  row[columns.discordId] = profile.discordId ? "'" + profile.discordId : row[columns.discordId] || '';
  ensureSheetSize(sheet, rowNumber, width);
  sheet.getRange(rowNumber, 1, 1, width).setValues([row]);
  return matchingRows.length ? 'updated' : 'added';
}

function normalizeDiscordId(value) {
  return String(value || '').trim().replace(/^'/, '');
}

function addIdentityIndex(index, token, email) {
  token = String(token || '').trim();
  email = normalizeStudentEmail(email);
  if (!token || !email) return;
  if (!index[token]) index[token] = {};
  index[token][email] = true;
}

function indexedEmails(index, tokens) {
  const found = {};
  (tokens || []).forEach(function (token) {
    const bucket = index[String(token || '').trim()] || {};
    Object.keys(bucket).forEach(function (email) { found[email] = true; });
  });
  return Object.keys(found);
}

function enrollmentIdentityRecords() {
  const ss = getSpreadsheet();
  const configuredName = responseSheetName('enrollment');
  const configured = ss.getSheetByName(configuredName);
  const intake = ss.getSheetByName(intakeResponsesName());
  const candidates = [];
  const seen = {};
  const reserved = {};
  const configuredSheets = configuredSheetMap();
  for (const key in configuredSheets) {
    const name = String(configuredSheets[key] || '').trim();
    if (name && name !== configuredName) reserved[name] = true;
  }
  if (configured) {
    candidates.push(configured);
    seen[configured.getSheetId()] = true;
  }
  if (intake && !seen[intake.getSheetId()]) {
    candidates.push(intake);
    seen[intake.getSheetId()] = true;
  }
  ss.getSheets().forEach(function (sheet) {
    if (seen[sheet.getSheetId()] || reserved[sheet.getName()] || sheet.getLastRow() < 2) return;
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
    const emailCol = findHeader(headers, fieldCandidates('enrollment', 'enrollmentEmail', ['Email Address', 'Email']));
    const nameCol = findHeader(headers, fieldCandidates('enrollment', 'name', ['Your Name', 'Full Name', 'Name']));
    const phoneCol = findHeader(headers, fieldCandidates('enrollment', 'phone', ['WhatsApp Number', 'Phone', 'Mobile', 'Contact Number']));
    const usernameCol = findHeader(headers, fieldCandidates('enrollment', 'discordUsername', ['Discord Username', 'Discord Handle', 'username']));
    const discordIdCol = findHeader(headers, ['Discord ID', 'Discord User ID']);
    // Unknown legacy/import tabs are safe identity references only when they
    // contain a real email plus a durable Discord identity, or a name and
    // phone pair. Operational bot tabs remain excluded through `reserved`.
    if (emailCol !== -1 && (discordIdCol !== -1 || usernameCol !== -1 ||
        (nameCol !== -1 && phoneCol !== -1))) candidates.push(sheet);
  });

  const byEmail = {};
  const sourceTabs = [];
  candidates.forEach(function (sheet) {
    const data = sheet.getDataRange().getValues();
    if (!data.length) return;
    const headers = data[0].map(String);
    const emailCol = findHeader(headers, fieldCandidates('enrollment', 'enrollmentEmail', ['Email Address', 'Email']));
    const nameCol = findHeader(headers, fieldCandidates('enrollment', 'name', ['Your Name', 'Full Name', 'Name']));
    if (emailCol === -1) return;
    const usernameCol = findHeader(headers, fieldCandidates('enrollment', 'discordUsername', ['Discord Username', 'Discord Handle', 'username']));
    const discordIdCol = findHeader(headers, ['Discord ID', 'Discord User ID']);
    const phoneCol = findHeader(headers, fieldCandidates('enrollment', 'phone', ['WhatsApp Number', 'Phone', 'Mobile', 'Contact Number']));
    const regionCol = findHeader(headers, fieldCandidates('enrollment', 'region', ['Current Region (Division)', 'Region', 'Division', 'Current Location']));
    const subregionCol = findHeader(headers, fieldCandidates('enrollment', 'subregion', ['Current Subregion / Area', 'Subregion', 'Area']));
    sourceTabs.push(sheet.getName());
    for (let i = 1; i < data.length; i++) {
      const email = validStudentProfileEmail(data[i][emailCol]);
      if (!email) continue;
      const incoming = {
        email: email,
        name: nameCol === -1 ? '' : String(data[i][nameCol] || '').trim(),
        username: usernameCol === -1 ? '' : String(data[i][usernameCol] || '').trim(),
        discordId: discordIdCol === -1 ? '' : normalizeDiscordId(data[i][discordIdCol]),
        phone: phoneCol === -1 ? '' : String(data[i][phoneCol] || '').trim(),
        region: regionCol === -1 ? '' : String(data[i][regionCol] || '').trim(),
        subregion: subregionCol === -1 ? '' : String(data[i][subregionCol] || '').trim(),
        sourceTab: sheet.getName(),
      };
      if (!byEmail[email]) {
        byEmail[email] = incoming;
        continue;
      }
      const current = byEmail[email];
      ['name', 'username', 'discordId', 'phone', 'region', 'subregion'].forEach(function (key) {
        if (!current[key] && incoming[key]) current[key] = incoming[key];
      });
      if (sheet.getName() === configuredName || sheet.getName() === intakeResponsesName()) {
        current.sourceTab = sheet.getName();
      }
    }
  });
  return { records: Object.keys(byEmail).map(function (email) { return byEmail[email]; }), sourceTabs: sourceTabs };
}

function botMapCompleteness(row) {
  return (row || []).reduce(function (count, value) {
    return count + (String(value || '').trim() ? 1 : 0);
  }, 0);
}

function mergeExistingBotMapRows(rows) {
  const sorted = (rows || []).slice().sort(function (a, b) {
    return botMapCompleteness(b.values) - botMapCompleteness(a.values);
  });
  const values = new Array(BOT_MAP_HEADERS.length).fill('');
  let emailBackground = '#ffffff';
  sorted.forEach(function (entry) {
    for (let col = 0; col < BOT_MAP_HEADERS.length; col++) {
      if (!String(values[col] || '').trim() && String(entry.values[col] || '').trim()) {
        values[col] = entry.values[col];
      }
    }
    if (String(entry.emailBackground || '#ffffff').toLowerCase() !== '#ffffff') {
      emailBackground = entry.emailBackground;
    }
  });
  values[0] = normalizeStudentEmail(values[0]);
  values[3] = normalizeDiscordId(values[3]);
  return { values: values, emailBackground: emailBackground };
}

function ensureBotMapArchive() {
  return ensureTab(
    botMapArchiveName(),
    ['Archived At', 'Reason'].concat(BOT_MAP_HEADERS));
}

function readBotMapArchiveEntries() {
  const archive = ensureBotMapArchive();
  if (archive.getLastRow() < 2) return [];
  const data = archive.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const values = data[i].slice(2, 2 + BOT_MAP_HEADERS.length);
    while (values.length < BOT_MAP_HEADERS.length) values.push('');
    const email = normalizeStudentEmail(values[0]);
    const discordId = normalizeDiscordId(values[3]);
    if (!email && !discordId) continue;
    values[0] = email;
    values[3] = discordId;
    out.push({
      values: values,
      archivedAt: String(data[i][0] || ''),
      reason: String(data[i][1] || ''),
      emailBackground: '#ffffff',
    });
  }
  return out;
}

function archiveBotMapRows(entries) {
  if (!(entries || []).length) return 0;
  const archive = ensureBotMapArchive();
  const existing = {};
  const data = archive.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const key = [
      normalizeStudentEmail(data[i][2]),
      normalizeDiscordId(data[i][5]),
      normalizeIdentityToken(data[i][4]),
      String(data[i][1] || '').trim(),
    ].join('|');
    existing[key] = true;
  }
  const timestamp = Utilities.formatDate(new Date(), CONFIG.TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
  const rows = [];
  entries.forEach(function (entry) {
    const values = (entry.values || []).slice(0, BOT_MAP_HEADERS.length);
    while (values.length < BOT_MAP_HEADERS.length) values.push('');
    const key = [
      normalizeStudentEmail(values[0]),
      normalizeDiscordId(values[3]),
      normalizeIdentityToken(values[2]),
      entry.reason,
    ].join('|');
    if (existing[key]) return;
    existing[key] = true;
    rows.push([timestamp, entry.reason].concat(values));
  });
  if (rows.length) {
    archive.getRange(archive.getLastRow() + 1, 1, rows.length, BOT_MAP_HEADERS.length + 2).setValues(rows);
  }
  return rows.length;
}

function upsertActiveIdentityRows(sheetName, activeEntries, minimumHeaders) {
  const sheet = sheetName === CONFIG.SHEETS.matrix
    ? ensureAttendanceSheet()
    : ensureTab(sheetName, minimumHeaders);
  const data = sheet.getDataRange().getValues();
  const rowByEmail = {};
  for (let i = 1; i < data.length; i++) {
    const email = normalizeStudentEmail(data[i][1]);
    if (email && !rowByEmail[email]) rowByEmail[email] = i + 1;
  }
  const additions = [];
  (activeEntries || []).forEach(function (entry) {
    const values = entry.values || [];
    const email = normalizeStudentEmail(values[0]);
    const identity = [values[1] || '', email, values[7] || ''];
    const row = rowByEmail[email];
    if (row) sheet.getRange(row, 1, 1, 3).setValues([identity]);
    else additions.push(identity);
  });
  if (additions.length) {
    const width = Math.max(sheet.getLastColumn(), minimumHeaders.length);
    const rows = additions.map(function (identity) {
      return identity.concat(new Array(Math.max(0, width - 3)).fill(''));
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, width).setValues(rows);
  }
  return { updated: activeEntries.length - additions.length, added: additions.length };
}

function syncAllDataRosterEntries(activeEntries) {
  const schema = ensureAllDataProfileColumns();
  const sheet = schema.sheet;
  const columns = schema.columns;
  const width = Math.max(sheet.getLastColumn(), 1);
  const data = sheet.getDataRange().getValues();
  const byEmail = {};
  const byDiscordId = {};
  for (let i = 1; i < data.length; i++) {
    const email = normalizeStudentEmail(data[i][columns.email]);
    const discordId = normalizeDiscordId(data[i][columns.discordId]);
    if (email && !byEmail[email]) byEmail[email] = i + 1;
    if (discordId && !byDiscordId[discordId]) byDiscordId[discordId] = i + 1;
  }
  const additions = [];
  const duplicateRows = {};
  let updated = 0;
  (activeEntries || []).forEach(function (entry) {
    const values = entry.values || [];
    const profile = {
      email: normalizeStudentEmail(values[0]),
      name: String(values[1] || '').trim(),
      username: String(values[2] || '').trim(),
      discordId: normalizeDiscordId(values[3]),
      region: String(values[5] || '').trim(),
      subregion: String(values[6] || '').trim(),
      phone: String(values[7] || '').trim(),
    };
    if (!profile.email || !profile.discordId) return;
    const emailRow = byEmail[profile.email] || 0;
    const discordRow = byDiscordId[profile.discordId] || 0;
    const rowNumber = emailRow || discordRow;
    const row = rowNumber ? data[rowNumber - 1].slice() : new Array(width).fill('');
    while (row.length < width) row.push('');
    if (emailRow && discordRow && emailRow !== discordRow) {
      const oldIdentityRow = data[discordRow - 1] || [];
      for (let column = 0; column < width; column++) {
        if ((row[column] === '' || row[column] === null) && oldIdentityRow[column] !== '' && oldIdentityRow[column] !== null) {
          row[column] = oldIdentityRow[column];
        }
      }
      duplicateRows[discordRow] = true;
    }
    row[columns.email] = profile.email;
    if (profile.name) row[columns.name] = profile.name;
    if (profile.phone) row[columns.phone] = profile.phone;
    if (profile.region) row[columns.region] = profile.region;
    if (profile.subregion) row[columns.subregion] = profile.subregion;
    row[columns.username] = profile.username;
    row[columns.discordId] = "'" + profile.discordId;
    if (rowNumber) {
      sheet.getRange(rowNumber, 1, 1, width).setValues([row]);
      updated++;
    } else {
      additions.push(row);
    }
  });
  if (additions.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, additions.length, width).setValues(additions);
  }
  Object.keys(duplicateRows).map(Number).sort(function (a, b) { return b - a; })
    .forEach(function (rowNumber) { sheet.deleteRow(rowNumber); });
  return { updated: updated, added: additions.length, merged: Object.keys(duplicateRows).length };
}

function upsertJobSheetRosterRows(activeEntries) {
  const sheet = ensureJobSheets();
  const data = sheet.getDataRange().getValues();
  const rowByEmail = {};
  for (let i = 1; i < data.length; i++) {
    const email = normalizeStudentEmail(data[i][0]);
    if (email && !rowByEmail[email]) rowByEmail[email] = i + 1;
  }
  const additions = [];
  let updated = 0;
  (activeEntries || []).forEach(function (entry) {
    const values = entry.values || [];
    const email = normalizeStudentEmail(values[0]);
    if (!email) return;
    const row = rowByEmail[email];
    if (row) {
      sheet.getRange(row, 1, 1, 2).setValues([[email, values[1] || '']]);
      updated++;
    } else {
      additions.push([email, values[1] || '', '', '', '']);
    }
  });
  if (additions.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, additions.length, 5).setValues(additions);
  }
  return { updated: updated, added: additions.length };
}

function mergeDuplicateIdentityRows(sheetName, email, emailColumn, numericFromColumn) {
  const sheet = getSpreadsheet().getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 3) return 0;
  const data = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    if (normalizeStudentEmail(data[i][emailColumn - 1]) === email) rows.push(i + 1);
  }
  if (rows.length < 2) return 0;
  const target = rows[0];
  const merged = data[target - 1].slice();
  rows.slice(1).forEach(function (rowNumber) {
    const candidate = data[rowNumber - 1];
    for (let column = 0; column < merged.length; column++) {
      if ((merged[column] === '' || merged[column] === null) && candidate[column] !== '' && candidate[column] !== null) {
        merged[column] = candidate[column];
      } else if (column + 1 >= (numericFromColumn || Number.POSITIVE_INFINITY) &&
          Number.isFinite(Number(merged[column])) && Number.isFinite(Number(candidate[column]))) {
        merged[column] = Math.max(Number(merged[column]) || 0, Number(candidate[column]) || 0);
      }
    }
  });
  sheet.getRange(target, 1, 1, merged.length).setValues([merged]);
  rows.slice(1).sort(function (a, b) { return b - a; }).forEach(function (rowNumber) {
    sheet.deleteRow(rowNumber);
  });
  return rows.length - 1;
}

function mergeDuplicateJobDailyRows(email) {
  const sheet = getSpreadsheet().getSheetByName(CONFIG.SHEETS.jobsDaily);
  if (!sheet || sheet.getLastRow() < 3) return 0;
  const data = sheet.getDataRange().getValues();
  const rowByDate = {};
  const deletes = [];
  for (let i = 1; i < data.length; i++) {
    if (normalizeStudentEmail(data[i][1]) !== email) continue;
    const date = normalizeSheetDate(data[i][0]) || String(data[i][0] || '').trim();
    if (!rowByDate[date]) {
      rowByDate[date] = i + 1;
      continue;
    }
    const target = rowByDate[date];
    const best = Math.max(Number(sheet.getRange(target, 3).getValue()) || 0, Number(data[i][2]) || 0);
    sheet.getRange(target, 3).setValue(best);
    deletes.push(i + 1);
  }
  deletes.sort(function (a, b) { return b - a; }).forEach(function (rowNumber) {
    sheet.deleteRow(rowNumber);
  });
  return deletes.length;
}

function mergeDuplicateDawnAttendanceRows(email) {
  const sheet = getSpreadsheet().getSheetByName(dawnAttendanceName());
  if (!sheet || sheet.getLastRow() < 3) return 0;
  const data = sheet.getDataRange().getDisplayValues();
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    if (normalizeStudentEmail(data[i][1]) === email) rows.push(i + 1);
  }
  if (rows.length < 2) return 0;
  const target = rows[0];
  const merged = data[target - 1].slice();
  rows.slice(1).forEach(function (rowNumber) {
    const candidate = data[rowNumber - 1];
    if (!merged[0] && candidate[0]) merged[0] = candidate[0];
    if (!merged[2] && candidate[2]) merged[2] = candidate[2];
    for (let column = 3; column < Math.max(merged.length, candidate.length); column++) {
      merged[column] = mergeDawnAttendanceCell(merged[column], candidate[column]);
    }
  });
  ensureSheetSize(sheet, target, merged.length);
  sheet.getRange(target, 1, 1, merged.length).setValues([merged]);
  for (let column = 3; column < merged.length; column++) {
    styleDawnAttendanceCell(sheet.getRange(target, column + 1), merged[column]);
  }
  rows.slice(1).sort(function (a, b) { return b - a; }).forEach(function (rowNumber) {
    sheet.deleteRow(rowNumber);
  });
  return rows.length - 1;
}

function migrateStudentEmail(oldEmail, newEmail) {
  oldEmail = normalizeStudentEmail(oldEmail);
  newEmail = normalizeStudentEmail(newEmail);
  if (!oldEmail || !newEmail || oldEmail === newEmail) return { changed: 0 };
  const sheetNames = [
    CONFIG.SHEETS.botMap, CONFIG.SHEETS.allData,
    CONFIG.SHEETS.matrix, CONFIG.SHEETS.jobsMatrix, CONFIG.SHEETS.outreachMatrix,
    CONFIG.SHEETS.interviewMatrix,
    CONFIG.SHEETS.jobSheets, CONFIG.SHEETS.jobsDaily, CONFIG.SHEETS.interviewLog,
    CONFIG.SHEETS.outreachLog, CONFIG.SHEETS.outreachDaily, CONFIG.SHEETS.workshopAtt,
    CONFIG.SHEETS.scores, CONFIG.SHEETS.resumes, CONFIG.SHEETS.projects,
    dawnAttendanceName(),
  ];
  let changed = 0;
  sheetNames.forEach(function (sheetName) {
    const sheet = getSpreadsheet().getSheetByName(sheetName);
    if (!sheet || sheet.getLastRow() < 2) return;
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
    const emailIndex = findHeader(headers, ['Student Email', 'Enrollment Email', 'Email Address', 'Email']);
    if (emailIndex === -1) return;
    const range = sheet.getRange(2, emailIndex + 1, sheet.getLastRow() - 1, 1);
    const values = range.getValues();
    let sheetChanged = false;
    values.forEach(function (row) {
      if (normalizeStudentEmail(row[0]) !== oldEmail) return;
      row[0] = newEmail;
      changed++;
      sheetChanged = true;
    });
    if (sheetChanged) range.setValues(values);
  });
  [CONFIG.SHEETS.matrix, CONFIG.SHEETS.jobsMatrix, CONFIG.SHEETS.outreachMatrix,
    CONFIG.SHEETS.interviewMatrix]
    .forEach(function (sheetName) { mergeDuplicateIdentityRows(sheetName, newEmail, 2, 4); });
  mergeDuplicateIdentityRows(CONFIG.SHEETS.botMap, newEmail, 1);
  mergeDuplicateIdentityRows(CONFIG.SHEETS.jobSheets, newEmail, 1);
  mergeDuplicateIdentityRows(CONFIG.SHEETS.outreachLog, newEmail, 1);
  mergeDuplicateDawnAttendanceRows(newEmail);
  const allDataSheet = getSpreadsheet().getSheetByName(CONFIG.SHEETS.allData);
  if (allDataSheet && allDataSheet.getLastColumn()) {
    const allHeaders = allDataSheet.getRange(1, 1, 1, allDataSheet.getLastColumn()).getDisplayValues()[0];
    const allEmailIndex = findHeader(allHeaders, ['email', 'Email Address']);
    if (allEmailIndex !== -1) {
      mergeDuplicateIdentityRows(CONFIG.SHEETS.allData, newEmail, allEmailIndex + 1);
    }
  }
  mergeDuplicateJobDailyRows(newEmail);
  const props = PropertiesService.getScriptProperties();
  const oldKey = jobSnapshotKey(oldEmail);
  const newKey = jobSnapshotKey(newEmail);
  const previous = props.getProperty(oldKey);
  if (previous && !props.getProperty(newKey)) props.setProperty(newKey, previous);
  if (previous) props.deleteProperty(oldKey);
  return { changed: changed };
}

function chooseRosterCandidate(existingId, corroboratedUsername, nameOnly, usernameOnly) {
  const distinct = function (values) {
    return (values || []).filter(function (value, index, list) {
      return value && list.indexOf(value) === index;
    });
  };
  existingId = distinct(existingId);
  corroboratedUsername = distinct(corroboratedUsername);
  nameOnly = distinct(nameOnly);
  usernameOnly = distinct(usernameOnly);
  if (existingId.length > 1) return { error: 'Discord ID is attached to multiple emails in old Bot_Map' };
  if (existingId.length === 1) return { email: existingId[0], source: 'Verified Discord ID' };
  if (corroboratedUsername.length > 1) return { error: 'multiple records match username and name' };
  if (corroboratedUsername.length === 1) {
    return { email: corroboratedUsername[0], source: 'Username + matching student name' };
  }
  if (nameOnly.length) {
    return { error: 'name-only match is not trusted; private email and phone confirmation required' };
  }
  if (usernameOnly.length) {
    return { error: 'username matched, but student name did not; private data survey required' };
  }
  return { error: 'no unique match in All Data, archive, or enrollment responses' };
}

function writeRosterReview(people, activeEntries, unmatched, guildId) {
  const sheet = ensureRosterReview();
  const previousById = {};
  if (sheet.getLastRow() > 1) {
    const previousRows = sheet.getRange(
      2, 1, sheet.getLastRow() - 1, ROSTER_REVIEW_HEADERS.length).getDisplayValues();
    previousRows.forEach(function (row) {
      const id = normalizeDiscordId(row[0]);
      if (id) previousById[id] = row;
    });
  }
  const activeById = {};
  (activeEntries || []).forEach(function (entry) {
    const values = entry.values || [];
    const discordId = normalizeDiscordId(values[3]);
    if (discordId) activeById[discordId] = values;
  });
  const unmatchedById = {};
  (unmatched || []).forEach(function (item) {
    unmatchedById[normalizeDiscordId(item.discordId)] = item;
  });
  const stamp = Utilities.formatDate(new Date(), CONFIG.TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
  const rows = (people || []).map(function (person) {
    const id = normalizeDiscordId(person.discordId);
    const values = activeById[id] || [];
    const issue = unmatchedById[id] || {};
    const previous = previousById[id] || [];
    const onboarding = onboardingProfileDefaults(guildId, id);
    // Columns E:I are deliberately supervisor-editable. Once a supervisor
    // corrects one of these values, a later Discord sync must never replace it
    // with an older All Data/Form value.
    const row = [
      id ? "'" + id : '',
      String(person.username || ''),
      String(person.displayName || person.globalName || person.nickname || person.username || ''),
      '',
      validStudentProfileEmail(previous[4]) || values[0] || '',
      previous[5] || values[1] || '',
      validStudentProfilePhone(previous[6]) || values[7] || '',
      previous[7] || values[5] || onboarding.region || '',
      previous[8] || values[6] || '',
      values[8] || previous[9] || '',
      previous[10] || values[9] || issue.reason || '',
      stamp,
      previous[12] || '',
      previous[13] || '',
      previous[14] || '',
    ];
    row[3] = isProvisionalStudentEmail(values[0]) || missingStudentProfileFields(row).length
      ? 'PROFILE INCOMPLETE'
      : 'VERIFIED';
    return row;
  });
  const oldRows = Math.max(0, sheet.getLastRow() - 1);
  if (oldRows) {
    sheet.getRange(2, 1, oldRows, Math.max(sheet.getLastColumn(), ROSTER_REVIEW_HEADERS.length))
      .clearContent()
      .setBackground('#ffffff');
  }
  if (rows.length) {
    ensureSheetSize(sheet, rows.length + 1, ROSTER_REVIEW_HEADERS.length);
    sheet.getRange(2, 1, rows.length, ROSTER_REVIEW_HEADERS.length).setValues(rows);
    const colors = rows.map(function (row) {
      return new Array(ROSTER_REVIEW_HEADERS.length)
        .fill(row[3] === 'VERIFIED' ? '#d9ead3' : '#fff2cc');
    });
    sheet.getRange(2, 1, rows.length, ROSTER_REVIEW_HEADERS.length).setBackgrounds(colors);
  }
  if (oldRows > rows.length) sheet.deleteRows(rows.length + 2, oldRows - rows.length);
  sheet.autoResizeColumns(1, ROSTER_REVIEW_HEADERS.length);
  return {
    total: rows.length,
    verified: rows.filter(function (row) { return row[3] === 'VERIFIED'; }).length,
    needsVerification: rows.filter(function (row) {
      return row[3] !== 'VERIFIED';
    }).length,
  };
}

function getRosterReviewStatus() {
  const sheet = getSpreadsheet().getSheetByName(rosterReviewName());
  if (!sheet || sheet.getLastRow() < 2) {
    return { total: 0, verified: 0, needsVerification: 0, lastSync: '' };
  }
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, ROSTER_REVIEW_HEADERS.length)
    .getDisplayValues()
    .filter(function (row) { return normalizeDiscordId(row[0]); });
  const verified = rows.filter(function (row) {
    return String(row[3] || '').trim().toUpperCase() === 'VERIFIED';
  }).length;
  return {
    total: rows.length,
    verified: verified,
    needsVerification: rows.length - verified,
    incompleteProfiles: rows.filter(function (row) {
      return missingStudentProfileFields(row).length > 0;
    }).length,
    lastSync: rows.reduce(function (latest, row) {
      return String(row[11] || '') > latest ? String(row[11] || '') : latest;
    }, ''),
  };
}

function missingStudentProfileFields(reviewRow) {
  const row = reviewRow || [];
  const missing = [];
  if (!cleanStudentProfileText(row[5], 100)) missing.push('name');
  if (!validStudentProfileEmail(row[4])) missing.push('email');
  if (!validStudentProfilePhone(row[6])) missing.push('phone');
  if (!cleanStudentProfileText(row[7], 100)) missing.push('region');
  if (/^dhaka$/i.test(cleanStudentProfileText(row[7], 100)) &&
      !cleanStudentProfileText(row[8], 100)) missing.push('subregion');
  if (String(row[3] || '').trim().toUpperCase() === 'PROFILE INCOMPLETE' &&
      missing.indexOf('email') === -1) {
    missing.push('email');
  }
  return missing;
}

function getMissingStudentProfiles() {
  const sheet = getSpreadsheet().getSheetByName(rosterReviewName());
  if (!sheet || sheet.getLastRow() < 2) {
    return {
      total: 0, complete: 0, incomplete: 0, delivered: 0,
      completedSurveys: 0, deliveryProblems: 0, profiles: [],
    };
  }
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, ROSTER_REVIEW_HEADERS.length)
    .getDisplayValues()
    .filter(function (row) { return normalizeDiscordId(row[0]); });
  const profiles = rows.map(function (row) {
    const missing = missingStudentProfileFields(row);
    if (!missing.length) return null;
    return {
      discordId: normalizeDiscordId(row[0]),
      username: String(row[1] || ''),
      displayName: String(row[2] || row[1] || ''),
      matched: String(row[3] || '').trim().toUpperCase() === 'VERIFIED',
      missing: missing,
      reason: String(row[10] || ''),
      deliveryStatus: String(row[12] || ''),
      surveySentAt: String(row[13] || ''),
      profileCompletedAt: String(row[14] || ''),
    };
  }).filter(Boolean);
  const delivered = rows.filter(function (row) {
    return String(row[12] || '').trim().toUpperCase() === 'SENT';
  }).length;
  const completedSurveys = rows.filter(function (row) {
    return String(row[12] || '').trim().toUpperCase() === 'COMPLETED';
  }).length;
  const deliveryProblems = rows.filter(function (row) {
    const status = String(row[12] || '').trim().toUpperCase();
    return status === 'DM BLOCKED' || status === 'NOT IN SERVER';
  }).length;
  return {
    total: rows.length,
    complete: rows.length - profiles.length,
    incomplete: profiles.length,
    delivered: delivered,
    completedSurveys: completedSurveys,
    deliveryProblems: deliveryProblems,
    profiles: profiles,
  };
}

function rosterReviewRowsById() {
  const sheet = ensureRosterReview();
  const out = {};
  if (sheet.getLastRow() < 2) return out;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, ROSTER_REVIEW_HEADERS.length)
    .getDisplayValues();
  rows.forEach(function (row) {
    const id = normalizeDiscordId(row[0]);
    if (id) out[id] = row;
  });
  return out;
}

function syncDiscordRoster(people, guildId) {
  return withScriptLock(function () {
    return syncDiscordRosterCore(people, guildId);
  });
}

function syncDiscordRosterCore(people, guildId) {
  people = Array.isArray(people) ? people : [];
  const uniquePeople = {};
  people.forEach(function (person) {
    const id = normalizeDiscordId(person.discordId);
    if (!id) return;
    uniquePeople[id] = {
      discordId: id,
      username: String(person.username || '').trim(),
      globalName: String(person.globalName || '').trim(),
      nickname: String(person.nickname || '').trim(),
      displayName: String(person.displayName || person.nickname || person.globalName || person.username || '').trim(),
    };
  });
  people = Object.keys(uniquePeople).map(function (id) { return uniquePeople[id]; });
  const reviewById = rosterReviewRowsById();

  const map = ensureBotMap();
  const oldData = map.getDataRange().getValues();
  const oldBackgrounds = oldData.length > 1
    ? map.getRange(2, 1, oldData.length - 1, 1).getBackgrounds()
    : [];
  const existingEntries = [];
  for (let i = 1; i < oldData.length; i++) {
    const values = oldData[i].slice(0, BOT_MAP_HEADERS.length);
    while (values.length < BOT_MAP_HEADERS.length) values.push('');
    if (!normalizeStudentEmail(values[0]) && !normalizeDiscordId(values[3])) continue;
    existingEntries.push({
      values: values,
      row: i + 1,
      emailBackground: String(oldBackgrounds[i - 1] && oldBackgrounds[i - 1][0] || '#ffffff').toLowerCase(),
    });
  }

  const allData = readAllData();
  const enrollment = enrollmentIdentityRecords();
  const archivedEntries = readBotMapArchiveEntries();
  const allByEmail = {};
  const formByEmail = {};
  const existingByEmail = {};
  const archiveByEmail = {};
  const existingEntriesById = {};
  const archiveEntriesById = {};
  const existingIdIndex = {};
  const archiveIdIndex = {};
  const formIdIndex = {};
  const existingUsernameIndex = {};
  const archiveUsernameIndex = {};
  const allUsernameIndex = {};
  const nameIndex = {};
  const formUsernameIndex = {};

  allData.forEach(function (record) {
    const email = normalizeStudentEmail(record.email);
    if (!email) return;
    allByEmail[email] = record;
    (record.nameKeys || identityNameKeys(record.name)).forEach(function (key) {
      addIdentityIndex(nameIndex, key, email);
    });
    addIdentityIndex(
      allUsernameIndex,
      normalizeIdentityToken(record.username).replace(/\s+/g, ''),
      email);
  });
  enrollment.records.forEach(function (record) {
    formByEmail[record.email] = record;
    identityNameKeys(record.name).forEach(function (key) {
      addIdentityIndex(nameIndex, key, record.email);
    });
    addIdentityIndex(formUsernameIndex, normalizeIdentityToken(record.username).replace(/\s+/g, ''), record.email);
    addIdentityIndex(formIdIndex, normalizeDiscordId(record.discordId), record.email);
  });
  existingEntries.forEach(function (entry) {
    const email = validStudentProfileEmail(entry.values[0]);
    const discordId = normalizeDiscordId(entry.values[3]);
    if (email) {
      (existingByEmail[email] = existingByEmail[email] || []).push(entry);
      addIdentityIndex(nameIndex, normName(entry.values[1]), email);
      addIdentityIndex(existingUsernameIndex, normalizeIdentityToken(entry.values[2]).replace(/\s+/g, ''), email);
    }
    if (discordId && email) {
      addIdentityIndex(existingIdIndex, discordId, email);
      (existingEntriesById[discordId] = existingEntriesById[discordId] || []).push(entry);
    }
  });
  archivedEntries.forEach(function (entry) {
    const email = validStudentProfileEmail(entry.values[0]);
    const discordId = normalizeDiscordId(entry.values[3]);
    if (email) {
      (archiveByEmail[email] = archiveByEmail[email] || []).push(entry);
      addIdentityIndex(
        archiveUsernameIndex,
        normalizeIdentityToken(entry.values[2]).replace(/\s+/g, ''),
        email);
    }
    if (discordId && email) {
      addIdentityIndex(archiveIdIndex, discordId, email);
      (archiveEntriesById[discordId] = archiveEntriesById[discordId] || []).push(entry);
    }
  });

  const assignedEmails = {};
  const activeEmails = {};
  const active = [];
  const reviewEntries = [];
  const unmatched = [];
  const emailMigrations = [];
  let linkedNow = 0;
  let kept = 0;

  people.forEach(function (person) {
    const personNames = [
      person.displayName, person.nickname, person.globalName, person.username,
    ].filter(Boolean);
    const personNameKeys = [];
    personNames.forEach(function (name) {
      identityNameKeys(name).forEach(function (key) {
        if (personNameKeys.indexOf(key) === -1) personNameKeys.push(key);
      });
    });
    const usernameToken = normalizeIdentityToken(person.username).replace(/\s+/g, '');
    const review = reviewById[person.discordId] || [];
    const reviewedEmail = validStudentProfileEmail(review[4]);
    const usernameCandidates = indexedEmails(allUsernameIndex, [usernameToken])
      .concat(indexedEmails(formUsernameIndex, [usernameToken]))
      .concat(indexedEmails(existingUsernameIndex, [usernameToken]))
      .concat(indexedEmails(archiveUsernameIndex, [usernameToken]));
    const corroboratedUsername = usernameCandidates.filter(function (email) {
      const record = allByEmail[email] || formByEmail[email] || {};
      const recordKeys = identityNameKeys(record.name);
      return recordKeys.some(function (key) { return personNameKeys.indexOf(key) !== -1; });
    });
    const nameCandidates = indexedEmails(nameIndex, personNameKeys);
    const choice = reviewedEmail
      ? { email: reviewedEmail, source: 'Supervisor-edited Roster Review' }
      : chooseRosterCandidate(
          indexedEmails(existingIdIndex, [person.discordId])
            .concat(indexedEmails(archiveIdIndex, [person.discordId]))
            .concat(indexedEmails(formIdIndex, [person.discordId])),
          corroboratedUsername,
          nameCandidates,
          usernameCandidates);
    if (choice.error) {
      unmatched.push(Object.assign({}, person, { reason: choice.error }));
      return;
    }
    const email = validStudentProfileEmail(choice.email);
    const source = choice.source;
    if (!email) {
      unmatched.push(Object.assign({}, person, {
        reason: 'linked identity has a synthetic or invalid email; private email and phone confirmation required',
      }));
      return;
    }
    if (assignedEmails[email]) {
      unmatched.push(Object.assign({}, person, {
        reason: 'same student record already matched another Discord member',
      }));
      return;
    }
    assignedEmails[email] = person.discordId;
    const currentIdentityEntries = existingEntriesById[person.discordId] || [];
    const archivedIdentityEntries = archiveEntriesById[person.discordId] || [];
    const currentMerged = mergeExistingBotMapRows(
      (existingByEmail[email] || []).concat(currentIdentityEntries));
    const merged = mergeExistingBotMapRows(
      (existingByEmail[email] || []).concat(archiveByEmail[email] || [])
        .concat(currentIdentityEntries).concat(archivedIdentityEntries));
    const all = allByEmail[email] || {};
    const form = formByEmail[email] || {};
    const onboarding = onboardingProfileDefaults(guildId, person.discordId);
    const wasLinked = normalizeDiscordId(currentMerged.values[3]) === person.discordId;
    const oldEmail = normalizeStudentEmail(currentMerged.values[0]);
    if (oldEmail && oldEmail !== email && isSyntheticStudentEmail(oldEmail)) {
      emailMigrations.push({ oldEmail: oldEmail, newEmail: email });
    }
    const name = String(review[5] || all.name || form.name || merged.values[1] || '').trim();
    const phone = validStudentProfilePhone(
      review[6] || all.phone || form.phone || merged.values[7] || '');
    const row = [
      email,
      name,
      person.username,
      person.discordId,
      String(merged.values[4] || '').trim(),
      String(review[7] || all.region || form.region || merged.values[5] || onboarding.region || '').trim(),
      String(review[8] || all.subregion || form.subregion || merged.values[6] || '').trim(),
      phone,
      source,
      !name ? 'Full name required before tracking' : !phone ? 'Valid phone required before tracking' : '',
    ];
    reviewEntries.push({ values: row, emailBackground: merged.emailBackground });
    if (!name || !phone) {
      unmatched.push(Object.assign({}, person, {
        reason: !name
          ? 'matched email but full name is missing; private profile confirmation required'
          : 'matched email but phone is missing or invalid; private profile confirmation required',
      }));
      return;
    }
    active.push({ values: row, emailBackground: merged.emailBackground });
    activeEmails[email] = true;
    if (wasLinked) kept++;
    else linkedNow++;
  });

  // Roster Review is the complete Discord-primary intake list, including
  // unmatched members. Write it before the Bot_Map replacement safety gate so
  // a new cohort can collect private profiles even when no one matches yet.
  const rosterReview = writeRosterReview(people, reviewEntries, unmatched, guildId);

  const archiveEntries = [];
  let duplicatesMerged = Object.keys(existingByEmail).reduce(function (count, email) {
    return count + Math.max(0, existingByEmail[email].length - 1);
  }, 0);
  existingEntries.forEach(function (entry) {
    const email = normalizeStudentEmail(entry.values[0]);
    if (activeEmails[email]) {
      const rows = existingByEmail[email] || [];
      if (rows.length > 1) {
        archiveEntries.push({ values: entry.values, reason: 'duplicate row merged during Discord sync' });
      }
      return;
    }
    archiveEntries.push({ values: entry.values, reason: 'not matched to a current Discord student' });
  });
  const archived = archiveBotMapRows(archiveEntries);

  emailMigrations.forEach(function (migration) {
    migrateStudentEmail(migration.oldEmail, migration.newEmail);
  });

  const previousRows = Math.max(0, map.getLastRow() - 1);
  if (previousRows) {
    map.getRange(2, 1, previousRows, Math.max(map.getLastColumn(), BOT_MAP_HEADERS.length))
      .clearContent()
      .setBackground('#ffffff');
  }
  if (active.length) {
    map.getRange(2, 1, active.length, BOT_MAP_HEADERS.length)
      .setValues(active.map(function (entry) { return entry.values; }));
    for (let i = 0; i < active.length; i++) {
      map.getRange(i + 2, 1).setBackground(active[i].emailBackground || '#ffffff');
    }
  }
  const excessRows = previousRows - active.length;
  if (excessRows > 0) map.deleteRows(active.length + 2, excessRows);
  map.autoResizeColumns(1, BOT_MAP_HEADERS.length);

  const allDataSync = syncAllDataRosterEntries(active);

  const matrixUpdates = {
    attendance: upsertActiveIdentityRows(
      CONFIG.SHEETS.matrix, active, ATTENDANCE_HEADERS),
    jobs: upsertActiveIdentityRows(
      CONFIG.SHEETS.jobsMatrix, active, ['Name', 'Email', 'Phone']),
    outreach: upsertActiveIdentityRows(
      CONFIG.SHEETS.outreachMatrix, active, ['Name', 'Email', 'Phone']),
    interviewMatrix: upsertActiveIdentityRows(
      CONFIG.SHEETS.interviewMatrix, active, ['Name', 'Email', 'Phone']),
    jobSheets: upsertJobSheetRosterRows(active),
    interviews: { readyStudents: active.length, eventRowsPreserved: true },
  };
  const statusStyles = refreshStudentStatusStyles(guildId);
  return {
    activeRows: active.length,
    linkedNow: linkedNow,
    kept: kept,
    unmatched: unmatched,
    duplicatesMerged: duplicatesMerged,
    archived: archived,
    allDataRows: allData.length,
    enrollmentRows: enrollment.records.length,
    enrollmentSourceTabs: enrollment.sourceTabs,
    missingPhone: unmatched.filter(function (entry) {
      return /phone/i.test(String(entry.reason || ''));
    }).length,
    matrixUpdates: matrixUpdates,
    statusStyles: statusStyles,
    allDataSync: allDataSync,
    rosterReview: rosterReview,
    archiveIdentityRowsRead: archivedEntries.length,
    identityPending: unmatched.length,
    provisionalCreated: 0,
  };
}

function appendToBotMap(email, name, username, discordId, phone, source) {
  email = validStudentProfileEmail(email);
  phone = validStudentProfilePhone(phone);
  if (!email || !phone || !String(name || '').trim()) {
    throw new Error('A real email, full name, and valid phone are required before tracking');
  }
  const map = ensureBotMap();
  const data = map.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (normalizeStudentEmail(data[i][0]) === email) {
      // exists: just fill username/id if empty
      if (username && !String(data[i][2]).trim()) map.getRange(i + 1, 3).setValue(username);
      if (discordId && !String(data[i][3]).trim()) map.getRange(i + 1, 4).setValue("'" + discordId);
      if (phone && !String(data[i][7] || '').trim()) map.getRange(i + 1, 8).setValue(phone);
      if (source && !String(data[i][8] || '').trim()) map.getRange(i + 1, 9).setValue(source);
      return 'updated';
    }
  }
  map.appendRow([
    email, name, username || '', discordId ? "'" + discordId : '',
    '', '', '', phone || '', source || 'Manual supervisor link', phone ? '' : 'Missing phone/contact data',
  ]);
  return 'added';
}

function appendToAttendance(email, name, phone) {
  const sh = getSpreadsheet().getSheetByName(CONFIG.SHEETS.matrix);
  if (!sh) throw new Error('Attendance tab not found: ' + CONFIG.SHEETS.matrix);
  const data = sh.getDataRange().getValues();
  let result = 'added';
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][CONFIG.MATRIX.emailCol - 1]).trim().toLowerCase() === email) {
      result = 'exists';
      break;
    }
  }
  if (result === 'added') {
    const row = new Array(sh.getLastColumn()).fill('');
    row[0] = name; row[1] = email; row[2] = phone;
    sh.appendRow(row);
  }
  syncTrackingStudent(email, name, phone);
  return result;
}

// Name-only matching is advisory. Discord display names are not verified
// identities, so this audit never writes Bot_Map or Attendance by name alone.
function matchMissing(people) {
  const allData = readAllData();
  const mapped = {};
  for (const s of readBotMap()) mapped[s.email] = true;
  const available = allData.filter(function (a) { return !mapped[a.email]; });

  const added = [], manual = [];
  for (const p of people) {
    const norm = normName(p.displayName);
    const cands = norm
      ? available.filter(function (a) {
          return a.norm === norm || a.norm.indexOf(norm) !== -1 || norm.indexOf(a.norm) !== -1;
        }).slice(0, 3).map(function (a) { return a.name + ' <' + a.email + '>'; })
      : [];
    manual.push({ username: p.username, displayName: p.displayName,
                  discordId: p.discordId, candidates: cands,
                  reason: 'Discord display names are advisory; confirm real email and phone' });
  }
  // ---- reverse direction: All Data students with no Discord presence ----
  const finalMap = {};
  for (const s of readBotMap()) finalMap[s.email] = s;
  const missingFromDiscord = [];
  for (const a of allData) {
    const bm = finalMap[a.email];
    if (!bm) {
      missingFromDiscord.push({ name: a.name, email: a.email, phone: a.phone,
        reason: 'not enrolled & not found in Discord' });
    } else if (!bm.discordId) {
      missingFromDiscord.push({ name: a.name, email: a.email, phone: a.phone,
        reason: 'enrolled but no Discord account linked' });
    }
  }

  return { added: added, manual: manual, missingFromDiscord: missingFromDiscord };
}

// Manual link: require a complete trusted record from a recognized Sheet tab.
function addStudent(email, discordId, username, displayName) {
  email = validStudentProfileEmail(email);
  if (!email) return { error: 'A real student email is required; generated Discord-domain emails are rejected' };
  const rec = readAllData().find(function (a) { return a.email === email; });
  const form = enrollmentIdentityRecords().records.find(function (a) {
    return a.email === email;
  }) || {};
  const archived = mergeExistingBotMapRows(readBotMapArchiveEntries().filter(function (entry) {
    return normalizeStudentEmail(entry.values[0]) === email;
  }));
  const name = (rec && rec.name) || form.name || archived.values[1] || '';
  const phone = validStudentProfilePhone(
    (rec && rec.phone) || form.phone || archived.values[7] || '');
  if (!name || !phone) {
    return { error: 'The matched Sheet record needs a full name and valid phone; use !editprofile for this student' };
  }
  const mapResult = appendToBotMap(email, name, username, discordId, phone, 'Manual supervisor link');
  const map = ensureBotMap();
  const data = map.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (normalizeStudentEmail(data[i][0]) !== email) continue;
    map.getRange(i + 1, 6, 1, 3).setValues([[
      (rec && rec.region) || form.region || archived.values[5] || '',
      (rec && rec.subregion) || form.subregion || archived.values[6] || '',
      phone || form.phone || archived.values[7] || '',
    ]]);
    break;
  }
  const attResult = appendToAttendance(email, name, phone);
  return { name: name, email: email, inAllData: !!rec, botMap: mapResult, attendance: attResult };
}

function checkProfileSubmissionAttemptLimit(discordId) {
  const id = normalizeDiscordId(discordId);
  const key = PROFILE_SUBMISSION_ATTEMPT_PREFIX + id;
  const props = PropertiesService.getScriptProperties();
  let state = {};
  try { state = JSON.parse(props.getProperty(key) || '{}'); }
  catch (e) { state = {}; }
  const now = Date.now();
  if (!state.windowStart || now - Number(state.windowStart) > 60 * 60 * 1000) {
    state = { windowStart: now, count: 0 };
  }
  state.count = Number(state.count || 0) + 1;
  props.setProperty(key, JSON.stringify(state));
  if (state.count > 5) {
    throw new Error('Too many private-data submissions; wait one hour or contact your mentor');
  }
  return key;
}

function recordProfileSurveyDeliveries(items) {
  return withScriptLock(function () {
    return recordProfileSurveyDeliveriesCore(items);
  });
}

function recordProfileSurveyDeliveriesCore(items) {
  const sheet = ensureRosterReview();
  const data = sheet.getDataRange().getValues();
  const rowById = {};
  for (let i = 1; i < data.length; i++) {
    const id = normalizeDiscordId(data[i][0]);
    if (id) rowById[id] = i + 1;
  }
  const allowed = {
    SENT: true,
    'DM BLOCKED': true,
    'NOT IN SERVER': true,
  };
  const stamp = Utilities.formatDate(new Date(), CONFIG.TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
  let recorded = 0;
  let missing = 0;
  (items || []).forEach(function (item) {
    const id = normalizeDiscordId(item && item.discordId);
    const status = String(item && item.status || '').trim().toUpperCase();
    let row = rowById[id];
    if (!id || !allowed[status]) {
      missing++;
      return;
    }
    if (!row) {
      row = sheet.getLastRow() + 1;
      const created = [
        "'" + id,
        cleanStudentProfileText(item.username, 100),
        cleanStudentProfileText(item.displayName || item.username, 100),
        'PROFILE INCOMPLETE', '', '', '', '', '',
        'Discord join private profile intake',
        'Email and phone required before attendance identity is complete',
        stamp, status, status === 'SENT' ? stamp : '', '',
      ];
      ensureSheetSize(sheet, row, ROSTER_REVIEW_HEADERS.length);
      sheet.getRange(row, 1, 1, ROSTER_REVIEW_HEADERS.length)
        .setValues([created])
        .setBackground('#fff2cc');
      rowById[id] = row;
      recorded++;
      return;
    }
    const rowValues = data[row - 1];
    const current = String(rowValues[12] || '').trim().toUpperCase();
    if (current === 'COMPLETED') return;
    rowValues[12] = status;
    if (status === 'SENT') rowValues[13] = stamp;
    recorded++;
  });
  if (recorded && data.length > 1) {
    sheet.getRange(2, 13, data.length - 1, 2).setValues(data.slice(1).map(function (row) {
      return [row[12] || '', row[13] || ''];
    }));
  }
  return { recorded: recorded, missing: missing, attempted: (items || []).length };
}

function updateRosterReviewVerification(discordId, record, username, displayName, source, reviewNote) {
  const sheet = ensureRosterReview();
  const data = sheet.getDataRange().getValues();
  const id = normalizeDiscordId(discordId);
  let row = -1;
  for (let i = 1; i < data.length; i++) {
    if (normalizeDiscordId(data[i][0]) === id) {
      row = i + 1;
      break;
    }
  }
  if (row === -1) row = sheet.getLastRow() + 1;
  const stamp = Utilities.formatDate(new Date(), CONFIG.TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
  const previous = row <= sheet.getLastRow()
    ? sheet.getRange(row, 1, 1, ROSTER_REVIEW_HEADERS.length).getDisplayValues()[0]
    : [];
  const values = [
    "'" + id,
    String(username || ''),
    String(displayName || username || ''),
    'VERIFIED',
    record.email,
    record.name,
    record.phone || '',
    record.region || '',
    record.subregion || '',
    source,
    String(reviewNote || '').slice(0, 1000),
    stamp,
    'COMPLETED',
    previous[13] || '',
    stamp,
  ];
  ensureSheetSize(sheet, row, ROSTER_REVIEW_HEADERS.length);
  sheet.getRange(row, 1, 1, ROSTER_REVIEW_HEADERS.length)
    .setValues([values])
    .setBackground('#d9ead3');
}

function onboardingProfileDefaults(guildId, discordId) {
  guildId = normalizeDiscordId(guildId);
  discordId = normalizeDiscordId(discordId);
  if (!guildId || !discordId) return {};
  const key = 'ob_' + guildId + '_user_' + discordId;
  let record = {};
  try {
    record = JSON.parse(PropertiesService.getScriptProperties().getProperty(key) || '{}');
  } catch (e) {
    record = {};
  }
  return {
    region: cleanStudentProfileText(record.division, 100),
  };
}

function intakeAnswerKey(answer) {
  return String(answer && answer.key || '').toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_').slice(0, 80);
}

function intakeHeader(answer) {
  const key = intakeAnswerKey(answer);
  const title = cleanStudentProfileText(answer && answer.title, 180) || key || 'Question';
  return title + (key ? ' [' + key + ']' : '');
}

function ensureIntakeResponseSchema(answers) {
  const sheet = ensureTab(intakeResponsesName(), INTAKE_BASE_HEADERS);
  let headers = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn()))
    .getDisplayValues()[0].map(String);
  INTAKE_BASE_HEADERS.forEach(function (header) {
    if (headers.indexOf(header) !== -1) return;
    sheet.getRange(1, headers.length + 1).setValue(header);
    headers.push(header);
  });
  (answers || []).forEach(function (answer) {
    const header = intakeHeader(answer);
    if (headers.indexOf(header) !== -1) return;
    const key = intakeAnswerKey(answer);
    const existingIndex = key
      ? headers.findIndex(function (existing) { return String(existing).endsWith(' [' + key + ']'); })
      : -1;
    if (existingIndex !== -1) {
      sheet.getRange(1, existingIndex + 1).setValue(header);
      headers[existingIndex] = header;
      return;
    }
    sheet.getRange(1, headers.length + 1).setValue(header);
    headers.push(header);
  });
  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold').setBackground('#d9ead3');
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(Math.min(9, headers.length));
  return { sheet: sheet, headers: headers };
}

function upsertAllDataFromIntake(profile) {
  const schema = ensureAllDataProfileColumns();
  const sheet = schema.sheet;
  const columns = schema.columns;
  const data = sheet.getDataRange().getValues();
  const idRows = [];
  const emailRows = [];
  for (let i = 1; i < data.length; i++) {
    if (normalizeDiscordId(data[i][columns.discordId]) === profile.discordId) idRows.push(i + 1);
    if (normalizeStudentEmail(data[i][columns.email]) === profile.email) emailRows.push(i + 1);
  }
  if (idRows.length > 1 || emailRows.length > 1) {
    throw new Error('All Data contains duplicate identity rows; a supervisor must resolve them');
  }
  if (idRows.length && emailRows.length && idRows[0] !== emailRows[0]) {
    throw new Error('Discord ID and enrollment email belong to different All Data rows');
  }
  const rowNumber = idRows[0] || emailRows[0] || sheet.getLastRow() + 1;
  const width = Math.max(sheet.getLastColumn(), 7);
  const row = rowNumber <= sheet.getLastRow()
    ? sheet.getRange(rowNumber, 1, 1, width).getValues()[0]
    : new Array(width).fill('');
  const existingId = normalizeDiscordId(row[columns.discordId]);
  const existingEmail = normalizeStudentEmail(row[columns.email]);
  if (existingId && existingId !== profile.discordId) {
    throw new Error('Enrollment email is already linked to another Discord account');
  }
  if (existingEmail && existingEmail !== profile.email) {
    throw new Error('This Discord account is already linked to a different enrollment email; ask your mentor to correct it');
  }
  row[columns.email] = profile.email;
  // A Discord-OAuth-bound intake resubmission is the student's authoritative
  // update path for mutable profile details. Immutable Discord/email conflicts
  // above still fail closed.
  row[columns.name] = profile.name;
  row[columns.phone] = profile.phone;
  row[columns.region] = profile.region;
  row[columns.subregion] = profile.subregion;
  row[columns.username] = profile.username;
  row[columns.discordId] = "'" + profile.discordId;
  ensureSheetSize(sheet, rowNumber, width);
  sheet.getRange(rowNumber, 1, 1, width).setValues([row]);
  return rowNumber <= data.length ? 'updated' : 'added';
}

function submitIntakeApplication(body) {
  body = body || {};
  const submissionId = String(body.submissionId || '').trim();
  const discordId = normalizeDiscordId(body.discordId);
  const answers = Array.isArray(body.answers) ? body.answers.slice(0, 80) : [];
  if (!/^[a-f0-9-]{16,64}$/i.test(submissionId)) return { error: 'Valid submission ID is required' };
  if (!discordId) return { error: 'Discord ID is required' };
  if (normalizeDiscordId(body.guildId) === '') return { error: 'Discord server ID is required' };
  const rawProfile = body.profile || {};
  const profile = {
    email: validStudentProfileEmail(rawProfile.email),
    name: cleanStudentProfileText(rawProfile.name, 100),
    phone: normalizeStudentProfilePhone(rawProfile.phone),
    region: cleanStudentProfileText(rawProfile.region, 100),
    subregion: cleanStudentProfileText(rawProfile.subregion, 100),
    username: cleanStudentProfileText(body.username, 100),
    discordId: discordId,
  };
  if (!profile.email || !profile.name || !profile.phone || !profile.region ||
      (/^dhaka$/i.test(profile.region) && !profile.subregion)) {
    return { error: 'Name, real enrollment email, phone and region are required; Dhaka members must also select an area' };
  }
  return withScriptLock(function () {
    const schema = ensureIntakeResponseSchema(answers);
    const sheet = schema.sheet;
    const headers = schema.headers;
    const data = sheet.getDataRange().getValues();
    const idColumn = headers.indexOf('Submission ID');
    let rowNumber = sheet.getLastRow() + 1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idColumn] || '').trim() === submissionId) {
        rowNumber = i + 1;
        break;
      }
    }
    const now = Utilities.formatDate(new Date(), CONFIG.TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
    const row = rowNumber <= sheet.getLastRow()
      ? sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0]
      : new Array(headers.length).fill('');
    function put(header, value) {
      const index = headers.indexOf(header);
      if (index >= 0) row[index] = value;
    }
    put('Submission ID', submissionId);
    if (!row[headers.indexOf('Submitted At')]) put('Submitted At', now);
    put('Updated At', now);
    put('Admission Status', 'SUBMITTED - AWAITING DISCORD');
    put('Admission Detail', '');
    put('Cohort', CONFIG.COHORT);
    put('Discord ID', "'" + discordId);
    put('Discord Username', profile.username);
    put('Discord Display Name', cleanStudentProfileText(body.displayName || body.globalName || profile.username, 100));
    answers.forEach(function (answer) {
      const index = headers.indexOf(intakeHeader(answer));
      if (index >= 0) row[index] = cleanStudentProfileText(answer.value, 4000);
    });
    ensureSheetSize(sheet, rowNumber, headers.length);
    sheet.getRange(rowNumber, 1, 1, headers.length).setValues([row]);
    const allData = upsertAllDataFromIntake(profile);
    return { saved: true, submissionId: submissionId, row: rowNumber, allData: allData };
  });
}

function updateIntakeApplicationStatus(body) {
  body = body || {};
  const submissionId = String(body.submissionId || '').trim();
  if (!/^[a-f0-9-]{16,64}$/i.test(submissionId)) return { error: 'Valid submission ID is required' };
  return withScriptLock(function () {
    const schema = ensureIntakeResponseSchema([]);
    const sheet = schema.sheet;
    const headers = schema.headers;
    const data = sheet.getDataRange().getValues();
    const idColumn = headers.indexOf('Submission ID');
    let rowNumber = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idColumn] || '').trim() === submissionId) {
        rowNumber = i + 1;
        break;
      }
    }
    if (rowNumber === -1) return { error: 'Intake submission was not found' };
    const now = Utilities.formatDate(new Date(), CONFIG.TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
    sheet.getRange(rowNumber, headers.indexOf('Updated At') + 1).setValue(now);
    sheet.getRange(rowNumber, headers.indexOf('Admission Status') + 1)
      .setValue(cleanStudentProfileText(body.status, 100));
    sheet.getRange(rowNumber, headers.indexOf('Admission Detail') + 1)
      .setValue(cleanStudentProfileText(body.detail, 500));
    return { saved: true, submissionId: submissionId, row: rowNumber };
  });
}

function getIntakeRoleProfiles(discordIds) {
  const requested = {};
  (discordIds || []).slice(0, 500).forEach(function (value) {
    const id = normalizeDiscordId(value);
    if (id) requested[id] = true;
  });
  if (!Object.keys(requested).length) return { profiles: [] };
  const sheet = SpreadsheetApp.getActive().getSheetByName(intakeResponsesName());
  if (!sheet || sheet.getLastRow() < 2) return { profiles: [] };
  const values = sheet.getDataRange().getDisplayValues();
  const headers = values[0].map(String);
  const idIndex = headers.indexOf('Discord ID');
  const updatedIndex = headers.indexOf('Updated At');
  if (idIndex < 0) return { error: 'Intake Responses has no Discord ID column' };
  const intakeKeyMap = {
    region: 'region',
    subregion: 'subregion',
    genderpreference: 'genderPreference',
    studystage: 'studyStage',
    availability: 'availability',
    jobfocus: 'jobFocus',
    englishcommunication: 'englishCommunication',
    technologies: 'technologies',
  };
  const latest = {};
  for (let rowIndex = 1; rowIndex < values.length; rowIndex++) {
    const id = normalizeDiscordId(values[rowIndex][idIndex]);
    if (!requested[id]) continue;
    const stamp = updatedIndex >= 0 ? String(values[rowIndex][updatedIndex] || '') : '';
    if (latest[id] && latest[id].stamp > stamp) continue;
    const answers = {};
    headers.forEach(function (header, columnIndex) {
      const match = String(header).match(/\[([a-zA-Z0-9_]+)\]\s*$/);
      const storedKey = match && String(match[1]).toLowerCase();
      const key = intakeKeyMap[storedKey];
      if (key) answers[key] = String(values[rowIndex][columnIndex] || '');
    });
    latest[id] = { discordId: id, stamp: stamp, answers: answers };
  }
  return {
    profiles: Object.keys(latest).map(function (id) { return latest[id]; }),
  };
}

function saveOnboardingFromIntake(guildId, discordId, input) {
  guildId = normalizeDiscordId(guildId);
  discordId = normalizeDiscordId(discordId);
  input = input || {};
  if (!guildId || !discordId) return false;
  const allowedGender = ['female', 'male', 'private'];
  const allowedDivision = ['Barishal', 'Chattogram', 'Dhaka', 'Khulna', 'Mymensingh', 'Rajshahi', 'Rangpur', 'Sylhet', 'Abroad', 'Other'];
  const allowedAvailability = ['full_time', 'limited', 'study'];
  const allowedStudy = ['graduated', 'university_final', 'university_early', 'college', 'school', 'other'];
  const allowedJobFocus = ['remote', 'onsite', 'hybrid'];
  const allowedEnglish = ['basic', 'advanced', 'expert'];
  const gender = String(input.gender || '');
  const division = String(input.division || '');
  const availability = String(input.availability || '');
  const studyStage = String(input.studyStage || '');
  const subregion = cleanStudentProfileText(input.subregion, 100);
  const jobFocus = String(input.jobFocus || '');
  const englishLevel = String(input.englishLevel || '');
  const skills = Array.isArray(input.skills)
    ? input.skills.map(function (skill) {
      return cleanStudentProfileText(skill, 80);
    }).filter(Boolean).slice(0, 25)
    : [];
  if (allowedGender.indexOf(gender) === -1 && allowedDivision.indexOf(division) === -1 &&
      allowedAvailability.indexOf(availability) === -1 && allowedStudy.indexOf(studyStage) === -1 &&
      allowedJobFocus.indexOf(jobFocus) === -1 && allowedEnglish.indexOf(englishLevel) === -1 &&
      !skills.length) {
    return false;
  }
  const key = 'ob_' + guildId + '_user_' + discordId;
  const props = PropertiesService.getScriptProperties();
  let record = {};
  try { record = JSON.parse(props.getProperty(key) || '{}'); }
  catch (e) { record = {}; }
  record.userId = discordId;
  // A new authenticated intake submission updates mutable role-profile answers
  // instead of leaving stale values from an earlier submission.
  if (allowedGender.indexOf(gender) !== -1) record.gender = gender;
  if (allowedDivision.indexOf(division) !== -1) {
    record.division = division;
    record.subregion = division === 'Dhaka' ? subregion : '';
  }
  if (allowedAvailability.indexOf(availability) !== -1) record.availability = availability;
  if (allowedStudy.indexOf(studyStage) !== -1) record.studyStage = studyStage;
  if (allowedJobFocus.indexOf(jobFocus) !== -1) record.jobFocus = jobFocus;
  if (allowedEnglish.indexOf(englishLevel) !== -1) record.englishLevel = englishLevel;
  if (skills.length) record.skills = skills;
  record.updatedAt = new Date().toISOString();
  props.setProperty(key, JSON.stringify(record));
  return Boolean(record.gender || record.division || record.availability || record.studyStage ||
    record.jobFocus || record.englishLevel || (record.skills && record.skills.length));
}

function submitStudentProfile(body) {
  body = body || {};
  const discordId = normalizeDiscordId(body.discordId);
  const fields = body.fields || {};
  const adminOverride = body.adminOverride === true;
  if (!discordId) return { error: 'Discord ID is required' };
  if (adminOverride && !normalizeDiscordId(body.supervisorId)) {
    return { error: 'Supervisor ID is required for a manual profile correction' };
  }
  return withScriptLock(function () {
    const attemptKey = adminOverride ? '' : checkProfileSubmissionAttemptLimit(discordId);
    const reviewSheet = ensureRosterReview();
    const reviewData = reviewSheet.getDataRange().getValues();
    let reviewRow = null;
    for (let i = 1; i < reviewData.length; i++) {
      if (normalizeDiscordId(reviewData[i][0]) === discordId) {
        reviewRow = reviewData[i];
        break;
      }
    }
    if (!reviewRow) {
      // The bot has already verified this immutable Discord ID is a current
      // guild member. Accept the profile even if an older Roster Review sheet
      // has not captured the member yet; the verified row is written below.
      reviewRow = [
        "'" + discordId,
        cleanStudentProfileText(body.username, 100),
        cleanStudentProfileText(body.displayName || body.username, 100),
        'NEEDS PRIVATE VERIFICATION', '', '', '', '', '', '',
        'Created from Discord-bound private profile survey', '', '', '', '',
      ];
    }

    const suppliedEmail = fields.email === undefined
      ? ''
      : validStudentProfileEmail(fields.email);
    if (fields.email !== undefined && !suppliedEmail) {
      return { error: 'Enter a valid enrollment email address' };
    }
    const suppliedName = fields.name === undefined
      ? ''
      : cleanStudentProfileText(fields.name, 100);
    if (fields.name !== undefined && suppliedName.length < 2) {
      return { error: 'Enter a valid full name' };
    }
    const suppliedPhone = fields.phone === undefined
      ? ''
      : normalizeStudentProfilePhone(fields.phone);
    const suppliedRegion = fields.region === undefined
      ? ''
      : cleanStudentProfileText(fields.region, 100);
    const suppliedSubregion = fields.subregion === undefined
      ? ''
      : cleanStudentProfileText(fields.subregion, 100);
    if (fields.region !== undefined && !suppliedRegion) {
      return { error: 'Enter a division or current region' };
    }
    if (fields.subregion !== undefined && /^dhaka$/i.test(suppliedRegion) && !suppliedSubregion) {
      return { error: 'Choose a Dhaka area when the current division is Dhaka' };
    }

    const current = readBotMap();
    const linkedById = current.find(function (student) {
      return student.discordId === discordId;
    }) || null;
    const reviewEmail = validStudentProfileEmail(reviewRow[4]);
    const linkedEmail = linkedById && !isSyntheticStudentEmail(linkedById.email)
      ? linkedById.email
      : '';
    const email = adminOverride
      ? suppliedEmail
      : linkedEmail || (linkedById && suppliedEmail) || reviewEmail || suppliedEmail;
    if (!email) return { error: 'Enrollment email is required to link this profile' };
    const emailConflict = current.find(function (student) {
      return student.email === email && student.discordId && student.discordId !== discordId;
    });
    if (emailConflict) {
      return { error: 'That student email is already linked to another Discord account' };
    }
    const allRecord = readAllData().find(function (student) {
      return student.email === email;
    }) || {};
    const legacyRecord = enrollmentIdentityRecords().records.find(function (student) {
      return student.email === email;
    }) || {};
    const referenceRecord = allRecord.email ? allRecord : legacyRecord;
    const referencePhone = validStudentProfilePhone(referenceRecord.phone);
    if (!adminOverride && referencePhone && suppliedPhone &&
        referencePhone !== validStudentProfilePhone(suppliedPhone)) {
      return {
        error: 'That email and phone do not match the existing Sheet record; ask a mentor to verify it privately',
      };
    }
    const archiveRows = readBotMapArchiveEntries().filter(function (entry) {
      return normalizeStudentEmail(entry.values[0]) === email;
    });
    const archived = mergeExistingBotMapRows(archiveRows);
    const archivedStatus = String(archived.values[4] || '').trim().toLowerCase();
    const preservedStatus = String((linkedById && linkedById.status) || archivedStatus || '').trim();
    const onboardingDefaults = onboardingProfileDefaults(body.guildId, discordId);

    const previousEmail = normalizeStudentEmail(
      (linkedById && linkedById.email) || reviewEmail || '');
    if (previousEmail && previousEmail !== email &&
        (adminOverride || isSyntheticStudentEmail(previousEmail))) {
      migrateStudentEmail(previousEmail, email);
    }

    const profile = {
      email: email,
      name: String(adminOverride
        ? suppliedName
        : referenceRecord.name || (linkedById && linkedById.name) || reviewRow[5] || suppliedName).trim(),
      phone: validStudentProfilePhone(adminOverride
        ? suppliedPhone
        : referenceRecord.phone || (linkedById && linkedById.phone) || reviewRow[6] || suppliedPhone),
      region: String(adminOverride
        ? suppliedRegion
        : referenceRecord.region || (linkedById && linkedById.region) || reviewRow[7] ||
          suppliedRegion || onboardingDefaults.region || '').trim(),
      subregion: String(adminOverride
        ? suppliedSubregion
        : referenceRecord.subregion || (linkedById && linkedById.subregion) ||
          reviewRow[8] || suppliedSubregion).trim(),
      username: cleanStudentProfileText(body.username, 100),
      discordId: discordId,
    };
    if (!/^dhaka$/i.test(profile.region)) profile.subregion = '';
    // Student submissions only fill empty authoritative values. Existing
    // non-empty All Data values are never silently overwritten.
    if (!profile.name) profile.name = suppliedName;
    if (!profile.phone) profile.phone = suppliedPhone;
    if (!profile.region) profile.region = suppliedRegion;
    if (!profile.subregion) profile.subregion = suppliedSubregion;
    const missing = [];
    if (!profile.name) missing.push('name');
    if (!profile.email) missing.push('email');
    if (!validStudentProfilePhone(profile.phone)) missing.push('phone');
    if (!profile.region) missing.push('region');
    if (/^dhaka$/i.test(profile.region) && !profile.subregion) missing.push('subregion');
    if (missing.length) {
      return { error: 'Required profile fields are still missing: ' + missing.join(', ') };
    }

    const reviewNotes = adminOverride
      ? ['Supervisor correction by Discord ID ' + normalizeDiscordId(body.supervisorId)]
      : [];
    if (!adminOverride && suppliedEmail && suppliedEmail !== email) {
      reviewNotes.push('Submitted email "' + suppliedEmail + '" differs from the Discord-linked email; linked value retained');
    }
    if (!adminOverride && referenceRecord.name && suppliedName && normName(referenceRecord.name) !== normName(suppliedName)) {
      reviewNotes.push('Submitted name "' + suppliedName + '" differs from the existing Sheet record; existing value retained');
    }
    if (!adminOverride && referenceRecord.region && suppliedRegion &&
        normName(referenceRecord.region) !== normName(suppliedRegion)) {
      reviewNotes.push('Submitted region "' + suppliedRegion + '" differs from the existing Sheet record; existing value retained');
    }
    if (!adminOverride && referenceRecord.subregion && suppliedSubregion &&
        normName(referenceRecord.subregion) !== normName(suppliedSubregion)) {
      reviewNotes.push('Submitted subregion "' + suppliedSubregion + '" differs from the existing Sheet record; existing value retained');
    }

    const allDataResult = upsertAllDataFromStudentProfile(profile, adminOverride);
    const savedRecord = readAllData().find(function (student) {
      return student.email === email;
    });
    if (!savedRecord) {
      throw new Error('All Data write could not be verified; Bot_Map was not updated');
    }
    const enriched = {
      email: email,
      name: savedRecord.name,
      phone: savedRecord.phone,
      region: savedRecord.region,
      subregion: savedRecord.subregion,
    };

    appendToBotMap(
      email, enriched.name, profile.username, discordId, enriched.phone,
      adminOverride ? 'Supervisor private profile correction' : 'Private student data survey');
    const map = ensureBotMap();
    const mapData = map.getDataRange().getValues();
    let savedMapRow = null;
    for (let i = 1; i < mapData.length; i++) {
      if (normalizeStudentEmail(mapData[i][0]) !== email) continue;
      savedMapRow = [
        email,
        enriched.name,
        profile.username || mapData[i][2] || '',
        "'" + discordId,
        mapData[i][4] || preservedStatus,
        enriched.region,
        enriched.subregion,
        enriched.phone,
        adminOverride ? 'Supervisor private profile correction' : 'Private student data survey',
        '',
      ];
      map.getRange(i + 1, 1, 1, BOT_MAP_HEADERS.length).setValues([savedMapRow]);
      break;
    }
    if (!savedMapRow) throw new Error('Bot_Map write could not be verified');

    const inactiveStatus = preservedStatus.toLowerCase() === 'hired' || preservedStatus.toLowerCase() === 'left';
    if (!inactiveStatus) {
      const activeEntry = [{ values: savedMapRow }];
      upsertActiveIdentityRows(
        CONFIG.SHEETS.matrix, activeEntry, ATTENDANCE_HEADERS);
      upsertActiveIdentityRows(
        CONFIG.SHEETS.jobsMatrix, activeEntry, ['Name', 'Email', 'Phone']);
      upsertActiveIdentityRows(
        CONFIG.SHEETS.outreachMatrix, activeEntry, ['Name', 'Email', 'Phone']);
      upsertActiveIdentityRows(
        CONFIG.SHEETS.interviewMatrix, activeEntry, ['Name', 'Email', 'Phone']);
      upsertJobSheetRosterRows(activeEntry);
    }
    updateRosterReviewVerification(
      discordId, enriched, profile.username, body.displayName || profile.username,
      adminOverride
        ? (inactiveStatus
          ? 'Supervisor private profile correction (inactive status preserved)'
          : 'Supervisor private profile correction')
        : (inactiveStatus
          ? 'Private student data survey (inactive status preserved)'
          : 'Private student data survey'),
      reviewNotes.join('; '));

    const onboardingPrefilled = adminOverride
      ? false
      : saveOnboardingFromIntake(body.guildId, discordId, body.onboarding || {});

    if (attemptKey) PropertiesService.getScriptProperties().deleteProperty(attemptKey);
    const remainingMissing = missingStudentProfileFields([
      discordId, profile.username, body.displayName || profile.username, 'VERIFIED',
      enriched.email, enriched.name, enriched.phone, enriched.region,
      enriched.subregion, 'Private student data survey', '', '',
    ]);
    return {
      saved: true,
      allData: allDataResult,
      reviewRequired: reviewNotes.length > 0,
      remainingMissing: remainingMissing,
      onboardingPrefilled: onboardingPrefilled,
    };
  });
}

// ============================================================
//  OUTREACH TRACKING
//  Outreach_Log: Email | Name | Discord ID | First Post | Last Post | Total Posts
//  One row per student. Dates are yyyy-MM-dd strings (Dhaka time).
// ============================================================
function ensureOutreachLog() {
  const ss = getSpreadsheet();
  let sh = ss.getSheetByName(CONFIG.SHEETS.outreachLog);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.SHEETS.outreachLog);
    sh.appendRow(['Email', 'Name', 'Discord ID', 'First Post', 'Last Post', 'Total Posts']);
    sh.setFrozenRows(1);
  }
  return sh;
}

function findStudent(email) {
  return readBotMap().find(function (s) { return s.email === email; }) || null;
}

function ensureOutreachDailySchema() {
  const headers = ['Date', 'Email', 'Discord Message ID', 'Discord Message', 'Logged At'];
  const sh = ensureTab(CONFIG.SHEETS.outreachDaily, headers);
  if (sh.getMaxColumns() < headers.length) {
    sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
  }
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  return sh;
}

function reconcileOutreachSummary(email) {
  email = normalizeStudentEmail(email);
  const daily = ensureOutreachDailySchema();
  const events = daily.getDataRange().getValues();
  const dates = [];
  for (let i = 1; i < events.length; i++) {
    if (normalizeStudentEmail(events[i][1]) !== email) continue;
    const date = normalizeSheetDate(events[i][0]);
    if (date) dates.push(date);
  }
  if (!dates.length) return { email: email, total: 0, first: '', last: '' };
  dates.sort();
  const student = findStudent(email) || { email: email, name: email, discordId: '' };
  const log = ensureOutreachLog();
  const rows = log.getDataRange().getValues();
  let row = 0;
  for (let i = 1; i < rows.length; i++) {
    if (normalizeStudentEmail(rows[i][0]) === email) { row = i + 1; break; }
  }
  const values = [[
    email,
    student.name || email,
    student.discordId ? "'" + student.discordId : '',
    dates[0],
    dates[dates.length - 1],
    dates.length,
  ]];
  if (row) log.getRange(row, 1, 1, 6).setValues(values);
  else log.getRange(log.getLastRow() + 1, 1, 1, 6).setValues(values);
  return { email: email, total: dates.length, first: dates[0], last: dates[dates.length - 1] };
}

// Rebuild every summary represented in the durable event log in one bounded
// pass. Legacy summary-only rows are preserved, while duplicate summary rows
// are collapsed by normalized email. This repairs cohorts where an earlier
// request saved Outreach_Daily and timed out before updating Outreach_Log.
function reconcileAllOutreachSummaries() {
  const daily = ensureOutreachDailySchema();
  const events = daily.getDataRange().getValues();
  const aggregates = {};
  for (let i = 1; i < events.length; i++) {
    const email = normalizeStudentEmail(events[i][1]);
    const date = normalizeSheetDate(events[i][0]);
    if (!email || !date) continue;
    if (!aggregates[email]) aggregates[email] = [];
    aggregates[email].push(date);
  }

  const students = {};
  readBotMap().forEach(function (student) { students[student.email] = student; });
  const log = ensureOutreachLog();
  const existing = log.getDataRange().getValues();
  const rows = [];
  const rowByEmail = {};
  for (let i = 1; i < existing.length; i++) {
    const email = normalizeStudentEmail(existing[i][0]);
    if (!email || rowByEmail[email] !== undefined) continue;
    rowByEmail[email] = rows.length;
    rows.push(existing[i].slice(0, 6));
  }

  Object.keys(aggregates).sort().forEach(function (email) {
    const dates = aggregates[email].sort();
    const student = students[email] || {};
    const values = [
      email,
      student.name || email,
      student.discordId ? "'" + student.discordId : '',
      dates[0],
      dates[dates.length - 1],
      dates.length,
    ];
    if (rowByEmail[email] === undefined) {
      rowByEmail[email] = rows.length;
      rows.push(values);
    } else {
      rows[rowByEmail[email]] = values;
    }
  });

  if (log.getLastRow() > 1) log.getRange(2, 1, log.getLastRow() - 1, 6).clearContent();
  if (rows.length) log.getRange(2, 1, rows.length, 6).setValues(rows);
  return {
    durableEvents: Math.max(0, events.length - 1),
    reconciledStudents: Object.keys(aggregates).length,
    summaryRows: rows.length,
  };
}

function syncOutreachMatrixDate(dateStr, guildId) {
  const dateKey = normalizeSheetDate(dateStr);
  if (!dateKey) throw new Error('Outreach matrix requires a valid date');
  ensureTab(CONFIG.SHEETS.outreachMatrix, ['Name', 'Email', 'Phone']);
  const daily = ensureOutreachDailySchema();
  const events = daily.getDataRange().getValues();
  const counts = {};
  for (let i = 1; i < events.length; i++) {
    if (normalizeSheetDate(events[i][0]) !== dateKey) continue;
    const email = normalizeStudentEmail(events[i][1]);
    if (email) counts[email] = (counts[email] || 0) + 1;
  }
  return syncTrackingMatrixCounts(
    CONFIG.SHEETS.outreachMatrix, dateKey, counts, true, guildId);
}

// Live logging is recoverable as well as idempotent. If an earlier request
// saved Outreach_Daily but timed out before the summary/matrix update, retrying
// the same Discord message repairs both downstream views instead of returning
// early and leaving them stale.
function logOutreach(email, dateStr, guildId, messageId, messageUrl) {
  email = normalizeStudentEmail(email);
  if (!email) return { error: 'no email' };
  messageId = normalizeDiscordId(messageId);
  messageUrl = String(messageUrl || '').trim().slice(0, 1000);
  return withScriptLock(function () {
    const daily = ensureOutreachDailySchema();
    const dailyData = daily.getDataRange().getValues();
    let duplicate = false;
    let eventEmail = email;
    let eventDate = normalizeSheetDate(dateStr) || todayStr();
    if (messageId) {
      for (let i = 1; i < dailyData.length; i++) {
        if (normalizeDiscordId(dailyData[i][2]) !== messageId) continue;
        duplicate = true;
        eventEmail = normalizeStudentEmail(dailyData[i][1]) || email;
        eventDate = normalizeSheetDate(dailyData[i][0]) || eventDate;
        break;
      }
    }
    if (!duplicate) {
      daily.appendRow([
        eventDate, eventEmail, messageId ? "'" + messageId : '', messageUrl, new Date(),
      ]);
    }
    const summary = reconcileOutreachSummary(eventEmail);
    const matrix = syncOutreachMatrixDate(eventDate, guildId);
    return {
      result: duplicate ? 'duplicate-reconciled' : 'saved',
      duplicate: duplicate,
      email: eventEmail,
      summary: summary,
      matrix: matrix,
    };
  });
}

function backfillOutreachDaily(entries, guildId) {
  return withScriptLock(function () {
    const sh = ensureOutreachDailySchema();
    const data = sh.getDataRange().getValues();
    const existingIds = {};
    const blankRowsByKey = {};
    for (let i = 1; i < data.length; i++) {
      const dateKey = normalizeSheetDate(data[i][0]);
      const email = normalizeStudentEmail(data[i][1]);
      const messageId = normalizeDiscordId(data[i][2]);
      if (messageId) existingIds[messageId] = true;
      else if (dateKey && email) {
        const key = dateKey + '|' + email;
        if (!blankRowsByKey[key]) blankRowsByKey[key] = [];
        blankRowsByKey[key].push(i + 1);
      }
    }

    const additions = [];
    const assignments = [];
    const seenPayload = {};
    const affectedDates = {};
    const affectedEmails = {};
    let duplicates = 0;
    for (const item of (entries || []).slice(0, 500)) {
      const dateKey = normalizeSheetDate(item.date);
      const email = normalizeStudentEmail(item.email);
      const messageId = normalizeDiscordId(item.messageId);
      const messageUrl = String(item.messageUrl || '').trim().slice(0, 1000);
      if (!dateKey || !email || !messageId || seenPayload[messageId]) continue;
      seenPayload[messageId] = true;
      affectedDates[dateKey] = true;
      affectedEmails[email] = true;
      if (existingIds[messageId]) { duplicates++; continue; }
      const key = dateKey + '|' + email;
      const blankRow = blankRowsByKey[key] && blankRowsByKey[key].shift();
      if (blankRow) {
        assignments.push({
          row: blankRow,
          values: ["'" + messageId, messageUrl, new Date()],
        });
      } else {
        additions.push([dateKey, email, "'" + messageId, messageUrl, new Date()]);
      }
      existingIds[messageId] = true;
    }
    assignments.forEach(function (item) {
      sh.getRange(item.row, 3, 1, 3).setValues([item.values]);
    });
    if (additions.length) {
      sh.getRange(sh.getLastRow() + 1, 1, additions.length, 5).setValues(additions);
    }

    // Reconcile even duplicate IDs: a previous timed-out call may have saved
    // the event while missing its summary or matrix update.
    Object.keys(affectedEmails).forEach(function (email) {
      reconcileOutreachSummary(email);
    });
    Object.keys(affectedDates).forEach(function (dateKey) {
      syncOutreachMatrixDate(dateKey, guildId);
    });
    return {
      saved: assignments.length + additions.length,
      reconciled: Object.keys(seenPayload).length,
      attachedToExisting: assignments.length,
      created: additions.length,
      duplicatesSkipped: duplicates,
    };
  });
}

// backfill: OVERWRITES stats per student (run once from channel history)
function backfillOutreach(entries) {
  const sh = ensureOutreachLog();
  const data = sh.getDataRange().getValues();
  const rowByEmail = {};
  for (let i = 1; i < data.length; i++) {
    rowByEmail[String(data[i][0]).trim().toLowerCase()] = i + 1;
  }
  let written = 0;
  for (const en of entries) {
    const email = String(en.email || '').trim().toLowerCase();
    if (!email) continue;
    const row = rowByEmail[email];
    if (row) {
      sh.getRange(row, 4, 1, 3).setValues([[en.first, en.last, en.count]]);
    } else {
      const s = findStudent(email);
      sh.appendRow([email, s ? s.name : '', s ? "'" + s.discordId : '', en.first, en.last, en.count]);
    }
    written++;
  }
  return { written: written };
}

// daily check: who never posted / who has gone quiet
function getOutreachStatus(staleDays) {
  const sh = ensureOutreachLog();
  const data = sh.getDataRange().getValues();
  const log = {};
  for (let i = 1; i < data.length; i++) {
    log[String(data[i][0]).trim().toLowerCase()] = {
      last: String(data[i][4]).trim(),
      count: Number(data[i][5] || 0),
    };
  }

  // today's per-student message counts
  const todayCounts = {};
    const dsh = getSpreadsheet().getSheetByName(CONFIG.SHEETS.outreachDaily);
  if (dsh) {
    const dd = dsh.getDataRange().getValues();
    for (let i = 1; i < dd.length; i++) {
      if (normalizeSheetDate(dd[i][0]) !== todayStr()) continue;
      const em = String(dd[i][1]).trim().toLowerCase();
      todayCounts[em] = (todayCounts[em] || 0) + 1;
    }
  }

  const today = new Date(todayStr() + 'T00:00:00');
  const never = [], stale = [];

  for (const s of readBotMap()) {
    if (s.active === false || s.status === 'hired' || s.status === 'left') continue;
    const entry = log[s.email];
    if (!entry || !entry.count) { never.push(s); continue; }
    const last = new Date(entry.last + 'T00:00:00');
    const daysSince = Math.floor((today - last) / 86400000);
    if (daysSince >= staleDays) {
      stale.push(Object.assign({ lastPost: entry.last, daysSince: daysSince, count: entry.count,
        todayCount: todayCounts[s.email] || 0 }, s));
    }
  }
  for (const s of never) s.todayCount = 0;
  stale.sort(function (a, b) { return b.daysSince - a.daysSince; });
  return { date: todayStr(), never: never, stale: stale, staleDays: staleDays };
}

// ============================================================
//  HIRED PIPELINE - set Status=hired + color rows green
// ============================================================
const HIRED_GREEN = '#d9ead3';

function markHired(emails) {
  const ss = getSpreadsheet();
  const map = ensureBotMap();
  const mData = map.getDataRange().getValues();

  const att = ss.getSheetByName(CONFIG.SHEETS.matrix);
  const aData = att ? att.getDataRange().getValues() : [];
  const aCols = att ? att.getLastColumn() : 0;

  const done = [], notFound = [];
  for (const raw of emails) {
    const email = String(raw).trim().toLowerCase();
    let found = false;

    // Bot_Map: set status + green row
    for (let i = 1; i < mData.length; i++) {
      if (String(mData[i][0]).trim().toLowerCase() === email) {
        map.getRange(i + 1, 5).setValue('hired');
        map.getRange(i + 1, 1, 1, 5).setBackground(HIRED_GREEN);
        found = true;
        break;
      }
    }

    // Attendance matrix: green row
    for (let i = 1; att && i < aData.length; i++) {
      if (String(aData[i][CONFIG.MATRIX.emailCol - 1]).trim().toLowerCase() === email) {
        att.getRange(i + 1, 1, 1, aCols).setBackground(HIRED_GREEN);
        break;
      }
    }

    (found ? done : notFound).push(email);
  }
  return { hired: done, notFound: notFound };
}

// ============================================================
//  APPROVED LEAVE
//  Leave_Requests is the durable request/decision ledger. Approved working
//  dates are written as L in Attendance. P and L are both non-absence states;
//  only an empty/A cell is absent.
// ============================================================
function leaveRequestHeaders() {
  return [
    'Request ID', 'Submitted At', 'Updated At', 'Cohort', 'Discord ID',
    'Name', 'Email', 'Phone', 'Requested Start', 'Requested End',
    'Approved Dates', 'Reason', 'Status', 'Supervisor ID', 'Decision Note',
  ];
}

function ensureLeaveRequests() {
  const headers = leaveRequestHeaders();
  const sheet = ensureTab(leaveRequestsName(), headers);
  ensureSheetSize(sheet, Math.max(2, sheet.getLastRow()), headers.length);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  return sheet;
}

function validDateKey(value) {
  const normalized = normalizeSheetDate(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
}

function leaveRequestFromRow(row) {
  return {
    requestId: String(row[0] || ''),
    submittedAt: row[1] instanceof Date ? row[1].toISOString() : String(row[1] || ''),
    updatedAt: row[2] instanceof Date ? row[2].toISOString() : String(row[2] || ''),
    cohort: String(row[3] || ''),
    discordId: normalizeDiscordId(row[4]),
    name: String(row[5] || ''),
    email: normalizeStudentEmail(row[6]),
    phone: String(row[7] || ''),
    requestedStart: validDateKey(row[8]),
    requestedEnd: validDateKey(row[9]),
    approvedDates: String(row[10] || '').split(',').map(validDateKey).filter(Boolean),
    reason: String(row[11] || ''),
    status: String(row[12] || '').trim().toLowerCase(),
    supervisorId: normalizeDiscordId(row[13]),
    decisionNote: String(row[14] || ''),
  };
}

function activateTrackedStudents(request) {
  return withScriptLock(function () {
    const guildId = String(request && request.guildId || '').trim();
    const requestedIds = (request && request.discordIds || [request && request.discordId])
      .map(normalizeDiscordId).filter(Boolean);
    const discordIds = requestedIds.filter(function (id, index) {
      return requestedIds.indexOf(id) === index;
    });
    if (!discordIds.length || !guildId) throw new Error('Activation requires Discord ID and guild ID');

    const map = ensureBotMap();
    const data = map.getDataRange().getValues();
    const matches = {};
    discordIds.forEach(function (id) {
      matches[id] = { discordId: id, rows: [], email: '', name: '', status: '' };
    });
    for (let i = 1; i < data.length; i++) {
      const id = normalizeDiscordId(data[i][3]);
      if (!matches[id]) continue;
      matches[id].rows.push(i + 1);
      matches[id].email = matches[id].email || normalizeStudentEmail(data[i][0]);
      matches[id].name = matches[id].name || String(data[i][1] || '').trim();
      matches[id].status = matches[id].status || String(data[i][4] || '').trim().toLowerCase();
    }

    const failures = [];
    const activatable = [];
    discordIds.forEach(function (id) {
      const match = matches[id];
      if (!match.rows.length || !match.email) {
        failures.push({ discordId: id, error: 'Student is not linked in Bot_Map; run Discord roster sync first' });
      } else if (match.status === 'hired' || match.status === 'left') {
        failures.push({ discordId: id, error: 'Hired/left status must be corrected explicitly before activation' });
      } else {
        activatable.push(match);
      }
    });

    const attendanceRowsByEmail = {};
    const attendance = getSpreadsheet().getSheetByName(CONFIG.SHEETS.matrix);
    if (attendance && attendance.getLastRow() > 1) {
      const emails = attendance.getRange(
        2, CONFIG.MATRIX.emailCol, attendance.getLastRow() - 1, 1).getValues();
      for (let i = 0; i < emails.length; i++) {
        const email = normalizeStudentEmail(emails[i][0]);
        if (!attendanceRowsByEmail[email]) attendanceRowsByEmail[email] = [];
        attendanceRowsByEmail[email].push(i + 2);
      }
    }

    const properties = PropertiesService.getScriptProperties();
    const exclusionKey = 'ST_excl_' + guildId;
    const activatedIds = new Set(activatable.map(function (item) { return item.discordId; }));
    const activeIds = (properties.getProperty(exclusionKey) || '')
      .split(',').map(function (id) { return String(id).trim(); })
      .filter(function (id) { return id && !activatedIds.has(id); });
    properties.setProperty(exclusionKey, activeIds.join(','));

    const warningKey = 'ST_attendance_warning_state_v1_' + guildId;
    let warnings = {};
    try { warnings = JSON.parse(properties.getProperty(warningKey) || '{}'); }
    catch (error) { warnings = {}; }
    const metadataKey = 'ST_inactive_student_meta_v1_' + guildId;
    let metadata = {};
    try { metadata = JSON.parse(properties.getProperty(metadataKey) || '{}'); }
    catch (error) { metadata = {}; }

    const activated = activatable.map(function (match) {
      match.rows.forEach(function (row) {
        map.getRange(row, 1).setBackground('#ffffff');
      });
      const attendanceRows = attendanceRowsByEmail[match.email] || [];
      attendanceRows.forEach(function (row) {
        attendance.getRange(row, 1, 1, attendance.getLastColumn()).setBackground('#ffffff');
      });
      const previousWarningCount = Number(warnings[match.discordId] && warnings[match.discordId].count || 0);
      delete warnings[match.discordId];
      delete metadata[match.discordId];
      return {
        active: true,
        discordId: match.discordId,
        email: match.email,
        name: match.name,
        botMapRowsCleared: match.rows.length,
        attendanceRowsCleared: attendanceRows.length,
        previousWarningCount: previousWarningCount,
      };
    });
    properties.setProperty(warningKey, JSON.stringify(warnings));
    properties.setProperty(metadataKey, JSON.stringify(metadata));

    const statusStyles = refreshStudentStatusStyles(guildId);
    activated.forEach(function (item) { item.statusStyles = statusStyles; });
    return { activated: activated, failures: failures, statusStyles: statusStyles };
  });
}

function activateTrackedStudent(request) {
  const result = activateTrackedStudents(request);
  if (result.failures.length) throw new Error(result.failures[0].error);
  if (!result.activated.length) throw new Error('Student activation could not be verified');
  return result.activated[0];
}

function deactivateTrackedStudents(request) {
  return withScriptLock(function () {
    const guildId = String(request && request.guildId || '').trim();
    const requestedIds = (request && request.discordIds || [])
      .map(normalizeDiscordId).filter(Boolean);
    const discordIds = requestedIds.filter(function (id, index) {
      return requestedIds.indexOf(id) === index;
    });
    if (!guildId || !discordIds.length) throw new Error('Inactivation requires Discord IDs and guild ID');

    const students = {};
    readBotMap().forEach(function (student) {
      const id = normalizeDiscordId(student.discordId);
      if (id && !students[id]) students[id] = student;
    });
    const failures = [];
    const accepted = [];
    discordIds.forEach(function (id) {
      const student = students[id];
      if (!student) failures.push({ discordId: id, error: 'Student is not linked in Bot_Map' });
      else if (student.status === 'hired' || student.status === 'left') {
        failures.push({ discordId: id, error: 'Hired/left status is protected' });
      } else accepted.push(id);
    });
    if (failures.length) {
      throw new Error('Inactivation validation failed: ' + failures.map(function (item) {
        return item.discordId + ' (' + item.error + ')';
      }).join('; '));
    }

    const properties = PropertiesService.getScriptProperties();
    const exclusionKey = 'ST_excl_' + guildId;
    const current = new Set((properties.getProperty(exclusionKey) || '')
      .split(',').map(function (id) { return String(id).trim(); }).filter(Boolean));
    const metadataKey = 'ST_inactive_student_meta_v1_' + guildId;
    let metadata = {};
    try { metadata = JSON.parse(properties.getProperty(metadataKey) || '{}'); }
    catch (error) { metadata = {}; }
    let added = 0;
    let metadataChanged = false;
    const inactiveDate = validDateKey(request && request.date) || todayStr();
    const source = String(request && request.source || 'manual').slice(0, 80);
    const reason = String(request && request.reason || 'Marked inactive by a mentor').slice(0, 500);
    accepted.forEach(function (id) {
      if (!current.has(id)) {
        current.add(id);
        added++;
      }
      if (!metadata[id]) {
        metadata[id] = {
          inactiveDate: inactiveDate, source: source, reason: reason,
          recordedAt: new Date().toISOString(),
        };
        metadataChanged = true;
      }
    });
    properties.setProperty(exclusionKey, Array.from(current).join(','));
    properties.setProperty(metadataKey, JSON.stringify(metadata));
    if (request && request.warningState && typeof request.warningState === 'object') {
      properties.setProperty(
        'ST_attendance_warning_state_v1_' + guildId,
        JSON.stringify(request.warningState));
    }
    const statusStyles = refreshStudentStatusStyles(guildId);
    return {
      deactivated: accepted, failures: failures, added: added,
      total: current.size, metadataChanged: metadataChanged, statusStyles: statusStyles,
    };
  });
}

function submitLeaveRequest(request) {
  return withScriptLock(function () {
    const discordId = normalizeDiscordId(request && request.discordId);
    const requestedStart = validDateKey(request && request.requestedStart);
    const requestedEnd = validDateKey(request && request.requestedEnd);
    const reason = String(request && request.reason || '').trim().slice(0, 1500);
    if (!discordId || !requestedStart || !requestedEnd || requestedStart > requestedEnd || !reason) {
      throw new Error('Leave request requires a student, valid date range, and reason');
    }
    if (requestedEnd > shiftDateKey(requestedStart, 62)) {
      throw new Error('Leave request cannot exceed 63 calendar days');
    }
    const student = readBotMap().find(function (item) {
      return normalizeDiscordId(item.discordId) === discordId;
    });
    if (!student || student.active === false || student.status === 'hired' || student.status === 'left') {
      throw new Error('Leave requester is not an active tracked student');
    }
    const requestId = String(request.requestId || Utilities.getUuid()).trim().slice(0, 80);
    const sheet = ensureLeaveRequests();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === requestId) {
        const duplicateId = leaveRequestFromRow(data[i]);
        duplicateId.created = false;
        duplicateId.duplicate = true;
        duplicateId.duplicateReason = 'same request was already received';
        return duplicateId;
      }
      const prior = leaveRequestFromRow(data[i]);
      if (prior.discordId === discordId && prior.status === 'pending') {
        if (prior.requestedStart === requestedStart && prior.requestedEnd === requestedEnd) {
          prior.created = false;
          prior.duplicate = true;
          prior.duplicateReason = 'same dates already have a pending request';
          return prior;
        }
        throw new Error('You already have a pending leave request. Wait for the mentor decision before submitting different dates');
      }
    }
    const now = new Date();
    const row = [
      requestId, now, now, CONFIG.COHORT, "'" + discordId,
      student.name || String(request.name || ''), student.email,
      student.phone || String(request.phone || ''), requestedStart, requestedEnd,
      '', reason, 'pending', '', '',
    ];
    sheet.appendRow(row);
    const created = leaveRequestFromRow(row);
    created.created = true;
    created.duplicate = false;
    return created;
  });
}

function attendanceDateColumn(sheet, dateKey) {
  const matrixHeader = Utilities.formatDate(new Date(dateKey + 'T12:00:00'), CONFIG.TZ, 'd/M/yy');
  const headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), CONFIG.MATRIX.firstDateCol)).getDisplayValues()[0];
  let column = 0;
  let insertBefore = 0;
  for (let index = CONFIG.MATRIX.firstDateCol - 1; index < headers.length; index++) {
    const key = matrixHeaderDateKey(headers[index]);
    if (key === dateKey) { column = index + 1; break; }
    if (!insertBefore && key && key > dateKey) insertBefore = index + 1;
  }
  if (!column && insertBefore) {
    sheet.insertColumnBefore(insertBefore);
    column = insertBefore;
  } else if (!column) {
    column = Math.max(sheet.getLastColumn() + 1, CONFIG.MATRIX.firstDateCol);
    ensureSheetSize(sheet, Math.max(2, sheet.getLastRow()), column);
  }
  if (String(sheet.getRange(1, column).getDisplayValue() || '').trim() !== matrixHeader) {
    sheet.getRange(1, column).setValue(matrixHeader).setFontWeight('bold').setBackground('#d9eaf7');
  }
  return column;
}

function markApprovedLeave(email, dates) {
  const normalizedEmail = normalizeStudentEmail(email);
  const uniqueDates = Array.from(new Set((dates || []).map(validDateKey).filter(Boolean))).sort();
  if (!normalizedEmail || !uniqueDates.length) throw new Error('Approved leave requires an email and working dates');
  if (uniqueDates.length > 63) throw new Error('Approved leave cannot exceed 63 working dates');
  const roster = readBotMap();
  const student = roster.find(function (item) { return item.email === normalizedEmail; });
  if (!student) throw new Error('Approved leave student is not in Bot_Map');
  ensureAttendanceRosterRows(roster);
  const sheet = ensureAttendanceSheet();
  const data = sheet.getDataRange().getValues();
  let row = 0;
  for (let i = 1; i < data.length; i++) {
    if (normalizeStudentEmail(data[i][CONFIG.MATRIX.emailCol - 1]) === normalizedEmail) {
      row = i + 1;
      break;
    }
  }
  if (!row) throw new Error('Attendance row could not be created for approved leave');
  let marked = 0;
  uniqueDates.forEach(function (date) {
    const column = attendanceDateColumn(sheet, date);
    const cell = sheet.getRange(row, column);
    if (String(cell.getValue() || '').trim().toUpperCase() === 'P') return;
    cell.setValue('L').setBackground('#cfe2f3').setHorizontalAlignment('center');
    marked++;
  });
  return { email: normalizedEmail, dates: uniqueDates, marked: marked };
}

function decideLeaveRequest(decision) {
  return withScriptLock(function () {
    const requestId = String(decision && decision.requestId || '').trim();
    const status = String(decision && decision.status || '').trim().toLowerCase();
    const supervisorId = normalizeDiscordId(decision && decision.supervisorId);
    const note = String(decision && decision.note || '').trim().slice(0, 1000);
    if (!requestId || !['approved', 'rejected'].includes(status) || !supervisorId) {
      throw new Error('Leave decision requires request ID, approved/rejected status, and supervisor');
    }
    const sheet = ensureLeaveRequests();
    const data = sheet.getDataRange().getValues();
    let rowIndex = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === requestId) { rowIndex = i; break; }
    }
    if (rowIndex === -1) throw new Error('Leave request was not found');
    const existing = leaveRequestFromRow(data[rowIndex]);
    const approvedDates = status === 'approved'
      ? Array.from(new Set((decision.dates || []).map(validDateKey).filter(Boolean))).sort()
      : [];
    if (status === 'approved' && !approvedDates.length) throw new Error('Approved leave has no working dates');
    if (existing.status !== 'pending') {
      if (existing.status === status && existing.approvedDates.join(',') === approvedDates.join(',')) {
        existing.decisionChanged = false;
        return existing;
      }
      throw new Error('Leave request has already been decided');
    }
    if (status === 'approved') markApprovedLeave(existing.email, approvedDates);
    const row = rowIndex + 1;
    sheet.getRange(row, 3).setValue(new Date());
    sheet.getRange(row, 11).setValue(approvedDates.join(','));
    sheet.getRange(row, 13).setValue(status);
    sheet.getRange(row, 14).setValue("'" + supervisorId);
    sheet.getRange(row, 15).setValue(note);
    const decided = leaveRequestFromRow(sheet.getRange(row, 1, 1, leaveRequestHeaders().length).getValues()[0]);
    decided.decisionChanged = true;
    return decided;
  });
}

function getLeaveRequests(status, discordId, limit) {
  const wantedStatus = String(status || '').trim().toLowerCase();
  const wantedId = normalizeDiscordId(discordId);
  const sheet = ensureLeaveRequests();
  const rows = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, leaveRequestHeaders().length).getValues()
    : [];
  return rows.map(leaveRequestFromRow).filter(function (request) {
    return (!wantedStatus || request.status === wantedStatus) && (!wantedId || request.discordId === wantedId);
  }).sort(function (a, b) { return String(b.submittedAt).localeCompare(String(a.submittedAt)); })
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 100)));
}

function getLeaveCalendar(dateKey) {
  const date = validDateKey(dateKey);
  if (!date) throw new Error('Leave calendar date must be YYYY-MM-DD');
  const leaveByEmail = matrixLeaveOnDate(date);
  const students = readBotMap().filter(function (student) { return leaveByEmail[student.email]; }).map(function (student) {
    return {
      email: student.email,
      name: student.name,
      phone: student.phone || '',
      discordId: student.discordId || '',
    };
  });
  return { version: VERSION, cohort: CONFIG.COHORT, date: date, students: students };
}

// ============================================================
//  APPEALS
//  One private ledger covers bootcamp inactivity and Dawn Focus removals.
//  Discord performs access restoration; this backend stores the durable,
//  idempotent request and mentor decision audit trail.
// ============================================================
function appealLogHeaders() {
  return [
    'Request ID', 'Submitted At', 'Updated At', 'Cohort', 'Scope',
    'Discord ID', 'Name', 'Email', 'Phone', 'Cause', 'Affected Dates',
    'Explanation', 'Status', 'Mentor ID', 'Decision Note',
  ];
}

function ensureAppealLogs() {
  const headers = appealLogHeaders();
  const sheet = ensureTab(appealLogsName(), headers);
  ensureSheetSize(sheet, Math.max(2, sheet.getLastRow()), headers.length);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  return sheet;
}

function appealFromRow(row) {
  return {
    requestId: String(row[0] || ''),
    submittedAt: row[1] instanceof Date ? row[1].toISOString() : String(row[1] || ''),
    updatedAt: row[2] instanceof Date ? row[2].toISOString() : String(row[2] || ''),
    cohort: String(row[3] || ''),
    scope: String(row[4] || '').trim().toLowerCase(),
    discordId: normalizeDiscordId(row[5]),
    name: String(row[6] || ''),
    email: normalizeStudentEmail(row[7]),
    phone: String(row[8] || ''),
    cause: String(row[9] || '').trim().toLowerCase(),
    affectedDates: String(row[10] || ''),
    explanation: String(row[11] || ''),
    status: String(row[12] || '').trim().toLowerCase(),
    mentorId: normalizeDiscordId(row[13]),
    decisionNote: String(row[14] || ''),
  };
}

function submitAppeal(request) {
  return withScriptLock(function () {
    const scope = String(request && request.scope || '').trim().toLowerCase();
    const discordId = normalizeDiscordId(request && request.discordId);
    const cause = String(request && request.cause || '').trim().toLowerCase();
    const affectedDates = String(request && request.affectedDates || '').trim().slice(0, 400);
    const explanation = String(request && request.explanation || '').trim().slice(0, 1500);
    if (['bootcamp', 'dawn'].indexOf(scope) === -1 || !discordId ||
        ['medical', 'exam', 'bereavement', 'other'].indexOf(cause) === -1 ||
        !affectedDates || explanation.length < 20) {
      throw new Error('Appeal requires scope, student, cause, affected dates, and detailed explanation');
    }
    const student = readBotMap().find(function (item) {
      return normalizeDiscordId(item.discordId) === discordId;
    });
    if (!student || student.status === 'hired' || student.status === 'left') {
      throw new Error('Appeal requester is not a current bootcamp student');
    }
    const requestId = String(request.requestId || Utilities.getUuid()).trim().slice(0, 80);
    const sheet = ensureAppealLogs();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const prior = appealFromRow(data[i]);
      if (prior.requestId === requestId) return Object.assign(prior, { created: false });
      if (prior.discordId === discordId && prior.scope === scope && prior.status === 'pending') {
        return Object.assign(prior, { created: false });
      }
    }
    const now = new Date();
    const row = [
      requestId, now, now, CONFIG.COHORT, scope, "'" + discordId,
      student.name || String(request.name || ''), student.email,
      student.phone || String(request.phone || ''), cause, affectedDates,
      explanation, 'pending', '', '',
    ];
    sheet.appendRow(row);
    return Object.assign(appealFromRow(row), { created: true });
  });
}

function decideAppeal(decision) {
  return withScriptLock(function () {
    const requestId = String(decision && decision.requestId || '').trim();
    const status = String(decision && decision.status || '').trim().toLowerCase();
    const mentorId = normalizeDiscordId(decision && decision.mentorId);
    const note = String(decision && decision.note || '').trim().slice(0, 1000);
    if (!requestId || ['approved', 'declined'].indexOf(status) === -1 || !mentorId) {
      throw new Error('Appeal decision requires request ID, approved/declined status, and mentor');
    }
    if (status === 'declined' && !note) throw new Error('A declined appeal requires a mentor note');
    const sheet = ensureAppealLogs();
    const data = sheet.getDataRange().getValues();
    let rowIndex = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === requestId) { rowIndex = i; break; }
    }
    if (rowIndex === -1) throw new Error('Appeal request was not found');
    const existing = appealFromRow(data[rowIndex]);
    if (existing.status !== 'pending') {
      if (existing.status === status) return existing;
      throw new Error('Appeal request has already been decided');
    }
    const row = rowIndex + 1;
    sheet.getRange(row, 3).setValue(new Date());
    sheet.getRange(row, 13).setValue(status);
    sheet.getRange(row, 14).setValue("'" + mentorId);
    sheet.getRange(row, 15).setValue(note);
    return appealFromRow(sheet.getRange(row, 1, 1, appealLogHeaders().length).getValues()[0]);
  });
}

function getAppeals(status, discordId, scope, limit) {
  const wantedStatus = String(status || '').trim().toLowerCase();
  const wantedId = normalizeDiscordId(discordId);
  const wantedScope = String(scope || '').trim().toLowerCase();
  const sheet = ensureAppealLogs();
  const rows = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, appealLogHeaders().length).getValues()
    : [];
  return rows.map(appealFromRow).filter(function (appeal) {
    return (!wantedStatus || appeal.status === wantedStatus) &&
      (!wantedId || appeal.discordId === wantedId) &&
      (!wantedScope || appeal.scope === wantedScope);
  }).sort(function (a, b) { return String(b.submittedAt).localeCompare(String(a.submittedAt)); })
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 100)));
}

// ============================================================
//  DAWN FOCUS ATTENDANCE
//  One idempotent batch is written after the 07:00 window closes. Discord
//  messages are never written one-by-one, which keeps Apps Script executions
//  bounded. The matrix stores P/time, approved leave L, or A; message text is
//  not persisted.
// ============================================================
function mergeDawnAttendanceCell(existingValue, incomingValue) {
  const values = [existingValue, incomingValue].map(function (value) {
    return String(value || '').split('|').map(function (part) { return part.trim(); }).filter(String);
  }).reduce(function (all, parts) { return all.concat(parts); }, []);
  const events = [];
  ['Joined', 'Rejoined', 'Removed'].forEach(function (event) {
    if (values.indexOf(event) !== -1) events.push(event);
  });
  const presentTimes = values.map(function (part) {
    const match = part.match(/^P\b[^0-9]*(\d{1,2}:\d{2})/i);
    return match ? match[1] : '';
  }).filter(String).sort();
  if (presentTimes.length) events.push('P Â· ' + presentTimes[0]);
  else if (values.some(function (part) { return /^L$/i.test(part); })) events.push('L');
  else if (values.some(function (part) { return /^A$/i.test(part); })) events.push('A');
  values.forEach(function (part) {
    if (/^(Joined|Rejoined|Removed|A|L)$/i.test(part) || /^P\b/i.test(part)) return;
    if (events.indexOf(part) === -1) events.push(part);
  });
  return events.join(' | ');
}

function styleDawnAttendanceCell(cell, value) {
  const text = String(value || '');
  cell.setHorizontalAlignment('center');
  if (/\bP\b/.test(text)) cell.setBackground('#d9ead3');
  else if (/(^|\|\s*)L($|\s*\|)/.test(text)) cell.setBackground('#cfe2f3');
  else if (/(^|\|\s*)A($|\s*\|)/.test(text)) cell.setBackground('#f4cccc');
  else if (/Removed/.test(text)) cell.setBackground('#fce5cd');
  else if (/(Joined|Rejoined)/.test(text)) cell.setBackground('#fff2cc');
}

function isGenericDawnAttendanceTab(sheet) {
  if (!sheet || !/^Sheet\d*$/i.test(sheet.getName()) || sheet.getLastColumn() < 3) return false;
  const headers = sheet.getRange(1, 1, 1, 3).getDisplayValues()[0]
    .map(function (value) { return String(value || '').trim().toLowerCase(); });
  if (headers.join('|') !== 'name|email|phone') return false;
  if (sheet.getLastColumn() < 4 || sheet.getLastRow() < 2) return true;
  const values = sheet.getRange(2, 4, sheet.getLastRow() - 1, sheet.getLastColumn() - 3)
    .getDisplayValues().reduce(function (all, row) { return all.concat(row); }, [])
    .map(function (value) { return String(value || '').trim(); }).filter(String);
  return values.every(function (value) {
    return value.split('|').map(function (part) { return part.trim(); }).every(function (part) {
      return /^(Joined|Rejoined|Removed|A|P\b.*)$/i.test(part);
    });
  });
}

function uniqueHiddenDawnArchiveName(ss, originalName) {
  let name = 'Dawn Archive - ' + originalName;
  let counter = 2;
  while (ss.getSheetByName(name)) name = 'Dawn Archive - ' + originalName + ' ' + counter++;
  return name.slice(0, 99);
}

function repairDawnAttendance() {
  return withScriptLock(function () {
    const ss = getSpreadsheet();
    const target = ensureTab(dawnAttendanceName(), ['Name', 'Email', 'Phone']);
    const candidates = ss.getSheets().filter(function (sheet) {
      return sheet.getSheetId() !== target.getSheetId() && isGenericDawnAttendanceTab(sheet);
    });
    let migratedCells = 0;
    let migratedStudents = 0;
    candidates.forEach(function (source) {
      const sourceRows = source.getLastRow();
      const sourceCols = source.getLastColumn();
      const data = sourceRows ? source.getRange(1, 1, sourceRows, sourceCols).getDisplayValues() : [];
      for (let sourceRow = 1; sourceRow < data.length; sourceRow++) {
        const email = normalizeStudentEmail(data[sourceRow][1]);
        if (!email) continue;
        let targetRow = 0;
        if (target.getLastRow() > 1) {
          const targetEmails = target.getRange(2, 2, target.getLastRow() - 1, 1).getDisplayValues();
          for (let i = 0; i < targetEmails.length; i++) {
            if (normalizeStudentEmail(targetEmails[i][0]) === email) { targetRow = i + 2; break; }
          }
        }
        if (!targetRow) {
          targetRow = target.getLastRow() + 1;
          ensureSheetSize(target, targetRow, Math.max(3, target.getLastColumn()));
          target.getRange(targetRow, 1, 1, 3).setValues([[
            String(data[sourceRow][0] || '').slice(0, 150), email,
            String(data[sourceRow][2] || '').slice(0, 50),
          ]]);
          migratedStudents++;
        }
        for (let sourceCol = 3; sourceCol < sourceCols; sourceCol++) {
          const incoming = String(data[sourceRow][sourceCol] || '').trim();
          const dateHeader = String(data[0][sourceCol] || '').trim();
          if (!incoming || !dateHeader) continue;
          const targetHeaders = target.getRange(1, 1, 1, Math.max(3, target.getLastColumn()))
            .getDisplayValues()[0];
          let targetCol = targetHeaders.findIndex(function (value) {
            return String(value || '').trim() === dateHeader;
          }) + 1;
          if (!targetCol) {
            targetCol = Math.max(4, target.getLastColumn() + 1);
            ensureSheetSize(target, Math.max(2, target.getLastRow()), targetCol);
            target.getRange(1, targetCol).setValue(dateHeader).setFontWeight('bold').setBackground('#d9eaf7');
          }
          const cell = target.getRange(targetRow, targetCol);
          const merged = mergeDawnAttendanceCell(cell.getDisplayValue(), incoming);
          cell.setValue(merged);
          styleDawnAttendanceCell(cell, merged);
          migratedCells++;
        }
      }
      source.setName(uniqueHiddenDawnArchiveName(ss, source.getName()));
      source.hideSheet();
    });
    target.setFrozenRows(1);
    target.setFrozenColumns(3);
    SpreadsheetApp.flush();
    return {
      sheet: target.getName(),
      migratedTabs: candidates.length,
      migratedCells: migratedCells,
      studentsAdded: migratedStudents,
      students: Math.max(0, target.getLastRow() - 1),
    };
  });
}

function saveDawnAttendance(entries, dateKey, guildId) {
  const date = normalizeSheetDate(dateKey);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Dawn attendance date must be YYYY-MM-DD');
  const headers = ['Name', 'Email', 'Phone'];
  const sheet = ensureTab(dawnAttendanceName(), headers);
  ensureSheetSize(sheet, Math.max(2, sheet.getLastRow()), Math.max(4, sheet.getLastColumn()));
  const matrixDate = Utilities.formatDate(new Date(date + 'T12:00:00'), CONFIG.TZ, 'd/M/yy');
  const headerValues = sheet.getRange(1, 1, 1, Math.max(3, sheet.getLastColumn())).getDisplayValues()[0];
  let dateCol = headerValues.findIndex(function (value) { return String(value).trim() === matrixDate; }) + 1;
  if (!dateCol) {
    dateCol = Math.max(4, sheet.getLastColumn() + 1);
    ensureSheetSize(sheet, Math.max(2, sheet.getLastRow()), dateCol);
    sheet.getRange(1, dateCol).setValue(matrixDate).setFontWeight('bold').setBackground('#d9eaf7');
  }
  const existing = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getDisplayValues()
    : [];
  const rowByEmail = {};
  existing.forEach(function (row, index) {
    const email = normalizeStudentEmail(row[1]);
    if (email) rowByEmail[email] = index + 2;
  });
  let added = 0;
  let marked = 0;
  (entries || []).forEach(function (entry) {
    const id = normalizeDiscordId(entry.discordId);
    const email = normalizeStudentEmail(entry.email);
    if (!id || !email) return;
    let row = rowByEmail[email];
    if (!row) {
      row = sheet.getLastRow() + 1;
      ensureSheetSize(sheet, row, dateCol);
      sheet.getRange(row, 1, 1, 3).setValues([[
        String(entry.displayName || '').slice(0, 150),
        email,
        String(entry.phone || '').slice(0, 50),
      ]]);
      rowByEmail[email] = row;
      added++;
    } else {
      sheet.getRange(row, 1, 1, 3).setValues([[
        String(entry.displayName || existing[row - 2][0] || '').slice(0, 150),
        email,
        String(entry.phone || existing[row - 2][2] || '').slice(0, 50),
      ]]);
    }
    const present = String(entry.status || '') === 'Present';
    const leave = String(entry.status || '') === 'Leave';
    const time = String(entry.firstMessageAt || '').match(/(\d{2}:\d{2})(?::\d{2})?$/);
    const attendanceMark = present ? `P · ${time ? time[1] : ''}`.trim() : (leave ? 'L' : 'A');
    const cell = sheet.getRange(row, dateCol);
    const merged = mergeDawnAttendanceCell(cell.getDisplayValue(), attendanceMark);
    cell.setValue(merged);
    styleDawnAttendanceCell(cell, merged);
    marked++;
  });
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(3);
  return { date: date, dateColumn: matrixDate, saved: marked, studentsAdded: added };
}

function saveDawnMembershipEvent(entry, dateKey, eventName) {
  const date = normalizeSheetDate(dateKey);
  const event = String(eventName || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Dawn membership date must be YYYY-MM-DD');
  if (!/^(Joined|Removed|Rejoined)$/.test(event)) throw new Error('Invalid Dawn membership event');
  const id = normalizeDiscordId(entry && entry.discordId);
  const email = normalizeStudentEmail(entry && entry.email);
  if (!id || !email) throw new Error('Dawn membership event requires a Discord member and verified email');
  const sheet = ensureTab(dawnAttendanceName(), ['Name', 'Email', 'Phone']);
  ensureSheetSize(sheet, Math.max(2, sheet.getLastRow()), Math.max(4, sheet.getLastColumn()));
  const matrixDate = Utilities.formatDate(new Date(date + 'T12:00:00'), CONFIG.TZ, 'd/M/yy');
  const headerValues = sheet.getRange(1, 1, 1, Math.max(3, sheet.getLastColumn())).getDisplayValues()[0];
  let dateCol = headerValues.findIndex(function (value) { return String(value).trim() === matrixDate; }) + 1;
  if (!dateCol) {
    dateCol = Math.max(4, sheet.getLastColumn() + 1);
    ensureSheetSize(sheet, Math.max(2, sheet.getLastRow()), dateCol);
    sheet.getRange(1, dateCol).setValue(matrixDate).setFontWeight('bold').setBackground('#d9eaf7');
  }
  const existing = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getDisplayValues()
    : [];
  let row = 0;
  for (let i = 0; i < existing.length; i++) {
    if (normalizeStudentEmail(existing[i][1]) === email) { row = i + 2; break; }
  }
  if (!row) row = sheet.getLastRow() + 1;
  ensureSheetSize(sheet, row, dateCol);
  sheet.getRange(row, 1, 1, 3).setValues([[
    String(entry.displayName || (existing[row - 2] && existing[row - 2][0]) || '').slice(0, 150),
    email,
    String(entry.phone || (existing[row - 2] && existing[row - 2][2]) || '').slice(0, 50),
  ]]);
  const cell = sheet.getRange(row, dateCol);
  const merged = mergeDawnAttendanceCell(cell.getDisplayValue(), event);
  cell.setValue(merged);
  styleDawnAttendanceCell(cell, merged);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(3);
  return { date: date, dateColumn: matrixDate, event: event, email: email };
}

function syncDawnMembers(entries, dateKey) {
  return withScriptLock(function () {
    const date = normalizeSheetDate(dateKey);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Dawn member sync date must be YYYY-MM-DD');
    const sheet = ensureTab(dawnAttendanceName(), ['Name', 'Email', 'Phone']);
    ensureSheetSize(sheet, Math.max(2, sheet.getLastRow()), Math.max(4, sheet.getLastColumn()));

    const existingRows = sheet.getLastRow() > 1
      ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getDisplayValues()
      : [];
    const rowByEmail = {};
    existingRows.forEach(function (row, index) {
      const email = normalizeStudentEmail(row[1]);
      if (email) rowByEmail[email] = {
        row: index + 2,
        name: String(row[0] || ''),
        phone: String(row[2] || ''),
      };
    });

    const dateColumns = {};
    function eventColumn(eventDate) {
      const normalized = normalizeSheetDate(eventDate || date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return 0;
      if (dateColumns[normalized]) return dateColumns[normalized];
      const matrixDate = Utilities.formatDate(new Date(normalized + 'T12:00:00'), CONFIG.TZ, 'd/M/yy');
      const headers = sheet.getRange(1, 1, 1, Math.max(3, sheet.getLastColumn())).getDisplayValues()[0];
      let column = headers.findIndex(function (value) {
        return String(value || '').trim() === matrixDate;
      }) + 1;
      if (!column) {
        column = Math.max(4, sheet.getLastColumn() + 1);
        ensureSheetSize(sheet, Math.max(2, sheet.getLastRow()), column);
        sheet.getRange(1, column).setValue(matrixDate).setFontWeight('bold').setBackground('#d9eaf7');
      }
      dateColumns[normalized] = column;
      return column;
    }

    let added = 0;
    let updated = 0;
    let eventsSaved = 0;
    const skippedDiscordIds = [];
    (entries || []).slice(0, 1000).forEach(function (entry) {
      const discordId = normalizeDiscordId(entry && entry.discordId);
      const email = normalizeStudentEmail(entry && entry.email);
      if (!discordId || !email) {
        if (discordId) skippedDiscordIds.push(discordId);
        return;
      }
      const existing = rowByEmail[email];
      let row = existing && existing.row;
      const isNew = !row;
      if (!row) {
        row = sheet.getLastRow() + 1;
        ensureSheetSize(sheet, row, Math.max(4, sheet.getLastColumn()));
        rowByEmail[email] = { row: row, name: '', phone: '' };
        added++;
      } else {
        updated++;
      }
      const current = rowByEmail[email];
      const displayName = String(entry.displayName || current.name || '').slice(0, 150);
      const phone = String(entry.phone || current.phone || '').slice(0, 50);
      sheet.getRange(row, 1, 1, 3).setValues([[displayName, email, phone]]);
      current.name = displayName;
      current.phone = phone;

      let event = String(entry.event || '').trim();
      if (!event && isNew) event = 'Joined';
      if (/^(Joined|Removed|Rejoined)$/.test(event)) {
        const column = eventColumn(entry.eventDate || date);
        if (column) {
          const cell = sheet.getRange(row, column);
          const merged = mergeDawnAttendanceCell(cell.getDisplayValue(), event);
          cell.setValue(merged);
          styleDawnAttendanceCell(cell, merged);
          eventsSaved++;
        }
      }
    });
    sheet.setFrozenRows(1);
    sheet.setFrozenColumns(3);
    SpreadsheetApp.flush();
    return {
      sheet: sheet.getName(),
      received: Math.min((entries || []).length, 1000),
      saved: added + updated,
      added: added,
      updated: updated,
      eventsSaved: eventsSaved,
      skippedDiscordIds: skippedDiscordIds,
      students: Math.max(0, sheet.getLastRow() - 1),
    };
  });
}

function getDawnAbsenceReport(start, end, guildId) {
  const startKey = validDateKey(start);
  const endKey = validDateKey(end);
  if (!startKey || !endKey || startKey > endKey || endKey > shiftDateKey(startKey, 62)) {
    throw new Error('Dawn absence report requires a valid range of at most 63 days');
  }
  const sheet = getSpreadsheet().getSheetByName(dawnAttendanceName());
  const data = sheet ? sheet.getDataRange().getDisplayValues() : [];
  const columns = [];
  if (data.length) {
    for (let column = 3; column < data[0].length; column++) {
      const key = matrixHeaderDateKey(data[0][column]);
      if (key && key >= startKey && key <= endKey) columns.push({ index: column, key: key });
    }
  }
  columns.sort(function (a, b) { return a.key.localeCompare(b.key); });
  const rowsByEmail = {};
  for (let row = 1; row < data.length; row++) {
    const email = normalizeStudentEmail(data[row][1]);
    if (email) rowsByEmail[email] = data[row];
  }
  const leaveByDate = {};
  columns.forEach(function (column) { leaveByDate[column.key] = matrixLeaveOnDate(column.key); });
  const excluded = {};
  excludedDiscordIds(guildId).forEach(function (id) { excluded[id] = true; });
  const students = trackingStudents().filter(function (student) {
    return student.active && student.status !== 'hired' && student.status !== 'left' &&
      !(student.discordId && excluded[student.discordId]);
  }).map(function (student) {
    const row = rowsByEmail[student.email] || [];
    const absentDates = columns.filter(function (column) {
      if (leaveByDate[column.key] && leaveByDate[column.key][student.email]) return false;
      const value = String(row[column.index] || '');
      return /(^|\|\s*)A($|\s*\|)/i.test(value) && !/\bP\b/i.test(value);
    }).map(function (column) { return column.key; });
    return {
      email: student.email,
      name: student.name,
      phone: student.phone || '',
      username: student.username || '',
      discordId: student.discordId || '',
      absentDays: absentDates.length,
      absentDates: absentDates,
    };
  }).filter(function (student) { return student.absentDays > 0; });
  students.sort(function (a, b) {
    return b.absentDays - a.absentDays || String(a.name).localeCompare(String(b.name));
  });
  return {
    version: VERSION,
    cohort: CONFIG.COHORT,
    start: startKey,
    end: endKey,
    recordedSessions: columns.map(function (column) { return column.key; }),
    students: students,
  };
}

// ============================================================
//  UNIFIED RENDER UPTIME SCHEDULE
//  Stored in the protected control Apps Script project's ScriptProperties.
//  Render-Uptime-Monitor.gs reads the same property from its five-minute
//  trigger, while the Discord process uses the authenticated Web App action.
// ============================================================
function defaultRenderUptimeSchedule_() {
  return {
    version: 2,
    timezone: CONFIG.TZ || 'Asia/Dhaka',
    windows: [{ start: '04:50', end: '23:30' }],
    days: [0, 1, 2, 3, 4, 5, 6],
    dates: [],
    overrides: {},
    wakeLeadMinutes: 10,
  };
}

function validUptimeClock_(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}

function validUptimeDate_(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(text + 'T00:00:00Z');
  return !isNaN(date.getTime()) && Utilities.formatDate(date, 'UTC', 'yyyy-MM-dd') === text;
}

function normalizeRenderUptimeSchedule_(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const fallback = defaultRenderUptimeSchedule_();
  const windows = Array.isArray(source.windows) ? source.windows.slice(0, 4).map(function (item) {
    const start = String(item && item.start || '');
    const end = String(item && item.end || '');
    if (!validUptimeClock_(start) || !validUptimeClock_(end) || start === end) {
      throw new Error('Backend windows require different HH:MM start/end values');
    }
    return { start: start, end: end };
  }) : fallback.windows;
  if (!windows.length) throw new Error('At least one backend window is required');
  const days = Array.isArray(source.days)
    ? source.days.filter(function (day, index, array) {
        return Number.isInteger(day) && day >= 0 && day <= 6 && array.indexOf(day) === index;
      }).sort()
    : fallback.days;
  if (!days.length) throw new Error('At least one regular backend day is required');
  const dates = Array.isArray(source.dates)
    ? source.dates.map(String).filter(validUptimeDate_).filter(function (date, index, array) {
        return array.indexOf(date) === index;
      }).sort().slice(0, 120)
    : [];
  const overrides = {};
  if (source.overrides && typeof source.overrides === 'object' && !Array.isArray(source.overrides)) {
    Object.keys(source.overrides).sort().slice(-180).forEach(function (date) {
      if (!validUptimeDate_(date)) return;
      const value = source.overrides[date];
      const state = String(value);
      if (state === 'on' || state === 'off' || state === 'always') {
        overrides[date] = state;
        return;
      }
      if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.windows)) {
        const specialWindows = value.windows.slice(0, 4).map(function (item) {
          const start = String(item && item.start || '');
          const end = String(item && item.end || '');
          if (!validUptimeClock_(start) || !validUptimeClock_(end) || start === end) {
            throw new Error('Backend override windows require different HH:MM start/end values');
          }
          return { start: start, end: end };
        });
        if (specialWindows.length) overrides[date] = { windows: specialWindows };
      }
    });
  }
  return {
    version: 2,
    timezone: String(source.timezone || fallback.timezone).slice(0, 80),
    windows: windows,
    days: days,
    dates: dates,
    overrides: overrides,
    wakeLeadMinutes: 10,
  };
}

function getRenderUptimeSchedule_() {
  const raw = PropertiesService.getScriptProperties().getProperty(RENDER_UPTIME_SCHEDULE_KEY);
  if (!raw) return defaultRenderUptimeSchedule_();
  try { return normalizeRenderUptimeSchedule_(JSON.parse(raw)); }
  catch (err) { throw new Error('Stored backend uptime schedule is invalid: ' + String(err)); }
}

function setRenderUptimeSchedule_(value) {
  const schedule = normalizeRenderUptimeSchedule_(value);
  if (typeof pingRenderServicesOnSchedule_ !== 'function') {
    throw new Error('Render-Uptime-Monitor.gs is missing from the control Apps Script project');
  }
  const triggers = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === 'pingRenderServicesOnSchedule_';
  });
  for (let i = 1; i < triggers.length; i++) ScriptApp.deleteTrigger(triggers[i]);
  if (!triggers.length) {
    ScriptApp.newTrigger('pingRenderServicesOnSchedule_').timeBased().everyMinutes(5).create();
  }
  PropertiesService.getScriptProperties().setProperty(
    RENDER_UPTIME_SCHEDULE_KEY, JSON.stringify(schedule));
  return { ok: true, schedule: schedule, triggerCount: 1 };
}

// ============================================================
//  PRIVATE COHORT MAILER
//  Students are placed only in BCC. A durable batch reservation prevents a
//  retried Web App request from sending the same cohort/date/type twice.
// ============================================================
function mailerLogHeaders() {
  return [
    'Batch Key', 'Created At', 'Updated At', 'Cohort', 'Date', 'Type',
    'Status', 'Student Recipient Count', 'Subject', 'To', 'CC',
    'BCC Recipients', 'Error', 'Transport', 'Gmail Message ID',
  ];
}

function ensureMailerLog() {
  const headers = mailerLogHeaders();
  const sheet = ensureTab(mailerLogName(), headers);
  ensureSheetSize(sheet, Math.max(2, sheet.getLastRow()), headers.length);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);
  return sheet;
}

function normalizeMailerEmail(value) {
  const email = String(value || '').trim().toLowerCase()
    .replace(/^mailto:/, '').replace(/\s+/g, '');
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function normalizeMailerEmailList(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[;,\s]+/);
  const seen = {};
  const result = [];
  raw.forEach(function (item) {
    const email = normalizeMailerEmail(item);
    if (email && !seen[email]) {
      seen[email] = true;
      result.push(email);
    }
  });
  return result;
}

function mailerRecordFromRow(row, rowNumber) {
  return {
    rowNumber: rowNumber,
    batchKey: String(row[0] || ''),
    createdAt: row[1] instanceof Date ? row[1].toISOString() : String(row[1] || ''),
    updatedAt: row[2] instanceof Date ? row[2].toISOString() : String(row[2] || ''),
    cohort: String(row[3] || ''),
    date: normalizeSheetDate(row[4]),
    mailType: String(row[5] || ''),
    status: String(row[6] || '').trim().toLowerCase(),
    recipientCount: Number(row[7] || 0),
    subject: String(row[8] || ''),
    error: String(row[12] || ''),
    transport: String(row[13] || ''),
    gmailMessageId: String(row[14] || ''),
  };
}

function findMailerBatch(sheet, batchKey) {
  if (!sheet || sheet.getLastRow() < 2) return null;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, mailerLogHeaders().length).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0] || '') === batchKey) return mailerRecordFromRow(rows[i], i + 2);
  }
  return null;
}

function reserveMailerBatch(request, addresses) {
  return withScriptLock(function () {
    const sheet = ensureMailerLog();
    const existing = findMailerBatch(sheet, request.batchKey);
    if (existing && ['sent', 'pending'].indexOf(existing.status) !== -1) {
      return Object.assign(existing, { duplicate: true });
    }
    const now = new Date();
    const values = [
      request.batchKey, existing ? new Date(existing.createdAt) : now, now,
      String(request.cohort || CONFIG.COHORT), request.date, request.mailType,
      'pending', addresses.studentBcc.length, request.subject,
      addresses.to.join(','), addresses.cc.join(','), addresses.bcc.join(','),
      '', '', '',
    ];
    if (existing) sheet.getRange(existing.rowNumber, 1, 1, values.length).setValues([values]);
    else sheet.appendRow(values);
    SpreadsheetApp.flush();
    return { rowNumber: existing ? existing.rowNumber : sheet.getLastRow(), duplicate: false };
  });
}

function finishMailerBatch(batchKey, status, error, transport, gmailMessageId) {
  return withScriptLock(function () {
    const sheet = ensureMailerLog();
    const existing = findMailerBatch(sheet, batchKey);
    if (!existing) throw new Error('Mailer batch reservation disappeared');
    sheet.getRange(existing.rowNumber, 3).setValue(new Date());
    sheet.getRange(existing.rowNumber, 7).setValue(status);
    sheet.getRange(existing.rowNumber, 13).setValue(String(error || '').slice(0, 500));
    sheet.getRange(existing.rowNumber, 14).setValue(String(transport || '').slice(0, 80));
    sheet.getRange(existing.rowNumber, 15).setValue(String(gmailMessageId || '').slice(0, 200));
    SpreadsheetApp.flush();
    return true;
  });
}

function validateMailerBatch(request) {
  const batchKey = String(request.batchKey || '').trim();
  const date = validDateKey(request.date);
  const mailType = String(request.mailType || '').trim().toLowerCase();
  const subject = String(request.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 180);
  const body = String(request.body || '').trim().slice(0, 12000);
  if (!/^[A-Za-z0-9:._-]{12,180}$/.test(batchKey)) throw new Error('Mailer batch key is invalid');
  if (!date || ['absent', 'warning1', 'warning2', 'inactive'].indexOf(mailType) === -1) {
    throw new Error('Mailer requires a valid date and mail type');
  }
  if (!subject || !body) throw new Error('Mailer subject and body are required');
  const to = normalizeMailerEmailList(request.to);
  const cc = normalizeMailerEmailList(request.cc);
  const extraBcc = normalizeMailerEmailList(request.extraBcc);
  const studentBcc = normalizeMailerEmailList(request.studentBcc);
  if (!to.length) throw new Error('Mailer To address is not configured');
  if (!studentBcc.length) return { skipped: true, reason: 'no-student-recipients' };
  const visible = {};
  to.concat(cc).forEach(function (email) { visible[email] = true; });
  const bcc = [];
  studentBcc.concat(extraBcc).forEach(function (email) {
    if (!visible[email] && bcc.indexOf(email) === -1) bcc.push(email);
  });
  if (!bcc.length) throw new Error('No private BCC recipient remains after deduplication');
  const totalRecipients = normalizeMailerEmailList(to.concat(cc, bcc));
  if (totalRecipients.length > MAIL_RECIPIENTS_PER_MESSAGE_LIMIT) {
    throw new Error('One mail batch cannot exceed ' + MAIL_RECIPIENTS_PER_MESSAGE_LIMIT + ' total To/CC/BCC recipients');
  }
  return {
    batchKey: batchKey, date: date, mailType: mailType, subject: subject, body: body,
    cohort: String(request.cohort || CONFIG.COHORT).trim().slice(0, 120),
    senderName: String(request.senderName || 'Job Placement — Programming Hero').trim().slice(0, 120),
    replyTo: normalizeMailerEmail(request.replyTo),
    to: to, cc: cc, bcc: bcc, studentBcc: studentBcc,
  };
}

function sendCohortEmailBatch(request) {
  const mail = validateMailerBatch(request || {});
  if (mail.skipped) return { ok: true, skipped: true, reason: mail.reason, recipients: 0 };
  const reservation = reserveMailerBatch(mail, mail);
  if (reservation.duplicate) {
    return {
      ok: reservation.status === 'sent', duplicate: true, status: reservation.status,
      recipients: reservation.recipientCount || mail.studentBcc.length,
      transport: reservation.transport || '', gmailMessageId: reservation.gmailMessageId || '',
      remainingDailyRecipients: MailApp.getRemainingDailyQuota(),
    };
  }
  const allRecipients = normalizeMailerEmailList(mail.to.concat(mail.cc, mail.bcc));
  const remaining = MailApp.getRemainingDailyQuota();
  if (remaining < allRecipients.length) {
    finishMailerBatch(mail.batchKey, 'failed',
      'Daily recipient quota is too low: need ' + allRecipients.length + ', remaining ' + remaining);
    throw new Error('Email recipient quota is too low for this batch');
  }
  try {
    const options = {
      bcc: mail.bcc.join(','),
      name: mail.senderName,
    };
    if (mail.cc.length) options.cc = mail.cc.join(',');
    if (mail.replyTo) options.replyTo = mail.replyTo;
    const sentMessage = GmailApp.createDraft(
      mail.to.join(','), mail.subject, mail.body, options).send();
    const gmailMessageId = sentMessage.getId();
    if (!gmailMessageId) throw new Error('Gmail did not return a sent message ID');
    finishMailerBatch(mail.batchKey, 'sent', '', 'gmail-draft', gmailMessageId);
    return {
      ok: true, duplicate: false, status: 'sent', recipients: mail.studentBcc.length,
      transport: 'gmail-draft', gmailMessageId: gmailMessageId,
      remainingDailyRecipients: MailApp.getRemainingDailyQuota(),
    };
  } catch (error) {
    finishMailerBatch(mail.batchKey, 'failed', String(error));
    throw error;
  }
}

function getMailerStatus() {
  const sheet = ensureMailerLog();
  const sent = [];
  if (sheet.getLastRow() > 1) {
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, mailerLogHeaders().length).getValues();
    rows.slice(-20).forEach(function (row, index) {
      const record = mailerRecordFromRow(row, Math.max(2, sheet.getLastRow() - 19 + index));
      sent.push({
        batchKey: record.batchKey, date: record.date, type: record.mailType,
        status: record.status, recipients: record.recipientCount,
        transport: record.transport, gmailMessageId: record.gmailMessageId,
      });
    });
  }
  return {
    version: VERSION,
    remainingDailyRecipients: MailApp.getRemainingDailyQuota(),
    recentBatches: sent,
  };
}

function authorizeMailer() {
  const result = getMailerStatus();
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function authorizeGmailMailer() {
  const aliases = GmailApp.getAliases();
  const result = {
    ok: true,
    account: Session.getActiveUser().getEmail(),
    aliases: aliases.length,
    note: 'Gmail mailbox authorization is ready for draft-send mail batches.',
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

// First-run helper for a copied cohort backend. Selecting and running this
// function in the Apps Script editor requests and verifies every Google service
// used by JP ADMIN without sending mail, creating Forms, or deleting data.
function authorizeAllRequiredServices() {
  validateConfig();
  const ss = getSpreadsheet();
  SpreadsheetApp.flush();
  const result = {
    ok: true,
    version: VERSION,
    spreadsheet: Boolean(ss),
    forms: FormApp.getActiveForm() ? 'active form available' : 'service authorized',
    triggers: ScriptApp.getProjectTriggers().length,
    mailQuotaAvailable: MailApp.getRemainingDailyQuota() >= 0,
    gmail: GmailApp.getAliases().length >= 0,
    outboundRequests: Boolean(UrlFetchApp.getRequest('https://script.google.com/')),
    note: 'Required Google services are authorized. No email was sent and no data was deleted.',
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

// ============================================================
//  WEB APP API
//  GET  ?action=attendance  -> today's present/absent (now with IDs)
//  GET  ?action=roster      -> full Bot_Map
//  POST {action:'saveIds'}  -> bot writes matched Discord IDs back
// ============================================================
function doGet(e) {
  try { return doGetInner(e); }
  catch (err) { return json({ error: 'AppsScript: ' + String(err).slice(0, 300) }); }
}
function doGetInner(e) {
  validateConfig();
  if (!e.parameter || e.parameter.key !== CONFIG.SECRET_KEY)
    return json({ error: 'unauthorized' });
  if (e.parameter.action === 'attendance') {
    return json(getTodayAttendance(e.parameter.guildId || ''));
  }
  if (e.parameter.action === 'attendanceaudit') {
    return json(getAttendanceAudit(e.parameter.date || todayStr(), e.parameter.guildId || ''));
  }
  if (e.parameter.action === 'pipelineaudit') {
    return json(getActivityPipelineAudit(
      e.parameter.date || todayStr(), e.parameter.guildId || ''));
  }
  if (e.parameter.action === 'absences') {
    return json(getAbsenceReport(
      e.parameter.start || todayStr(),
      e.parameter.end || todayStr(),
      e.parameter.guildId || '', String(e.parameter.includeExcluded || '') === '1'));
  }
  if (e.parameter.action === 'roster') {
    return json({
      roster: readBotMap(),
      excludedIds: excludedDiscordIds(e.parameter.guildId || ''),
    });
  }
  if (e.parameter.action === 'rosterreview') return json(getRosterReviewStatus());
  if (e.parameter.action === 'missingprofiles') return json(getMissingStudentProfiles());
  if (e.parameter.action === 'health') return json(healthCheck());
  if (e.parameter.action === 'formstatus') return json(getFormStatus());
  if (e.parameter.action === 'listforms') return json({ forms: listForms() });
  if (e.parameter.action === 'setactiveform') return json(setActiveForm(e.parameter.formId));
  if (e.parameter.action === 'nextquestion') {
    return json(nextQuestion(e.parameter.category || ''));
  }
  if (e.parameter.action === 'studentinfo') {
    return json({ students: studentInfo() });
  }
  if (e.parameter.action === 'performance') {
    return json(getPerformanceReport(
      e.parameter.start || '', e.parameter.end || '', e.parameter.email || '',
      String(e.parameter.includeHistory || '') === '1', Number(e.parameter.days) || 7));
  }
  if (e.parameter.action === 'rtbr') {
    return json(computeRtbr(Number(e.parameter.days) || 7, e.parameter.jobTarget));
  }
  if (e.parameter.action === 'getstates') {
    const prefix = 'ST_' + String(e.parameter.prefix || '');
    const all = PropertiesService.getScriptProperties().getProperties();
    const out = {};
    for (const k in all) if (k.indexOf(prefix) === 0) out[k.slice(3)] = all[k];
    return json({ states: out });
  }
  if (e.parameter.action === 'getstate') {
    return json({ value: PropertiesService.getScriptProperties().getProperty('ST_' + e.parameter.k) || '' });
  }
  if (e.parameter.action === 'nextresource') {
    return json(nextResource());
  }
  if (e.parameter.action === 'jobsheets') {
    return json({ sheets: readJobSheets() });
  }
  if (e.parameter.action === 'jobaudit') {
    return json(getJobAuditBundle(e.parameter.date || todayStr(), e.parameter.guildId || ''));
  }
  if (e.parameter.action === 'scores') {
    return json(getScores(Number(e.parameter.days) || 7));
  }
  if (e.parameter.action === 'outreachstatus') {
    const staleDays = Number(e.parameter.staleDays) || 2;
    return json(getOutreachStatus(staleDays));
  }
  if (e.parameter.action === 'leaverequests') {
    return json({ requests: getLeaveRequests(
      e.parameter.status || '', e.parameter.discordId || '', Number(e.parameter.limit) || 100) });
  }
  if (e.parameter.action === 'appeals') {
    return json({ appeals: getAppeals(
      e.parameter.status || '', e.parameter.discordId || '', e.parameter.scope || '',
      Number(e.parameter.limit) || 100) });
  }
  if (e.parameter.action === 'leavecalendar') {
    return json(getLeaveCalendar(e.parameter.date || todayStr()));
  }
  if (e.parameter.action === 'dawnabsences') {
    return json(getDawnAbsenceReport(
      e.parameter.start || todayStr(), e.parameter.end || todayStr(),
      e.parameter.guildId || ''));
  }
  if (e.parameter.action === 'mailerstatus') return json(getMailerStatus());
  if (e.parameter.action === 'renderUptimeSchedule') {
    return json({ schedule: getRenderUptimeSchedule_() });
  }
  if (e.parameter.action === 'openform') { openForm(); return json(getFormStatus()); }
  if (e.parameter.action === 'closeform') { closeForm(); return json(getFormStatus()); }
  return json({ error: 'unknown action' });
}

function doPost(e) {
  try { return doPostInner(e); }
  catch (err) { return json({ error: 'AppsScript: ' + String(err).slice(0, 300) }); }
}
function doPostInner(e) {
  validateConfig();
  let body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return json({ error: 'bad json' }); }

  if (body.key !== CONFIG.SECRET_KEY) return json({ error: 'unauthorized' });

  if (body.action === 'createForms') {
    return json(createCohortForms(body.cohort || 'Cohort', body.spec || null, body.kinds || null));
  }
  if (body.action === 'setupTrackingSheets') {
    return json(setupTrackingSheets(body.mode || 'existing', body.guildId || ''));
  }
  if (body.action === 'setupCohortWorkbook') {
    return json(setupCohortWorkbook(
      body.mode || 'repair',
      body.spreadsheetReference || '',
      body.guildId || ''));
  }
  if (body.action === 'arrangeSheetTabs') {
    return json(arrangeSheetTabs());
  }
  if (body.action === 'repairAttendanceRoster') {
    return json(repairAttendanceRoster(body.guildId || ''));
  }
  if (body.action === 'repairActivityPipelines') {
    return json(repairActivityPipelines(body.guildId || ''));
  }
  if (body.action === 'cleanBank') {
    return json(cleanBank(body.keywords || []));
  }
  if (body.action === 'saveProject') {
    return json(saveProject(body));
  }
  if (body.action === 'fillLocations') {
    return json(fillLocations(body.tab, body.column));
  }
  if (body.action === 'saveResume') {
    return json(saveResume(body.email, body.link, body.fileUrl));
  }
  if (body.action === 'logInterview') {
    return json(logInterview(body));
  }
  if (body.action === 'logInterviews') {
    return json(logInterviews(body));
  }
  if (body.action === 'backfillInterviews') {
    return json(backfillInterviews(body.entries || [], body.guildId || ''));
  }
  if (body.action === 'repairInterviewDuplicates') {
    return json(repairInterviewDuplicates(body.guildId || ''));
  }
  if (body.action === 'saveJobCounts') {
    return json(saveJobCounts(body.date || todayStr(), body.entries || [], body.guildId || ''));
  }
  if (body.action === 'saveJobSnapshots') {
    return json(saveJobSnapshots(body.date || todayStr(), body.entries || []));
  }
  if (body.action === 'logWorkshop') {
    return json(saveWorkshopAttendance(body.date || todayStr(), body.slot || '', body.entries || []));
  }
  if (body.action === 'saveResources') {
    return json(saveResources(body.items || []));
  }
  if (body.action === 'setState') {
    PropertiesService.getScriptProperties().setProperty('ST_' + body.k, String(body.v));
    const exclusionMatch = String(body.k || '').match(/^excl_(\d{15,22})$/);
    const statusStyles = exclusionMatch
      ? refreshStudentStatusStyles(exclusionMatch[1])
      : null;
    return json({ ok: true, statusStyles: statusStyles });
  }
  if (body.action === 'saveJobSheets') {
    let saved = 0;
    for (const it of (body.items || [])) {
      const r = saveJobSheet(it.email, it.sheetId, it.gid);
      if (!r.error) saved++;
    }
    return json({ saved: saved });
  }
  if (body.action === 'saveJobSheet') {
    return json(saveJobSheet(body.email, body.sheetId, body.gid));
  }
  if (body.action === 'addQuestions') {
    return json(addQuestions(body.questions || []));
  }
  if (body.action === 'logScore') {
    return json(logScore(body));
  }
  if (body.action === 'matchMissing') {
    return json(matchMissing(body.people || []));
  }

  if (body.action === 'syncDiscordRoster') {
    return json(syncDiscordRoster(body.people || [], body.guildId));
  }

  if (body.action === 'activateStudent') {
    return json(activateTrackedStudent(body));
  }
  if (body.action === 'activateStudents') {
    return json(activateTrackedStudents(body));
  }
  if (body.action === 'deactivateStudents') {
    return json(deactivateTrackedStudents(body));
  }

  if (body.action === 'addStudent') {
    return json(addStudent(body.email, body.discordId, body.username, body.displayName));
  }
  if (body.action === 'submitStudentProfile') {
    return json(submitStudentProfile(body));
  }
  if (body.action === 'setRenderUptimeSchedule') {
    return json(setRenderUptimeSchedule_(body.schedule || {}));
  }
  if (body.action === 'saveDawnAttendance') {
    return json(saveDawnAttendance(body.entries || [], body.date || todayStr(), body.guildId || ''));
  }
  if (body.action === 'saveDawnMembershipEvent') {
    return json(saveDawnMembershipEvent(body.entry || {}, body.date || todayStr(), body.event || ''));
  }
  if (body.action === 'repairDawnAttendance') {
    return json(repairDawnAttendance());
  }
  if (body.action === 'syncDawnMembers') {
    return json(syncDawnMembers(body.entries || [], body.date || todayStr()));
  }
  if (body.action === 'submitLeaveRequest') {
    return json(submitLeaveRequest(body));
  }
  if (body.action === 'decideLeaveRequest') {
    return json(decideLeaveRequest(body));
  }
  if (body.action === 'submitAppeal') {
    return json(submitAppeal(body));
  }
  if (body.action === 'decideAppeal') {
    return json(decideAppeal(body));
  }
  if (body.action === 'submitIntakeApplication') {
    return json(submitIntakeApplication(body));
  }
  if (body.action === 'updateIntakeApplicationStatus') {
    return json(updateIntakeApplicationStatus(body));
  }
  if (body.action === 'getIntakeRoleProfiles') {
    return json(getIntakeRoleProfiles(body.discordIds || []));
  }
  if (body.action === 'recordProfileSurveyDeliveries') {
    return json(recordProfileSurveyDeliveries(body.items || []));
  }

  if (body.action === 'logOutreach') {
    return json(logOutreach(
      body.email, body.date, body.guildId || '', body.messageId, body.messageUrl));
  }

  if (body.action === 'backfillOutreach') {
    return json(backfillOutreach(body.entries || []));
  }
  if (body.action === 'backfillOutreachDaily') {
    return json(backfillOutreachDaily(body.entries || [], body.guildId || ''));
  }

  if (body.action === 'sendCohortEmailBatch') {
    return json(sendCohortEmailBatch(body));
  }

  if (body.action === 'markHired') {
    return json(markHired(body.emails || []));
  }

  if (body.action === 'saveIds') {
    const map = ensureBotMap();
    const data = map.getDataRange().getValues();
    const rowByEmail = {};
    for (let i = 1; i < data.length; i++) {
      rowByEmail[normalizeStudentEmail(data[i][0])] = i + 1;
    }
    let saved = 0;
    for (const item of body.ids || []) {
      const row = rowByEmail[normalizeStudentEmail(item.email)];
      if (row && item.discordId) {
        map.getRange(row, 4).setValue("'" + item.discordId); // ' keeps it as text
        saved++;
      }
    }
    return json({ saved: saved });
  }
  return json({ error: 'unknown action' });
}

// ============================================================
//  ATTENDANCE
//  Response analysis is shared by the private audit and the posted report.
//  Only the posted report path writes P values into the matrix.
// ============================================================
function analyzeAttendanceResponses(dateKey, roster, summaryRoster) {
  const ss = getSpreadsheet();
  const dailyName = responseSheetName('attendance');
  const dailySheet = ss.getSheetByName(dailyName);
  if (!dailySheet) throw new Error('Attendance response tab not found: ' + dailyName);
  const d = dailySheet.getDataRange().getValues();
  if (!d.length) throw new Error('Attendance response tab is empty: ' + dailyName);
  const dh = d[0].map(String);
  const cDate = findHeader(dh, fieldCandidates('attendance', 'attendanceDate', ['Date of attendance', 'Attendance Date']));
  const cTimestamp = findHeader(dh, ['Timestamp', 'Submitted At', 'Submission Time', 'Response Timestamp']);
  const cMood = findHeader(dh, fieldCandidates('attendance', 'mood', ['Overall Mood', 'Mood']));
  const cInterview = findHeader(dh, fieldCandidates('attendance', 'interview', ['Faced Any Interview today?', 'Faced Any Interview']));
  const cInterviewShared = findHeader(dh, fieldCandidates('attendance', 'interviewShared',
    ['Shared Interview update on the Discord channel?', 'Shared Interview update']));
  const identityHeaders = attendanceIdentityValues(dh, dh).map(String);
  if (cTimestamp === -1 || !identityHeaders.length) {
    throw new Error('Attendance response tab must contain Timestamp and student identity columns; found: ' + dh.join(' | '));
  }

  const presentSet = {};
  const latestResponseByEmail = {};
  const identityIssues = [];
  const invalidDateRows = [];
  const correctedDateRows = [];
  const duplicateSubmissionRows = [];
  const firstResponseRowByEmail = {};
  let responseRows = 0;

  for (let i = 1; i < d.length; i++) {
    // Google Forms writes its Timestamp itself, while students can accidentally
    // choose a birthday or use DD/MM in the editable attendance-date question.
    // This is a same-day daily form, so the immutable submission timestamp is
    // authoritative. The selected date remains an auditable correction detail.
    const claimedDate = cDate === -1 ? '' : normalizeSheetDate(d[i][cDate]);
    const submittedDate = normalizeSheetDate(d[i][cTimestamp]);
    const rowDate = submittedDate;
    if (rowDate && !/^\d{4}-\d{2}-\d{2}$/.test(rowDate)) {
      invalidDateRows.push({
        row: i + 1,
        submitted: String(d[i][cTimestamp] || '').trim().slice(0, 80),
      });
      continue;
    }
    if (rowDate !== dateKey) continue;
    responseRows++;

    if (/^\d{4}-\d{2}-\d{2}$/.test(submittedDate) && claimedDate && claimedDate !== submittedDate) {
      correctedDateRows.push({
        row: i + 1,
        selected: String(cDate === -1 ? '' : d[i][cDate] || '').trim().slice(0, 80),
        countedAs: submittedDate,
      });
    }

    const identity = resolveRosterIdentity(attendanceIdentityValues(dh, d[i]), roster);
    if (!identity.student) {
      identityIssues.push({
        row: i + 1,
        reason: identity.ambiguous ? 'ambiguous identity' : 'not matched to the roster',
        submitted: (identity.submitted || []).join(' | ').slice(0, 160),
      });
      continue;
    }
    const email = identity.student.email;
    if (!email) continue;
    if (presentSet[email]) {
      duplicateSubmissionRows.push({
        row: i + 1,
        firstRow: firstResponseRowByEmail[email] || '',
        email: email,
      });
    } else {
      firstResponseRowByEmail[email] = i + 1;
    }
    presentSet[email] = true;
    // A later same-day submission is a correction. It remains a duplicate for
    // audit visibility, but its summary answers replace the earlier row.
    latestResponseByEmail[email] = {
      row: i + 1,
      mood: cMood === -1 ? 0 : Number(d[i][cMood]),
      interview: cInterview === -1 ? '' : d[i][cInterview],
      interviewShared: cInterviewShared === -1 ? '' : d[i][cInterviewShared],
    };
  }
  let moodSum = 0, moodCount = 0;
  const interviews = [];
  const interviewConflictRows = [];
  const rosterByEmail = {};
  roster.forEach(function (student) { rosterByEmail[student.email] = student; });
  const summaryEmails = {};
  (summaryRoster || roster).forEach(function (student) { summaryEmails[student.email] = true; });
  Object.keys(latestResponseByEmail).forEach(function (email) {
    const response = latestResponseByEmail[email];
    if (!summaryEmails[email]) return;
    if (response.mood) { moodSum += response.mood; moodCount++; }
    if (attendanceInterviewAnswerIsContradictory(response.interview, response.interviewShared)) {
      interviewConflictRows.push({ row: response.row, email: email });
    }
    if (attendanceInterviewAnswerIsPositive(response.interview, response.interviewShared)) {
      interviews.push(rosterByEmail[email] ? rosterByEmail[email].name : email);
    }
  });

  return {
    responseSheet: dailyName,
    responseRows: responseRows,
    matchedResponses: Object.keys(presentSet).length,
    presentSet: presentSet,
    moodSum: moodSum,
    moodCount: moodCount,
    interviews: interviews,
    identityIssues: identityIssues,
    invalidDateRows: invalidDateRows,
    correctedDateRows: correctedDateRows,
    duplicateSubmissionRows: duplicateSubmissionRows,
    interviewConflictRows: interviewConflictRows,
    dateHeader: cDate === -1 ? '' : dh[cDate],
    timestampHeader: cTimestamp === -1 ? '' : dh[cTimestamp],
    identityHeaders: identityHeaders,
    interviewHeader: cInterview === -1 ? '' : dh[cInterview],
    interviewSharedHeader: cInterviewShared === -1 ? '' : dh[cInterviewShared],
  };
}

function attendanceInterviewAnswerIsPositive(answer, sharedAnswer) {
  if (String(answer || '').trim().toLowerCase() !== 'yes') return false;
  return !attendanceInterviewAnswerIsContradictory(answer, sharedAnswer);
}

function attendanceInterviewAnswerIsContradictory(answer, sharedAnswer) {
  if (String(answer || '').trim().toLowerCase() !== 'yes') return false;
  const shared = String(sharedAnswer || '').trim().toLowerCase();
  // The confirmation question is more explicit than an accidental Yes click.
  return /no\s+interview|did\s+not\s+face|none\s+today/.test(shared);
}

function currentDiscordRosterAudit() {
  const sheet = getSpreadsheet().getSheetByName(rosterReviewName());
  if (!sheet || sheet.getLastRow() < 2) {
    return { total: 0, linked: 0, unlinked: [] };
  }
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, ROSTER_REVIEW_HEADERS.length)
    .getDisplayValues()
    .filter(function (row) { return normalizeDiscordId(row[0]); });
  const unlinked = rows.filter(function (row) {
    return String(row[3] || '').trim().toUpperCase() !== 'VERIFIED' ||
      !validStudentProfileEmail(row[4]);
  }).map(function (row) {
    return {
      discordId: normalizeDiscordId(row[0]),
      username: String(row[1] || ''),
      displayName: String(row[2] || row[1] || ''),
      reason: String(row[10] || 'Private identity data incomplete'),
    };
  });
  return { total: rows.length, linked: rows.length - unlinked.length, unlinked: unlinked };
}

function getAttendanceAudit(dateKey, guildId) {
  const normalizedDate = normalizeSheetDate(dateKey) || todayStr();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
    throw new Error('Attendance audit date must be YYYY-MM-DD');
  }
  const roster = readBotMap();
  const inactiveRosterStudents = roster.filter(function (student) {
    return student.active === false && student.status !== 'hired' && student.status !== 'left';
  }).map(function (student) {
    return {
      name: student.name,
      email: student.email,
      username: student.username || '',
      discordId: student.discordId || '',
      reasons: student.inactiveReasons || [],
      botMapColor: student.botMapColor || '',
      attendanceColors: student.attendanceColors || [],
    };
  });
  const matrix = attendanceRosterAudit(roster, guildId);
  const discord = currentDiscordRosterAudit();
  const responses = analyzeAttendanceResponses(normalizedDate, roster);
  const matrixPresent = matrixPresentOnDate(normalizedDate);
  const matrixLeave = matrixLeaveOnDate(normalizedDate);
  const presentStudents = matrix.active.filter(function (student) {
    return responses.presentSet[student.email] || matrixPresent[student.email];
  }).map(function (student) {
    return {
      name: student.name,
      email: student.email,
      phone: student.phone || '',
      username: student.username || '',
      discordId: student.discordId || '',
      source: responses.presentSet[student.email] ? 'FORM RESPONSE' : 'MATRIX P',
    };
  });
  const leaveStudents = matrix.active.filter(function (student) {
    return !responses.presentSet[student.email] && !matrixPresent[student.email] && matrixLeave[student.email];
  }).map(function (student) {
    return {
      name: student.name,
      email: student.email,
      phone: student.phone || '',
      username: student.username || '',
      discordId: student.discordId || '',
      source: 'APPROVED LEAVE',
    };
  });
  const notPresentStudents = matrix.active.filter(function (student) {
    return !responses.presentSet[student.email] && !matrixPresent[student.email] && !matrixLeave[student.email];
  }).map(function (student) {
    return {
      name: student.name,
      email: student.email,
      phone: student.phone || '',
      username: student.username || '',
      discordId: student.discordId || '',
    };
  });
  const discordRosterCaptured = discord.total > 0 || matrix.active.length === 0;
  return {
    cohort: CONFIG.COHORT,
    date: normalizedDate,
    currentDiscordStudents: discord.total,
    identityLinkedStudents: discord.linked,
    unlinkedDiscordStudents: discord.unlinked,
    activeRosterStudents: matrix.active.length,
    inactiveRosterStudents: inactiveRosterStudents,
    attendanceRows: Object.keys(matrix.rowsByEmail).length,
    missingAttendanceRows: matrix.missing,
    duplicateAttendanceEmails: matrix.duplicateEmails,
    orphanAttendanceRows: matrix.orphanRows,
    responseSheet: responses.responseSheet,
    responseRows: responses.responseRows,
    matchedResponses: responses.matchedResponses,
    presentStudents: presentStudents,
    leaveStudents: leaveStudents,
    notPresentStudents: notPresentStudents,
    identityIssues: responses.identityIssues,
    invalidDateRows: responses.invalidDateRows,
    correctedDateRows: responses.correctedDateRows,
    duplicateSubmissionRows: responses.duplicateSubmissionRows,
    interviewConflictRows: responses.interviewConflictRows,
    dateHeader: responses.dateHeader,
    timestampHeader: responses.timestampHeader,
    identityHeaders: responses.identityHeaders,
    discordRosterCaptured: discordRosterCaptured,
    ready: matrix.missing.length === 0 && matrix.duplicateEmails.length === 0 &&
      matrix.orphanRows.length === 0 && discord.unlinked.length === 0 &&
      discordRosterCaptured,
  };
}

function repairAttendanceRoster(guildId) {
  const roster = activeAttendanceRoster(readBotMap(), guildId);
  const result = ensureAttendanceRosterRows(roster);
  const after = attendanceRosterAudit(readBotMap(), guildId);
  return {
    activeStudents: result.activeStudents,
    added: result.added,
    updated: result.updated,
    duplicateAttendanceEmails: after.duplicateEmails,
    orphanAttendanceRows: after.orphanRows,
    missingAttendanceRows: after.missing,
  };
}

function getActivityPipelineAudit(dateKey, guildId) {
  const normalizedDate = normalizeSheetDate(dateKey) || todayStr();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
    throw new Error('Pipeline audit date must be YYYY-MM-DD');
  }
  const roster = readBotMap();
  const active = activeAttendanceRoster(roster, guildId);
  const activeByEmail = {};
  active.forEach(function (student) { activeByEmail[student.email] = student; });
  const discord = currentDiscordRosterAudit();
  let attendance;
  let attendanceError = '';
  try {
    attendance = getAttendanceAudit(normalizedDate, guildId);
  } catch (err) {
    attendanceError = String(err && err.message || err);
    attendance = {
      presentStudents: [],
      leaveStudents: [],
      missingAttendanceRows: [],
      duplicateAttendanceEmails: [],
      orphanAttendanceRows: [],
      identityIssues: [],
      invalidDateRows: [],
    };
  }
  const jobLinks = {};
  readJobSheets().forEach(function (item) { jobLinks[item.email] = item; });

  const jobCounts = {};
  const jobsSheet = getSpreadsheet().getSheetByName(CONFIG.SHEETS.jobsDaily);
  if (jobsSheet && jobsSheet.getLastRow() > 1) {
    const rows = jobsSheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (normalizeSheetDate(rows[i][0]) !== normalizedDate) continue;
      const email = normalizeStudentEmail(rows[i][1]);
      if (email) jobCounts[email] = Number(rows[i][2]) || 0;
    }
  }

  const outreachCounts = {};
  const outreachSheet = getSpreadsheet().getSheetByName(CONFIG.SHEETS.outreachDaily);
  if (outreachSheet && outreachSheet.getLastRow() > 1) {
    const rows = outreachSheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (normalizeSheetDate(rows[i][0]) !== normalizedDate) continue;
      const email = normalizeStudentEmail(rows[i][1]);
      if (email) outreachCounts[email] = (outreachCounts[email] || 0) + 1;
    }
  }

  const interviewCounts = {};
  const interviewSheet = getSpreadsheet().getSheetByName(CONFIG.SHEETS.interviewLog);
  if (interviewSheet && interviewSheet.getLastRow() > 1) {
    const rows = interviewSheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (normalizeSheetDate(rows[i][0]) !== normalizedDate) continue;
      const email = normalizeStudentEmail(rows[i][1]);
      if (email) interviewCounts[email] = (interviewCounts[email] || 0) + 1;
    }
  }

  const attendancePresent = {};
  attendance.presentStudents.forEach(function (student) {
    attendancePresent[student.email] = student.source || 'PRESENT';
  });
  (attendance.leaveStudents || []).forEach(function (student) {
    attendancePresent[student.email] = 'APPROVED LEAVE';
  });
  const students = active.map(function (student) {
    return {
      name: student.name,
      email: student.email,
      phone: student.phone || '',
      username: student.username || '',
      discordId: student.discordId || '',
      attendance: attendancePresent[student.email] || 'NO ATTENDANCE',
      tracker: jobLinks[student.email]
        ? (jobLinks[student.email].gid ? 'LINKED GID ' + jobLinks[student.email].gid : 'LINKED DEFAULT')
        : 'MISSING',
      jobs: Object.prototype.hasOwnProperty.call(jobCounts, student.email)
        ? jobCounts[student.email] : null,
      outreach: outreachCounts[student.email] || 0,
      interviews: interviewCounts[student.email] || 0,
    };
  });
  return {
    version: VERSION,
    cohort: CONFIG.COHORT,
    date: normalizedDate,
    currentDiscordStudents: discord.total,
    identityLinkedStudents: discord.linked,
    unlinkedDiscordStudents: discord.unlinked,
    activeStudents: active.length,
    inactiveColorStudents: roster.filter(function (student) {
      return student.active === false && student.status !== 'hired' && student.status !== 'left';
    }).map(function (student) {
      return {
        name: student.name,
        email: student.email,
        username: student.username || '',
        discordId: student.discordId || '',
        reasons: student.inactiveReasons || [],
      };
    }),
    hiredOrLeftStudents: roster.filter(function (student) {
      return student.status === 'hired' || student.status === 'left';
    }).length,
    attendance: {
      error: attendanceError,
      present: attendance.presentStudents.length,
      leave: (attendance.leaveStudents || []).length,
      missingRows: attendance.missingAttendanceRows,
      duplicateEmails: attendance.duplicateAttendanceEmails,
      orphanRows: attendance.orphanAttendanceRows,
      identityIssues: attendance.identityIssues,
      invalidDateRows: attendance.invalidDateRows,
    },
    jobs: {
      linked: active.filter(function (student) { return jobLinks[student.email]; }).length,
      missing: active.filter(function (student) { return !jobLinks[student.email]; }).map(function (student) {
        return { name: student.name, email: student.email, username: student.username || '', discordId: student.discordId || '' };
      }),
      savedForDate: Object.keys(jobCounts).filter(function (email) { return activeByEmail[email]; }).length,
    },
    outreachEvents: Object.keys(outreachCounts).reduce(function (sum, email) {
      return sum + (activeByEmail[email] ? outreachCounts[email] : 0);
    }, 0),
    interviews: Object.keys(interviewCounts).reduce(function (sum, email) {
      return sum + (activeByEmail[email] ? interviewCounts[email] : 0);
    }, 0),
    students: students,
    excludedIds: excludedDiscordIds(guildId),
  };
}

function repairActivityPipelines(guildId) {
  return withScriptLock(function () {
    const roster = readBotMap();
    const eligibleRoster = activeAttendanceRoster(roster, guildId);
    const attendance = ensureAttendanceRosterRows(eligibleRoster);
    const active = eligibleRoster.map(function (student) {
      return { values: [
        student.email, student.name, student.username, "'" + student.discordId,
        student.status || '', student.region || '', student.subregion || '',
        student.phone || '', student.matchSource || '', student.reviewNote || '',
      ] };
    });
    const jobs = upsertActiveIdentityRows(
      CONFIG.SHEETS.jobsMatrix, active, ['Name', 'Email', 'Phone']);
    const outreach = upsertActiveIdentityRows(
      CONFIG.SHEETS.outreachMatrix, active, ['Name', 'Email', 'Phone']);
    const interviews = upsertActiveIdentityRows(
      CONFIG.SHEETS.interviewMatrix, active, ['Name', 'Email', 'Phone']);
    ensureJobSheets();
    ensureJobsDailySchema();
    ensureInterviewLogSchema();
    ensureOutreachLog();
    ensureOutreachDailySchema();
    const outreachSummaries = reconcileAllOutreachSummaries();
    const statusStyles = refreshStudentStatusStyles(guildId);
    return {
      activeStudents: active.length,
      attendance: attendance,
      jobs: jobs,
      outreach: outreach,
      interviews: interviews,
      outreachSummaries: outreachSummaries,
      statusStyles: statusStyles,
      guildId: String(guildId || ''),
    };
  });
}

function getTodayAttendance(guildId) {
  const today = Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd');
  const fullRoster = readBotMap();
  const roster = activeAttendanceRoster(fullRoster, guildId);
  const analysis = analyzeAttendanceResponses(today, fullRoster, roster);
  const eligibleEmails = {};
  roster.forEach(function (student) { eligibleEmails[student.email] = true; });
  const presentSet = {};
  Object.keys(analysis.presentSet).forEach(function (email) {
    if (eligibleEmails[email]) presentSet[email] = true;
  });
  const moodSum = analysis.moodSum;
  const moodCount = analysis.moodCount;
  const interviews = analysis.interviews;

  // The immutable Google Form Timestamp is authoritative; the editable date
  // answer is already ignored/corrected above. A corrupt Timestamp is the one
  // date condition that must stop because its calendar day cannot be proven.
  if (analysis.invalidDateRows.length) {
    return {
      cohort: CONFIG.COHORT,
      date: today,
      blocked: true,
      blockReason: 'invalid-timestamps',
      present: [],
      leave: [],
      absent: [],
      presentCount: 0,
      leaveCount: 0,
      absentCount: 0,
      avgMood: null,
      interviewsToday: [],
      identityIssues: analysis.identityIssues,
      invalidDateRows: analysis.invalidDateRows,
      correctedDateRows: analysis.correctedDateRows,
      duplicateSubmissionRows: analysis.duplicateSubmissionRows,
      interviewConflictRows: analysis.interviewConflictRows,
      responseRows: analysis.responseRows,
      matchedResponses: analysis.matchedResponses,
    };
  }

  // Unmatched/ambiguous identities never count as present, but one wrong email
  // must not deny service to the complete cohort. The student remains absent
  // unless another valid response or an existing manual P/L mark exists.
  syncAttendanceMatrix(today, presentSet, roster);
  const absenceFlags = refreshAttendanceAbsenceFlags();
  const history = getRecentHistory(today);
  // ALSO honor a 'P' in today's column of the Attendance matrix
  // (a student marked present there counts present even without a form submit)
  const matrixP = matrixPresentToday();
  const matrixL = matrixLeaveOnDate(today);

  const present = [], leave = [], absent = [];
  for (const s of roster) {
    if (presentSet[s.email] || matrixP[s.email]) {
      present.push(s);
    } else if (matrixL[s.email]) {
      leave.push(s);
    } else {
      absent.push(Object.assign({ history: history[s.email] || null }, s));
    }
  }
  present.sort((a, b) => a.name.localeCompare(b.name));
  leave.sort((a, b) => a.name.localeCompare(b.name));
  absent.sort((a, b) => a.name.localeCompare(b.name));

  return {
    cohort: CONFIG.COHORT,
    date: today,
    presentCount: present.length,
    leaveCount: leave.length,
    absentCount: absent.length,
    present, leave, absent,
    avgMood: moodCount ? Math.round((moodSum / moodCount) * 10) / 10 : null,
    interviewsToday: interviews,
    identityIssues: analysis.identityIssues,
    invalidDateRows: analysis.invalidDateRows,
    correctedDateRows: analysis.correctedDateRows,
    duplicateSubmissionRows: analysis.duplicateSubmissionRows,
    interviewConflictRows: analysis.interviewConflictRows,
    responseRows: analysis.responseRows,
    matchedResponses: analysis.matchedResponses,
    absenceFlags: absenceFlags,
  };
}

// ============================================================
//  FORM SUBMISSIONS
//  Enrollment updates identity/matrix metadata. Attendance only
//  marks P for the submitted date; interview Yes/No answers must
//  never overwrite the Job Holder column.
// ============================================================
function rowValue(headers, values, candidates) {
  const index = findHeader(headers, candidates);
  return index === -1 ? '' : values[index];
}

function processEnrollmentRow(responseSheet, row) {
  const lastCol = responseSheet.getLastColumn();
  const headers = responseSheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const values = responseSheet.getRange(row, 1, 1, lastCol).getValues()[0];
  const email = normalizeStudentEmail(
    rowValue(headers, values, fieldCandidates('enrollment', 'enrollmentEmail', ['Email Address', 'Email'])));
  const name = String(rowValue(headers, values, fieldCandidates('enrollment', 'name', ['Your Name', 'Full Name', 'Name']))).trim();
  if (!email) throw new Error('Enrollment row has no email');

  PropertiesService.getScriptProperties().setProperty(PROPERTY_KEYS.enrollmentSheet, responseSheet.getName());
  const phone = String(rowValue(
    headers, values, fieldCandidates('enrollment', 'phone', ['WhatsApp Number', 'Phone', 'Mobile']))).trim();
  upsertAllDataFromEnrollment(email, name, phone);

  const map = ensureBotMap();
  const mapData = map.getDataRange().getValues();
  const region = String(rowValue(headers, values, fieldCandidates('enrollment', 'region', ['Current Region (Division)', 'Region', 'Division']))).trim();
  const subregion = String(rowValue(headers, values, fieldCandidates('enrollment', 'subregion', ['Current Subregion / Area', 'Subregion', 'Area']))).trim();
  let mapped = false;
  for (let i = 1; i < mapData.length; i++) {
    if (normalizeStudentEmail(mapData[i][0]) !== email) continue;
    mapped = true;
    if (name) map.getRange(i + 1, 2).setValue(name);
    if (region) map.getRange(i + 1, 6).setValue(region);
    if (subregion) map.getRange(i + 1, 7).setValue(subregion);
    if (phone) map.getRange(i + 1, 8).setValue(phone);
    break;
  }

  // Form submissions enrich the identity master, but do not create active
  // students. Discord membership must create the Bot_Map link first.
  if (!mapped) {
    console.log('Enrollment saved to All Data; awaiting Discord roster link for ' + email);
    return { stored: true, active: false };
  }

  const matrix = ensureAttendanceSheet();
  const matrixData = matrix.getDataRange().getValues();
  let matrixRow = -1;
  for (let i = 1; i < matrixData.length; i++) {
    if (String(matrixData[i][CONFIG.MATRIX.emailCol - 1]).trim().toLowerCase() === email) {
      matrixRow = i + 1;
      break;
    }
  }
  if (matrixRow === -1) {
    matrixRow = matrix.getLastRow() + 1;
    matrix.getRange(matrixRow, 1, 1, 6).setValues([[
      name,
      email,
      phone,
      String(rowValue(headers, values, fieldCandidates('enrollment', 'experience', ['Experience']))).trim(),
      String(rowValue(headers, values, fieldCandidates('enrollment', 'jobHolder', ['Currently Job Holder?', 'Job Holder']))).trim(),
      String(rowValue(headers, values, fieldCandidates('enrollment', 'jobFocus', ['Job Focus']))).trim(),
    ]]);
  } else {
    const existing = matrix.getRange(matrixRow, 1, 1, 6).getValues()[0];
    const updates = [
      name || existing[0], email,
      phone || existing[2],
      String(rowValue(headers, values, fieldCandidates('enrollment', 'experience', ['Experience']))).trim() || existing[3],
      String(rowValue(headers, values, fieldCandidates('enrollment', 'jobHolder', ['Currently Job Holder?', 'Job Holder']))).trim() || existing[4],
      String(rowValue(headers, values, fieldCandidates('enrollment', 'jobFocus', ['Job Focus']))).trim() || existing[5],
    ];
    matrix.getRange(matrixRow, 1, 1, 6).setValues([updates]);
  }
  syncTrackingStudent(email, name, String(matrix.getRange(matrixRow, 3).getValue() || '').trim());
  console.log('Enrollment synchronized for active Discord student ' + email);
  return { stored: true, active: true };
}

function processAttendanceRow(responseSheet, row) {
  const lastCol = responseSheet.getLastColumn();
  const headers = responseSheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const values = responseSheet.getRange(row, 1, 1, lastCol).getValues()[0];
  const roster = readBotMap();
  const identity = resolveRosterIdentity(attendanceIdentityValues(headers, values), roster);
  if (!identity.student) {
    console.warn('Attendance identity was not matched at row ' + row + ': ' +
      (identity.ambiguous ? 'ambiguous' : (identity.submitted || []).join(' | ').slice(0, 160)));
    return { marked: false, reason: identity.ambiguous ? 'ambiguous identity' : 'identity not found' };
  }
  const email = identity.student.email;
  PropertiesService.getScriptProperties().setProperty(PROPERTY_KEYS.attendanceSheet, responseSheet.getName());

  const rawTimestamp = rowValue(headers, values, ['Timestamp', 'Submitted At', 'Submission Time', 'Response Timestamp']);
  const timestampDate = normalizeSheetDate(rawTimestamp);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(timestampDate)) {
    throw new Error('Attendance response Timestamp is missing or invalid');
  }
  const dateKey = timestampDate;

  const sheet = ensureAttendanceSheet();
  let data = sheet.getDataRange().getValues();
  let matrixRow = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][CONFIG.MATRIX.emailCol - 1]).trim().toLowerCase() === email) {
      matrixRow = i + 1;
      break;
    }
  }
  if (matrixRow === -1) {
    const student = identity.student;
    if (!student) throw new Error('Attendance email is not enrolled: ' + email);
    matrixRow = sheet.getLastRow() + 1;
    sheet.getRange(matrixRow, 1, 1, 6).setValues([[student.name, email, '', '', '', '']]);
    data = sheet.getDataRange().getValues();
  }

  const dateCol = attendanceDateColumn(sheet, dateKey);
  sheet.getRange(matrixRow, dateCol).setValue('P').setBackground('#ffffff');
  console.log('✅ Marked P for ' + email + ' on ' + dateKey);
}

function onFormSubmit(e) {
  if (!e || !e.range) throw new Error('onFormSubmit requires a spreadsheet form-submit event');
  const responseSheet = e.range.getSheet();
  const row = e.range.getRow();
  const headers = responseSheet.getRange(1, 1, 1, responseSheet.getLastColumn()).getValues()[0].map(String);
  const hasAttendanceDate = findHeader(headers, fieldCandidates('attendance', 'attendanceDate', ['Date of attendance', 'Attendance Date'])) !== -1;
  const hasEnrollmentName = findHeader(headers, fieldCandidates('enrollment', 'name', ['Your Name', 'Full Name'])) !== -1;

  if (responseSheet.getName() === responseSheetName('attendance') || hasAttendanceDate) {
    // Google has already persisted the response row. Attendance is reconciled
    // in one idempotent batch when !closeform / !attendance requests the report,
    // avoiding one expensive Sheet mutation execution per student submission.
    console.log('Attendance response saved at row ' + row + '; matrix sync deferred to report time');
    return;
  }
  if (responseSheet.getName() === responseSheetName('enrollment') || hasEnrollmentName) {
    processEnrollmentRow(responseSheet, row);
    return;
  }
  console.log('⚠️ Ignored form response from unrecognized tab: ' + responseSheet.getName());
}

// ============================================================
//  FORM OPEN / CLOSE
// ============================================================
function attendanceFormId() {
  return PropertiesService.getScriptProperties().getProperty(PROPERTY_KEYS.attendanceFormId) || String(CONFIG.FORM_ID || '').trim();
}
function openForm() {
  const id = attendanceFormId();
  if (!id) throw new Error('No attendance form is active; run !createforms or !forms link <edit URL>');
  const form = FormApp.openById(id);
  if (form.isAcceptingResponses()) return; // already open
  form.deleteAllResponses(); // form-side cleanup only; Sheet rows are never touched
  form.setAcceptingResponses(true);
}

function closeForm() {
  const id = attendanceFormId();
  if (!id) throw new Error('No attendance form is active; run !createforms or !forms link <edit URL>');
  const form = FormApp.openById(id);
  form.setCustomClosedFormMessage('⚠️ Attendance Closed. Watch the Discord for the next window.');
  form.setAcceptingResponses(false);
}

function todayStr() {
  return Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd');
}

function normalizeSheetDate(value) {
  if (value instanceof Date && !isNaN(value)) return Utilities.formatDate(value, CONFIG.TZ, 'yyyy-MM-dd');
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const human = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (human) {
    const d = new Date(Number(human[3]), Number(human[2]) - 1, Number(human[1]));
    if (!isNaN(d)) return Utilities.formatDate(d, CONFIG.TZ, 'yyyy-MM-dd');
  }
  const parsed = new Date(raw);
  return isNaN(parsed) ? raw : Utilities.formatDate(parsed, CONFIG.TZ, 'yyyy-MM-dd');
}

function getFormStatus() {
  const id = attendanceFormId();
  if (!id) return { accepting: false, configured: false, error: 'no active attendance form', date: todayStr() };
  const form = FormApp.openById(id);
  return {
    accepting: form.isAcceptingResponses(),
    url: form.getPublishedUrl(),
    title: form.getTitle(),
    formId: id,
    date: Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd'),
  };
}

function formsLinkedToSpreadsheet() {
  const ss = getSpreadsheet();
  const seen = {};
  const out = [];
  ss.getSheets().forEach(function (sheet) {
    let url = '';
    try { url = sheet.getFormUrl() || ''; } catch (e) { return; }
    if (!url || seen[url]) return;
    try {
      const form = FormApp.openByUrl(url);
      seen[url] = true;
      out.push({ form: form, responseSheet: sheet.getName() });
    } catch (e) { /* skip forms this account cannot open */ }
  });
  return out;
}

function responseSheetForForm(formId) {
  const linked = formsLinkedToSpreadsheet();
  for (let i = 0; i < linked.length; i++) {
    if (linked[i].form.getId() === formId) return linked[i].responseSheet;
  }
  return '';
}

// list all forms linked to response tabs in this spreadsheet, so the user can pick
function listForms() {
  const linked = formsLinkedToSpreadsheet();
  const active = attendanceFormId();
  const out = [];
  for (let i = 0; i < linked.length; i++) {
    const f = linked[i].form;
    out.push({ id: f.getId(), title: f.getTitle(),
      publishedUrl: f.getPublishedUrl(), responseSheet: linked[i].responseSheet,
      isActive: f.getId() === active });
  }
  // the active form must appear even if its responses go to another sheet
  if (active && !out.some(function (f) { return f.id === active; })) {
    try {
      const f = FormApp.openById(active);
      out.unshift({ id: f.getId(), title: f.getTitle() || '(untitled form)',
        publishedUrl: f.getPublishedUrl(), isActive: true, external: true });
    } catch (e) { /* unreachable active form - formstatus will show the error */ }
  }
  return out;
}

function setActiveForm(formId) {
  formId = String(formId || '').trim();
  if (!formId) return { error: 'no form id' };
  try {
    const f = FormApp.openById(formId); // validate
    const responseSheet = responseSheetForForm(formId);
    const props = PropertiesService.getScriptProperties();
    props.setProperty(PROPERTY_KEYS.attendanceFormId, formId);
    if (responseSheet) props.setProperty(PROPERTY_KEYS.attendanceResponseSheet, responseSheet);
    return { active: formId, title: f.getTitle(), responseSheet: responseSheet || null };
  } catch (e) { return { error: 'form not found: ' + formId }; }
}

function healthCheck() {
  const ss = getSpreadsheet();
  const tabs = {};
  const configuredSheets = configuredSheetMap();
  for (const k in configuredSheets) {
    const resolvedName = k === 'roster' ? responseSheetName('enrollment') :
      k === 'daily' ? responseSheetName('attendance') : configuredSheets[k];
    tabs[resolvedName] = !!ss.getSheetByName(resolvedName);
  }
  let form = { ok: false };
  try {
    const f = FormApp.openById(attendanceFormId());
    form = { ok: true, title: f.getTitle(), accepting: f.isAcceptingResponses() };
  } catch (e) { form = { ok: false, error: String(e).slice(0, 100) }; }
  const result = {
    version: VERSION,
    cohort: CONFIG.COHORT,
    tz: CONFIG.TZ,
    tabs: tabs,
    responseSheets: {
      enrollment: responseSheetName('enrollment'),
      attendance: responseSheetName('attendance'),
    },
    spreadsheetIdStored: !!PropertiesService.getScriptProperties().getProperty(PROPERTY_KEYS.spreadsheetId),
    secretConfigured: secretConfigured(),
    form: form,
    time: new Date().toISOString(),
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
