# FileMaker Data API Tools for VS Code

[![Marketplace version](https://vsmarketplacebadges.dev/version/SureForgeTech.filemaker-data-api-tools.svg)](https://marketplace.visualstudio.com/items?itemName=SureForgeTech.filemaker-data-api-tools) [![Marketplace installs](https://vsmarketplacebadges.dev/installs/SureForgeTech.filemaker-data-api-tools.svg)](https://marketplace.visualstudio.com/items?itemName=SureForgeTech.filemaker-data-api-tools) [![License: MIT](https://img.shields.io/github/license/SureForgeTech/filemaker-data-api-for-vs-code)](LICENSE)

A free, open-source VS Code extension for the FileMaker Data API: connect, query, edit records, compare schemas, export and update in batches, generate TypeScript types, and (optionally, off by default) give AI tools safe access, including a read-only `@filemaker` chat participant. MIT licensed, no telemetry.

Install it from the Marketplace: search for **FileMaker Data API Tools** (publisher SureForgeTech), or run `code --install-extension SureForgeTech.filemaker-data-api-tools`.

Version **1.8.0** adds a **Browse** button in the connection wizard for a custom CA certificate, clearer sign-in errors that say which of the two common causes applies and link to the fix, and the field-order and panel fixes listed in the changelog. See the [upgrade notes](extension/UPGRADE.md) before importing a file.

One real FileMaker server was exercised on **2026-10-21**, but its version was not recorded. No server version has a completed recorded smoke test; see [Compatibility](extension/docs/COMPATIBILITY.md). FileMaker Cloud sign-in with a Claris ID is **not supported**.

## Documentation

| I want to... | Read |
| --- | --- |
| Browse the website | [Documentation home](https://sureforgetech.github.io/filemaker-data-api-for-vs-code/), [User Guide](https://sureforgetech.github.io/filemaker-data-api-for-vs-code/guide/) and [Changelog by version](https://sureforgetech.github.io/filemaker-data-api-for-vs-code/changelog/) |
| Use the extension | [User Guide](extension/docs/USER_GUIDE.md) |
| Common questions | [FAQ](extension/docs/FAQ.md) |
| Fix a connection problem | [Troubleshooting](extension/docs/TROUBLESHOOTING.md) |
| Get help or report a bug | [Support](SUPPORT.md) |
| Check which FileMaker versions work | [Compatibility](extension/docs/COMPATIBILITY.md) |
| Upgrade between versions | [Upgrade notes](extension/UPGRADE.md) and the [Changelog](extension/CHANGELOG.md) |
| Understand security and data handling | [Security overview](docs/security.md), [Data handling](docs/DATA_HANDLING.md) |
| Report a vulnerability | [Security policy](SECURITY.md) |
| Contribute code or docs | [Contributing](extension/CONTRIBUTING.md), [Architecture](extension/ARCHITECTURE.md), [API reference](https://sureforgetech.github.io/filemaker-data-api-for-vs-code/api/) |
| Cut a release | [Release process](docs/RELEASE.md), [cadence](docs/RELEASE_CADENCE.md), [rollback](docs/ROLLBACK.md) |
| Understand a design decision | [Architecture decision records](docs/ADR/README.md) |

The Marketplace page is [extension/README.md](extension/README.md).

## For contributors

### Repository layout

| Folder | Contents | How the extension uses it |
| --- | --- | --- |
| `extension/` | The VS Code extension (published as `SureForgeTech.filemaker-data-api-tools`) | The extension itself. |
| `shared/` | Shared schema, types and renderer utilities | Imported by the extension and by both workspaces below. |
| `designer-ui/` | React webview app for FM Web Layout Mode | The Layout Mode bundle. `extension/scripts/build-designer-ui-if-available.mjs` builds it and copies it into the extension; the extension build fails when the bundle cannot be produced. |
| `runtime-next/` | Next.js runtime template for generated FM Web apps | The FM Web preview template. `fmWebRuntimeGenerator` (`extension/src/services/fmWebRuntimeGenerator.ts`) copies it into `.fmweb/generated/runtime-next` in your workspace. It is **not** part of the Marketplace VSIX, so a Marketplace install says plainly that the preview is unavailable rather than generating an app that cannot work. Run the extension from this repository to use the preview. |
| `docs/` | Maintainer, security and release documentation | — |
| `tools/` | Release helpers (`release-notes.sh`, the pinned `vsce` install) | — |

### Develop

Node.js 22 or newer is required.

```bash
npm ci
npm run build
npm test
```

Press `F5` in VS Code to open an Extension Development Host, then run **FileMaker: Add Connection Profile**. No FileMaker server? Run `npm run mock:server -w extension` and point a profile at the mock Data API described in [CONTRIBUTING.md](extension/CONTRIBUTING.md).

Useful root scripts: `npm run lint`, `npm run typecheck`, `npm run test:coverage`, `npm run docs:api` (TypeDoc into `docs/api`), `npm run docs:site` (website into `pages`; open `pages/index.html` to preview it), `npm run package:check` (run `npm run build` first; builds a VSIX into `artifacts/` and validates it). See [Contributing](extension/CONTRIBUTING.md) for the full checklist.

`npm run lint` covers every workspace: each one has its own ESLint setup (`shared/eslint.config.mjs`, `designer-ui/eslint.config.mjs`, `runtime-next/eslint.config.mjs` and the extension's own), so a change that breaks the lint of any of them fails the root gate. `npm run test:coverage` covers every workspace that has tests; `designer-ui/` and `runtime-next/` keep their coverage floors in their own Vitest configs and the floors may only go up, so a change that drops either below its floor fails the root gate, the same as a failing extension test. `shared/` has no tests of its own and takes part in the lint gate only.

The generated FM Web app in `.fmweb/generated/runtime-next` receives the app sources, not this repository's lint and coverage setup: it runs its own tests and does not lint itself.

## License

MIT. See [LICENSE](LICENSE).
