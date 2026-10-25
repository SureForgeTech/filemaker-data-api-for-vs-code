# Changelog

This file is the operator-facing release ledger. Every pull request adds one
line under `## Unreleased` with one of the allowed section labels, or
applies the `changelog-skip` label for a purely no-impact change. See EAS
§B2 Universal PR Essentials.

Allowed entry labels:

- `[BREAKING]` - incompatible API, data, deployment, or operator change.
- `[FEATURE]` - new user-visible or operator-visible capability.
- `[FIX]` - bug fix or compatibility repair.
- `[INTERNAL]` - tests, CI, docs, refactors, generated artifacts, or process.
- `[SECURITY]` - vulnerability fix, security control, or hardening change.

PR title prefix matches the highest-tier label added:
`[BREAKING]` -> `[major]`, `[FEATURE]` -> `[minor]`, others -> `[patch]`.

## Unreleased

### [BREAKING]

- None.

### [FEATURE]

- None.

### [FIX]

- None.

### [INTERNAL]

- None.

### [SECURITY]

- None.

## 1.8.0 (2026-10-25)

### [BREAKING]

- None.

### [FEATURE]

- The Connection wizard's certificate section has a Browse button that opens the system file picker for a custom CA bundle (PEM, CRT or CER), instead of typing the path by hand.

### [FIX]

- The Record Editor shows fields in the same order as your layout, with the right kind of box for each field. The Viewer, find form and FM Web use the same field rules, and Copy no longer covers record values. A container shows its image and, when that image cannot be shown, its address. A repeated field now appears in FM Web. A required repeated field no longer stops a save, and a repeated column in a portal shows its value.
- Website tables scroll on small screens, documentation links stay on the website, and repeated documentation links are removed.
- Generated FM Web apps can run their own tests and refresh untouched older shared files. Missing field details, stopped previews and save errors have clearer messages; date hints appear while editing and saved messages clear when browsing.
- Layout Mode buttons keep their text readable when pointed at or selected with the keyboard. Effective Settings lines up with other screens and keeps its settings buttons on one line. Disclosure controls and separate tabs use the same size and rounded corners as other controls.
- The generated FM Web page opens again, no longer stretches sideways, and can edit and save records.
- All screens now share the same fonts, buttons, messages and read-only look.
- Read-only values stay easy to read, empty messages remain available to screen readers, and headings, panels and control sizes match across screens. Schema Diff opens with **Show only changes** ticked; clear it to see unchanged fields.
- Panels no longer sit empty when the extension cannot finish a request. The Record Viewer, Record Editor, Query Builder, Script Runner, Connection Wizard, Layout Mode and Schema Diff now say what went wrong instead of waiting forever, and the reason is written to the output channel.
- Sign-in errors now say what to do: FileMaker error 212 explains both possible causes — a mistyped password or a privilege set missing the `fmrest` extended privilege, with the exact FileMaker Pro path — and the error report now shows the matching Troubleshooting link for errors 212 and 9. Other FileMaker codes keep their existing message.

### [INTERNAL]

- The user guide, upgrade notes and a changelog by version are now on the project's website.
- The monthly secret rotation reminder now reads the rotation calendar in docs/SECRETS.md and files a reminder issue about 30 days before a tracked credential is due; a manual dry run prints what it would file. A row that cannot be read, or a name that appears twice in the calendar, is reported and fails the run instead of silently hiding a rotation.
- The shared package, the Layout Mode app and the FM Web preview template now take part in the repository's lint and coverage gates, so a change in any of them is checked like the extension's own code. The repository's own lint tooling stays in the repository: a generated FM Web app runs its own tests and does not lint itself. An app you generated earlier is recognised as a version this repository shipped, so the new test settings reach it instead of a warning about a file you did not touch. The README and docs/CI.md say how the workspaces are checked.
- The Marketplace listing description and the README lead now open with one sentence: connect to any FileMaker Data API server, run queries, browse schema, edit records and export results without leaving VS Code.
- The Marketplace listing README now shows the version, last-commit and MIT-license badges under its title.

### [SECURITY]

- Security: the web page generator now uses Next.js 16.4.2, which fixes three published problems in Next.js (an image-handling flaw and a flaw in the `use cache` feature that could each run code, and a denial-of-service flaw). The extension itself did not use the affected parts, but apps you generated earlier keep their old version: run `npm install next@16.4.2` in `.fmweb/generated/runtime-next` to update them.
- Security: `zod` is updated to 4.6.7, which fixes a published security advisory in zod 4.6.5 (the version 1.7.0 shipped): validating a very large array without a length limit could use all available memory. No behavior change.

## 1.7.0 (2026-10-22)

Minor release: no data migration, and no command or setting was removed. User-facing notes: `extension/CHANGELOG.md` and `extension/UPGRADE.md`. Entries for 1.6.0 were removed from this ledger; user-facing notes remain in `extension/CHANGELOG.md` under 1.6.0, and the full ledger is in git history through 5bd5dc8.

### [BREAKING]

- None.

### [FEATURE]

- Add Cancel Job in the Command Palette, running job menu and jobs status menu, with Copy failures in job details.

- Add Diagnose Connection: check the server address, network, certificate and Data API without signing in, explain likely fixes, and copy a report with the address hidden if wanted.
- Add FileMaker: Test My Server to check a connection safely and make a report without passwords, with separately confirmed scratch-record and script tests.

### [FIX]

- Offer **List records instead** for an empty Query Builder search, using the selected layout, page size, starting record and sort only after you choose it.
- Show a clear error when a saved queries file is not valid JSON or does not contain a list of saved queries; leave existing queries alone.
- Keep **Cancel Job** and **Show Jobs** available in the Command Palette with power-user mode switched off.

- Confirm uncertain batch writes using number formats only for number fields; keep text exact apart from line endings. Keep layout and script names exact in preview requests. Correct the Create Record field-loading guidance and avoid doubled punctuation in its defensive error message.

- Let Create Record recover from a failed field lookup; keep later real edits after skipped-only rows, ignore spaces around JSON record IDs and versions, and recognize matching retry results despite number, space or line-ending differences. Cancelling stops further record checks.
- Handle repeating read-only fields in imports, Record Editor saves and AI writes; check uncertain batch retries, skip duplicate record rows, and keep skipped values out of dry-run previews.
- Protect batch updates with the exported record version, skip records changed since export, and ask before overwriting newer changes or using files without versions. Dry runs report how many rows can be checked.
- Keep calculation, summary and container fields read-only in the Record Editor, explain global fields, and skip calculation and summary import columns with clear warnings.
- Clarify in the package description and getting-started pages that FileMaker Server is supported and FileMaker Cloud sign-in with a Claris ID is not supported yet.
- Allow generated files in a workspace opened through a symbolic link, refuse linked output folders before creating files, and show generation refusals clearly.
- Let requests continue as soon as a renewed session is ready, while closing the previous session in the background.
- Use stored text fields for long script parameters and distinguish empty text from an empty layout, with clearer messages when a script did not run.
- Keep all batch counts in recent jobs while limiting each saved record list to 1,000 entries; full lists remain available during the session. Cancelled exports say no file was written.
- Keep portal counts with the correct record and allow retrying Load more after an error.
- Give certificate date advice that matches the failure and put Data API failures before advice about older certificate settings.
- Name repeating fields that become empty after removing NUL characters.

- Ask before replacing unrelated generated files, start the client chooser in a generated folder, and protect AI context and FM Web page output.
- Show successful and failed batch rows separately, retain failure codes and partial results, and list each job once.
- Clear trusted certificates when the wizard address changes, offer a visible Save anyway choice, and show when a saved password can be kept.
- Clear old query and script results after failures and prevent repeated clicks from starting duplicate requests or dialogs.
- Keep narrow Query Builder controls inside the panel, remove repeated server facts and AI field names, and report missing portal rows honestly.
- Place added Layout Mode fields below existing objects and load the record automatically when Edit Record by ID supplies an ID. Correct the guide to say container URLs are shown as text.

- Diagnose Connection now shows the full matching certificate fingerprint, explains older certificate settings and missing intermediates, and gives advice that matches the current proxy handling. Server path prefixes work, report lines are easier to read, and hiding the address also hides the port.

- Long script parameters use a wildcard find on the first text field instead of an empty find. No-match finds and responses without a script status cannot report a successful script run.
- Test My Server now reads a record without an empty search, and empty searches show clear next steps. Cancelled batch updates wait for pending edits and keep a list of changed, failed and untouched records. Cancelling one request no longer cancels another request's sign-in, and renewed connections close their old sessions.
- Preserve text and record IDs when moving data through CSV and the Record Editor; show incomplete portal rows with Load more, keep existing exports safe on failure or cancellation, and offer CSV for Excel.

- Generated types now use the real field type and repeating field names. Generated clients handle empty finds and explain server errors. Special names stay intact; timeouts, paging and error messages give clearer next steps.

- Trusted certificates (trusted by fingerprint) and older allow-self-signed profiles now work without changing a VS Code setting, so a server with FileMaker's default certificate can be trusted and used. A changed trusted certificate is refused before any credentials are sent; a trusted-fingerprint connection that would need a proxy is refused with advice. Custom CA file profiles are unchanged: they keep going through a proxy as before. An older allow-self-signed profile goes direct unless an environment proxy applies; that route is unchanged.
- Warn before NUL characters can lose text in record edits and creation, refuse affected batch rows and AI writes, and generate valid types when a layout lists a field twice. Record the real-server findings and the remaining gap for creating portal rows.
- Require the same confirmation before deleting saved queries from Manage, and show handled errors when saved-query commands, comparison report exports or snapshot lookups fail.

- Webviews and Layout Mode controls now follow light, dark and high-contrast editor themes, with readable fields, messages and schema differences.
- Refresh unedited FM Web pages generated by version 1.0.0, while keeping edited files and symbolic links untouched.
- Report malformed AI hidden-field settings consistently in AI tools, Write AI Context and the AI status bar, without changing which fields are hidden.

### [INTERNAL]

- Maintenance: remove duplicate Cancel buttons from generated-file, NUL-character and AI-context dialogs; closing a dialog leaves files and records alone.
- Maintenance: identify an unreachable proxy in connection errors and clarify how older self-signed connections use environment proxies.
- Maintenance: include the CSV portal note column only when related rows are missing, count repeated fields once in Test My Server, and name repeated fields in Layout Inspector.
- Maintenance: show the request options used by public client methods in the API reference.

- Split the connection wizard into smaller host-side parts for easier maintenance, keeping its screens, checks and messages the same.
- Split AI tool code into smaller parts, keeping the same approvals, safety checks and results; test spaces around preview record IDs and exact layout and script names.
- Maintenance: split the Query Builder host code into smaller parts, check that rejected sessions stop after one retry and uploads keep the record version, and keep connection helpers out of the API pages.

- Maintenance/quality: add behavior tests for the largest coverage gaps and raise the minimum test coverage.
- Maintenance: split the FileMaker connection code into smaller parts, keeping the same requests and messages.

- Extract AI approval text and server-address scrubbing into pure helpers, with tests that preserve the existing text and results.
- Speed up theme guard tests by reusing stylesheet parsing, color measurements and the audit document, reducing Windows timeout risk without changing color checks.
- Test the external AI bridge directly without changing its protocol, and make MCP tests wait for events instead of fixed delays.
- Test saved-query, batch, schema snapshot, type generation, enterprise and activation flows without opening VS Code, and record existing gaps in confirmations and error handling.

- Share name validation, HTML escaping and the copied-request auth default reader, keeping existing messages, output and setting scopes.
- Refresh non-certificate failure-mode documentation against current code, check its file references, and clarify the upgrade guide’s AI switch behavior. Keep webview asset tests out of the build folder, and test Record Viewer failures, stale loads and its older fallback layout.
- Run designer and runtime tests in CI, lint browser scripts, check mock API compatibility and packaged bundles, and tighten the VSIX size and coverage budgets. Cancel superseded pull request runs, share the verified GitHub CLI setup, and remove an obsolete dependency ignore.
- Make command-context tests wait for completion, test process lookups without repeatedly starting PowerShell, and keep one real-process check with a longer timeout. Remove unused designer test tooling, align the zod version range, explain the TypeScript test alias, and add a complete command reference with a coverage check.
- Remove unused snippet and helper code, keep documented utilities and command handlers, and check for unused locals and parameters during typecheck.
- Add a support page with help channels and safe bug-report guidance, remove the unused `shx` development dependency (build and package scripts already use Node), and align workspace `@types/node` declarations with the supported Node 22 runtime.

### [SECURITY]

- Hide plain-text API keys and FileMaker access-token headers in error messages.

- Harden error messages by masking credentials and tokens before they reach notifications or other normalized-message displays; normal FileMaker messages stay unchanged. No known exploit.

- Updated `follow-redirects` (inside `axios`) from 1.16.0 to 1.16.1 for two advisories about credential headers surviving a redirect; the extension refuses every redirect (`maxRedirects: 0`), so the fixed paths were not reachable, and the production audit is clean again.
