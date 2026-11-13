# Data Handling

This document maps where the extension stores data, whether it is encrypted by
the extension, and when it is deleted. It is intended for enterprise security
and compliance review.

## Data Inventory

| Data category | Examples | Location | Format | Encryption | Retention and deletion |
| --- | --- | --- | --- | --- | --- |
| Connection profiles | Profile id, display name, server URL, database, auth mode, username, API path, proxy endpoint, AI access, custom CA file path, and (if you trusted a certificate) its SHA-256 fingerprint and whether an expired one was accepted | VS Code `globalState` under the extension profile store | JSON | Not encrypted by the extension. New profile objects cannot contain passwords, session tokens or proxy API keys. Legacy embedded URL credentials are retained until safe migration succeeds (see Security Notes). | Retained until the user deletes the profile or VS Code removes extension global state. Profile deletion closes the server session first, then clears local credentials, related saved queries and active-profile selection. |
| Credentials | FileMaker password, session token, proxy API key | VS Code `SecretStorage` by default; optional workspace-state fallback envelope when SecretStorage is unavailable and fallback mode is enabled | SecretStorage record, or an obfuscation envelope (AES-256-GCM with salt, IV, ciphertext and auth tag, keyed from the machine id) | Encrypted at rest by the OS-backed SecretStorage provider. The optional workspace-state fallback is **obfuscation only**: its key comes from the VS Code machine id, which is not secret, so it hides values from casual viewing but does not protect against anyone who can read the workspace state on this machine. | Deleted when the user deletes the profile. A successful SecretStorage write also removes any older fallback envelope for the same key. |
| Schema snapshots | Captured layout metadata, field metadata, script metadata, snapshot summaries | `.vscode/filemaker/snapshots/` in the workspace by default (`filemaker.schema.snapshots.storage` = `workspaceFiles`, trusted workspaces); VS Code `workspaceState` when that setting is `workspaceState` or the workspace is untrusted | JSON | Not encrypted by the extension. Schema metadata can reveal internal names and should be treated as internal project data. | Retained until explicitly pruned by the configured max snapshots per layout, deleted with workspace state, or removed with the workspace files. |
| Saved queries | Query name, profile id, database, layout, find JSON, sort JSON, limits, timestamps | VS Code `workspaceState` or `globalState`, selected by `filemaker.savedQueries.scope` | JSON | Not encrypted by the extension. | Retained until the user deletes the query, imports over it, deletes the related profile, or VS Code removes the selected state scope. |
| Cache | Runtime schema/layout metadata cache, in-flight request state | Extension host memory only | JavaScript objects | Not persisted. No at-rest encryption is applied because the data is not written to disk by the extension. | Cleared on extension host reload, process exit, profile invalidation, or TTL expiry. Schema cache TTL is bounded by `filemaker.schema.cacheTtlSeconds` and defaults to 300 seconds. |
| Offline metadata cache | Layout metadata (field names, types, value lists) the extension read while online, so it can be browsed in offline mode | `.vscode/filemaker/offline-metadata/` in the workspace (trusted workspaces only), with an `index.json` and a self-ignoring `.gitignore` | JSON and Git ignore rules | Not encrypted by the extension. Reveals internal names; do not commit to a public repository. | Refreshed by **FileMaker: Refresh Offline Metadata Cache** and whenever metadata is read online; the index keeps at most 1,000 items. Cached content is checksum-checked before use and ignored in untrusted folders. Deleted with the workspace files. The cache ignores itself in Git; schema snapshots are not ignored and remain available to commit. |
| Plugin approvals | Which workspace plugin folders you approved (workspace path and SHA-256 of the folder contents) | VS Code `globalState` | JSON | Not encrypted; contains no secrets. | Kept until VS Code removes extension global state. A changed folder is asked about again. |
| Audit logs | AI tool activity: tool, connection, layout, record ids, outcome, whether you confirmed | `ai-audit.log` in the extension's global storage folder (outside the workspace) | Text lines | Not encrypted. Field values are not logged. Model-supplied text is escaped and length-limited. | Capped at 256 KB; reads and refusals are dropped before write entries. Shown by **FileMaker: Show AI Activity**. There is no other durable audit-log file: request history and metrics are bounded VS Code `workspaceState`, and output-channel messages are transient IDE logs. |
| Test Connection credentials | Temporary password or proxy API key and throwaway session token | Extension host memory only for the test | In-memory values | Not persisted by Test Connection; saved secrets may be read for an unchanged profile | Throwaway session is closed after the test; saved profile secrets are unchanged. |
| FM Web project files | Layout definitions, synced metadata, generated runtime files and a non-secret `.env.local` notice | `.fmweb/` in the workspace | JSON and source files | Not encrypted; no live preview bridge token is saved here | Edited or added runtime files are left alone and listed as ignored by the private preview. Explicit regeneration deletes only after a modal names the files or folders and the user confirms. |
| FM Web private preview | Clean template, generated layouts, installed dependencies, private npm cache, empty `user.npmrc` and `global.npmrc`, `.fmweb-preview-owner` marker, `launch-used` state | System temporary folder, `fmweb-preview-*` | Source, package and state files | Private folder (owner-only modes on Unix; Windows uses the user's temporary-folder permissions); not encrypted | Process tree stopped and private files removed on cancellation or shutdown. Stale marked folders older than a day are removed only when their owning extension-host process no longer exists. |
| Preview credentials | Bridge token, single-use launch code, private session credential | Extension host and private preview server environment; launch code in the browser launch URL; session cookie in the browser | Random per-start values; HttpOnly, SameSite=Strict cookie | Not saved in workspace files or browser JavaScript; loopback HTTP is not encrypted | Launch expires after two minutes or first redemption; restart invalidates the previous launch and session. Keep the launch link private. |

## Data Flow

```text
VS Code commands and webviews
        |
        v
Extension host services
        |
        +--> Connection profile metadata --> VS Code globalState
        |
        +--> Passwords, tokens, proxy keys --> SecretStorage
        |                                      or obfuscated fallback envelope
        |
        +--> Saved queries -----------------> workspaceState or globalState
        |
        +--> Schema snapshots --------------> .vscode/filemaker/snapshots/
        |                                      (workspaceState if untrusted
        |                                      or configured)
        |
        +--> Runtime caches ----------------> extension host memory only
        |
        +--> Offline metadata --------------> .vscode/filemaker/offline-metadata/
        |
        +--> Direct/proxy API requests -----> configured FileMaker Data API
                                               or configured proxy endpoint
```

## Deletion Behavior

- Deleting a connection profile closes its server session first, then removes the profile metadata, clears the active
  profile selection when applicable, deletes credentials for that profile, and
  removes saved queries tied to that profile.
- Clearing VS Code extension state or removing a workspace can remove
  workspace-scoped records such as saved queries, history and metrics, and
  schema snapshots kept in `workspaceState` (untrusted workspaces, or when
  `filemaker.schema.snapshots.storage` is `workspaceState`).
- By default schema snapshots are files in `.vscode/filemaker/snapshots/` in
  the workspace. They are removed with the workspace files and should be
  deleted from the workspace when the project no longer needs them.
- Offline metadata cache files live in `.vscode/filemaker/offline-metadata/` and are deleted with the workspace files.
- The AI activity log and generated AI context file (default location) live in the extension's storage folder; removing the extension's global storage removes them.
- In-memory caches do not survive extension host restart or VS Code reload.
- Preview cancellation stops the process tree, removes private temporary files and clears legacy saved bridge address/token entries while preserving unrelated environment lines. The ownership marker prevents cleanup of unrecognized folders or folders whose owning process is still alive.

## Security Notes

- Secrets must stay out of profile metadata, saved queries, schema snapshots,
  diagnostics, request history and logs. In 1.9.0, saved server addresses with
  embedded credentials are cleaned only after any password is safely stored.
  Existing separately saved passwords are preserved. A warning asks the user to
  re-enter or confirm the credential in Edit Connection Profile. If secure
  storage is unavailable, the original entry remains for a later attempt.
- Connect warns once per profile per session before using remote plain HTTP.
  Certificate trust and Set AI Access follow locked profiles and write rules and
  are unavailable offline. Batch update follows record and write rules, checked
  per row; dry runs still write nothing and remain available offline.
- Untrusted folders cannot supply `.vscode/filemaker.config.json` or offline
  schema caches, or run environment and layout comparison. Trusted caches are
  checksum-checked before use; hash-setting changes do not invalidate intact data.
- Error text is shortened to one line with injected links broken, while bracketed
  codes and paths remain readable. Copied reports keep server text in code blocks.
  Record panels open container links only on the selected connection's own server.
  Suggested file names lose unsafe characters while keeping case and extension;
  exported layout and query names remain exact.
- Schema snapshots and saved queries are not encrypted. Treat exported or
  workspace-file copies as internal project artifacts.
- Normal record operations send API requests to the configured FileMaker server or
  proxy endpoint for the active profile. **Diagnose Connection** can also check a
  saved profile or a server address you type, without saving it or sending credentials.
  Its DNS, port and certificate probes connect directly; the Data API check uses the
  selected connection settings. For proxy profiles it checks the FileMaker server.
- **Test My Server** uses a separate temporary session and logs out afterwards.
  Read-only checks retrieve a record but omit its values from the report. Scratch-record
  writes and script execution require separate confirmation; cleanup is attempted
  even after cancellation. A failed cleanup names the scratch record to remove.
- FM Web asks before installing or starting its private preview and before any
  Layout Mode or preview button script. Script dialogs show the exact script,
  escaped parameter and connection host; hidden characters are visible and values
  too long to show in full are refused. Cancelling a script prompt runs no
  script. Cancelling preview startup clears its saved bridge address and token. AI and plugin approval
  dialogs also show hidden characters and refuse oversized values.
- Preview browser requests go to `127.0.0.1:3000`; the server adds the bridge token
  to requests to the local extension bridge. The launch link sets a private cookie
  checked on pages/assets and independently by the bridge route. Next.js
  development endpoints, such as live reload, are outside the cookie check.
- There are no new network destinations in 1.9.0. Preview installation still
  downloads dependencies from `registry.npmjs.org`, with install scripts disabled,
  empty npm configuration and a private cache. Each start resolves package versions
  with `npm install`; workspace npm configuration, overrides and edited runtime
  files stay unchanged and are not used by the private preview. Proxy variables
  and `NODE_EXTRA_CA_CERTS` pass through. Normal API and opted-in AI destinations
  remain as described here.
- Requests now have a 64 MiB response cap after decompression. Upload deadlines
  grow with file size, last at least `filemaker.requestTimeoutMs` and stop at
  30 minutes; stalled transfers stop. This does not reduce the separate container
  upload allowance. See [request and batch budgets](./security.md#filemaker-request-and-batch-budgets).
- These reports open as editor documents; they are not sent to a support service.
  Copying a diagnosis can hide its server address, port and revealing certificate details.
  Review organization-specific names before sharing either report. Jobs keep full
  changed, failed and untouched lists for the session; saved recent jobs retain all
  counts and at most 1,000 entries per list after restart.

## AI Context File

**FileMaker: Write AI Context** writes a Markdown file with database structure:
the connection name, database name, and the layout, field and script names you
select. It works without `filemaker.ai.enabled`, but still follows
`filemaker.features.ai.enabled`, enterprise AI policy and offline mode.
It contains no record data, value-list values, field descriptions,
server address, user name or credentials.

- It is written to the extension's storage folder by default, outside any
  repository. If you copy it into a workspace or point
  `filemaker.ai.contextPath` there, treat it as an internal project artifact and
  keep it out of public repositories.
- Names come from the database. Names are filtered (letters, digits, space and
  `_ - . : ( )`, 64 characters) and shown as JSON strings, but a name made only
  of allowed characters can still read like an instruction. An AI agent that
  loads the file can be influenced by it.
- Anything an AI tool reads, including this file, goes to the model provider
  you chose. The extension cannot control what that provider or the tool's other
  capabilities do with it.

## AI Tools

With `filemaker.ai.enabled` on (user settings only), language-model tools in VS Code can read the layouts, fields, scripts and records of the connection you chose, and with further switches change them (ADR-0004).

- **Data returned by a tool goes to the model provider you use.** The extension cannot control what the provider, or any shell, fetch or git tool the same agent has, does with it. Layout approval, the 500-record session quota and the 200 KB result cap reduce exposure; they do not remove it.
- **Field values and names are an uncontrolled text channel.** Values come back as JSON strings; layout and script names pass an allowlist (letters, digits, space and `_ - . : ( )`, 64 characters). Field names the model must send back unchanged are returned as they are (unless they contain control or separator characters), so a hostile field name can reach the model.
- **What is left out of results:** container fields, container streaming URLs and any value that points at the server's data API path (omitted), the server's own address and host (replaced; a user name is not removed from error text as a plain word), secrets that match the redaction patterns, and IP addresses, absolute file paths and host names in error text. Other text in a value is passed on as it is.
- **The hidden-field filter is best effort.** It applies to the AI tools and to the context file written by Write AI Context (which also says how many fields it left out, never which). `filemaker.ai.hiddenFields` matches by field name, case-insensitively, with or without a `Table::` prefix and with or without a repetition number such as `(2)`, on every layout. It cannot stop disclosure through a calculation or summary field on another layout, a script result, or a differently named field. A workspace file can add names but an agent with file-editing tools can edit workspace files, so keep your list, and enterprise settings, in user settings.
- **A restricted FileMaker account is the real control.** A dedicated account with a read-only privilege set is the only protection that does not depend on the model or on you.
- **Write dialogs show everything that is sent:** at most 10 fields, each new value up to 200 characters, all in full. A long old value is cut with a count. The whole dialog text is also limited to 4,000 characters (escaped characters take extra room), because a native dialog can clip a longer one. A write that cannot be shown this way is refused. The extension escapes control, bidirectional and markdown-significant characters in dialog text; the VS Code API documents `detail` only as "human-readable detail message" and does not say whether a modal renders markdown, so a bare web address in a value may still be linkified.
- The activity log is stored in the extension's storage folder, not the workspace, capped at 256 KB (reads and refusals are dropped before write entries). It records the tool, connection, layout, record ids, outcome and whether you confirmed. It does not record field values. Refused calls are logged at a limited rate.
- Secrets: tools never put the server address, user name or credentials in results; secrets in values and error text are redacted. Redaction can rewrite text in a field that looks like a secret, so writes refuse values containing the redaction marker.

## Chat Participant (@filemaker)

The `@filemaker` participant in VS Code's Chat view (ADR-0005) is another front end to the same AI tools, read only, under the same switches, approvals, limits, hidden fields and audit log (client name `chat participant`).

- **Sent to the language model chosen in the chat:** only for a `/find` written in plain words, one message with fixed instructions, the layout name, that layout's field names (hidden fields removed) and the user's own text. Never record values, connection or profile names, the server address, the user name or credentials. `/layouts`, `/describe`, `/explain` and a `/find` written as `Field=value` send nothing to a model.
- **Shown in the chat:** layout and field names, record values (up to 20 records, values cut at 200 characters) and errors, as plain text in code blocks. They stay in VS Code's chat history on this machine and can reach a model if later chat messages include that history; the extension cannot control that.
- **Not offered:** write and script tools are never offered to the model by the participant, whatever `allowWrites` and `allowScripts` say. Text the model writes is discarded; only a tool call that passes the tool's validation runs.
- **Not stored or sent by the extension:** no telemetry, no extra files.

## AI Server for External Tools (MCP)

When you run **FileMaker: Start/Stop AI Server for External Tools** in a window, a local server in that window lets MCP clients such as Claude Code and Cursor call the AI tools described above.

- **A permission, not a switch.** `filemaker.ai.externalServer.enabled` (user settings only) allows the feature and starts nothing. The server runs only in windows where you ran the command, and that command always asks in a dialog that says the server will start automatically when you reopen the workspace, so an agent or another extension cannot start it or make it persistent. VS Code remembers the start per workspace together with a permission epoch: the server starts again when you reopen that workspace while the setting is on, until you stop it there. Turning the setting off stops it everywhere and advances the epoch, which ends the automatic start for every workspace, also closed ones; turning the setting on again revives none of them.
- **Same rules, one implementation.** The server only passes `tools/list` and `tools/call` to the tool core; consent, caps, dialogs, hidden fields and the kill switch apply exactly as for VS Code's own agent mode. `tools/list` shows what the core offers at that moment.
- **Who can connect.** A Unix socket in a folder only you can use (mode 0700, socket 0600; the folder name includes a hash of the product's storage path, so VS Code, Insiders and Cursor do not share one), or on Windows an unguessable named pipe. Windows gives a Node-created pipe no promise of a user-only access list, so every connection must also send a per-session 256-bit token in a first message; the token is kept in a discovery file (mode 0600) in the extension's storage folder and checked in constant time. The discovery file also names the VS Code process and its start time; the shim connects only if that process is alive and is the same run, and only to a socket of the form this extension creates, so a stale or planted file cannot send the token to another program. Sockets left behind by a dead server are deleted only if nothing is listening on them (a connection attempt is refused), no discovery file names them and they are over 30 seconds old. If the process is alive but its start time cannot be read, the shim says it could not verify the window and the file is left in place. A program running as you can still read the discovery file, as it can read anything else of yours.
- **Limits.** 1 MiB per message and 4 MiB per second per connection, 8 authenticated connections plus a pool of 64 that have not yet authenticated (the oldest silent one is dropped for a new one, and a silent one is dropped after 1 second), 120 requests a minute per connection, 8 calls in flight per connection, 4 MiB of unsent output per connection, and idle connections closed after 15 minutes (never while a call is running).
- **Visibility.** A notification when an external program connects (at most one every 30 seconds) and the connection count in the status bar. The name an MCP client sends is its own claim and is only written to the activity log.
- **Cancelling.** If the client cancels or disconnects while one of your dialogs is open, you are told, and nothing is sent whatever you answer.
- **Data leaves for a different provider.** The model provider behind the MCP client is chosen in that client, not in VS Code. What a tool returns goes there.
- **Not supported:** remote windows (Dev Containers, Codespaces, SSH, WSL). The server will not start there.
- **The shim copy.** **Copy MCP Config** keeps a copy of the shim in the extension's storage, in a folder only you can use, so the config survives extension updates; the copy is checked (owner, mode, content hash) and a failed check leaves the config pointing into the extension folder.
- **Needs Node.js 18 or newer** on the PATH of the MCP client for the shim.
