# JP ADMIN — EJP Mentorship Bot Documentation

**Version:** v3.34 (bot) / v60 expected by `!doctor` (Apps Script; frozen EJP-13 remains v55) · **Updated:** September 2026
**Stack:** Node.js (discord.js) on Render Free · Google Sheets + Apps Script (database, API, and scheduled wake-up) · Groq AI (llama-3.3-70b)

---

## 1. Feature Map

| Feature                                                                                                       | Channel                               | Automatic                     |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------- |
| Job post forwarding (EJP `#job-posts` → STRIDE `#job-posts`, edit-sync, mentions suppressed)                 | EJP → STRIDE                          | `!forwarder` controlled       |
| Daily attendance: email/name/Discord-aware form matching → Sheet → absent report                              | #discussion                           | on `!closeform`               |
| Manual form control + supervisor reminders                                                                    | #bot-admin                            | configurable reminders        |
| Hired pipeline (mention → status + green rows + Hired Discord role)                                            | #successfully-hired                   | instant + startup repair      |
| Two-way identity audit (members ↔ database)                                                                   | #bot-admin                            | on command                    |
| Outreach monitor (log posts, ping students below the configured daily target)                                | #outreach-update                      | configurable                  |
| AI interview prep replies (+15 RTBR per interview)                                                            | #interview-update                     | instant                       |
| Question drops: configurable technical/communication totals, AI-scored, cheat detection, honors, auto-refilling bank | #communication-workshop               | configurable window           |
| Live workshop sessions: daily announcement + ✅ attendance polls + no-show report                             | #communication-workshop + #discussion | 10:05 AM / per slot / 8:40 PM |
| Job tracking: exhaustive public-sheet audit; every active student is mentioned with dated-today, total-row, and new-row counts | #job-tracking-sheet | configurable |
| Resume tracking (latest resume per student, auto)                                                             | #updated-resume                       | instant                       |
| Priority for Referral / Right-To-Be-Referred combined score board                                             | #right-to-be-referred                 | Thursday 8 PM                 |
| Full weekly performance leaderboard (applications + attendance first; interview/outreach/practice context plus RTBR rank and referral priority) | #discussion | Thursday 6 PM |
| Private one/all student performance, phone/WhatsApp without preview cards, and interview history              | #bot-admin                            | on command                    |
| Region directory with WhatsApp + resume links                                                                 | #bot-admin                            | on command                    |
| In-memory activity report (done / failed)                                                                      | #bot-admin                            | manual `!dailyreport`         |
| Resources preservation + repost in new servers                                                                | #resources                            | 11 AM (1/day)                 |
| Private role profile, rules acceptance, independent location/availability/work-mode/English/skill roles       | #welcome-to-the-bootcamp              | on join/intake/member interaction |

**Design principles:** Sheets is the durable database (restart-proof) · current Discord membership is the active-student source · `All Data` and Forms provide identity/contact information but never activate a student by themselves · supervisors are excluded everywhere by ID · any non-white identity row in `Bot_Map` or `Attendance` is inactive · `hired`/`left` status skips a student everywhere · empty question categories auto-refill via AI · discussion carries only important announcements.

---

## 2. Right-To-Be-Referred Score (rolling 7 days)

Top scorers get **first access to mentor-special job referrals** and the visible `Right to Be Referred` role. The weekly run removes the role from members who are no longer in the configured top quantity. Use `!rtbr top 10`, `!rtbr days 7`, `!rtbr time 20:00`, and `!schedule rtbr thu` to configure it.

| Component           | Points                                                              |
| ------------------- | ------------------------------------------------------------------- |
| ❓ Questions        | raw AI score per answered drop (0–10, +2 first-correct, cheats 30%) |
| 🎯 Interviews       | 15 per interview shared in #interview-update                        |
| 💼 Job applications | per day: min(count,target)/target × 10 · +2 if above target         |
| 🔥 Streak           | +3 per consecutive day hitting the configured application target (cap 15) |
| 🎤 Workshop         | 4 per attended session (✅ poll reaction)                           |

---

## 3. The Google Sheet — Tabs

| Tab                      | Purpose                                                                                                                                                      | Written by    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| `Enrollment Responses` / `Attendance Responses` | Friendly names for the configured active raw Form response tabs. `!arrangesheets` applies these names without changing the underlying Form destination; additional Form-like tabs are kept yellow for review. | Google Forms |
| `Attendance`             | Name/Email/Phone/profile fields, mentor-editable `Remarks`, then one P/L column per session. Repairs never reset Remarks. Inactive students are full-row dark red; activation removes that mark. Rolling history ignores future columns and merges duplicate rows/dates. | Apps Script   |
| `Dawn_Attendance`        | One canonical horizontal tab: Name/Email/Phone plus date columns. `P · HH:MM` means a qualifying message in the configured Sunday–Thursday window (default 05:00–07:00); approved `L` is excused; `A` means absent. Role changes add `Joined`, `Removed`, or `Rejoined` in that date cell. `!dawn sync` backfills every current role member and offline removal in one request; `!dawn repair` merges and hides legacy generic tabs. | Bot batch     |
| `Leave_Requests`         | Private request/decision ledger. Approved configured working dates are also written as `L` in Attendance. Reasons and contacts are never posted publicly. | Bot + supervisor |
| `Appeal_Logs`            | Private bootcamp/Dawn removal appeal and mentor-decision ledger. Includes contact, cause, dates, explanation, status, and decision note. | Bot + mentor |
| `Mailer_Log`             | Private idempotency/audit ledger for absence and warning email batches. Student BCC addresses and errors stay private. | Apps Script |
| `All Data`               | Master database: required fullName/email/phone plus optional Discord Username, Region/Division, and Subregion/Area. These values are preferred over Form/archive fallbacks. | You |
| `Bot_Map`                | Current Discord students only: Email, Name, Username, **Discord ID**, **Status**, **Region**, **Subregion**, **Phone**, match source, and review note. White-looking near-neutral identity cells here and in Attendance = active; deliberate status colors remain excluded and are explained by private audits. | Bot + you |
| `Bot_Map Archive`        | Stale and duplicate mappings preserved by roster sync. It is never treated as the active roster. | Bot |
| `Roster Review`          | Every eligible current Discord member, identity-link state, and the missing profile fields used by the private survey dashboard. | Bot |
| `Outreach_Log`           | first/last/total outreach posts per student                                                                                                                  | Bot           |
| `Question_Bank`          | ID, Category, Difficulty, Question, Model Answer, Used On (empty = available). Random pick, auto-refills.                                                    | Import/AI/you |
| `Scores`                 | one row per answered question                                                                                                                                | Bot           |
| `Job_Sheets`             | student → tracker Sheet ID plus selected tab GID; `DEFAULT` means the submitted link omitted `gid`, so the first visible/default tab is checked              | Bot           |
| `Jobs_Daily`             | Date, Email, Count, Name; one authoritative day+student application count for history, weekly reports, streaks, and RTBR                                      | Bot           |
| `Jobs Applied`           | Rebuildable matrix view from `Jobs_Daily`; active rows below 10 total over the latest three recorded dates are light red, while inactive rows are dark red | Bot           |
| `Outreach_Daily`         | Durable dated outreach-message history with immutable Discord message ID/source link for idempotent targets and matrix rebuilding                             | Bot           |
| `Outreach Update`        | Rebuildable matrix from immutable `Outreach_Daily` events. Retries repair partial summary/matrix writes; active threshold rows are light red and inactive rows dark red | Bot           |
| `Interview_Log`          | interview logged date, student, company, per-student serial, interview date, role/details, Discord source, and timestamp; structured posts log without AI      | Bot           |
| `Interview Updates`      | Rebuildable horizontal per-student/date interview-count matrix sourced from `Interview_Log`; inactive rows are dark red                                      | Bot           |
| `Workshop_Attendance`    | date, slot, attendee                                                                                                                                         | Bot           |
| `Resumes`                | latest resume message link per student                                                                                                                       | Bot           |
| `Resources`              | preserved #resources content for new servers                                                                                                                 | Bot           |
| `Projects`               | best-project links and summaries used in candidate matching                                                                                                 | Bot           |

---

## 4. Commands (supervisor-only — `!help` opens the Command Center)

Run `!help`, `!commands`, or `!commandcenter` in the cohort's private
`#bot-admin`. Choose a category from the menu or tap **Search commands** and
describe the task; results are visible only to that mentor and work in Discord
desktop, web, and mobile. `!help attendance repair` performs the same search
without opening the modal, while `!help all` posts the complete reference.

For a conversational search, run `!jp` or add a natural request such as
`!jp set the job target to 10`. `!jp` reads the same verified Command Center
catalog. If a required value is missing or two controls could match, it asks
one short question; reply directly to that bot message in plain English within
five minutes. It suggests the final command for review but never runs it.

**Setup:** `/setup` or `!setup` (private four-step beginner guide; self-hosted server owner is the permanent recovery supervisor) · `!setupserver` (channels + discovery + intros + 3-day warm-up) · `!ensurechannels` (missing channels + permissions only; no reposts/warm-up reset) · `!repairpermissions` (overwrite-only retry) · `!supervisor list|add @user|remove @user` (server-local durable supervisor access, including signed-capsule persistence for self-hosting) · `!announceall` · `!editannouncement <message link>` (private editor for pinned bot rules/intros) · `!checkperms`
**Onboarding:** `!onboardingpanel` · `!onboardingstatus` · `!onboardingreminder [#channel]` · `!rolerepair [#channel]` (`!onboardingrepair` alias) · `!completioncheck` · `!completionreminder` · `!setrulesmessage <link>` · `!resetonboarding @member` · `!groupactivities setup|sync|status`

The intake and Discord fallback create independent roles rather than fruit
teams: one `Division · ...`; one `Dhaka Area · ...` only for Dhaka; one each for
availability, work mode, and English level; and every honestly selected
`Skill · ...`. Outside-Dhaka members are not asked for an area. Re-submitting
the OAuth intake updates mutable profile answers and roles without creating a
duplicate student. Run `!rolerepair #discussion` after migration or manual role
edits. It processes members sequentially, mentions only students still missing
role-profile data, and makes one restart-safe follow-up after two hours.

Discord does not expose per-message read receipts to bots for mentor or bot
messages. Delivery, reactions, and button clicks can be observed, but none is a
reliable silent “seen” list; JP ADMIN therefore does not claim one.
**Identity:** pre-entry `!intake status|enable [slug]|disable|link` · automatic private join profile fallback (name, real email, phone, region, area) · `!syncmembers` · `!missingdata` / `!studentsurvey incomplete` (private dashboard/DM surveys) · `!studentsurvey attention [days] [send]` (incomplete plus no applications; preview before explicit send) · `!profilecheck` (refresh and verify all current members/profile coverage) · `!profilesurvey #channel` (mention incomplete students; answers stay private and Discord-ID-bound) · `!editprofile @student|DiscordID` (immediate supervisor correction with historical identity migration; raw ID avoids a ping) · `!studentstatus @student active|inactive` (activation/inactivation is atomic and verified across Discord, Bot_Map, Attendance, exclusions, metadata, warnings, and mutually exclusive status roles) · `!statusroles` · `!accessrules list|defaults|apply|allow|deny|remove` · `!studentstatuspanel` (active/inactive/protected counts and separate tap-to-manage lists) · `!activestudents [page N]` · `!inactivestudents` (private dated inactive list with individual/date/all activation controls; status changes require confirmation) · `!notapplying [days N]` · `!synchiredroles` · `!audit` · `!addstudent <email> @user` · `!students [region] [sub]` · `!studentreport` (private one/all/severe-needs-attention picker; every flagged student shows the reason; WhatsApp preview cards are suppressed)

For clearer access commands, `!accessrules block @role #channel` denies viewing
and `!accessrules unblock @role #channel` restores Discord/category inheritance.
The legacy `deny` and `remove` spellings remain valid.

For new cohorts, share the OAuth intake portal instead of a Discord invite. It
hides the server until the structured enrollment response is saved, adds the
verified Discord account, and then activates all tracking rows. The private
join profile remains only as a fallback for direct/manual joins. Keep native
**Apply to Join** off when using the portal so applicants do not face a second
manual approval gate. A configured supervisor can test the same portal without
being inserted into student tracking; the structured test response is retained
with a supervisor-test status. The English-only intake retains all non-Discord
STRIDE data-collection fields. OAuth supplies the immutable username, and the
portal keeps its own rules commitment instead of duplicating the old manual
Discord questions.
**Forms/Attendance:** `!setupcohortsheet [Sheet URL]` · `!setupcohortsheet cleanup confirm` · `!setupcohortsheet fresh confirm [Sheet URL]` · `!formtemplate` (show/add/edit/remove/move/help/title/description/collectemail/validate/restorecore/save/load/list/delete/reset) · `!createforms attendance [name]` (portal cohorts) · `!createforms <name>` (legacy two-Form mode) · `!designforms <description>` · `!forms` · `!forms use <number|id>` · `!forms link <edit URL|id>` · `!openform` · `!closeform` (closes + posts) · `!closeform silent` (closes only) · `!formstatus` · `!attendance` · private `!checkattendance [YYYY-MM-DD]` / `!repairattendance` · private `!checkpipelines [YYYY-MM-DD] [all]` / `!repairpipelines` · private `!absent [current|previous|YYYY-MM-DD|july week 1]` · `!setupsheets existing` / `!setupsheets empty confirm` · `!arrangesheets`
Attendance uses the freshly synchronized guild roster at both Apps Script and Discord publication boundaries. Students already inactive before the report are absent from its total and mentions; a student deactivated by the warning run after today's report appears today once and is excluded afterward. The immutable Google Form Timestamp controls the attendance day even when the editable date answer is wrong. An unmatched or ambiguous email is privately rejected, counts as no attendance, and leaves that student absent without blocking the valid cohort report; a missing/corrupt immutable Timestamp still stops safely.
**Outreach/Jobs/Interviews:** `!backfilloutreach [N days]`, `!backfillinterviews [N days]`, and `!backfilljobsheets [N days]` default to the latest **3 cohort calendar days** and accept **1-30 days** (for example, `!backfilloutreach 7 days`). They stop reading when Discord history reaches an older date and never clear or overwrite older durable events. Outreach/interview IDs remain idempotent; jobs saves only the newest tracker link in the selected window and does not change older daily counts. `!outreachcheck` · `!jobscheck [YYYY-MM-DD]` (student-facing and pings; optional date recovers a missed run) · `!checkjobsheets [YYYY-MM-DD]` (private, no pings/writes). Every job check automatically reconciles the same recent three-day window first. Interview and outreach history silently reconcile the same window every calendar day at 22:50, including holidays/weekends.
**Activity follow-up:** `!activityprompt outreach|interview|communication|all` · `!activitycheck attendance|jobs|interviews|all`
**Private mailer:** `!mailer status|enable|disable|quota` · `!mailer to|cc|bcc <emails|none>` · `!mailer replyto|sender|mentor|phone <value>` · `!mailer template|preview absent|warning1|warning2|inactive` · `!mailer send absent|warnings|all [YYYY-MM-DD]`. The reusable sender default is **Job Placement — Programming Hero**, and `solih@programming-hero.com` is always included in CC; `cc none` removes only additional CC addresses. Students are always BCC-only. Gmail hides BCC from received copies; inspect the Apps Script sender account's **Sent** copy or the bot-admin TSV/`Mailer_Log` audit. The confirmation reconciles the full Attendance absence total against eligible, already-inactive/excluded, invalid-email, duplicate-email, and unresolved rows, and attaches a private TSV with every recipient or skipped reason. Automatic mail waits until the attendance warning classification finishes; warning recipients do not also receive the absence email.

**Manual selected announcements:** `!followup <dawnjoin|jobsheet|profile|attendance|interview|jobs|outreach|dawn|communication|workshop> [days N] [#channel]`. The bot first builds a private no-ping preview; only the initiating supervisor can confirm. This sends once and never replaces or changes automated announcements/reports.

**Leave:** students run `!leave` in `#issues` and submit dates/reason privately. Requests and decisions run one at a time per cohort; a duplicate pending submission does not create another mentor card. Mentors use `!openleaves` (or `!leaves`) for one private oldest-first manager with Previous/Refresh/Next, then approve, adjust, or reject and add the required mentor note. Status plus note is posted in `#issues` mentioning that student; private reason/contact stays in bot-admin. Approved working dates show `L`; only blank/`A` counts absent.

**Warnings and appeals:** `!warnings @student` · `!warnings reset @student` · `!warnings start YYYY-MM-DD` · `!warningreport` · `!appeals [all]` · `!appeal approve|decline <request-id> | note`. The start command gives every student one inclusive baseline, rebases recorded evidence, repairs only unfair warning-driven inactivity, and posts a correction. One run can add only one warning. Warning three means three distinct two-date incidents (six counted absence dates), marks the student inactive, stops all attendance/activity/RTBR/leaderboard credit until mentor reactivation, and posts an appeal button in the eliminated-students channel. The Thursday private warning report has a 30-minute recovery window and a durable duplicate guard. Dawn removal is scope-specific, is announced with an appeal in `#emergency`, and cannot be bypassed by reusing the normal Dawn join form; mentor approval restores the Dawn role and posts a student-facing decision notice. The select menus, buttons, and modals work in Discord mobile. Discord does not support a bot-defined pre-join popup, so inactive rejoiners receive a DM or channel fallback.
**Questions:** `!questions` (clickable scheduler + channel picker) · `!questions channel #channel` · `!questions amounts <morning> <afternoon> <evening>` · `!dropquestion [cat] [workshop|discussion]` · `!genquestions <cat> <n>` · `!leaderboard` · `!weeklyreport` · `!rtbr` · `!replanquestions`
**Targets:** `!targets` · `!target applications 10` · the same command supports `outreach`, `attendance`, `interviews`, `communication`, and `workshops`
**Automation control:** `!control` · `!automation list|start|stop <key|all>` · `!automation starter` for a quiet new cohort · `!times` · `!time jobs 22:30` · `!schedule jobs sun-thu` · `!calendar` (private date selector) · `!calendar week sun-thu | context` · `!calendar holiday|working YYYY-MM-DD | context` · advanced `!settings` / `!set <key> <value>`
**Workshop:** `!workshop` / `!specialworkshop` (private controls) · `!workshopannounce` (confirmation request) · `!workshoppoll`
**Forwarder:** in `#bot-admin`, `!forwarder status|start|stop` · `!forwarder set <srcId> <dstId>` (live validation; route changes stay OFF until started; temporary failures show WAITING and retry without erasing ON intent)
**Reusable content:** `!contentsync source <server-id|control>` · `!contentsync run resources|jobhunting one|all` · `!contentsync auto resources|jobhunting on|off`
**Dawn Focus Circle:** `!dawn setup|invite|status|review|repair|sync` · `!dawn window [always|HH:MM-HH:MM]` · `!dawn attendance [HH:MM-HH:MM]` · `!dawn add|remove @student`
**Misc:** `!backupresources` · `!postresource` · private destination `!resourcesync status|on|off` · `!dailyreport` · searchable `!help` / `!commands` / `!commandcenter` · `!help all`

### Editable form templates

Form administration is private to `#bot-admin`. The built-in working pair is
based on the English STRIDE enrollment form plus bot-required phone, division,
area, Discord identity, job-holder/focus, attendance email/date, checkbox, and
arrival-time fields. Review it with `!formtemplate show enrollment` and
`!formtemplate show attendance`.

Run bare `!formtemplate` for exact add/edit syntax. Every mutation is saved to
Apps Script immediately. Named saves preserve both forms together and can be
loaded for a later cohort. Core bot fields may be reworded or moved; if one is
removed, validation blocks creation until `!formtemplate restorecore ...`
restores it. Run `!formtemplate validate` before the one-time `!createforms`.

---

## 5. Automatic Daily Timeline (Asia/Dhaka)

These are defaults, not hard-coded obligations. Use `!control` to see the
current server, `!time <name> HH:MM` to change a clock, `!schedule <key> <days>`
to change days, and `!automation start|stop <key>` to change whether it runs.
Every change is saved only for the command's cohort and applies without a
Render restart.

| Time                   | Event                                                                 | Where                 |
| ---------------------- | --------------------------------------------------------------------- | --------------------- |
| 4:50 AM                | Dawn Focus stale member-overwrite repair; not attendance              | dawn-focus-circle     |
| 6:00 AM Sun–Thu        | Outreach, interview, and communication templates (@everyone)          | respective channels   |
| 5:00 AM Sun–Thu        | Dawn role prompt; first non-empty message in configured 05:00–07:00 window counts | dawn-focus-circle |
| 7:10 AM Sun–Thu        | One history scan, horizontal Sheet batch, leave-aware report, restriction/survey | dawn-focus-circle |
| 10 minutes after each successful non-silent attendance close/report | Two-consecutive-recorded-session attendance warning (`P`/approved `L` breaks the streak) | warning |
| 8:00 AM every workday | Recovery check for any post-report attendance warning missed during a restart | warning |
| 8:10 AM Monday & Wednesday | Two-day application-target follow-up | emergency |
| Thu 8:20 AM / 7:00 PM  | Weekly interview reminder and final follow-up list                    | interview-update      |
| Thu 7:15 PM            | Private inactive/warning/current-week attendance report              | bot-admin             |
| 9:05 AM                | Question drop plan for the day                                        | internal              |
| 10:05 AM               | Private workshop approval request; public schedule only after confirmation | bot-admin → workshop + discussion |

| 7:00 AM / 1:00 / 6:00 PM | Two questions in each period; times, counts, window, gap, and channel are editable | selected question channel |
| 11:00 AM               | 1 preserved resource reposted (new servers)                           | resources             |
| 12:10 / 15:40 / 19:40  | ✅ attendance polls (15-min windows) + session reports                | workshop + discussion |
| 8:00 PM                | Outreach silent-students check (@everyone)                            | outreach-update       |
| 6:00 PM Thursday       | Full weekly performance leaderboard (@everyone)                        | discussion            |
| 8:00 PM alt days       | Question-score leaderboard (@everyone)                                 | workshop              |
| 8:00 PM Thursday       | Priority for Referral / RTBR board (@everyone)                       | right-to-be-referred  |
| 8:40 PM                | Workshop no-show mentions (@everyone)                                 | workshop              |
| 9:00 PM                | "Form not open?" reminder                                             | bot-admin             |
| ~10 PM                 | You: `!closeform` → attendance posts (@everyone + mentions + history) | discussion            |
| 10:30 PM               | Exhaustive daily-application check; individually mentions every active student and shows dated today, total tracker rows, new rows, and recent history | job-tracking-sheet |
| 10:50 PM daily         | Silent idempotent interview + outreach reconciliation for the latest three cohort calendar days (including holidays/weekends) | internal; failures only in bot-admin |

Attendance-warning and application-emergency messages expose only Discord
mentions publicly. The same run sends a copyable Name/Email/Phone/Reason TSV,
without pings, only to that cohort's private `#bot-admin` for manual contact.

Editable clock aliases are `formopen`, `formclose`, `outreach`, `jobs`,
`questionplan`, `leaderboard`, `workshopannounce`, `workshopnoshow`,
`weeklyreport`, `rtbr`, `resources`, `dmnudges`, `suggestions`,
`outreachprompt`, `interviewprompt`, `communicationprompt`,
`attendancewarning`, `warningreport`, `jobemergency`, `interviewmorning`, `interviewreview`,
`contentsync`, `activityreconcile`, `dawnreset`, and `dawncheck`. Question
counts/windows use `!set workshoptech`, `workshopcomm`, `discussiontech`,
`qstart`, `qend`, and `qwindow`; run `!replanquestions` after changing the
same day's plan. Workshop slots use `!set slots ...`. RTBR uses `!set rtbrdays`
and `!set rtbrtop`.

---

## 6. 🚀 NEW SERVER SETUP (fastest path, ~20 min)

**Rule of thumb: invite the bot with Administrator — all permission hassle disappears.**

1. **Google:** create a Sheet → paste local backend v60 → CONFIG:
   cohort name, blank FORM_ID if the bot creates Forms, new private SECRET_KEY
   → Deploy →
   **New deployment** → Web app → Execute as Me → **Anyone** → copy `/exec`
   URL. After adding the cohort, run
   `!setupcohortsheet fresh confirm <Google Sheet URL>`; this binds the Sheet,
   creates clean required tabs, and installs the trigger.
2. **Discord (2 min):** create the server (channels optional — the bot creates missing ones) → invite JP ADMIN with **Administrator** → copy the Server ID
3. **Bot (3 min):** invite the permanent JP ADMIN bot as Administrator, then run `!cohorts` in the protected control server's private `#bot-admin`. Choose **Add cohort** and provide the server ID, supervisors, deployed Apps Script URL/key, and timezone. The bot validates access, saves the durable registry, and restarts the one Render service through its service-specific deploy hook.
4. **In the new server (5 min):** `!setupserver` → `!setupcohortsheet fresh confirm <Sheet URL>` → import/check `All Data` → `!profilecheck` → `!missingdata` → use **Send / retry pending surveys** or `!profilesurvey #discussion` when profiles are incomplete → `!repairattendance` → `!checkattendance` → `!audit` → `!checkperms`. Fresh Sheet setup copies every current tab to a separate safety workbook and refuses existing operational history.
5. Day 4: the full engagement machinery wakes up by itself.

Standard channel names (auto-discovery): `welcome-to-the-bootcamp, rules-and-regulations, discussion, bot-admin, successfully-hired, outreach-update, interview-update, communication-workshop, job-tracking-sheet, right-to-be-referred, automation-announcement, resources, updated-resume, my-best-projects`. Existing `outreach-updates` and legacy `outreach` names are also recognized without creating a duplicate; an explicitly configured channel ID always wins.

---

## 7. Golden Rules & Troubleshooting

1. **Apps Script edits need a NEW VERSION**: Deploy → Manage deployments → ✏️ → New version → Deploy. #1 cause of "not working."
2. **One bot instance only** — Render runs it; never `node index.js` locally at the same time.
3. **Silent bot? Read Render Logs.** AI features fail silently in channels by design.
4. `!checkperms` diagnoses any "Missing Permissions" (irrelevant with Administrator).
5. Keep the complete contact master in **All Data**. `!syncmembers` uses it
   first, fills gaps from Forms/`Bot_Map Archive`, and records every eligible
   member in `Roster Review`. Columns E:I in Roster Review are durable manual
   corrections and survive later syncs. The backend also discovers OAuth intake
   and safe legacy contact tabs by headers. Members without a durable Discord-ID
   match or complete real-email/full-name/phone profile stay only in private
   Roster Review and automatically receive the private survey; no synthetic
   email or null phone enters tracking. Attendance and aggregate activity reports
   pause until every current student is safely linked. Run `!profilecheck` for a definitive current-member
   coverage refresh, then `!missingdata` for targeted private DM surveys or
   `!profilesurvey #channel` for a public reminder whose answers remain private.
   Use `!addstudent` only as the
   supervised fallback. The welcome panel contains only a button that opens the
   private form; it never displays submitted student data.
   Never edit raw Form rows merely to force a link.
6. Repeated `Unexpected token '<'` = stale/archived Apps Script deployment URL
   or access is not set to Anyone. A one-off HTML 404 can be a Google edge
   failure; core reads and idempotent writes retry automatically first.
7. Restarts lose only open question windows and the edit-sync map — all Sheet data survives.
8. Discord **attachment links expire** (~weeks). Resumes use permanent message jump links; resources keep text + external links reliably.
9. Update workflow: edit → `git push` → Render redeploys (~2 min).
10. **Never commit `.env`**; leaked token = reset immediately in the Developer Portal.
11. Bot name is set in Developer Portal → **Bot → USERNAME** (not the app name); server nicknames override it.

---

## 8. Free-Tier Budget

Render grants 750 Free instance hours per workspace each month. The preferred
deployment uses one Discord application and one Render service for up to three
cohorts. `BOT_ACTIVE_WINDOW=04:50-23:30` is the startup fallback. Private
`!backend` commands in the protected control cohort set the durable active
windows, repeating weekdays or exact dates, and date overrides. The one
`Render-Uptime-Monitor.gs` trigger reads that schedule and wakes the single
Render URL ten minutes early.
Use `!backend override YYYY-MM-DD[,YYYY-MM-DD] always` for temporary 24-hour
dates, or replace `always` with one to four `HH:MM-HH:MM` windows. The normal
schedule resumes automatically after those dates.
Students should submit bot-tracked channel updates only inside that window. Old per-service or
always-on monitors must remain paused.

EJP/STRIDE form the one-time Render bootstrap. With
`COHORT_CONTROL_KEY=stride` and this service's secret deploy hook configured,
an authorized supervisor can run private `!cohorts` to add, update, or retire
later cohorts. The bot validates the new Discord installation and Apps Script
backend, saves the registry in protected STRIDE Apps Script state, and restarts
the one service. Ordinary commands and all student data remain server-specific.
