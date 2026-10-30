import type * as vscode from 'vscode';
import type { FMClient } from '../../services/fmClient';
import type { ProfileStore } from '../../services/profileStore';
import type { SavedQueriesStore } from '../../services/savedQueriesStore';
import type { Logger } from '../../services/logger';
import type { QueryBuilderOpenOptions, QueryExecutionResult } from './types';

/** Shared host state; the browser message contract lives in types.ts. */
export interface QueryBuilderContext {
  panel: vscode.WebviewPanel;
  profileStore: ProfileStore;
  savedQueriesStore: SavedQueriesStore;
  fmClient: FMClient;
  logger: Logger;
  lastResult?: QueryExecutionResult;
  pendingDefaults?: QueryBuilderOpenOptions;
  /** The run the host is waiting for, so the page can cancel it. */
  activeRun?: { runId: number; controller: AbortController };
  disposed?: boolean;
  postError(message: string, runId?: number): Promise<void>;
  formatError(error: unknown): string;
  sendHistory(): Promise<void>;
  toCsvRows(result: QueryExecutionResult): Array<Map<string, unknown>>;
}
