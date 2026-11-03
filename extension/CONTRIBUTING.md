# Contributing

All contributors are expected to follow the project [Code of Conduct](../CODE_OF_CONDUCT.md). To report a vulnerability, follow the [security policy](../SECURITY.md) instead of opening an issue.

See the [adoption debt log](../docs/FILEMAKER_FAILURE_MODES.md#adoption-debt-verified-2026-10-21) for verified gaps, release targets and the next small checks.

## Set up

You need Git, Node.js 22 or newer, and npm. From the repository root:

```bash
npm ci
npm run build
npm test
```

`npm run setup` (or `./setup.sh` on macOS and Linux, `.\setup.ps1` or `setup.cmd` on Windows) installs dependencies in every workspace; add `--dry-run` (`node setup.mjs --dry-run`) to see what it would do.

Launch the extension host:

1. Open the repository in VS Code.
2. Press `F5`.
3. In the new window, run **FileMaker: Add Connection Profile**.

### A FileMaker server for testing

If you have no server, run the mock Data API (it is not shipped in the VSIX). It answers the server-level calls Test Connection makes (`/productInfo` and `/databases`), so Test Connection works against it: fill in the profile, select **Test Connection**, then **Save Profile** and **Connect**:

```bash
npm run mock:server -w extension     # http://127.0.0.1:18080, override with PORT
npm run mock:check -w extension      # runs the real client against it
```

Point a profile at `http://127.0.0.1:18080`, database `Sales`, account `tester`, password `testpass1`. Layouts are `Contacts` and `Invoices`. The mock can expire all sessions (`POST /__admin/expire`) to test session renewal. The header of `extension/test/mock-server/server.mjs` lists everything it does and where it only approximates FileMaker.

## Project conventions

- TypeScript strict mode is required. Avoid `any`; keep explicit types on API responses and message contracts.
- Keep secrets out of settings, state and logs.
- Use the shared utilities:
  - `utils/normalizeError.ts` for error normalization
  - `utils/redact.ts` for credential redaction
  - `utils/errorUx.ts` for command error UX with a "Details..." action
  - `services/settingsService.ts` for settings with defaults
  - `utils/policySetting.ts` and `enterprise/roleGuard.ts` for settings a repository may only make stricter
- Anything that comes from a repository (settings, files, templates) is untrusted. Policy a workspace can only restrict, never loosen.

## Adding commands

1. Add the command implementation under `src/commands/`.
2. Register it in `src/extension.ts`.
3. Add the command and menu contributions in `package.json`. A test fails if a contributed command is not registered.
4. Enforce the role guard and workspace trust where the command writes.
5. Add unit and integration tests.
6. Document the command in the [User Guide](docs/USER_GUIDE.md) using its exact title from `package.json`.

## Adding Data API endpoints

1. Add types in `src/types/dataApi.ts` and/or `src/types/fm.ts`.
2. Implement it in `src/services/fmClient.ts` using the existing request wrapper.
3. Add proxy passthrough in `src/services/proxyClient.ts`.
4. Propagate `AbortSignal` for cancellation.
5. Normalize errors with `normalizeError()`.
6. Redact sensitive values in logs and error details.
7. Add mocked integration tests in `test/integration/`, and extend the mock server if the endpoint matters to end-to-end checks.

## Documentation is part of the change

A pull request that changes what a user sees must update the docs in the same pull request:

- New or renamed command or setting: the [User Guide](docs/USER_GUIDE.md) (settings reference included).
- New prompt, changed default or changed behavior: [UPGRADE.md](UPGRADE.md) under the next version.
- Security or data-handling change: [docs/security.md](../docs/security.md) and [docs/DATA_HANDLING.md](../docs/DATA_HANDLING.md).
- User-visible change: a line in [CHANGELOG.md](CHANGELOG.md) under `## Unreleased`, and the one-line ledger entry in the root [CHANGELOG.md](../CHANGELOG.md).

The root changelog explains the labels (`[BREAKING]`, `[FEATURE]`, `[FIX]`, `[INTERNAL]`, `[SECURITY]`). The pull request title starts with `[major]`, `[minor]` or `[patch]` to match the highest label. Docs-only changes are `[patch]` with an `[INTERNAL]` entry.

## Testing

- **Unit tests**: helpers, stores, services, utilities, commands, tree view.
- **Integration tests**: mocked HTTP with `nock` for Data API contract behavior.
- **Snapshot tests**: webview HTML structure and CSP validation.
- **Mock server check**: `npm run mock:check -w extension`.

Run before submitting:

```bash
npm run lint            # zero warnings enforced
npm run typecheck       # tsc --noEmit for source and tests
npm test                # vitest
npm run test:coverage   # with coverage reporting
npm run build           # needed first on a clean checkout (the package check requires built packages)
npm run package:check   # validate the VSIX
```

Coverage floors are 82% lines, 81.5% statements, 80.5% functions and 76.5% branches, about two points below the measured result; raise them as tests improve.

CI (`build-test`) runs the same steps plus a dependency audit and a VSIX size check. See [docs/CI.md](../docs/CI.md).

## Code review checklist

- [ ] No secrets in settings, state or logs
- [ ] Error paths use `normalizeError()` and `showCommandError()`
- [ ] `AbortSignal` propagated where applicable
- [ ] Role guard and workspace trust checks in place for write operations
- [ ] A repository cannot loosen a restriction the user set
- [ ] Tests added for new functionality
- [ ] Lint, typecheck and all tests pass
- [ ] User Guide, UPGRADE.md and changelogs updated for anything a user will notice
