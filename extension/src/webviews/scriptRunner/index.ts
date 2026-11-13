import * as vscode from 'vscode';

import { RoleGuard } from '../../enterprise/roleGuard';
import { FMClientError } from '../../services/errors';
import type { FMClient } from '../../services/fmClient';
import type { Logger } from '../../services/logger';
import type { ProfileStore } from '../../services/profileStore';
import { describeScriptErrors, extractScriptErrors } from '../../services/responseGuard';
import { assertNameProvided, assertUsableUrlName } from '../../utils/urlSegment';
import type { RunScriptRequest } from '../../types/fm';
import { deliverSnippet, parseSnippetDelivery, type SnippetDelivery } from '../../snippets/deliver';
import type { SnippetFormat } from '../../snippets/model';
import { buildWebviewCsp, createNonce } from '../common/csp';
import { guardDispatch, requestType } from '../common/dispatch';
import {
  getStringField,
  toRecord
} from '../common/messageValidation';
import { isFeatureEnabled, isOfflineModeOn } from '../../utils/policySetting';
import { versionFooterHtml } from '../../about/runtimeVersion';

interface ScriptRunnerOpenOptions {
  profileId?: string;
  layout?: string;
  recordId?: string;
}

interface RunScriptPayload {
  profileId: string;
  layout: string;
  recordId?: string;
  scriptName: string;
  scriptParam?: string;
}

interface CopySnippetPayload extends RunScriptPayload {
  delivery: SnippetDelivery;
}

const UNTRUSTED_RUNNER_MESSAGE =
  'The Script Runner is disabled in untrusted workspaces. Trust the workspace to run scripts.';

type IncomingMessage =
  | { type: 'ready' }
  | { type: 'loadLayouts'; profileId: string }
  | { type: 'runScript'; payload: RunScriptPayload }
  | { type: 'copyCurl'; payload: CopySnippetPayload }
  | { type: 'copyFetch'; payload: CopySnippetPayload }
  | { type: 'copyRequest'; payload: CopySnippetPayload };

export class ScriptRunnerPanel {
  private requestInFlight = false;
  private static currentPanel: ScriptRunnerPanel | undefined;

  private pendingDefaults: ScriptRunnerOpenOptions | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly profileStore: ProfileStore,
    private readonly fmClient: FMClient,
    private readonly logger: Logger,
    defaults?: ScriptRunnerOpenOptions
  ) {
    this.pendingDefaults = defaults;
    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => {
      ScriptRunnerPanel.currentPanel = undefined;
    });

    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      this.dispatch(() => this.handleMessage(message), requestType(message));
    });
  }

  public static createOrShow(
    context: vscode.ExtensionContext,
    profileStore: ProfileStore,
    fmClient: FMClient,
    logger: Logger,
    defaults?: ScriptRunnerOpenOptions
  ): void {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(UNTRUSTED_RUNNER_MESSAGE);
      return;
    }

    const column = vscode.ViewColumn.One;

    const current = ScriptRunnerPanel.currentPanel;
    if (current) {
      current.panel.reveal(column);
      current.pendingDefaults = defaults;
      current.dispatch(() => current.sendInit(), 'init');
      return;
    }

    const panel = vscode.window.createWebviewPanel('filemakerScriptRunner', 'FileMaker Script Runner', column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'dist', 'webviews', 'scriptRunner', 'ui')
      ]
    });

    ScriptRunnerPanel.currentPanel = new ScriptRunnerPanel(
      panel,
      context,
      profileStore,
      fmClient,
      logger,
      defaults
    );
  }

  /**
   * The host hands the panel a message and returns; the handler runs on its own. A failure is
   * logged and posted to the page, so the user reads the reason instead of an empty panel.
   */
  private dispatch(run: () => PromiseLike<void>, type?: string): void {
    guardDispatch(run, {
      label: 'Script runner request',
      type,
      logger: this.logger,
      formatError: (error) => formatError(error),
      postError: (message) => this.postError(message)
    });
  }

  private async handleMessage(rawMessage: unknown): Promise<void> {
    const message = this.parseMessage(rawMessage);
    if (!message) {
      return;
    }

    // Defence in depth, as in the record editor: scripts run only in a trusted workspace.
    if (!vscode.workspace.isTrusted && message.type !== 'ready') {
      await this.panel.webview.postMessage({
        type: 'unsupported',
        message: UNTRUSTED_RUNNER_MESSAGE
      });
      return;
    }

    const guarded = ['runScript'].includes(message.type);
    if (guarded && this.requestInFlight) return;
    if (guarded) this.requestInFlight = true;
    try {
      switch (message.type) {
        case 'ready':
          await this.sendInit();
          break;
        case 'loadLayouts':
          await this.loadLayouts(message.profileId);
          break;
        case 'runScript':
          await this.runScript(message.payload);
          break;
        case 'copyCurl':
        case 'copyFetch':
        case 'copyRequest':
          await this.copyRequest(message.payload);
          break;
        default:
          break;
      }
    } finally {
      if (guarded) this.requestInFlight = false;
    }
  }

  private async sendInit(): Promise<void> {
    const profiles = await this.profileStore.listProfiles();
    const configuration = vscode.workspace.getConfiguration('filemaker');
    const scriptRunnerEnabled = isFeatureEnabled(configuration, 'features.scriptRunner.enabled');
    const includeAuthByDefault = configuration.get<boolean>('snippets.includeAuthByDefault', false);
    const parameterBuilderEnabled = configuration.get<boolean>('scripts.parameterBuilder.enabled', true);

    await this.panel.webview.postMessage({
      type: 'init',
      payload: {
        profiles: profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          database: profile.database,
          authMode: profile.authMode
        })),
        activeProfileId: this.profileStore.getActiveProfileId(),
        defaults: this.pendingDefaults,
        scriptRunnerEnabled,
        includeAuthByDefault,
        parameterBuilderEnabled
      }
    });

    this.pendingDefaults = undefined;
  }

  private async loadLayouts(profileId: string): Promise<void> {
    const profile = await this.profileStore.getProfile(profileId);

    if (!profile) {
      await this.postError('Connection profile not found.');
      return;
    }

    try {
      const layouts = await this.fmClient.listLayouts(profile);
      await this.panel.webview.postMessage({
        type: 'layoutsLoaded',
        payload: {
          profileId,
          layouts
        }
      });
    } catch (error) {
      await this.postError(formatError(error));
    }
  }

  private async runScript(payload: RunScriptPayload): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('filemaker');
    const scriptRunnerEnabled = isFeatureEnabled(configuration, 'features.scriptRunner.enabled');
    const offlineMode = isOfflineModeOn(configuration);

    if (!scriptRunnerEnabled) {
      await this.panel.webview.postMessage({
        type: 'unsupported',
        message: 'Script runner is disabled by setting filemaker.features.scriptRunner.enabled.'
      });
      return;
    }
    if (offlineMode) {
      await this.panel.webview.postMessage({
        type: 'unsupported',
        message: 'Offline mode is enabled; script execution is disabled.'
      });
      return;
    }

    const policy = new RoleGuard(this.logger);
    await policy.refresh();
    const guard = policy.getFeatureGuard('scriptRunner');
    if (!guard.allowed) {
      await this.postError(`Script execution is unavailable. ${guard.reason ?? 'Restricted by policy.'}`);
      return;
    }

    const profile = await this.profileStore.getProfile(payload.profileId);
    if (!profile) {
      await this.postError('Connection profile not found.');
      return;
    }

    try {
      const request = validateRunScriptPayload(payload);
      const result = await this.fmClient.runScript(profile, request);

      const payloadForPage = { profileId: payload.profileId, request, result };

      // A script that ran but reported a non-zero error (for example 3, "command is unavailable") is not a
      // success: the Data API answers 200 with `scriptError` in the response, so the page needs it spelled out.
      const scriptErrors = extractScriptErrors(result.response);
      await this.panel.webview.postMessage({
        type: 'scriptResult',
        payload: {
          ...payloadForPage,
          scriptErrors,
          scriptErrorText: scriptErrors.length > 0 ? describeScriptErrors(scriptErrors) : undefined
        }
      });
    } catch (error) {
      if (error instanceof FMClientError && error.code === 'SCRIPT_UNSUPPORTED') {
        await this.panel.webview.postMessage({
          type: 'unsupported',
          message: error.message
        });
        return;
      }

      this.logger.warn('Script runner failed.', { error, payload });
      await this.postError(formatError(error));
    }
  }

  private async copyRequest(payload: CopySnippetPayload): Promise<void> {
    const profile = await this.profileStore.getProfile(payload.profileId);
    if (!profile) {
      await this.postError('Connection profile not found.');
      return;
    }

    try {
      const request = validateRunScriptPayload(payload);
      await deliverSnippet(
        profile,
        {
          kind: 'runScript',
          layout: request.layout,
          scriptName: request.scriptName,
          scriptParam: request.scriptParam,
          recordId: request.recordId
        },
        payload.delivery
      );
    } catch (error) {
      await this.postError(formatError(error));
    }
  }

  private async postError(message: string): Promise<void> {
    await this.panel.webview.postMessage({
      type: 'error',
      message
    });
  }

  private parseMessage(rawMessage: unknown): IncomingMessage | undefined {
    const value = toRecord(rawMessage);
    if (!value) {
      return undefined;
    }

    if (value.type === 'ready') {
      return { type: 'ready' };
    }

    const profileId = getStringField(value, 'profileId');
    if (value.type === 'loadLayouts' && profileId) {
      return {
        type: 'loadLayouts',
        profileId
      };
    }

    if (value.type === 'runScript') {
      const payload = parseRunPayload(value.payload);
      if (!payload) {
        return undefined;
      }

      return {
        type: 'runScript',
        payload
      };
    }

    if (value.type === 'copyCurl' || value.type === 'copyFetch' || value.type === 'copyRequest') {
      // The two older message types name their format; `copyRequest` carries it in the payload.
      const fallback: SnippetFormat | undefined =
        value.type === 'copyCurl' ? 'curl' : value.type === 'copyFetch' ? 'fetch' : undefined;
      const payload = parseCopyPayload(value.payload, fallback);
      if (!payload) {
        return undefined;
      }

      return {
        type: value.type,
        payload
      };
    }

    return undefined;
  }

  private getHtml(webview: vscode.Webview): string {
    const standardsStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews', 'scriptRunner', 'ui', 'fieldStandards.css')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews', 'scriptRunner', 'ui', 'styles.css')
    );

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews', 'scriptRunner', 'ui', 'index.js')
    );

    const nonce = createNonce();
    const csp = buildWebviewCsp(webview, {
      nonce
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>FileMaker Script Runner</title>
  <link rel="stylesheet" href="${standardsStyleUri}" />
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <div class="container">
    <header class="header">
      <h1>FileMaker Script Runner</h1>
      <p>Run FileMaker scripts with safe request previews.</p>
    </header>

    <section class="panel">
      <div class="row">
        <label for="profileSelect">Profile</label>
        <select id="profileSelect"></select>
      </div>
      <div class="row">
        <label for="layoutSelect">Layout</label>
        <select id="layoutSelect"></select>
      </div>
      <div class="row">
        <label for="recordIdInput">Record ID (optional)</label>
        <input id="recordIdInput" type="text" placeholder="1" />
      </div>
      <div class="row">
        <label for="scriptNameInput">Script Name</label>
        <input id="scriptNameInput" type="text" placeholder="MyScript" />
      </div>
      <div class="row">
        <label for="scriptParamInput">Script Parameter (optional)</label>
        <div class="parameter-input-group">
          <textarea id="scriptParamInput" rows="3" placeholder="Any string payload"></textarea>
          <button class="secondary" id="buildParameterButton" type="button" aria-expanded="false" aria-controls="parameterBuilderPanel">Build Parameter</button>
        </div>
      </div>
      <section id="parameterBuilderPanel" class="panel builder-panel hidden" aria-labelledby="parameterBuilderTitle">
        <h2 id="parameterBuilderTitle">Build Parameter</h2>
        <div id="parameterRows" class="builder-rows"></div>
        <div class="builder-toolbar">
          <button class="secondary" id="addParameterRowButton" type="button">Add Row</button>
        </div>
        <div class="row">
          <label for="parameterPreview">JSON Preview</label>
          <pre id="parameterPreview" class="parameter-preview" role="status" aria-live="polite">{}</pre>
        </div>
        <p id="parameterBuilderStatus" class="status builder-status" role="status" aria-live="polite"></p>
        <div class="actions builder-actions">
          <button id="applyParameterButton" type="button">Apply Parameter</button>
          <button id="closeParameterBuilderButton" type="button" class="secondary">Close</button>
        </div>
      </section>
      <div class="row inline">
        <label class="toggle"><input id="includeAuthCheckbox" type="checkbox" /> Include auth header in snippets</label>
      </div>
      <div class="actions">
        <button id="runButton">Run Script</button>
        <details class="menu" id="copyRequestMenu">
          <summary class="secondary">Copy request</summary>
          <div class="menu-items">
            <button id="copyCurlButton" type="button" data-copy-format="curl">Copy as curl</button>
            <button id="copyFetchButton" type="button" data-copy-format="fetch">Copy as fetch()</button>
            <button id="copyHttpButton" type="button" data-copy-format="http">Copy as .http (REST Client)</button>
            <button id="copyPostmanButton" type="button" data-copy-format="postman">Copy as Postman collection</button>
            <button id="copyTypeScriptButton" type="button" data-copy-format="typescript">Copy as TypeScript</button>
            <button id="saveHttpButton" type="button" data-copy-format="http" data-copy-destination="editor" title="Opens the request in a new editor. Save it where you want.">Save as .http file…</button>
          </div>
        </details>
      </div>
      <p id="status" class="status" role="status" aria-live="polite"></p>
    </section>

    <section class="panel">
      <h2>Result</h2>
      <div id="summary" class="summary" role="status" aria-live="polite">No script run yet.</div>
      <pre id="rawResult" class="raw"></pre>
    </section>
  </div>

  ${versionFooterHtml()}
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function parseRunPayload(value: unknown): RunScriptPayload | undefined {
  const payload = toRecord(value);
  if (!payload) {
    return undefined;
  }

  const profileId = getStringField(payload, 'profileId');
  const layout = getStringField(payload, 'layout');
  const scriptName = getStringField(payload, 'scriptName');

  if (!profileId || !layout || !scriptName) {
    return undefined;
  }

  return {
    profileId,
    layout,
    scriptName,
    scriptParam: getStringField(payload, 'scriptParam'),
    recordId: getStringField(payload, 'recordId')
  };
}

function parseCopyPayload(value: unknown, fallbackFormat?: SnippetFormat): CopySnippetPayload | undefined {
  const payload = parseRunPayload(value);
  const raw = toRecord(value);
  const delivery = raw ? parseSnippetDelivery(raw, fallbackFormat) : undefined;
  if (!payload || !delivery) {
    return undefined;
  }

  return { ...payload, delivery };
}

function validateRunScriptPayload(payload: RunScriptPayload): RunScriptRequest {
  // Script and layout names are used exactly as given: a leading or trailing space is part of the name.
  const scriptName = payload.scriptName;

  assertNameProvided(scriptName, 'Script name is required.');

  const layout = payload.layout;
  assertNameProvided(layout, 'Layout is required.');
  assertUsableUrlName(scriptName, 'script');
  assertUsableUrlName(layout, 'layout');

  return {
    layout,
    scriptName,
    scriptParam: payload.scriptParam?.trim() ? payload.scriptParam : undefined,
    recordId: payload.recordId?.trim() ? payload.recordId : undefined
  };
}

function formatError(error: unknown): string {
  if (error instanceof FMClientError && error.kind === 'timeout') {
    // The request gave up waiting; the server was not told to stop.
    return `${error.message} The script may still be running on the server.`;
  }
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unexpected error.';
}
