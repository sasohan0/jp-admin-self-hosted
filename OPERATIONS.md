# Deployment and Operations Runbook

This runbook is for deploying, initializing, monitoring, and safely changing JP
ADMIN. The detailed click-by-click separate-server guide remains in
`SECOND_SERVER_SETUP.md`.

## Mentor-owned guided installation

Use `render.yaml` and `SELF_HOSTED_SETUP.md` for an independent single-server
copy. `JP_INSTALLER_MODE=true` is explicit: it cannot silently load the legacy
cohort. Render holds `DISCORD_TOKEN`, `COHORT_API_URL`, and
`COHORT_API_KEY`; the Discord setup capsule contains only signed server,
supervisor, timezone, and channel settings. The bot must be invited with
Administrator and both Server Members and Message Content privileged intents.

First run is safe before Apps Script is deployed: the Blueprint placeholder URL
allows `!setup` to create/repair private `#bot-admin` and show the Google guide.
After the mentor runs `authorizeAllRequiredServices()` and `setup()`, deploys
the Web App, and replaces `COHORT_API_URL`, Render restarts and restores the
signed capsule. The numbered buttons then match channels, synchronize every
eligible existing Discord member (including provisional identities), and test
the backend/permissions. Finish with `!checkperms`, `!doctor`, and
`!syncmembers`. Never troubleshoot by deleting existing channels or Sheet data.

## Production topology

Preferred topology for up to three active cohorts:

```text
One Discord application/token -> one Render service
  -> cohort A Apps Script/Sheet
  -> cohort B Apps Script/Sheet
  -> cohort C Apps Script/Sheet
```

Each cohort retains its own API secret, guild ID, supervisor IDs, Apps Script
deployment, and Sheet. `COHORT_REGISTRY_JSON` contains only the non-secret
registry and references separate API URL/key environment variables.

After adding a destination cohort, private `!resourcesync on` enables future
supervisor-authored posts from the protected control cohort's `#resources`.
The setting is stored in the destination backend; it does not unify bot-admin,
rosters, reports, or any other cohort data. Bot messages, commands, and student
posts are excluded to prevent loops and accidental publication.

For historical Resources and Job Hunting material, first run
`!contentsync source <old-server-id>` in the destination `#bot-admin` while the
old cohort is still active. Then use `!contentsync run resources all` and
`!contentsync run jobhunting all`, or enable one-item scheduled copying with
`!contentsync auto <kind> on`. The secret-free source snapshot remains usable
after retirement as long as JP ADMIN is still installed in and can read the old
server.

Production cutover completed on 2026-07-23: the `jp-admin-stride` service runs
EJP-13 and STRIDE through the permanent `JP ADMIN â€” STRIDE` application. The
old `ejp-bot` service is suspended and retained only for rollback. Uptime
monitor v3 has one trigger and points only to the permanent service.

The only active source repository is `sasohan0/jp-admin-stride`; its `main`
branch feeds the permanent Render service. `sasohan0/ejp-bot` is an archived
legacy backup. Never dual-push routine changes or connect the archived
repository to an active service.

Do not run a local `node index.js` using a production token while Render is also
connected. Multiple gateway sessions and duplicate cron execution can create
duplicate messages and writes.

## Discord application checklist

1. Create a new Discord application for a genuinely separate bot deployment.
2. The Client ID/Application ID is public and identifies the application. The
   Bot token is secret and authenticates the process.
3. Enable Server Members Intent and Message Content Intent.
4. Install the bot to the intended server with Administrator for the simplest
   bootstrap, or grant the complete minimum permission set below.
5. Place the bot's highest role above roles it must assign/remove.
6. Enable Developer Mode to copy guild/user/channel/message IDs.
7. Prefer having every configured supervisor join before `!setupserver` repairs
   member-specific permission overwrites. An absent supervisor is reported and
   skipped; rerun `!repairpermissions` after that person joins.

Minimum effective capabilities used by setup/onboarding/normal operation:

- View Channels
- Send Messages
- Embed Links
- Attach Files where relevant
- Read Message History
- Add Reactions / read reactions where relevant
- Manage Messages for pins/locked-channel operations
- Manage Channels for setup/permission repair
- Manage Roles for onboarding roles
- Mention Everyone for selected scheduled announcements, if desired

## Render configuration

Use:

```text
Build command: npm install
Start command: node index.js
```

`keepalive.js` must listen on the injected `PORT` and host `0.0.0.0`. Render's
router cannot attach reliably to a server that only binds to a loopback or
implicit host. A healthy root request returns HTTP 200 with an `OK` body.
Cache-busting query parameters are supported, so both `/` and
`/?uptime=apps-script&ts=...` must return HTTP 200.

### Scheduled Free-service wake-up

`Render-Uptime-Monitor.gs` is the external scheduler for the one unified
health URL. It sends requests every five minutes from 04:40 through just before
23:30 in `Asia/Dhaka`; the ten-minute lead wakes Render before the
`BOT_ACTIVE_WINDOW=04:50-23:30` Discord login.
This uses roughly 565 free-instance hours in a 30-day month, inside one
service's 750-hour monthly allowance.

Install it in one Google Apps Script project:

1. Add a new script file named `Render-Uptime-Monitor` and copy the repository
   file into it.
2. Save, select `installRenderUptimeMonitor`, and click Run once.
3. Approve the Script/URL Fetch authorization prompt.
4. Confirm the returned/logged status has `triggerCount: 1` and HTTP 2xx for
   the one configured URL. `testRenderUptimeNow` can repeat a manual check at
   any hour.
5. Pause every old per-service/always-on monitor. Leaving one active defeats
   the schedule and consumes Free instance hours outside the window.

The monitor is an Apps Script clock trigger, not part of the Web App endpoint;
adding it does not require a new Web App deployment. Run
`removeRenderUptimeMonitor` to delete only its own trigger.

For the preferred unified service, set a secret-free registry plus one pair of
private backend variables per cohort:

```text
DISCORD_TOKEN=<unified bot token>
COHORT_REGISTRY_JSON=[{"key":"ejp13","name":"EJP-13","guildId":"...","supervisorIds":["..."],"channels":{}},{"key":"stride","name":"STRIDE","guildId":"...","supervisorIds":["..."],"channels":{}}]
EJP13_API_URL=<EJP Apps Script /exec URL>
EJP13_API_KEY=<EJP backend secret>
STRIDE_API_URL=<STRIDE Apps Script /exec URL>
STRIDE_API_KEY=<STRIDE backend secret>
COHORT_CONTROL_KEY=stride
RENDER_DEPLOY_HOOK_URL=<this service's secret Render deploy hook>
FORWARDER_HUB_GUILD_ID=<EJP guild ID>
BOT_ACTIVE_WINDOW=04:50-23:30
BOT_ACTIVE_TIMEZONE=Asia/Dhaka
```

Do not include API URLs or keys inside the bootstrap JSON. The first managed
startup copies the active registry into private STRIDE Apps Script state.
Afterward, `!cohorts` can add, update, or retire a cohort without more Render
environment editing. It validates the Discord installation, Administrator
permission, supervisor list, Apps Script URL, and secret, then calls this
service's deploy hook so all cron registrations are rebuilt exactly once.
Keep at most three active cohorts.

To manage supervisors after attachment, run these only in that server's private
`#bot-admin`:

```text
!supervisor list
!supervisor add @user
!supervisor remove @user
```
Add accepts a current member mention or a raw Discord ID for someone who has
not joined yet. The command saves the durable registry, grants standard
private/locked-channel access when present, excludes that ID from active student
tracking immediately, and restarts the bot. For an absent supervisor, rerun
`!repairpermissions` after they join. Remove revokes the standard overwrites and
returns a remaining guild member to the Discord-primary student roster. A
supervisor cannot remove themselves.

`RENDER_DEPLOY_HOOK_URL` is a service-scoped secret from Render Settings. Do
not place it in chat, source, or documentation and do not replace it with a
broad Render API key. `COHORT_CONTROL_KEY=stride` protects STRIDE from
Discord retirement and anchors registry loading to its bootstrap backend.

For a separate isolated rollback service, set:

```text
DISCORD_TOKEN=<new bot token>
COHORT_NAME=<new cohort name>
COHORT_GUILD_ID=<new server ID>
COHORT_API_URL=<new Apps Script /exec URL>
COHORT_API_KEY=<new backend secret>
COHORT_SUPERVISOR_IDS=<comma-separated user IDs>
COHORT_TIMEZONE=Asia/Dhaka
COHORT_CHANNELS_JSON={}
GROQ_API_KEY=<optional AI key>
```

Startup must log exactly the intended cohort, for example:

```text
[config] Cohort deployment: EJP-14
```

If it logs EJP-13, the generic cohort identity variables are absent. If startup
reports missing cohort fields, isolated mode was triggered with an incomplete
set.

In unified mode startup logs every configured cohort. Run `!cohortstatus` in
each server's configured `#bot-admin`; it checks only that server's
Discord/backend access while deliberately hiding URLs and keys.

Unified hosting does not create a unified admin channel. Run ordinary
supervisor commands in each server's own configured `#bot-admin`. The command
message's guild ID selects the cohort before any channel, form, Sheet, setting,
or automation state is read. In particular, `!openform`, `!closeform`, and
`!formstatus` call only that server's Apps Script backend and active attendance
form.

### Working calendar and holiday announcements

Each cohort defaults to Sundayâ€“Thursday working days and Friday/Saturday
holidays. Manage it only from that cohort's private `#bot-admin`:

```text
!calendar
!calendar week sun-thu | Friday and Saturday are our regular holidays.
!calendar holiday 2026-08-15 | National holiday; regular activities resume Sunday.
!calendar working 2026-08-14 | Special replacement working day.
!calendar clear 2026-08-14 | Return this date to the regular weekly calendar.
```

`!calendar` also shows a private next-25-days selector. Choose a date, then
click **Set Holiday**, **Set Working**, or **Clear Override**. Holiday/working
buttons open an optional announcement-details form; the text commands remain
available for dates outside the selector.

`today` and `tomorrow` are accepted instead of a date; `!workweek`, `!holiday`,
and `!workingday` are shorter aliases. Text after `|` is the supervisor's
announcement context. Every mutation posts an `@everyone` announcement in the
configured discussion channel.

On a holiday, every scheduled automation and report is suppressed. Live
outreach, interview, and successfully-hired messages are still ingested into
the cohort Sheet, and manual supervisor commands remain available. A
working-date override resumes
ordinary daily automation even on a normally excluded weekday; Thursday weekly
reports, Thursday RTBR, and Thursday interview follow-up retain their fixed days.

### Attach or retire a cohort

Attach:

1. Prepare and deploy the new cohort Sheet/Apps Script.
2. Invite the unified Discord application and place its role correctly.
3. In an existing server's private `#bot-admin`, run `!cohorts` and choose
   **Add cohort**. Enter the name, Discord server ID, supervisor IDs, deployed
   `/exec` URL, and Apps Script secret in the private modal. The person adding
   it must appear in every active cohort's supervisor list.
4. Wait for the automatic restart, then run `!setupserver`, `!checkperms`,
   `!doctor`, and
   `!cohortstatus` inside the newly attached server.

Retire:

1. Run `!automation stop all`, take the final Sheet backup, and preserve any
   needed reports.
2. Run `!cohorts`, choose **Retire cohort**, then confirm. The protected control
   cohort is intentionally not offered. To retire STRIDE, first preserve its
   content source in each destination, move `COHORT_CONTROL_KEY` and the complete
   bootstrap registry to another active cohort in Render, deploy successfully,
   and only then retire STRIDE. Never remove the old control entry first.
3. Wait for the automatic restart and confirm `!cohortstatus` separately in each remaining
   server.
4. Remove the bot from the retired guild only after the rollback window.

After `!setupserver`, use `!repairpermissions` in private `#bot-admin` if any
private/locked template-channel overwrite failed. This repair command does not
repost announcements or reset the warm-up. Follow it with `!checkperms` and
`!doctor` rather than rerunning the full setup command. `!checkperms` verifies
the bot's effective access; the repair summary is the relevant result for
member privacy overwrites. If it lists an absent supervisor, invite that user
and run the repair once more.

## Apps Script backend checklist

1. Copy the intended Sheet and its bound Apps Script project.
2. Replace the copied editor source with the repository's
   `Code-v19-FINAL.gs` (internal backend version `v48`).
3. Set `CONFIG.COHORT`, generate a new private `CONFIG.SECRET_KEY`, keep
   `FORM_ID` blank when the bot will create forms, and do not share the key.
4. On a fresh copy, run `initializeNewCohortCopy()` once. It clears copied
   Script Properties but does not delete Sheet rows or tabs.
5. Run read-only `inspectCohortCopy()` and review its row counts before deciding
   whether old cohort data needs manual archival/cleanup. Do not run `setup()`
   yet if the copied response/data tabs still contain the previous cohort.
6. For a completely new batch, run `prepareNewBatchReset()`, review its output,
   then run `resetForNewStudentBatch()` within 15 minutes. Run
   `inspectCohortCopy()` again: student/activity tabs should report zero rows,
   while `Question_Bank` and `Resources` remain populated.
7. Preferred bot-driven path: deploy the Web App, add the cohort, then run
   `!setupcohortsheet fresh confirm <Google Sheet URL>` in private
   `#bot-admin`. It binds the Sheet, creates clean required tabs, and installs
   the one `onFormSubmit` trigger. It refuses non-empty operational history.
   Editor `setup()` remains the recovery/manual path.
8. Deploy as a Web App executing as the owner with the access level expected by
   the project.
9. After every Apps Script code change, create/deploy a new version. Editing the
   source alone does not update an existing versioned `/exec` deployment.
10. Browser-test a harmless read such as:

```text
<exec-url>?action=roster&key=<secret>
```

11. Run `!doctor sheet`, `!doctor post`, and `!doctor roster` after bot startup.

When linking an existing attendance Form, use `!forms link <edit URL or form
ID>`. If that Form writes to this spreadsheet, v23 also records its actual
response-tab name. For unusual/manual Form associations, run
`registerResponseSheets(enrollmentTab, attendanceTab)` directly in Apps Script.

Never paste the real key into documentation, commits, screenshots, or chat.

### Apps Script execution-pressure response

- First inspect **My Triggers** and **My Executions**. A once-daily report cannot
  explain hundreds of simultaneous runs by itself.
- The supported cohort project has exactly one spreadsheet `onFormSubmit`
  trigger after `setup()`. Do not add a second form trigger manually.
- v46 retains the no-sleep form handler. Attendance matrix mutation is deferred
  to one idempotent batch when the report is requested; unmatched identities
  become review items rather than trigger failures. Tracking matrices are
  synchronized through existing bot writes without adding another trigger,
  roster reads include exclusions, and each job audit remains one bundled
  backend execution.
- The operational report is manual-only through `!dailyreport`; there is no
  23:50 cron or `dailyreport` automation switch.
- Automation/settings reads are cached for 30 minutes because the workshop
  scheduler ticks each minute. Changes made through Discord commands invalidate
  the cache immediately; the longer refresh removes hundreds of needless Web
  App executions while the bot is idle or an automation is off.
- Core bot reads retry transient Google HTML 404/5xx responses up to five times
  with paced backoff and a cache-busted retry URL. Writes retry only when the
  action is explicitly idempotent. Concurrent roster refreshes in one guild
  share one Apps Script write and a successful result is reusable for one
  minute; manual `!syncmembers` still forces a new refresh.
- Keep the separate Render wake-up trigger in only one Apps Script project. It
  does not belong in each cohort backend.

Before the first attendance report for a cohort, and whenever a present student
is unexpectedly missing, use this private sequence in that server's
`#bot-admin`:

1. `!syncmembers` to refresh Discord membership and identity links.
2. `!repairattendance` to add/refresh every active linked student row without
   changing existing date marks.
3. `!checkattendance` (or `!checkattendance YYYY-MM-DD`) to review matrix
   duplicates, unlinked Discord members, form-response matches, invalid dates,
   and exact identity-cell colors for excluded students. A white-looking Google
   theme fill should remain active; deliberate status colors remain excluded.
4. Correct only the listed ambiguous/duplicate records, rerun the audit, then
   use normal `!closeform`. Use `!closeform silent` when no report should be
   posted.
5. Use `!checkpipelines [YYYY-MM-DD]` for one problems-only cross-check of
   Attendance, tracker links/counts, outreach events, and interview events.
   `!repairpipelines` safely repairs identity rows/schemas when the audit lists
   structural gaps; it does not delete activity history.

## New server initialization

After the bot is online, a configured supervisor should run:

1. `!setupserver`
2. Review its created/reused/failed channel summary.
3. If a template has an existing rules message, copy its Discord message link
   and run `!setrulesmessage <link>` in `#bot-admin`.
4. `!onboardingpanel`
5. To edit a bot-authored pinned rules or channel-introduction message later,
   copy its Discord message link and run `!editannouncement <link>` in
   `#bot-admin`. Use the prefilled private modal; the existing pin and rules
   link remain valid because the message is edited in place. User-authored
   messages must still be edited directly by their author.
6. In private `#bot-admin`, review the built-in bilingual defaults with
   `!formtemplate show enrollment` and `!formtemplate show attendance`. Edit,
   save a named copy, and run `!formtemplate validate`; then run
   `!createforms attendance <cohort name>` exactly once for portal cohorts.
   Use legacy `!createforms <cohort name>` only when both Google Forms are wanted.
7. Open the portal with `!intake enable <unique-slug>` and share `!intake link`.
   Existing cohorts may still populate `All Data` before `!syncmembers`.
   Discord membershipâ€”not Form submissionâ€”is the active roster source.
8. `!audit`.
9. `!filllocations` if location data needs importing.
10. `!checkperms`.
11. `!doctor`.
12. Build the human-friendly matrices with `!setupsheets existing`, or use
    `!setupsheets empty confirm` for a cohort with no retained daily history.
13. Run `!arrangesheets` to rename the active response tabs and reapply the
    blue manual-review, green active-form/reference, yellow other-Form-review,
    and gray bot-data order without rebuilding matrix data.
14. After trackers are linked, `!checkjobsheets` in `#bot-admin`.

`!setupserver` is idempotent for recognized text-channel names: it reuses them
and creates only missing standard channels. It may repost/pin introductions,
so do not run it repeatedly to diagnose an unrelated problem.

For an already-running cohort that only lacks a newly introduced standard
channel, run `!ensurechannels` instead. It creates/reuses missing channels,
repairs private/locked overwrites, and refreshes channel discovery without
reposting introductions or changing the warm-up date. A configured supervisor
may run it from any channel so it can safely create the cohort's first private
`#bot-admin`; move later administrative work to that private channel.

### Durable form-template workflow

The working enrollment and attendance templates are stored separately in
guild-namespaced Apps Script state. Use `!formtemplate save <name>` to preserve
a reusable pair and `!formtemplate load <name>` to make it current. Question
edits use a pipe-delimited syntax shown by `!formtemplate`; checkbox and choice
options follow the question title, while scale fields accept minimum, maximum,
low label, and high label.

Bot-required questions carry stable semantic keys. Their wording, choices,
help, required flag, and position can be changed. Removing one is allowed, but
`!formtemplate validate` blocks form creation until `restorecore` restores the
missing field. This is intentional protection against Forms that collect data
but silently fail roster or attendance processing. Form edit links are posted
only in private `#bot-admin`.

## Pre-entry intake portal

`Server Settings > Access > Apply to Join` is Discord's native full-screen
application gate. Pending applicants cannot see server content, and a server
administrator must approve or reject each application. Configure it only in
the Discord desktop application; it is a server-owner setting, not a JP ADMIN
command. Discord's documented public API does not expose those application
answers to the bot, so they do not automatically populate cohort Sheets.

JP ADMIN now provides the fully automatic alternative. Share the cohort portal
link instead of a normal server invite. The applicant signs in on Discord,
completes the full-screen editable enrollment form, and receives server access
only after the structured Sheet response is saved. Keep the server invite-only;
do not also enable **Apply to Join**, because that would add a second manual
approval gate after the portal.

One-time setup for the unified Discord application/service:

1. In **Discord Developer Portal -> JP ADMIN -> OAuth2**, add the exact redirect
   `<Render origin>/intake/oauth/callback`.
2. In Render, add `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, a random
   32+ character `INTAKE_SESSION_SECRET`, and `INTAKE_PUBLIC_URL` containing the
   HTTPS Render origin only. Never post the two secrets in Discord.
3. Deploy Apps Script v54 for every cohort and run `!setupcohortsheet` so
   `Intake Responses` exists.
4. In the target cohort's private `#bot-admin`, review
   `!formtemplate show enrollment`, customize/save it if needed, run
   `!formtemplate validate`, then run `!doctor intake`.
5. Open with `!intake enable <unique-cohort-slug>` and copy `!intake link`.
   Close new applications at any time with `!intake disable`; saved rows remain.

Intake writes are idempotent and can wait up to 90 seconds for a busy cohort
Sheet, with one automatic retry for a transient transport timeout. Ask a
student to submit again only when the portal still reports that enrollment
needs attention after the retry.

The portal requests only Discord OAuth `identify` and `guilds.join`. The OAuth
token is memory-only and expires with its 30-minute portal session. A submission
is saved idempotently in `Intake Responses` and `All Data`; Bot_Map and the
attendance/jobs/outreach tables activate only after Discord admission succeeds.

## Onboarding smoke test

Use a non-supervisor test member where possible.

1. Confirm the persistent welcome panel opens an ephemeral response.
2. Confirm the rules button opens the exact selected rules message.
3. Save gender preference and division; verify one probable `Bootcamp Â· ...`
   role appears.
4. Verify no identity role exceeds six members and no different divisions share
   one role.
5. Select one availability option and verify exactly one readiness role.
6. Complete the remaining answer and rules acceptance.
7. Run `!onboardingstatus` in `#bot-admin`; verify no gender output.
8. Test a full-time + school/college/early-university answer and verify the
   private warning and supervisor review flag.
9. Test `!resetonboarding @member`; verify stored answers and managed roles clear.
10. After majority completion or with `!finalizegroups`, verify final roles and
    late-completer rebalancing.

If role assignment fails, move the bot role higher and run `!doctor onboarding`.

## Bot-driven cohort workbook flow

Use these commands only in that cohort's private `#bot-admin`:

1. For a brand-new Sheet/backend, run
   `!setupcohortsheet fresh confirm <Google Sheet URL>` before importing
   operational history. A complete tab-level safety workbook is created, old Form-response tabs
   are removed, required bot tabs are rebuilt without inherited row colors,
   and `All Data`, `Question_Bank`, `Resources`, and unknown custom tabs are
   preserved. Fresh mode refuses any populated Bot_Map/activity log.
2. For an existing cohort, run `!setupcohortsheet` to create or repair required
   tabs without clearing data.
3. To remove old unconfigured `Form Responses ...` tabs from an existing
   cohort, run `!setupcohortsheet cleanup confirm`. It copies every current tab
   to a separate safety workbook
   first and never deletes any Form-linked tab, active Form tab, or
   unknown/custom tab.
4. Populate/check `All Data`, then run `!syncmembers`.
5. Run `!missingdata`, review the private missing-field list, and click **Send
   / retry pending surveys** when needed. Rerunning `!syncmembers` remains
   idempotent and preserves delivery/completion receipts.

## Discord-primary roster repair

`All Data` is the complete student/contact master and raw Form tabs remain
submission history. Neither makes a student active. Current eligible Discord
members are the only students placed in active `Bot_Map`.

Run `!syncmembers` only in private `#bot-admin`. The command:

1. excludes bots and configured supervisors from the payload;
2. keeps an exact current or archived Discord-ID link where possible;
3. otherwise accepts only a unique normalized `All Data`/Form name or username
   plus matching student name;
4. refuses to trust any username alone when its student name conflicts;
5. copies phone/region/subregion from `All Data`, then fills gaps from Forms and
   `Bot_Map Archive`;
6. preserves supervisor edits in Roster Review columns E:I on every rerun;
7. gives every unmatched current member a stable provisional identity and adds
   it to All Data, Bot_Map, Attendance, Jobs Applied, Outreach Update, Interview Updates, and
   Job_Sheets instead of dropping the member;
8. migrates operational identity/history when the provisional email is replaced
   with a real email; and
9. preserves stale and duplicate historical rows in `Bot_Map Archive`.

Run `!missingdata` in private `#bot-admin`. It shows current students and only
the names of missing fields; it does not echo stored contact values. Clicking
**Send / retry pending surveys** DMs only affected members who do not already
have a successful delivery receipt. Each modal asks for at most
the missing full name, enrollment email, phone/WhatsApp, division/current
region, and district/current area. Discord ID and current username come from
the live member and cannot be mistyped. Submissions are rate-limited, fill only
blank `All Data` values, and synchronize Bot_Map, Attendance, all three activity
matrices, and Roster Review. Existing non-empty master values require
supervisor review to change. `SENT` means Discord accepted the DM, while
`COMPLETED` means the modal was submitted; Discord does not provide a DM
read/open receipt. DM failures are listed only in `#bot-admin`. The welcome
panel contains a button that opens the same private form but never displays its
answers. Use `!addstudent student@email.com @member` only as a legacy
supervisor-reviewed fallback. Onboarding answers do not write `Bot_Map`.

Use `!profilecheck` when you need one definitive refresh plus coverage report:
eligible Discord students, members captured in Roster Review, identity-linked
active rows, complete profiles, and incomplete profiles. Use
`!profilesurvey #channel` when DMs are not enough. It mentions only incomplete
current members in that same-server channel and exposes no field names or
answers. The button opens a private five-field modal bound to the clicking
Discord ID. A stale/missing Roster Review row no longer rejects a verified
current member; hired/left status is preserved, and differences from existing
non-empty All Data values are retained as private review notes instead of
discarding the submission. Onboarding division can fill an otherwise missing
region; gender and study answers never enter the public profile message.

For every future join, JP ADMIN immediately DMs the required five-field private
profile form. The persistent welcome panel and each join greeting also contain
**Complete my private profile**, so a member with closed DMs can open the same
private modal in-server. Discord's native Community Onboarding can require
multiple-choice role/channel answers before entry, but it does not provide this
bot with private free-text email or phone values; contact collection therefore
starts from a button interaction after the account joins the guild.

If a small number of profiles still fail or older master data is wrong, run
`!editprofile <Discord ID>` in that cohort's private `#bot-admin` (or use a
mention when notification is acceptable), click the button,
and enter all five fields. The modal opens immediately without a Sheet read so Discord cannot time it out. The supervisor correction is authoritative, validates
the real email and phone, migrates a changed email across operational history,
preserves hired/left status, and repairs All Data, Bot_Map, Roster Review,
Attendance, Jobs Applied, Outreach Update, Interview Updates, and Job_Sheets. Do not edit raw
attendance responses to force an identity match.

## Job tracker smoke test

1. Use a public-viewer tracker with a known date-applied column and several rows
   for today's cohort-local date.
2. Post the full link including `gid` in the job-tracking channel.
3. Confirm the bot acknowledges/saves it.
4. Run `!checkjobsheets` privately and compare the count to the Sheet. The
   read-only audit can take several minutes because it inspects up to 30 public
   tabs per tracker.
5. Run `!checkjobsheets YYYY-MM-DD` for a historical known date.
6. Test a tracker with an unrelated updated-date column and confirm the
   date-applied column wins.
7. Test a tracker with title rows above its real headers and confirm the embedded
   application-date header is recovered.
8. Test an old link without `gid` whose default tab is not the dated application
   table. The private audit must report the discovered tab without writing; a
   student-facing check may persist the resolved GID for later checks. Also
   test an explicit old GID with requested-date rows on another tab: the audit
   may use the matching tab for that date but must not overwrite the explicit
   saved GID.
9. Test a recognizable application table with no date column. The first
   student-facing check must report a baseline; after adding one row, the next
   check must report one estimated new row. A private audit must never advance
   that baseline.
10. Test an invalid/non-public tracker and confirm it is reported unreadable.
11. Verify the audit does not mention/ping students and does not create/update
   daily score rows.
12. Confirm private audit lines show phone/WhatsApp when `All Data` has a phone,
    without expanding WhatsApp link-preview cards.
13. Run `!studentreport`, test one/all/needs-attention choices, confirm WhatsApp
    previews stay suppressed, and confirm the needs-attention output contains
    only severe cases with an explicit reason.

After deploying Apps Script v54, run `!setupcohortsheet` (or editor `setup()` as
a recovery path). Cleanup/fresh mode first copies every current tab into a
separate safety workbook through the existing Sheets permission, so no extra
Drive authorization is required. The command prepares `Bot_Map`,
`Bot_Map Archive`, and `Roster Review`;
it also upgrades `Jobs_Daily`
and `Interview_Log` in place: existing rows stay intact, names are backfilled,
and old interview rows receive per-student serials. Then deploy a new Web App
version on the existing `/exec` URL and confirm `!doctor sheet` reports v48.

### Tracking matrices and absence review

`Jobs_Daily`, `Outreach_Daily`, and `Interview_Log` are the source of truth. The
`Jobs Applied`, `Outreach Update`, and `Interview Updates` tabs are rebuildable
matrix views with frozen Name/Email/Phone columns. `!setupsheets existing`
restores all available history; `!setupsheets empty confirm` clears only the views and creates a clean
current-roster template. Neither command deletes raw history. Once three
recorded date columns exist, active job/outreach rows totaling fewer than 10
across those latest three dates are colored light red. Inactive students are
dark red across Attendance and all three activity matrices; verified activation
removes that mark. Attendance column G is manual `Remarks`; v46 inserts it
without overwriting old date columns, and later repairs never reset its values.
Run `!arrangesheets` to keep blue
manual-review tabs first, green active forms/reference tabs next, yellow
unassigned Form-like tabs next, and gray bot data last; unknown tabs remain
visible.

Run `!absent` in private `#bot-admin` for the current week, `!absent previous`
for the previous Sundayâ€“Saturday period, or a period such as
`!absent july week 1`. Month weeks mean days 1â€“7, 8â€“14, 15â€“21, 22â€“28, and the
remaining days. The tab-separated code blocks include private contact details
and are intentionally never posted outside `#bot-admin`.

Do not use Google Drive revision history as an application-date source. Drive
revision entries are file-level, may be incomplete for frequently edited Sheets,
and cannot prove which application row was added on a date. The v23 snapshot is
the deliberately bounded fallback; exact historical attribution still requires
a real application-date column.

Only run the student-facing `!jobscheck` when you intentionally want writes and
possible member mentions.

The automatic check runs at **10:30 PM** in each cohort timezone. It processes
students sequentially and performs an exhaustive bounded tab inspection, so a
large cohort may take many minutes. It never stops the cohort loop because one
tracker fails. Every active student is listed exactly once with a Discord
mention: dated applications today, total application rows in the selected
table, new rows since the previous successful check, and recent-day history.
Missing/unreadable trackers are also mentioned with unavailable counts rather
than being silently omitted.

## One-way job-post forwarding

Production forwarding is EJP `#job-posts` â†’ STRIDE `#job-posts`. Do not post
the same job manually in both servers. The old Endgame 12 route is retired; an
exact persisted Endgame destination is replaced with STRIDE on EJP startup.

The permanent `JP ADMIN â€” STRIDE` application performs the send, so it must be
installed in both servers and able to View Channel, Send Messages, Embed Links,
and Attach Files in STRIDE `#job-posts`. In EJP's private `#bot-admin`:

1. Run `!forwarder status` and require `ON` plus `Access: ready`. `WAITING`
   means durable ON intent is preserved but live access currently fails.
2. If needed, run `!forwarder set <EJP-job-posts-id> <STRIDE-job-posts-id>`.
   This validates both channels and leaves the route OFF.
3. Run `!forwarder start`.
4. In STRIDE `#bot-admin`, run `!forwarder stop`; the destination service must
   not create a second route.
5. Post one clearly labeled test in EJP `#job-posts`, verify one STRIDE copy and
   no Endgame copy, then remove the test messages.

Forwarded mentions are suppressed. Edit synchronization works only for messages
forwarded since the latest EJP process start because the message map is memory.
An enabled route revalidates every five minutes and on the next eligible source
post, so a transient Discord lookup failure cannot permanently switch it off.
Use `!doctor forwarder` for the same state in the health report.

## Routine health workflow

### After each deployment

```text
!checkperms
!doctor
!automation list
!control
!settings
!targets
!times
!schedule
```

Review Render logs for login, discovery warnings, cron registration errors, and
Apps Script JSON errors.

`!control` is the recommended starting point. It shows only the command
server's current switches, performance goals, clocks, and day schedules. Common
changes apply immediately and persist in that cohort's Apps Script state:

For command discovery, use `!help`, `!commands`, or `!commandcenter` in the
same private channel. The category menu and search modal are mobile-compatible;
only the mentor who clicks sees search/category results. The Command Center
button in `!control` opens the same catalog. Use `!help <words>` for direct
search or `!help all` for the long reference.

Use `!jp [plain-language request]` when the desired command is unclear. It is
restricted to the same cohort's private `#bot-admin`, suggests only commands
from the shared catalog, and never executes them. When it asks for one missing
detail, use Discord's Reply action on that prompt and answer naturally within
five minutes; a new unrelated `!jp ...` request starts over. If Groq is
temporarily unavailable, the response falls back to the closest locally ranked
catalog entries.

```text
!target applications 10
!target outreach 3
!time jobs 22:30
!time outreach 20:00
!schedule jobs sun-thu
!schedule workshop everyday
!set workshoptech 18
!set workshopcomm 3
!set discussiontech 0
!set slots 11:30-13:00,15:00-17:00,19:00-20:30
!set rtbrdays 7
!set rtbrtop 10
!replanquestions
```

Use `!automation stop <key>` to pause scheduled work without disabling its
manual command. `reports` is the umbrella for `leaderboard` and `weeklyreport`;
their child switches allow one to run while the other is paused. Clocks use
24-hour time in the cohort timezone. Changes made with `!time`, `!target`,
`!set`, or `!schedule` invalidate the shared settings cache, so no Render
restart is needed.

For question timing, use `!questions` in private `#bot-admin`. Its buttons edit
the morning/afternoon/evening time and count, answer window, and safe gap; its
channel picker accepts any cohort text channel. The equivalent commands are
`!questions channel #channel` and
`!questions amounts <morning> <afternoon> <evening>`. Defaults are two questions
at 07:00, 13:00, and 18:00. The daily planner runs at 06:30; **Replan Today**
replaces remaining same-day timers after an edit. The effective gap is raised
when necessary so it is longer than `qwindow`.

For workshops, use `!workshop` (or the Workshop button in `!control`). Configure
the schedule, enable the daily switch, and wait for the private approval card.
No public daily announcement, reminder, poll, or no-show report runs before a
supervisor clicks **Confirm and Send** for that date. `!specialworkshop` manages
the independent opt-in Dawn Focus announcement; it requires `!dawn setup` and
also requires confirmation. Turning either switch off invalidates a later
confirmation click.

For Dawn Focus, run `!dawn repair` once after the v46 rollout. It replaces a
Forum/Media channel with a normal private text channel, disables student thread
creation, clears obsolete per-student send denials, and merges schema-matching
generic Sheet tabs into `Dawn_Attendance` without deleting their source data.
Use `!dawn window always` (the default) or
`!dawn window HH:MM-HH:MM` to control channel writing. The access window is
independent of attendance. Use `!dawn attendance HH:MM-HH:MM` to set the
same-day attendance interval (default `05:00-07:00`); `!time dawncheck` must
remain later than its end. The review fetch starts at the exact window end and
does not scan unrelated messages outside that interval. Friday/Saturday reviews create no
Sheet marks and no absence penalties.

Run `!dawn sync` after assigning the role in bulk, after a backend outage, or
whenever the role count and `Dawn_Attendance` row count differ. It loads every
current role member, refreshes Name/Email/Phone, adds missing rows, and records
role removals missed while the bot was offline in one idempotent backend call.
It never creates `P`/`A` attendance marks or deletes prior date columns. Any
provisional/missing private profiles are listed only in `#bot-admin`; complete
them and rerun the command.

The historical v48 whole-history interview migration is complete. Current
`!backfillinterviews [N days]` is a recent recovery command: it defaults to
three cohort calendar days, accepts 1-30, and reconciles only those immutable
message events and date columns. Use the explicit private
`!repairinterviews` workflow only when a separate whole-history repair is
actually required.

Set cohort goals in private `#bot-admin`, for example `!target applications 10`
for STRIDE. Confirm with `!targets`. The value is guild-scoped: do not repeat it
in EJP unless EJP should also change. Application/outreach values are per
  scheduled day; the other four values are weekly. Deploy Apps Script v54 before
changing the application target so RTBR scoring uses the same goal as job
checks and reports.

Student operations remain private and cohort-local:

```text
!profilecheck
!studentsurvey incomplete
!studentsurvey attention 3
!studentsurvey attention 3 send
!notapplying days 3
!studentstatus @student inactive
!studentstatus @student active
!studentstatuspanel
!activestudents
!inactivestudents
!statusroles
!warnings @student
!warnings reset @student
!warnings start 2026-08-13
!warningreport
!addstudent student@example.com @student
```

Reactivation first syncs the current Discord roster, clears manual exclusion
plus Bot_Map/Attendance inactive color markers through Apps Script, resets the
student's attendance warning record, and reloads the roster. The bot reports
success only after the student is verified active. A hired/left status is not
silently changed. `!studentstatuspanel` opens active/inactive/protected counts
with separate mobile-friendly lists. `!activestudents` opens the active list
directly and confirmation-gates each inactivation. `!inactivestudents` opens
the inactive list:
each page has individual activation buttons plus Activate by date and Activate
all controls. Date/all changes require confirmation. New manual/warning
inactivations store their date, source, and reason; a pre-feature legacy record
is shown as `not recorded (legacy)` rather than receiving a guessed date. Bulk
activation performs one roster synchronization and one final verification.
A manual warning reset does not change active/inactive status.

Discord status roles are a projection of this verified state. `Active Student`
and `Inactive Student` are mutually exclusive; hired/left members have neither.
The bot role must stay above both roles and Hired. `!statusroles` is the safe
full reconciliation after a hierarchy correction or manual Discord-role edit.

Configure role/channel visibility only in private `#bot-admin`:

```text
!accessrules defaults
!accessrules block @Inactive Student #job-posts
!accessrules block @Hired #job-posts   # optional, never part of defaults
!accessrules unblock @Hired #job-posts
!accessrules allow @Some Role #some-channel
!accessrules remove @Some Role #some-channel
!accessrules list
!accessrules apply
```

`defaults` discovers `job-posts`, `job-post`, `job-opportunities`, or
`job-opportunity` and denies it only to Inactive Student. Hired members remain
unchanged unless a mentor adds an explicit `deny @Hired` rule. A Discord
member-specific overwrite or another role's explicit allow can override a role
deny; review unusual custom overwrites in Discord's channel permission page.

### Attendance and warning email batches

The cohort mailer uses the Google account that owns/runs the Apps Script Web
App. Apps Script v54 creates and sends a Gmail draft so the sender has a durable
Sent-folder message and `Mailer_Log` stores its Gmail message ID. In the Apps Script editor,
run `authorizeGmailMailer()` once and approve the requested Gmail permission, then
update the existing Web App deployment. Check remaining recipient quota with
`!mailer quota`.

Configure and preview before enabling:

```text
!mailer to mentor@example.com
!mailer cc none
!mailer bcc none
!mailer replyto mentor@example.com
!mailer sender SCPC-13 Job Placement
!mailer mentor Solih Ahmad Sohan
!mailer phone +8801746877767
!mailer preview absent
!mailer preview warning1
!mailer preview warning2
!mailer preview inactive
!mailer enable
```

Edit a body/subject with `!mailer template <type>`. Manual delivery always
shows group counts and requires the confirmation button:

```text
!mailer send all 2026-08-21
```

Automatic delivery runs after the ten-minute warning classification. The bot
writes a durable per-cohort pending record before starting the timer, resumes
it after a Render restart, and retries a bounded failure without resending an
idempotent batch. The report-date work calendar is authoritative; a custom
warning-day schedule does not suppress an enabled mailer. Student
recipients are BCC-only. Warning 1, 2, or 3 supersedes ordinary absence on that
date; warning 3 is sent only on the inactivation date. `Mailer_Log` prevents
retry duplicates. A category is split into bounded BCC batches that keep the
combined To/CC/BCC count at Google's 50-recipient-per-message limit
batches. Google counts every To/CC/BCC recipient against the Apps Script daily
recipient quota; BCC protects privacy but does not bypass quota.

Before the first warning run, set one cohort-wide inclusive baseline with
`!warnings start YYYY-MM-DD`. The command rereads recorded Attendance evidence,
preserves valid post-baseline warnings, repairs only warning-driven inactive
states invalidated by the baseline, and posts a correction in `#warning`.
It never assigns different start dates to different students. `!warningreport` is also
scheduled for Thursday at `warningreporttime` (default 19:15) and posts only in
the current cohort's private bot-admin. It includes inactive state, warning
count, current-week absences/streak, and a copyable contact table. Its 30-minute
recovery window handles slow settings/Sheet reads or a brief service restart;
a durable date marker prevents a recovered run from posting twice.

### Elimination and appeal recovery

Every attendance-warning run consumes at most one pair of two previously
unused **consecutive recorded-session** absence dates. A present mark or
approved leave breaks the run; separated absences never form a warning pair.
The normal check is queued ten minutes after the non-silent `!closeform`
attendance report on every working day. Its pending state is durable, so bot
startup and the configured recovery clock re-arm a timer lost to restart.
Historical backlog
cannot jump a student directly from 0/3 to 3/3. At
warning three (six counted dates), the student becomes inactive and receives a
mobile-friendly appeal button in `#eliminated-students` plus DM. An inactive
student who rejoins is not silently reactivated; they receive the status and
appeal entry again. Discord has no bot-controlled pre-join full-screen modal,
so a blocked DM falls back to the restricted student-visible channel.

The student chooses Medical emergency, Final examination, Unfortunate death or
bereavement, or Other serious reason, then enters affected dates and a detailed
explanation. The private record is stored in `Appeal_Logs` and sent to bot-admin:

```text
!appeals
!appeals all
!appeal approve <request-id> | optional mentor note
!appeal decline <request-id> | required reason
```

Bootcamp approval reactivates the student and resets warnings. Dawn removal is
mentioned in `#emergency` with its appeal button and a direct explanation of
lost channel access. Dawn approval restores only the Dawn role/access, then
notifies the student privately and in `#emergency`; attendance resumes at the
next scheduled check-in. A removed Dawn member cannot bypass review
with the ordinary join form; `!dawn add @student` remains the mentor's manual
restore path and also clears the Dawn appeal lock.

### Leave requests and approved absence

`!setupserver` creates/reuses `#issues`. A current active student runs `!leave`
there and opens the private modal; the reason is written to `Leave_Requests`
and shown only in that cohort's `#bot-admin`. Mentors can use the approval,
adjustment, and rejection buttons, or these private fallbacks:

```text
!leaves
!leave approve <request-id> 2026-08-16..2026-08-18 | approved for exam
!leave reject <request-id> | insufficient details
```

Every approval/rejection requires a mentor note. Leave operations are serialized
per cohort; the backend enforces one pending request per student and retries do
not create another bot-admin card or another decision notice. Every new decision
is posted in `#issues` mentioning the student, including status and mentor note;
the private request reason/contact remains visible only in bot-admin.

Approval includes only configured working dates from the cohort calendar and
writes `L` into Attendance. `P` and `L` are non-absence; only blank/`A` counts
absent. The Dawn 07:10 review reads the same leave calendar, writes `L`, and
does not consume a Dawn missed-day count. Run `!leaves setup` once after the v46
backend is published to create/verify the ledger before accepting requests.

### Manual selected follow-up announcements

These commands are always manual. They build a private preview in `#bot-admin`
and require the same supervisor to click **Send announcement**. Confirmation
sends one message and a private contact TSV; it never enables, disables,
replaces, or reschedules an automated announcement/report.

```text
!followup dawnjoin #discussion
!followup jobsheet #job-tracking-sheet
!followup profile #discussion
!followup attendance days 2 #warning
!followup interview #interview-update
!followup jobs days 2 #emergency
!followup outreach days 2 #outreach-update
!followup dawn days 2 #dawn-focus-circle
!followup communication #communication-workshop
!followup workshop #communication-workshop
```

`days N` means the minimum number of below-target/absent days for daily
metrics. Application and outreach messages show today's gap and the remaining
period gap; approved leave dates are excluded. Communication/workshop checks
refuse to run while their corresponding feature is disabled.

Preview the attention survey before adding `send`. Its intersection contains
incomplete current students with no application activity in the selected
window; missing-email profiles are included because they cannot be matched to a
tracker. The explicit send may resend an uncompleted survey. `!studentstatus`
retains all history and changes only whether that current guild member is used
by warnings, mentions, reports, and DMs.

For cohort lifecycle changes, run `!cohorts` in the protected control cohort's
private `#bot-admin`. Add and Update validate the target guild, supervisors,
Administrator access, and separate Apps Script URL/key before saving. Retire
removes that cohort after confirmation; the protected control cohort cannot be
retired. The service-specific deploy hook then restarts the single Render
service so handlers are registered exactly once for the new active registry.

`BOT_ACTIVE_WINDOW=04:50-23:30` in Asia/Dhaka is the safe fallback before the
managed control backend can be read. Configure the durable global schedule in
the protected control cohort's private `#bot-admin`:

```text
!backend
!backend windows 04:00-23:00
!backend windows 04:00-14:00,17:00-23:00
!backend days everyday
!backend days weekdays
!backend days mon,wed,fri
!backend dates 2026-08-15,2026-08-20
!backend dates clear
!backend date 2026-08-15 on|off|clear
```

Only a supervisor configured in every active cohort can use these commands.
`weekdays` means Sunday through Thursday. Exact dates replace the repeating-day
rule until cleared, and one-date overrides take priority. A successful update
applies immediately and ensures exactly one five-minute control-project
trigger. The monitor starts pinging ten minutes before each window.

Install `Render-Uptime-Monitor.gs` only in the protected control cohort's Apps
Script project; old per-cohort or external always-on monitors must remain
disabled. The bot prompts the Dawn role at 05:00 by default and scans
the completed window once at 07:10; messages never write to Apps Script one by
one. After changing `Render-Uptime-Monitor.gs`, run
`installRenderUptimeMonitor()` once in the control Apps Script project. Later
`!backend` edits repair a missing or duplicate monitor trigger automatically.

### Daily/weekly operations

- `!dailyreport` for actions/failures since the last report/restart.
- `!onboardingstatus` while onboarding is active.
- `!checkjobsheets` when tracker accuracy is questioned.
- `!audit` after roster changes.
- `!groqstatus` when AI features stop responding.
- `!doctor <check>` for a focused diagnosis before rerunning setup.

## Troubleshooting matrix

| Symptom | Likely cause | Safe response |
| --- | --- | --- |
| Startup loads wrong cohort | Generic `COHORT_*` identity variables absent | Correct Render environment; redeploy; confirm config log. |
| Startup says a field is missing | Partial isolated-mode environment | Supply the complete isolated identity/backend set. |
| Repeated `Unexpected token '<'` / HTML response | Old/archived Apps Script URL or Web App access not set to Anyone | Compare the managed cohort URL with the active deployment, deploy a new version if required, then run `!doctor sheet` and `!doctor post`. |
| One-off HTML 404 while Apps Script executions are otherwise completed | Transient Google Web App edge failure | Current bot retries core reads/idempotent writes automatically; check execution history and rerun the private command if all attempts fail. |
| One outreach event reports `unauthorized`, but `!doctor post` otherwise passes | Isolated Apps Script deployment/routing inconsistency | Safe reads/idempotent writes now confirm one authentication rejection before failing. Run `!doctor post`; the silent 22:50 reconciliation restores any missed message by immutable Discord message ID without pinging students. A repeated rejection means the cohort URL/key pair must be corrected. |
| `!backfilloutreach [N days]` reports `Lock timeout` after a long wait | Apps Script contention or an unusually busy selected window | The default is only three days, history writes use 25-event batches, and lock retries wait for remote completion. Run `!doctor post`, then rerun the same bounded command; message IDs prevent duplicates. |
| `!backfilljobsheets`/`!backfilloutreach` reports a roster-refresh fallback | Google rejected only the optional pre-scan roster write | The import still processed every student in the last durable roster. Run `!doctor post`; rerun the backfill later only to capture brand-new unmatched Discord members. |
| Student tracker reply says the link could not be saved immediately | All retry-safe attempts met a temporary Google Web App failure | Do not ask the student to repost. The next job check reconciles the latest three cohort calendar days automatically; run `!backfilljobsheets` sooner, or specify a larger 1-30-day window when the message is older. |
| Uptime monitor reports HTTP 404 | Health server does not accept the monitor query string, or old Render code is deployed | Deploy the query-safe `keepalive.js`; verify both `/` and `/?uptime=apps-script&ts=1` return 200. |
| Bot is silent everywhere | Token/intents/login failure or wrong guild ID | Read Render logs; verify application intents and `COHORT_GUILD_ID`. |
| One channel is silent | Wrong/stale ID or permission override | Run `!checkperms`; verify `COHORT_CHANNELS_JSON`/discovery name. |
| Duplicate channels | Existing template name not recognized | Add a safe alias to both setup/discovery through the shared normalizer; do not delete data blindly. |
| Onboarding panel/rules broken | Stored message deleted or channel changed | Run `!onboardingpanel`; select an existing rules message again. |
| Cannot assign team role | Missing Manage Roles or bot below target role | Move bot role above managed roles; run permission/onboarding doctor checks. |
| Groups appear outdated | Late responses, changed answers, or a failed role assignment | Run `!onboardingstatus`, then `!finalizegroups`; inspect failures. |
| Tracker count is zero unexpectedly | Wrong tab GID, date/header ambiguity, first snapshot baseline, timezone/date format, or private sheet | Run the private audit; inspect dated/snapshot/baseline status; compare link and column headers. |
| AI command fails | No key, quota/rate limit, or malformed response | Run `!groqstatus`; inspect logs; preserve queued helper behavior. |
| Duplicate scheduled messages | Multiple active bot instances or duplicate module registration | Stop the extra process and inspect `index.js` registration. |
| Settings/switch appears delayed | Five-minute cache | Wait or restart only if operationally appropriate; state is durable. |

## Safe source-change workflow

1. Preserve unrelated working-tree changes.
2. Read `AGENTS.md`, `ARCHITECTURE.md`, `FILE_CATALOG.md`, and direct source
   dependencies.
3. Add tests at a pure boundary where possible.
4. Update command/help/data/operations docs in the same change.
5. Run:

```powershell
npm test
$files = rg --files -g "*.js"
foreach ($file in $files) { node --check $file }
```

6. Load changed Discord modules locally without login when dependencies exist.
7. Deploy to Render.
8. Run focused live checks, then `!doctor`.
9. Report separately what was unit-tested and what was live-tested.

## Dependency maintenance

- `package-lock.json` controls production resolution.
- Prefer non-breaking security updates first.
- A major Discord.js update requires gateway, builder, permissions, and
  interaction API testing.
- A major `node-cron` update requires every cron registration and timezone
  behavior to be retested.
- Never use `npm audit fix --force` automatically on production code.

## Incident rules

- Leaked Discord token: reset it immediately in Developer Portal and update
  Render.
- Leaked Apps Script key: rotate backend secret, redeploy/update Render, and
  invalidate the old value.
- Wrong-server activity: stop the incorrect Render service first, then correct
  isolation variables before restarting.
- Accidental public private-data post: delete it, preserve necessary incident
  evidence privately, identify the output path, and add a regression guard/test.
- Suspected bad bulk write: stop the responsible automation, copy/backup the
  Sheet, inspect Render logs and payload scope, then repair deliberately.
