export type NormalizedErrorKind =
  | 'auth'
  | 'network'
  | 'validation'
  | 'server'
  | 'timeout'
  | 'cancellation'
  /** A TLS certificate problem; trying again cannot help. */
  | 'certificate'
  | 'unknown';

export interface RequestChainEntry {
  attempt: number;
  method?: string;
  url?: string;
  status?: number;
  elapsedMs?: number;
  at?: string;
  note?: string;
}

export interface NormalizedError {
  kind: NormalizedErrorKind;
  message: string;
  status?: number;
  code?: string;
  /** Node / OpenSSL code of a network or TLS failure (`CERT_HAS_EXPIRED`, `ECONNREFUSED`, ...). */
  networkCode?: string;
  /** Meaning of the FileMaker code: who can fix it (see utils/fileMakerCodes.ts). */
  fmCategory?: string;
  /** Link to the troubleshooting page section for this error. */
  docsUrl?: string;
  /** `Retry-After` from the response, in milliseconds. */
  retryAfterMs?: number;
  requestId?: string;
  endpoint?: string;
  safeHeaders?: Record<string, string>;
  details?: unknown;
  isRetryable: boolean;
  originalName?: string;
  /** Number of retry attempts that preceded the final failure. Optional. */
  retryCount?: number;
  /** 0-indexed final attempt that produced this error. Optional. */
  finalAttemptIndex?: number;
  /** Chronological list of attempts (URL/method/status/elapsed) for the failed operation. */
  requestChain?: RequestChainEntry[];
  /** Redacted stack trace, if available. */
  stackTrace?: string;
}

export interface NormalizeErrorOptions {
  /** Logical operation recorded by the client, independent of the transport method. */
  operation?: string;
  requestData?: unknown;
  requestParams?: unknown;
  fallbackMessage?: string;
  requestId?: string;
  endpoint?: string;
  status?: number;
  safeHeaders?: Record<string, string>;
}
