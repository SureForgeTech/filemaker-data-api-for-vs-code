import { designerLayoutMetadata } from '../../fmweb/fieldMetadata';
import * as vscode from 'vscode';

import type { FMClient } from '../../services/fmClient';
import { HistoryStore } from '../../services/historyStore';
import type { Logger } from '../../services/logger';
import type { ProfileStore } from '../../services/profileStore';
import type { SavedQueriesStore } from '../../services/savedQueriesStore';
import { isFormulaNeutralizationOn } from '../../utils/userScopeSetting';
import { extractLayoutFieldNames } from '../../utils/layoutFields';
import {
  getOptionalNumberField,
  getStringField,
  toRecord
} from '../common/messageValidation';
import { isFeatureEnabled } from '../../utils/policySetting';
import type { QueryBuilderOpenOptions, QueryExecutionResult, IncomingMessage, OpenRecordPayload, UploadContainerPayload } from './types';
import type { QueryBuilderContext } from './context';
import { parseIncomingMessage } from './messages';
import { handleRunQuery } from './find';
import { handleSaveQuery } from './savedQueries';
import { exportResultsToEditor, exportResultsJsonFile, exportResultsCsvFile, copyRequest, toCsvRows } from './results';
import { getHtmlForWebview } from './html';
import { guardDispatch, requestType } from '../common/dispatch';

export class QueryBuilderPanel {
  private requestInFlight = false;
  private static currentPanel: QueryBuilderPanel | undefined;

  private readonly query: QueryBuilderContext;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly profileStore: ProfileStore,
    savedQueriesStore: SavedQueriesStore,
    private readonly historyStore: HistoryStore,
    private readonly fmClient: FMClient,
    private readonly logger: Logger,
    defaults?: QueryBuilderOpenOptions
  ) {
    this.query = {
      panel, profileStore, savedQueriesStore, fmClient, logger, pendingDefaults: defaults,
      postError: (message, runId) => this.postError(message, runId),
      formatError: (error) => this.formatError(error),
      sendHistory: () => this.sendHistory(),
      toCsvRows: (result) => this.toCsvRows(result)
    };
    this.panel.webview.html = getHtmlForWebview(this.panel.webview, context.extensionUri);

    this.panel.onDidDispose(() => {
      QueryBuilderPanel.currentPanel = undefined;
    });

    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      this.dispatch(() => this.handleMessage(message), requestType(message));
    });
  }

  public static createOrShow(
    context: vscode.ExtensionContext,
    profileStore: ProfileStore,
    savedQueriesStore: SavedQueriesStore,
    fmClient: FMClient,
    logger: Logger,
    defaults?: QueryBuilderOpenOptions,
    historyStore?: HistoryStore
  ): void {
    const column = vscode.ViewColumn.One;

    const current = QueryBuilderPanel.currentPanel;
    if (current) {
      current.panel.reveal(column);
      current.query.pendingDefaults = defaults;
      current.dispatch(() => current.sendInitState(), 'init');
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'filemakerQueryBuilder',
      'FileMaker Query Builder',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'dist', 'webviews', 'queryBuilder', 'ui')
        ]
      }
    );

    QueryBuilderPanel.currentPanel = new QueryBuilderPanel(
      panel,
      context,
      profileStore,
      savedQueriesStore,
      historyStore ?? new HistoryStore(context.workspaceState),
      fmClient,
      logger,
      defaults
    );
  }

  /**
   * Restores a Query Builder tab that VS Code brings back after a window reload. The serializer
   * rebuilds the real page, so the page runs again and reads the snapshot it stored itself.
   */
  public static registerSerializer(
    context: vscode.ExtensionContext,
    profileStore: ProfileStore,
    savedQueriesStore: SavedQueriesStore,
    historyStore: HistoryStore | undefined,
    fmClient: FMClient,
    logger: Logger
  ): vscode.Disposable {
    // VS Code has already put the saved state back on `webview.state` when this runs, so the
    // rebuilt page reads the pre-restart snapshot with getState(); `state` carries that same value.
    return vscode.window.registerWebviewPanelSerializer('filemakerQueryBuilder', {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
        void state; // the page reads the same snapshot itself via vscode.getState()
        QueryBuilderPanel.restore(panel, context, profileStore, savedQueriesStore, historyStore, fmClient, logger);
      }
    });
  }

  /**
   * Rebuilds the panel over a revived webview. The constructor sets the page, the page posts
   * `ready`, and the host answers with the init payload, so the panel behaves like a new one.
   */
  private static restore(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    profileStore: ProfileStore,
    savedQueriesStore: SavedQueriesStore,
    historyStore: HistoryStore | undefined,
    fmClient: FMClient,
    logger: Logger
  ): void {
    // Only one Query Builder panel is open at a time, so a revived duplicate is closed again.
    if (QueryBuilderPanel.currentPanel) {
      panel.dispose();
      return;
    }

    QueryBuilderPanel.currentPanel = new QueryBuilderPanel(
      panel,
      context,
      profileStore,
      savedQueriesStore,
      historyStore ?? new HistoryStore(context.workspaceState),
      fmClient,
      logger
    );
  }

  public static requestSaveCurrentQuery(): boolean {
    const current = QueryBuilderPanel.currentPanel;
    if (!current) {
      return false;
    }

    current.dispatch(async () => {
      await current.panel.webview.postMessage({
        type: 'saveCurrentQuery'
      });
    }, 'saveCurrentQuery');

    return true;
  }

  /**
   * The host hands the panel a message and returns; the handler runs on its own. A failure is
   * logged and posted to the page, so the user reads the reason instead of an empty panel.
   */
  private dispatch(run: () => PromiseLike<void>, type?: string): void {
    guardDispatch(run, {
      label: 'Query builder request',
      type,
      logger: this.logger,
      formatError: (error) => this.formatError(error),
      postError: (message) => this.postError(message)
    });
  }

  private async handleMessage(rawMessage: unknown): Promise<void> {
    const message = parseIncomingMessage(rawMessage);
    if (!message) {
      await this.reportRejectedRequest(rawMessage);
      return;
    }

    const guarded = ['runQuery', 'saveQuery'].includes(message.type);
    if (guarded && this.requestInFlight) return;
    if (guarded) this.requestInFlight = true;
    try {
      await this.dispatchMessage(message);
    } catch (error) {
      this.logger.error('Query builder request failed.', { type: message.type, error });
      await this.postError(
        this.formatError(error),
        message.type === 'runQuery' ? message.payload.runId : undefined
      );
    } finally {
      if (guarded) this.requestInFlight = false;
      if (message.type === 'saveQuery') await this.panel.webview.postMessage({ type: 'querySaveFinished' });
    }
  }

  /**
   * The webview waits for a reply to requests it makes (Run shows "Running…"),
   * so a request that fails validation still gets an error back.
   */
  private async reportRejectedRequest(rawMessage: unknown): Promise<void> {
    const value = toRecord(rawMessage);
    const type = value ? getStringField(value, 'type') : undefined;
    const messages: Record<string, string> = {
      runQuery: 'Enter a find request before running the query.',
      saveQuery: 'Enter a find request before saving the query.',
      copyFetchSnippet: 'Enter a find request before copying it.',
      copyCurlSnippet: 'Enter a find request before copying it.',
      copyRequest: 'Enter a find request before copying it.',
      copyText: 'Nothing to copy, or the results are too large to copy. Save them as CSV instead.',
      openRecord: 'That row has no record ID to open.'
    };
    const text = type ? messages[type] : undefined;
    if (text) {
      if (type === 'runQuery') this.query.lastResult = undefined;
      const payload = value ? toRecord(value.payload) : undefined;
      const runId = type === 'runQuery' && payload ? getOptionalNumberField(payload, 'runId') : undefined;
      await this.postError(text, runId);
    }
  }

  private async dispatchMessage(message: IncomingMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.sendInitState();
        break;
      case 'loadLayouts':
        await this.handleLoadLayouts(message.profileId);
        break;
      case 'loadFieldNames':
        await this.handleLoadFieldNames(message.profileId, message.layout);
        break;
      case 'runQuery':
        await handleRunQuery(this.query, message.payload);
        break;
      case 'cancelRun':
        this.cancelRun(message.runId);
        break;
      case 'saveQuery':
        await handleSaveQuery(this.query, message.payload);
        break;
      case 'exportResultsToEditor':
        await exportResultsToEditor(this.query);
        break;
      case 'exportResultsJsonFile':
        await exportResultsJsonFile(this.query);
        break;
      case 'exportResultsCsvFile':
        await exportResultsCsvFile(this.query);
        break;
      case 'copyFetchSnippet':
      case 'copyCurlSnippet':
      case 'copyRequest':
        await copyRequest(this.query, message.payload);
        break;
      case 'uploadContainer':
        await this.uploadContainer(message.payload);
        break;
      case 'openRecord':
        await this.openRecord(message.payload);
        break;
      case 'copyText':
        await vscode.env.clipboard.writeText(message.text);
        vscode.window.showInformationMessage(`Copied ${message.label} to clipboard.`);
        break;
      case 'refreshHistory':
        await this.sendHistory();
        break;
      default:
        break;
    }
  }

  /**
   * Aborts the request of the run the page is waiting on. A run id that is not in flight is
   * ignored: that run has already finished, and there is nothing left to cancel.
   */
  private cancelRun(runId: number): void {
    const active = this.query.activeRun;
    if (!active || active.runId !== runId) {
      return;
    }

    active.controller.abort();
  }

  private async sendInitState(): Promise<void> {
    const profiles = await this.profileStore.listProfiles();
    const savedQueries = await this.query.savedQueriesStore.listSavedQueries();

    const filemakerConfig = vscode.workspace.getConfiguration('filemaker');
    const includeAuthByDefault = filemakerConfig.get<boolean>('snippets.includeAuthByDefault', false);
    const recordEditEnabled = isFeatureEnabled(filemakerConfig, 'features.recordEdit.enabled');

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
        savedQueries,
        defaults: this.query.pendingDefaults,
        includeAuthByDefault,
        recordEditEnabled,
        neutralizeFormulas: isFormulaNeutralizationOn(filemakerConfig)
      }
    });

    await this.sendHistory();

    this.query.pendingDefaults = undefined;
  }

  private async sendHistory(): Promise<void> {
    await this.panel.webview.postMessage({
      type: 'history',
      payload: this.historyStore.listEntries()
    });
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
      this.logger.error('Failed to load layouts for query builder.', { profileId, error });
      await this.postError(this.formatError(error));
    }
  }

  private async handleLoadFieldNames(profileId: string, layout: string): Promise<void> {
    const profile = await this.profileStore.getProfile(profileId);
    if (!profile) {
      await this.panel.webview.postMessage({
        type: 'fieldNamesLoaded',
        payload: { profileId, layout, fieldNames: [], error: 'Profile not found.' }
      });
      return;
    }

    try {
      const metadata = await this.fmClient.getLayoutMetadata(profile, layout);
      const fieldNames = extractLayoutFieldNames(metadata);
      await this.panel.webview.postMessage({
        type: 'fieldNamesLoaded',
        payload: { profileId, layout, fieldNames, fieldMetadata: designerLayoutMetadata(layout, metadata).fields }
      });
    } catch (error) {
      this.logger.warn('Failed to load field names for query builder.', { profileId, layout, error });
      await this.panel.webview.postMessage({
        type: 'fieldNamesLoaded',
        payload: {
          profileId,
          layout,
          fieldNames: [],
          error: this.formatError(error)
        }
      });
    }
  }

  private async uploadContainer(payload: UploadContainerPayload): Promise<void> {
    try {
      const completed = await vscode.commands.executeCommand<boolean>(
        'filemakerDataApiTools.uploadContainer',
        payload
      );

      await this.panel.webview.postMessage({
        type: 'containerUploadResult',
        payload: {
          completed: completed === true
        }
      });
    } catch (error) {
      await this.postError(this.formatError(error));
    }
  }

  private async openRecord(payload: OpenRecordPayload): Promise<void> {
    const command =
      payload.mode === 'edit' ? 'filemakerDataApiTools.openRecordEditor' : 'filemakerDataApiTools.openRecordViewer';
    try {
      await vscode.commands.executeCommand(command, {
        profileId: payload.profileId,
        layout: payload.layout,
        recordId: payload.recordId
      });
    } catch (error) {
      await this.postError(this.formatError(error));
    }
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return 'Unknown error while processing query builder request.';
  }

  /** `runId` ties a failure to the run that caused it, so the webview can end that run's busy state. */
  private async postError(message: string, runId?: number): Promise<void> {
    await this.panel.webview.postMessage({
      type: 'error',
      message,
      ...(runId === undefined ? {} : { runId })
    });
  }

  private toCsvRows(result: QueryExecutionResult): Array<Map<string, unknown>> {
    return toCsvRows(result);
  }
}
