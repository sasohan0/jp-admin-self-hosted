# Data, Environment, and State Contracts

The complete Apps Script source is stored in `Code-v19-FINAL.gs`; its internal
backend version is now `v55`. This document records the contract shared by that
backend and all bot callers. If an action or response changes, update both sides,
the contract tests, and the deployed Apps Script Web App version.

## Environment variables

### Always required

| Variable | Meaning | Secret? |
| --- | --- | --- |
| `DISCORD_TOKEN` | Token for the Discord bot application used by this process. | Yes |

### Legacy EJP-13 mode

Used only when no generic cohort identity variable is set.

| Variable | Meaning | Secret? |
| --- | --- | --- |
| `EJP13_API_URL` | EJP-13 Apps Script `/exec` Web App URL. | Operationally sensitive |
| `EJP13_API_KEY` | EJP-13 Apps Script shared secret. | Yes |

Guild, supervisor, channel, timezone, and schedule defaults for legacy mode are
currently in `config.js`.

### Isolated cohort mode

| Variable | Required | Meaning |
| --- | --- | --- |
| `COHORT_NAME` | Yes | Human-readable cohort name. |
| `COHORT_GUILD_ID` | Yes | Discord server/guild snowflake. |
| `COHORT_API_URL` | Yes | This cohort's Apps Script `/exec` URL. |
| `COHORT_API_KEY` | Yes | This cohort's Apps Script secret. |
| `COHORT_SUPERVISOR_IDS` | Yes | Comma-separated Discord user IDs. |
| `COHORT_TIMEZONE` | No | Defaults to `Asia/Dhaka`. |
| `COHORT_CHANNELS_JSON` | No | Channel-key→ID object; use `{}` for setup/discovery. |

Setting any of the first five activates isolated mode; partial configuration
then fails startup validation.

### Unified multi-cohort mode

Set `COHORT_REGISTRY_JSON` to an array of one to three enabled entries. Each
entry requires `key`, `name`, `guildId`, and `supervisorIds`; `channels`,
`timezone`, and schedule overrides are optional. The registry itself contains
no Apps Script secret. By default, an entry with `"key":"stride"` reads
`STRIDE_API_URL` and `STRIDE_API_KEY`; `apiUrlEnv`/`apiKeyEnv` can select
different environment-variable names.

`COHORT_REGISTRY_JSON` cannot be combined with generic single-cohort
`COHORT_*` identity variables. Duplicate keys, names, or guild IDs and more
than three enabled entries fail startup before Discord login.

Registry mode does not merge administration or data. Each guild uses its own
configured `#bot-admin` and resolves commands to its own Apps Script URL/key,
Sheet, forms, channels, supervisors, settings, switches, targets, schedules,
and persisted guild-namespaced state. `!openform`, `!closeform`, and
`!formstatus` therefore affect only the server in which the command is sent.

`BOT_ACTIVE_WINDOW=04:50-23:30` and `BOT_ACTIVE_TIMEZONE=Asia/Dhaka` are the
safe startup fallback. In managed mode, the protected control backend's
`JP_RENDER_UPTIME_SCHEDULE_V1` property is authoritative after it is reachable.
It supports one to four windows, repeating weekdays or exact dates, and
date-specific on/off overrides. The same schedule controls the Discord Gateway
and the external Render wake monitor.

For Discord-managed add/update/retire, configure these once:

| Variable | Meaning |
| --- | --- |
| `COHORT_CONTROL_KEY` | Registry key of the protected control cohort, normally `stride`. |
| `RENDER_DEPLOY_HOOK_URL` | Secret deploy hook for this Render service only. Do not use a broad Render API key. |

On first managed startup the bootstrap registry is copied into the control
cohort's Apps Script state. Later starts use that saved state before Discord
login. The control cohort remains anchored to its bootstrap URL/key and cannot
be retired through Discord.

### Optional schedule/content overrides

| Variable | Default/use |
| --- | --- |
| `FORM_OPEN_REMINDER` | `0 21 * * *` in isolated mode. |
| `FORM_CLOSE_REMINDER` | `15 22 * * *` in isolated mode. |
| `OUTREACH_CHECK_CRON` | `0 20 * * *` in isolated mode. |
| `JOBS_CHECK_CRON` | `30 22 * * *` (10:30 PM) in isolated mode. Former built-in `59 23 * * *` and `0 23 * * *` defaults migrate automatically. |
| `WORKSHOP_MEET_URL` | Default configured Google Meet URL. |
| `WORKSHOP_GPT_URL` | Default configured Speak More/ChatGPT URL. |

### AI, forwarding, and hosting

| Variable | Meaning |
| --- | --- |
| `GROQ_API_KEY` | One Groq key. |
| `GROQ_API_KEYS` | Comma-separated key rotation list; preferred when present. |
| `FORWARDER_SOURCE_CHANNEL_ID` | Isolated-mode default forwarding source; the source must belong to that service's cohort guild. |
| `FORWARDER_DESTINATION_CHANNEL_ID` | Isolated-mode default destination visible/sendable by the same bot application. |
| `FORWARDER_TARGET_USER_ID` | Only this user's source posts auto-forward. |
| `PORT` | Render-assigned keep-alive HTTP port; defaults locally in `keepalive.js`. |

The old generic name `CLIENT_ID` is not used. `DISCORD_CLIENT_ID` is required
only when the intake portal is enabled; `DISCORD_TOKEN` still authenticates the
running bot.

### Pre-entry intake portal

The unified service uses four one-time variables for every cohort portal:

| Variable | Meaning | Secret? |
| --- | --- | --- |
| `DISCORD_CLIENT_ID` | Public JP ADMIN Application ID. | No |
| `DISCORD_CLIENT_SECRET` | OAuth2 client secret from the Developer Portal. | Yes |
| `INTAKE_SESSION_SECRET` | Random 32+ character HMAC key for short-lived portal state. | Yes |
| `INTAKE_PUBLIC_URL` | HTTPS origin of the one Render service, without a path. | No |

The OAuth redirect is exactly
`<INTAKE_PUBLIC_URL>/intake/oauth/callback`; scopes are `identify guilds.join`.
OAuth access tokens stay only in process memory for at most 30 minutes and are
never written to Apps Script or Sheets.
Recognized private placement answers may prefill the existing
`ob_<guildId>_user_<userId>` record only after Discord admission; the portal
does not mark rules accepted or finalize roles by itself.

## Channel configuration contract

| Config key | Standard name | Recognized aliases | Setup permissions |
| --- | --- | --- | --- |
| `welcome` | `welcome-to-the-bootcamp` | `welcome-to-bootcamp`, `bootcamp-welcome`, `welcome` | Members view, bot/supervisors post |
| `rules` | `rules-and-regulations` | `rules-and-regulation`, `rules-regulations`, `server-rules`, `rules` | Members view, bot/supervisors post |
| `discussion` | `discussion` | — | Normal |
| `supervisor` | `bot-admin` | — | Hidden from `@everyone`; supervisors/bot allowed |
| `hired` | `successfully-hired` | — | Members view, bot/supervisors post |
| `outreach` | `outreach-update` | `outreach-updates`, `outreach` | Normal |
| `interviewUpdates` | `interview-update` | `interview-updates` | Normal |
| `workshop` | `communication-workshop` | — | Normal |
| `jobTracking` | `job-tracking-sheet` | `job-tracking` | Normal |
| `rtbr` | `right-to-be-referred` | — | Members view, bot/supervisors post |
| `automationLog` | `automation-announcement` | — | Members view, bot/supervisors post |
| `resources` | `resources` | — | Normal |
| `resource_sync_<sourceGuildId>_<destinationGuildId>` | destination cohort backend | `resources.js` | Destination-only opt-in for control-cohort resource mirroring. |
| `resumeUpdates` | `updated-resume` | `update-resume`, `resume` | Normal |
| `projects` | `my-best-projects` | `best-projects` | Normal |
| `jobHunting` | `job-hunting-channels` | `job-hunting-channel`, `job-hunting` | Normal |
| `warning` | `warning` | `warnings` | Members view, bot/supervisors post |
| `emergency` | `emergency` | — | Members view, bot/supervisors post |
| `discipline` | `dawn-focus-circle` | — | Normal text channel hidden from `@everyone`; role members send during the configurable window (default always), while student thread creation stays denied. |
| `issues` | `issues` | `issue`, `leave-requests`, `leave-request` | Normal student-facing request channel; leave reasons open privately and are sent only to bot-admin/Sheet. |
| `eliminated` | `eliminated-students` | `eliminated-student`, `inactive-students` | Readable student status/appeal channel; ordinary members cannot post. Third-warning notices mention only the affected student and include a mobile appeal button. |

Names are normalized by removing emoji/symbol separators and numeric prefixes.
Explicit valid text-channel IDs win in `!setupserver`; startup `discover.js`
preserves any non-placeholder explicit ID without live validation.

Runtime settings can override destinations for attendance, outreach, jobs,
workshop, discussion, reports, RTBR, and no-show output without changing the
base channel map.

## Apps Script transport

- Requests use the Web App `/exec` URL.
- Authentication is the shared `key` query/body field.
- GET uses `?action=<name>&key=<secret>&...`.
- POST sends JSON with `{ key, action, ...payload }` and follows redirects.
- Core callers use `apps-script-api.js`. GETs and explicitly idempotent writes
  use up to five paced attempts when Google returns a transient HTML 404/5xx,
  timeout, network error, or a recognized temporary Apps Script JSON failure
  such as Script Lock contention. Timeout/lock retries include a 15-second
  remote-completion grace because aborting the HTTP wait does not cancel an
  Apps Script execution. One isolated `unauthorized` response is confirmed
  through the same bounded five attempts on safe requests; a persistent wrong
  key still stops after that sequence.
  Retry URLs carry harmless cache-busting parameters. Non-idempotent writes are
  never retried by default.
- Callers expect JSON. A persistent HTML/DOCTYPE or `Unexpected token '<'`
  usually means a stale deployment, incorrect Web App access setting, or an
  archived/wrong `/exec` URL; a one-off occurrence can be a Google edge error.
- `doctor.js` currently expects backend health version `v55`.
- API executions open the explicitly stored `JP_SPREADSHEET_ID`; they do not
  depend on an active editor spreadsheet in Web App requests.
- Enrollment and attendance response-tab names are stored separately so copied
  Sheets and newly linked Forms do not have to remain `Form Responses 1/2`.

## Apps Script GET actions

| Action | Main callers | Expected purpose/result |
| --- | --- | --- |
| `health` | `doctor.js` | Version plus required-tab availability. |
| `roster` | `roster.js` | Student identity/status/location/active-color list plus guild manual exclusions in one execution. |
| `missingprofiles` | `student-data-survey.js` | Private, minimal list of current Discord IDs/display names and the profile field names still missing. It never returns stored email, phone, region, or subregion values. |
| `getstate` | state/forwarder/onboarding/doctor | One persistent value as `{ value }`. |
| `getstates` | settings/automations/onboarding | Prefix-filtered map as `{ states }`. |
| `formstatus` | attendance/form control/doctor | Active form ID/title/link and accepting state. |
| `openform` | `formcontrol.js` | Opens active form and returns link/status. |
| `closeform` | `formcontrol.js` | Closes active form. |
| `attendance` | attendance/reporter | Present/absent/history/interview summary. The immutable Form Timestamp controls the date; a wrong editable date is audit-only. Unmatched/ambiguous identities are rejected as non-attendance and remain absent without blocking other students. A missing/corrupt immutable Timestamp still stops safely. History uses only recorded matrix dates on or before the report date, merges duplicate rows/date columns, and honors updated P/L marks. Same-day duplicate Form submissions use the latest answer; an explicit “No interview faced today” confirmation vetoes a contradictory Yes. |
| `attendanceaudit` | `attendance.js` | Private, non-posting audit for one date: Discord-review linkage, active Bot_Map students, Attendance row readiness/duplicates, response identity matches, and invalid dates. |
| `pipelineaudit` | `attendance.js` | Private combined health view for Discord identity/color activity, Attendance, job tracker links/daily counts, outreach events, and interview events. It returns contact data only to the authorized bot-admin command. |
| `absences` | `attendance.js` | Private date-bounded active-student absence records with phone/username, recorded-session count, longest streak, and absent dates. Accepts `start`, `end`, and guild ID for manual exclusions. |
| `listforms` | `forms.js` | Forms discovered through individual response tabs, response-tab names, and active marker. |
| `setactiveform` | `forms.js` | Selects active form and its linked response tab; state-changing despite GET transport. |
| `outreachstatus` | outreach/DM/engagement/suggest | Stale, never, and activity values. |
| `rtbr` | RTBR/DM/engagement/match/suggest/reporter/weekly report | Rolling combined student scores/components plus raw application/interview/workshop counts. Native Sheet dates are normalized before range checks. Callers pass the guild's validated `jobTarget`; missing/invalid values retain the legacy 15 default. |
| `studentinfo` | students/engagement/match | Enriched identity/contact/location/resume/project information. |
| `performance` | weekly-report/student-reports/followup | Date-bounded jobs, attendance, interviews, outreach, per-date application/outreach values, approved leave dates, communication/question, and workshop metrics; optional private interview history and phone data. Attendance counts each student/date once even when duplicate matrix rows or date columns exist. |
| `leaverequests` | `leave.js` | Pending/decided private requests for the one-message `!openleaves` supervisor manager. |
| `leavecalendar` | Attendance/Dawn checks | Students with approved `L` on one date; used to suppress false absence/target penalties. |
| `dawnabsences` | `followup.js` | Date-bounded Dawn `A` records with approved leave excluded. |
| `appeals` | `appeals.js` | Pending or recent private bootcamp/Dawn appeal records for the current cohort. |
| `jobsheets` | jobs/doctor | Student tracker Sheet IDs/GIDs and identity data. |
| `jobaudit` | `jobs.js` | One quota-conscious bundle containing roster, exclusions, tracker references, private contacts, and saved counts for one date. |
| `nextquestion` | `questions.js` | Claims/returns an unused question for a category. |
| `scores` | `questions.js` | Score records/aggregates for requested day window. |
| `nextresource` | `resources.js` | Returns and advances the next saved resource. |

## Apps Script POST actions

| Action | Main caller | Payload/use |
| --- | --- | --- |
| `setState` | shared state modules | `k`, `v`; persistent control/onboarding/settings value. |
| `saveDawnAttendance` | `dawn-discipline.js` | One idempotent batch after the configured Sunday–Thursday window (default 05:00–07:00). The bounded Discord scan starts at the exact window end and keeps only in-window messages. It upserts the horizontal `Dawn_Attendance` matrix by email/date; cells contain `P · HH:MM`, approved `L`, or `A`. Message text is not stored. |
| `submitLeaveRequest` | `leave.js` | Idempotently creates a private pending leave request for one active Discord-linked student. |
| `decideLeaveRequest` | `leave.js` | Approves/rejects once; approval writes `L` to each selected configured working date in Attendance. |
| `submitAppeal` | `appeals.js` | Idempotently creates one pending private appeal per student/scope with cause, affected dates, explanation, and roster contact data. |
| `decideAppeal` | `appeals.js` | Idempotently records an approved/declined mentor decision and note. Discord access/status restoration is performed by the bot for the same scope. |
| `repairDawnAttendance` | `dawn-discipline.js` | Creates the canonical fallback `Dawn_Attendance` name for old CONFIG objects, merges only schema-matching generic Dawn tabs, then hides the preserved source tabs. |
| `syncDawnMembers` | `dawn-discipline.js` | One idempotent supervisor-triggered reconciliation of current Dawn role members plus role removals missed while offline. Upserts Name/Email/Phone and lifecycle events without adding attendance marks or deleting history. |
| `saveDawnMembershipEvent` | `dawn-discipline.js` | Records Dawn role `Joined`, `Removed`, and `Rejoined` lifecycle markers in the matching date cell without storing a Discord identifier in the Sheet. |
| `saveIds` | `roster.js` | Writes matched Discord IDs/usernames. |
| `matchMissing` | `missing.js` | Attempts bulk identity matching against Sheet data. |
| `addStudent` | `missing.js` | Adds/repairs one student mapping. |
| `markHired` | `hired.js` | Marks status and related rows/formatting as hired. |
| `createForms` | `cohort-admin.js` | Cohort name plus validated enrollment/attendance definitions containing title, description, collect-email flag, fields, stable semantic keys, checkbox/time/scale metadata, and choices. Legacy field arrays remain accepted. |
| `fillLocations` | `locations.js` | Source tab/column selection. |
| `logOutreach` | `outreach.js` | One Discord outreach event plus guild/message ID/source URL. Message-ID replay is idempotent and recoverable: a retry reconciles the durable event into both summary and matrix views after a partial/timed-out request. |
| `backfillOutreach` | `outreach.js` | Batched historical outreach entries. |
| `backfillOutreachDaily` | `outreach.js` | Reconciles only messages inside the requested 1-30-day window (three days by default) into `Outreach_Daily` by immutable message ID, then rebuilds affected summaries/dates without deleting older events. The bot submits at most 25 events per locked call. |
| `logInterviews` | `interview.js` | Live writes and bounded history reconciliation use the same per-message idempotent action. A requested 1-30-day window (three days by default) can add/repair only matching immutable message events and their dates without running a whole-history duplicate repair or changing older rows. |
| `setupTrackingSheets` | `attendance.js` | `mode=existing` rebuilds `Jobs Applied`, `Outreach Update`, and `Interview Updates` from durable logs; `mode=empty` creates clean roster templates. Both preserve raw logs, pass the guild ID for exclusions, and refresh Attendance/status formatting. |
| `arrangeSheetTabs` | `attendance.js` | Renames the configured active Form response tabs, then non-destructively orders/colors manual-review, active forms/reference, other Form-review, and bot-maintained groups. Unknown tabs remain visible and are not deleted. |
| `setupCohortWorkbook` | `cohort-sheet-command.js` | Optionally binds a Sheet URL/ID, creates required tabs and the form trigger, or performs backup-first cleanup/fresh initialization with explicit confirmation. |
| `syncDiscordRoster` | `roster.js` | Rebuilds active `Bot_Map` from current non-bot, non-supervisor Discord members. Roster Review columns E:I override older sources and survive future syncs. A member without a safe match receives a stable `@pending.jp-admin.invalid` internal identity, remains visibly profile-incomplete, and is added to All Data, Attendance, all three activity matrices, and Job_Sheets instead of being dropped. Replacing that pending email migrates operational rows/history. |
| `activateStudents` | `exclude.js` / `inactive-controls.js` | Atomically clears manual exclusion, Bot_Map/Attendance inactive colors, attendance warnings, and inactive metadata for a verified batch, then refreshes every status-styled matrix once. Hired/left is rejected per student. `activateStudent` remains the compatible single-student wrapper. |
| `deactivateStudents` | `exclude.js` / `inactive-controls.js` | Atomically adds verified Bot_Map students to guild exclusion state and records date/source/reason metadata before refreshing status styling. Hired/left is rejected. |
| `mailerstatus` | `mailer.js` | Returns remaining Apps Script daily recipient quota plus a bounded recent batch summary. It never returns secrets or message bodies. |
| `sendCohortEmailBatch` | `mailer.js` | Sends one validated plain-text group with students only in BCC. `Mailer_Log` reserves the guild/date/type/part batch key before Gmail draft-send, preventing retries from duplicating a sent/pending batch and recording the returned Gmail message ID. |
| `submitStudentProfile` | `student-data-survey.js` | Private modal submission keyed by the current Discord member ID. Student submissions are rate-limited and fill only missing authoritative values; supervisor submissions from `!editprofile` are explicitly marked as authoritative corrections. A missing Roster Review row is created safely, hired/left status is preserved, onboarding division can fill a missing region, and a changed real/provisional email migrates operational identity/history. Active successful writes synchronize All Data, Bot_Map, Attendance, all three activity matrices, Job_Sheets, and Roster Review without returning private values. |
| `submitIntakeApplication` | `intake-portal.js` | Idempotently writes one OAuth-bound application to `Intake Responses` and upserts its contact values into `All Data`. It deliberately does not activate Bot_Map or tracking rows. |
| `updateIntakeApplicationStatus` | `intake-portal.js` | Marks the saved application synchronized or action-required without resubmitting answers. |
| `recordProfileSurveyDeliveries` | `student-data-survey.js` | One batched delivery receipt write after DM attempts: `SENT`, `DM BLOCKED`, or `NOT IN SERVER`; completed profiles are never downgraded. For a brand-new join, it safely creates the incomplete Roster Review intake row without a full-roster Apps Script execution. |
| `repairAttendanceRoster` | `attendance.js` | Adds/refreshes all active Discord-linked Bot_Map identities in Attendance while preserving every date mark and manual value. |
| `repairActivityPipelines` | `attendance.js` | Preserves history while repairing active identity rows and schemas for Attendance and all three activity matrices. It reconciles `Outreach_Log` from immutable `Outreach_Daily` events while preserving legacy-only summaries, then refreshes inactive styling. |
| `saveJobSheet` | `jobs.js` | One student email→Sheet ID/GID link. |
| `saveJobSheets` | `jobs.js` | Batched tracker associations. |
| `saveJobCounts` | `jobs.js` | Cohort date, guild ID, and per-student counted applications/name; date+email writes are idempotent and matrix alerts honor manual exclusions. |
| `saveJobSnapshots` | `jobs.js` | Successful tracker row totals for one cohort date. Atomically stores a per-student baseline in Script Properties and returns the non-negative new-row delta used only when a recognizable application table lacks a usable date column. |
| `logInterviews` | `interview.js` | Bulk event list plus immutable Discord message ID/source URL. One lock upserts message-ID + event-index rows, preserves distinct multi-interview events, and updates real message edits without inflating serials. |
| `logInterview` | legacy callers | Backward-compatible single-event wrapper around `logInterviews`. |
| `repairInterviewDuplicates` | `interview.js` | Private exact-duplicate cleanup and per-student serial rebuild; distinct events are preserved. |
| `saveResume` | `resume.js` | Latest resume message pointer. |
| `saveProject` | `projects.js` | Project jump link and summary. |
| `addQuestions` | `questions.js` | Generated question rows. |
| `logScore` | `questions.js` | One evaluated answer, idempotent by student + Discord question message ID (date + question ID fallback for legacy rows). |
| `cleanBank` | `questions.js` | Question-bank cleanup request. |
| `logWorkshop` | `workshop.js` | Date, slot, and verified attendees; duplicate date+slot+email rows are ignored. |
| `saveResources` | `resources.js` | Batched records carrying immutable source message IDs for retry-safe storage. |

## Persistent state keys

The backend `setState/getstate/getstates` facility is used as a key-value store.

| Pattern | Owner | Value |
| --- | --- | --- |
| `setup_<guildId>` | `state.js` | `YYYY-MM-DD` server setup date. |
| `auto_<guildId>_<automationKey>` | `automations.js` | `1` or `0`. Includes daily `workshop`, opt-in `specialworkshop`, child-specific `leaderboard`/`weeklyreport`, and the legacy `reports` umbrella. Legacy `dailyreport` values are ignored because the report is manual-only. |
| `set_<guildId>_<settingKey>` | `settings.js` / scheduler | Runtime target, quantity, clock, question-period plan, workshop approval marker, special-workshop definition, channel, or JSON day list for `sched_*`. Clock values use zero-padded 24-hour `HH:MM` in the cohort timezone. |
| `excl_<guildId>` | `exclude.js` / roster | Comma-separated Discord user IDs. |
| `inactive_student_meta_v1_<guildId>` | `exclude.js`, `inactive-controls.js` | Per-student inactive date, source, reason, and recording timestamp for the private control panel. Existing warning timestamps are used only as a safe legacy fallback; unknown legacy dates are never invented. Verified activation removes the student's metadata. |
| `warning_report_last_v1_<guildId>` | `warning-controls.js` | Last cohort-local date whose scheduled private warning report completed. It makes the 30-minute recovery window restart-safe and duplicate-safe. Manual `!warningreport` does not change this marker. |
| `ob_<guildId>_user_<userId>` | `onboarding.js` | JSON private onboarding record. |
| `ob_<guildId>_rules_message` | `onboarding.js` | Official rules Discord message ID. |
| `ob_<guildId>_panel_message` | `onboarding.js` | Persistent welcome-panel message ID. |
| `ob_<guildId>_finalized` | `onboarding.js` | `1` after a failure-free final grouping run. |
| `fwd_<hubGuildId>_enabled` | `forwarder.js` | `1` or `0` for the explicit forwarding hub. |
| `fwd_<hubGuildId>_source` | `forwarder.js` | Source channel ID. |
| `fwd_<hubGuildId>_dest` | `forwarder.js` | Destination channel ID. |
| `doctor_<suffix>` | `doctor.js` | Temporary write-path probe. |
| `formtpl_<guildId>_working_<kind>` | `cohort-admin.js` | JSON working enrollment or attendance template. Stored separately to remain within Apps Script's per-value limit. |
| `formtpl_<guildId>_saved_<name>_<kind>` | `cohort-admin.js` | One named reusable enrollment/attendance template pair. |
| `formtpl_<guildId>_saved_names` | `cohort-admin.js` | JSON slug-to-display-name manifest for saved templates. |
| `managed_cohort_registry_v1_<controlGuildId>` | `managed-cohorts.js` | Private active-cohort registry used by `!cohorts` and server-local `!supervisor add/remove`; includes backend URL/key values and is readable only through the authenticated control Apps Script API. |
| pinned `JPADMIN_SETUP_V1:<payload>.<signature>` in private `#bot-admin` | `self-hosted-setup.js` | Mentor-owned installer identity, supervisor IDs, timezone, and discovered channel IDs. Contains no backend key or URL; HMAC signature uses the Render-only `COHORT_API_KEY`. A bad signature fails closed. |
| `JP_RENDER_UPTIME_SCHEDULE_V1` | `backend-control.js`, `operating-window.js`, `Render-Uptime-Monitor.gs` | Global unified-service schedule stored only in the protected control Apps Script project's raw ScriptProperties. It is accessed through authenticated `renderUptimeSchedule`/`setRenderUptimeSchedule` actions and is not guild-local. |
| `set_<guildId>_calendar_workdays` | `work-calendar.js` | JSON weekday-number array for the cohort's normal working week; defaults to Sunday–Thursday. |
| `set_<guildId>_calendar_overrides` | `work-calendar.js` | Bounded JSON map of `YYYY-MM-DD` to holiday/working override plus supervisor announcement context. |
| `content_source_v1_<destinationGuildId>` | `content-sync.js` | Secret-free snapshot of the selected reusable-content source, retained if that cohort is retired later. |
| `content_cursor_v1_<sourceGuildId>_<destinationGuildId>_<kind>` | `content-sync.js` | Last copied Discord message for Resources or Job Hunting history. |
| `content_auto_v1_<sourceGuildId>_<destinationGuildId>_<kind>` | `content-sync.js` | Destination-specific periodic one-item backfill switch. |
| `dawn_profiles_v1_<guildId>` | `dawn-discipline.js` | Private Dawn Focus membership status, consecutive misses, pending survey state, permit use, and durable `appealRequired` lock after removal. No reason is posted publicly. |
| `dawn_checkins_v1_<guildId>_<weekStart>` | `dawn-discipline.js` | IDs counted by the finished-window batch, persisted once at review time rather than once per message. |
| `dawn_config_v1_<guildId>` | `dawn-discipline.js` | Canonical normal-text channel ID plus archived legacy Forum/Media channel IDs used only for bounded history recovery. |
| `attendance_warning_state_v1_<guildId>` | `activity-automation.js`, `warning-controls.js`, `exclude.js` | Per-student warning count, consumed absence dates, shared baseline metadata, warning-driven inactive source, evaluated attendance date, and the separate date on which a warning was issued. Every run consumes at most one new pair; reruns cannot reuse dates. `!warnings start` safely rebases evidence; `!warnings undo` removes only the latest incident. Reactivation or `!warnings reset` clears the record. |
| `post_attendance_followup_v1_<guildId>` | `formcontrol.js`, `activity-automation.js` | Durable report date, due time, attempt count, and warning/mailer stage completion. It re-arms the ten-minute follow-up after restart and becomes `completed` only after every enabled stage finishes or the report date is confirmed non-working/warm-up. |
| `student_access_rules_v1_<guildId>` | `student-access.js` | Deduplicated role ID/channel ID/View Channel allow-or-deny rules. IDs are resolved only inside the command guild and reapplied at startup or by `!accessrules apply`. |
| `cohort_mailer_config_v1_<guildId>` | `mailer.js` | Private To/CC/additional-BCC/reply-to/sender/mentor fields and four editable templates. Student recipients are calculated at send time and are never stored in this state value. |
| `auto_<guildId>_mailer` | `automations.js`, `mailer.js` | Opt-in automatic mail after a successful attendance report and the subsequent warning classification. Manual preview/confirmed sends remain available while off. |
| `set_<guildId>_attendancewarningstart` | `settings.js`, `warning-controls.js`, `activity-automation.js` | Inclusive cohort-wide first date eligible for attendance-warning evidence. Set through `!warnings start YYYY-MM-DD`; do not use different dates per student. |
| `group_activities_v1_<guildId>` | `group-activities.js` | Parent channel ID and identity-role-to-private-thread mappings. |
| `intake_portal_v1_<guildId>` | `intake-settings.js` | JSON `{enabled,slug}` for the cohort-specific public portal. Disabling preserves all responses. |
| `JP_JOBSNAP_<encoded-email>` | Apps Script v23+ / `jobs.js` | Private tracker identity, day baseline, latest recognizable application-row total, and last check time for date-less fallback counting. Cleared when a tracker link changes or a new student batch is reset. |
| `JP_PROFILE_SUBMIT_ATTEMPT_<discordId>` | Apps Script v30+ / `student-data-survey.js` | One-hour private profile-submission rate-limit window. Deleted after a successful submission. |

Performance target setting keys are `jobstarget` and `outreachdaily` (per
scheduled day), plus `weeklyattendance`, `weeklyinterviews`,
`weeklycommunication`, and `weeklyworkshops`. Defaults are 15, 3, 5, 1, 3,
and 3 respectively. They are stored under the guild-namespaced `set_*` pattern,
so STRIDE can use 10 daily applications without changing EJP.

Additional runtime controls include `rtbrdays`, `rtbrtop`, `weeklytop`,
`jobshistory`, technical/communication/discussion question counts and windows,
workshop slots, leaderboard interval, and each clock key exposed by `!times`.
Day schedules use `sched_<automationKey>`. An explicit JSON `[]` means every
day, including the Thursday defaults for both weekly performance and RTBR tasks.

Apps Script Script Properties additionally hold the bound spreadsheet ID,
configured cohort, enrollment response-tab name, attendance response-tab name,
active attendance Form ID, and semantic-key-to-question-title maps for the two
created Forms. Those maps allow supervisors to reword bot-required questions
without breaking response processing. `initializeNewCohortCopy()` clears copied runtime
properties without deleting Sheet rows; `setup()` records fresh bindings and
installs only the required spreadsheet submit trigger.

The installed spreadsheet trigger processes enrollment metadata only.
Attendance responses are already durable in the response tab; the authenticated
`attendance` read reconciles that day's matched students into the matrix in one
idempotent batch to avoid one expensive mutation execution per submission.

For a genuinely new student batch, `prepareNewBatchReset()` creates a 15-minute
editor-only approval after showing the exact plan. `resetForNewStudentBatch()`
then clears copied student and activity rows while retaining question/resource
content. Question `Used On` and resource `Posted In New Server` markers reset so
the preserved material is reusable. Neither function is exposed through the Web
App API.

Forwarder keys are guild-namespaced using `FORWARDER_HUB_GUILD_ID` (or the
first registry cohort when no hub is explicitly configured). A one-time
compatibility read migrates the original `fwd_enabled/source/dest` keys into
the selected hub namespace. The legacy EJP configuration
uses EJP `#job-posts` as its source and STRIDE `#job-posts` as its destination.
If `fwd_dest` still contains the retired Endgame 12 channel, startup replaces
that exact value with the STRIDE destination. A route/access failure never
forwards to an unverified channel, but it also does not erase `fwd_enabled=1`.
Runtime status becomes WAITING and validation retries every five minutes and
on the next matching source post. Only `!forwarder stop` persists OFF.

### Onboarding record shape

Current records may include:

```json
{
  "userId": "Discord user ID",
  "gender": "female | male | private",
  "division": "Bangladesh division | Abroad | Other",
  "availability": "full_time | limited | study",
  "studyStage": "graduated | university_final | university_early | college | school | other",
  "rulesAccepted": true,
  "completedAt": "ISO timestamp",
  "updatedAt": "ISO timestamp",
  "groupRoleId": "Discord role ID",
  "groupName": "Bootcamp · Division · Fruit",
  "groupProvisional": false
}
```

Do not include raw records in public diagnostics.

## Google Sheet logical tables

The backend is expected to manage at least these logical tabs. Exact health-tab
requirements are defined by Apps Script, not this repository.

| Tab | Main use |
| --- | --- |
| `Enrollment Responses` / `Attendance Responses` | Friendly names applied to the two configured active response tabs by `!arrangesheets`. Google Forms continue using the same underlying sheets. Other Form-like tabs are kept and grouped yellow for review. |
| `Intake Responses` | Structured pre-entry applications. Fixed submission/Discord/status columns are followed by one readable column per editable enrollment-template question. Durable question IDs let title edits reuse/rename the existing column. Submission ID makes retries idempotent, and status distinguishes saved applicants from admitted active students. |
| `Attendance` | Per-session attendance matrix/history. Fixed columns are Name, Email, Phone, Experience, Job Holder, Job Focus, and mentor-editable Remarks; dates begin after Remarks. Repairs preserve Remarks. Inactive students are dark red across the full row and verified activation removes only that inactive styling. |
| `Dawn_Attendance` | Single horizontal Dawn matrix: Name, Email, Phone, then one column per scheduled Sunday–Thursday date. `P · HH:MM` records the first qualifying message inside the configured window (default 05:00–07:00); `A` means none. The same date cell preserves `Joined`, `Removed`, or `Rejoined`. Raw message content and Discord identifiers are not stored. |
| `Jobs Applied` | Rebuildable horizontal application-count view sourced from `Jobs_Daily`. Blank means no authoritative tracker count; zero is authoritative. Active rows below the latest-three-date threshold are light red; inactive rows override that with dark red. |
| `Outreach Update` | Rebuildable horizontal outreach-count view sourced from immutable `Outreach_Daily` messages. Missing student/date combinations display zero. Active rows below the latest-three-date threshold are light red; inactive rows are dark red. Duplicate/retried writes reconcile this view. |
| `Interview Updates` | Rebuildable horizontal interview-count view sourced from `Interview_Log`: frozen Name/Email/Phone followed by one count column per logged date. Missing combinations display zero. Inactive students are dark red; active students are white. |
| `All Data` | Preferred master identity/contact/location source. The private data survey fills missing full name, email, phone, current Discord username/ID, Region/Division, and Subregion/Area. Existing non-empty master values require supervisor review to change and are never silently replaced by a student submission. |
| `Bot_Map` | Current Discord-student identity book: email/name/username/Discord ID/status/region/subregion/phone/match source/review note. Discord membership controls inclusion; a Form or `All Data` row alone is never active. An intentionally colored Email cell here or in `Attendance` excludes the linked member. Visually white, very bright neutral theme fills remain active, and private audits expose exact exclusion colors. Verified `!studentstatus ... active` clears both identity-cell color markers plus the durable manual exclusion only after a fresh Discord sync; hired/left remains protected. |
| `Bot_Map Archive` | Stale and duplicate mappings preserved by `!syncmembers`; never used as the active roster. |
| `Roster Review` | Complete current eligible Discord roster. Columns E:I (email, name, phone, region, subregion) are durable supervisor-editable overrides and are never erased by `!syncmembers`; blanks may still be enriched from trusted sources. It records verified/profile-incomplete state, survey delivery/completion, onboarding-region fallback, and private differences from older master values. `!missingdata`/`!profilecheck` return only status and missing-field information, never stored contact values. |
| `Leave_Requests` | Private durable leave request/decision ledger. Submission/decision IDs are idempotent, one student may have only one pending request, and Discord processes cohort operations serially. Approved working dates are materialized as `L` in Attendance. Reasons/contacts remain private in bot-admin; status and mentor note are posted to the requesting student in `#issues`. |
| `Appeal_Logs` | Private durable bootcamp/Dawn removal appeal ledger: request/scope/student contact/cause/dates/explanation/status/mentor decision. Never publish raw rows outside `#bot-admin`. |
| `Mailer_Log` | Private email batch ledger: key/time/cohort/date/type/status/count/subject/administrative headers/BCC audit/error/transport/Gmail message ID. It supports idempotency and must not be copied into public reports. |
| `Outreach_Log` | Outreach events/aggregates. |
| `Question_Bank` | Questions, categories, answers, used state. |
| `Scores` | Evaluated answers and points, idempotent by student email + immutable Discord question message ID; legacy rows use date + question ID. |
| `Job_Sheets` | One identity row for every active Discord student plus any saved tracker Sheet ID/GID. Blank Sheet ID/GID means the member has not linked a tracker; `DEFAULT` means a posted link omitted `gid`. Nightly and private audits inspect up to 30 public tabs, preserve explicit GIDs, and report both total application rows and requested-date counts. |
| `Jobs_Daily` | Dated application counts and streak inputs: Date, Email, Count, Name; one authoritative row per date+email. Existing rows are retained and names are backfilled during setup. Counts from a date-less tracker are labeled as snapshot estimates in Discord before being saved. |
| `Outreach_Daily` | One durable dated row per recorded outreach message: Date, Email, Discord Message ID, source URL, and logged time. Message ID makes live retries and backfills idempotent. Existing-mode matrix setup aggregates these rows into student/date counts. |
| `Interview_Log` | Interview events: logged date, email/name/company, per-student serial, interview date, role, details, Discord URL, logged timestamp, immutable Discord message ID, and zero-based event index. The backend bulk-upserts one Discord message under one lock; embed updates, retries, and real edits cannot append duplicate events. Existing history is retained and serialized during setup. |
| `Workshop_Attendance` | Date/slot/student attendance. |
| `Resumes` | Latest resume message pointers. |
| `Projects` | Project links/summaries used by matching. |
| `Resources` | Preserved resource messages plus source Discord message ID for idempotent live sync/backfill. |

## Cache and restart behavior

| State | Location | Typical lifetime/restart effect |
| --- | --- | --- |
| Roster/exclusion reads | `roster.js` memory | Ten minutes; roster plus manual exclusions are fetched in one backend execution and rebuilt after restart. |
| Settings/automation reads | module memory | Thirty minutes; Discord control writes invalidate the relevant cache immediately and durable values remain in backend. |
| Setup date | `state.js` memory | Ten minutes; durable value remains. |
| Question windows/plans | `questions.js` memory/timers | Open window/plan can be lost on restart; persisted bank/scores remain. |
| Workshop daily attendance snapshot | `workshop.js` memory | Can be rebuilt only through subsequent poll operations; logged backend rows remain. |
| Form/activity approvals | memory maps | Pending approval lost on restart. |
| Forward edit map | `forwarder.js` memory | Old forwarded messages stop edit-syncing after restart. |
| Reporter entries | `reporter.js` memory | Unposted log entries lost on restart. |
| Onboarding assignment queues | `onboarding.js` memory | Only serialization is lost; records/roles/message IDs remain. |

Durable new business data must not rely on these caches/maps.
