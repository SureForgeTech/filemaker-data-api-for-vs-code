# Frequently asked questions

Plain answers to the questions people ask most. The [User Guide](./USER_GUIDE.md) has the full details, and the [Troubleshooting page](./TROUBLESHOOTING.md) lists the common errors with the symptom, the cause and the fix steps.

## How do I install the extension?

Open the Extensions view in VS Code (`Cmd+Shift+X` on macOS, `Ctrl+Shift+X` on Windows and Linux), search for **FileMaker Data API Tools** (publisher **SureForgeTech**) and select **Install**. From a terminal you can run `code --install-extension SureForgeTech.filemaker-data-api-tools`. You need VS Code 1.96 or newer.

To install one particular version, download the `.vsix` from the [GitHub releases](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/releases) and run **Extensions: Install from VSIX...** in VS Code. A VSIX does not update itself; the Marketplace always has the newest build.

Before you connect, you need a FileMaker Server with the Data API enabled, an HTTPS address your computer can reach, and an account whose privilege set has the `fmrest` extended privilege ("Access via FileMaker Data API"). The FM Web preview is not part of the Marketplace build; use the repository if you want that preview. See [Before you start](./USER_GUIDE.md#before-you-start).

## Should I connect directly or through a proxy?

**Direct** means the extension talks straight to the FileMaker Data API. You enter the server address, the database name, the account name and the password, and your FileMaker account is the only identity involved.

**Proxy** means your team runs a middleware service in front of FileMaker. You enter the proxy endpoint, and the proxy API key if it needs one, instead of the FileMaker account. The proxy signs in to FileMaker on your behalf, and the extension never sees the FileMaker credentials in this mode.

Direct mode uses an account name and a password only: OAuth and single sign-on are not implemented, so if your organization needs another identity flow, put a compatible proxy in front. A proxy in the request path can see every action and every value that passes through it, so keep it on infrastructure you operate and give the proxy account only the privileges it needs. See the [security overview](../../docs/security.md).

## Where are my profiles and my saved queries kept?

A connection profile (the server address, database name, sign-in method and user name) is kept in your VS Code user data, so it follows you between workspaces and is not part of a project. A password is not part of the profile; it is kept separately (see the password question below).

Saved queries live in the workspace by default. Set `filemaker.savedQueries.scope` to `global` to keep them in your VS Code user data instead. Schema snapshots, the offline metadata cache and generated files (types, client, snippets) are written inside the workspace folder. The full list of what is stored where, and when it is deleted, is in [Data handling](../../docs/DATA_HANDLING.md).

## Can my team share a connection setup with me?

A repository can include `.filemaker/profile-template.json` to pre-fill the connection wizard for everyone who clones it. A template carries no secrets: a `password`, a `proxyApiKey`, a token or any unsupported field makes the extension ignore the whole template and show a warning, and everyone enters their own password in the wizard.

The extension ignores `.filemaker/profile-template.json` in an untrusted workspace. In a trusted workspace the wizard names the address on a banner and asks you to confirm before it saves or tests credentials against an address that came from the template.

The file comes from the repository you cloned, so review it like any repository file before you trust the workspace: it names the server your credentials would be sent to, and a cloned repository could name a server owned by someone else.

## Where is my password stored?

Passwords, API keys and session tokens are kept in your operating system's keychain; if you turn on `filemaker.secrets.fallback` = `workspace-state`, an obfuscated copy is stored in VS Code workspace storage instead, which is not protection against local access.

That storage is VS Code SecretStorage, which uses Keychain on macOS, Credential Manager on Windows and a keyring such as GNOME Keyring on Linux. Secrets are never written to settings, profiles, saved queries, snapshots or logs. If SecretStorage is not available (for example a Linux machine without a keyring), connecting fails with an error unless you turn the fallback on yourself. The setting is read from your user settings only, and the default is `vscode-only`.

## Can I use FileMaker Cloud?

FileMaker Cloud sign-in with a Claris ID is **not supported**: the extension has no Claris ID login. Whether a Cloud tenant accepts an account name and a password on the Data API is not confirmed, so ask Claris or your administrator before you plan around it.

If a connection fails, the [Troubleshooting page](./TROUBLESHOOTING.md) lists the common errors, including a FileMaker Cloud sign-in, with the symptom, the cause and the fix steps. Which server versions are targeted, and what is still unconfirmed, is in [Compatibility](./COMPATIBILITY.md).

## How do I run a script?

Run **FileMaker: Open Script Runner** (or use a layout's right-click menu), choose a profile and a layout, type the script name exactly as FileMaker lists it, add a record ID and a parameter if the script needs them, and select **Run Script**; the script's answer appears below the form. **Build Parameter** helps you put a JSON parameter together. The Script Runner does not ask you to confirm, so check the name before you run it.

Running scripts needs a trusted workspace. It is blocked in offline mode, for the `viewer` role, and when `filemaker.features.scriptRunner.enabled` is off. If a script is refused or fails, the [Troubleshooting page](./TROUBLESHOOTING.md) has the cause and the fix steps.

## How do I put a file into a container field?

Run **FileMaker: Upload to Container**, choose a profile and a layout, enter the record ID and the container field name, and pick the file. The default size limit is 100 MB (`filemaker.containerUploadMaxBytes`), and the upload needs a trusted workspace.

A container field is read-only in the Record Editor, which points you to this upload, and a container column is skipped by a batch update, so files always go through this separate action. If a container field shows only a URL instead of the file, the [Troubleshooting page](./TROUBLESHOOTING.md) explains what to check.

## Why is it slow, and what limits are there?

Batch work runs as a job. A batch update sends `filemaker.batch.concurrency` requests at a time (default 4, at most 10), and a batch export fetches page by page and stops at `filemaker.batch.maxRecords` records (default 10,000; the hard limit is 250,000). With `filemaker.performance.mode` set to `high-scale` an export is always written as JSONL.

Each Data API request times out after `filemaker.requestTimeoutMs` (default 15000 milliseconds). Sessions are renewed for you: a FileMaker Data API token expires after about 15 minutes of inactivity, and the extension renews it about 30 seconds early (`filemaker.session.refreshLeadSeconds`).

The FileMaker server has limits of its own. When it asks the extension to slow down, the extension waits for the server's `Retry-After` and tries again; the [Troubleshooting page](./TROUBLESHOOTING.md) covers what to do when a request is refused for that reason.

## What happens to my data?

FileMaker Data API requests go only to the FileMaker server or proxy you configured; everything else stays on your computer unless you use AI tools, whose provider receives the tool output you allow (see the AI question below).

The files written into your workspace, such as schema snapshots, the offline metadata cache and generated types, hold layout, field and script names, so keep them out of public repositories. The AI context file holds names only, never record data. Logs, request history and error details are redacted: passwords, tokens, API keys and authorization headers are hidden, and the request history keeps metadata rather than record bodies.

See the [security overview](../../docs/security.md) and [Data handling](../../docs/DATA_HANDLING.md) for the details.

## Does AI get my FileMaker data?

Only if you turn it on. The AI features are off by default (`filemaker.ai.enabled` is `false`, and it is read from your user settings only), and you choose the connection yourself with **FileMaker: Set AI Access for Connection**, where you pick Read or Write.

Anything a tool returns goes to the model provider that VS Code, or the MCP client behind it, uses, and the extension cannot control what that provider or the other tools of the same agent do with it. The extension applies its own limits: 50 records per call, 500 records per session, 30 calls a minute, 10 write attempts per session and 3 a minute, results capped at 200 KB, every write confirmed in a dialog, and hidden fields kept out with `filemaker.ai.hiddenFields`. The `AI: off` item in the status bar switches everything off at once.

The control that does not depend on the model is your FileMaker account: connect with a dedicated account whose privilege set is read-only. [Data handling](../../docs/DATA_HANDLING.md#ai-tools) has the full list of what is sent, kept out and limited.

## What license is the extension under?

MIT. The extension is free and open source. See [LICENSE](../../LICENSE).

## How can I contribute?

See [Contributing](../CONTRIBUTING.md). You need Git, Node.js 22 or newer and npm; from the repository root run `npm ci`, `npm run build` and `npm test`, then press `F5` in VS Code to open an Extension Development Host. If you have no FileMaker server, the repository includes a mock Data API that you can start with `npm run mock:server -w extension`.

A pull request that changes what a user sees has to update the documentation in the same pull request. Everyone is expected to follow the [Code of Conduct](../../CODE_OF_CONDUCT.md), and a suspected security problem goes to the [security policy](../../SECURITY.md) instead of a public issue.

## Does the extension collect telemetry?

No. There is no telemetry and no usage reporting of any kind, and the extension sends nothing to its authors. Its only destination is the FileMaker server or the proxy you configured, plus the AI model provider you choose yourself if you turn the AI features on.
