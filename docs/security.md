# Security and Trust Model

This document captures the trust boundaries inside the FileMaker Data API
Tools extension and what each boundary protects (or doesn't). To report a
vulnerability, see the [security policy](../SECURITY.md). For where data is
stored and for how long, see [DATA_HANDLING.md](./DATA_HANDLING.md).

## Principles

- **Secrets stay in the host.** Passwords, API keys and session tokens are read
  only by the extension host's client code. Webviews never receive them and
  never call FileMaker directly.
- **A repository is untrusted input.** Settings, templates, plugin folders,
  layout files and generated runtime folders can arrive with a clone. They may
  make the extension stricter, never looser, and anything that runs code or
  sends credentials needs the user's confirmation.
- **Confirm what is risky, in the host.** Dialogs are built by the extension,
  not by a webview, a plugin or an AI tool.
- **No telemetry.** The extension talks only to the configured FileMaker
  server or proxy.

## Connection profiles

A connection profile contains a server URL, database name, auth mode,
and either a username (direct auth) or a proxy endpoint (proxy auth).
Passwords, session tokens, and proxy API keys are stored separately in
`SecretStore`, which prefers VS Code's `SecretStorage` (OS keychain)
and, only if you choose `filemaker.secrets.fallback` = `workspace-state`,
falls back to an AES-256-GCM envelope in workspace state when SecretStorage is
unavailable. That fallback is obfuscated, not protection against anyone with
local access to VS Code state: its key derives from the machine ID.

## Direct mode

In direct mode the extension talks straight to the FileMaker Data API
using Basic auth on `POST /sessions` and a Bearer token on subsequent
requests. The trust boundary is the user's FileMaker credentials and
the TLS connection to the server. There is no third party in the
request path.

### Server certificates

The server certificate is verified the normal way against Node's trusted
list, the operating system's store (where VS Code's Node can read it) and
`NODE_EXTRA_CA_CERTS`, plus an optional per-profile CA file. A user can
instead trust one specific certificate by its SHA-256 fingerprint
("pinning"): the connection then accepts exactly that certificate (host name
and issuer checks are skipped for it only), refuses it when it has expired
unless the user accepted that, and fails hard with a re-trust prompt when
the server presents a different one. In 1.7.0 the extension checks a trusted fingerprint on direct connections with every
`http.proxySupport` value, including VS Code's default, `override` (see the User Guide, Certificates). For a verified or pinned profile nothing
is sent to the server before its certificate is checked; a profile that still
has the older allow-self-signed setting skips every check when its agent is used.
Legacy profiles go direct unless an environment proxy applies; on that route VS Code
may still replace their certificate handling. CA-only profiles retain their existing proxy routing. A pinned connection is never made through an
HTTP proxy (the request is refused before anything is sent when an
environment, VS Code or system/PAC proxy applies, with `PIN_THROUGH_PROXY`). The pin is stored in the profile
(`pinnedCertSha256`), is never read from a workspace template or file, and
is not a secret. Redirects are not followed.

**What pinning does and does not give you.** A pin is trust on first use of
one certificate fingerprint. It does not authenticate who presented the
certificate when the user first trusted it (a man-in-the-middle present at
that moment gets pinned), and it does not protect against anyone who holds that
certificate's private key. For that certificate it skips the host-name,
issuer and revocation checks. The user is told to compare the fingerprint
with the administrator's before trusting. It is not known whether FileMaker
Server's default certificate is the same on every installation; if it is,
pinning it only detects change.

## Proxy mode

When `authMode = 'proxy'`, the extension posts every action to a
user-configured proxy endpoint. The proxy then authenticates to
FileMaker on the user's behalf, typically using a service account or
delegated credentials it manages internally. The extension itself
never sees those credentials in proxy mode.

### Payload sent to the proxy

For each action, the extension sends the minimum profile fields the
proxy needs to route the request:

```json
{
  "action": "<action-name>",
  "profile": {
    "id": "<profile-id>",
    "database": "<database>",
    "serverUrl": "<https://fm.example.com>",
    "apiBasePath": "/fmi/data",
    "apiVersionPath": "vLatest"
  },
  "payload": { ... }
}
```

Notable omissions:

- The human-readable `name` is **not** sent. Proxies identify profiles
  by `id`.
- Authorization for the proxy itself (when configured) is carried in
  the standard `Authorization: Bearer <proxyApiKey>` header, not in
  the body.

### What a compromised proxy can see

A proxy in the request path has the same FileMaker access as the
configured proxy auth principal. That means:

1. **Every action's payload** (find queries, record edits, script
   invocations) passes through the proxy in cleartext as far as the
   proxy is concerned — TLS to the proxy is necessary but not
   sufficient.
2. **The proxy's account is the trust anchor** for whatever it can
   read or write in FileMaker. Restrict proxy accounts to the
   minimum privileges per environment (read-only proxies for
   read-only deployments, separate accounts per database where
   feasible).
3. **The proxy can replay or alter requests** between receipt and
   forwarding. Treat the proxy host as part of the FileMaker security
   perimeter.

### Mitigations

- Keep the proxy on infrastructure you operate; do not point at
  third-party hosted relays for production data.
- Rotate the proxy API key (`SecretStore` proxy key) on a regular
  cadence; the extension picks up rotated keys automatically.
- Restrict proxy ingress to known client IPs / VPN.
- Audit-log proxy actions on the proxy itself; the extension cannot
  see proxy-side logs.

## Local bridge server (`FmBridgeServer`)

When the FM Web project workflow is in use, the extension starts a
local HTTP server bound to `127.0.0.1` (random port) and gates every
request with:

1. **Workspace trust**: untrusted workspaces are rejected outright.
2. **Localhost socket check**: non-loopback peers are rejected.
3. **Per-session bridge token**: a 256-bit random token must be sent
   in the `X-FM-Bridge-Token` header. The token is generated on each
   `ensureStarted()` and discarded on `stop()`.
4. **Origin allow-list**: cross-origin requests must come from
   explicitly allowed origins.
5. **Rate limit and request budget** (see `filemaker.fmWeb.bridge.*`
   settings): token-bucket rate limiter + hard per-token-lifetime
   request cap. Throttled requests receive `HTTP 429` with
   `Retry-After`; budget-exhausted clients must restart the bridge.

The trust boundary is **the bridge token + localhost binding**. Any
local process that obtains the token can call the bridge as if it
were the trusted runtime. The token lives in the extension host's
memory and, so the preview app can send it, in the generated runtime's
`.env.local` (`.fmweb/generated/runtime-next/.env.local`, owner-only,
with a `.gitignore` beside it) as `NEXT_PUBLIC_FMWEB_BRIDGE_TOKEN`. That
name means Next.js also puts it in the preview app's browser bundle, so
treat the preview page like any other local client of the bridge. A new
token is generated each time the bridge starts; rate limiting bounds the
blast radius if it is exfiltrated.

## Workspace trust and restrict-only policy

- In an untrusted workspace the extension limits itself mostly to reading:
  browsing, metadata and finds. Record edit, create and delete, container
  upload, the Script Runner, batch export and update, writing generated
  files, plugins, the FM Web commands and preview, and AI tools need a trusted
  workspace. Trust is evaluated at each use, and an open record editor or
  Script Runner refuses changes if trust is lost. `capabilities.untrustedWorkspaces` in `package.json` lists the
  settings that are ignored in an untrusted workspace.
- Enterprise mode, the enterprise role, offline mode and the
  `filemaker.features.*.enabled` switches are **restrict-only** for workspace
  settings and `.vscode/filemaker.config.json`: a repository may turn
  enterprise mode on, lower the role, turn offline mode on or a feature off,
  and may never do the reverse. The baseline is the user's own setting.
- The `filemaker.ai.*` settings that widen access are read from user settings
  only, including in dev containers and Codespaces.

## Confirmations

The extension asks before it: saves a record (listing the changed fields),
deletes a record, executes a batch update (and asks whether to check each record for newer changes or overwrite them, or whether to continue when the file has no modId column), warns before saving text that contains a NUL character, asks before overwriting generated files that the extension did not write, asks twice before Test My Server's write test (create, edit, delete a scratch record) and before it runs a script, runs workspace plugins, starts the
FM Web preview (`npm install`, `npm run dev`), runs a Layout Mode `runScript`
behavior, sends credentials to an address that came from a workspace profile
template or to a remote `http://` address, switches AI tools back on, and for
every AI write, delete or script run.

## Plugins

Workspace plugins run with the extension's access (saved connections and
sessions). They are loaded only in a trusted workspace, only when enterprise
policy allows `pluginInstall`, and only after the user approves the exact
content of the plugin folder (SHA-256 of every file, remembered per workspace).
A folder with a symbolic link or more than 500 files is refused. Anything a
plugin imports from outside its folder is not covered by the hash.

## Logs and redaction

Logs, request history, metrics, error details and copied snippets (free-text API keys and FileMaker access-token headers in error text are masked too) pass through
one redaction function. It hides authorization headers, session tokens
(including in request paths such as `DELETE /sessions/<token>`), token-like
query parameters, JSON keys whose names contain `token`, `secret`, `password`,
`session` or `apiKey`, and user names and passwords inside URLs. Request
history keeps metadata, not record bodies.

## AI features

AI features are off by default and are designed on the assumption that the
model may be steered by text it reads (database values, layout and field names,
files in a cloned repository). The controls live in the extension host, in one
tool core, and do not rely on the model behaving. The full design and threat
model are in [ADR-0004](./ADR/ADR-0004-ai-integration.md).

- Switches that widen access are user-scope only. A connection must be chosen
  by the user and set to `read` or `write`. Write and script tools are not
  offered until `filemaker.ai.allowWrites` / `allowScripts` is set.
- Layout reads need per-session approval. Results are capped (records per call
  and per session, calls per minute, bytes), container fields and server
  addresses are left out, and secrets are redacted.
- Every write is confirmed by the user in a dialog the extension builds from a
  fresh read of the record; it cannot be set to "always allow". Delete needs the
  record id typed. Scripts must be on a user-scope allowlist.
- A kill switch in the status bar turns everything off. Activity is logged
  outside the workspace without field values.
- The **Write AI Context** file contains structure only (names), is filtered to
  an allowlist of characters, and is written outside the repository by default.

What it cannot do: once data is in a model's context it can leave through the
model provider and through any shell, web or git tool the same agent has.
Hidden-field filtering is by name and does not stop disclosure through a
calculation, a summary field or a script result. A dedicated FileMaker account
with a read-only privilege set is the only control that does not depend on the
model or on the user. See also the [AI section of DATA_HANDLING.md](./DATA_HANDLING.md#ai-tools).

## What the extension does *not* protect against

- **Malicious local processes** on the same machine that can read
  the extension host's memory. This is outside the OS-level threat
  model; rely on the OS / EDR.
- **A compromised proxy host**. See "Proxy mode" above.
- **A man-in-the-middle at the moment a certificate is first trusted**, or a leaked private key of a trusted certificate. A pin detects a later change on direct connections, including with VS Code's default `http.proxySupport`; a required proxy is refused. Profiles that still use the older allow-self-signed setting have no certificate checks at all.
- **FileMaker server-side ACLs**. The extension talks the Data API
  and inherits whatever rights the authenticated user has on the
  server. Server admins remain the authority on what data is
  reachable.

## Reporting security issues

Do not open a public issue. Follow the [security policy](../SECURITY.md).

## FileMaker request and batch budgets

Every direct and proxy HTTP exchange has a wall-clock deadline set by
`filemaker.requestTimeoutMs` (15 seconds by default), as well as the socket
inactivity timeout. Receiving headers or dripping body bytes does not extend the
deadline. Caller cancellation still stops the request. Sign-in, sign-out, server
discovery and session retirement use these limits too (retirement uses at most
three seconds).

Responses are limited to 64 MiB after decompression per HTTP request. Smaller
explicit limits used by AI tools still apply. Large exports can use smaller
pages; a page or schema response over the limit must be reduced at the source.
Uploads retain the existing `filemaker.containerUploadMaxBytes` limit (100 MiB
by default, configurable up to 2 GiB); the transport allows up to 3 GiB outbound
to accommodate multipart and proxy base64 overhead. The response limit does not
reduce the container upload allowance. These are per-request budgets, not a
total export-size limit.

`filemaker.batch.maxRecords` (10,000 by default) caps both exports and update-file
rows, including dry runs. Oversized update files are refused before any records
are changed; split the file or deliberately raise the setting before retrying.
