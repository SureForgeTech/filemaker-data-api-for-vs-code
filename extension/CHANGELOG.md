# Changelog

## Unreleased

- [INTERNAL] The unit tests no longer pass an IP address as a TLS server name, which Node 22 warns about and Node 26 rejects.
- [INTERNAL] The real VS Code proxy-patch TLS test now skips, with the reason logged, when a plain TCP connection to this machine's own LAN address cannot be opened. Once TCP connects, every certificate, pin and sign-in failure still fails the test.
- [SECURITY] Schema snapshots and the offline metadata cache refuse to read, write or delete through a symlink under `.vscode/filemaker`, so a cloned repository cannot point them at files outside the workspace.
- A failure to save the optional offline schema cache no longer fails a layout schema that the server returned; it is logged as a warning instead.
- Script parameters sent through the FM Web bridge keep their spaces, line breaks and empty value exactly as written.
- Log lines that include an error now show the error's name, message and code instead of an empty `{}`, with secrets still hidden.
- A layout named `FileMaker` no longer produces a generated TypeScript client with two `FileMakerRecord` types. Layout names that differ only by letter case, such as `Sales` and `sales`, now get separate generated type files, each named with a short hash, so the files no longer swap places when the server lists layouts in a different order. This applies to Generate Types for Layout as well as Generate Types for All Layouts: a single layout is named from the server's layout list when it can be read, and from the files already in the folder when it cannot, so a cached layout still generates. In offline mode the layout list is never requested at all, so there is no sign-in attempt or wait before the cached layout generates. A generated file that belongs to a different layout is never replaced, and a layout keeps updating the file it already owns, including a numbered one (such as `Sales-1a2b3c4d-1.ts`) given out by an earlier run, even when numbers in between are missing. Newly generated files carry a `Layout SHA-256` line that identifies the layout without printing its name; older files are only recognised when their `Layout:` line shows the name unambiguously, and any other generated file is left untouched. Delete any old `Sales.ts`-style file left by an earlier build.
- A restored Query Builder tab now uses the current extension folder and script settings instead of the ones saved before the window reload.
- The Query Builder keeps the previous results available to export when a later search is canceled.
- FM Web displays, validates and saves a repeated field under its lowest available repetition key when `Name(1)` is absent.
- [SECURITY] Open Generated Types Folder refuses output paths that pass through a symlink outside the workspace.
- The Query Builder can cancel a search while it is still loading its connection profile, and closing the panel stops that search.
- The Query Builder now restores the page size and offset after a window reload for the same connection and layout; host saved-query values take precedence.

- Canceling Browse for a CA certificate keeps the previously selected file path.
- Saved connection secrets are decrypted with a fixed 16-byte tag check, so a shortened or tampered tag is refused instead of being misread. Secrets saved earlier keep working. No known exploit.
- The extension's panels now ignore messages that do not come from VS Code itself, so a stray or badly formed message is dropped before it can act. No known exploit.
- Files written for generated pages, type generation and AI context now stay inside their folder: a path that tries to escape is refused instead of written. No known exploit.
- The Marketplace listing README now has a Security & Trust section right after the product tour: credentials stay in the OS keychain, nothing is collected or sent to the authors, an untrusted folder stays read only, and the security policy is one link away.
- A privacy policy at the repository root (PRIVACY.md) now says what the extension stores locally, what never leaves your machine, the proxy-mode exception, which third parties are reached, the GDPR/CCPA stance, and where to send privacy questions; the documentation table, the Marketplace listing and the User Guide all link to it.
- The Marketplace README now opens the product tour with a Query Builder hero screenshot of the Contacts layout: field pickers, a populated find request and the found rows.
- The Marketplace README now shows a GIF of the connection flow: add a connection profile, connect, and open the Query Builder.
- The Query Builder results table sizes its Open column to fit both actions, so View and Edit are both visible and clickable instead of clipping Edit to "View ...".
- The Query Builder remembers the selected connection, layout, find request, editor tab and result view, so reopening the panel after a window reload restores the work in progress instead of an empty form.
- The Query Builder clears restored criteria and sort rows when the layout they were written for is no longer among the profile's layouts, so a saved find is never shown or run against another layout.
- The Query Builder shows a Cancel button while a query is running; pressing it aborts the request in flight and the panel reports the query as cancelled.
- Error toasts can reconnect to the server in one click after a sign-in failure and open the matching troubleshooting page from the toast; more errors now carry that link, including no free sessions, too many sign-in attempts, HTTP 403/404, certificate problems and connection failures.
- Five commands gain default keyboard shortcuts: Open Query Builder `Ctrl+Alt+Q`, Open Record Viewer `Ctrl+Alt+V`, Open Script Runner `Ctrl+Alt+E`, Show Request History `Ctrl+Alt+H` and Open FM Web Layout Mode `Ctrl+Alt+L` (each `Cmd+Alt` on macOS except Show Request History, which stays `Ctrl+Alt+H` to avoid the system's Hide Others shortcut); rebind or clear them in Keyboard Shortcuts as before.

## 1.8.0

_Released 2026-10-25._

This release adds a **Browse** button for a custom CA certificate in the connection wizard, sign-in errors that explain both possible causes and link to the fix, and fields shown in your layout's order with one consistent look across every screen. Read [UPGRADE.md](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/UPGRADE.md), “Upgrading from 1.7.0 to 1.8.0”.

- The Marketplace listing description and the README lead now open with one sentence: connect to any FileMaker Data API server, run queries, browse schema, edit records and export results without leaving VS Code.
- Security: the web page generator now uses Next.js 16.4.2, which fixes three published problems in Next.js (an image-handling flaw and a flaw in the `use cache` feature that could each run code, and a denial-of-service flaw). The extension itself did not use the affected parts, but apps you generated earlier keep their old version: run `npm install next@16.4.2` in `.fmweb/generated/runtime-next` to update them.
- Security: `zod` is updated to 4.6.7, which fixes a published security advisory in zod 4.6.5 (the version 1.7.0 shipped): validating a very large array without a length limit could use all available memory. No behavior change.
- The Record Editor shows fields in the same order as your layout, with the right kind of box for each field. The Viewer, find form and FM Web use the same field rules, and Copy no longer covers record values. A container shows its image and, when that image cannot be shown, its address. A repeated field now appears in FM Web. A required repeated field no longer stops a save, and a repeated column in a portal shows its value.
- Website tables scroll on small screens, documentation links stay on the website, and repeated documentation links are removed.
- Generated FM Web apps can run their own tests and refresh untouched older shared files. Missing field details, stopped previews and save errors have clearer messages; date hints appear while editing and saved messages clear when browsing.
- Layout Mode buttons keep their text readable when pointed at or selected with the keyboard. Effective Settings lines up with other screens and keeps its settings buttons on one line. Disclosure controls and separate tabs use the same size and rounded corners as other controls.
- The generated FM Web page opens again, no longer stretches sideways, and can edit and save records.
- All screens now share the same fonts, buttons, messages and read-only look.
- Read-only values stay easy to read, empty messages remain available to screen readers, and headings, panels and control sizes match across screens. Schema Diff opens with **Show only changes** ticked; clear it to see unchanged fields.
- Panels no longer sit empty when the extension cannot finish a request. The Record Viewer, Record Editor, Query Builder, Script Runner, Connection Wizard, Layout Mode and Schema Diff now say what went wrong instead of waiting forever, and the reason is written to the output channel.
- The user guide, upgrade notes and a changelog by version are now on the project's website.
- Sign-in errors now say what to do: FileMaker error 212 explains both possible causes — a mistyped password or a privilege set missing the `fmrest` extended privilege, with the exact FileMaker Pro path — and the error report now shows the matching Troubleshooting link for errors 212 and 9. Other FileMaker codes keep their existing message.
- The Marketplace listing README now shows the version, last-commit and MIT-license badges under its title.
- The Connection wizard's certificate section has a Browse button that opens the system file picker for a custom CA bundle (PEM, CRT or CER), instead of typing the path by hand.

## 1.7.0

_Released 2026-10-22._

This release helps you avoid overwriting newer records, makes connection problems easier to understand, and keeps exported files and text safer. Your profiles, saved queries and settings carry over. Read [UPGRADE.md](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/UPGRADE.md), “Upgrading from 1.6.0 to 1.7.0”, before your next batch update.

- **Safer batch updates.** Keep the exported record version and choose **Check for newer changes (recommended)**. Records changed since export are left alone with error 306; other rows continue. You can choose **Overwrite even if changed**, or cancel. Files without versions get a warning. Dry runs show how many rows can be checked, and duplicate record rows are skipped.
- **Read-only fields are clear.** When field details are available, calculation, summary and container fields are read-only in the Record Editor, including repeating fields. Use Upload to Container for containers. Batch imports skip those columns with warnings; AI writes refuse them. Global fields stay editable with a session-wide note.
- **List records without a search.** An empty Query Builder search offers **List records instead**. It uses your layout, page size, starting record and sort only when you choose it, on a direct connection. Proxy users are asked to enter a search value.
- **Check your server.** **Test My Server** makes a report using a separate sign-in. It starts with read-only checks; scratch-record and script tests need separate confirmation. **Diagnose Connection** checks an address, network, certificate and Data API without signing in or saving a typed address, explains likely fixes, and can hide the server address when you copy its report.
- **Trust a certificate without changing VS Code's proxy setting.** A trusted fingerprint now works on direct connections under the default setting too. A changed certificate is refused before credentials are sent. A connection with a trusted fingerprint still cannot go through a proxy: the message explains how to use a direct route. Custom CA profiles keep their existing routing. Older Allow self-signed profiles go direct unless an environment proxy applies; proxy failures now name the proxy and relevant settings.
- **Safer exports and imports.** CSV exports keep record IDs and versions separate from similarly named layout fields, include fields missing from the first row, and offer CSV for Excel. Text that looks like a number and its spaces stay text. Export files are replaced only on success; failure or cancellation leaves an existing file alone. A portal note column appears only when related rows are missing. The Record Viewer can load more related rows on direct connections.
- **Keep track of jobs.** **Cancel Job** and **Show Jobs** are always in the Command Palette, even with power-user mode off. Cancellation waits for sent updates to finish and keeps changed, failed and untouched records. Job details offer **Copy failures**, including error codes. Full lists last for the session; after restart each saved list keeps up to 1,000 entries and all counts.
- **Editor themes.** Panels and Layout Mode controls follow light, dark and high-contrast themes, with more readable fields, messages and schema differences.

### Fixes

- Saving or creating text containing a NUL character now warns before FileMaker can drop the rest of the text; choose to remove the character or cancel. Batch rows and AI writes with it are refused. Repeating fields that would become empty are named.
- Create Record can recover from a failed field lookup; opening Edit Record by ID loads that record. Repeated clicks no longer start duplicate requests, and failed queries and scripts clear old results.
- Batch rows with only skipped fields no longer hide later edits. After a lost update reply, a retry checks the record before claiming success; number formats are compared as numbers only for known number fields, while text keeps spaces and leading zeros. An uncertain result asks you to check the record.
- Long script parameters use a stored text field to find a record; an empty layout or missing script result cannot be reported as a successful run. Names with spaces or special characters stay exact. Generated types use the real field types, handle repetitions and repeated names, and generated clients explain empty searches and server errors.
- Generated files ask before replacing unrelated files. The client folder chooser starts in the generated folder. AI context and FM Web pages are protected, edited runtime files stay untouched, and unedited pages from version 1.0.0 can be refreshed. A workspace opened through a symbolic link works; linked output folders are refused with an explanation. FM Web generation and preview still need a source checkout.
- Deleting a saved query from Manage asks first. Invalid saved-query imports explain the problem and leave your queries alone. File and snapshot failures show an error instead of silently stopping.
- Changing the wizard's server address clears its trusted certificate; **Save anyway** is visible, and the wizard explains when a saved password can be kept. Certificate advice distinguishes dates, missing intermediates and Data API failures; diagnosis handles server path prefixes and shows the full fingerprint.
- Cancelling one request no longer cancels another request's sign-in. Renewed sessions let requests continue while old sessions close in the background.
- Portal counts stay with the right record, and failed Load more requests can be tried again. Layout Inspector names repeated fields; field choices and server-test counts avoid duplicates. New Layout Mode fields go below existing objects, and narrow query controls stay inside the panel.
- Error messages hide more passwords, tokens and API keys. Malformed AI hidden-field settings are reported consistently without changing what is hidden. Confirmation dialogs no longer have duplicate Cancel buttons; closing one leaves records and files alone.
- FileMaker Cloud sign-in with a Claris ID is **not supported**. One real FileMaker server was exercised on 2026-10-21, but its version was not recorded; no server version has a completed recorded smoke test.

### Maintenance

Internal code was split into smaller parts for upkeep. Dependencies were updated, unused tools removed, and tests and package checks strengthened, with a higher minimum test coverage.

## 1.6.0

_Released 2026-10-19._

This is a minor release. Your profiles, saved queries, settings and stored data carry over unchanged, and no command or setting was removed. Nothing needs to be done for a normal install. **Read [UPGRADE.md](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/UPGRADE.md) ("Upgrading from 1.5.0 to 1.6.0")** for the few behavior changes you may notice.

In short:

- **New:** Layout Mode has standard field sizes and spacing, arranging and standardizing a layout (each undone in one step), and starter templates. The find form, Record Editor, Record Viewer and generated web layout views now show fields the same way.
- **Fixed:** a certificate you trusted could still fail with a misleading "not trusted" error under VS Code's default network setting; the message now says why and names the setting to change. Script runs return only the script's answer, copy-as-code is more exact, and profile changes made in another VS Code window show up within two seconds.

- [FEATURE] Layout Mode adds standard field sizes and spacing, arranging the selection into a standard form and standardizing it (each with one Undo step), and blank, form, two-column and first-portal starter templates (offered for a new, empty web layout). Synced field types and FileMaker field order guide placement; names and behavior bindings stay intact.
- [FEATURE] Find forms, Record Editor, Record Viewer and generated web layout views share Layout Mode field sizes, top labels and responsive spacing. The next time you generate or preview an FM Web app, its managed runtime files are refreshed to template version 3; a managed file you edited is left alone and named in a warning.
- [FIX] A certificate you trusted (pinned) could still fail with a misleading "not trusted" error when VS Code's `http.proxySupport` setting is `override` (its default): VS Code then replaces the extension's own connection, so the extension cannot check the certificate you trusted and VS Code's normal check applies instead. A server whose certificate VS Code trusts anyway (for example from Let's Encrypt) keeps working. Under `override` the trust is not enforced: a different certificate that VS Code trusts would be accepted too. The message now says why, for every kind of request and for proxy connections, and names the fix: set `http.proxySupport` to `fallback`, or install a public certificate on the server and choose **Forget trusted certificate**. The trust dialog, the wizard and the message after trusting say the same. The `on` value was not tested.
- [FIX] Script runs return only the script's answer, including the plain GET form. Layouts, scripts and container fields named `.` or `..` are refused before a request is sent, also in proxy mode.
- [FIX] Copied TypeScript keeps a field named `__proto__`. Copied proxy requests keep a trailing slash. Copied API base paths stay as configured (including percent escapes), and curl switches off bracket and brace expansion when needed.
- [FIX] New files written by Write AI Context and new FM Web runtime files are readable by you only; a file that is replaced keeps its permissions (without setuid, setgid or sticky bits).
- [FIX] Folder names keep visible emoji presentation selectors while refusing hidden standalone selectors. The Output panel and Show Effective Settings now warn when `ai.hiddenFields` is a string instead of a list; hiding is unchanged: the whole string still counts as one field name, even with commas.
- [FIX] Profile changes made in another VS Code window refresh the connection status, explorer and AI tools within two seconds; configuration and secret changes also refresh them.
- [FIX] Layout Mode lists fields in FileMaker's field order, not alphabetically. The Record Viewer also asks the server for the layout's field details at the same time as the record when schema metadata is on (it is not added to the request history, and a failure is ignored).
- [INTERNAL] The test mock of FileMaker Server's default certificate now matches a real server exactly, with an end-to-end test of the trust flow. Connection-limit tests no longer depend on timing.

## 1.5.0

_Released 2026-10-19._

This is a minor release. Your profiles, saved queries, settings and stored data carry over unchanged, and no command or setting was removed. Nothing needs to be done for a normal install. **Read [UPGRADE.md](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/UPGRADE.md) ("Upgrading from 1.4.0 to 1.5.0")** for the few behavior changes you may notice.

In short:

- **New:** a read-only `@filemaker` participant in VS Code's Chat view, and copy-as-code for requests (curl, fetch(), `.http`, Postman, TypeScript) from more places.
- **Changed:** scripts now run with the request the Claris Data API Guide documents (one request that reads no record), and layout, script and field names are no longer trimmed, so a name with a leading or trailing space is used exactly as the server lists it.
- **Fixed:** narrow editor panels, the Record Editor and Record Viewer on first open, the Restricted Mode notice in the connection wizard, and several Windows and Linux problems.
- [FEATURE] A read-only `@filemaker` chat participant for VS Code's Chat view (ADR-0005): `/layouts`, `/describe`, `/find` (`Field=value` or plain words that the chosen language model turns into a search, which the extension validates like any tool call) and `/explain`. It uses the AI tools through the same core, so every AI setting, approval, limit, hidden-field rule and the kill switch apply; it offers no write or script command and sends the model only layout and field names and your words, never record values or connection details. Everything from the database is shown as plain text in code blocks (never as a link, image or button), and calls are logged as client `chat participant`. No new setting; the editor floor stays 1.96. See the User Guide, "Chat with @filemaker".
- [FEATURE] Copy a request as code, everywhere. **Copy request** in the Query Builder and Script Runner now offers curl, fetch(), a `.http` file for REST Client, a Postman v2.1 collection and TypeScript (and **Save as .http file…**, which opens an unsaved editor and writes nothing into the workspace); the Record Viewer and Record Editor have **Copy request for this record** (get, edit with a `modId` placeholder, delete; the editor copies the fields you changed); and **FileMaker: Copy Request as Code…** copies login, find, get, create, edit, delete, run script, list layouts, list scripts, layout metadata and container upload for the active connection. The password, session token and API key are never copied (`<REDACTED>`, or with **Include auth header** a variable such as `$FM_TOKEN` or `{{token}}`); an account, query string or fragment typed into the server address is dropped; credential-looking names and values are replaced with `***` and the request says so; names and values are escaped for each format (shell quoting, JavaScript strings including U+2028 and `</script>`, JSON, `.http` line breaks and `{{variables}}`) and layout, field and script names are percent-encoded exactly like the client does. **Run script** is now copied in the form the Claris guide documents (a `GET` with `script.param` in the address), not a `POST` (the documented script endpoint takes only `GET`). See the user guide section "Copy a request as code".
- [SECURITY] Log and diagnostics redaction now also covers single-quoted keys (`{'token': '...'}`) and plain-text `Cookie:`, `Set-Cookie:`, `Authorization:` and `Proxy-Authorization:` lines.
- [SECURITY] Configured file paths (for example `filemaker.ai.contextPath`) now also reject characters that render as blank (Hangul fillers, variation selectors, the combining grapheme joiner), so a path cannot look like a different one.
- [FIX] On Windows, **Write AI Context** and the FM Web runtime generator can now update a file that is marked read-only (for example by a version-control tool): the update used to fail with `EPERM`, where macOS and Linux replaced it. The file stays read-only afterwards.
- [FIX] On Windows, `npm run build` no longer needs `sh` on the PATH, and `npm run package:check` writes `filemaker-data-api-tools-<version>.vsix` instead of a file literally named `...-${npm_package_version}.vsix`; both steps are now Node scripts that behave the same in cmd.exe, PowerShell and a POSIX shell.
- [FIX] On Windows, a repository checked out with `core.autocrlf` (the Git for Windows default) no longer fails `npm run package:check` or the mock dataset check because generated files such as `THIRD_PARTY_NOTICES.txt` came out with CRLF line endings: `.gitattributes` now keeps LF in the working tree on every platform, and both checks also ignore CRLF.
- [FIX] The build commit shown by **About** is now found on Windows when the temp or checkout path contains an 8.3 short name or a different drive-letter case (it said `unknown`).
- [FIX] On Windows, the MCP shim waits up to 30 seconds (it was 8) for PowerShell to report the process start time before it gives up and refuses to connect: PowerShell takes about 2 seconds to start on an idle machine and much longer on a busy one.
- [FIX] An MCP client configured with `--workspace C:\Work\Alpha` now matches the window VS Code reports as `c:\work\alpha` (folder paths are compared without regard to case on Windows).
- [FIX] A connection that drops while FileMaker's answer is still arriving is reported as that: 'The connection to <host> dropped while reading the response, so the answer is incomplete', with a reminder to check whether a change was applied before repeating it. It used to read like a success ('... (HTTP 200)').
- [FIX] **Refresh Schema Cache** now also clears the layout list and layout metadata kept by the connection, so the next refresh reads the layouts from the server again (before, it cleared only the field schema and the old layout list was served until it expired).
- [FIX] Layout names are kept exactly as the server sends them. A layout whose name begins or ends with a space (for example ` Sales`) is no longer trimmed into a different name that cannot be opened, and layouts that differ only in spacing or case stay separate entries; only an identical name (which the Data API cannot tell apart) is listed once.
- [FIX] A malformed `filemaker.ai.hiddenFields` value no longer switches hiding off for the whole scope: non-text entries are ignored and the valid names in the same list still hide (a bare string counts as one name), and the Output panel says so once.
- [FIX] Refreshing a generated FM Web runtime file now keeps the file permissions of the file it replaces, and a write that fails part way (for example a full disk) no longer leaves a hidden `.tmp` file in the generated folder.
- [FIX] The AI server for external tools now writes a line to the Output panel when it rejects a socket folder (for example an `XDG_RUNTIME_DIR` that is open to other users) before falling back to the temp folder, and the error names each folder variable that was tried instead of only the last one (a too-long socket path now names the variable actually in use).
- [FIX] After an untrusted-certificate failure the extension looks at the server certificate once per server and failure for a minute (the result is remembered, including a look that got no answer), instead of paying up to 1.5 s on every failed request.
- [FIX] Scripts run with the request the Claris Data API Guide documents: `GET .../layouts/<layout>/script/<script>?script.param=<text>`. Before, the extension first sent a `POST` to that address (which the Data API does not accept) and then fell back to a find with the script attached, so every script run also read a record. A script run is now one request that reads nothing. Parameters are percent-encoded exactly (a space is `%20`, never `+`; unicode, `|`, `&` and `/` survive). A parameter too long for a URL (about 2,000 characters, as the guide advises) goes in the body of a find limited to one record, the guide's other documented form; with a record id and a too-long parameter you get a clear error instead. The attach-to-another-request form is used only when the server refuses the script endpoint (405, 501 or a FileMaker 404). Script Runner's Copy as curl / fetch now shows the same GET request.
- [FIX] Running a script refuses a script or layout named `.` or `..` with a clear message before anything is sent (a web address would resolve it away and send a different request that reported success), in the client, Script Runner and the AI tool. A script run now returns only the script's answer: when the script is attached to a record or a find, the record's `data` and `dataInfo` are dropped before Layout Mode, the preview bridge or any other caller sees them.
- [FIX] The Record Editor no longer hides the fact that fields are missing. A note under the field list always says that fields your account cannot access are not listed, and when the layout lists fields that the record has no value for it says how many and names them (up to five).
- [FIX] The Record Viewer no longer sits on a loading skeleton. Opened for a record (from a results row, for example) it loads that record by itself; opened without one it shows the form with the hint 'Enter a record ID and select Load Record.'; a failed load shows its error.
- [FIX] The connection wizard says when the workspace is in Restricted Mode. A notice at the top explains what is limited (a profile template in the project is ignored; workspace settings that change how connections and commands behave are ignored until you trust the workspace) and has a **Manage Workspace Trust** button; it disappears when you trust the workspace.
- [FIX] Panels fit narrow editors. A very long layout name no longer widens the layout drop-down (and the whole page) in the Record Editor, Record Viewer and Script Runner: long names are clipped with the full name in the tooltip; buttons wrap; long values break instead of overflowing. The connection wizard's Test button, the Query Builder's menus and request history, the Diagnostics tables (they now scroll inside their cards), and Layout Mode (its three columns narrow, then stack in one scrolling column) work from 360 px up. Checked with the real-VS-Code responsive audit (J14: 360-1100 px, zoom -2 to +2, light, dark and high-contrast themes).
- [FIX] Layout, script and field names are now used exactly everywhere. With layouts `Sales` and ` Sales` (a leading space), choosing ` Sales` no longer turns into `Sales`: a container upload, a script run (Script Runner, Layout Mode, AI tool), a saved query and type generation all use the exact name, so nothing is written to the wrong layout. Generated type files, TypeScript identifiers and VS Code snippet keys for such layouts stay distinct. The Record Editor's hidden-fields note appears only when the layout lists fields the record lacks.
- [FIX] The **Upload to Container** command, the only route to a container upload, keeps the field name exactly as typed or given (a field named ` Photo` is no longer sent as `Photo`); global field names and the FM Web synced field list are kept exactly as well.
- [FIX] Script names read from the server and field names chosen in the Query Builder's find form and sort are kept exactly (a leading or trailing space is part of the name), like layout names.
- [FIX] Layout Mode: a very long field name in the field list no longer widens the whole page; the name is clipped. The connection wizard's section headings also break inside a very long word at a very narrow width.
- [INTERNAL] A stray unclosed `@media` block in the Query Builder stylesheet (introduced in the copy-request menu change, never released) is closed, and a test now checks every webview stylesheet for balanced braces.
- [INTERNAL] Real-VS-Code UI suite triage after the 1.5.0 dry run: J07 uses the Copy request menu; J10c starts a fresh AI session (the 30 calls a minute limit and layout approvals are shared by the whole window, and J10a/J10b had used them) and closes the Chat side bar when done (it left J14 about 160 px narrower); J10c reads the whole Show AI Activity document instead of its visible lines; J14 closes side bars before measuring and stops the AI server if J10b left it running (the command toggles, so the start dialog never appeared); the J14 page-overflow finding now names the elements that reach furthest right.
- [INTERNAL] Compatibility page states what is verified: Server 21.x is targeted (built from the Claris documentation and the mock, not yet checked against a real server), 19.x, 20.x and custom proxies are expected to work but not tested. The Linux keychain troubleshooting row uses the message as the extension logs it (`SecretStorage unavailable (…)`), and the walkthrough step 4 shows the sidebar image.
- [INTERNAL] Marketplace page and User Guide refreshed for the changes since 1.4.0. The three drawn mock-ups in `docs/marketplace/` are replaced by nine real screenshots (query builder, copy as code, record editor, connection wizard, sidebar, schema diff, Layout Mode, `@filemaker` chat and the About message) taken in the real VS Code with the mock Data API and made-up data; they are produced by the new `e2e-ui/journeys/j16-marketplace-screenshots.mjs` (skipped unless `E2E_MARKETPLACE=1`; the chat shot uses the harness's stand-in language model). The README lists certificate trust by fingerprint, Restricted Mode, `@filemaker`, MCP clients and Windows/Linux support without claiming a real-server test; the User Guide gains sections for Windows, Linux and macOS, for names used exactly as typed, for the script `GET` form and its address limit (about 2,000 characters), and for how `@filemaker` behaves in an untrusted workspace.
- [INTERNAL] New `cross-platform` CI job: build, lint, typecheck, unit tests with coverage and package check on `windows-latest` and `ubuntu-latest` (Node 22). It is not a required check. New Windows-only tests run a real named-pipe MCP server and clients, real directory junctions through the discovery, shim-install, path-confinement and FM Web generator checks, read-only file replacement, and an `icacls` check of the discovery file's access rights; several MCP discovery tests that were Unix-only now run on Windows too.
- [INTERNAL] Tests no longer assume Unix: path separators in expectations, a regular file instead of `/dev/null` as an unwritable folder, backslashes in the mock TLS authority's OpenSSL configuration, and CRLF-tolerant reads of `.vscodeignore`.
- [INTERNAL] The mock FileMaker Data API (`npm run mock:server`) now covers the documented Data API surface (sessions with Basic, OAuth headers and Claris ID, productInfo, databases, layouts and scripts with folders, layout metadata, records, find, duplicate, container upload, globals, script endpoint and script parameters), the FileMaker error codes with their HTTP statuses, a configurable 15-minute token lifetime, a session cap, TLS modes, a reference proxy endpoint, an admin control surface (separate port optional) with named failure faults, and a seeded dataset of about 1,400 records of deliberately mixed quality (`test/mock-server/DATASET.md` says which record ids exercise which condition). The endpoint inventory with its Claris sources is in `scripts/mock/ENDPOINTS.md`; `npm run mock:check` runs every implemented endpoint and error code, and `test/unit/mockServer` holds contract tests against the response shapes in the Claris Data API Guide.
- [INTERNAL] Real VS Code UI end-to-end tests (`npm run test:e2e-ui`, not part of `npm test` or CI): Playwright drives the downloaded VS Code desktop app with the built VSIX through twelve user journeys plus failure-mode, AI and MCP server journeys, writing a step report with screenshots. A known-findings list (`e2e-ui/known-findings.json`) lets a run exit 0 when only known findings fail and exit 1 on a new failure; the real Claude Code CLI journey is opt-in (`E2E_CLAUDE=1`). See `extension/e2e-ui/README.md`.
- [INTERNAL] Dependabot now also watches `tools/publish` (the pinned Marketplace publish tool), which has its own lockfile and was not covered before.
- [INTERNAL] Dependencies updated: `zod` 4.6.5 (the one runtime library besides `axios` that ships in the extension) and a round of development tools (`vitest` 5, `@types/node`, `eslint`, `globals`, `prettier`, `@vitest/coverage-v8`). `THIRD_PARTY_NOTICES.txt` is regenerated. No behavior change.

## 1.4.0

_Released 2026-10-18._

This is a minor release. No data migration, and no command or setting was removed; see UPGRADE.md for behaviour changes you may notice. **Read [UPGRADE.md](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/UPGRADE.md) ("Upgrading from 1.3.0 to 1.4.0")** for the behavior changes you may notice: repositories can no longer loosen your policy, new confirmation prompts, generated file names, CSV apostrophes, AI features (off by default), and the FM Web preview needing the repository. The [User Guide](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/docs/USER_GUIDE.md) covers everything below.

- [FEATURE] The extension version is now easy to find. **FileMaker: About / Show Version** shows the version, build (commit and commit date), VS Code, operating system, remote window, workspace trust and language, with **Copy for bug report** (no server address, profile name, user name, token or path), **Open Changelog** and **Report an Issue** (the bug form opens with the version fields filled in). The version also appears in the status bar tooltip, as the FileMaker Explorer description, in the footer of the connection wizard, Query Builder, Record Editor, Layout Mode and Diagnostics Dashboard, on the first Output line at start-up, and in **Show Diagnostics**. The bug report form asks for the About block.
- [FEATURE] Clearer User versus Workspace settings. New **FileMaker: Show Effective Settings** lists every policy-related setting with the value in effect, where it comes from, your User and Workspace values and, when a workspace value is ignored, a plain sentence saying why (the value in effect is read by the code that enforces the rule; for on/off switches the explanation is built from the same reading), with buttons that open the User or Workspace tab at that setting. The extension now tells you once per setting per workspace when a project ships a value that is ignored (with **Don't show again for this workspace**); notification text never contains a value from a settings file. Restricted Mode, multi-root workspaces and `.code-workspace` files are explained, and the settings files are read only in a trusted workspace, with a size cap and without following links. Every setting description starts with **User settings only.**, **Workspace can only make this stricter.** or **Per workspace.**; `filemaker.savedQueries.scope`, `filemaker.schema.snapshots.storage` and `filemaker.typegen.outputDir` are explained (stored values unchanged); **Open AI Settings** opens the User tab. No setting was renamed and no enforcement changed. The user guide has a new "User settings vs Workspace settings in plain words" section.
- [FEATURE] **Test Connection** is now a ladder that says which step failed: reaching the Data API (TLS, name, port, and `/productInfo`, which needs no account), listing the hosted databases (so a wrong database name can be answered with the names the server lists), then signing in. The status bar item shows the real state of the connection from the last request (connecting, connected, sign-in failed, certificate problem, unreachable) instead of always saying connected, and says only that the profile is active before any request has been made.
- [FEATURE] Trust a private or self-signed server by pinning its certificate instead of switching checking off. **Test Connection** (and the **Trust this certificate…** button on a connection error) shows who the certificate is for, its dates and its SHA-256 fingerprint, says why it was refused, and on your approval trusts exactly that one certificate for the connection: host-name and issuer checks are skipped for it only, it is refused if it has expired (unless you accepted that in the dialog), and a different certificate later is a hard failure that offers **Review and re-trust**. Nothing is sent to a server before its certificate is checked. The pin is stored in the new optional profile field `pinnedCertSha256` (never settable from a workspace template). The checkbox for the older setting is gone from the wizard; profiles that already have `allowSelfSigned` keep working, keep a persistent warning in the profile list and status bar, are offered a one-time conversion, and can be converted or switched back to normal checking in the wizard. The custom CA file also trusts your operating system's certificates where VS Code's Node can read them, so a company CA that is only installed in the system store works (set `http.systemCertificates` to false to opt out).
- [FEATURE] New user setting `filemaker.export.neutralizeFormulas` (default on, user settings only; a workspace cannot change it). Turn it off to get CSV exports and **Copy as table** without the leading apostrophe that protects spreadsheets from cells starting with `=`, `+`, `-`, `@`, tab or carriage return. JSON Lines exports never had the apostrophe. Importing a file takes the apostrophe off either way.
- [FEATURE] The connection wizard can trust a private certificate authority. A new **Certificates (advanced)** section has a **Custom CA certificate file** (an absolute path to a PEM file; checked on save and test: it must exist, be a certificate and not hold a private key). It is stored per profile only: a workspace `.filemaker/profile-template.json` cannot set it. Editing a profile in the wizard now keeps its AI access setting unless the server or user changes. (For a server whose certificate has no host names, such as FileMaker Server's default certificate, use the certificate trust dialog described above.)
- [FEATURE] MCP clients such as Claude Code and Cursor can use the AI tools (ADR-0004, phase 3). Off by default: turn on `filemaker.ai.externalServer.enabled` in your user settings, run **FileMaker: Start/Stop AI Server for External Tools**, then **FileMaker: Copy MCP Config for Claude Code / Cursor** and paste the result into the client. The setting is only a permission: the server runs in a window only after you run the command there and confirm its dialog (VS Code remembers that per workspace and starts it again when you reopen it, until you stop it with the same command; turning the setting off stops it everywhere and ends the automatic start for every workspace, also closed ones). A bundled stdio program (needs Node.js 18 or newer on the client's PATH) connects to a local socket (a folder only you can use; on Windows an unguessable named pipe) and proves it holds a per-session token kept in a file only you can read; it checks that the window that wrote the file is still the same process before sending the token. The tools, limits, layout approvals, write dialogs and kill switch are exactly the ones used for VS Code's own agent mode, and the tool list updates when you switch AI off. The name an MCP client gives itself is shown only in **Show AI Activity**. You get a notification when a program connects. Not supported in remote windows. What the tools return goes to the model provider behind your MCP client.
- [FEATURE] AI tools for VS Code language-model clients such as Copilot agent mode (ADR-0004, phase 2). Off by default: set `filemaker.ai.enabled` in your user settings, pick a connection with **FileMaker: Set AI Access for Connection** (profiles gain `aiAccess`: none, read or write; default none), and tools can list layouts and scripts, describe a layout, find and read records (closed query form, 50 records per call, 500 per session, 30 calls a minute) and explain error codes. Each layout asks for approval once per session. `filemaker.ai.allowWrites` adds create, edit and delete of one record at a time, and `filemaker.ai.allowScripts` adds running scripts from `filemaker.ai.scriptAllowlist`; every write asks in a dialog that cannot be set to always allow, built by the extension from a fresh read of the record (delete needs the record id typed; an edit sent with the modId read at that time is refused if the record changed). A write is limited to 10 fields and 200 characters per value so the dialog shows all of it, and is refused if it cannot. Write attempts are capped at 10 a session and 3 a minute; the kill switch asks before switching back on and only **Start New AI Session** resets the caps. These settings are read from your user settings only; a workspace or dev container cannot turn them on. `filemaker.ai.hiddenFields` hides fields by name (best effort), `filemaker.features.ai.enabled` and an `ai` entry in `disabledFeatures` can switch AI off, offline mode blocks AI reads too, and tools are not registered in an untrusted workspace. A status bar item shows the state and is a kill switch; **FileMaker: Show AI Activity** shows a log kept outside the workspace. Anything a tool returns goes to your AI model provider; use a FileMaker account with a restricted privilege set. See the README section "AI tools".
- [FEATURE] **FileMaker: Write AI Context** writes a Markdown summary of the layouts you pick (up to 50), their fields and the script names, for AI coding tools to load. Names are written as JSON strings in code blocks, limited to 64 characters of letters, digits, space and `_ - . : ( )` (anything else becomes a placeholder, counted in the header); value-list values, descriptions, the server address, user name and credentials are never included, and the file stays within 20 KB. It is written outside your repository by default (the extension's storage folder) with an offer to copy it into the workspace and to add it to `.gitignore`. `filemaker.ai.contextPath` (user settings only) can point it elsewhere inside the workspace; an existing file only has its marker-delimited section replaced, and symbolic links and paths that leave the workspace are refused. Names of this kind can still carry misleading text that an AI tool might follow; treat the file as data (ADR-0004, phase 1).
- [FEATURE] The Record Editor now refuses to overwrite a record that someone else changed after you opened it. Saving sends the version of the record you loaded, and FileMaker rejects the edit if it no longer matches (error 306). The editor then shows which fields changed since, which of them you also edited, keeps your edits in the form, and offers **Reload record**. Before, the last save silently overwrote the other person's change. Batch update is unchanged.
- [SECURITY] Write AI Context now honours `filemaker.ai.hiddenFields`. The generated context file used to list fields you had hidden from AI tools (for example SSN, Password, Token). They are now left out using the same name matching and the same user-scope reading as the AI tools, and the file and the confirmation say how many were left out (never which).
- [SECURITY] A trusted (pinned) server certificate can no longer be bypassed by an HTTP proxy. With `HTTPS_PROXY` set, the request used to be tunnelled with certificate checking switched off, so the pin was ignored and the password reached whatever answered. Now a connection with a pinned certificate is made directly or not at all: if a proxy applies to the server (`HTTPS_PROXY`, `ALL_PROXY`, ... minus `NO_PROXY`) the extension refuses before sending anything and says to add the server to `NO_PROXY` or use a custom CA file; and even if something hands the agent to a proxy-aware client, the tunnelled connection verifies normally and fails closed. The custom CA file and the unpinned default keep checking certificates through a proxy; the older "skip all checks" setting keeps skipping them, as before.
- [SECURITY] After FileMaker rejects the stored credentials (error 210, 211, 212, 213 or 214), the extension no longer signs in again by itself. Before, every action (each Explorer refresh, each query) sent another failed login, so a changed password could trigger an account lockout. Automatic sign-ins now stop for that connection with a message that says so; they resume when you edit the account or password, or run **Connect** or **Test Connection**. When the server has no free Data API sessions (956) automatic sign-ins wait 30 s, then 60 s, up to 5 minutes. Parallel requests share one login attempt.
- [SECURITY] **Delete Record** now follows the same rules as saving a record: it is refused when `filemaker.features.recordEdit.enabled` is off or enterprise policy disables or restricts record editing (`disabledFeatures: ["recordEdit"]`, viewer role). Before it checked only the general write permission and workspace trust.
- [SECURITY] `filemaker.secrets.fallback` is now an application-scope setting (read from your user settings only), so a repository's `.vscode/settings.json` can no longer switch your secret storage to the workspace-state fallback or turn secret persistence off, and `filemaker.typegen.outputDir` is a restricted setting in untrusted workspaces. If you set `secrets.fallback` in workspace settings, move it to user settings.
- [SECURITY] Query Builder **Copy as table** now applies the same spreadsheet-formula protection as the CSV export: a cell that starts with `=`, `+`, `-`, `@`, tab or carriage return gets a leading apostrophe when pasted (plain numbers and phone numbers are left alone). Before, `=HYPERLINK(...)` from a field value pasted into Excel or Sheets as a live formula.
- [SECURITY] Editing, creating and uploading to records and the Script Runner now need a trusted workspace, as the README and the Marketplace page already said. Before, only Delete Record and Upload to Container checked; **Open Record Editor**, **Edit Record by ID**, **Create Record**, **Open Script Runner** and the editor and runner panels themselves now refuse in an untrusted workspace with a message, and the panels also refuse save, load and run messages if trust is lost.
- [SECURITY] AI tools follow-ups: the approval dialog text may not pass 4,000 characters (escaped characters count, a longer write is refused) and written values are limited to 200 characters; writes also refuse the `[server]`, `[container or server URL omitted]` and `[container field omitted]` placeholders; the server-address scrub matches host-shaped text only, so a user name such as "admin" is left alone in ordinary words; a session reset while a call is in flight can no longer leave the record quota negative; and the policy re-check after a dialog also covers the script allowlist, approved layouts and the target profile.
- [SECURITY] Names that come from a FileMaker database (layout, field and profile names) can no longer put code into generated files. Generated TypeScript types, clients and snippets now escape them for the comment, string or snippet placeholder they land in, so a layout named with `*/` and a line break stays text. Layouts whose names differ in any way that the file name drops or folds (`A/B` and `A:B`, `My Layout` and `My_Layout`, very long names) now get separate files instead of overwriting each other, and names such as `CON` or `..` get safe file names. Generated files for layouts with spaces or punctuation in the name are written under a new name (with a short hash); delete the old ones. Names that differ only in letter case can still collide on case-insensitive file systems.
- [SECURITY] CSV and batch exports no longer let a cell run as a spreadsheet formula: text starting with `=`, `+`, `-`, `@`, tab or carriage return gets a leading apostrophe (plain numbers, signed numbers and phone numbers such as `+1 (555) 123-4567` are left alone). Batch update takes the apostrophe off again when it reads a file. `neutralizeFormulas: false` turns it off in code.
- [SECURITY] The schema snapshot index in `.vscode/filemaker/snapshots` and the offline cache index are checked before use: entries that are not well formed, or whose file name is not a plain `.json` name in that folder, are ignored, so a cloned repository's index can no longer make pruning delete other files. The generated-output folder setting also rejects Windows drive-relative paths such as `D:folder`.
- [SECURITY] Logs, history, metrics and error messages now hide more secrets: the session token in `DELETE /sessions/<token>` (it was recorded in clear in request traces), query parameters such as `access_token`, `sessionToken` and `sig`, JSON fields whose name merely contains `token`, `secret`, `password`, `session` or `apiKey` (for example `sessionToken` or `clientSecret`), and a user name and password written inside a URL.
- [SECURITY] Workspace plugins (`.vscode/filemaker-plugins/`) no longer run just because the folder is trusted: the extension hashes the whole plugin folder (every file under it, not only the entry scripts) and asks once, naming the files and workspace, before importing anything. The approval is remembered by workspace and content, so a changed, added or removed file asks again. A folder with more than 500 files, or one that contains a symbolic link, is refused, with a message saying why.
- [SECURITY] A repository can no longer weaken the enterprise policy. `filemaker.enterprise.mode`, `filemaker.enterprise.role` and `.vscode/filemaker.config.json` can turn enterprise mode on and lower the role for that workspace, but cannot switch it off or raise the role above the one in your own user settings (or the default, `developer`). Before, a repo could unlock plugin loading by setting `enterpriseMode: false` or `role: "admin"`. If you relied on a repo file to grant `admin`, set it in your user settings instead.
- [SECURITY] A repository can no longer loosen your offline mode or feature switches. A workspace `.vscode/settings.json` can switch `filemaker.offline.mode` on or a `filemaker.features.*.enabled` switch off, but cannot undo what is set in your user settings (`filemaker.offline.mode` is now also a restricted setting in untrusted workspaces).
- [SECURITY] The FM Web preview bridge applies your limits: it refuses record changes in offline mode, when record editing is switched off and when the enterprise role disallows `writeOperations` or `recordEdit`, and refuses script runs in offline mode, when the script runner is switched off and when the role disallows `scriptRunner`. The bridge also serves only the active connection and rejects a request that names another profile. Layout Mode prompt text from a layout file is flattened to one line so it cannot fake extra lines in the confirmation.
- [SECURITY] Layout Mode `runScript` behaviours (from a layout file that can come with a repository) now need a trusted workspace, the script runner to be enabled, offline mode off, and the enterprise policy to allow scripts, and they ask before running, naming the script, parameter and connection, and saying when the project file chose that connection.
- [SECURITY] **Start FM Web Preview** now shows what it will run (`npm install` and `npm run dev` in the generated runtime folder, using that folder's `package.json`) and asks first.
- [SECURITY] A `.filemaker/profile-template.json` that arrives with a cloned repository can no longer steer your credentials. It is ignored in an untrusted workspace, it no longer locks the server address, the wizard names the address it points at, and the wizard asks before saving or testing against an address that came from the workspace (unless you already have a profile for that server).
- [SECURITY] Connection wizard: editing a profile's server address, proxy address or user name no longer reuses the saved password, API key or session token for the new target; you are asked to enter the password again. **Test Connection** now uses throwaway credentials, so it never reads, overwrites or clears a real profile's secrets, and it checks the address the same way Save does. In proxy mode the backend `serverUrl` is checked and bound to the saved API key as well as the proxy address. A saved profile with a user name or password in its address stays listed so it can be fixed. The wizard also warns before sending a password to a remote `http://` address, rejects a server address with a username or password in it, validates the proxy endpoint, and checks the shape of the form data it receives.
- [FIX] A panel tab that VS Code restores after a window reload or restart is no longer a dead, empty page. Every panel type (connection wizard, Query Builder, Record Viewer, Record Editor, Script Runner, Layout Mode, Schema Diff, Environment Compare, Diagnostics Dashboard, Effective Settings) now has a serializer that shows a short page saying the panel was closed by the reload and naming the command that opens a working one, and the extension now also starts on `onWebviewPanel` for each of those panel types, so the serializer exists before a saved tab is restored (it still starts when VS Code has finished starting).
- [FIX] A script that ran but returned a script error (for example error 3) no longer shows 'Script execution completed'. Script Runner shows 'Script ran, but it reported an error' with the error code and its meaning, in the error colour; Layout Mode reports the same as a failed script action; a timed-out script now says it may still be running on the server. Script errors 1, 3, 4 and 5 have plain-words meanings.
- [FIX] Commands appear without a window reload. After the connection wizard saves your first profile, **Connect** and **Edit Connection** are available at once, and after **Initialize FM Web Project** the FM Web commands appear (the Command Palette conditions are re-read whenever profiles change or the project file is created, changed or deleted, including outside the extension).
- [FIX] Review fixes for the follow-ups. Effective Settings says a `filemaker.typegen.outputDir` is unusable only when the value in force really is (judged by the rule the code uses), and never because of Restricted Mode. TLS agents are closed when the extension shuts down; a replaced agent waits at least the request timeout plus ten seconds before its sockets are closed, and the cache evicts the least recently used. Generated preview files are written through a temporary file and renamed into place (a link planted at the target is replaced, never followed); a folder where a file belongs gets a plain message. The sign-in pause for error 956 uses Claris's wording ('database or Admin API sessions'), error 1703's advice uses the softened FileMaker Cloud wording, and an untrusted-certificate message offers a CA file only when the certificate is known to list host names (not when the look at the certificate was skipped or failed).
- [FIX] Script errors reported next to a container upload or a find that worked are now shown as a warning (as for create, edit and delete), not only logged. Effective Settings now explains an invalid `filemaker.enterprise.role` in User settings as 'treated as developer' and a `filemaker.typegen.outputDir` that cannot be used as the default folder, and refreshes when the `.code-workspace` file changes. Replaced or evicted TLS agents are closed (after a short grace period) so their sockets do not linger, and a pinned agent no longer changes the request options it is given, so a kept-alive pinned socket is reused instead of being stranded.
- [FIX] Refreshing the generated preview app no longer writes through symbolic links (a link at a managed file, or a folder that links outside the generated runtime, is left alone and the file is named in the warning) and no longer overwrites a file you edited that still carries an older version marker: it is refreshed only if it matches a version the extension shipped; otherwise it is left and named in the warning.
- [FIX] Marketplace builds no longer list **Generate FM Web Next.js App** or **Start FM Web Preview Server**, which only said 'not available in this installation' there: they are hidden from the Command Palette when the installation has no runtime template (checked the way the generator finds it); invoked another way they still give the same plain message. Layout Mode and layout-page generation do not need the template and stay available.
- [FIX] Certificate advice only where it can work. For FileMaker Server's default certificate, and for any certificate that lists no host names, the message and the trust dialog now say to trust the certificate (or install one from a public authority) and no longer end with 'set it as the connection's CA file', which cannot make host-name verification pass; a certificate that does list its host names (a private authority) still gets the CA-file option, second. The trust dialog's 'Why it was refused' line uses the same wording as the error message. A trusted (pinned) certificate behind a proxy is now told what works: add the server's host name to NO_PROXY so the connection goes direct, or forget the pin and use a CA file for a certificate with proper host names (a pinned profile ignores the CA file).
- [FIX] A trusted (pinned) certificate works on every connection, not two of three. The agent kept TLS sessions, and on a resumed session there is no certificate to compare, so the second and third requests were refused as "certificate changed" (Test Connection failed right after you trusted a certificate). A pinned agent now caches no sessions, and a connection that somehow resumed one is refused rather than accepted unchecked. Whether a pinned connection is refused behind a proxy now follows axios's own rules exactly (`HTTPS_PROXY`/`ALL_PROXY` and its two `NO_PROXY` matchers; `npm_config_*` and `HTTP_PROXY` do not count for https), so a pinned connection is not refused for a proxy axios would not use, and does not bypass a required one. The certificate review says it connects directly and ignores the proxy, and the check that recognises FileMaker's default certificate is capped at 1.5 s and skipped behind a proxy.
- [FIX] Certificate messages are shorter and truer. FileMaker Server's own default certificate (recognised by what the server presents) gets the plain "default certificate is self-signed" sentence; any other untrusted chain gets a neutral one that names a missing intermediate certificate as the common cause; neither mentions a screen, so they read the same in a notification and in the wizard. A certificate with no host names says so instead of telling you to "use a name the certificate lists". **Trust this certificate…** is offered only where trusting makes sense (not for a revoked certificate), the certificate text in the trust dialog is stripped of control characters and quoted so it cannot fake lines, IPv6 server addresses work in the review, and the review asks the same confirmation as Test Connection for an address that came from the workspace template. Sign-in details: error 214 is described as possibly temporary; a failed renewal ahead of expiry no longer pauses sign-ins while the current token still works (and is not retried each time); error 1703 pauses automatic sign-ins like the other credential errors; a Test Connection leaves nothing behind in the client.
- [FIX] Error text from a server's reply (a gateway's HTML page) is now cut to a few kilobytes before any processing and stripped of tags in one pass, so a hostile reply of a megabyte of `<` can no longer freeze the extension for seconds. The status bar no longer says "connected" after a gateway error (502, 503, 504) or a cancelled request: a gateway error shows "unreachable" and a cancel leaves the last known state.
- [FIX] A batch update stops the whole job only for errors that mean the account cannot do this at all (9, 205, 207, or rejected credentials). A record hidden by a record-level access rule (error 200, "Record access is denied") fails that record only, with its reason in the failure list, and the job carries on with the rest.
- [FIX] The operating system's certificates are added to Node's own trusted list (including `NODE_EXTRA_CA_CERTS`), not to a bare copy of the built-in list, so a CA added through `NODE_EXTRA_CA_CERTS` keeps working. The system store is read in the background after the extension starts and re-read every ten minutes; a CA installed later is picked up then or on reload.
- [FIX] A failed **Test Connection** shows its reason once (in the message box, not repeated in the red badge), and a certificate problem gets the **Trust this certificate…** (or **Review and re-trust**) button right there. FileMaker Server's own default certificate (a self-signed "Claris" certificate with no names, from a private root) now gets the plain message: this server uses a certificate that is not trusted, you can trust it in the wizard, or install one from a public authority; it pins and connects, and no credentials are sent before the check.
- [FIX] A rejected sign-in against a FileMaker Cloud host (`*.filemaker-cloud.com`) now says that FileMaker Cloud normally uses Claris ID sign-in, which this extension does not support, and that an account name and password may not be accepted by the tenant (it no longer claims they cannot work), instead of looking like a wrong password. The user guide's troubleshooting table explains a plain HTTP 404 as a wrong address or disabled Data API (not "metadata not supported") and names the current `filemaker.requestTimeoutMs` setting.
- [FIX] Proxy mode keeps what FileMaker said. A proxy can now return `fmCode` (FileMaker's error code) and `status` in its `ok: false` reply (documented in ADR-0001); the extension then raises the same error as in direct mode, so the record-changed dialog (306), "no records match" (an empty result, not an error), rejected-credentials handling and the friendly error texts work through a proxy. A proxy reply that is a web page instead of JSON is reported as that, and redirects are not followed. Proxies that do not send these fields behave as before.
- [FIX] The schema cache (layout fields, up to 5 minutes) is now dropped whenever the connection's cached data is: a new sign-in, a sign-out, or saving the profile in the wizard. Before, changing the account in a profile left the old account's fields visible for up to five minutes.
- [FIX] Batch update no longer retries FileMaker's own errors (HTTP 500 with an error code) or counts them towards the circuit breaker, so a read-only account no longer triples the load and stalls the job. It retries only connection and gateway problems, a locked record (301), and 429/503, waiting for the server's `Retry-After`. When the account cannot do the update at all (no privilege, rejected credentials) the job stops once, with FileMaker's reason and the number of records not attempted. A batch export reports `truncated` only when the layout has more records than the cap, not when it has exactly that many.
- [FIX] **Connect** retries only failures that a retry can fix (a refused connection, a timeout, a gateway error, a full session pool). Before, it retried HTTP 500 with FileMaker error 802 (no fmrest privilege or closed file) three times, and never retried a refused connection or a timeout.
- [FIX] A page that is not the Data API (a captive portal, firewall block page, sign-in redirect, empty or cut-off reply) now gives one clear error with the status and content type, instead of `Cannot read properties of undefined`. Redirects are no longer followed (the Data API never redirects; before, a redirect to another server completed a login there and an https-to-http downgrade was followed): the error says where the server pointed. A 200 reply whose first FileMaker message is an error is treated as the error it is. A script error that comes back with a record you saved, created or deleted is shown next to the success. "No records match" (FileMaker error 401) is recognised by its code whether the server sent HTTP 404 or 500, so a batch export no longer fails on the empty last page. A bare 404 is explained as a wrong address, API path or disabled Data API instead of "metadata/script runner not supported", and is no longer cached as unsupported.
- [FIX] Connection failures now say what happened and what to do, whatever part of the extension hit them (Test Connection, Connect, the Explorer, Query Builder, batch jobs, the Script Runner and the AI tools share one mapping by Node error code). An expired or not-yet-valid certificate, a self-signed or privately signed one, a certificate for another name, a missing intermediate certificate, a wrong port (http vs https), old TLS, a refused connection, an unknown host, a timeout and a dropped connection each get their own message with a next step. **Retry** is offered only where trying again can help (not for certificates, and not for FileMaker's own errors such as 802 or a privilege refusal), and **Edit Profile** only for rejected credentials or a wrong database name, no longer for HTTP 403. Friendly text and advice for FileMaker error codes 9, 203, 208, 209, 400, 953, 959, 960, 1630 and 1700-1710 (and the earlier ones) is shared with the AI tools. A 429 or 503 `Retry-After` is read, and a gateway's HTML error page is cut down to short plain text in the error report.
- [FIX] The release job downloads the source-map artifact itself. Before, only the publish job did, so the GitHub release step would have failed after a successful Marketplace publish. The package job now fails if the build produces no source maps.
- [FIX] Connection wizard and TLS: a **Custom CA certificate file** is added to the system's trusted certificates instead of replacing them (before, setting one made every public-CA server fail); an edited or renewed CA file is picked up without restarting VS Code; editing a profile's database or API path (not only the address or user) resets its AI access to none. The AI status-bar click names the real reason when AI is off (offline mode, an untrusted workspace, enterprise policy, a feature switch, or no enabled connection).
- [FIX] The FM Web preview now says plainly when it cannot work. The Marketplace extension does not include the `runtime-next` and `shared` packages the preview app needs, and the generator used to fall back to a bare app with no bridge client that depended on a `shared` folder only the repository has. **Start FM Web Preview** and **Generate Next.js Runtime Template** now stop with a message that the preview needs the repository (or a run from source). Apps generated earlier get their bridge client, data hook and layout client refreshed to the current template (marked `fmweb-managed: runtime template v2`) when they are unmodified or carry an older marker, so the new session token is actually sent; an edited copy is left alone and named in a warning. `.env.local` is written through a temporary file, and refused if it is a symbolic link.
- [FIX] **Create Record** works. It opened the Record Editor in create mode, but the page had no way to create anything and the host rejected the message it would have sent. Create mode now lists the layout's fields (no record ID), has a **Create Record** button, checks the names against the layout and the field hints, asks in a modal naming the connection, layout and fields, sends only the fields you filled in, and shows the new record ID. It needs a trusted workspace, record editing switched on and offline mode off, like Save.
- [FIX] The notice and setting text for the secret-storage fallback no longer call it encryption: `workspace-state` keeps an obfuscated copy keyed from the machine id, which hides secrets from casual viewing but is not protection against anyone with local access.
- [FIX] Marketplace listing and manifest: the homepage and author links point to `https://abdenterprises.com` (the `?ref=vscode` form returned 404); virtual workspaces are declared unsupported (files are written to the workspace folder on disk); the untrusted-workspace description now says the AI tools are not registered there; settings with a fixed set of values (`connectionWizard.requireTestBeforeSave`, `secrets.fallback`, `savedQueries.scope`, `performance.mode`, `schema.snapshots.storage`, `enterprise.role`, both log levels) now explain each choice; the README says Claris and FileMaker are trademarks of Claris International Inc. and that the extension is independent.
- [FIX] Schema snapshot and offline-cache index entries for layouts whose name contains `..` (for example `Q1..Q2`) are no longer dropped as unsafe, so they are listed and pruned like any other. A file name is still refused if it has a path separator, a drive letter, a segment of `.` or `..`, or nothing but dots before `.json`.
- [FIX] Clicking the AI status bar item while AI tools are not on no longer sets the kill switch behind the scenes. Before, enabling AI afterwards left the tools off until you clicked again and confirmed a dialog; now the click explains how to turn AI on and changes nothing.
- [FIX] **Toggle Offline Mode** now switches the mode in your user settings. Before, it wrote the workspace scope, so it failed with no folder open and left a `.vscode/settings.json` in the repository. It also said "Offline mode disabled." when a setting elsewhere kept the mode on; it now reports the mode that is in effect and, if a workspace setting keeps it on, says so. A workspace's own `offline.mode: true` (in `.vscode/settings.json`) can no longer be cleared by the command, because the command only writes your user settings; edit or remove it in the workspace file.
- [FIX] Batch update from a CSV that the batch export wrote no longer sends `modId` (or `recordId`) to FileMaker as a field. Export writes `recordId` and `modId` before the fields; import treated every other column as a field, so re-importing an unedited export failed on the unknown field `modId`. Exactly those two columns (`recordId` and `modId`, case-sensitive) are now skipped; a field named `RecordID` or `ModId` is still a field. As before, a cell that looks like JSON or a plain number is sent as that value (a text field holding `12` becomes the number 12) and empty cells are skipped. A test now exports through the real writer and re-imports with the real parser.
- [FIX] The FM Web preview can now reach the bridge. The bridge has always required an `X-FM-Bridge-Token` header, but nothing sent it, so every request from the preview app was refused with 403. **Start FM Web Preview** now writes the bridge address and the per-session token to `.fmweb/generated/runtime-next/.env.local` (owner-only, with a `.gitignore` beside it that keeps it out of git; the token is never logged) and the generated client sends it. The client also no longer calls `fetch` detached from `window`, which browsers reject with "Illegal invocation". The bridge also refuses edit, create and delete when `filemaker.features.recordEdit.enabled` is off (user setting) or enterprise policy blocks record editing.
- [FIX] A find that matches nothing, or an offset past the last match, now returns an empty result. FileMaker reports that case as HTTP 404 with error 401, and the extension treated it as a failure, so an empty Query Builder result showed an error and a batch export failed on its final request whenever the match count was an exact multiple of the page size, or when nothing matched.
- [FIX] When a session expires, parallel requests now share one renewal instead of each opening its own FileMaker session. Before, five simultaneous requests opened five sessions and left four orphaned on the server until they timed out.
- [INTERNAL] Docs: remove the known-issue notes that #390 fixed (certificate messages and trust dialog, pinned-proxy message, FileMaker Cloud wording, 956 text), say that the FM Web preview commands are hidden when the template is not installed, and describe the managed preview-file refresh and the new script-error warnings for find and upload.
- [INTERNAL] Tests for the gaps reviews flagged: the AI flag in the About block, the build-identity time guard, the Layout Mode footer style properties, the workspace-trust listener of Effective Settings, redirects on every request path, the session-resume backstop, the pinned transport's proxy opt-out, and the template-hash guard that stops a managed runtime file changing without deciding about older copies.
- [INTERNAL] Documentation reconciled with certificate pinning, the settings view and About / Show Version: the user guide has a first-run path for FileMaker Server's default certificate, a rewritten Certificates section, the Test Connection ladder, sign-in pauses and status bar states, batch update behavior, and a rewritten Troubleshooting section linking the failure-mode catalogue; the catalogue's status note and symptom table are current; `extension/UPGRADE.md`, the smoke test (certificate pinning and proxy checks) and the settings table (three badges) are updated.
- [INTERNAL] Release 1.4.0 preparation: the release job now writes the release notes to a file and fails when they are empty (before, a failing notes script could create a release with empty notes), and `docs/JOB_AID_MANUAL_RELEASE.md` describes publishing by hand.
- [INTERNAL] No released version shipped the "Allow self-signed certificate" checkbox: the published build (89c5109) and the 1.3.0 package do not have it, and it first appeared in the 1.4.0 hardening work (#383), so replacing it with certificate pinning changes nothing for an installed 1.3.0. Profiles that already carry the older `allowSelfSigned` field (hand-edited) are still read.
- [INTERNAL] Documentation pass: the user guide is rewritten for 1.4 (first connection, profile templates, every feature, settings reference, troubleshooting, FAQ, and a section on using AI with FileMaker); the Marketplace README and root README are rewritten; `extension/UPGRADE.md` lists the 1.4 behavior changes; the release, cadence and rollback docs describe the current process, with a release checklist that covers non-code work, a manual-publish fallback and a smoke test (`extension/docs/QA/SMOKE_TEST.md`); the security policy is one file (`SECURITY.md`); and stale or duplicate docs are removed (cloud agent, roadmap, funding, marketing plan, install page, the v1.1.0 smoke test, the Marketplace-token job aid, and six FM Web pages merged into `extension/docs/FM_WEB.md`).
- [INTERNAL] Releases attach the external source maps (`sourcemaps-<tag>.tgz`) next to the VSIX so a stack trace from the minified bundle can be symbolicated; `docs/RELEASE.md` and `docs/BUNDLE_SIZE.md` now describe external maps, and `docs/DATA_HANDLING.md`, `docs/security.md` and ADR-0002 call the secret-store fallback obfuscation. The designer-ui build says to build `shared` when `shared/dist` is missing; the bridge compares its token in constant time.
- [INTERNAL] Stop tracking `artifacts/build.log`, `run.log` and `test.log` (local output) and ignore `artifacts/*.log`.
- [INTERNAL] The VSIX now carries `THIRD_PARTY_NOTICES.txt`: the licence text of every package bundled into it (axios and its dependencies, zod, React, and so on), generated by `npm run notices` from the real esbuild metafile and checked by `npm run notices:check` (part of `package:check`) and a unit test, which fail if a bundled package has no licence text or the file is stale. The VSIX also no longer includes `eslint.config.mjs`, `scripts/`, `docs/QA/` or `ARCHITECTURE.md`.
- [INTERNAL] Production build: `dist/extension.js` and the worker are now minified with an external source map that is kept out of the VSIX (it was 6.5 MB with an inline map), the Layout Mode UI bundle is built with `NODE_ENV=production`, minified and without source maps (no React development code), and the build fails with a clear message if the designer-ui bundle breaks (it still skips with a warning when only `extension/` was installed). The bundles are configured in one place, `scripts/esbuild-config.mjs`.
- [INTERNAL] Add `docs/FILEMAKER_FAILURE_MODES.md`, a maintainer catalogue of what goes wrong with FileMaker connections (certificates, network, sign-in, account privileges, server behaviour), what the extension shows today, the gaps found and the mock-server cases needed to test them. Documentation only.
- [INTERNAL] The release pipeline now publishes to the Marketplace with Microsoft Entra ID (a short-lived GitHub OIDC sign-in as a managed identity, `vsce publish --azure-credential`) instead of a personal access token, which Microsoft retires on 2026-12-01. One-time setup is in `docs/JOB_AID_ENTRA_PUBLISHING.md`; until it is done, upload the `.vsix` by hand.
- [INTERNAL] Propose how AI models in VS Code can use the Data API safely (ADR-0004): a generated schema-context file, language-model tools and an MCP server, read-only by default, with user confirmation for every write. Design only; nothing is built yet.
- [INTERNAL] Release pipeline hardening: Marketplace publishing is a separate job that waits for a `marketplace` environment, runs only for a tag on `main` that matches the extension version, and no longer runs `npm ci` while holding `VSCE_PAT` (vsce is installed from its own small lockfile in `tools/publish`, without install scripts). The GitHub release step, which needs write access, is its own job. A stray Claude Code session lock file is no longer tracked.
- [INTERNAL] Add a mock FileMaker Data API for local testing (`npm run mock:server`) and an end-to-end check that runs the real client against it (`npm run mock:check`, 25 checks). It mirrors the documented response shapes and error codes, so it can catch bugs that in-memory fakes cannot; it is not shipped in the extension.

## 1.3.0

- [SECURITY] Webview Content Security Policy nonces now come from the OS random number generator (`crypto.randomInt`) instead of `Math.random()`.
- [FIX] Changes to the enterprise, offline and performance settings are applied one at a time, so overlapping changes can no longer interleave role contexts and plugin reloads, and a failure is logged instead of left unhandled.
- [FIX] Remove the unused `filemaker.telemetry.enabled` setting. The extension collects no telemetry, and the setting did nothing.
- [INTERNAL] Published under the **SureForgeTech** Marketplace publisher (`SureForgeTech.filemaker-data-api-tools`); the source moved to github.com/SureForgeTech/filemaker-data-api-for-vs-code.

## 1.2.0

_First published to the VS Code Marketplace on 2026-10-17 by manual upload under the SureForgeTech publisher, built from main at 0895ca4. This version was never tagged in git._

- [FIX] Remove the **Export Connection Profiles** and **Import Connection Profiles** commands. They were listed in power-user mode but never implemented, so running them failed with "command not found". A test now activates the extension and fails if a contributed command is not registered.
- [FIX] A hand-edited `filemaker.defaultApiBasePath` or `filemaker.defaultApiVersionPath` (or its deprecated `filemakerDataApiTools.*` name) that is not a string, such as `2` or `null`, now falls back to the default (`/fmi/data`, `vLatest`) instead of throwing.
- [FIX] Settings renamed from `filemakerDataApiTools.*` to `filemaker.*` now resolve scope by scope, so a workspace or folder value wins over a user value whichever name it uses, and within one scope the new name wins. Before, any new-name value anywhere hid every old-name value, even a more specific one.
- [FEATURE] Query Builder: build finds with a form (field, condition, value, OR requests, omit, sort) alongside the JSON editor; open any result row in the Record Viewer or Editor; see "Showing 1–100 of N found"; sort the current page by column; copy results as a table; follow the VS Code theme; and run with Ctrl/Cmd+Enter. Paging now uses FileMaker's 1-based offsets, so the next page no longer repeats a record. "begins with" and "equals (whole field)" match from the start of the field, "contains phrase" finds the literal phrase, and symbols such as @ are matched literally. Commands use a FileMaker category with clearer titles, tree rows show at most two inline actions, settings are grouped into sections with one-click migration of deprecated keys, code generation and environment compare show progress, and the walkthrough adds layout inspection and code generation steps.
- [INTERNAL] Keep the generated-client compilation test independent of ambient package types and allow 30 seconds for its full TypeScript compile on shared CI runners.
- [FIX] Simplify profile and layout selection with searchable connection details, a setup action for missing profiles, and loading feedback; validate find inputs, honor cancellation, restore FM Web profile switching, and prevent stale connection-status updates.
- [INTERNAL] Consolidate command selection logic, correct test fixture types and checked array access, and include source and tests in the standard typecheck command.
- [FEATURE] Connection wizard now offers a **Connect Now** action immediately after a profile is saved, so first-run users flow straight from "saved" to an open session without hunting for **FileMaker: Connect** in the Command Palette. Editing an existing profile offers **Reconnect now** instead.

- [FEATURE] Added a Layout Inspector view that shows selected layout fields, portals, value lists, and field validation rules with refreshable session caching.

- Attributed the extension to ABD Enterprises in README and `package.json`:
  - new `author` field pointing at `https://abdenterprises.com`
  - `homepage` now resolves to `abdenterprises.com?ref=vscode` (with the GitHub repo still linked via `repository`)
  - README opens with an ABD attribution line and closes with a consulting-engagement table for users who need integration, migration, or modernization help

## 1.1.0

Major usability, accessibility, security, and reliability release.

### Onboarding

- Added a first-run Getting Started walkthrough (Add Profile → Test Connection → Query Builder) with screenshots and clear action verbs.
- Added a dedicated activity-bar container with a FileMaker icon.
- Added a Welcome view that surfaces **Add Connection Profile** / **Open Walkthrough** when no profiles exist (previously the empty state was buried behind always-present Environment Sets / Jobs roots).
- Connection wizard restored: fixed a crash on load caused by a missing `<form id="wizardForm">` wrapper. Save and Test Connection buttons are now reliably bound.
- Connection wizard collapses advanced server fields (`API Base Path`, `API Version`) under a `<details>` disclosure so first-time users see only what they need.
- Connection wizard shows live progress during Test Connection with phase-by-phase status.
- Walkthrough id computed from `context.extension.id` at runtime so a publisher rename can't silently break the walkthrough; the first-run flag is now only set after the walkthrough opens successfully.

### Connection / Status

- Added a persistent `$(plug) FileMaker: <profile>` status-bar item so you always know whether you're connected and to which profile. Click to open the Explorer.
- Proactive session-token refresh in `fmClient` keeps long-running sessions alive without manual reconnect.
- Exponential-backoff retry on transient login errors during Connect.
- Inline Test Connection result + save guard: badge shows untested / passed / failed / stale; configurable policy (`off` / `warn` / `block`) controls whether saving without a recent test is allowed.

### Errors & Recovery

- Error toasts now offer **Retry / Edit Profile / Open Settings** actions inline. Retry re-invokes the original command; Edit Profile reopens the wizard for the failing profile; Open Settings jumps to the relevant setting key.
- Structured error reports with the full request chain, redacted headers, and a one-click **Copy as Bug Report** action that produces a markdown report safe to paste into an issue.
- Graceful fallback in `secretStore` when VS Code SecretStorage is unavailable (AES-256-GCM PBKDF2 envelope).
- Offline-mode status-bar indicator with stale-cache awareness.
- Circuit-breaker registry plus **Show Circuit Breaker Status** command for diagnosing repeated failures.

### Accessibility

- Connection wizard required fields now mark `aria-required`, render a visible `*`, and link hints via `aria-describedby` so screen-reader users get full context.
- Authentication mode toggle exposes proper `aria-pressed` state.
- Password / username inputs include `autocomplete` hints.
- Focus management: focus lands on the first input on open; Query Builder focuses the profile select after init.

### Discoverability

- Command palette flood: ~33 commands gated behind context keys (`filemaker.hasProfiles`, `filemaker.hasSchemaSnapshots`, `filemaker.enterpriseMode`, `filemaker.advanced.powerUserMode`). New users see only what's relevant; advanced/diagnostic commands stay hidden until needed.
- Power-user mode setting unlocks plugin / circuit-breaker / diagnostics commands.

### Settings

- Deduplicated `filemakerDataApiTools.*` settings under the canonical `filemaker.*` namespace. Legacy keys now carry `markdownDeprecationMessage`; explicit values continue to be honored with a one-time deprecation toast pointing at the new key.
- Validation: `filemaker.schema.hashAlgorithm` is checked against `crypto.getHashes()` at activation; an unsupported value surfaces a toast instead of a silent fallback.
- Declared `capabilities.untrustedWorkspaces` so VS Code's built-in trust banner fires up front (instead of bespoke command-level toasts).

### Documentation

- Rewrote USER_GUIDE.md connection sections to match the actual webview UI (the previous copy described a quick-pick flow that no longer existed).
- Walkthrough markdown gained screenshots reused from the marketplace assets.
- Corrected an incorrect tip claiming profiles were workspace-scoped; profiles are global, only saved queries are workspace-scoped.

### Security & Reliability

- Token-bucket rate limit plus per-session request budget on the FM bridge server.
- Profile cache keys versioned (`v2::`) and include the normalized `serverUrl` to prevent cross-profile cache poisoning.
- Documented proxy threat model; minimized outbound profile payload.
- Structural validator for inbound webview messages.

### Performance

- Replaced 59 per-command `activationEvents` with `onStartupFinished` and lazy command registration.
- `batchExportFind` now streams CSV rows instead of buffering the entire result set.
- Refactored `fmClient` to extract `SessionTokenTracker` for clearer proactive-refresh state.

### Tests

- New unit-test coverage for `schemaService`, `batchService`, error-action selection, deprecated-setting tracking, command-resolution helpers, connection status bar, and webview structural assertions (catches the kind of HTML/JS mismatch that hid the wizard form bug).

## 1.0.0

Production release.

- Complete CRUD: find, get, create, edit, delete records
- Value list support with extraction and explorer integration
- Container field detection and URL resolution
- Portal data utilities with pagination parameters
- Global field support with payload builder/parser
- Compound find queries with omit support
- Duplicate record preparation with auto-enter field filtering
- 253 tests across 58 test files
- Coverage reporting with @vitest/coverage-v8
- Webview rendering stability (loading skeletons, targeted DOM updates, debouncing)
- Responsive CSS with fluid scaling and ARIA accessibility
- Enterprise role guards and workspace trust enforcement
- VS Code Marketplace publishing workflow in CI

## 0.9.0

- Global field support:
  - Added `buildGlobalFieldsPayload()` and `parseGlobalFieldsPayload()` utilities
  - Added `isValidGlobalFieldName()` validation
- Compound find support:
  - Added `buildCompoundFindQuery()` for multi-request finds with omit support
  - Added `parseCompoundFindQuery()` for parsing query arrays back to structured rows
  - Added `validateCompoundFind()` validation
- Duplicate record support:
  - Added `extractDuplicateFieldData()` and `prepareDuplicateFieldData()` utilities
  - Added `isLikelyAutoEnterField()` heuristic for excluding auto-enter fields
- Tests:
  - 10 global field tests, 7 compound find tests, 6 duplicate record tests
  - Total: 253 tests across 58 test files

## 0.8.0

- Portal support:
  - Added `extractPortals()` utility for structured portal data extraction from records
  - Added `extractPortalMetadata()` for parsing portal field metadata from layout info
  - Added `buildPortalParams()` for portal-aware find/get request parameters (limit, offset per portal)
  - Portal field names extracted and sorted, internal fields (recordId/modId) filtered
- Tests:
  - 12 portal utility tests (extraction, metadata, params, edge cases)
  - Total: 226 tests across 55 test files

## 0.7.0

- Value list support:
  - Added `ValueList` and `ValueListItem` types
  - Added `extractValueLists()` utility for parsing layout metadata
  - Value Lists group node in Explorer under each layout
  - Value list items displayed with item count
- Container field support:
  - Added `isContainerField()` utility for field type detection
  - Added `resolveContainerUrl()` for building full download URLs from relative paths
  - Added `isImageContainer()` for detecting image content types
- Tests:
  - 7 value list parser tests (extraction, edge cases, fallbacks)
  - 9 container field utility tests (detection, URL resolution, image detection)
  - Total: 214 tests across 54 test files

## 0.6.0

- Webview rendering stability:
  - Added loading skeleton states to all webviews (no more empty form flash)
  - Replaced full DOM rebuilds with targeted element updates in recordEditor, queryBuilder, recordViewer, scriptRunner
  - Added 200ms debounce to recordEditor field input handlers
  - Fixed layout thrashing in queryBuilder virtual table scroll handler (requestAnimationFrame)
  - Lowered virtualization threshold from 250 to 50 rows
  - Added fade-in transitions for schema diff sections
- Responsive CSS improvements:
  - Fluid max-width, clamp-based font sizing, fluid padding across all webviews
  - Removed fixed min-width on tables (horizontal scroll wrapper instead)
  - Added ARIA attributes for accessibility (aria-live, role=status)
- Test coverage expansion:
  - Added coverage reporting with @vitest/coverage-v8 and lcov output
  - Added ProxyClient unit tests (13 tests covering all public methods)
  - Added command handler tests (registration, common utils parsing)
  - Added webview HTML snapshot tests (CSP nonce, directives, DOM structure)
  - Added fmExplorer tree view tests (root nodes, profile children, refresh)
  - Added utility tests for errorUx, hash, jsonlWriter, csp
  - Added integration tests for createRecord and deleteRecord
  - Total: 191 tests across 52 test files
- Added Create Record support:
  - createRecord method in FMClient and ProxyClient
  - RecordEditor create mode (custom title, confirmation, success message with recordId)
  - FileMaker: Create Record command with layout picker
  - Explorer context menu on layout nodes
- Added Delete Record support:
  - deleteRecord method in FMClient and ProxyClient
  - FileMaker: Delete Record command with confirmation dialog
  - Deletion blocked for viewer role and untrusted workspaces
- Security:
  - Bumped axios 1.13.6 to 1.15.0 (SSRF and header injection fixes)
  - Bumped next 15.5.14 to 15.5.15 (DoS fix)
  - Added npm audit step to CI pipeline

## 0.5.1

- Fixed layout parsing for folder-based FileMaker layout payloads:
  - nested folder nodes are now flattened into selectable layout names
  - layouts under folders (for example `Assets`) now resolve correctly in Query Builder and Explorer
- Added tests for folder/nested layout parsing:
  - unit coverage for mixed layout structures
  - integration coverage for mocked `/layouts` folder responses
- Fixed VSIX packaging defaults:
  - removed `--no-dependencies` from package script to avoid missing runtime modules in installed VSIX files

## 0.5.0

- Quality/hardening release (no major new user-facing feature set).
- Added centralized settings service:
  - defaulting and validation/clamping for key settings
  - trust-aware defaults for snapshot storage/file output flows
- Added shared error infrastructure:
  - typed normalized error model (`src/types/errors.ts`)
  - shared `normalizeError()` utility
  - shared command error UX helper with `Details…` JSON document
- Added shared redaction utility and migrated logging call sites:
  - centralized token/password/header redaction
  - history/job/log pathways aligned on common redaction behavior
- Hardened webviews:
  - common CSP nonce builder
  - message validation helpers for inbound postMessage payloads
  - stricter CSP usage across webview surfaces
- Hardened data client behavior:
  - broader normalized error mapping (auth/server/network/timeout/cancellation)
  - cancellable proxy calls and improved propagation of abort signals
- Validation/sanitization improvements:
  - stronger profile input validation (URL/database/profile IDs)
  - safer output path/file-name handling for generated artifacts
- Testing expansion:
  - new unit tests for normalizeError, redact, settingsService, message validation
  - additional unit/integration coverage for fmClient headers and timeout/abort/non-JSON handling
- CI updates:
  - format check step
  - package validation step
  - stricter lint gate (`--max-warnings=0`)
- Documentation overhaul:
  - refreshed README and ARCHITECTURE
  - added CONTRIBUTING, SECURITY, UPGRADE guides

## 0.4.0

- Added enterprise governance foundations:
  - environment sets (`create/list/store`) for grouped profile workflows
  - cross-environment comparison service with layout presence matrix
  - layout diff across environments with field-level drift output
  - comparison export to JSON/Markdown
  - environment set explorer section and commands
- Added role-based feature controls:
  - `filemaker.enterprise.mode` and `filemaker.enterprise.role`
  - command-layer restriction enforcement (viewer/developer/admin)
  - locked profile handling via enterprise config policy
  - enterprise config parsing from `.vscode/filemaker.config.json`
- Added observability and diagnostics:
  - request tracing with `requestId`
  - rolling metrics store (latency, success/failure, re-auth, cache hit)
  - diagnostics dashboard webview
  - logger support for `filemaker.logging.level`
- Added high-scale performance hardening:
  - `filemaker.performance.mode`
  - high-scale batch export behavior (JSONL-first)
  - adaptive concurrency controller
  - retry/backoff for 429/5xx
  - circuit-breaker protection for repeated batch-update failures
- Added plugin architecture:
  - plugin contracts (`pluginTypes`)
  - plugin lifecycle and loading registry
  - internal + trusted workspace plugin loading
  - safe plugin API wrapper without SecretStorage exposure
  - plugin commands (`Reload Plugins`, `List Active Plugins`)
- Added offline metadata mode:
  - `filemaker.offline.mode`
  - persistent metadata cache store under `.vscode/filemaker/offline-metadata`
  - explorer offline badge
  - toggle offline mode and refresh cache commands
  - schema service cache fallback in offline mode
- Updated explorer structure:
  - `Environment Sets` root
  - `OFFLINE MODE` badge root item when enabled
- Expanded test coverage:
  - unit tests for role guard, environment compare, metrics, adaptive concurrency, circuit breaker, plugin registry, environment set store
  - integration tests for environment compare, offline mode, high-scale export behavior, role guard restrictions

## 0.3.0

- Added schema snapshots and schema diff workflows:
  - capture snapshots per profile/layout
  - workspaceState or workspace-files storage backend
  - diff two snapshots or diff current metadata vs latest snapshot
  - schema diff webview with added/removed/changed sections
  - optional Problems diagnostics publishing for drift detection
- Added type/snippet generation:
  - TypeScript layout artifacts generated into configurable output folder
  - field-name sanitization + mapping constants
  - metadata hash header for rerunnable generation traceability
  - VS Code snippet generation for find/get-record flows
- Added record editing write-back support:
  - new Record Editor webview
  - draft validation + dirty-state handling
  - preview patch JSON before save
  - partial update save via Data API edit endpoint
  - explicit save confirmation with rollback guidance
- Added batch operations + job runner:
  - batch find export with pagination (JSONL/CSV)
  - batch update from CSV/JSON with dry-run default
  - bounded concurrency execution and cancellation support
  - job progress/status tracking + status bar integration
  - persisted recent job summaries
- Hardening improvements:
  - improved cache keys (profile/database/api path aware)
  - best-effort ETag handling for metadata fetches
  - workspace trust gating for file-output and batch features
  - expanded settings surface for v0.3 features
- Added CI workflow:
  - npm install, lint, test, build
  - optional packaging step on tags
- Added tests:
  - unit tests for schema diff, name sanitize, type generation, job runner
  - integration tests for editRecord, snapshot+diff, batch export and batch update behavior

## 0.2.0

- Added Saved Queries v2:
  - workspace/global scope setting
  - schema versioning + migration from v0.1 format
  - run/open/manage/delete/export/import commands
  - explorer integration under profile nodes
- Added schema/field metadata browser:
  - `Fields` tree under layouts
  - metadata cache with TTL
  - graceful unsupported handling
  - refresh schema cache command
- Added Script Runner webview + command:
  - run scripts with layout/context inputs
  - copy as curl/fetch helpers
  - unsupported detection and UI guardrails
- Upgraded Query Builder:
  - load saved query defaults
  - save current query command integration
  - export JSON to editor/file and CSV to file
  - history panel
  - copy as curl/fetch with auth-inclusion toggle
- Added request history store + command (`Show Request History`)
- Added utilities:
  - JSON validation helper
  - CSV exporter
  - snippet generator with default auth redaction
- Added/expanded tests:
  - saved queries store
  - JSON validation
  - snippet redaction
  - CSV escaping
  - history ring buffer
  - schema metadata integration
  - script runner integration
  - saved query run integration

## 0.1.0

- Initial MVP release:
  - Connection profiles with secure secret handling
  - FileMaker Explorer tree view (profiles + layouts)
  - Query Builder and Record Viewer webviews
  - FileMaker Data API client with token lifecycle and 401 retry
  - Direct and proxy auth modes
  - Unit and integration tests (mocked HTTP)
