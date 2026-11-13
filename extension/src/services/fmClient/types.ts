import type { PortalPaging } from '../../types/fm';

/** @internal */
export interface LayoutCacheEntry {
  expiresAt: number;
  layouts: string[];
}

/** @internal */
export interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  data?: unknown;
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean>;
  /** Percent-encode the query exactly (a space is `%20`, never `+`), as the Claris guide shows for script parameters. */
  strictQuery?: boolean;
  signal?: AbortSignal;
  /** Refuse a response body larger than this (axios maxContentLength). */
  maxResponseBytes?: number;
  /** Renew the deadline on substantial byte progress for record reads and container transfers. */
  transfer?: boolean;
}

/** @internal */
export interface HistoryContext {
  recordHistory?: boolean;
  profileId: string;
  operation: string;
  layout?: string;
  endpoint: string;
}

/** @internal */
export interface RequestTrace {
  operation: string;
  requestId: string;
  reauthCount: number;
  cacheHit: boolean;
  endpoint: string;
}

/** Optional cancellation, paging and response limits for client requests. */
export interface ClientRequestControl {
  portal?: PortalPaging;
  signal?: AbortSignal;
  /**
   * The user asked for this sign-in (Connect, Test Connection). It goes ahead even when automatic
   * sign-ins are paused after the server rejected the stored credentials, and its result ends or
   * renews that pause.
   */
  userInitiated?: boolean;
  /**
   * A renewal ahead of expiry while the current token is still valid. If it fails, nothing is
   * paused and the caller keeps using the token it has.
   */
  proactive?: boolean;
  /** For list, get and find calls: refuse a response body larger than this many bytes. */
  maxResponseBytes?: number;
}

export interface FMClientContainerUploadOptions {
  signal?: AbortSignal;
  fieldRepetition?: number;
  modId?: string;
  maxBytes?: number;
}

/** @internal */
export interface AuthPause {
  code: string;
  /** Hash of the account, password and server the rejection was for; a change ends the pause. */
  stamp: string;
}

/** What the extension knows about a connection right now, from its most recent requests. */
export interface SessionHealth {
  state: 'connecting' | 'connected' | 'auth-failed' | 'certificate' | 'unreachable';
  /** The error message behind a failed state (already safe to show). */
  message?: string;
  at: number;
}

export interface FMClientSessionOptions {
  /** Treat the session token as expired after this many ms since issuance. Default 14m. */
  maxAgeMs?: number;
  /** Refresh proactively when remaining lifetime drops below this many ms. Default 30s. */
  refreshLeadMs?: number;
  /** Override Date.now for tests. */
  now?: () => number;
}

/** Optional guards for an edit. */
export interface EditRecordOptions {
  /** The record's modification id as loaded; the edit is refused if the record has changed since. */
  modId?: string;
}

/** Optional extras for a create. */
export interface CreateRecordOptions {
  /**
   * Related (portal) rows to create with the parent record, keyed by portal name.
   * Each row is a new related record; rows naming a recordId/modId are refused.
   */
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

/** @internal */
export const DEFAULT_LAYOUT_TTL_MS = 60_000;

/** The Claris guide advises keeping a Data API URL under 2000 characters (URL and data format notes). */
export const MAX_SCRIPT_URL_LENGTH = 2000;
