import { safeFileName } from '../../utils/safeText';
import * as vscode from 'vscode';

import type { Logger } from '../../services/logger';
import type { SchemaDiffResult } from '../../types/fm';
import { buildWebviewCsp, createNonce } from '../common/csp';
import { guardDispatch, requestType } from '../common/dispatch';
import { toRecord } from '../common/messageValidation';
import { versionFooterHtml } from '../../about/runtimeVersion';

interface SchemaDiffWebviewMessage {
  type: 'ready' | 'exportJson';
}

export class SchemaDiffPanel {
  private static currentPanel: SchemaDiffPanel | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Pick<Logger, 'error'>,
    private diff: SchemaDiffResult
  ) {
    this.panel.webview.html = this.renderHtml(panel.webview);
    this.panel.onDidDispose(() => {
      SchemaDiffPanel.currentPanel = undefined;
    });

    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      this.dispatch(() => this.handleMessage(message), requestType(message));
    });
  }

  public static createOrShow(
    context: vscode.ExtensionContext,
    diff: SchemaDiffResult,
    logger: Pick<Logger, 'error'>
  ): void {
    const current = SchemaDiffPanel.currentPanel;
    if (current) {
      current.diff = diff;
      current.panel.reveal(vscode.ViewColumn.One);
      current.dispatch(() => current.sendDiff(), 'sendDiff');
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'filemakerSchemaDiff',
      'FileMaker Schema Diff',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'dist', 'webviews', 'schemaDiff', 'ui')
        ]
      }
    );

    SchemaDiffPanel.currentPanel = new SchemaDiffPanel(panel, context, logger, diff);
  }

  /**
   * The host hands the panel a message and returns; the handler runs on its own. A failure is
   * logged and posted to the page, so the user reads the reason instead of an empty panel.
   */
  private dispatch(run: () => PromiseLike<void>, type?: string): void {
    guardDispatch(run, {
      label: 'Schema diff request',
      type,
      logger: this.logger,
      formatError: (error) => formatError(error),
      postError: (message) => this.postError(message)
    });
  }

  private async postError(message: string): Promise<void> {
    await this.panel.webview.postMessage({ type: 'error', message });
  }

  private async handleMessage(message: unknown): Promise<void> {
    const incoming = parseMessage(message);
    if (!incoming) {
      return;
    }

    switch (incoming.type) {
      case 'ready':
        await this.sendDiff();
        break;
      case 'exportJson':
        await this.exportDiffJson();
        break;
      default:
        break;
    }
  }

  private async sendDiff(): Promise<void> {
    await this.panel.webview.postMessage({
      type: 'diff',
      payload: this.diff
    });
  }

  private async exportDiffJson(): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      title: 'Export schema diff JSON',
      defaultUri: vscode.Uri.file(`schema-diff-${safeFileName(this.diff.layout)}.json`),
      filters: {
        JSON: ['json']
      }
    });

    if (!uri) {
      return;
    }

    const bytes = Buffer.from(`${JSON.stringify(this.diff, null, 2)}\n`, 'utf8');
    await vscode.workspace.fs.writeFile(uri, bytes);
    vscode.window.showInformationMessage(`Exported schema diff to ${uri.fsPath}`);
  }

  private renderHtml(webview: vscode.Webview): string {
    const standardsStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews', 'schemaDiff', 'ui', 'fieldStandards.css')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews', 'schemaDiff', 'ui', 'styles.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews', 'schemaDiff', 'ui', 'index.js')
    );

    const nonce = createNonce();
    const csp = buildWebviewCsp(webview, {
      nonce
    });

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Schema Diff</title>
  <link rel="stylesheet" href="${standardsStyleUri}" />
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <main class="container">
    <header>
      <h1>FileMaker Schema Diff</h1>
      <p id="meta"></p>
      <div class="summary" id="summary" role="status" aria-live="polite"></div>
      <div class="actions">
        <div class="mode-switch" role="tablist" aria-label="Schema diff view mode">
          <button id="sideBySideMode" type="button" role="tab" aria-selected="true">Side by Side</button>
          <button id="treeMode" type="button" role="tab" aria-selected="false">Tree</button>
        </div>
        <label class="filter-toggle">
          <input id="changesOnly" type="checkbox" checked />
          <span>Show only changes</span>
        </label>
        <button id="exportButton">Export Diff JSON</button>
      </div>
    </header>

    <section class="fm-panel" id="sideBySidePanel">
      <h2>Side by Side</h2>
      <div id="sideBySide"></div>
    </section>

    <section class="fm-panel" id="treePanel" hidden>
      <h2>Tree</h2>
      <div id="tree"></div>
    </section>
  </main>

  ${versionFooterHtml()}
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function parseMessage(value: unknown): SchemaDiffWebviewMessage | undefined {
  const record = toRecord(value);
  if (!record) {
    return undefined;
  }

  if (record.type === 'ready') {
    return { type: 'ready' };
  }

  if (record.type === 'exportJson') {
    return { type: 'exportJson' };
  }

  return undefined;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unexpected error in the schema diff panel.';
}
