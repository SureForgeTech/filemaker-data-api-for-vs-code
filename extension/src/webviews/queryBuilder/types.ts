import type { SavedQuery } from '../../types/fm';
import type { SnippetDelivery } from '../../snippets/deliver';

export interface QueryBuilderOpenOptions {
  profileId?: string;
  layout?: string;
  savedQuery?: SavedQuery;
}

export interface RunQueryPayload {
  profileId: string;
  layout: string;
  findJson: string;
  /** Set only by the explicit List records instead action; retained when paging. */
  listRecords?: boolean;
  sortJson?: string;
  limit?: number;
  offset?: number;
  queryId?: string;
  /** Webview-assigned sequence number, echoed back so stale results can be ignored. */
  runId?: number;
}

export interface SaveQueryPayload extends RunQueryPayload {
  /** Empty when the webview has no name yet; the host then asks for one. */
  name: string;
}

export interface OpenRecordPayload {
  profileId: string;
  layout: string;
  recordId: string;
  mode: 'view' | 'edit';
}

export interface CopySnippetPayload extends RunQueryPayload {
  delivery: SnippetDelivery;
}

export interface UploadContainerPayload {
  profileId: string;
  layout: string;
}

export interface QueryExecutionResult {
  profileId: string;
  layout: string;
  query: RunQueryPayload;
  result: {
    data: Array<Record<string, unknown>>;
    dataInfo?: Record<string, unknown>;
  };
}

export type IncomingMessage =
  | { type: 'ready' }
  | { type: 'loadLayouts'; profileId: string }
  | { type: 'loadFieldNames'; profileId: string; layout: string }
  | { type: 'runQuery'; payload: RunQueryPayload }
  | { type: 'cancelRun'; runId: number }
  | { type: 'saveQuery'; payload: SaveQueryPayload }
  | { type: 'exportResultsToEditor' }
  | { type: 'exportResultsJsonFile' }
  | { type: 'exportResultsCsvFile' }
  | { type: 'copyFetchSnippet'; payload: CopySnippetPayload }
  | { type: 'copyCurlSnippet'; payload: CopySnippetPayload }
  | { type: 'copyRequest'; payload: CopySnippetPayload }
  | { type: 'uploadContainer'; payload: UploadContainerPayload }
  | { type: 'openRecord'; payload: OpenRecordPayload }
  | { type: 'copyText'; text: string; label: string }
  | { type: 'refreshHistory' };

