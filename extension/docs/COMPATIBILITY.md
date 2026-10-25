# Compatibility

This extension talks to FileMaker through the FileMaker Data API. A server is compatible when it exposes the standard Data API under `/fmi/data`, accepts HTTPS requests from your machine or proxy, and the target database account has the `fmrest` extended privilege enabled.

## Evidence

One real FileMaker server was exercised on **2026-10-21**, but its FileMaker Server version was **not recorded**. The recorded checks included a no-match find (HTTP 200, FileMaker code 401, empty data), text and field behavior, and Diagnose Connection with a valid Let's Encrypt certificate and TLS 1.2. These findings apply to that server only; they do not complete a smoke test for any named version. The Data API engine name and API path do not identify the installed FileMaker Server release. Ask the administrator for the version before recording a version-specific result.

FileMaker Server **19, 20, 21 and 22** all still need a completed smoke test with the installed version recorded. FileMaker Cloud is untested, and **Claris ID sign-in is not supported**. The mock and automated tests do not prove compatibility with a real server version. See the [recorded findings and remaining checks](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/docs/FILEMAKER_FAILURE_MODES.md).

## Server Matrix

| Platform | Data API path | Status | Notes |
| --- | --- | --- | --- |
| FileMaker Server 19.x | `/fmi/data` | Expected to work, not tested | Expected to work, not tested. |
| FileMaker Server 20.x | `/fmi/data` | Expected to work, not tested | Expected to work, not tested. |
| FileMaker Server 21.x | `/fmi/data` | Targeted | Targeted. The Data API documentation for 21.x is the reference the extension and its mock are built from. No completed smoke test with version 21.x recorded. The October 21 real-server exercise did not record a server version. |
| FileMaker Server 22.x | `/fmi/data` | Expected to work, not tested | No completed smoke test with version 22.x recorded. Earlier certificate inspection alone does not establish Data API compatibility. |
| FileMaker Cloud | `/fmi/data` | Untested | Unverified. The extension has no Claris ID login; whether a Cloud tenant accepts an account name and password on the Data API is not confirmed (ask Claris or your administrator). Validate authentication and network policy before relying on it. |
| Custom proxy in front of FileMaker Server | Proxy-defined, upstream usually `/fmi/data` | Expected to work, not tested | Expected to work when the proxy keeps Data API semantics; not tested. |

No supported version is currently documented as known-broken. If you find a version-specific failure, open a bug report with the FileMaker Server version, operating system, deployment type, and Output panel logs.

## Feature Notes

| Feature | Compatibility note |
| --- | --- |
| Direct Data API sessions | Requires HTTPS reachability and an account with `fmrest`. The default API base path is `/fmi/data`. |
| Container fields | Container metadata and URLs are supported. Actual download behavior depends on server networking, SSL configuration, and whether returned container URLs are reachable from VS Code. |
| Value lists | Value list discovery depends on FileMaker layout metadata returned by the Data API. Layout-specific or privilege-filtered value lists may differ by account. |
| Scripts | Script listing and execution depend on the account's privileges and the script being available to the selected layout/database context. |
| OAuth / SSO | Direct mode currently uses FileMaker username/password credentials stored in VS Code SecretStorage. OAuth or SSO-specific flows are not implemented; use a compatible proxy if your organization requires custom identity handling. |
| FileMaker Server's default certificate, self-signed or private-CA certificates | In the connection wizard, trust the one certificate by its fingerprint (**Trust this certificate**, shown by Test Connection; direct connections work with every `http.proxySupport` setting), or set a custom CA certificate file under **Certificates (advanced)** for a company authority whose certificate names the server. A CA file alone does not work for FileMaker's default certificate (it has no host names). Both are per profile, `https://` only, and never come from a template or workspace file. A pinned certificate is not used through an HTTP proxy. Older **Allow self-signed** profiles still use an applicable `HTTPS_PROXY` environment proxy with `override`, `fallback`, `on` or `off`; `NO_PROXY` can exclude a server. An unreachable proxy is reported as a proxy connection problem. Changing proxy support does not disable an environment proxy. See the [User Guide](./USER_GUIDE.md#certificates). |
| Linux-hosted FileMaker Server | Expected to work when the standard Data API endpoint is enabled and reachable. Validate SSL certificates, firewall rules, and container URL reachability. |

## Operating Systems

The extension runs on macOS, Windows and Linux desktops (VS Code 1.96 or newer).

| Platform | What is tested automatically | Notes |
| --- | --- | --- |
| Windows (x64) | Every pull request and push to `main`: build, lint, type check, the unit and integration tests with coverage (including real named pipes, directory junctions, read-only files and the MCP shim), and the VSIX package check, on a GitHub-hosted `windows-latest` runner. | Not tested: Windows on ARM, other Windows versions than the runner's, a non-English Windows (the tests avoid parsing localized output, but nothing runs on one). |
| Linux (x64) | The same, on `ubuntu-latest` (the required `build-test` check also runs there). | Not tested: other distributions, Linux on ARM, `XDG_RUNTIME_DIR` setups other than the runner's. |
| macOS | Not in CI. It is the platform the extension is developed on, so the tests are run there by hand; the Unix-socket tests also run on Linux in CI. | Intel and Apple silicon are both expected to work. |

What no platform's automated run covers: the real VS Code user interface (the Playwright journeys in `extension/e2e-ui` are run by hand, on macOS), and a real FileMaker Server (the tests use the mock Data API).

Known platform limits:

- **AI server for MCP clients on Windows.** The server listens on a named pipe with a random 128-bit name, and every connection must send the per-session token from the discovery file. Node cannot set an access control list (ACL) on a pipe, and Windows has no file modes, so the Unix checks (socket mode 0600 in a folder of mode 0700 that you own) have no Windows equivalent: access control there is the token plus the secrecy of the pipe name. The discovery file holds the token and lives in the extension's global storage under your user profile, which inherits the profile's access rights (you, SYSTEM and administrators); the extension does not change them. Do not point `--dir` at a shared folder. A program that runs as you can read the token, as on every platform.
- **`node` must be on the PATH of the MCP client.** The copied MCP configuration runs `node` (18 or newer) with the bundled shim. VS Code's own Electron runtime is not used for this.
- **Remote windows are not supported** for the AI server (SSH, WSL, Dev Containers, Codespaces): the extension host runs on the remote machine while the MCP client runs on yours, so the local pipe or socket cannot be reached. The command says so and does not start.
- **Links.** Writes that go through a symbolic link or a directory junction are refused on every platform. On Windows, creating a directory symbolic link needs administrator rights or Developer Mode, a junction does not; both are refused the same way.
- **Read-only files.** A file marked read-only is updated in place of the old one and stays read-only on every platform (on Windows a rename over a read-only file needs the attribute cleared first, which the extension does for the moment of the replacement).
- **Case-insensitive file systems.** Windows and default macOS volumes treat `Layout.ts` and `layout.ts` as one file. Names that differ only in letter case can therefore share a generated file; names that differ in any other way get a hash suffix.
- **Reserved Windows names.** Generated file names avoid `CON`, `NUL`, `COM1` and similar names, and configured paths containing them, drive-relative paths (`C:x`), alternate data streams (`file:stream`), short names (`GIT~1`) or a trailing dot or space are refused.
- **Line endings.** Generated files are written with LF. A repository checkout on Windows keeps LF (`.gitattributes` sets `eol=lf`), and checks that compare generated files with committed ones ignore CRLF.

To check your own machine, run the same commands as CI (see [CI.md](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/docs/CI.md#cross-platform-job)).

## Version Selection Guidance

- Leave **API Base Path** set to `/fmi/data` unless your proxy or server deployment requires a custom route.
- Leave **API Version** set to `vLatest` unless you need to pin behavior for a specific server version.
- Test each saved profile after changing server version, credentials, proxy settings, SSL certificates, or firewall rules.
- Run the [smoke test](https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/docs/QA/SMOKE_TEST.md) against at least one representative server before rolling the extension out to a team.

## Reporting Gaps

Compatibility evidence is environment-specific. When reporting a gap, include:

- FileMaker Server or FileMaker Cloud version
- Server operating system and deployment type
- Extension version and VS Code version
- Direct mode or proxy mode
- The affected Data API operation
- Redacted Output panel logs
