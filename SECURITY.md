# Security and privacy

## Never publish these values

- Discord bot tokens
- Apps Script `SECRET_KEY` / Render `COHORT_API_KEY`
- OAuth client secrets or Render deploy hooks
- Student names, emails, phone numbers, resumes, private onboarding answers, or Sheet exports
- Private `#bot-admin` screenshots containing student or cohort data

Discord Application IDs and public Web App URLs are identifiers, not passwords, but do not publish them unless needed for diagnosis.

## If a secret is exposed

1. Reset the Discord bot token in the Discord Developer Portal when applicable.
2. Replace only `DISCORD_TOKEN` in Render and restart the service.
3. Generate a new backend secret when the Apps Script key was exposed, then update both Apps Script `CONFIG.SECRET_KEY` and Render `COHORT_API_KEY` together.
4. Remove the exposed material from the public location, but assume it was copied already.
5. Run private `!doctor`, `!doctor post`, and `!checkperms` after recovery.

## Reporting a vulnerability or bug

Open a GitHub issue only with sanitized reproduction steps and placeholder IDs. Do not include a working credential or student data. For a vulnerability that cannot be described safely in public, use GitHub's private vulnerability-reporting feature if it is enabled for the repository.
