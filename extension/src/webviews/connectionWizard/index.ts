import * as vscode from 'vscode';

import type { FMClient } from '../../services/fmClient';
import type { Logger } from '../../services/logger';
import type { ProfileStore } from '../../services/profileStore';
import type { SecretStore } from '../../services/secretStore';
import type { ConnectionProfile } from '../../types/fm';
import { buildWebviewCsp, createNonce } from '../common/csp';
import { guardDispatch, requestType } from '../common/dispatch';
import { versionFooterHtml } from '../../about/runtimeVersion';
import type { CertificateState, ConnectionWizardOptions } from './types';
import type { WizardContext } from './context';
import { handleMessage } from './messages';
import { sendInit, sendLoadProfile } from './profiles';

export type { ConnectionWizardTestPolicy } from './types';

export class ConnectionWizardPanel {
  private static currentPanel: ConnectionWizardPanel | undefined;

  private editingProfile: ConnectionProfile | undefined;
  /** Origins that came from the workspace's profile template, not from the user. */
  private templateOrigins = new Set<string>();
  /**
   * The certificate trust of the profile being edited, as the user has left it. It starts from the
   * saved profile and changes only through the trust dialog (never from the form fields, a template
   * or a file): a pinned certificate, and the older "skip all checks" flag.
   */
  private certificateTarget: string | undefined;
  private certState: CertificateState = { legacy: false };

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly profileStore: ProfileStore,
    private readonly secretStore: SecretStore,
    private readonly fmClient: FMClient,
    private readonly logger: Logger,
    editingProfile?: ConnectionProfile,
    private readonly options: ConnectionWizardOptions = {}
  ) {
    this.editingProfile = editingProfile;
    this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);

    // Trusting the workspace while the wizard is open removes the notice.
    const trustListener = vscode.workspace.onDidGrantWorkspaceTrust(() => {
      this.dispatch(() => sendInit(this.host), 'init');
    });
    this.panel.onDidDispose(() => {
      trustListener.dispose();
      ConnectionWizardPanel.currentPanel = undefined;
    });

    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      this.dispatch(() => handleMessage(this.host, message), requestType(message));
    });
  }

  public static createOrShow(
    context: vscode.ExtensionContext,
    profileStore: ProfileStore,
    secretStore: SecretStore,
    fmClient: FMClient,
    logger: Logger,
    editingProfile?: ConnectionProfile,
    options: ConnectionWizardOptions = {}
  ): void {
    const current = ConnectionWizardPanel.currentPanel;
    if (current) {
      current.editingProfile = editingProfile;
      current.panel.reveal(vscode.ViewColumn.One);
      current.dispatch(() => sendLoadProfile(current.host), 'loadProfile');
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'filemakerConnectionWizard',
      editingProfile ? `Edit Profile — ${editingProfile.name}` : 'Add Connection Profile',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'dist', 'webviews', 'connectionWizard', 'ui')
        ]
      }
    );

    ConnectionWizardPanel.currentPanel = new ConnectionWizardPanel(
      panel,
      context,
      profileStore,
      secretStore,
      fmClient,
      logger,
      editingProfile,
      options
    );
  }
  /** A checked view of the same panel state; no services or secrets are copied. */
  private get host(): WizardContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Type queries check the private members exposed to modules.
    const host = this;
    return host as unknown as {
      panel: typeof host.panel;
      profileStore: typeof host.profileStore;
      secretStore: typeof host.secretStore;
      fmClient: typeof host.fmClient;
      logger: typeof host.logger;
      options: typeof host.options;
      editingProfile: typeof host.editingProfile;
      templateOrigins: typeof host.templateOrigins;
      certificateTarget: typeof host.certificateTarget;
      certState: typeof host.certState;
    };
  }


  /**
   * The host hands the panel a message and returns; the handler runs on its own. A failure is
   * logged and posted to the page, so the user reads the reason instead of an empty panel.
   */
  private dispatch(run: () => PromiseLike<void>, type?: string): void {
    guardDispatch(run, {
      label: 'Connection wizard request',
      type,
      logger: this.logger,
      formatError: (error) => formatError(error),
      postError: (message) => this.postError(message)
    });
  }

  /** The page shows this in its status line, like the save and test failures do. */
  private async postError(message: string): Promise<void> {
    await this.panel.webview.postMessage({ type: 'error', message });
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = createNonce();
    const uiBase = vscode.Uri.joinPath(
      this.context.extensionUri,
      'dist',
      'webviews',
      'connectionWizard',
      'ui'
    );
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(uiBase, 'styles.css'));
    const standardsStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(uiBase, 'fieldStandards.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(uiBase, 'index.js'));
    const csp = buildWebviewCsp(webview, { nonce });

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${standardsStyleUri}" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Connection Profile</title>
</head>
<body>
  <!--
    Wrapping <form id="wizardForm"> is load-bearing: the UI script
    (connectionWizard/ui/index.js) installs delegated input/change listeners
    on it to drive the "test result is stale" badge. Every nested <button>
    has type="button" so this never submits. Removing the form here would
    silently regress the badge state machine (the script would null-deref
    on document.getElementById('wizardForm')).
  -->
  <form id="wizardForm" class="container">
    <div id="restrictedNotice" class="restricted-notice hidden" role="note">
      <strong>This workspace is in Restricted Mode.</strong>
      <span>What is limited here: a profile template in the project (<code>.filemaker/profile-template.json</code>) is ignored, so nothing is filled in from the project, and workspace settings that change how connections and commands behave (offline mode, feature switches, enterprise settings, batch limits, output folders) are ignored until you trust the workspace. Your profile, password and test connection work as usual, and a profile you save is yours (it is not stored in the project).</span>
      <button id="manageTrustBtn" type="button">Manage Workspace Trust</button>
    </div>
    <h1>Connection Profile</h1>
    <p class="subtitle">Configure a connection to your FileMaker Server.</p>

    <div class="fm-panel">
    <div class="form-section">
      <h2>Profile</h2>
      <div class="field">
        <label for="profileName">Profile Name <span class="required-marker" aria-hidden="true">*</span></label>
        <input id="profileName" type="text" required aria-required="true"
               placeholder="e.g. Production Server" />
      </div>
    </div>

    <div class="form-section">
      <h2 id="auth-mode-heading">Authentication Mode</h2>
      <div class="mode-toggle" role="group" aria-labelledby="auth-mode-heading">
        <button type="button" id="modeDirectBtn" aria-pressed="true">Direct</button>
        <button type="button" id="modeProxyBtn" aria-pressed="false">Proxy</button>
      </div>
      <p class="hint" style="margin-top: -8px;">
        <strong>Direct</strong> connects to FileMaker Data API directly.
        <strong>Proxy</strong> connects through your middleware endpoint.
      </p>
    </div>

    <div class="form-section">
      <h2>Server</h2>
      <div class="field">
        <label for="serverUrl">Server URL <span class="required-marker" aria-hidden="true">*</span></label>
        <input id="serverUrl" type="url" required aria-required="true"
               aria-describedby="serverUrl-hint"
               placeholder="https://fm.yourcompany.com" />
        <div id="serverUrl-hint" class="hint">The HTTPS address of your FileMaker Server.</div>
      </div>
      <div class="field">
        <label for="database">Database Name <span class="required-marker" aria-hidden="true">*</span></label>
        <input id="database" type="text" required aria-required="true"
               aria-describedby="database-hint"
               placeholder="MyDatabase" />
        <div id="database-hint" class="hint">The hosted FileMaker database file name.</div>
      </div>
      <!--
        API Base Path and API Version are correct out of the box for 99% of
        servers. Surfacing them as top-level inputs makes new users second-
        guess whether they need to configure them, and they account for a
        chunk of "I don't know what to fill in" friction in the wizard.
        Hidden behind <details> so the defaults stay populated but the visual
        weight goes to fields that actually matter on first save.
      -->
      <details class="advanced-toggle">
        <summary>Advanced server options</summary>
        <div class="field">
          <label for="apiBasePath">API Base Path</label>
          <input id="apiBasePath" type="text" value="/fmi/data"
                 aria-describedby="apiBasePath-hint" />
          <div id="apiBasePath-hint" class="hint">Usually <code>/fmi/data</code>. Change only if your server uses a custom path.</div>
        </div>
        <div class="field">
          <label for="apiVersionPath">API Version</label>
          <input id="apiVersionPath" type="text" value="vLatest"
                 aria-describedby="apiVersionPath-hint" />
          <div id="apiVersionPath-hint" class="hint">Usually <code>vLatest</code>.</div>
        </div>
      </details>
    </div>

    <div class="form-section">
      <details class="advanced-toggle" id="certificateOptions">
        <summary>Certificates (advanced)</summary>
        <div class="field">
          <label for="caBundlePath">Custom CA certificate file</label>
          <input id="caBundlePath" type="text" autocomplete="off"
                 aria-describedby="caBundlePath-hint"
                 placeholder="/path/to/company-ca.pem" />
          <button type="button" id="pickCaBundle" class="secondary" aria-label="Browse for a CA certificate file">Browse…</button>
          <div id="caBundlePath-hint" class="hint">Optional. Absolute path to a PEM file with the certificate authority that signed your server's certificate. It is added to the certificates this computer already trusts (the built-in public list and, where VS Code can read it, the operating system's store), so public servers still work. This is the safe way to trust a private server.</div>
        </div>
        <div class="field">
          <label>Trusted server certificate</label>
          <div id="certificateStatus" class="hint" role="status">No certificate has been trusted by hand. The server's certificate is checked the normal way.</div>
          <div class="inline-actions">
            <button type="button" id="reviewCertBtn" class="secondary">Review server certificate…</button>
            <button type="button" id="forgetCertBtn" class="secondary hidden">Forget trusted certificate</button>
          </div>
          <div class="hint">For a private or self-signed server without a CA file: shows who the certificate is for, its dates and its SHA-256 fingerprint, and trusts exactly that one certificate if you agree. If the server later presents a different one, the connection is refused until you review it again. No VS Code setting change is needed. A trusted certificate requires a direct connection without a proxy. Test Connection offers this when it meets a certificate problem.</div>
        </div>
        <div id="legacyTlsWarning" class="field legacy-tls-warning hidden" role="alert">
          <strong>⚠ This connection skips ALL certificate checks.</strong>
          <div class="hint warning-hint">An older setting turned certificate checking off for this profile, so expired, wrong-host or forged certificates are all accepted. Replace it with a pinned certificate.</div>
          <div class="inline-actions">
            <button type="button" id="convertCertBtn" class="primary">Convert to a pinned certificate…</button>
            <button type="button" id="stopSkippingBtn" class="secondary">Check certificates normally</button>
          </div>
        </div>
      </details>
    </div>

    <div id="directFields" class="form-section direct-fields">
      <h2>Credentials</h2>
      <div class="field">
        <label for="username">Username <span class="required-marker" aria-hidden="true">*</span></label>
        <input id="username" type="text" required aria-required="true"
               aria-describedby="username-hint"
               placeholder="api_user" autocomplete="username" />
        <div id="username-hint" class="hint">The FileMaker account with fmrest privilege.</div>
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" type="password"
               aria-describedby="password-hint"
               autocomplete="current-password" />
        <div id="password-hint" class="hint">Stored securely in VS Code SecretStorage. Never written to disk.</div>
      </div>
    </div>

    <div id="proxyFields" class="form-section proxy-fields">
      <h2>Proxy Settings</h2>
      <div class="field">
        <label for="proxyEndpoint">Proxy Endpoint <span class="required-marker" aria-hidden="true">*</span></label>
        <input id="proxyEndpoint" type="url" required aria-required="true"
               aria-describedby="proxyEndpoint-hint"
               placeholder="https://api.yourcompany.com/fm-proxy" />
        <div id="proxyEndpoint-hint" class="hint">Your middleware endpoint URL.</div>
      </div>
      <div class="field">
        <label for="proxyApiKey">API Key (optional)</label>
        <input id="proxyApiKey" type="password" autocomplete="off"
               aria-describedby="proxyApiKey-hint" />
        <div id="proxyApiKey-hint" class="hint">Sent as a Bearer token to your proxy. Stored securely.</div>
      </div>
    </div>

    <div class="actions">
      <button type="button" id="saveBtn" class="primary">Save Profile</button>
      <button type="button" id="testBtn" class="secondary">Test Connection</button>
    </div>

    <div id="status" class="status" role="status" aria-live="polite"></div>
    </div>
  </form>

  ${versionFooterHtml()}
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unexpected error in the connection wizard.';
}
