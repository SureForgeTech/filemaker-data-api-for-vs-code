# FileMaker Data API Tools for VS Code

A free, open-source VS Code extension for the FileMaker Data API: connect, query, edit records, compare schemas, export and update in batches, generate TypeScript types, and (optionally, off by default) give AI tools safe access, including a read-only `@filemaker` chat participant. MIT licensed, no telemetry.

Install it from the Marketplace: search for **FileMaker Data API Tools** (publisher SureForgeTech), or run `code --install-extension SureForgeTech.filemaker-data-api-tools`.

Version **1.7.0** adds checks for newer changes before batch updates, read-only calculated fields in the editor, **List records instead** for an empty search, and **Test My Server** and **Diagnose Connection** to explain connection problems. Exports preserve text and record versions, and **Cancel Job** and **Show Jobs** are always available. See the [upgrade notes](extension/UPGRADE.md) before importing a file.

One real FileMaker server was exercised on **2026-10-21**, but its version was not recorded. No server version has a completed recorded smoke test; see [Compatibility](extension/docs/COMPATIBILITY.md). FileMaker Cloud sign-in with a Claris ID is **not supported**.

## Documentation

| I want to... | Read |
| --- | --- |
| Browse the website | [Documentation home](https://sureforgetech.github.io/filemaker-data-api-for-vs-code/), [User Guide](https://sureforgetech.github.io/filemaker-data-api-for-vs-code/guide/) and [Changelog by version](https://sureforgetech.github.io/filemaker-data-api-for-vs-code/changelog/) |
| Use the extension | [User Guide](extension/docs/USER_GUIDE.md) |
| Get help or report a bug | [Support](SUPPORT.md) |
| Check which FileMaker versions work | [Compatibility](extension/docs/COMPATIBILITY.md) |
| Upgrade between versions | [Upgrade notes](extension/UPGRADE.md) and the [Changelog](extension/CHANGELOG.md) |
| Understand security and data handling | [Security overview](docs/security.md), [Data handling](docs/DATA_HANDLING.md) |
| Report a vulnerability | [Security policy](SECURITY.md) |
| Contribute code or docs | [Contributing](extension/CONTRIBUTING.md), [Architecture](extension/ARCHITECTURE.md), [API reference](https://sureforgetech.github.io/filemaker-data-api-for-vs-code/api/) |
| Cut a release | [Release process](docs/RELEASE.md), [cadence](docs/RELEASE_CADENCE.md), [rollback](docs/ROLLBACK.md) |
| Understand a design decision | [Architecture decision records](docs/ADR/README.md) |

The Marketplace page is [extension/README.md](extension/README.md).

## Repository layout

| Folder | Contents | How the extension uses it |
| --- | --- | --- |
| `extension/` | The VS Code extension (published as `SureForgeTech.filemaker-data-api-tools`) | The extension itself. |
| `shared/` | Shared schema, types and renderer utilities | Imported by the extension and by both workspaces below. |
| `designer-ui/` | React webview app for FM Web Layout Mode | The Layout Mode bundle. `extension/scripts/build-designer-ui-if-available.mjs` builds it and copies it into the extension; the extension build fails when the bundle cannot be produced. |
| `runtime-next/` | Next.js runtime template for generated FM Web apps | The FM Web preview template. `fmWebRuntimeGenerator` (`extension/src/services/fmWebRuntimeGenerator.ts`) copies it into `.fmweb/generated/runtime-next` in your workspace. It is **not** part of the Marketplace VSIX, so a Marketplace install says plainly that the preview is unavailable rather than generating an app that cannot work. Run the extension from this repository to use the preview. |
| `docs/` | Maintainer, security and release documentation | — |
| `tools/` | Release helpers (`release-notes.sh`, the pinned `vsce` install) | — |

## Develop

Node.js 22 or newer is required.

```bash
npm ci
npm run build
npm test
```

Press `F5` in VS Code to open an Extension Development Host, then run **FileMaker: Add Connection Profile**. No FileMaker server? Run `npm run mock:server -w extension` and point a profile at the mock Data API described in [CONTRIBUTING.md](extension/CONTRIBUTING.md).

Useful root scripts: `npm run lint`, `npm run typecheck`, `npm run test:coverage`, `npm run docs:api` (TypeDoc into `docs/api`), `npm run docs:site` (website into `pages`; open `pages/index.html` to preview it), `npm run package:check` (run `npm run build` first; builds a VSIX into `artifacts/` and validates it). See [Contributing](extension/CONTRIBUTING.md) for the full checklist.

`npm run lint` and `npm run test:coverage` cover every workspace, `designer-ui/` and `runtime-next/` included. Each workspace has its own ESLint setup (`designer-ui/eslint.config.mjs`, `runtime-next/eslint.config.mjs`) and its own coverage floors in its Vitest config; the floors may only go up. A change in either workspace that breaks its lint or drops its coverage below the floor fails the root gate, the same as a failing extension test.

## License

MIT. See [LICENSE](LICENSE).
