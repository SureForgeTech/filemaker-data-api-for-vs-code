# Release smoke test

A short manual pass to run on the build you are about to release (and again on the published version). It takes about 20 minutes. The release checklist in [docs/RELEASE.md](../../../docs/RELEASE.md) links here; record the result in the release pull request or in an issue made from the **QA: Smoke test** template.

## Set up

1. Use a clean VS Code profile so other extensions and settings do not interfere:
   ```bash
   code --user-data-dir /tmp/fm-smoke-user --extensions-dir /tmp/fm-smoke-ext
   ```
2. Install the build: `code --user-data-dir /tmp/fm-smoke-user --extensions-dir /tmp/fm-smoke-ext --install-extension artifacts/filemaker-data-api-tools-X.Y.Z.vsix` (or install from the Marketplace for the post-publish pass).
3. Pick a server:
   - **A real FileMaker Server** (HTTPS, an account with the `fmrest` extended privilege), or
   - **The mock Data API**: `npm run mock:server -w extension`, then use server `http://127.0.0.1:18080`, database `Sales`, account `tester`, password `testpass1`. Layouts are `Contacts` and `Invoices`. The mock approximates FileMaker; it does not prove behavior against a real server. The mock answers the server-level calls Test Connection makes (`GET /fmi/data/vLatest/productInfo` and `GET /fmi/data/vLatest/databases`), so **Test Connection passes all three steps against it**: the mock reports `FileMaker Data API Engine 22.0.1` and lists the databases it hosts (`Sales`, `Quality`, `Inventory`, `Locked`). Check 5 still needs a real FileMaker Server to confirm real-server behavior; check 14 (certificates) always needs one. Say which you used in the result.
4. Open an empty folder in VS Code and trust it.

## Checks

Tick each one. A failure in checks 1 to 15 blocks the release.

| # | Check | Expected |
| --- | --- | --- |
| 1 | Install | The extension shows as `FileMaker Data API Tools`, version X.Y.Z, publisher SureForgeTech. **FileMaker: About / Show Version** shows X.Y.Z and a build. The FileMaker icon is in the activity bar. |
| 2 | First run | The Getting Started walkthrough opens once, and its screenshots load. With no profile, the Connections view shows the welcome text with **Add Connection Profile**. |
| 3 | Command Palette | With no profile, typing `FileMaker:` lists only a short list of commands (for example add profile, getting started, user guide, diagnostics), not the data commands. |
| 4 | Wizard failure | **Add Connection Profile**, enter a bogus server, **Test Connection**: a red badge with a readable error. |
| 5 | Wizard success | Enter the real details, **Test Connection**: the progress names "Step 1 of 3" to "Step 3 of 3" and the result green (a wrong database name is answered with the names the server hosts). **Save Profile**, then **Connect Now** connects. The status bar shows `FileMaker: <profile>`. The mock passes this check; a real FileMaker Server is still needed to confirm the behavior of a real server. |
| 6 | Secrets | After saving, the password is not in `settings.json` or the Output channel. **Edit Connection Profile**, change the server address, **Save Profile**: the wizard asks for the password again. |
| 7 | Explorer | The profile expands to layouts, then Fields and Value Lists. |
| 8 | Query Builder | Open it on a layout, build a find with the form, **Run**. Results show with a found count. Paging, column sort and **Export > Save results as CSV…** work. A find that matches nothing shows an empty result, not an error. |
| 9 | Record Editor | Open a record, change a field, **Save**, confirm: the change appears. Then open the same record in two editors, save in one, and save in the other: the second save is refused and its form keeps the edit. |
| 10 | Batch | **Batch Export (Find)** to a `.csv` file works. **Batch Update from CSV/JSON** with **Dry-run only** shows a preview and changes nothing. |
| 11 | Schema | **Capture Schema Snapshot** twice, then **Diff Schema Snapshots** opens the diff. |
| 12 | Session | **Disconnect** changes the status bar and **Connect** works again. After the session is dropped (mock: `curl -X POST http://127.0.0.1:18080/__admin/expire`) the next find still succeeds. |
| 13 | Create Record | **Create Record** opens the editor in create mode with the layout's fields. Fill one field, select **Create Record**, confirm: the new record ID is shown and the record appears in a find. |
| 14 | Certificates | **Prerequisite:** leave VS Code's `http.proxySupport` at its default (`override`) for this whole check: trusting a fingerprint must work on direct connections with the default setting (repeat (a) and (c) once more with `fallback` and with `on` and expect the same results). Run all of these against test servers (a real FileMaker Server with its default certificate, plus a server with a private-CA certificate that names the host). (a) **Default certificate:** **Test Connection** shows **Trust this certificate for ...?** with the Subject, Issuer, Names, dates and SHA-256 as observed (record the exact Subject, Issuer and Names text you see in the result: expected `Claris Self Signed Certificate (Not for Production Use)` and `Claris Root Authority` with no names, but not yet confirmed on a real server); accepting re-runs the test to green; **Save Profile**, then **Connect** works on all requests (not only the first two). (b) **Decline** the dialog: the red message shows once and keeps a **Trust this certificate…** button. (c) **Changed certificate:** replace the server's certificate (or point the profile at a server with another one): the connection fails with "not the one you trusted" and the button reads **Review and re-trust**; nothing was sent to the server. (d) **Expired pin:** a pinned certificate past its end date is refused unless it was accepted with **Trust anyway, although it is not valid**. (e) **Custom CA file:** a bad path is rejected; a correct CA file for a server whose certificate names the host connects; a CA file alone does not fix the default certificate. (f) **Forget trusted certificate** removes the pin. (g) **Proxy case:** with `HTTPS_PROXY` set to any address that applies to the server, a pinned profile is refused before anything is sent with the message about a proxy; adding the host to `NO_PROXY` and restarting VS Code makes it connect. |
| 15 | MCP server | With `filemaker.ai.enabled` and a connection set to Read, run **Start/Stop AI Server for External Tools**: the confirmation dialog appears, the status bar item reads `AI: ... · MCP`, **Copy MCP Config for Claude Code / Cursor** copies a config, and a connected MCP client lists the tools. Run the command again to stop (no dialog); `· MCP` disappears from the status bar item. |
| 16 | Generated files | **Generate Types for Layout** writes a file under `filemaker-types/layouts/`. |
| 17 | Reload | **Developer: Reload Window**: the status bar item and the Connections view come back. |
| 18 | Untrusted workspace | In Restricted Mode, finds work; **Open Record Editor**, **Create Record**, **Edit Record by ID**, **Delete Record**, **Open Script Runner** and type generation are refused with a clear message. |
| 19 | Prompts | A file in `.vscode/filemaker-plugins/` asks before it runs. **Start FM Web Preview Server** (after **Initialize FM Web Project**) asks before running `npm` when run from the repository; in a Marketplace build the command is hidden from the Command Palette and, invoked another way, reports that the preview is not available in this installation. |
| 20 | AI default | The status bar shows `AI: off`. **Write AI Context** writes a file and offers to open it. With `filemaker.ai.enabled` off, no `fm_` tools are offered to the agent. |
| 21 | User guide | **FileMaker: Open User Guide** opens the guide. |
| 22 | Uninstall | Uninstalling removes the activity bar icon and the status bar items. |

## Result

Record the version, date, tester, VS Code version, operating system, real server or mock, pass or fail for each check, and links to any issues opened.

For a failure, open an issue titled `X.Y.Z QA: check N <short description>` with the redacted log (**View > Output > FileMaker Data API Tools**) or the **FileMaker: Show Diagnostics** report.
