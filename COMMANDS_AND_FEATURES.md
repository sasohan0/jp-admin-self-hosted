# Commands and Feature Ownership

This is the code-level command map. Commands are prefix commands handled through
Discord `messageCreate`; onboarding also uses buttons/select menus and join
events. Unless a row explicitly says otherwise, commands are supervisor-only.

## Server setup and diagnostics

| Command | Module | Scope | Effect |
| --- | --- | --- | --- |
| `!setupserver` | `setup-command.js` | Configured supervisor | Reuses/creates standard channels, repairs permissions, discovers IDs, posts introductions, begins warm-up, and prepares rules/onboarding. |
| `/setup` or `!setup` / `!setup guide` | `self-hosted-setup.js` | Server owner or administrator during first self-hosted run; afterward a configured supervisor in private `#bot-admin` | Opens a four-step button guide for Apps Script authorization, safe existing-channel matching, Discord-primary roster sync, and verification. The slash command avoids first-run dependence on Message Content Intent. The server owner is always a permanent recovery supervisor. Self-hosted first run persists only a signed non-secret setup capsule. Managed deployments also expose the existing Add cohort flow. |
| `!ensurechannels` | `setup-command.js` | Configured supervisor in any channel | Reuses/creates only missing standard channels, repairs private/locked overwrites, and refreshes discovery without reposting introductions or changing the warm-up date. Useful for a live cohort whose template is missing a newly required channel. |
| `!repairpermissions` | `setup-command.js` | Configured supervisor in `#bot-admin` | Repairs private/locked standard channel overwrites without recreating channels, reposting introductions, or resetting warm-up. |
| `!announceall` | `announce.js` | Supervisor | Posts/pins all standard introductions and mirrors them to the automation log. |
| `!announce <channel-key>` | `announce.js` | Supervisor | Posts/pins one standard introduction. |
| `!editannouncement <Discord message link>` | `announce.js` | Configured supervisor in `#bot-admin` | Opens a private prefilled modal and edits that pinned bot-authored rules/introduction message in place. The message ID, pins, and onboarding rules links remain valid. |
| `!checkperms` | `perms.js` | Supervisor | Reports effective server/channel permissions. |
| `!doctor [check]` | `doctor.js` | Supervisor | Runs all or one live health check. The roster check reports verified Bot_Map rows, every current Discord student captured in Roster Review, and the pending private-verification count. Invalid names return the current check list. |
| `!help` / `!commands` / `!commandcenter` | `help.js` | Supervisor, private `#bot-admin` | Opens the cohort-specific Command Center with a category selector, mobile-friendly Search modal, and Full Reference button. Search results are ephemeral. `!help <words>` performs a direct search and `!help all` posts the complete reference. |
| `!dailyreport` | `reporter.js` | Supervisor | Posts and clears the current in-memory operational report. |
| `!cohortstatus` | `cohort-status.js` | In the current server's private `#bot-admin`, checks only that server's Discord connection, configured channels, and Sheet backend without printing URLs or keys. |
| `!cohorts` / `!cohortmanager` | `cohort-manager.js` | Private managed-deployment panel for adding, updating, or retiring a cohort. The caller must be a supervisor in every active cohort. New backends and Administrator access are validated before the registry is saved; the protected control cohort cannot be retired. |
| `!backend` / `!backend help` | `backend-control.js` | Shows the unified service schedule or its command guide. It works only in the protected control cohort's private `#bot-admin`, and the caller must supervise every active cohort. |
| `!backend windows <HH:MM-HH:MM[,HH:MM-HH:MM...]>` | `backend-control.js` | Saves one to four daily Render/Discord active windows, immediately reconciles the current connection, and ensures exactly one five-minute Apps Script monitor trigger. |
| `!backend days everyday\|weekdays\|mon,wed,...` | `backend-control.js` | Chooses repeating active weekdays and exits exact-date mode. `weekdays` means Sunday through Thursday. |
| `!backend dates <YYYY-MM-DD,...>\|clear` / `!backend date <YYYY-MM-DD> on\|off\|clear` | `backend-control.js` | Runs only on listed dates, returns to recurring days, or applies/removes one date-specific override. |
| `!backend override <YYYY-MM-DD[,YYYY-MM-DD...]> always\|HH:MM-HH:MM[,..]\|off\|clear` | `backend-control.js` | Applies a self-expiring full-day or custom-window exception to only those dates. The regular schedule resumes automatically afterward. |
| `!supervisor [list]` / `!supervisor add @user-or-ID` / `!supervisor remove @user-or-ID` | `cohort-manager.js` | Private, server-local supervisor management in that cohort’s `#bot-admin`. Add accepts a current member or preconfigures an absent person's raw Discord ID, saves the durable registry, repairs private/locked permissions when present, and excludes the ID from student tracking. Remove revokes standard overwrites and resyncs a remaining guild member as a normal Discord student; self-removal is blocked. |
| `!groqstatus` | `groqstatus.js` | Supervisor | Shows configured Groq keys and observed quota. |

## Private onboarding administration

These commands must be run in the configured supervisor channel.

| Command | Module | Effect |
| --- | --- | --- |
| `!onboardingpanel` | `onboarding.js` | Creates or refreshes the pinned persistent welcome panel and rules link. |
| `!onboardingstatus` | `onboarding.js` | Separately shows complete-with-rules, ready role profiles, rules-only pending members, genuinely missing role data, division/readiness, and availability review without displaying gender. |
| `!restorerolesfromintake @student\|DiscordID\|all` | `onboarding.js`, Apps Script v60 | Privately reloads the latest structured Intake Responses row for selected current student(s), persists its validated onboarding profile, and reconciles all managed roles. Stored lowercase semantic field tags are mapped back to canonical role fields before validation. It never prints private answers or touches members outside the command guild. |
| `!onboardingreminder [#channel]` | `onboarding.js` | Mentions only current members whose private onboarding is incomplete, in `#discussion` by default or a selected same-server text channel. It posts only the rules/onboarding buttons and never displays private answers. |
| `!rolerepair [#channel]` | `onboarding.js` | Sequentially reconciles independent division, Dhaka-area, availability, work-mode, English, and multi-skill roles. Legacy fruit assignments are removed from members but no role/data is deleted. Missing students are mentioned in the selected channel (discussion by default) with a private form and one durable two-hour follow-up. |
| `!onboardingrepair` | `onboarding.js` | Compatibility alias for `!rolerepair`. |
| `!completioncheck` | `onboarding.js` | Syncs the current Discord roster, then privately lists the union of students missing private onboarding and/or required profile fields. No public ping. |
| `!completionreminder` | `onboarding.js` | Runs the same combined check and posts buttons in the configured welcome channel while mentioning only the incomplete current students. Profile and onboarding forms remain private. |
| `!finalizegroups` | `onboarding.js` | Retired compatibility command that directs mentors to `!rolerepair`. |
| `!setrulesmessage <Discord message link>` | `onboarding.js` | Selects an existing message in this server's configured rules channel and refreshes the panel link. |
| `!resetonboarding @member` | `onboarding.js` | Deletes one stored response record and removes bot-managed identity/readiness roles. |

Member-facing onboarding is not a prefix command. A complete authenticated
intake assigns the roles and skips the fallback questionnaire; the delayed join
greeting asks only for explicit rules acceptance. Missing intake role fields
still open the private paged fallback questionnaire.
New non-bot, non-supervisor members also receive the five-field private contact
form in DM. The welcome panel contains **Complete my private profile** as a
fallback. Submitting it creates or repairs `All Data`, `Bot_Map`, `Roster Review`,
`Attendance`, `Jobs Applied`, `Outreach Update`, `Interview Updates`, and `Job_Sheets`; email and phone
are required, and no answer is posted publicly.

## Pre-entry intake portal

These commands are supervisor-only in that cohort's private `#bot-admin`.

| Command | Module | Behavior |
| --- | --- | --- |
| `!intake status` | `intake-config.js` | Shows whether this cohort portal is open, its link, and whether the shared OAuth environment is ready. |
| `!intake enable [slug]` | `intake-config.js` | Opens a unique cohort link after environment and duplicate-slug validation. It uses the current working enrollment template. |
| `!intake disable` | `intake-config.js` | Stops new intake sessions without deleting `Intake Responses` or `All Data`. |
| `!intake link` | `intake-config.js` | Returns the shareable portal URL without mentioning students. |

Applicants authenticate with Discord before seeing the full-screen form. A
valid submission is stored first; Discord admission and the active tracking
profile are then synchronized. This replaces the enrollment Google Form, not
the daily attendance Form. `!formtemplate` remains the editor and reusable
template system for both enrollment intake and attendance.
If a configured supervisor uses the portal for a smoke test, the structured
application and Discord admission result are stored but the supervisor is never
activated in Bot_Map or any student tracking matrix.
The English-only default retains every non-Discord field from the STRIDE data
collection Form. OAuth supplies the username instead of asking students to type
it; the portal keeps its own pre-entry rules commitment without duplicating the
old "already joined" question.
Built-in division, conditional Dhaka area, availability, job preference,
English rating, and multi-select technologies prefill the role profile after
admission. OAuth-bound resubmission updates mutable profile/role data and starts
role reconciliation immediately. Rules acceptance remains an explicit Discord
action; private gender/study answers are never exposed as roles.

## Identity, roster, and engagement

| Command | Module | Effect |
| --- | --- | --- |
| `!syncmembers` | `sync-command.js` / `roster.js` | In private `#bot-admin`, captures every current non-bot/non-supervisor member in Roster Review and searches All Data, OAuth intake, recognized Form tabs, safe legacy contact tabs, and Bot_Map history. Durable Discord IDs win; display names alone are never trusted. Only real-email/full-name/valid-phone profiles enter Bot_Map or tracking. Newly unresolved members receive the private data form once, and public attendance/activity reports pause until coverage is complete. |
| `!missingdata` | `student-data-survey.js` | In private `#bot-admin`, shows only who needs data, missing field names, and non-private delivery/completion receipts. The button sends/retries pending current members without resending already-delivered surveys. Discord ID/username are automatic; successful submissions fill only missing master values and synchronize identity/tracking tabs. “Delivered” means Discord accepted the DM; Discord provides no read/open receipt. |
| `!profilecheck` | `student-data-survey.js` / `roster.js` | In private `#bot-admin`, refreshes the current Discord-primary roster, safely preserves Bot_Map if too few identities match, and reports current members captured, identity-linked rows, complete profiles, and missing profiles. |
| `!profilesurvey #channel` | `student-data-survey.js` | In private `#bot-admin`, refreshes roster capture, then posts a minimal mention list and button in the chosen same-server text channel. The button opens a private modal bound to the clicking member's Discord ID; no profile answers are posted publicly. |
| `!editprofile @student` / `!editprofile <Discord ID>` | `student-data-survey.js` | In private `#bot-admin`, immediately opens a supervisor-only correction modal for full name, real enrollment email, phone/WhatsApp, region, and area; it does not wait on a Sheet read that could time out the Discord interaction. Prefer a raw Discord ID when no student notification is wanted. A validated correction overwrites those authoritative profile fields, migrates a changed email across operational history, and repairs every identity/tracking row. |
| `!synchiredroles` | `hired.js` | In private `#bot-admin`, creates/reuses the Hired role and assigns it to every member with explicit `Bot_Map` status `hired`. |
| `!statusroles` | `student-access.js` | Reconcile all current members from verified status into exactly one Active Student or Inactive Student role; hired/left has neither. Reports hierarchy/member failures privately. |
| `!accessrules list\|defaults\|apply` | `student-access.js` | Inspect/reapply durable role/channel visibility. Defaults deny job-post visibility only to Inactive Student; Hired changes only through an explicit rule. |
| `!accessrules block\|unblock\|allow @role #channel` | `student-access.js` | Block any role from one channel, restore Discord/category inheritance, or explicitly allow viewing. `deny`/`remove` remain supported aliases; every ID is resolved inside the current cohort guild. |
| `!audit` | `missing.js` | Two-way Discord/Sheet audit with automatic backend matching where possible. |
| `!findmissing` | `missing.js` | Alias of `!audit`. |
| `!addstudent <email> @member` | `missing.js` | Manually creates/repairs one identity mapping. |
| `!exclude @member` | `exclude.js` | Excludes a member from warnings, checks, and DMs without changing hired/left status. |
| `!include @member` | `exclude.js` | Removes the manual exclusion. |
| `!excluded` | `exclude.js` | Lists manual exclusions. |
| `!studentstatus @member active\|inactive` | `exclude.js` | Inactivation retains data. Activation syncs the current Discord roster, clears manual and Bot_Map/Attendance color exclusions plus warnings through Apps Script, then reloads and verifies the student before reporting success. Hired/left is protected. |
| `!studentstatus list` | `exclude.js` | Private non-pinging list of manually inactive students. |
| `!studentstatuspanel` | `inactive-controls.js` | Private active/inactive/protected counts with tap-to-open separate lists. Active-list inactivation requires confirmation; inactive-list activation uses the verified backend path. All buttons acknowledge Discord before remote work. |
| `!activestudents [page n]` | `inactive-controls.js` | Opens the active list directly with one confirmed inactivation control per current student. |
| `!inactivestudents` | `inactive-controls.js` | Private paginated control panel for every current activatable inactive student. Shows inactive date/reason/warning count and provides per-student activation/email buttons plus confirmation-gated activate-by-date, activate-all, and email-all actions. Inactive mail uses the configured inactive template, keeps the mentor in To, and places students only in BCC. Legacy records without metadata say the date was not recorded; hired/left records are protected. |
| `!warnings @member` | `warning-controls.js` | Private current active/inactive state, warning count, and latest counted pair. |
| `!warnings reset @member` | `warning-controls.js` | Clears only the student's attendance-warning history; it does not change active/inactive state. Normal reactivation through `!studentstatus ... active` also resets warnings automatically. |
| `!warnings undo @member` | `warning-controls.js` | Reverses only the latest warning pair while preserving earlier valid warnings. If that latest warning caused warning-based inactivity, the student is safely reactivated and the corrected counter is restored. A focused correction mentions the student in `#warning`; private state details remain in `#bot-admin`. |
| `!warnings start YYYY-MM-DD` | `warning-controls.js` | Sets one inclusive cohort-wide warning baseline, rebuilds warning evidence from recorded attendance, reactivates only students whose warning-based inactivity becomes invalid, preserves valid post-baseline warnings, and publishes a focused correction in `#warning`. One run can add at most one warning. |
| `!warningreport` | `warning-controls.js` | Private current-week inactive/warning/attendance-absence summary plus copyable Name/Email/Phone/Discord ID TSV. Scheduled Thursday at `warningreporttime` when enabled; a 30-minute grace window and durable completion marker recover slow/restarted runs without duplication. |
| `!appeals [all]` | `appeals.js` | Private pending/recent appeal cards with Approve/Decline buttons. |
| `!appeal approve\|decline <request-id> \| note` | `appeals.js` | Command fallback for mobile/button review. Bootcamp approval reactivates and resets warnings; Dawn approval restores only the Dawn role/access. Decline requires a note. |
| `!studentsurvey incomplete` | `student-data-survey.js` | Opens the private missing-profile dashboard. |
| `!studentsurvey attention [days] [send]` | `student-data-survey.js` | Intersects incomplete profiles with no application activity. Preview is non-pinging; explicit `send` delivers/resends the private Discord-ID-bound survey. |
| `!students [region] [subregion]` | `students.js` | Shows region counts or a contact/resume directory. |
| `!filllocations [tab | column]` | `locations.js` | Imports Region/Subregion from a selected form-data tab/column. |
| `!active [top <n>]` | `engagement.js` | Ranks recently engaged students. |
| `!inactive [days <n>]` | `engagement.js` | Finds students with no tracked activity in the period. Engagement commands require an exact first token and do not intercept `!inactivestudents`. |
| `!notapplying [days <n>]` | `engagement.js` | Private copyable contact list of active students with no application activity in the selected window. |
| `!calllist` | `engagement.js` | Builds a private follow-up list with phone/WhatsApp links. |

## Google Forms and attendance

| Command | Module | Effect |
| --- | --- | --- |
| `!formtemplate` / `!formtemplate help` | `cohort-admin.js` | In private `#bot-admin`, shows durable template-editing syntax. |
| `!formtemplate show <enrollment\|attendance>` | `cohort-admin.js` | Lists working form metadata, every question, type, required state, choices, help, and protected semantic key. |
| `!formtemplate add/edit/remove/move/help/title/description/collectemail ...` | `cohort-admin.js` | Mutates and immediately persists the working template. Removing a bot-required field is allowed, but build validation then blocks until it is restored. |
| `!formtemplate validate` / `restorecore <kind\|all>` | `cohort-admin.js` | Checks bot-required fields, duplicate titles/keys, choices, and property size; restores missing core questions when requested. |
| `!formtemplate save/load/list/delete/reset ...` | `cohort-admin.js` | Manages named reusable template pairs or resets the working form(s) to the built-in bilingual defaults. Destructive delete/reset requires `confirm`. |
| `!createforms <cohort name>` | `cohort-admin.js` | Validates and creates enrollment/attendance Forms from the persisted working template; edit links stay in private `#bot-admin`. |
| `!createforms attendance [cohort name]` | `cohort-admin.js` | Portal mode: validates the working pair but creates only the daily attendance Form and makes it active. |
| `!designforms <description>` | `cohort-admin.js` | Uses Groq to draft an editable template; supervisor checkmark saves it as working and builds it. |
| `!forms` | `forms.js` | Lists forms bound to the cohort backend and identifies the active form. |
| `!forms use <number-or-form-id>` | `forms.js` | Switches the active attendance form. |
| `!forms link <edit-url-or-form-id>` | `forms.js` | Activates an existing attendance Form even when no linked forms are listed; a linked response tab is detected automatically. |
| `!openform` | `formcontrol.js` | Opens only the current Discord server's active attendance form through that cohort's backend. |
| `!closeform` | `formcontrol.js` | Closes the current server's active form and posts or edits that date's attendance after 30 seconds. |
| `!closeform silent` | `formcontrol.js` | Closes only the current server's active form and confirms privately without posting or scheduling an attendance report. |
| `!formstatus` | `formcontrol.js` | Shows only the current server's active form open/closed state. |
| `!attendance [YYYY-MM-DD]` | `attendance.js` | Rechecks today or a requested previous date and edits that date's durable public report without repeating notifications. Unmatched/ambiguous email identities are privately rejected and remain absent without blocking valid students; same-name present/absent account collisions still fail closed. |
| `!checkattendance [YYYY-MM-DD]` | `attendance.js` | Private read-only readiness report. Attendance day always comes from the immutable Google Form `Timestamp`; the editable attendance-date answer never controls counting. The audit lists timestamp/date corrections, duplicate submissions, identity issues, matrix P values, and copyable contacts. It never pings students. |
| `!repairattendance` | `attendance.js` | Adds every active Discord-linked Bot_Map student to Attendance and refreshes Name/Email/Phone without changing date columns, P/L values, or the dedicated mentor-editable Remarks column. |
| `!checkpipelines [YYYY-MM-DD] [all]` | `attendance.js` | Private combined audit of Discord identity, color activity, Attendance, job tracker links/saved counts, outreach events, and interview events. It lists problems by default; `all` includes every active student. A broken attendance response tab is reported without hiding the other pipelines. |
| `!repairpipelines` | `attendance.js` | Non-destructively repairs active identity rows and schemas for Attendance, Jobs Applied, Outreach Update, Interview Updates, Job_Sheets, Jobs_Daily, Interview_Log, Outreach_Log, and Outreach_Daily. It reconciles stale Outreach summaries from durable daily events; activity history and Attendance Remarks are preserved, and inactive styling is refreshed. |
| `!absent [current\|previous\|YYYY-MM-DD\|month week n]` | `attendance.js` / `absence-period.js` | In private `#bot-admin`, returns every active student absent at least once in the selected recorded-session period. Output is copyable TSV with name, email, phone, Discord username, absence count, longest streak, and dates. `july week 1` means July 1–7; later month weeks advance in seven-day blocks. |
| `!setupsheets existing` | `attendance.js` | Rebuilds `Jobs Applied`, `Outreach Update`, and `Interview Updates` from `Jobs_Daily`, `Outreach_Daily`, and `Interview_Log`, preserving raw logs. |
| `!setupsheets empty confirm` | `attendance.js` | Replaces only the three rebuildable matrix views with clean current-roster templates. The explicit confirmation protects against accidental view clearing; raw logs remain untouched. |
| `!arrangesheets` | `attendance.js` | In private `#bot-admin`, renames the configured active response tabs to `Enrollment Responses` / `Attendance Responses`; moves manual-review tabs first (blue), active forms/reference next (green), other Form-like tabs next (yellow), and bot-maintained data last (gray). It preserves unknown tabs and never hides or deletes anything. |
| `!setupcohortsheet [Google Sheet URL]` | `cohort-sheet-command.js` | Non-destructively binds a new backend when needed, installs the one form trigger, and creates/repairs all required tabs. |
| `!setupcohortsheet cleanup confirm` | `cohort-sheet-command.js` | Copies every current tab to a separate safety workbook, then deletes only obsolete, unlinked Form-response tabs and rebuilds views from durable data. Every tab still linked to any Form is preserved. |
| `!setupcohortsheet fresh confirm [Google Sheet URL]` | `cohort-sheet-command.js` | For a new cohort with no operational history: makes a backup, rebuilds bot-owned tabs with clean formatting, preserves `All Data`/reference content, and removes obsolete Form tabs. Refuses populated operational history. |

Attendance identity matching prefers a normalized email or Discord ID, then a
unique Discord username, then a unique normalized student-name alias (including
common `Md`/`Mst` prefixes and Discord decoration). An ambiguous or unmatched
answer is never guessed; it is reported privately in `#bot-admin`, does not
count as present, and does not block the report. The immutable Form Timestamp
controls the day even when the editable date answer is wrong; only a
missing/corrupt immutable Timestamp stops the run.
`!attendance` also reconciles every active Discord-linked student into the
Attendance matrix before marking matched P values. An intentionally colored
Email identity cell in `Bot_Map` or `Attendance` makes the row inactive and
keeps it out of present/absent totals. Very bright, near-neutral Google theme
fills that look white remain active; diagnostics report exact exclusion colors.
Recent-history text uses only recorded date columns on or before the report
date; future/blank template columns are ignored. Duplicate student rows/date
columns are merged with P then L precedence. The latest same-day Form response
controls mood/interview summaries, and “No interview faced today” overrides a
contradictory Yes.
The form-submit trigger defers attendance matrix writes; `!closeform` or
`!attendance` reconciles all matched present rows in one idempotent batch.
After reconciliation, blank absence cells belonging to a run of at least three
recorded sessions in the current or previous Sunday-based week receive a red
`❌`. Existing `P` values and manual notes are not overwritten. The private
absence command counts recorded session columns rather than calendar days.

## Outreach, jobs, interviews, resumes, and projects

| Command/event | Module | Effect |
| --- | --- | --- |
| Message in configured `#outreach-update` / `#outreach-updates` | `outreach.js` | Logs the roster member's outreach activity; the `channel_outreach` runtime override wins for both live logging and history backfill. |
| `!backfilloutreach [N days]` | `outreach.js` | Reconciles the latest three cohort calendar days by default; 1-30 days select an explicit inclusive window. Pagination stops at the first older date. Each in-window Discord message ID is idempotent; older events are neither scanned nor overwritten. |
| `!outreachcheck` | `outreach.js` | Runs the stale/never-outreached report immediately. |
| Successful outreach/job/interview write | Apps Script v60 | Keeps all three activity matrices synchronized with their durable logs. Bot writes are serialized per cohort and long idempotent activity/roster writes use a three-minute timeout. Outreach retries and interview history backfills repair downstream views by immutable message identity. Active job/outreach rows below 10 total over the latest three recorded dates turn light red; inactive rows in all matrices are dark red until mentor activation. |

| Tracker link in `#job-tracking-sheet` | `jobs.js` | Stores the member's latest Sheet ID and selected tab `gid`. A link without `gid` is explicitly acknowledged as using the default/first visible tab and appears as `DEFAULT` in `Job_Sheets`. If the immediate backend write exhausts transient retries, the durable Discord message is reconciled automatically from recent history before the next job check; the student is not asked to repost. |
| `!backfilljobsheets [N days]` | `jobs.js` | Scans the latest three cohort calendar days by default, or an explicit 1-30-day window, and saves the newest in-window tracker link per student. Pagination stops at the first older date; existing daily job history is untouched. |
| `!jobscheck [YYYY-MM-DD]` | `jobs.js` | Runs the student-facing target check for today or an explicitly requested missed date and saves one authoritative dated count per tracker. Future dates are rejected. |
| `!checkjobsheets [YYYY-MM-DD]` | `jobs.js` | Slow private read-only audit for the requested cohort date. It fresh-reads up to 30 public tabs per tracker, reports the selected table's total application rows and requested-date count, preserves every explicitly submitted `gid`, includes phone/WhatsApp without preview cards, reports unsafe/invalid dates, chunks safely, and performs no student pings or score/count writes. |
| `!activityprompt outreach\|interview\|communication\|all` | `activity-automation.js` | Manually posts the selected student-facing 06:00 template with controlled `@everyone`. |
| `!activitycheck attendance [YYYY-MM-DD]\|jobs\|interviews\|all` | `activity-automation.js` | Manually runs the absence, two-workday job-target, or Thursday interview follow-up logic and returns an explicit private result, including zero-new-incident success. The optional date applies only to attendance and defaults to the current cohort date. Attendance/job checks also post a copyable name/email/phone/reason TSV only in that cohort's private `#bot-admin`. |
| `!mailer status\|enable\|disable\|quota` | `mailer.js` | Private mailer status and opt-in automation control. Enabling requires a configured private To address. |
| `!mailer to\|cc\|bcc <emails\|none>` | `mailer.js` | Configure administrative headers. `solih@programming-hero.com` is always retained in CC; `cc none` removes only additional addresses. Dynamic student recipients remain BCC-only and are deduplicated from visible headers. |
| `!mailer replyto\|sender\|mentor\|phone <value>` | `mailer.js` | Configure response/sender/template variables without editing Render or Apps Script source. The reusable sender default is `Job Placement — Programming Hero`. |
| `!mailer template\|preview <absent\|warning1\|warning2\|inactive>` | `mailer.js` | Mobile/desktop template editor and private rendered preview. |
| `!mailer send <absent\|warnings\|all> [YYYY-MM-DD]` | `mailer.js` | Read-only recipient preview followed by explicit confirmation. It shows the current Attendance absence count separately from eligible recipients, identifies roster records excluded before the attendance report, and counts inactive candidates, invalid-email, duplicate-email, and unreconciled rows. Pre-report exclusions are neither absent nor mail recipients. A same-day warning/inactive email supersedes ordinary absence; previously inactive students use the separate `!inactivestudents` recovery mail action. The private confirmation/result attaches an exact TSV of recipients and skipped reasons. Gmail hides BCC in received copies. Completion reports new recipients separately from previously sent idempotent batches, which are never resent. |
| Inactive panel mail | `inactive-controls.js`, `mailer.js` | `!inactivestudents` can preview and confirm the configured inactive email for one selected inactive student or the complete current inactive list. Gmail does not reveal BCC recipients in the mentor's received copy; the private confirmation and `Mailer_Log` counts provide the audit. |
| `!followup <type> [days N] [#channel]` | `followup.js` | Builds a no-ping private preview for Dawn join, tracker/profile, attendance, interview, jobs, outreach, Dawn, communication, or workshop gaps. Preview rows use plain student names, while the confirmed announcement uses real mentions. Only the initiating supervisor can confirm. This is a one-off manual announcement and never changes scheduled automation. Recipients are intersected with live guild membership. |
| `!leave` | `leave.js` | Student command in `#issues`; opens a private date/reason modal. The public channel never receives the reason. |
| `!openleaves` / `!leaves` / `!leave approve\|reject <request-id> \| note` | `leave.js` | Opens one serialized private bot-admin manager, oldest request first, with Previous/Refresh/Next and approve/adjust/reject controls. It no longer floods the channel with one card per pending request. Duplicate submissions and repeat notifications are suppressed. All outcomes require a mentor note and post status to that student in `#issues`. Approved working dates become `L`; rejected requests never alter Attendance. |
| `!studentreport` | `student-reports.js` | Private interactive picker for one student, all active students, or severe needs-attention cases; the latter includes only zero applications, below-half scheduled applications, or zero attendance and prints each reason. Includes seven-day metrics, contact details without WhatsApp preview cards, and serialized interview history for the selected student. |
| Student post/edit in interview channel | `interview.js` / `interview-parser.js` | Deterministically bulk-upserts structured single or multiple interview announcements even if AI is unavailable. Immutable Discord message ID + event index prevents duplicate Sheet rows/replies from embed updates, retries, overlapping handlers, and real edits. |
| `!backfillinterviews [N days]` | `interview.js` | Private scan of the latest three cohort calendar days by default, or an explicit 1-30-day window. It stops at the first older date and bulk-reconciles only in-window immutable events; existing older `Interview_Log` events remain untouched. |
| Current-roster preflight | `attendance.js`, `jobs.js`, `outreach.js`, `interview.js` | Student-facing attendance/job/outreach runs refresh Discord membership before reading the roster. An unknown current tracker/outreach/interview poster triggers one immediate refresh and retry. A failed report preflight aborts visibly in `#bot-admin` instead of publishing a partial member list. |
| Roster refresh coordination | `roster.js` | Concurrent callers in one guild share one refresh, and a successful refresh is reusable for 60 seconds. Explicit `!syncmembers` forces a new refresh. This reduces duplicate Apps Script executions without weakening report preflights. |
| Supervisor mention in hired channel | `hired.js` | Marks the student hired, colors Sheet rows, excludes the member from active checks, and assigns the Discord Hired role. A delayed idempotent startup sync repairs existing hired members after deployment. |
| Student link/attachment in resume channel | `resume.js` | Saves latest resume pointer. |
| Student link/attachment in projects channel | `projects.js` | Saves project pointer and bounded summary. |

## Questions, workshops, referrals, and AI

| Command | Module | Effect |
| --- | --- | --- |
| `!dropquestion [category] [workshop|discussion]` | `questions.js` | Drops one question manually. |
| `!questions` | `questions.js` | Private clickable panel for the question switch, morning/afternoon/evening times and counts, answer window, gap, destination, replanning, and a manual drop. Defaults to two questions at 07:00, 13:00, and 18:00. |
| `!questions channel #channel` | `questions.js` | Sets any text channel in this cohort as the dedicated question destination and rebuilds remaining timers. The panel also has a channel picker. |
| `!questions amounts <morning> <afternoon> <evening>` | `questions.js` | Sets each period to 0–10 questions and replans the remainder of the day. |
| `!genquestions <category> <count>` | `questions.js` | Generates and saves questions through Groq/Apps Script. |
| `!cleanbank` | `questions.js` | Removes configured unwanted question-bank content through the backend. |
| `!leaderboard` | `questions.js` | Posts the current two-day leaderboard. |
| `!weeklyreport` | `weekly-report.js` | Builds the Sunday-to-current-date performance leaderboard from live trackers plus backend metrics, displays achieved/configured goals, and posts it in `#discussion`. |
| `!workshop` / `!specialworkshop` | `workshop.js` | Private clickable controls for daily communication workshops and the opt-in Dawn Focus special workshop. |
| `!workshopannounce` | `workshop.js` | Creates a private confirmation card; it never posts the public schedule without a supervisor button click. |
| `!workshoppoll` | `workshop.js` | Opens a manual attendance poll. |
| `!repairinterviews` | `interview.js` | Private exact-duplicate repair for Interview_Log; preserves distinct multi-interview events and rebuilds per-student serials. |
| `!rtbr` | `rtbr.js` | From `#bot-admin`, posts the rolling board and reconciles `Right to Be Referred` membership for the qualified top students. Missing Discord identities leave existing role membership unchanged. |
| `!rtbr top <1-25>` / `!rtbr days <1-90>` / `!rtbr time HH:MM` | `rtbr.js` | Changes the qualified-role quantity, scoring window, or weekly execution time immediately for this cohort. |
| `!match <job description>` | `match.js` | Extracts requirements and ranks up to five suitable candidates. |
| `!suggest` | `suggest.js` | Drafts one activity; supervisor checkmark approval posts it. |
| `!dmnudges` | `dm-nudges.js` | Sends personalized bot DMs to eligible lagging members now. |
| `!jp [plain-language request]` | `agent.js` | Private `#bot-admin` conversational command finder. It uses the authoritative catalog, deterministically resolves student-status follow-ups containing a mention/raw ID, asks at most two focused direct-reply questions, then falls back to verified commands instead of looping. It never executes commands. |

## Runtime control and routing

| Command | Module | Effect |
| --- | --- | --- |
| `!control` / `!automationconfig` | `control-center.js` | Private one-place snapshot of this cohort's switches, targets, clock times, scheduled days, and exact control/student/cohort command shortcuts. Its Command Center button opens the searchable catalog without duplicating command definitions. |
| `!automation [list]` | `automations.js` | Shows persistent automation switches. |
| `!automation start|stop <key|all>` | `automations.js` | Changes switches and invalidates the local cache immediately. Background refresh is deliberately less frequent to protect Apps Script quota. |
| `!automation starter` | `automations.js` / `channel-visibility.js` | Applies the quiet new-cohort preset and hides only held outreach, interview, communication, RTBR, and Dawn workflow channels from students. Core channels stay visible; starting a related automation reveals its channel again. |
| `!settings` | `settings.js` | Lists default/current settings. |
| `!set <key> <value>` | `settings.js` | Persists one valid target, time, URL, slot, or channel override. |
| `!targets` | `settings.js` | Shows the six cohort performance goals and whether each is daily or weekly. |
| `!target <metric> <amount>` | `settings.js` | Validates and persists a guild-specific applications, outreach, attendance, interviews, communication, or workshops goal. |
| `!times` | `settings.js` | Lists every editable automation clock in the cohort timezone. |
| `!time <name> HH:MM` | `settings.js` | Changes one automation clock without a Render restart. |
| `!schedule` | `scheduler.js` | Lists day schedules for automation keys. |
| `!schedule <key> <days>` | `scheduler.js` | Saves `sun-thu`, comma-list, or everyday scheduling. |
| `!calendar` / `!calendar week <days> \| <context>` / `!calendar holiday|working|clear <date> \| <context>` | `work-calendar.js` | Private cohort calendar with a next-25-days selector and optional announcement-details modal. Friday/Saturday holidays are the default. Holidays suppress every scheduled automation/report, while live outreach, interview, and successfully-hired posts remain recordable and manual commands work. A date-specific working override resumes ordinary daily automation; fixed weekly publications retain their weekday. Every mutation posts an `@everyone` announcement in discussion. Aliases: `!workweek`, `!holiday`, `!workingday`. |
| `!say <#channel-or-id> <message>` | `say.js` | Sends a one-off message as the bot. |

Automation switch keys are:

`attendance`, `outreach`, `jobs`, `questions`, `workshop`, `specialworkshop`, `reports`,
`leaderboard`, `weeklyreport`, `rtbr`, `resources`, `dmnudges`, `suggestions`,
`activityprompts`, `escalations`, `contentsync`, `discipline`, and opt-in `mailer`. `reports` is
the umbrella switch for both leaderboard keys.

Day-schedule keys are `attendance`, `outreach`, `jobs`, `questions`,
`workshop`, `specialworkshop`, `leaderboard`, `weeklyreport`, `rtbr`, `resources`, `dmnudges`,
`suggestions`, `outreachprompt`, `interviewprompt`, `communicationprompt`,
`interviewfollowup`, `contentsync`, and
`discipline`. `weeklyreport` and `rtbr` both default to Thursday;
`everyday` explicitly overrides those defaults.

Runtime setting keys are:

`jobstarget`, `outreachstale`, `outreachdaily`, `weeklyattendance`,
`weeklyinterviews`, `weeklycommunication`, `weeklyworkshops`, `rtbrdays`,
`rtbrtop`, `weeklytop`, `jobshistory`, `workshoptech`, `workshopcomm`,
`discussiontech`, `qwindow`, `qmorningtime`, `qmorningcount`,
`qafternoontime`, `qafternooncount`, `qeveningtime`, `qeveningcount`,
`qperiodgap`, legacy `qchannel`, `questionplantime`,
`leaderboardtime`, `leaderboardinterval`, `pollwindow`, `preminutes`,
`announcetime`, `noshowtime`, `slots`, `meeturl`, `gpturl`, the Dawn
special-workshop date/time/title/link/context settings, the automation time keys
shown by `!times`, and `channel_attendance`,
`channel_outreach`, `channel_jobs`, `channel_workshop`, `channel_questions`, `channel_discussion`,
`channel_reports`, `channel_rtbr`, and `channel_noshow`.

## Resources and forwarding

| Command/event | Module | Effect |
| --- | --- | --- |
| `!backupresources` | `resources.js` | Saves bounded resource-channel history to the backend. |
| `!postresource` | `resources.js` | Posts the next saved resource. |
| `!resourcesync status\|on\|off` | `resources.js` | In a destination cohort's private `#bot-admin`, opts that cohort into or out of new supervisor-authored resources posted in the protected control cohort. Mirrored messages never parse mentions and are also stored in the destination `Resources` tab. Bot posts, commands, and student posts are ignored. |
| `!contentsync source <server-id\|control>` | `content-sync.js` | Selects and snapshots an active old cohort as the source for reusable Resources and Job Hunting history; the snapshot survives later retirement. |
| `!contentsync run <resources\|jobhunting> <one\|all>` | `content-sync.js` | Copies either the next uncopied supervisor-authored item or the complete remaining backlog with mentions suppressed. |
| `!contentsync auto <resources\|jobhunting> <on\|off>` | `content-sync.js` | Enables one-item-per-scheduled-day backfill for the destination cohort. |
| `!dawn setup\|invite\|status\|review\|repair\|sync` | `dawn-discipline.js` | Creates/reuses the channel, posts enrollment, reports status, runs a review, repairs legacy channel/tabs, or bulk-syncs every current Dawn role member plus offline removals into the canonical matrix. At 07:10 the automated review scans only the configured Sunday–Thursday attendance window (default 05:00–07:00) and writes one idempotent batch (`P · HH:MM` / `A`). A manual rerun can recover an earlier missed presence without double-counting absence. |
| `!dawn window [always\|HH:MM-HH:MM]` | `dawn-discipline.js` | Shows or sets when role members can send. Default is always open. This is independent of attendance. |
| `!dawn attendance [HH:MM-HH:MM]` | `dawn-discipline.js` | Shows or changes the exact same-day attendance scan window (default 05:00–07:00). The review time must remain later than the window end. |
| `!dawn add\|remove @student` | `dawn-discipline.js` | Supervisor override for one member's Dawn Focus role. |
| `!groupactivities setup\|sync\|status` | `group-activities.js` | Creates/reuses `#group-activities`; each populated `Division · ...` role receives a private thread whose membership is synchronized from that role. Availability, work-mode, English and skill roles are excluded. |
| `!forwarder [status]` | `forwarder.js` | In private `#bot-admin`, shows OFF, ON, WAITING, or UNKNOWN and performs a live source/destination access check. A temporary lookup/access failure does not erase durable ON intent. |
| `!forwarder set <source-id> <destination-id>` | `forwarder.js` | Validates and persists a route whose source belongs to this cohort and whose destination is visible/sendable by the same bot. Route changes leave forwarding OFF. |
| `!forwarder start|stop` | `forwarder.js` | Enables/disables real-time forwarding; start refuses an inaccessible route. An enabled route retries every five minutes and again on matching source posts. |
| Eligible source message/edit | `forwarder.js` | Forwards only the configured target user's messages, suppresses forwarded mentions, and syncs edits still in the in-memory map. |

The legacy EJP deployment defaults to EJP `#job-posts` → STRIDE `#job-posts`.
The previous Endgame 12 destination is retired: an exact persisted match is
migrated to STRIDE during startup. The EJP bot application must be a member of
STRIDE with View Channel, Send Messages, Embed Links, and Attach Files in the
destination channel. The separate STRIDE service's own forwarder must remain
OFF to prevent a second route.

There is currently no implemented `!forward <date...>` historical batch command.
Older documentation/help references to that command are stale and must not be
presented as working behavior.

## Automatic behavior map

Times are cohort-timezone values, normally `Asia/Dhaka`. Every daily automation
clock below is editable with `!time`; changes are durable and take effect
without rebuilding cron jobs or restarting Render.

Application and outreach goals are per matching scheduled day. Weekly reports
multiply those daily values by the number of `jobs`/`outreach` schedule days in
the report range. Attendance, interviews, communication practice, and workshop
goals are fixed weekly values. A zero weekly goal disables comparison for that
secondary metric; daily application/outreach goals must be at least one.

| Automatic behavior | Owner | Default timing | Guards |
| --- | --- | --- | --- |
| Attendance form state reminders | `attendance.js` | 21:00 and 22:15 | `attendance` switch + day schedule |
| Attendance report eligibility | `attendance.js`, Apps Script v52 | On `!closeform` / `!attendance` | Current guild roster only. Already-inactive, hired, left, protected, and supervisor records are excluded at both backend and Discord layers. A warning-3 student appears on deactivation day only because warning classification follows the report. |
| Outreach follow-up check | `outreach.js` | 20:00 | `outreach` switch + day schedule; includes every active student below the configured daily count |
| Outreach/interview/communication templates | `activity-automation.js` | 06:00 Sun–Thu | umbrella `activityprompts` plus individual switch/day schedule + warm-up |
| Consecutive-attendance warning | `formcontrol.js`, `attendance.js`, `activity-automation.js` | Every working day, ten minutes after a successful non-silent `!closeform` report; durable startup/configured-time recovery | `attendancewarning` switch + warm-up. The report-date work calendar—not a stale feature-day override—controls eligibility. Only two consecutive recorded-session absences count; `P` or approved `L` breaks the run. The shared baseline applies to everyone, one check can add at most one warning, and warning 3 marks inactive. |
| Attendance/warning mailer | `formcontrol.js`, `activity-automation.js`, `mailer.js` | After the ten-minute warning classification; durable and idempotent across restart/retry | Opt-in `mailer` switch independent of the warning switch/day override. Warning 1/2/3 groups supersede ordinary absence for that date; inactive students are not mailed again on later dates. Private previews reconcile the Attendance total and attach eligible/skipped address details without exposing them publicly. |
| Two-day application-target emergency | `activity-automation.js` | Every working day at 08:10 | `jobemergency` switch + warm-up. It checks the two preceding working days; approved leave is excused. Holidays are skipped. |
| Interview follow-up | `activity-automation.js` | Thursday 08:20 and 19:00 | `escalations` + `interviewfollowup` switch/day schedule + warm-up |
| Interview + outreach history reconciliation | `activity-reconciliation.js` | 22:50 every calendar day by default | Silent three-calendar-day maintenance window, including Friday/Saturday and holidays; pagination stops before older messages; no student-facing report or automation-switch dependency |
| Dawn Focus repair/prompt/review | `dawn-discipline.js` | 04:50 stale-overwrite repair / 05:00 prompt / 07:10 review, Sunday–Thursday | `discipline` switch + day schedule; configurable attendance window defaults 05:00–07:00; no per-message Sheet calls; channel sending window is independent |
| Historical content backfill | `content-sync.js` | 10:00 Sun–Thu, one item/kind | `contentsync` switch + day schedule + destination opt-in |
| Job application accountability | `jobs.js` | 22:30 | `jobs` switch + day schedule + warm-up |
| Question plan | `questions.js` | 06:30 plans exact period slots; defaults: 2 at 07:00, 2 at 13:00, 2 at 18:00 | `questions` switch + day schedule + warm-up |
| Leaderboard | `questions.js` | 20:00 every second day | `reports` + `leaderboard` switches and its day schedule |
| Weekly performance leaderboard | `weekly-report.js` | Thursday 18:00 | `reports` + `weeklyreport` switches, day schedule, and warm-up; manual command remains available |
| Workshop minute tick | `workshop.js` | every minute; configured event times | `workshop` switch + warm-up + a daily supervisor confirmation before public output; independent `specialworkshop` controls Dawn Focus announcements |
| Priority for Referral / RTBR board | `rtbr.js` + `weekly-report.js` | RTBR is included in Thursday's main leaderboard and posted separately at 20:00 | `weeklyreport` / `rtbr` switches + day schedules |
| Resource repost | `resources.js` | 11:00 | `resources` switch |
| Activity suggestion | `suggest.js` | 21:00 | opt-in `suggestions` switch |
| DM nudges | `dm-nudges.js` | 23:45 | opt-in `dmnudges` switch |

`!dailyreport` remains available as a manual in-memory diagnostic, but no
scheduled daily report runs and it makes no unattended Apps Script calls.

## Authorization summary

- Prefix commands in this document are supervisor-only in current source.
- Student behavior is triggered by ordinary messages/replies/reactions in the
  configured feature channels.
- Onboarding questionnaire interactions are available to guild members through
  the public panel but produce ephemeral responses.
- Forwarding automatically processes only the configured source channel and
  configured target user.
