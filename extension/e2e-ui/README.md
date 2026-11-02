# Real VS Code UI end-to-end tests

These tests drive the **real VS Code desktop app** (downloaded by `@vscode/test-electron`) with the **built VSIX** installed,
against the **mock FileMaker Data API** (`../test/mock-server`), the way a user would: command palette, webview wizards and
panels, modal dialogs, status bar, Explorer, settings. They are not part of `npm test` or CI (they need a display and a
download of about 300 MB). CI runs the strict full suite weekly and before tagged releases; pull requests use the faster
unit/integration gates. Without a prerequisite the local runner prints why and exits 0.

## Run

```bash
npm ci                                  # repo root
npm run build -w shared                 # the production bundle needs shared/dist
cd extension && npm run package:check   # builds ../artifacts/filemaker-data-api-tools-<version>.vsix (the production bundle)
npm run test:e2e-ui                     # everything (about 55 minutes), report in ../artifacts/e2e-ui/<timestamp>/
E2E_ONLY=j02,j05 npm run test:e2e-ui    # some journeys (prefix match on the file name)
```

Environment: `E2E_ARTIFACTS` (output folder, default `<repo>/artifacts/e2e-ui/<timestamp>`, git-ignored: attach evidence
to a PR or release, never commit it), `E2E_VSCODE_VERSION` (default `stable`), `E2E_VSCODE_CACHE` (download cache, default
a per-user directory with mode 0700: `~/Library/Caches/filemaker-data-api-e2e-vscode` on macOS, `$XDG_CACHE_HOME` or
`~/.cache` elsewhere), `E2E_VSIX` (VSIX path), `E2E_ONLY` (journey prefixes), `E2E_CLAUDE=1` (see below).
On Linux without a display run `xvfb-run -a npm run test:e2e-ui`. The processes the suite starts (VS Code, the mock,
the MCP shim) get an allowlisted environment (`PATH`, `LANG`, `TMPDIR`, display variables): tokens and cloud credentials
in your shell (`GH_TOKEN`, `AWS_*`, `ANTHROPIC_*`) are not passed on.

**Download integrity.** On macOS with stable VS Code the harness downloads the build itself and checks its sha256 against
the field in VS Code's update API (a separate request from the download), refusing a mismatch; `E2E_VSCODE_SHA256` pins
a digest. Elsewhere, or for a pinned version, only the download server's own header is checked (`@vscode/test-electron`).

**CI.** A scheduled workflow runs the full strict suite on Ubuntu under `xvfb-run`, and tagged releases wait for it before
packaging/publishing. Reports, screenshots and VS Code logs are uploaded even on failure. The job has a 120-minute timeout
to allow for the VS Code download and the 25–55 minute run. Pull requests do not run this slow suite.

## What gates, and the known-findings list

The suite exits **0** when every failing step is listed in `e2e-ui/known-findings.json` (a finding the product still
has), and **1** when a step fails that is not listed (a regression or a new finding), when a journey crashes, or with
`E2E_STRICT=1` (every failure counts). After a run the console also lists known findings that now pass (remove them from the
file) and steps that asserted nothing.

To update the list after triaging the failures of a full run: `E2E_UPDATE_KNOWN=1 npm run test:e2e-ui` rewrites the entries
of the journeys that ran (so a partial `E2E_ONLY` run keeps the others). Review the diff of `known-findings.json` in the PR:
every added line is a failure someone accepted. Keys are `<journey> | <step name>`; renaming a step makes it new.

A step passes only if it called `assert` (or returned an explicit `{ result }`). A step that asserts nothing is reported as
a NOTE with `unasserted: true`, never as PASS, and is listed at the end of the run; use `s.step(..., fn, { observe: true })`
for a step that only records behaviour.

## Claude Code CLI (opt-in)

J10b can run the real `claude` CLI against the MCP server. It is **off by default**; set `E2E_CLAUDE=1`. It starts with an
allowlisted environment (`PATH`, `LANG`, `TMPDIR`, `HOME` and `CLAUDE_CONFIG_DIR` pointing at an empty temporary
directory), so no `ANTHROPIC_*`, `AWS_*` or `CLAUDE_CODE_USE_*` variable reaches it. Be aware that **`HOME` does not control
the macOS Keychain**: the CLI may still find credentials there. That is why this is opt-in and why the non-interactive
prompt step reports NOT-TESTABLE when the CLI says it is not logged in. Do not use your own login for this.

A VS Code window opens on your desktop while the tests run and takes focus; leave the machine alone. Everything the tests
create lives under one temp folder (user data, extensions, `HOME`, workspace), removed at the end; VS Code is started with
`--use-mock-keychain`, so the macOS Keychain and your own VS Code profile and extensions are never touched. Nothing is
signed in: the first-run "Welcome to VS Code / Sign in to GitHub Copilot" overlay is dismissed with "Continue without Signing In".

## Output

`report.md` / `report.json`: one row per step with the expectation, the result (PASS, FAIL, NOTE, NOT-TESTABLE), the
screenshot path and details. `screenshots/` has a PNG per step, `vscode-logs/` the VS Code and extension host logs.
A FAIL row is a finding: the detail says what was seen. Rows in the 13a/13b/13c journeys assert the _recommended_ behaviour
from `docs/FILEMAKER_FAILURE_MODES.md`, so a FAIL there confirms a gap.

## Why Playwright's Electron support (the harness decision)

| Option                                                | Verdict                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Playwright `_electron.launch` on the real VS Code | **Chosen.** One dependency (`playwright-core`, no browser download). The real desktop build, custom (DOM) dialogs via `window.dialogStyle: custom`, and `files.simpleDialog.enable` for open/save dialogs, so everything is scriptable. Webviews are nested iframes (`vscode-webview://.../fake.html`); `page.frames()` reaches them. Isolation by `--user-data-dir`, `--extensions-dir`, `HOME`. |
| (b) vscode-extension-tester (ExTester)                | Needs Selenium plus a chromedriver matching VS Code's Electron, a second download that breaks on every VS Code update. Its page objects do not cover the extension's webviews, so most steps would still be raw DOM. Slower.                                                                                                                                                                      |
| (c) `code serve-web` in a browser                     | Tests the web build, not the desktop app: no native secret storage, no OS dialogs, a different extension host. Several journeys (trust, MCP socket, kill -9 of the extension host) would not be the same code path.                                                                                                                                                                               |

Computer-use screen control cannot type into VS Code, so nothing here uses it.

## Layout

- `run.mjs` orchestrator; `lib/session.mjs` (launch, palette, pickers, modals, webview frames), `lib/flows.mjs`, `lib/observe.mjs`, `lib/mock.mjs`, `lib/report.mjs` (paths in the report are made relative), `lib/vscode.mjs` (cache and checksum), `known-findings.json`.
- `helper-extension/` a tiny test-only extension loaded with `--extensionDevelopmentPath`. It lets the harness call `vscode.lm.invokeTool`, read settings and list extensions through JSON files. It is never packaged (`.vscodeignore` excludes `e2e-ui/**`).
- `journeys/j*.mjs` the journeys (see the table in the PR description).
- `journeys/j16-marketplace-screenshots.mjs` is not a test: it takes the screenshots in `docs/marketplace/` (Marketplace page and User Guide) from the real VS Code against the mock, with made-up data. It does nothing unless `E2E_MARKETPLACE=1`; run it alone with `E2E_MARKETPLACE=1 E2E_ONLY=j16 E2E_SHOTS_DIR=<folder> npm run test:e2e-ui`, look at every image, and copy the ones you want into `docs/marketplace/`. The chat screenshot uses the harness's stand-in language model (see j10c).
