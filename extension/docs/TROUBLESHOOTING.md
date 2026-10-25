# Troubleshooting

This page lists the errors the extension reports, with the symptom you see, the likely cause and the fix steps.

Start with **Test Connection** in the connection wizard. It names the step that failed: reaching the Data API, listing the hosted databases, or signing in. The failed step tells you which section below to read. **FileMaker: Diagnose Connection** goes deeper without signing in: it checks the address, the host name, the port, the certificate and VS Code's network settings, then asks the Data API for its product information. It sends no credentials and changes nothing.

The [FileMaker failure-mode catalogue](../../docs/FILEMAKER_FAILURE_MODES.md) has the maintainer view of the same ground, with the code and the evidence behind each behaviour.

## HTTP 401: the server refused the request

### Symptom

- "Reached the server, but sign-in failed: ... [212] Invalid user account and/or password".
- "Sign-in is paused: FileMaker rejected the saved credentials (error 210-214 or 1703) ...".
- A data call answers with HTTP 401 and FileMaker code 952 ("Invalid FileMaker Data API token").

### Likely cause

- Error 212 means a wrong account name or password. The account name is not case sensitive; the password is.
- The account's privilege set lacks the `fmrest` extended privilege ("Access via FileMaker Data API"). The server reports this the same way as a wrong password, so it looks like one.
- The other paused codes are 210 (the account is inactive), 211 (the password expired; change it in FileMaker Pro), 212 (wrong), 213 (the account does not exist), 214 (too many attempts: wait first) and 1703 (the server wants a different sign-in method, such as a Claris ID or external authentication).
- HTTP 401 on a data call means the session token is missing or invalid, not that the password is wrong.

### Fix steps

1. Edit the connection, type the password again and select **Test Connection**. A certificate or address problem is fixed before the sign-in is tried again.
2. If the message lists the databases the server hosts, compare the database name with the one in the profile.
3. Check the privilege set: open the database in FileMaker Pro, choose File > Manage > Security, edit the account's privilege set, open **Extended Privileges** and tick `fmrest`.
4. After fixing the account or the password, edit the connection and save, or run **FileMaker: Connect** or **Test Connection**. The extension pauses automatic sign-ins after a rejection so that repeated failures cannot lock the account; do not keep retrying.
5. For code 952, see [The session expired](#the-session-expired).

## HTTP 404: nothing answered at that address

### Symptom

- HTTP 404 with no FileMaker error code.
- HTTP 404 that carries a FileMaker error code, or HTTP 405 or HTTP 501.
- Error 802 "Unable to open file", or "unable to open file".
- Error 105 (layout is missing) or 104 (script is missing).

### Likely cause

- Nothing answered at that address: the Server URL, the API base path (`/fmi/data`), the API version (`vLatest`), the database name, or the FileMaker Data API being switched off (Admin Console > Connectors).
- The database name is wrong, in the wrong case, still carries the `.fmp12` suffix, or the file is closed or not hosted.
- The account's privilege set lacks the `fmrest` extended privilege for that file.
- A 404 with a FileMaker error code, or HTTP 405 or 501, means the server does not offer that feature, for example layout metadata.
- The layout or the script name is misspelled, was renamed, or the account cannot see it.

### Fix steps

1. Check the Server URL, the API base path and the API version under the advanced server options, and the database name (the file name without `.fmp12`).
2. Ask the administrator to confirm that the FileMaker Data API is enabled (Admin Console > Connectors) and that the file is open and hosted.
3. Check the account's privilege set for `fmrest` (File > Manage > Security > privilege set > **Extended Privileges**).
4. For a 404 with a FileMaker error code, or HTTP 405 or 501, run **FileMaker: Refresh Schema Cache**, or check the layout and script names.
5. **FileMaker: Connect** does not retry error 802. Fix the cause first.

## Certificate errors: the server certificate is not trusted

### Symptom

- "This server uses a certificate that is not trusted: FileMaker Server's default certificate is self-signed".
- "This server's certificate is not trusted by this computer. The certificate chain could not be verified ..." (`unable to verify the first certificate`).
- "The certificate of <host> is self-signed, and this computer does not trust it".
- "The certificate of <host> lists no host names".
- "The certificate of <host> was not issued for that name".

### Likely cause

- The server still has FileMaker's built-in certificate. It is self-signed, it lists no host names, and it is labelled "Not for Production Use". No certificate authority file can make it match the server's address, because the certificate has no names.
- The authority that signed the certificate is not trusted on this computer, or the server does not send its intermediate certificate (a common cause).
- You connected by an IP address or by a name the certificate does not list.
- A certificate from a public authority needs nothing from you.

### Fix steps

1. In the connection wizard, select **Test Connection**. When the certificate is the problem, the extension reads the certificate before it sends anything and shows **Trust this certificate for "<profile name>"?** with the reason it was refused, the **Server**, **Subject**, **Issuer**, **Names**, the **Valid** dates and the **SHA-256** fingerprint.
2. Compare the SHA-256 fingerprint with the one your administrator gives you (or the one in the Admin Console) and select **Trust this certificate**. The extension then trusts exactly that one certificate for this connection, and the test runs again by itself.
3. Select **Save Profile**. The fingerprint is stored in the profile, so later connections need no click.
4. A CA file alone does not fix FileMaker's default certificate. For a certificate that does list the server's host names and was issued by your organisation's authority, set that authority's PEM file under **Certificates (advanced)**; the message mentions the CA file only in that case. If the server sends only its leaf certificate, ask the administrator to install the full chain on the server.
5. You can reopen the dialog with **Review server certificate...** and remove the pin with **Forget trusted certificate**, both under **Certificates (advanced)**.
6. For production, install a certificate from a public authority, with the intermediate certificate, in the Admin Console (Configuration > SSL Certificate) and restart the server as the console says.

## The certificate was revoked, expired or replaced

### Symptom

- "The certificate of <host> has been revoked".
- "The security certificate of <host> has expired", or "is not valid yet".
- "The certificate you trusted for <host> has expired".
- "... is not the one you trusted for this connection" (button **Review and re-trust**).

### Likely cause

- The authority revoked the certificate.
- The server certificate is out of date, or your computer's clock is wrong.
- The pinned certificate ran out.
- The server presented a different certificate than the one you pinned, because it was renewed or replaced by something else answering.

### Fix steps

1. Check your computer's date and time first. If the clock is right, the server's certificate needs renewing (Admin Console > Configuration > SSL Certificate).
2. For a revoked certificate, ask the administrator to install a new certificate.
3. After the administrator renews it, review the new fingerprint and re-trust it with **Review and re-trust**. Do that only if your administrator renewed the certificate.
4. A pinned certificate that has expired, or is not yet valid, is refused unless you accepted that explicitly in the dialog; the button then reads **Trust anyway, although it is not valid**.

## The custom CA file cannot be read

### Symptom

- "The CA file ... does not contain a certificate".
- "Unable to read TLS CA bundle at ...".

### Likely cause

- The path is wrong or the file is unreadable, or it is not a PEM file with `-----BEGIN CERTIFICATE-----` blocks (a public certificate, not a key). An empty file, or a file that is no longer a certificate, gives the same answer.

### Fix steps

1. Check the **Certificate authority file** path under **Certificates (advanced)**. It must be an absolute path to a readable PEM file that holds a certificate, not a private key.
2. Point it at the root and any intermediate certificate of the authority that signed your server's certificate.
3. Save the profile and test again. An edited or renewed file is used on the next connection.
4. A wrong CA file keeps the ordinary untrusted-chain advice. Changing `http.proxySupport` is not the remedy for a wrong CA file; see [A proxy or a CORS rule is in the way](#a-proxy-or-a-cors-rule-is-in-the-way).

## The server offers only an old TLS version

### Symptom

- "only offers old TLS versions", or "no TLS version or cipher is shared".

### Likely cause

- The server, or the proxy in front of it, offers only TLS 1.0 or 1.1, or shares no cipher with this computer.

### Fix steps

1. Ask the administrator to enable TLS 1.2 or newer on the server or on the proxy.
2. There is nothing to change in VS Code: the extension will not lower its minimum TLS version.

## The session expired

### Symptom

- "Session expired", or FileMaker error 952 ("Invalid FileMaker Data API token").
- HTTP 401 on a data call after the extension has been idle.

### Likely cause

- The Data API token timed out. The token expires after about 15 minutes of inactivity, and each call that uses it resets that counter.
- The administrator disconnected the client, or the server restarted, so the token was revoked.

### Fix steps

1. The extension renews the token about 30 seconds early (`filemaker.session.refreshLeadSeconds`), treats a token as expired after 14 minutes (`filemaker.session.maxAgeMinutes`), and signs in again once when a request is still rejected. Usually nothing is needed.
2. If the problem keeps happening, run **FileMaker: Disconnect** and then **FileMaker: Connect**.
3. Ask the administrator whether the session was disconnected in the Admin Console (Databases > Clients list).

## Error 956: no free Data API sessions

### Symptom

- Error 956, with the Claris wording "Maximum number of database or Admin API sessions exceeded".
- The pause message "FileMaker has reached its maximum number of database or Admin API sessions. Waiting n s before signing in again".

### Likely cause

- The server has reached its limit of database or Admin API sessions. Claris documents neither a numeric maximum nor a setting for it.
- The account is not the problem, so checking or changing the account does not help. The session limit is.

### Fix steps

1. Wait first. Automatic sign-ins wait 30 seconds, then longer, up to 5 minutes.
2. Use **FileMaker: Connect** to try now.
3. Ask the administrator to disconnect idle clients: Admin Console > Databases > Clients list > select the client > Disconnect (Data API clients are disconnected immediately).
4. Do not keep retrying the sign-in: the wait is what releases the slot.

## Error 214: too many sign-in attempts

### Symptom

- Error 214 ("Too many login attempts"), inside "Sign-in is paused: FileMaker rejected the saved credentials (error 210-214 or 1703) ...".

### Likely cause

- The server or the account policy locks the account after too many failed sign-in attempts. The lockout belongs to the account, not to the connection.
- Repeating **FileMaker: Connect** or **Test Connection** does not shorten it. Every new attempt counts as another attempt and keeps the lockout in place.

### Fix steps

1. Wait for the lockout to expire before you try again. Do not run **FileMaker: Connect** or **Test Connection** in a loop.
2. Fix the cause first (the password, the state of the account or the `fmrest` privilege) so that the next attempt can succeed.
3. Ask the administrator to unlock the account or to reset the password if the lockout does not clear on its own.

## Error 1703, or a FileMaker Cloud sign-in

### Symptom

- Error 1703, or a rejected sign-in on a FileMaker Cloud host.

### Likely cause

- FileMaker Cloud normally uses Claris ID sign-in, which this extension does not support. Whether a Cloud tenant also accepts an account name and password is not confirmed.
- The same code on another server can mean external authentication, such as an OAuth provider or Active Directory.

### Fix steps

1. Do not keep retrying. Error 1703 pauses automatic sign-ins like errors 210 to 214.
2. On FileMaker Cloud, ask Claris or your administrator whether the Data API accepts an account name and password, or only Claris ID.
3. On another server, ask the administrator which sign-in method the server expects.

## HTTP 403: the request was refused

### Symptom

- HTTP 403.

### Likely cause

- The server or a gateway refused the request. The account may lack the privilege, or a firewall blocked it.

### Fix steps

1. Ask the administrator for the missing access, or for the firewall rule that allows your address.
2. Editing the connection will not help: the profile is not the cause, so the error offers no **Edit Profile** action.

## The workspace is not trusted (Restricted Mode)

### Symptom

- A banner says the folder is in Restricted Mode.
- The connection wizard shows a notice at the top with a **Manage Workspace Trust** button.
- Commands are greyed out or missing.

### Likely cause

- VS Code runs the extension in Restricted Mode until you trust the folder. In an untrusted workspace the extension can browse, read metadata and run finds, but it will not edit, create or delete records, upload to containers, run scripts, write generated files, run batch jobs, load plugins, start the FM Web preview or register AI tools, and it ignores a `.filemaker/profile-template.json`.
- Workspace settings that change how connections and commands behave are ignored until you trust the workspace.

### Fix steps

1. Choose **Yes, I trust the authors** in the banner or in the dialog when the folder is yours, or comes from a source you trust. Review it with **Workspaces: Manage Workspace Trust**.
2. The notice goes away when you trust the workspace. Trust is checked each time, and a panel that is already open refuses changes if trust is lost.
3. Your own profile, password and **Test Connection** work as usual, and a profile you save is yours: it is not stored in the project.

## A proxy or a CORS rule is in the way

### Symptom

- "A proxy is configured on this computer (HTTPS_PROXY, VS Code http.proxy, or a system/PAC proxy), and a trusted (pinned) server certificate cannot be checked through a proxy".
- "The proxy <host:port> could not be reached".
- "This server's certificate failed VS Code's own certificate check (...), and this connection's certificate settings could not be applied ...".

### Likely cause

- An environment proxy (`HTTPS_PROXY`), VS Code's own proxy (`http.proxy`), or a system/PAC proxy applies to the server address. A pinned connection is made directly and never through a proxy, so the extension refuses before sending anything (`PIN_THROUGH_PROXY`), even when the profile also has a CA file.
- The third message is a backup message for an untrusted pinned or legacy request that stayed on the environment-proxy route while VS Code's networking patch was active. It never replaces a CA-only error, and the network code and the trust actions stay available.
- A CORS error belongs to a browser page. The extension runs in VS Code's Node process, not in a page in a browser, so a cross-origin rule is not what blocks the connection: the proxy route is.

### Fix steps

1. For an environment proxy, add the server's host name to `NO_PROXY` and restart VS Code so it sees the change.
2. For a VS Code proxy or a system/PAC proxy, exclude the server in that proxy's settings, or remove the proxy setting, so the pinned connection goes direct.
3. A profile that has a pinned certificate ignores its CA file, and the message says so. For a certificate with proper host names you can instead ask for one that is issued and use a CA file, but not for FileMaker's default certificate: forgetting the pin and setting a CA file does nothing for it.
4. If the third message persists, try `http.proxySupport` set to `fallback` and test again, or ask the administrator to install a publicly trusted certificate. Changing proxy support does not switch off an environment proxy.
5. Trusted certificates work with all four values of VS Code's **http.proxySupport** setting: `override` (the default), `fallback`, `on` and `off`.

## The server cannot be reached or times out

### Symptom

- "Nothing is listening on `<host:port>`".
- "The name <host> could not be found", or "could not be looked up right now".
- "Connecting to <host> timed out", or "no network route".
- "<host> does not speak https on that port".
- "The connection to <host> was closed. The server may only accept https".
- "The server closed the connection ... before answering".
- "The server did not return Data API JSON (...; HTTP n, content type)".
- "The server redirected the request".
- HTTP 429, 502, 503 or 504.

### Likely cause

- The FileMaker Data API is not enabled, the server or the Data API is not running, or the address or the port is wrong.
- The host name is misspelled, the VPN is not connected, or DNS is not answering.
- A firewall is dropping the traffic, or the server is unreachable.
- You used `http://` against an HTTPS-only server, or the wrong port.
- The server restarted, or a firewall or proxy dropped the connection.
- A web page, a firewall, a proxy or a sign-in page answered instead of FileMaker Server, or the reply was empty or cut off.
- The Data API never redirects. A redirect points at another address: http to https, another host, or a sign-in page.
- A gateway could not reach FileMaker Server, or it did not answer in time. The server may be restarting or overloaded. The status bar shows `unreachable`.

### Fix steps

1. Check the Server URL, the scheme (`https://`) and the port, and that the FileMaker Data API is enabled (Admin Console > Connectors).
2. Check the spelling of the host name, the VPN and the DNS.
3. Open the Server URL in a browser to see what answers, and check the base path and the version.
4. For a timeout, ask whether a firewall is dropping the traffic from your address. Raise `filemaker.requestTimeoutMs` only for a slow server, not for an unreachable one.
5. For HTTP 429 the extension reads `Retry-After`: wait, and avoid large exports at busy times. For 502, 503 and 504, try again shortly and ask the administrator to check the Admin Console.
6. For a dropped connection, try again; if it keeps happening, ask the administrator.

## A find returns nothing

### Symptom

- A find returns an empty result and no error. FileMaker reports "no records match" as error code 401.

### Likely cause

- No record matches the criteria. FileMaker sends code 401 with an empty data list, and the extension accepts that code on any HTTP status and shows an empty result rather than an error. Other versions may use another status.
- Record-level access rules may hide the records from your account, or the criteria may not match the field values.

### Fix steps

1. Check the criteria and the account's record access.
2. Do not confuse this with HTTP 401, which is a sign-in or session problem; see [HTTP 401: the server refused the request](#http-401-the-server-refused-the-request).
3. An empty page caused by an offset past the last match keeps the supplied match count.

## The account lacks a privilege

### Symptom

- Error 9, 200, 202, 203, 205 or 207, "Insufficient privileges", or "Record access is denied".

### Likely cause

- The account's privilege set does not allow the operation, on that layout, record, field or script. Error 205 means no privilege to create records, and 207 means no privilege to change the schema.

### Fix steps

1. Ask the administrator for the access you need.
2. Editing the connection will not help: the profile is not the cause, so the error offers no **Edit Profile** action.
3. A script that runs with full access privileges can do more than your own account can. The allow-list you keep for the AI tools decides which scripts may run; it does not change what the account may do.

## The find or the script request is refused

### Symptom

- "Find criteria are empty", or "Missing required property" (400 / 10).
- "This parameter is too long to send".
- "The script did not run because this layout has no records".
- "The server did not confirm that the script ran".
- "Script runner is not supported on this server/profile.".

### Likely cause

- The find has no criteria. An empty find cannot list records.
- The encoded URL exceeds 2,000 characters, and a text-field find cannot carry it.
- A read confirmed that the layout has no visible records, so the script did not run.
- The response had no `scriptError`, so the runner cannot confirm execution.
- The server refused both the script endpoint and the attach-to-another-request form (405, 501 or a FileMaker 404).

### Fix steps

1. Enter at least one field value, or choose **List records instead** in the Query Builder on a direct connection. It lists only after you choose it; a proxy connection needs a search value.
2. Shorten the parameter, or use a layout with a text field and no record ID.
3. Add a record, or use a layout that has records.
4. Check the script before trying again.
5. Check that the layout and the script exist for the account, and that the server supports the Data API script calls.

## The record changed while you were working

### Symptom

- Error 306 on save, or in a batch update.
- Batch update: "Could not confirm: the first attempt may have succeeded".
- Error 301 (record in use).
- Errors 500 to 511 on save.

### Likely cause

- The record changed since you loaded or exported it, so the modification ID no longer matches.
- A reply was lost, and the retry could not confirm the saved values.
- Another user or a script has the record open.
- The value failed the field's validation, for example a date, a range, a unique value or a value list.

### Fix steps

1. A batch update skips the changed row and continues with the rest. See Jobs and **Copy failures**. Review the newer record before you retry.
2. For an unconfirmed save, check the record before trying again: it may already have changed.
3. For error 301, try again shortly. Ask the administrator whether a script leaves records uncommitted.
4. For a validation error, enter a value in the field's format and check the field's rules with the administrator.

## A save worked but a script error is shown

### Symptom

- The record was saved, and a script error is shown next to the success message.

### Likely cause

- The layout ran a script, for example OnRecordCommit, and the script reported an error. The record is saved; the message names the script phase and the FileMaker error.

### Fix steps

1. Read the named script phase and the FileMaker error code.
2. The same warning is shown for edit, create, delete, find and container upload. Getting a single record does not display script errors.
3. Ask the administrator, or the owner of the script, why the script reports that code.

## A field is read-only, or layouts and fields are missing

### Symptom

- A field is read-only in the editor, or a column is skipped on import.
- Layouts or fields are missing in the sidebar.

### Likely cause

- Calculation, summary and container fields are left out when the layout's field details are available. FileMaker still decides what your account may change.
- Your privilege set may show only some layouts, the schema cache is out of date, or you are in offline mode, where only cached layouts show.

### Fix steps

1. Use **FileMaker: Upload to Container** for containers.
2. Run **FileMaker: Refresh Connections**, then **FileMaker: Refresh Schema Cache**.
3. Check which account the profile uses. The Layout Inspector shows the field's kind and result type.

## A batch job stops or reports failed rows

### Symptom

- A batch update "stopped" with FileMaker's reason and a number of records not attempted.
- A batch update where some records failed with error 200.

### Likely cause

- The account cannot do updates at all: error 9 (insufficient privileges), 205 (cannot create records), 207 (cannot change the schema), or its credentials were rejected.
- A record-level access rule hides those records from your account.

### Fix steps

1. Records that were already updated stay updated. The job does not undo them.
2. Fix the access, then run the job again for the records that were not attempted.
3. The failed rows are listed with their reason and their record ID, and the job carried on with the rest.

## Commands are greyed out or missing

### Symptom

- Commands are greyed out or missing from the Command Palette or from the sidebar.

### Likely cause

- You may be in an untrusted workspace (Restricted Mode), in offline mode, or limited by the enterprise role. Some commands appear only after you add a profile.

### Fix steps

1. Read the message: it names the reason.
2. Trust the workspace if that is the reason; see [The workspace is not trusted (Restricted Mode)](#the-workspace-is-not-trusted-restricted-mode).
3. Run **FileMaker: Toggle Offline Mode** if offline mode is the reason. A workspace or policy setting can keep offline mode on, and the toggle cannot clear that.
4. Add a connection profile to see the commands that need one.

## Proxy mode: the proxy returns errors

### Symptom

- Proxy mode returns errors, or the FileMaker error codes are not recognised.

### Likely cause

- The proxy must keep the Data API request and response shapes. A proxy that returns `fmCode` and `status` in its error reply gets the same messages as a direct connection; one that does not gets the generic proxy message.
- In proxy mode the extension never sees the FileMaker credentials. The proxy's own account decides what you can see, and every extension user gets the same view unless the proxy maps users.
- Redirects are not followed, so the proxy endpoint must answer directly.

### Fix steps

1. Test the proxy endpoint outside VS Code.
2. Ask the proxy's owner to return `fmCode` and `status` in the `ok: false` reply.

## A container field shows a URL instead of the file

### Symptom

- A container field shows a URL. The Record Viewer shows an image preview or a link for it, and the AI tools leave container fields out of their results.

### Likely cause

- A container value is a URL, not the file itself. The extension only writes containers: it uploads with **FileMaker: Upload to Container** and never downloads the stored file, so the URL is what you can open.

### Fix steps

1. To replace the file, run **FileMaker: Upload to Container**, choose the profile and the layout, enter the record ID and the container field name, and pick the file. The default size limit is 100 MB (`filemaker.containerUploadMaxBytes`), and uploading needs a trusted workspace.
2. Container fields are read-only in the Record Editor, which points at **Use Upload to container**. Save and Create Record leave them out, including repetitions.
3. To open the file, use the URL the extension shows.

## Saved queries, generated files and CSV files

### Symptom

- A saved-query import says the file is invalid.
- A generated file has an unexpected name.
- CSV cells start with an apostrophe.

### Likely cause

- The import expects a JSON file exported with **FileMaker: Export Saved Queries**. Invalid JSON, or a file without a query list, leaves the existing queries alone.
- Generated file names avoid names that Windows reserves, and names that differ only in letter case can share a file on Windows and on macOS's default disk format. A name with spaces or punctuation gets a new file name with a short hash.
- The export puts an apostrophe in front of text that starts with `=`, `+`, `-`, `@`, a tab or a carriage return, so that a spreadsheet does not run it as a formula.

### Fix steps

1. Export the saved queries again and import that file.
2. See [Generate types, a client and snippets](./USER_GUIDE.md#generate-types-a-client-and-snippets) in the User Guide for the file names.
3. See [Batch export and batch update](./USER_GUIDE.md#batch-export-and-batch-update) in the User Guide for the apostrophes. Set `filemaker.export.neutralizeFormulas` to `false` in your **user** settings if you need the raw text.

## AI: off in the status bar

### Symptom

- The status bar shows `AI: off`.

### Likely cause

- AI tools are off by default. When they are not on, the status bar item only explains why: for example `filemaker.ai.enabled` is off, offline mode, an untrusted workspace, enterprise policy, or no connection enabled.

### Fix steps

1. Switch AI tools on with **FileMaker: Switch AI Tools Off or On** if you want them.
2. See [Using AI with FileMaker](./USER_GUIDE.md#using-ai-with-filemaker) in the User Guide for what the AI tools may do.

## A setting seems to do nothing

### Symptom

- A setting seems to do nothing.

### Likely cause

- A workspace value may be ignored. Some settings are read from your user settings only, and a workspace can only make the policy stricter.

### Fix steps

1. Run **FileMaker: Show Effective Settings**. It covers the 24 policy-related settings and shows where each value comes from.
2. For any other setting, the badge in the Settings editor (**Per workspace**) tells you that it works as typed.

## The password cannot be stored, or the wizard asks for it again

### Symptom

- "SecretStorage unavailable (...)".
- The wizard asks for the password again.

### Likely cause

- VS Code could not reach the operating system keychain. This is common on Linux without a keyring, and in some remote windows.
- You changed the server address, the proxy address or the user name. The wizard does not reuse the saved password in that case, so a saved password is never sent to a different server.

### Fix steps

1. Install and unlock a keyring, or set `filemaker.secrets.fallback` in your **user** settings. That fallback is obfuscated, not protected: use it only when there is no keyring.
2. Type the password again when you changed the server address, the proxy address or the user name. This is intended. If you only change the profile name or the database, the saved secret is kept.
3. When editing a profile, "••••••• (saved)" in the password box means you can leave it empty to keep the saved password.

## Where to get logs

- **Output panel.** View > Output, then choose **FileMaker Data API Tools** in the dropdown. Set `filemaker.logging.level` to `debug` for more detail. Secrets are redacted, so the lines are safe to attach to a bug report once you have read them.
- **FileMaker: Show Diagnostics** opens a report with your VS Code and extension versions, the operating system, the active profile (no secrets), your settings and recent log lines.
- **FileMaker: Copy Connection Diagnosis for Bug Report** copies the latest connection diagnosis. It asks **Hide the server address?** first, and hiding also removes the port and the certificate details.
- **FileMaker: About / Show Version** shows the extension version, the build, your VS Code version and the **Extension host** line. **Copy for bug report** copies a short block of those facts, with no server address, profile name, user name, token or folder path.
- **FileMaker: Show Effective Settings** shows the value in effect for the policy-related settings (24 of them: the switches, limits and paths a project could try to change), not every setting.
- **Details...** on an error message opens a document with the failing endpoint and the retry chain, redacted. It is safe to paste into a bug report.
- **FileMaker: Test My Server** writes a report with the HTTP status and the FileMaker code the server actually returned. **Copy report with server address hidden** shares it without the address.

The logs and the reports redact passwords, session tokens, API keys and authorization headers, but layout, field and script names and server details can still identify your organisation. Read anything you attach before you attach it.
