import { designerLayoutMetadata } from '../../fmweb/fieldMetadata';
import * as vscode from 'vscode';

import { SettingsService } from '../../services/settingsService';
import type { FMClient } from '../../services/fmClient';
import type { Logger } from '../../services/logger';
import type { ProfileStore } from '../../services/profileStore';
import type { FileMakerRecord } from '../../types/fm';
import { buildWebviewCsp, createNonce, profileImageSources, serverOrigin } from '../common/csp';
import { guardDispatch, requestType } from '../common/dispatch';
import { getStringField, toRecord } from '../common/messageValidation';
import {
  deliverSnippet,
  parseRecordRequestPayload,
  recordOperation,
  type RecordRequestPayload
} from '../../snippets/deliver';
import { copyRecordRequestMenuHtml } from '../../snippets/recordMenuHtml';
import { versionFooterHtml } from '../../about/runtimeVersion';

interface RecordViewerOpenOptions {
  profileId?: string;
  layout?: string;
  recordId?: string;
}

interface LoadRecordPayload {
  portal?: string;
  portalLimit?: number;
  profileId: string;
  layout: string;
  recordId: string;
}

type IncomingMessage =
  | { type: 'ready' }
  | { type: 'loadLayouts'; profileId: string }
  | { type: 'loadRecord'; payload: LoadRecordPayload }
  | { type: 'exportRecord' }
  | { type: 'copyRecordRequest'; payload: RecordRequestPayload };

export class RecordViewerPanel {
  private readonly requestsInFlight = new Set<string>();
  private static currentPanel: RecordViewerPanel | undefined;

  private recordLoadVersion = 0;
  private pendingDefaults: RecordViewerOpenOptions | undefined;
  private lastRecord: { profileId: string; layout: string; record: FileMakerRecord } | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly profileStore: ProfileStore,
    private readonly fmClient: FMClient,
    private readonly logger: Logger,
    defaults?: RecordViewerOpenOptions
  ) {
    this.pendingDefaults = defaults;
    this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);

    this.panel.onDidDispose(() => {
      RecordViewerPanel.currentPanel = undefined;
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
    defaults?: RecordViewerOpenOptions
  ): void {
    const column = vscode.ViewColumn.One;

    const current = RecordViewerPanel.currentPanel;
    if (current) {
      current.panel.reveal(column);
      current.pendingDefaults = defaults;
      current.dispatch(() => current.sendInitState(), 'init');
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'filemakerRecordViewer',
      'FileMaker Record Viewer',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'dist', 'webviews', 'recordViewer', 'ui')
        ]
      }
    );

    RecordViewerPanel.currentPanel = new RecordViewerPanel(
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
      label: 'Record viewer request',
      type,
      logger: this.logger,
      formatError: (error) => this.formatError(error),
      postError: (message) => this.postError(message)
    });
  }

  private async handleMessage(rawMessage: unknown): Promise<void> {
    const message = this.parseIncomingMessage(rawMessage);
    if (!message) {
      return;
    }

    const guarded = ['loadRecord'].includes(message.type);
    const requestKey = guarded && 'payload' in message ? message.type === 'loadRecord' ? `load:${JSON.stringify(message.payload)}` : 'write' : undefined;
    if (requestKey && this.requestsInFlight.has(requestKey)) return;
    if (requestKey) this.requestsInFlight.add(requestKey);
    try {
      switch (message.type) {
        case 'ready': {
          await this.sendInitState();
          break;
        }
        case 'loadLayouts': {
          await this.handleLoadLayouts(message.profileId);
          break;
        }
        case 'loadRecord': {
          await this.handleLoadRecord(message.payload);
          break;
        }
        case 'exportRecord': {
          await this.exportRecord();
          break;
        }
        case 'copyRecordRequest': {
          await this.copyRecordRequest(message.payload);
          break;
        }
        default:
          break;
      }
    } finally {
      if (requestKey) this.requestsInFlight.delete(requestKey);
    }
  }

  private async sendInitState(): Promise<void> {
    const profiles = await this.profileStore.listProfiles();

    await this.panel.webview.postMessage({
      type: 'init',
      payload: {
        profiles: profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          serverOrigin: serverOrigin(profile.serverUrl),
          database: profile.database,
          authMode: profile.authMode
        })),
        activeProfileId: this.profileStore.getActiveProfileId(),
        defaults: this.pendingDefaults
      }
    });

    this.pendingDefaults = undefined;
  }

  private async handleLoadLayouts(profileId: string): Promise<void> {
    const profile = await this.profileStore.getProfile(profileId);
    if (!profile) {
      await this.postError('The selected connection profile could not be found.');
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
      this.logger.error('Failed to load layouts for record viewer.', { profileId, error });
      await this.postError(this.formatError(error));
    }
  }

  private async handleLoadRecord(payload: LoadRecordPayload): Promise<void> {
    const loadVersion = ++this.recordLoadVersion;
    const profile = await this.profileStore.getProfile(payload.profileId);
    if (loadVersion !== this.recordLoadVersion) return;
    if (!profile) {
      await this.postError('The selected profile no longer exists.');
      return;
    }

    try {
      const presentation = new SettingsService().isSchemaMetadataEnabled()
        ? this.fmClient.getLayoutMetadata(profile, payload.layout, { recordHistory: false })
          .then((metadata) => designerLayoutMetadata(payload.layout, metadata).fields)
          .catch(() => []) // Presentation metadata must never prevent viewing a record.
        : Promise.resolve([]);
      const [loadedRecord, presentationFields] = await Promise.all([
        payload.portal && payload.portalLimit
          ? this.fmClient.getRecord(profile, payload.layout, payload.recordId, { portal: { [payload.portal]: { limit: payload.portalLimit, offset: 1 } } })
          : this.fmClient.getRecord(profile, payload.layout, payload.recordId),
        presentation
      ]);
      if (loadVersion !== this.recordLoadVersion) return;
      let record = loadedRecord;
      const previous = this.lastRecord;
      if (payload.portal && previous?.profileId === payload.profileId && previous.layout === payload.layout && previous.record.recordId === payload.recordId) {
        const portalName = payload.portal;
        record = {
          ...loadedRecord,
          portalData: {
            ...previous.record.portalData,
            ...(Object.hasOwn(loadedRecord.portalData ?? {}, portalName)
              ? { [portalName]: loadedRecord.portalData![portalName]! } : {})
          },
          portalDataInfo: [
            ...(previous.record.portalDataInfo ?? []).filter((info) => (info.portalObjectName ?? info.table) !== portalName),
            ...(loadedRecord.portalDataInfo ?? []).filter((info) => (info.portalObjectName ?? info.table) === portalName)
          ]
        };
      }
      this.lastRecord = {
        profileId: payload.profileId,
        layout: payload.layout,
        record
      };

      await this.panel.webview.postMessage({
        type: 'recordLoaded',
        payload: { ...this.lastRecord, presentationFields }
      });
    } catch (error) {
      if (loadVersion === this.recordLoadVersion) await this.postError(this.formatError(error));
    }
  }

  private async copyRecordRequest(payload: RecordRequestPayload): Promise<void> {
    const profile = await this.profileStore.getProfile(payload.profileId);
    if (!profile) {
      await this.postError('The selected profile no longer exists.');
      return;
    }

    try {
      await deliverSnippet(
        profile,
        recordOperation(payload.kind, payload.layout, payload.recordId),
        payload.delivery
      );
    } catch (error) {
      await this.postError(this.formatError(error));
    }
  }

  private async exportRecord(): Promise<void> {
    if (!this.lastRecord) {
      await this.postError('No record loaded yet.');
      return;
    }

    const document = await vscode.workspace.openTextDocument({
      language: 'json',
      content: JSON.stringify(this.lastRecord, null, 2)
    });

    await vscode.window.showTextDocument(document, { preview: false });
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return 'Unknown error while processing record viewer request.';
  }

  private async postError(message: string): Promise<void> {
    await this.panel.webview.postMessage({
      type: 'error',
      message
    });
  }

  private parseIncomingMessage(rawMessage: unknown): IncomingMessage | undefined {
    const value = toRecord(rawMessage);
    if (!value) {
      return undefined;
    }

    const type = getStringField(value, 'type');
    if (!type) {
      return undefined;
    }

    switch (type) {
      case 'ready':
        return { type };
      case 'loadLayouts': {
        const profileId = getStringField(value, 'profileId');
        if (!profileId) {
          return undefined;
        }

        return {
          type,
          profileId
        };
      }
      case 'loadRecord': {
        const payload = this.parseLoadRecordPayload(value.payload);
        if (!payload) {
          return undefined;
        }

        return {
          type,
          payload
        };
      }
      case 'exportRecord':
        return { type };
      case 'copyRecordRequest': {
        const payload = parseRecordRequestPayload(value.payload);
        return payload ? { type, payload } : undefined;
      }
      default:
        return undefined;
    }
  }

  private parseLoadRecordPayload(rawPayload: unknown): LoadRecordPayload | undefined {
    const payload = toRecord(rawPayload);
    if (!payload) {
      return undefined;
    }

    const profileId = getStringField(payload, 'profileId');
    const layout = getStringField(payload, 'layout');
    const recordId = getStringField(payload, 'recordId');
    if (!profileId || !layout || !recordId) {
      return undefined;
    }

    const portal = typeof payload.portal === 'string' && payload.portal.length > 0 ? payload.portal : undefined;
    const portalLimit = typeof payload.portalLimit === 'number' && Number.isInteger(payload.portalLimit) && payload.portalLimit > 0 && payload.portalLimit <= 250_000 ? payload.portalLimit : undefined;
    if (portal && !portalLimit) return undefined;
    return { profileId, layout, recordId, ...(portal ? { portal, portalLimit } : {}) };
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews', 'recordViewer', 'ui', 'styles.css')
    );

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews', 'recordViewer', 'ui', 'index.js')
    );

    const standardsStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews', 'recordViewer', 'ui', 'fieldStandards.css')
    );
    const standardsScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews', 'recordViewer', 'ui', 'fieldStandards.js')
    );

    const nonce = createNonce();
    const csp = buildWebviewCsp(webview, {
      nonce,
      // A container image is served by the FileMaker server of a profile.
      imageSources: profileImageSources(this.profileStore)
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>FileMaker Record Viewer</title>
  <link rel="stylesheet" href="${standardsStyleUri}" />
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <div class="container">
    <header class="header">
      <h1>FileMaker Record Viewer</h1>
      <p>Inspect one record and related portal data.</p>
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
        <label for="recordIdInput">Record ID</label>
        <input id="recordIdInput" type="text" placeholder="1" />
      </div>
      <div class="actions">
        <button id="loadButton">Load Record</button>
        <button class="secondary" id="exportButton">Export Record JSON</button>
        ${copyRecordRequestMenuHtml()}
      </div>
      <p id="status" class="status" role="status" aria-live="polite"></p>
    </section>

    <section class="panel">
      <h2>Record</h2>
      <div id="fieldDataContainer"></div>
      <div id="relatedDataContainer" class="related"></div>
      <pre id="rawJson" class="raw"></pre>
    </section>
  </div>

  ${versionFooterHtml()}
  <script nonce="${nonce}" src="${standardsScriptUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
