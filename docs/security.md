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

Old saved server addresses containing a user name or password are cleaned only
after any password has been saved securely; an existing saved password is kept.
A warning asks the user to re-enter or confirm the credential in Edit Connection
Profile. If storage is unavailable, the original entry remains for a later attempt.
New credential-bearing addresses are refused. Test Connection keeps the temporary
password or proxy API key and session token in memory only, closes its throwaway
session and never changes the saved profile's secrets. Removing a profile closes
its server session before deleting local credentials. Connect warns once per
profile per session before using a remote plain `http://` address.

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
   bridge start and discarded on `stop()`.
4. **Origin allow-list**: every request must carry exactly
   `http://localhost:3000` or `http://127.0.0.1:3000` as its Origin.
   Missing origins, HTTPS and other ports are refused. The preview dev/start
   scripts and extension launch bind to `127.0.0.1:3000`; if that port is busy,
   stop its existing service before starting the preview.
5. **Rate limit and request budget** (see `filemaker.fmWeb.bridge.*`
   settings): token-bucket rate limiter + hard per-token-lifetime
   request cap. Throttled requests receive `HTTP 429` with
   `Retry-After`; budget-exhausted clients must restart the bridge.

The bridge token is held only in the extension host and the private Next server's
`FMWEB_BRIDGE_TOKEN` environment variable. It is never a `NEXT_PUBLIC_` value,
written into `.env.local`, or passed to browser JavaScript. Browser calls go to
`/api/bridge/<route>`; that server route validates the session, Host and exact
Origin before adding the token to a fixed, allowlisted bridge request. It does
not forward client credentials or upstream headers. Origin alone cannot
authenticate a local process; possession of the private session cookie is required.

At each start the extension generates independent random 256-bit launch and
session credentials and passes both only through the server process environment.
Once Next reports ready, the extension opens `http://127.0.0.1:3000/?launch=...`
in the user's browser. Proxy exchanges the launch code once, within two minutes
of server start, for an HttpOnly, SameSite=Strict, Path=/ session cookie and
redirects to `/` without the code. An exclusively created file in the private
temporary directory makes redemption single-use across workers and recompiles.
Pages and assets without the cookie receive 401 (Next.js development endpoints,
such as live reload, are outside the cookie check); the bridge-proxy route also
checks the cookie independently and returns 401 without it. Wrong Host values
are refused: only `127.0.0.1:3000` and `localhost:3000` are accepted. This prevents
DNS rebinding. Preview responses use no-store and launch responses suppress the
Referer. Server request output is not displayed because it could include the
launch code. Restarting stops the old preview and bridge and changes all credentials.
A busy port is an error; the extension never opens an existing service as its preview.

This protects against another local OS user who can connect to loopback but
cannot read the victim's private files, browser cookies or process environment.
That user gets 401 without a cookie and cannot obtain the bridge token from
served HTML or browser bundles. Root, processes able to read the victim's process
environment, malicious software running as the victim, a compromised browser or
extension, stolen/shared launch links or cookies, and malicious downloaded
packages are outside this boundary. Cookies are scoped to a host, not a port;
use the launched 127.0.0.1 URL and do not send the preview cookie to other local
services. A local attacker can still occupy port 3000 to deny startup.

Before running, the extension compares generated runtime files with the shipped
template and shared sources. The start modal lists ignored edited or added files:
configuration such as `.npmrc` and `.env*`, custom runtime files and lockfiles.
Workspace dependencies and build output are also ignored. These are left alone. A layout whose generated file
is edited or linked is skipped with a warning. Starting never deletes user files.
Only **Generate FM Web Next.js App** offers **Regenerate from template**: a modal
names exactly which files or folders (including their contents) it will delete,
and cancellation leaves them alone. No repository marker establishes dependency
provenance.

Execution uses a fresh private temporary copy of the shipped files and generated
layout JSON, with a fresh dependency tree and private npm cache. Temporary folders
use the `fmweb-preview-` prefix and a `.fmweb-preview-owner` marker naming the owning
extension-host process. Cleanup stops the process tree and removes the private
folder; stale marked folders older than a day are removed only after the owning
process no longer exists. Active windows' folders are left alone. On Windows,
Node.js and npm are resolved from PATH, no command shell or console window opens,
and cancellation stops the process tree too.

`npm install --ignore-scripts` uses the public npm registry, empty pinned user
and global config files, an explicit prefix and a limited process environment.
No project npm configuration or `.env` override is used or changed. Proxy variables
and `NODE_EXTRA_CA_CERTS` pass through. The template dev script runs with npm
pre/post scripts disabled and binds Next to 127.0.0.1:3000. The Run modal describes
both commands. Each start resolves package versions with `npm install`; no
workspace lockfile is reused. Fresh downloads and startup on every platform
remain unverified in this offline documentation preparation. Failed installs
stop rather than retrying with scripts. The system Node/npm and PATH must be
trusted. The generated `.env.local` holds only a non-secret notice; cancelling
also removes legacy saved bridge entries while preserving unrelated env lines.

There are no new network destinations in 1.9.0. Preview dependencies still come
from `registry.npmjs.org`; preview traffic uses loopback and the configured
FileMaker server or proxy. AI providers are reached only through opted-in AI use.

Every preview `/runScript` request asks in a VS Code modal naming the exact
script, layout, parameter and connection host, and says it came from a layout
file. All Unicode category C and default-ignorable characters are visibly
escaped, and the parameter length is shown. Layout Mode uses the same escaping
and displays the layout execution will actually use. Values that exceed the
confirmation display bounds are refused in full, never shortened for approval.
Only one prompt may be pending, with a five-second cooldown after it closes;
other bridge routes keep their existing behavior. Layout URL actions accept
only HTTP and HTTPS; runtime tabs use `noopener,noreferrer`.

## Workspace trust and restrict-only policy

- In an untrusted workspace the extension limits itself mostly to reading:
  browsing, metadata and finds. Record edit, create and delete, container
  upload, the Script Runner, batch export and update, writing generated
  files, plugins, the FM Web commands and preview, and AI tools need a trusted
  workspace. Trust is evaluated at each use, and an open record editor or
  Script Runner refuses changes if trust is lost. `capabilities.untrustedWorkspaces` in `package.json` lists the
  settings that are ignored in an untrusted workspace. The workspace enterprise
  file is ignored, offline schema caches are not used, and environment and layout
  comparison are unavailable until trust is granted. Trusted offline caches are
  checksum-checked before use; altered content is refused.
- Enterprise mode, the enterprise role, offline mode and the
  `filemaker.features.*.enabled` switches are **restrict-only** for workspace
  settings and `.vscode/filemaker.config.json`: a repository may turn
  enterprise mode on, lower the role, turn offline mode on or a feature off,
  and may never do the reverse. The baseline is the user's own setting.
- The `filemaker.ai.*` settings that widen access are read from user settings
  only, including in dev containers and Codespaces. In 1.9.0,
  `filemaker.snippets.includeAuthByDefault`, `filemaker.schema.hashAlgorithm`,
  `filemaker.fmWeb.bridge.rateLimitPerSecond`, `filemaker.fmWeb.bridge.rateLimitBurst`
  and `filemaker.fmWeb.bridge.requestBudget` are also User-only; workspace values
  are ignored.
- Executing batch updates needs record editing enabled and enterprise permission
  for batch, record and write operations; policy and offline mode are checked
  again before each row. Dry runs still write nothing and work with writes
  disabled or offline mode on; an offline dry run does not contact the server.
  Trust Server Certificate and Set AI Access follow locked-profile and write
  rules and are unavailable offline.
- Offline metadata cache folders write a self-ignoring `.gitignore`; schema
  snapshots are not ignored and remain available to commit.

## Confirmations

The extension asks before it: saves a record (listing the changed fields),
deletes a record, executes a batch update (and asks whether to check each record for newer changes or overwrite them, or whether to continue when the file has no modId column), warns before saving text that contains a NUL character, asks before overwriting generated files that the extension did not write, asks twice before Test My Server's write test (create, edit, delete a scratch record) and before it runs a script, runs workspace plugins, starts the
FM Web preview (`npm install`, `npm run dev`), runs a Layout Mode or FM Web preview `runScript`
behavior, sends credentials to an address that came from a workspace profile
template or to a remote `http://` address, switches AI tools back on, and for
every AI write, delete or script run. AI, plugin and layout/preview script
confirmations show hidden characters as visible escapes and refuse values too
long to show in full. Cancelling a script prompt runs no script; cancelling preview startup clears
saved bridge credentials.

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
history keeps metadata, not record bodies. Error notifications use shortened,
one-line text and break injected links while keeping bracketed codes and file
paths readable. Copied reports keep server text inside code blocks. Record Editor
and Record Viewer open container links only on the selected connection's own
server. Suggested save names keep case and extension while unsafe characters
are removed; layout and query names in exported data stay exact. Comparison
reports and generated client README files display names without letting them
add links, images or table rows.

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
  It does not need `filemaker.ai.enabled`, but still follows
  `filemaker.features.ai.enabled`, enterprise AI policy and offline mode.

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

Every direct and proxy HTTP exchange is time-limited, and the limit depends on
the kind of request. The base value is `filemaker.requestTimeoutMs` (15 seconds
by default).

- **Sign-in, sign-out, server discovery, metadata and ordinary requests** have a
  wall-clock deadline. Receiving headers or dripping body bytes does not extend
  it.
- **Downloads and large reads** renew the deadline each time 64 KiB of body
  arrives, so a healthy slow transfer finishes and a stalled or dripping one
  stops.
- **Uploads** have a wall-clock deadline for the whole exchange, including the
  response wait. It grows with the body size at 32 KiB per second (including
  multipart or proxy base64 overhead), lasts at least the request timeout, and
  has a 30 minute ceiling. Stalled uploads stop at that deadline; socket activity
  does not renew it. Connection setup, including DNS and proxy lookup, still
  uses the base timeout.
- **Every transfer** also has a 30 minute ceiling.

Caller cancellation still stops any request. Session retirement uses at most
three seconds.

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

Timeouts say “Request timed out” and name `filemaker.requestTimeoutMs`; after a
change, they warn that it may have been applied. An oversized response can show
“maxContentLength size of 67108864 exceeded”; reducing page size or the response
at the source is needed, not a larger timeout. HTTP 413 is the server or gateway's
request-size limit, separate from this response cap.
