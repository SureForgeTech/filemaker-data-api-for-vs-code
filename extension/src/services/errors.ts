import type { NormalizedError, NormalizedErrorKind } from '../types/errors';

export class FMClientError extends Error {
  public readonly status?: number;
  public readonly code?: string;
  /** Node / OpenSSL code of a network or TLS failure. */
  public readonly networkCode?: string;
  public readonly fmCategory?: string;
  /** Link to the troubleshooting page section for this error. */
  public readonly docsUrl?: string;
  public readonly retryAfterMs?: number;
  public readonly details?: unknown;
  public readonly requestId?: string;
  public readonly endpoint?: string;
  public readonly safeHeaders?: Record<string, string>;
  public readonly kind?: NormalizedErrorKind;
  public readonly isRetryable: boolean;

  public constructor(
    message: string,
    options?: {
      status?: number;
      code?: string;
      networkCode?: string;
      fmCategory?: string;
      docsUrl?: string;
      retryAfterMs?: number;
      details?: unknown;
      requestId?: string;
      endpoint?: string;
      safeHeaders?: Record<string, string>;
      kind?: NormalizedErrorKind;
      isRetryable?: boolean;
    }
  ) {
    super(message);
    this.name = 'FMClientError';
    this.status = options?.status;
    this.code = options?.code;
    this.networkCode = options?.networkCode;
    this.fmCategory = options?.fmCategory;
    this.docsUrl = options?.docsUrl;
    this.retryAfterMs = options?.retryAfterMs;
    this.details = options?.details;
    this.requestId = options?.requestId;
    this.endpoint = options?.endpoint;
    this.safeHeaders = options?.safeHeaders;
    this.kind = options?.kind;
    this.isRetryable = options?.isRetryable ?? false;
  }

  public toNormalized(): NormalizedError {
    return {
      kind: this.kind ?? inferKindFromStatus(this.status),
      message: this.message,
      status: this.status,
      code: this.code,
      networkCode: this.networkCode,
      fmCategory: this.fmCategory,
      docsUrl: this.docsUrl,
      retryAfterMs: this.retryAfterMs,
      requestId: this.requestId,
      endpoint: this.endpoint,
      safeHeaders: this.safeHeaders,
      details: this.details,
      isRetryable: this.isRetryable,
      originalName: this.name
    };
  }
}

function inferKindFromStatus(status: number | undefined): NormalizedErrorKind {
  if (status === 401 || status === 403) {
    return 'auth';
  }

  if (typeof status === 'number' && status >= 400 && status < 500) {
    return 'validation';
  }

  if (typeof status === 'number' && status >= 500) {
    return 'server';
  }

  return 'unknown';
}

export function toFMClientError(normalized: NormalizedError): FMClientError {
  return new FMClientError(normalized.message, {
    status: normalized.status,
    code: normalized.code,
    networkCode: normalized.networkCode,
    fmCategory: normalized.fmCategory,
    docsUrl: normalized.docsUrl,
    retryAfterMs: normalized.retryAfterMs,
    details: normalized.details,
    requestId: normalized.requestId,
    endpoint: normalized.endpoint,
    safeHeaders: normalized.safeHeaders,
    kind: normalized.kind,
    isRetryable: normalized.isRetryable
  });
}

/**
 * FileMaker error 306, "Record modification ID does not match": the record changed
 * after it was loaded, and an edit that sent that modId was refused.
 */
export function isRecordModifiedConflict(error: unknown): boolean {
  return error instanceof FMClientError && error.code === '306';
}
