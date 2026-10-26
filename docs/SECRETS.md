# Secrets and credentials

This repository holds **no repository secrets** today. Check with `gh secret list --repo SureForgeTech/filemaker-data-api-for-vs-code`; the list should be empty. One secret is planned and named below (`OVSX_PAT`) but not set yet.

## Inventory

| Name | Where | What it is | Secret? |
| --- | --- | --- | --- |
| `OVSX_PAT` | Repository secret (not set yet) | Eclipse Foundation publisher access token for publishing to open-vsx.org. Needed by the **publish-ovsx** job in CI ([RELEASE.md](./RELEASE.md#how-publishing-works)); the job fails closed without it. Setup tracked in [#265](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/issues/265). | Yes, once set |
| `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` | Variables on the `marketplace` environment | Identifiers of the Microsoft Entra managed identity that publishes to the Marketplace. Setup: [JOB_AID_ENTRA_PUBLISHING.md](./JOB_AID_ENTRA_PUBLISHING.md). Not set yet, so publishing is manual until the setup is done ([RELEASE.md](./RELEASE.md#manual-publish-fallback)). | No |
| `LINUX_RUNNER_LABELS` | Repository variable | Runner labels for CI jobs | No |
| `GITHUB_TOKEN` | Provided by GitHub Actions per run | Used by the release job and workflows with explicit permissions | Managed by GitHub |

Publishing signs in with a short-lived GitHub OIDC token exchanged for the managed identity, restricted to the `marketplace` environment (tags only, a required reviewer). There is no personal access token to store or renew. The old `VSCE_PAT` token type stops working on 2026-12-01 in any case; if a `VSCE_PAT` secret turns up, delete it.

Not in use any more: the Claude Code cloud agent secrets (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `PRS_PAT`) were removed together with the workflow that used them. Open VSX publishing (`OVSX_PAT`) is wired into CI but the secret itself is not set up yet (#265).

## Rotation calendar

The monthly `secret-rotation-reminder.yml` workflow reads the table below and files a reminder issue about 30 days before each tracked credential is due for rotation. One row per credential, with an owner and the next rotation date in ISO form (`YYYY-MM-DD`).

| Name | Owner | Next rotation due | Notes |
| --- | --- | --- | --- |
| <!-- No tracked credential yet. Add a row here when you add a secret, with an owner and a next rotation date. --> | | | |

There are no rows yet because this repository holds no secrets: publishing uses a short-lived OIDC token instead of a personal access token (see [JOB_AID_ENTRA_PUBLISHING.md](./JOB_AID_ENTRA_PUBLISHING.md)). The table is the mechanism, not a list of invented expiries — the workflow only reminds about the rows that are really there.

A row without a date (blank or `N/A`) is tracked but never reminds. A row with an unreadable date, the wrong number of columns or a name that appears twice is reported as a warning by the workflow and fails that run, so a typo cannot silently hide a rotation. Two rows with the same name are a duplicate: one credential cannot have two rotation dates, so neither row is honored until the table is fixed. A duplicate is a duplicate even when one of the two rows is unreadable, so a broken date cannot hide the second date of the same credential.

The reminder issues carry the label `ops/secret-rotation`. The workflow creates that label when it is missing; if the repository settings do not let the job create it, add the label by hand once.

### Manual dry-run

The workflow can be run by hand from the Actions tab. The `dry-run` input is on by default for a manual run: it prints what it would file and creates no issue and posts no comment. Untick it to file the reminders for real. The scheduled run always files for real. Only one run files at a time: a run that starts while another one is still going waits for it, so the two cannot race for the same issue.

The same dry run works from a checkout, without the workflow:

```bash
node scripts/secret-rotation-remind.mjs --dry-run
```

The parser behind it is `scripts/lib/secret-rotation.mjs`, its tests are `scripts/secret-rotation.test.mjs` (`node --test scripts/*.test.mjs`).

## If you add a secret

1. Prefer something that is not a secret (OIDC, a variable).
2. Scope it to an environment with a required reviewer, not the whole repository, and give the job that uses it the narrowest permissions.
3. Never run `npm ci` or other dependency install scripts in a job that holds it (the `publish` job installs `vsce` from its own lockfile with `--ignore-scripts` for this reason).
4. Add a row to the [Rotation calendar](#rotation-calendar) above with an owner and an expiry, and set a calendar reminder 30 days before the expiry. The monthly `secret-rotation-reminder.yml` workflow files a reminder issue from that row about 30 days before the date; it is a safety net, not the source of truth, so keep the calendar reminder too.
5. Document how to rotate it here.

## If a credential is exposed

1. Revoke it at the source straight away (Azure portal, Marketplace publisher page, GitHub settings).
2. Rotate it as documented above.
3. Check the Actions run history for the period between exposure and revocation for runs you do not recognize.
4. If user data could be affected, follow the [security policy](../SECURITY.md) and tell users in the release notes.

## What this extension stores for users

User passwords, proxy API keys and session tokens are in VS Code SecretStorage on the user's machine. See [DATA_HANDLING.md](./DATA_HANDLING.md).

Ownership and succession: [MAINTAINERS.md](./MAINTAINERS.md).
