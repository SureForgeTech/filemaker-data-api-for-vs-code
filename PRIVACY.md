# Privacy Policy

This policy covers the FileMaker Data API Tools extension for VS Code. It is written for the people who install it and for the teams that review it. The extension is a local tool: it has no account, no servers of its own, and no analytics.

## What the extension stores locally

Everything the extension keeps stays on your machine — in VS Code's own state, the operating system's keychain, and files in your workspace:

- Connection profiles — profile name, username, server URL, database, API path, authentication mode, proxy endpoint, certificate settings (CA bundle path, pinned certificate) and whether the optional AI features are enabled for it — live in VS Code's extension state (`globalState`). Profile objects contain no passwords, session tokens or proxy API keys.
- Passwords, FileMaker session tokens and proxy API keys live in VS Code `SecretStorage`, which on desktop platforms is your operating system's keychain. If `SecretStorage` is unavailable and you explicitly configure the `filemaker.secrets.fallback` setting, secrets fall back to workspace state with obfuscation rather than encryption; the default is `vscode-only`.
- Saved queries, schema snapshots, environment sets, request history and dismissed notices live in workspace state or workspace files, depending on the feature; saved queries move to VS Code's global state when `filemaker.savedQueries.scope` is `global`.
- Nothing is sent to the extension's authors: no telemetry, no usage data and no crash reports leave your machine. Locally, the extension does keep a bounded request history and a diagnostics record (`FileMaker: Show Request History` and `FileMaker: Show Diagnostics`) in workspace state.

## What never leaves your machine

- Your credentials are sent only to the FileMaker server you configured — never to the extension's authors.
- There is no analytics, no crash reporting, no advertising identifier and no account to sign in to.
- Logs, history and error details hide authorization headers, tokens and passwords.

## The proxy exception

In proxy mode you opt in to routing requests through your own middleware. The extension never sees the FileMaker credentials in this mode: your middleware authenticates with FileMaker on your behalf. What travels from the extension to your middleware is the request itself, the profile's connection details (profile id, database, server URL and API paths) and your proxy API key.

## Third parties

- The only service the extension talks to by default is the FileMaker Server you configured.
- If you switch on the optional AI features (off by default), the data you approve — layout and script names, and record values within the session limits — goes to the model provider you configured (Anthropic or another provider, reached through the provider's own client or API). The extension does not choose or contact a provider on its own.

## GDPR and CCPA

- Under GDPR and CCPA the extension collects no personal data for its authors, does not sell anything and shares nothing; there is no vendor-side profile of you to disclose.
- Whatever it stores lives on your machine, under your control. Deleting a profile removes its metadata, its credentials and its saved queries. Request history, diagnostics, schema snapshots, environment sets and the AI activity log are separate: they are removed by clearing the extension's state or the workspace files (see the [data handling notes](docs/DATA_HANDLING.md)), and uninstalling the extension does not remove them by itself.
- Requests about data your organisation holds go to your organisation. Questions about the extension itself are below.

## Questions about this policy

Send privacy questions through the channels in the [security policy](SECURITY.md); the same routes reach the maintainers.
