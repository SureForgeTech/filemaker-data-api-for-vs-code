# FM Web reference

Reference for the FM Web workflow (Layout Mode, generated Next.js runtime and the local bridge). For the steps a user follows, see [FM Web and Layout Mode](./USER_GUIDE.md#fm-web-and-layout-mode) in the user guide. FM Web is experimental.

## Architecture

Four layers:

1. VS Code extension services (`fmWebProjectService`, `fmWebRuntimeGenerator`, `fmBridgeServer`).
2. The Layout Mode webview (the designer, from `designer-ui/`).
3. The generated Next.js runtime (`.fmweb/generated/runtime-next`, from `runtime-next/`).
4. The shared renderer and schema package (`@fmweb/shared`, from `shared/`).

Flows:

- **Layout authoring:** the webview edits `LayoutDefinition` JSON in `.fmweb/layouts`.
- **Metadata sync:** the extension pulls layouts, fields and script names into `.fmweb/metadata`.
- **Runtime generation:** the extension copies the template app and the generated layout artifacts into `.fmweb/generated`. Recognized untouched files refresh; edited files are kept. Only the explicit generation command offers deletion after a named confirmation.
- **Live data:** the Next.js app calls the extension's localhost bridge (`/fm/*`) for record and script operations. It keeps the found set and current record in session state and carries the record context between web layouts.

Design constraints: webviews never reach FileMaker directly; FileMaker credentials stay in the extension host; the bridge binds to loopback only. The browser calls a route on the private preview server, which adds the bridge token server-side.

## Project paths

| Path | Contents |
| --- | --- |
| `.fmweb/layouts` | Authored layout definitions |
| `.fmweb/metadata` | Synced FileMaker metadata cache |
| `.fmweb/generated/runtime-next` | Generated runtime app; `.env.local` contains only a non-secret notice, not live preview credentials |
| `.fmweb/generated/layouts` | Generated runtime layout artifacts |
| System temporary folder: `fmweb-preview-*` | Private running copy, dependencies, npm cache, empty npm config files, `.fmweb-preview-owner` ownership marker and `launch-used` single-use launch state |

## Layout schema

`LayoutDefinition` is versioned and validated with Zod (`extension/src/fmweb/layoutSchema.ts`).

Top level: `schemaVersion`, `id`, `name`, `fmLayoutName`, `canvas { width, height, gridSize }`, `objects[]`, `styles`.

Object types: `field`, `text`, `button`, `portal`, `rectangle`, `image`, `tabPanel`.

Every object may carry a `behavior`: `runScript`, `goToWebLayout`, `goToFmLayout`, `openUrl` or `showDialog`, with the extra fields `scriptName`, `targetLayoutId`, `targetFmLayoutName`, `url`, `dialogId` and `parameter`.

`migrateLayoutDefinition` migrates older schema versions to the current one. A newer, unknown schema version is rejected rather than parsed down-level.

## Bridge security

The bridge (`fmBridgeServer`) is started by **FileMaker: Start FM Web Preview Server**. It:

- binds to `127.0.0.1` on a random port and rejects non-loopback peers;
- requires a trusted workspace;
- requires a 256-bit per-session token in the `X-FM-Bridge-Token` header, generated when the bridge starts and discarded when it stops, and compares it in constant time;
- accepts only `http://localhost:3000` and `http://127.0.0.1:3000` origins and JSON `POST` requests to `/fm/*` with validated payloads;
- caps the request body at 1 MB and applies a token-bucket rate limit and a per-session request budget (User-only settings `filemaker.fmWeb.bridge.rateLimitPerSecond`, `filemaker.fmWeb.bridge.rateLimitBurst` and `filemaker.fmWeb.bridge.requestBudget`; workspace values are ignored; throttled requests get HTTP 429 with `Retry-After`);
- serves only the active connection and rejects a request that names another profile;
- applies the user's own limits to changes: record changes (edit, create, delete) are refused in offline mode, when `filemaker.features.recordEdit.enabled` is off, and when the enterprise role or `disabledFeatures` disallow `writeOperations` or `recordEdit`; script runs are refused in offline mode, when `filemaker.features.scriptRunner.enabled` is off, and when they disallow `scriptRunner`.

The bridge never returns secrets. Its token stays in extension-host memory and the private server's `FMWEB_BRIDGE_TOKEN` environment variable. It is never a `NEXT_PUBLIC_` value or sent to browser JavaScript. The browser calls `/api/bridge/<route>`; that route checks the private session cookie, Host and exact Origin before adding the token. It does not forward browser credentials or upstream headers. Record context and found-set IDs stay in session storage, without credentials.

The preview app binds only to `127.0.0.1:3000`. VS Code opens a private launch link valid for two minutes. Redeeming it once sets an HttpOnly, SameSite=Strict session cookie and redirects to `/` without the code. A private `launch-used` file prevents reuse across workers. Pages and assets need the cookie; the bridge route checks it independently. Only `127.0.0.1:3000` and `localhost:3000` Host values are accepted. Restarting invalidates the old launch and session. A busy port is an error; it does not open the service already using that port. **Known limit:** Next.js development endpoints such as live reload are outside the cookie check. Keep launch links private; software running as you, administrators and downloaded packages remain outside this protection.

Before installing or starting, a VS Code dialog describes the commands and lists edited or added runtime files that will be ignored. The preview runs a clean private temporary copy of the shipped template and generated layouts. Your `.npmrc`, `.env*` overrides, custom runtime files, lockfiles, `node_modules` and build output are left alone and not used. A layout with an edited or linked generated file is skipped with a warning. Starting does not delete your files.

Installation uses `npm install --ignore-scripts --no-audit --no-fund` against `registry.npmjs.org`, with separate empty user/global configuration, an explicit prefix, a private npm cache and a limited environment. The template dev script runs with npm pre/post scripts disabled. Your npm configuration is left unchanged; proxy variables and `NODE_EXTRA_CA_CERTS` pass through for company networks. **Known limit:** `npm install` resolves package versions at each start; the private preview does not reuse a workspace lockfile. No install scripts run; a failed install stops startup.

Only **FileMaker: Generate FM Web Next.js App** offers **Regenerate from template**, with a modal naming exactly which files or folders (including their contents) will be deleted. Confirm to delete those names; cancel to keep them. Otherwise generation refreshes recognized untouched files and warns about edited or linked files it keeps.

Before every script run from Layout Mode or a preview button, VS Code shows the script, layout, escaped parameter, its length and connection host. Hidden characters are visible escapes; a value too long to display in full is refused. Only one preview script prompt can be open, with a five-second cooldown after closing. Cancelling a script prompt runs no script. Cancelling preview startup clears its saved bridge address and token while preserving unrelated `.env` lines. Script names and parameters are sent exactly as supplied. Link actions accept only HTTP and HTTPS.

Private temporary folders contain a `.fmweb-preview-owner` marker naming the owning extension-host process. Cancellation or shutdown stops the process tree and removes private files. Stale marked folders older than a day are removed only if their owning process no longer exists; an open window's folder is left alone. On Windows, the preview searches absolute PATH entries for `node.exe` and `node_modules\npm\bin\npm-cli.js` (the standard Node.js installer layout); these can be in separate entries. A version manager such as nvm-windows works only if its PATH entries expose both files in those locations; a non-standard npm location may produce **Could not find Node.js and npm on PATH**. On macOS and Linux, the preview runs `npm` from PATH. No command shell or console window opens. If startup says **Could not find Node.js and npm on PATH**, install Node.js with npm and restart VS Code. Cancellation also stops the Windows process tree.

These changes add no new network destinations: the preview still reaches the public npm registry for dependencies, the local bridge, and through it the configured FileMaker server or proxy. It does not send data to the extension authors.

## What the Marketplace build contains

The Marketplace extension does not include the `runtime-next` and `shared` packages the preview app needs. In that installation **Start FM Web Preview Server** and **Generate FM Web Next.js App** are hidden from the Command Palette; invoked another way they stop with "The FM Web preview is not available in this installation" and point at the repository. When you rerun them in an installation that has the template, files the extension keeps current in an earlier app are refreshed, except files you edited and symbolic links, which are left alone and named in a warning. Layout Mode, metadata sync and layout files work everywhere. Do not promise the preview to Marketplace users.

## Develop and test

```bash
npm ci                # repository root
npm run build
npm run typecheck
npm test
npm run lint
```

Press `F5` to open an Extension Development Host and run the FM Web commands from the Command Palette: **Initialize FM Web Project**, **Select Active Profile**, **Sync FM Web Project Metadata**, **Open FM Web Layout Mode**, **Generate FM Web Next.js App**, **Generate FM Web Layout Page**, **Start FM Web Preview Server**.
