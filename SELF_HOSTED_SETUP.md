# JP ADMIN: beginner self-hosted setup

This guide is for a mentor who has never created a Discord bot, used Render, or deployed Apps Script. Your copy is independent: it uses your Discord application, your Render service, your Google Sheet, and your Apps Script deployment. It does not connect to the STRIDE production bot or another mentor's data.

For a printable, screenshot-backed walkthrough, use [`output/pdf/JP-ADMIN-Self-Hosted-Installation-Guide.pdf`](output/pdf/JP-ADMIN-Self-Hosted-Installation-Guide.pdf). It follows the same safe sequence and includes a final completion card.

Setup never deletes an existing Discord channel, message history, Google Sheet tab, or student record. JP ADMIN matches existing channel names first and creates only missing standard channels. The first roster sync includes existing non-bot, non-supervisor server members even if they never completed intake.

## Before you start

You need:

- permission to administer the Discord server;
- a Google account that will own the cohort Sheet and Apps Script;
- a free Render account connected to GitHub;
- this repository in your own private GitHub repository (upload the shared ZIP if necessary).

The package also contains `MENTOR_OPERATIONS_GUIDE.md` for daily work and `MENTOR_COMMAND_REFERENCE.md` for every categorized command. Finish this installation guide before operating attendance or student-facing reports.

Keep passwords private. A Discord bot token and the Render value named `COHORT_API_KEY` are passwords. Enter them only in Discord's developer portal, Render's secret environment fields, and the `CONFIG.SECRET_KEY` field inside your private Apps Script project. Never post them in Discord, screenshots, GitHub, or support messages.

## Part 1 — create the Discord bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and choose **New Application**.
2. Give it a recognizable name such as `JP ADMIN - My Cohort`.
3. Open **Bot**. Choose **Reset Token**, copy the token temporarily, and keep it private.
4. On the same Bot page, enable these **Privileged Gateway Intents**:
   - **Server Members Intent**
   - **Message Content Intent**
5. Open **OAuth2 → URL Generator**.
6. Under **Scopes**, select **both `bot` and `applications.commands`**. Under **Bot Permissions**, select **Administrator**.
7. Open the generated link, choose the correct server, and approve the invitation.

![Discord Developer Portal application list](docs/screenshots/discord-developer-login.png)

On the current Discord portal, **Installation** can create the Discord-provided invite link. Confirm **Guild Install**, add both `bot` and `applications.commands`, and set **Permissions** to **Administrator**. If the provided link is unavailable, use **OAuth2 → URL Generator** or replace only the public Application ID in this exact link:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&permissions=8&scope=bot%20applications.commands
```

Never use the bot token in an invite URL. The server picker shows only servers where your Discord account can manage the server.

![Discord application installation settings](docs/screenshots/discord-administrator-install.png)

Administrator is requested because setup may need to create missing channels, repair private-channel permission overwrites, manage student roles, read members, and pin setup panels. It does not bypass Discord's role hierarchy: after invitation, move the JP ADMIN bot role above every student status or identity role the bot will manage.

## Part 2 — put the downloaded ZIP in a private GitHub repository

The ZIP is a clean source package, not a connected Git repository. Extract it first; do not upload the ZIP file itself as the project.

### Recommended: GitHub Desktop

1. Sign in at [GitHub](https://github.com/) and choose **New repository**.
2. Use a name such as `jp-admin-my-cohort`, choose **Private**, and leave README, `.gitignore`, and license creation off. Choose **Create repository**.
3. Install and sign in to [GitHub Desktop](https://desktop.github.com/).
4. In GitHub Desktop choose **File → Clone repository**, select the empty repository, and clone it.
5. Open the cloned local folder. Copy all extracted ZIP contents into that folder. The top level must contain `render.yaml`, `package.json`, `index.js`, and `SELF_HOSTED_SETUP.md`—not another nested folder.
6. Return to GitHub Desktop. In **Summary**, type `Initial JP ADMIN setup`, choose **Commit to main**, then choose **Push origin**.
7. Open the repository on GitHub and verify `render.yaml` is visible at the top level.

![Create a private GitHub repository](docs/screenshots/github-new-private-repository.png)

### Alternative: command line

From inside the extracted package folder, after creating an empty private GitHub repository, run:

```text
git init
git add .
git commit -m "Initial JP ADMIN setup"
git branch -M main
git remote add origin https://github.com/YOUR-NAME/YOUR-REPOSITORY.git
git push -u origin main
```

Replace only the example repository URL. GitHub may open a browser sign-in; never paste a Discord token or Apps Script key into GitHub. For later bot updates, copy the changed files into the cloned folder, review them in GitHub Desktop, commit, and **Push origin**. Render redeploys the connected `main` branch automatically.

## Part 3 — start your Render copy

1. In your private GitHub repository, confirm `render.yaml` is at the top level.
2. Open the [Render Blueprint page](https://dashboard.render.com/blueprints), choose **New Blueprint Instance**, and connect your repository.
3. Render asks for `DISCORD_TOKEN`. Paste the token directly into that secret field and create the service.
4. Wait until the deploy says **Live**. Open `https://YOUR-SERVICE.onrender.com/health`; it should show `OK`.

![Render Blueprint overview](docs/screenshots/render-blueprint.png)

Render Blueprints support a free `web` service and this package requests `plan: free`. Free web services are intended for hobby/testing use: they have a monthly workspace allowance, an ephemeral filesystem, and can spin down after an idle period. A sleeping service takes time to wake and the bot disconnects during a restart. JP ADMIN stores durable cohort data in Apps Script/Google Sheets rather than the local filesystem, but a paid always-on instance is the safer choice when continuous bot availability is required.

![Render free web-service documentation](docs/screenshots/render-free-service.png)

The Blueprint generates `COHORT_API_KEY` for you and starts in safe installer mode. The temporary Apps Script URL is intentional; Discord setup can begin before Google is finished.

## Part 4 — start the private Discord guide

1. In any channel where you can type, run `/setup` and select the JP ADMIN command. `!setup` remains a fallback.
2. JP ADMIN reuses an existing channel named `bot-admin` if present. Otherwise it creates one.
3. It repairs `#bot-admin` so `@everyone` cannot view it and the server owner, initiating administrator, and bot can use it.
4. Continue only in `#bot-admin`. Use the numbered buttons from left to right.

The Discord server owner is always saved as the permanent recovery supervisor—even if another administrator begins setup or an older saved package omitted the owner. After the backend test succeeds, add other mentors in private `#bot-admin` with `!supervisor add @mentor`; confirm with `!supervisor list`. The owner cannot be removed, so the bot cannot become administratively inaccessible.

If `/setup` is not listed, the bot was installed without `applications.commands`: repeat Part 1 with both scopes, wait up to one minute, and reopen Discord. If `!setup` alone is silent, enable Message Content Intent and restart Render. `/setup` remains usable even when that text-command intent is wrong.

## Part 5 — copy and authorize the Google backend

1. Make a new Google Sheet for this cohort. Existing student rows may be kept; do not delete them.
2. In the Sheet choose **Extensions → Apps Script**.
3. Delete only the empty starter function in the new script editor. Paste the complete contents of `Code-v19-FINAL.gs` from this package.
4. Near the top, edit only these `CONFIG` values:
   - `COHORT`: your cohort name;
   - `TZ`: your timezone, normally `Asia/Dhaka`;
   - `SECRET_KEY`: the exact generated value from Render's **Environment** page named `COHORT_API_KEY`.
5. Do not change the Apps Script action names or remove existing Sheet tabs.
6. Save the script. In the function selector choose `authorizeAllRequiredServices`, then choose **Run**.
7. Google will ask for access. Choose **Review permissions**, select the account that owns the Sheet, use **Advanced** if the unverified-app notice appears, and allow access.
8. The helper safely checks Spreadsheet, Forms, triggers, Mail quota, Gmail access, and outbound requests. It sends no email and deletes no data.

![Run the Apps Script permission helper](docs/screenshots/apps-script-authorize.png)
9. Select `setup` and run it once. This initializes required tabs and saves the bound spreadsheet identity.
10. Choose **Deploy → New deployment → Web app**:
    - Execute as: **Me**
    - Who has access: **Anyone**
11. Deploy, authorize if asked, and copy the final URL ending in `/exec`.
12. In Render open your service → **Environment**. Replace `COHORT_API_URL` with that `/exec` URL and save. Render restarts automatically.

Do not create a second Apps Script deployment just because setup is retried. For later code updates, create a new Apps Script version and edit the existing Web App deployment so its public URL remains unchanged.

## Part 6 — finish with the buttons

Return to private `#bot-admin`, run `/setup` (or `!setup`), and complete:

1. **Google permissions** → **Done — test connection**. This performs a read-only backend health check.
2. **Match channels**. Existing configured or recognized channels are reused. Only missing channels are created. Private and announcement-only permissions are repaired.
3. **Sync students**. Every current eligible Discord member is captured in
   `Roster Review`. JP ADMIN searches `All Data`, `Intake Responses`, the
   configured enrollment tab, and safe legacy contact tabs. Only a real email,
   full name, and valid phone enter `Bot_Map` and tracking. A Discord display
   name is never accepted as proof of identity, and fake `@discord.com` or
   placeholder emails are rejected. Unrecognized students receive the private
   missing-data form automatically; stale or duplicate mappings are archived
   rather than silently deleted.
4. **Verify**. The bot checks backend health and protected-channel permissions.

Then run these private commands:

```text
!automation starter
!automation
!checkperms
!doctor
!syncmembers
!profilecheck
```

Do not start public attendance, jobs, outreach, or aggregate activity reports
until `!profilecheck` says every current student is captured, linked, and
complete. If a student's DM is blocked, use the **Send / retry pending surveys**
button or `!profilesurvey #discussion`; submitted contact data remains private.

The starter preset keeps attendance, job tracking, and content sync ready, but
holds noisy student programmes until the mentor deliberately starts them. It
also hides only their dedicated outreach, interview-update, workshop, RTBR,
discipline, and group-activity channels from ordinary students. Core rules,
welcome, discussion, resources, resume, job-hunting, and mentor channels remain
visible. Starting a matching automation reveals its channel; stopping it hides
that channel again. Nothing is deleted.

A complete web-intake submission supplies the student's role profile, so the
welcome flow asks only for rules acceptance. The private questionnaire is a
fallback for missing required role fields, and the bot briefly rechecks slow
backend writes before deciding it is needed.

Diagnostics deliberately suppress mentions, so they do not ping students. Setup is complete when the required backend, permissions, roster, and schedules are healthy. Some optional `!doctor` items can remain disabled when you intentionally did not configure that feature, such as Groq.

Before students arrive, also run `!doctor onboarding`. After existing students
are present, use `!rolerepair #discussion` deliberately: it assigns independent
division, Dhaka-area, availability, work-mode, English and honest multi-skill
roles from saved intake data, then mentions only students whose required role
data is missing. It repeats the reminder once after two hours for only those
still incomplete. It never deletes old roles or data. A web-intake resubmission
updates the student's existing Discord-linked profile and roles automatically.

Configure weekly **Right to Be Referred** membership at any time in private
`#bot-admin` with `!rtbr top <1-25>`, `!rtbr days <1-90>`, and
`!rtbr time HH:MM`.

Now open `MENTOR_OPERATIONS_GUIDE.md`. It explains how to start attendance and job tracking, operate the weekly reports, review leave requests, and avoid student pings during diagnostics. Use `MENTOR_COMMAND_REFERENCE.md` when you need the complete command list.

## Adding a new cohort to the existing unified JP ADMIN bot

The production-style unified bot supports at most three enabled cohorts with strict server isolation. A person who is a configured supervisor in every active cohort can run `!setup` in the current private `#bot-admin` and choose **Add another cohort**, or run `!cohorts` directly.

Before adding it:

- install the same Discord application in the new server with Administrator;
- create a separate Google Sheet and separate Apps Script Web App deployment;
- use a unique Apps Script key;
- include your own Discord user ID in the new cohort supervisors.

After the manager saves the cohort, JP ADMIN restarts and loads the durable registry before Discord login. In the new server run `!setupserver` once, then `!syncmembers`, `!checkperms`, and `!doctor`. Cohorts never share Sheet credentials, channel IDs, student records, schedules, or event routing.

## Normal recovery

- **A numbered step failed:** fix the named issue and press **Retry**. Failed setup does not delete data.
- **Bot is offline:** verify Render is Live and `/health` is HTTP 200, then check the Render logs for a Discord login or configuration message.
- **Invalid token:** reset the token in Discord, replace only `DISCORD_TOKEN` in Render, and restart. Never run two services with the same token.
- **Apps Script test fails:** confirm the Web App URL ends in `/exec`, deployment access is Anyone, and `CONFIG.SECRET_KEY` exactly matches Render's generated key.
- **Duplicate-looking channels:** do not delete anything. Run `!ensurechannels`, inspect the result, and configure aliases/IDs only after identifying the intended channel.
- **Existing students are missing:** enable Server Members Intent, keep their
  existing real email/name/phone data in any recognized Sheet tab, then run
  `!syncmembers` and `!profilecheck` in private `#bot-admin`. Do not invent an
  email from a Discord name. Use the private survey retry when a match remains
  unresolved.
- **`/setup` is missing:** reinstall the bot using both OAuth scopes: `bot` and `applications.commands`.
- **A mentor cannot use setup:** have the server owner run `/setup`, then add the mentor with `!supervisor add @mentor` in private `#bot-admin`.
- **`!setup` is silent:** use `/setup`; then enable Message Content Intent and restart Render so all prefix commands work.

## What to share

Share the repository ZIP, not a working `.env` file. The ZIP must not contain Discord tokens, Apps Script keys, Render deploy hooks, screenshots with private production data, or copied Google data. The included guide screenshots contain no secrets or student data. Each mentor creates their own credentials and infrastructure by following this guide.
