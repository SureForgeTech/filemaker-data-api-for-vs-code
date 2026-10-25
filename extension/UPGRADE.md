# Upgrade Guide

What to do, and what will look different, when you move from one version to the next. Each section lists only changes you can notice. For everything else, see the [Changelog](./CHANGELOG.md).

## Upgrading from 1.7.0 to 1.8.0

Your profiles, saved queries and settings carry over; there is no data migration. No command or setting was removed or renamed, and no setting default changed. FileMaker Cloud sign-in with a Claris ID is still **not supported**; Cloud is untested.

### Connection wizard: pick a CA certificate with Browse

The certificate section in the connection wizard has a **Browse** button that opens the system file picker, so you can choose a PEM, CRT or CER file instead of typing the path. The path you choose is still saved with the profile and is used by **Test Connection**.

### Sign-in failures now say what to do

FileMaker error 212 now explains both possible causes: a mistyped password, or a privilege set that is missing the `fmrest` extended privilege, and it names the path in FileMaker Pro. Errors 212 and 9 also carry a Troubleshooting link in the Details report; other FileMaker codes keep their existing message.

### New job and connection commands

**Cancel Job** is in the Command Palette, in the menu of a running job and in the jobs status menu, and job details offer **Copy failures**. **Test My Server** reads a record and checks the server, and **Diagnose Connection** checks the address, the network, the certificate and the Data API without signing in and copies a report.

## Upgrading from 1.6.0 to 1.7.0

Your profiles, saved queries and settings carry over; there is no data migration. No command or setting was removed or renamed, and no setting default changed. AI features remain off by default. Read these changes before importing an old export or sharing a connection report. FileMaker Cloud sign-in with a Claris ID is **not supported**; Cloud is untested.

### 1. Batch updates ask how to handle newer changes

Keep the exported `modId` (or reserved `__modId`) column unchanged. After confirming an update, choose **Check for newer changes (recommended)** or **Overwrite even if changed**. The first sends each row's exported version to FileMaker. A record changed since export is skipped with error **306**, appears in Jobs and **Copy failures**, and is not retried; other rows continue. The summary counts these skipped rows. Overwrite deliberately leaves out the version check and can replace someone else's newer work.

If no row has a version, a warning offers **Continue** or **Cancel**. Continuing cannot detect newer changes. If only some rows have versions, the prompt counts rows that cannot be checked. Export again to get versions, or review the unprotected rows yourself. A dry run sends no updates and shows version coverage, skipped columns and a sample of the values that would be sent. Duplicate record rows are skipped with a warning, and rows containing only skipped fields do not hide later changes. JSON record IDs and versions accept surrounding spaces; layout, script and field names still use every character exactly.

If a reply is lost and a retry gets 306, the extension reads the record again. It counts success only if the intended values already match. Different number formats are accepted only for fields known to be numbers. Text, dates and timestamps must match exactly, including spaces and leading zeros, apart from line endings; unknown field types use that exact comparison too. If it cannot confirm the result, the row says **Could not confirm: the first attempt may have succeeded**. Check the record before trying again.

### 2. Calculated, summary and container fields are read-only

When field details are available, the Record Editor disables calculation, summary and container fields, including repetitions, and leaves them out of Save and Create Record. Use **Upload to Container** for containers. Batch import skips these columns with warnings, and AI writes refuse them. Remove them from a file intended for import; related columns also are not a way to create related records. Global fields remain editable and say **Session-wide**. FileMaker still decides your account's field privileges. If field details cannot be read, the editor warns that it cannot identify read-only fields; check before saving. A failed Create Record field lookup shows an error; select another layout and then the intended layout again to retry.

### 3. Empty searches offer List records instead

An empty Query Builder form, `[]` or `[{}]` sends no find. Choose **List records instead** to list the current layout with the current page size, starting record and sort. Nothing is listed until you choose it. This needs a direct connection; a proxy connection asks you to enter criteria. Saved queries, batch exports, AI searches, generated clients and copied code still refuse empty searches. To find an empty field, use **is empty**, which supplies `=`.

### 4. CSV exports carry record versions and preserve text

The first two columns are `recordId` and `modId`. If those clash with layout fields, the record columns become `__recordId` and `__modId`, with more underscores if needed. Keep them first and together; do not edit their values. An older ambiguous file is refused: export again. Fields missing from the first record are included too. Imports and the Record Editor keep number-looking text, leading zeros and spaces instead of guessing its type. Number fields receive numbers only for safe decimal values; other entries stay text with a warning, so large numbers are not rounded. Empty CSV cells still leave a field unchanged. Duplicate column names are refused, and unsupported import formats explain which file to use.

**Excel-compatible CSV (UTF-8 BOM)** adds the encoding marker Excel needs. The formula-safety setting is unchanged and still defaults to on. Failed or cancelled exports leave an existing destination file alone. The final `__portalNote (export information)` column appears only when related rows are truncated; import ignores it. Keep it last or remove it. A CSV export does not contain complete related records when that note is present. The Record Viewer can **Load more** portal rows on a direct connection and retry a failed load; proxy portal paging and creating related rows remain unsupported.

### 5. Trusted fingerprints work with VS Code's default proxy setting

A trusted certificate fingerprint now works on a direct connection with every `http.proxySupport` value, including the default `override`. You no longer need to change that setting just to trust FileMaker Server's default certificate. The fingerprint is checked before credentials are sent; a changed certificate is refused even if a public authority trusts it. A trusted fingerprint takes priority over a CA file or the older Allow self-signed flag.

A pinned connection that needs an environment, VS Code or system/PAC proxy is refused with **PIN_THROUGH_PROXY**. Exclude the server from the proxy, or add it to `NO_PROXY` for an environment proxy if your network permits a direct connection. For a certificate with proper server names, you can instead forget the fingerprint and use the company CA file. CA-only profiles keep their existing certificate handling and proxy routing.

Older **Allow self-signed** profiles go direct unless an environment proxy applies. Behind that proxy their previous route remains, and VS Code may still replace their certificate handling. `http.proxySupport` does not disable an environment proxy. Failures that identify the proxy now say the proxy could not be reached and name the relevant settings. Advice to try `fallback` is limited to older certificate handling on that route, not CA-only failures. Prefer trusting a confirmed fingerprint or a public certificate to the older flag, which skips certificate checks when applied.

The wizard clears the trusted fingerprint when you change the server address, explains when a saved password can be kept, and offers **Save anyway** after a failed test. Certificate advice now distinguishes date problems, missing intermediates and Data API failures.

### 6. Test My Server and Diagnose Connection

**FileMaker: Test My Server** uses a separate temporary sign-in to read a record and check server behavior. Start with **Run read-only test**. Scratch-record writes and running a script need separate confirmation and the usual permissions. Use a disposable scratch layout for writes; if cleanup fails the report names the record to remove. The report omits passwords and record values, but review names and server details before sharing it.

**FileMaker: Diagnose Connection** checks a saved server or an address you type without saving it, signing in or changing trust. It checks the network, certificate and Data API, explains likely fixes, and shows the full fingerprint. **Copy Connection Diagnosis for Bug Report** offers to hide the server address, port and revealing certificate details. Network probes are direct; the Data API check uses the connection's settings. For proxy profiles this checks the FileMaker server, not the middleware's sign-in. Both commands need offline mode off. No new setting is needed.

One real server was exercised on **2026-10-21**, but its FileMaker Server version was not recorded. Its no-match find returned HTTP 200, code 401 and empty data. Other versions may answer differently; any status with code 401 is still treated as no matches. No version has a completed recorded smoke test. See [Compatibility](./docs/COMPATIBILITY.md).

### 7. Jobs and the Command Palette

**Cancel Job** and **Show Jobs** are always shown, even when power-user mode is off. Cancel stops new requests but waits for sent updates to finish; it does not undo changes. Jobs show changed, failed and untouched records separately and offer **Copy failures** with error codes. During this session the lists are complete. After restart recent jobs keep all counts and at most 1,000 entries per list, marked when shortened. Copy a full list before restarting if you need it. Cancelled exports say no file was written.

### 8. Safer edits, files and saved queries

- A NUL character (U+0000) can make FileMaker drop the text after it. Save and Create Record now ask you to remove it or cancel, naming repeating fields that would become empty. Batch import refuses the whole affected row; AI writes refuse the value. Other characters stay unchanged.
- Generated code asks before replacing unrelated files: **Overwrite**, **Skip existing**, or **Cancel**. The client chooser starts in the generated folder. AI context asks before adding its section to an existing file and refuses project document names such as README.md and CHANGELOG.md. Closing a confirmation cancels; duplicate Cancel buttons are gone.
- A workspace opened through a symbolic link works for generation. Linked output folders are refused before files or folders are created, and refusals are shown clearly. Generated types use actual field types and repetitions and avoid duplicate properties. Names remain exact.
- For source-checkout users, unedited FM Web pages from version 1.0.0 can be refreshed. Edited runtime files remain untouched. FM Web generation and preview are still absent from the Marketplace package; Layout Mode remains available.
- Deleting a saved query from **Manage** asks for confirmation. Invalid JSON or a file without a list of saved queries shows a clear import error and leaves existing queries alone. Failed query, comparison export and snapshot operations show handled errors.

### Smaller changes

- Panels and Layout Mode follow light, dark and high-contrast editor themes. Narrow query controls stay inside the panel, and new Layout Mode fields go below existing objects.
- Opening Edit Record by ID loads the record. Repeated clicks do not start duplicate requests, and failed queries or scripts clear stale results. Repeated field choices and counts are shown once, with notes in the editor and Layout Inspector.
- Long script parameters use a stored text field for the necessary find. An empty layout, no match or missing script status cannot claim a successful script run. Generated clients explain empty searches and server errors; timeout and paging messages give clearer next steps.
- Cancelling one request does not cancel another request's sign-in. Renewed sessions resume requests while closing the previous session in the background.
- Errors hide more passwords, API keys and tokens. Malformed AI hidden-field settings are reported consistently; which fields are hidden has not changed. A new [support page](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/SUPPORT.md) explains how to ask for help safely.

### Rolling back

Use **Install Specific Version...** in the Extensions view to return to 1.6.0, or install its VSIX if you kept it (only tagged versions have a GitHub release). Profiles and saved data need no migration. Keep an untouched copy of exports before editing them. Version 1.6.0 does not protect batch updates with exported versions and may need the old certificate setting workaround. Installing it does not undo record changes already sent to FileMaker.

## Upgrading from 1.5.0 to 1.6.0

This is a minor release. Your profiles, saved queries, settings and stored data carry over unchanged, and no command or setting was removed or renamed. Nothing needs to be done for a normal install. These are the behavior changes you may notice.

### 1. Fields look the same everywhere, and Layout Mode can tidy a layout

The find form, Record Editor, Record Viewer and the generated web layout views now use the same field sizes, top labels and responsive spacing as Layout Mode. Your data and layouts are not changed, but these screens will look different from 1.5.0.

Layout Mode adds standard field sizes and spacing, an action that arranges the selected objects into a standard form, an action that standardizes them, and starter templates (blank, form, two-column, first portal; the templates are offered for a new, empty web layout). Arranging and standardizing each undo in one step. Nothing is rearranged until you choose an action; field names and behavior bindings stay as they are. Layout Mode now lists fields in FileMaker's field order instead of alphabetically.

**Apps you generated before:** the next time you run **Generate FM Web Next.js App** or **Start FM Web Preview Server**, the extension refreshes the managed runtime files in an app you generated earlier (template version 2 becomes 3: `page.tsx`, `bridge-client.ts`, `runtime-data.ts`, `runtime-behavior.ts` and `runtime-layout-client.tsx`). A managed file you edited is not overwritten: a warning names it, and you delete that file and run the command again to get a fresh copy; until then the preview cannot reach the bridge.

### 2. Trusting a certificate can need one VS Code setting

If you trust a server's certificate by its fingerprint (for example FileMaker Server's default certificate), the extension checks that one certificate itself. VS Code's **http.proxySupport** setting at its default, `override`, replaces the extension's own connection for servers that are not on your computer, so the trust cannot take effect and the normal certificate check applies instead. Before this release that ended in a misleading "not trusted" message right after you trusted the certificate.

- The trust dialog and the wizard now say this and name the setting, and the message after trusting offers to open it. Set **http.proxySupport** to `fallback`, or install a certificate from a public authority on the server and choose **Forget trusted certificate**.
- A server whose certificate VS Code already trusts (for example one from Let's Encrypt) keeps working, with or without an old trusted certificate on the profile.
- While the setting is `override`, a trusted certificate is not enforced: a different certificate that VS Code trusts would be accepted too.
- Profiles that connect to the same computer (`localhost`) are not affected.

In 1.7.0 this setting change is no longer needed for direct connections; see the 1.7.0 notes above.

### Smaller changes

- A script, layout or container field named `.` or `..` is refused before anything is sent, also in proxy mode.
- Copied TypeScript keeps a field named `__proto__`; copied proxy requests keep a trailing slash; copied API base paths stay as configured; curl output switches off bracket and brace expansion when needed.
- New files written by Write AI Context and new FM Web runtime files are readable by you only; a file that is replaced keeps its permissions.
- The Record Viewer also asks the server for the layout's field details at the same time as the record (when schema metadata is on); it is not added to the request history and a failure is ignored.
- The Output panel and **Show Effective Settings** warn when `ai.hiddenFields` is a string instead of a list.
- A profile changed in another VS Code window refreshes the connection status, the explorer and the AI tools within two seconds.

### Rolling back

Install the previous version from the Extensions view (**Install Specific Version...**) or from a [release](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/releases) (only tagged versions have one). Your data is not migrated, so nothing needs to be undone.

## Upgrading from 1.4.0 to 1.5.0

This is a minor release. Your profiles, saved queries, settings and stored data carry over unchanged, and no command or setting was removed or renamed. Nothing needs to be done for a normal install. These are the behavior changes you may notice.

### 1. Scripts run with a single request, and return only the script's answer

The extension now runs a script the way the Claris Data API Guide documents it: one `GET .../layouts/<layout>/script/<script>?script.param=<text>`. Before, it sent a `POST` that the Data API does not accept and then fell back to a find with the script attached, so every script run also read a record.

- A script run now reads no record. The result you get back is the script's result and error code only. If something you built (a Layout Mode `runScript` behavior, a plugin, an AI tool call) relied on the record data that used to come back with a script run, fetch the record with a find instead.
- A script parameter is sent percent-encoded exactly (a space is `%20`, never `+`). A parameter too long for a web address (about 2,000 characters) is sent in the body of a find limited to one record, which is the guide's other documented form. With a record ID and a parameter that long you get a clear error instead.
- A script or layout named `.` or `..` is refused with a message before anything is sent.
- **Copy as curl / fetch** in the Script Runner shows the same `GET` request.

### 2. Names are no longer trimmed

Layout, script and field names are now used exactly as the server lists them or as you typed them. A name with a leading or trailing space (for example ` Sales`) used to be turned into `Sales`, which could not be opened or, worse, pointed at a different layout. Layouts that differ only in spacing or case are now separate entries. Action: if you have a saved query, a generated type file or a snippet that was created for a layout whose name begins or ends with a space, check it still points where you expect. Names without such spaces are not affected.

### 3. `@filemaker` in the Chat view (new, off until you switch AI tools on)

VS Code's Chat view now lists a read-only `@filemaker` participant (`/layouts`, `/describe`, `/find`, `/explain`, `/help`). It reads the database only through the AI tools, so it does nothing until you turn those on (`filemaker.ai.enabled` and a connection chosen with **Set AI Access for Connection**; both are off by default), and it follows every AI setting, approval, limit, hidden-field rule and the kill switch. It has no command that changes a record or runs a script, even if you allowed writes and scripts for agent mode. In an untrusted workspace (Restricted Mode) it is listed but answers every request with "AI tools are not available right now" and reads nothing. It sends the language model only layout and field names and your own words, never record values or connection details. There is no new setting. See [Chat with @filemaker](./docs/USER_GUIDE.md#chat-with-filemaker).

### 4. Copy a request as code

**Copy request** in the Query Builder and Script Runner now offers curl, `fetch()`, a `.http` file (for the REST Client extension), a Postman collection and TypeScript, and the Record Viewer and Record Editor have **Copy request for this record**. A new command, **FileMaker: Copy Request as Code…**, copies a request for the active connection. Your password, session token and API key are never copied. The existing setting `filemaker.snippets.includeAuthByDefault` (default off) now covers all of these: with it on, copied requests show an `Authorization` header with a variable to fill in (for example `$FM_TOKEN`) instead of `<REDACTED>`. See [Copy a request as code](./docs/USER_GUIDE.md#copy-a-request-as-code).

### Smaller changes

- **Panels fit narrow editors.** Long layout names are clipped (full name in the tooltip) instead of widening the page; the Query Builder, Diagnostics and Layout Mode work from 360 px wide.
- **Record Editor and Record Viewer.** The editor says when fields are not shown because your account cannot access them, and names fields the record has no value for. The viewer loads the record it was opened for, or shows a hint when opened without one.
- **Connection wizard** shows a notice when the workspace is in Restricted Mode, with a **Manage Workspace Trust** button.
- **Refresh Schema Cache** also clears the layout list, so the next refresh reads layouts from the server again.
- A connection that drops while a reply is still arriving is reported as incomplete, not as a success.
- **Windows and Linux.** Updating a file marked read-only (Write AI Context, the FM Web runtime) works on Windows; the MCP shim waits longer for PowerShell; folder paths from MCP clients match regardless of letter case on Windows.
- Logs and diagnostics hide more secrets (single-quoted keys; `Cookie`, `Set-Cookie`, `Authorization` and `Proxy-Authorization` lines), and configured file paths now reject characters that render as blank.
- A badly formed `filemaker.ai.hiddenFields` value no longer switches hiding off: the valid names still hide.

### Rolling back

Install the previous version from the Extensions view (**Install Specific Version...**) or from a [release](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/releases) (only tagged versions have one). Your data is not migrated, so nothing needs to be undone.

## Upgrading from 1.3.0 to 1.4.0

This is a minor release. Your profiles, saved queries, settings and stored data carry over unchanged, and no command or setting was removed. Nothing needs to be done for a normal install. These are the behavior changes you may notice, and what to do about each.

### 1. A repository file can no longer grant a role or switch protections off

A workspace `.vscode/settings.json` or `.vscode/filemaker.config.json` can make the extension stricter. It can no longer loosen anything you set in your own user settings:

| Setting or file | A workspace can still | A workspace can no longer |
| --- | --- | --- |
| `filemaker.enterprise.mode`, `enterpriseMode` in `filemaker.config.json` | turn enterprise mode on | turn it off |
| `filemaker.enterprise.role`, `role` in `filemaker.config.json` | lower the role | raise it above your own user setting (default `developer`) |
| `filemaker.offline.mode` | turn offline mode on | turn it off |
| `filemaker.features.*.enabled` | turn a feature off | turn a feature on |

Action: if you relied on a repository file to grant `admin`, to switch enterprise mode off or to switch a feature back on, set it in your **user** settings instead. `filemaker.secrets.fallback` and `filemaker.export.neutralizeFormulas` are read from user settings only too, and several settings are ignored in an untrusted workspace (see the settings reference).

**Toggle Offline Mode** now changes your user setting and reports the mode that is really in effect. A workspace `offline.mode: true` written by an older version stays on and the command says so; edit that workspace setting yourself.

### 2. Generated file names with spaces or punctuation have a hash suffix

A layout whose name has anything besides letters, digits, `_`, `.` and `-` now gets `<safe name>-<8 characters>.ts` under `<typegen output>/layouts/`. Layouts that used to collide on one file now get separate files. Action: regenerate, update imports, and delete the old generated files. Names are also escaped inside the generated code. Layout names containing `..` (for example `Q1..Q2`) work in snapshots and the offline cache.

### 3. CSV and Copy as table apostrophes

CSV exports (batch export and Query Builder) and **Copy results as table** put a leading apostrophe in front of text that starts with `=`, `+`, `-`, `@`, a tab or a carriage return, for example `'=SUM(A1)`. Plain numbers and phone numbers are not changed. Action: if another program reads these files, strip a leading apostrophe there, or set `filemaker.export.neutralizeFormulas` to `false` in your user settings (JSON Lines exports never had it). Batch update skips the `recordId` and `modId` columns, so a CSV export of a layout with plain fields can be edited and imported back. Exports also contain related (`Table::Field`), calculation, summary and container columns, and import sends every column back: delete those columns before importing, and do not expect an export to restore old values for layouts that have them.

### 4. New prompts

You will now be asked before:

- running a **workspace plugin** (`.vscode/filemaker-plugins/`). The whole folder is hashed and the approval is remembered per workspace and content, so plugins you already use ask once. A folder with more than 500 files, more than 20 MB or a symbolic link is refused.
- **Start FM Web Preview Server** runs `npm install` and `npm run dev`.
- a Layout Mode **`runScript`** behavior runs a script.
- the connection wizard saves or tests credentials against an **address that came from `.filemaker/profile-template.json`**, or sends them to a remote **`http://`** address.
- you change a saved profile's **server address, proxy address or user name**: type the password (or API key) again. **Test Connection** uses a throwaway session and never touches the saved secrets.
- switching AI tools back on, and every AI write.

### 5. AI features are off by default

New commands (**Write AI Context**, **Set AI Access for Connection**, **Show AI Activity**, **Start New AI Session**, **Switch AI Tools Off or On**, **Start/Stop AI Server for External Tools**, **Copy MCP Config for Claude Code / Cursor**) and `filemaker.ai.*` settings. Profiles gain an optional `aiAccess` (`none` by default), which resets to none if you change the profile's server, user, database or API paths. Nothing is read by an AI tool until you set `filemaker.ai.enabled` in your user settings and choose a connection. A status bar item `AI: off` is shown on the right; selecting it explains why AI is unavailable, or asks before switching tools back on if you used the kill switch. Older extension versions drop the unknown `ai` entry from `disabledFeatures`; use `filemaker.features.ai.enabled` in the same files if a team still has older versions.

### 6. Create Record works; Delete Record needs the record-edit switches

The Record Editor's create mode lists the layout's fields, has a **Create Record** button and a confirmation, and shows the new record's ID. Editing, creating, deleting and uploading, and the Script Runner, now need a trusted workspace. **Delete Record** now also respects `filemaker.features.recordEdit.enabled` and the enterprise record-edit restriction, like saving does. Saving a record whose version changed since you loaded it is refused (error 306) and your edits stay in the form.

### 7. The FM Web live preview is not in the Marketplace build

The Marketplace package does not include the preview app template, so **Start FM Web Preview Server** and **Generate FM Web Next.js App** are hidden from the Command Palette (invoked another way they say "not available in this installation") and need the repository. Layout Mode and metadata sync are unchanged. For repository users the preview now sends its bridge token, and previously generated apps get their managed files refreshed (an edited copy is left alone with a warning).

### 8. Other behavior to know about

- A server address with a user name or password in it (`https://user:pass@host`) is rejected. A saved profile that has one stays in the list so you can fix it.
- `.filemaker/profile-template.json` is ignored in an untrusted workspace and no longer locks the server address (only the database and API paths).
- `filemaker.typegen.outputDir` is ignored in untrusted workspaces and rejects drive-relative paths such as `D:folder`.
- For repository users of the FM Web preview, the bridge enforces your limits: record changes and script runs follow offline mode, the record-edit and script-runner switches, and the enterprise role.
- A Layout Mode `runScript` behavior needs a trusted workspace, the script runner on, offline mode off and a policy that allows scripts, and it asks for confirmation naming the script, parameter and connection.
- Enterprise `disabledFeatures` and role handling are restrict-only (see section 1).

### Smaller changes

- A find that matches nothing returns an empty result instead of an error.
- Parallel requests share one session renewal.
- Logs and error details hide more secrets.
- **Certificates.** The wizard shows a server's certificate (subject, issuer, names, dates, SHA-256) and, if you agree, trusts exactly that certificate for the connection (a pinned fingerprint stored in the profile, never from a workspace file). A different certificate later fails with **Review and re-trust**; an expired pinned certificate is refused unless you accepted that in the dialog; a pinned connection is never made through an HTTP proxy (exclude the server from the environment, VS Code or system proxy). A custom CA file under **Certificates (advanced)** is added to your computer's certificates. FileMaker Server's default certificate has no host names, so it needs the trust dialog, not a CA file. A pin is trust on first use of one fingerprint: compare it with your administrator's before you trust it; it detects a later change but does not prove who presented the certificate the first time. No released version had an "Allow self-signed certificate" checkbox, so nothing to migrate from 1.3.0; profiles that already carry the older hand-edited `allowSelfSigned` keep working with a persistent warning and an offer to convert. Pins work on direct routes with all four `http.proxySupport` values, including `override`, and refuse a required proxy with `PIN_THROUGH_PROXY`. CA-only profiles retain their previous certificate handling and proxy routing. The older `allowSelfSigned` goes direct when no environment proxy applies and skips every check when its agent is used; behind an environment proxy its previous CONNECT route and possible host-agent replacement are unchanged. A trusted fingerprint takes priority over both a CA file and the older flag.
- **Passwords and sign-in.** After FileMaker rejects the saved account or password (error 210 to 214, or 1703) the extension no longer signs in again by itself; edit the connection, or run **Connect** or **Test Connection**, to resume. With no free Data API sessions (956) automatic sign-ins back off from 30 seconds to 5 minutes. A rejected sign-in on a FileMaker Cloud host says Cloud uses a Claris ID, which the extension does not support (whether a tenant also accepts an account name and password is not confirmed).
- **Clearer errors.** Connection failures say what happened and what to do; a reply that is not Data API JSON gets its own message; redirects are not followed; "no records" is recognised by FileMaker code 401 (verified as HTTP 200 with empty data on a real FileMaker Data API Engine, 2026-10-21; older/other versions may use another status, so any status with code 401 stays accepted); a script error returned with a saved, created or deleted record is shown next to the success.
- **Test Connection** is a ladder (Data API and certificate, database list, sign-in) and the status bar shows the real state of the last request.
- **Batch update** carries on past records your account cannot change (error 200) and stops only when the account cannot update at all (9, 205, 207 or rejected credentials).
- **Settings:** every setting description starts with one of three badges, and **FileMaker: Show Effective Settings** shows the value in effect and why a workspace value is ignored. Nothing was renamed and no enforcement changed.
- **About / Show Version** shows the version and build, with **Copy for bug report**.
- Virtual workspaces (such as github.dev) are not supported.
- Release builds ship minified code without source maps (they are attached to each GitHub release), and `THIRD_PARTY_NOTICES.txt` is included.

### Rolling back

Install the previous version from the Extensions view (**Install Specific Version...**) or from a [release](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/releases) (only tagged versions have one). Your data is not migrated, so nothing needs to be undone, except the renamed generated files (regenerate them) and the `aiAccess` field (older versions ignore it).

## v1.2.0 to v1.3.0

- The unused `filemaker.telemetry.enabled` setting was removed. The extension has never collected telemetry. Delete the setting from your settings files; it did nothing.
- Published under the **SureForgeTech** publisher: the extension ID is `SureForgeTech.filemaker-data-api-tools`. If you install from the command line or list it in `.vscode/extensions.json`, use that ID.
- Webview Content Security Policy nonces use the operating system's random number generator.

## v1.1.0 to v1.2.0

- Settings were grouped. Old `filemakerDataApiTools.*` names (`logLevel`, `requestTimeoutMs`, `defaultApiBasePath`, `defaultApiVersionPath`) still work but are deprecated in favor of `filemaker.logging.level`, `filemaker.requestTimeoutMs`, `filemaker.defaultApiBasePath` and `filemaker.defaultApiVersionPath`. A more specific value wins whichever name it uses. A one-click migration is offered. A hand-edited non-string value for a path setting falls back to the default.
- **Export Connection Profiles** and **Import Connection Profiles** were removed. They never worked. Share a [profile template](./docs/USER_GUIDE.md#profile-templates-for-a-team) and saved queries instead.
- Query Builder paging uses FileMaker's 1-based offsets: **Start at record** 1 is the first record.
- Commands moved to a `FileMaker` category with clearer titles, so search for the new title in the Command Palette.

## v1.0.0 to v1.1.0

- The connection wizard replaces the old quick-pick flow. Existing profiles work without change.
- Many commands are hidden from the Command Palette until they apply (a profile exists, a snapshot exists, enterprise mode or `filemaker.advanced.powerUserMode` is on). Nothing was removed.
- Legacy `filemakerDataApiTools.*` settings were deprecated in favor of `filemaker.*`.
- A first-run walkthrough opens once.

## v0.9.0 to v1.0.0

Production release. No breaking changes.

## Older versions

For 0.x, see the [Changelog](./CHANGELOG.md).
