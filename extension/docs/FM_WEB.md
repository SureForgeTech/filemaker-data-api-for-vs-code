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
- **Runtime generation:** the extension copies the template app and the generated layout artifacts into `.fmweb/generated`. Generated files are deterministic and existing user-customized files are skipped.
- **Live data:** the Next.js app calls the extension's localhost bridge (`/fm/*`) for record and script operations. It keeps the found set and current record in session state and carries the record context between web layouts.

Design constraints: webviews never reach FileMaker directly; credentials never leave VS Code SecretStorage (only `FMClient` and `ProxyClient` read them); the bridge binds to localhost only.

## Project paths

| Path | Contents |
| --- | --- |
| `.fmweb/layouts` | Authored layout definitions |
| `.fmweb/metadata` | Synced FileMaker metadata cache |
| `.fmweb/generated/runtime-next` | Generated runtime app (its private `.env.local` holds the bridge URL and the session token) |
| `.fmweb/generated/layouts` | Generated runtime layout artifacts |

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
- accepts only `localhost` and `127.0.0.1` origins and JSON `POST` requests to `/fm/*` with validated payloads;
- caps the request body at 1 MB and applies a token-bucket rate limit and a per-session request budget (`filemaker.fmWeb.bridge.*` settings; throttled requests get HTTP 429 with `Retry-After`);
- serves only the active connection and rejects a request that names another profile;
- applies the user's own limits to changes: record changes (edit, create, delete) are refused in offline mode, when `filemaker.features.recordEdit.enabled` is off, and when the enterprise role or `disabledFeatures` disallow `writeOperations` or `recordEdit`; script runs are refused in offline mode, when `filemaker.features.scriptRunner.enabled` is off, and when they disallow `scriptRunner`.

The bridge never returns secrets. The token is written to a private `.env.local` in the generated app (as `NEXT_PUBLIC_FMWEB_BRIDGE_TOKEN`, together with the bridge URL), through a temporary file, and the write is refused if `.env.local` is a symbolic link; the generated client sends it in the header. Apps generated earlier get their managed runtime files (bridge client, data hook, layout client; marked `fmweb-managed: runtime template v2`) refreshed to the current template when they are unmodified or carry an older marker; an edited copy is left alone and named in a warning. The runtime keeps record context and found-set IDs in session storage, not credentials.

Threats and mitigations in short: remote access (loopback binding and socket check), cross-site requests (origin allow-list, JSON only, token), untrusted workspace content (trust required; the preview asks before it runs `npm install` and `npm run dev`), credential leakage (secrets stay in `FMClient`), resource exhaustion (body cap, rate limit, budget). Any local process that obtains the token can use the bridge as the runtime does; the token lives in extension host memory and in the private `.env.local`.

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
