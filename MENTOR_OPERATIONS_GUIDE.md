# JP ADMIN mentor operations guide

This is the day-to-day handbook after `SELF_HOSTED_SETUP.md` is complete. Start in the private `#bot-admin` channel unless a step says otherwise. JP ADMIN never needs a mentor to delete an existing channel, Sheet tab, message, or student record.

## First-day activation checklist

Run these in private `#bot-admin`, in order:

```text
!syncmembers
!repairpipelines
!rolerepair #discussion
!checkperms
!doctor
!forms
!checkattendance
!checkjobsheets
!control
```

`!syncmembers` includes current non-bot, non-supervisor server members even if they did not complete intake. `!repairpipelines` adds or repairs operational identity rows without deleting history. For a new cohort, run `!automation starter` once: quiet essentials stay enabled and noisy programme channels remain hidden until their matching automation starts. `!checkattendance` and `!checkjobsheets` are private diagnostics; they do not ping students. Fix every required `!doctor` failure before enabling public automation. Optional features such as Groq may remain off if they were intentionally not configured.

Run `!rolerepair` before inviting students when possible. If members already
exist, it assigns independent division, Dhaka-area, availability, work-mode,
English, and multi-skill roles from saved intake answers. Members missing role
data are mentioned in the selected channel with a private form, then only the
remaining members are mentioned once more after two hours. No role object,
channel, message, or Sheet row is deleted.

## Daily mentor routine

| When | Private mentor action | Public effect |
| --- | --- | --- |
| Start of day | `!doctor schedules`, then `!formstatus` | None |
| Attendance opens | `!openform` | Opens the active Form and posts its link |
| During the day | `!checkpipelines YYYY-MM-DD` | None |
| Before a jobs follow-up | `!checkjobsheets YYYY-MM-DD` | None |
| Attendance closes | `!closeform` | Closes the Form, then posts attendance after 30 seconds |
| End of day | Review `!openleaves`, `!checkpipelines YYYY-MM-DD all`, and `!control` | None unless you approve/reject a leave |
| Weekly review | `!weeklyreport` and, if used, `!leaderboard` | Posts the selected leaderboard |

Use `!closeform silent` when a Form must close without an attendance post. Use `!attendance` only when you deliberately want an immediate manual attendance post. Commands such as `!jobscheck`, `!followup ...`, `!activityprompt ...`, reminders, and `!say` can publish or ping; do not use them as diagnostics.

## Attendance: initial setup and normal use

1. In `#bot-admin`, run `!forms`.
2. If the correct Form is listed, run `!forms use <number>`. If it is not listed, run `!forms link <attendance Form edit URL>`.
3. Run `!repairattendance`, then `!checkattendance`. Repair adds or updates active Discord-linked students without changing their marks.
4. Run `!formstatus` to confirm the active Form.
5. At the start of attendance, run `!openform`.
6. At the end, run `!closeform`. Wait for the attendance report; do not run it repeatedly.
7. If the report is questionable, use `!checkattendance YYYY-MM-DD` and `!absent YYYY-MM-DD` privately before changing anything.

Presence comes from the active Form responses matched to the current Discord roster. Approved leave is stored as `L`; it breaks an absence run and is not counted as an unexcused absence. Inactive, hired, left, protected, and supervisor records are excluded by the attendance eligibility rules.

## Job tracking: initial setup and normal use

1. Decide whether the Sheet already has real history:
   - existing data: `!setupsheets existing`
   - truly empty new cohort: `!setupsheets empty confirm`
2. Run `!syncmembers` so every current student has an operational row.
3. Students place their public Google Sheet tracker links in the configured jobs channel. The selected Sheet-tab `gid` in each link is preserved.
4. Run `!backfilljobsheets` to import tracker links from the latest three calendar days. Use `!backfilljobsheets 7 days` or another 1-30-day window only when needed. The import is idempotent and does not change older daily job counts.
5. Run `!checkjobsheets` privately. It reads public tracker tabs, reports invalid or unparseable dates, and never pings students or writes job scores/counts.
6. Use `!checkjobsheets YYYY-MM-DD` for a known date when verifying daily counts.
7. Use `!jobscheck` only when you intentionally want the student-facing exhaustive report; it can list and ping students.

Daily application totals are derived from tracker rows and the cohort timezone. A date column such as **Date Applied** is preferred over an unrelated updated timestamp. Never “fix” a mismatch by deleting Sheet rows; correct the tracker/date or identity link, then rerun the private audit.

## Weekly leaderboard and performance report

JP ADMIN has two different boards:

- `!leaderboard` posts the current two-day question-score leaderboard.
- `!weeklyreport` posts the full Sunday-to-current-date performance leaderboard in the configured discussion channel. It combines live job trackers and backend attendance, outreach, interview, communication, workshop, and question metrics against the configured targets.

Set the operating values in private:

```text
!targets
!times
!schedule
!automation list
!control
```

Use `!target <metric> <amount>`, `!time <name> HH:MM`, `!schedule <feature> <days>`, and `!automation start|stop <key>` only after reviewing the current values. `weeklyreport` and `leaderboard` have separate switches and schedules. A manual command remains available even when its automatic switch is off. Before the first public run, use `!doctor schedules` and confirm the cohort timezone/work calendar.

`!rtbr` additionally reconciles the visible **Right to Be Referred** role. Set
the qualification count, rolling window, and weekly clock with:

```text
!rtbr top 10
!rtbr days 7
!rtbr time 20:00
!schedule rtbr thu
```

The calculation requires verified current Discord identities before changing
membership, so an incomplete identity cannot silently displace an existing
qualifier.

## Leave request and approval

Student flow:

1. The student goes to `#issues` and sends `!leave`.
2. JP ADMIN opens a private modal for requested dates and reason.
3. The reason and contact details go only to private `#bot-admin`; the public channel never receives them.

Mentor flow:

1. Run `!openleaves` (or the older alias `!leaves`) in private `#bot-admin`.
2. Review the oldest pending request in the single manager. Use **Previous**, **Refresh**, and **Next** to move without posting duplicate cards, then use **Approve**, **Adjust dates**, or **Reject**.
3. Add the required mentor note and confirm the exact dates.
4. If buttons are unavailable, use:

```text
!leave approve <request-id> | approved for exam
!leave reject <request-id> | more details required
```

For an adjusted range, use the date controls in the panel. Approved working dates become `L` in Attendance. Rejected requests do not change Attendance. The status message mentions only the requesting student in `#issues`; private reasons and contact details stay in `#bot-admin`. Duplicate pending submissions and repeated decision notifications are suppressed.

## Commands to know every day

| Purpose | Safe first command | Follow-up |
| --- | --- | --- |
| Overall health | `!doctor` | `!doctor <check>` |
| Channel permissions | `!checkperms` | `!repairpermissions` |
| Current students | `!syncmembers` | `!audit`, `!profilecheck` |
| Profile roles | `!doctor onboarding` | `!rolerepair [#channel]` |
| Attendance | `!formstatus` | `!openform`, `!closeform`, `!checkattendance` |
| Combined data readiness | `!checkpipelines YYYY-MM-DD` | `!repairpipelines` |
| Jobs | `!checkjobsheets YYYY-MM-DD` | `!backfilljobsheets [N days]`, deliberate `!jobscheck` |
| Leave | `!openleaves` | page through requests, then approve/adjust/reject with a note |
| Schedules and switches | `!control` | `!schedule`, `!automation`, `!times`, `!targets` |
| Weekly review | `!weeklyreport` | `!leaderboard`, `!rtbr` |
| Find any command | `!help` or `!jp <question>` | See `MENTOR_COMMAND_REFERENCE.md` |

## Command safety levels

- **Private/read-only:** `!doctor`, `!checkperms`, `!checkattendance`, `!checkpipelines`, `!checkjobsheets`, `!forms`, `!formstatus`, `!openleaves`, `!leaves`, `!control`, `!settings`, `!times`, `!targets`, `!schedule`.
- **Private but changes data/configuration:** setup, repair, sync, backfill, target/time/schedule/switch, supervisor, status, mailer, and leave-decision commands.
- **Public or can ping:** `!openform`, normal `!closeform`, `!attendance`, `!jobscheck`, `!leaderboard`, `!weeklyreport`, `!rtbr`, `!followup ...`, reminders, activity prompts, `!say`, and announcements.

The complete categorized list is in `MENTOR_COMMAND_REFERENCE.md`. The live private command center is `!help`; it is authoritative for the running version.

## Recovery without deleting data

- Bot offline: check Render **Live**, then `/health`. HTTP 200 with `ready` means Discord is connected; `scheduled_offline` means the saved operating window is intentionally closed; HTTP 503 means startup or Discord readiness failed. Then inspect Render events/logs and the public Render status page before changing tokens or channels.
- Attendance mismatch: `!checkattendance` → `!repairattendance` → recheck.
- Jobs mismatch: `!checkjobsheets <date>` → verify tracker `gid` and dates → recheck.
- Missing students: enable **Server Members Intent**, then `!syncmembers`.
- Missing or stale profile roles: move the bot role above managed roles, run `!doctor onboarding`, then `!rolerepair [#channel]`.
- Channel issue: `!checkperms` → `!repairpermissions`; do not delete or recreate channels.
- Backend issue: verify the existing Apps Script `/exec` deployment and matching secret, then `!doctor sheet` and `!doctor post`.
- Duplicate-looking output: stop the automation switch, check the schedule/logs, and verify the module was not registered twice before restarting. Backfills and leave decisions have durable/idempotent guards, but public commands should still be run once.
- Regional Render outage: on a trusted local computer run `npm ci`, copy `.env.failover.example` to the gitignored `.env.failover`, and fill it only with this mentor-owned deployment's Render health URL, public Discord Application ID, cohort identity, and private credentials. Then run `npm run start:failover`. The guard refuses legacy/wrong cohort or bot identities, refuses to start while Render is healthy, and automatically stops the local bot when the primary health endpoint recovers. Never run the same token in two healthy bot processes.
