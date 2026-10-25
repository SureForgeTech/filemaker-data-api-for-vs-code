import type { DataApiEnvelope } from '../types/dataApi';
import type { ScriptErrorReport } from '../types/fm';
import { docsUrlForCode, getFileMakerErrorInfo } from '../utils/fileMakerCodes';
import { plainTextPreview } from '../utils/plainText';
import { redactValue } from '../utils/redact';
import { FMClientError } from './errors';

/** Code on errors raised when a 2xx answer is not Data API JSON. */
export const NOT_DATA_API_CODE = 'NOT_DATA_API_RESPONSE';

export type { ScriptErrorReport };

interface RawResponse {
  status: number;
  data: unknown;
  headers?: unknown;
}

const MAX_PREVIEW = 200;

function contentTypeOf(headers: unknown): string | undefined {
  if (!headers || typeof headers !== 'object') {
    return undefined;
  }
  const record = headers as Record<string, unknown> & { get?: (name: string) => unknown };
  const value = typeof record.get === 'function' ? record.get('content-type') : (record['content-type'] ?? record['Content-Type']);
  return typeof value === 'string' ? value.split(';')[0]?.trim().toLowerCase() : undefined;
}

/** Plain text of the start of a body, for the error details: tags removed, cut short. */
function preview(data: unknown): string {
  const text = typeof data === 'string' ? data : (JSON.stringify(data) ?? '');
  return plainTextPreview(text, MAX_PREVIEW);
}

function notDataApi(raw: RawResponse, what: string): FMClientError {
  const type = contentTypeOf(raw.headers);
  return new FMClientError(
    `The server did not return Data API JSON (${what}; HTTP ${raw.status}${type ? `, ${type}` : ''}). ` +
      'A web page, proxy, firewall or sign-in page may be answering instead of FileMaker Server: check the Server URL, the API base path and version, and that the Data API is enabled.',
    {
      status: raw.status,
      code: NOT_DATA_API_CODE,
      kind: 'server',
      isRetryable: false,
      details: redactValue({ status: raw.status, contentType: type, bodyStart: preview(raw.data) })
    }
  );
}

/**
 * Checks that a 2xx answer really is the Data API envelope (`{ response: {...}, messages: [...] }`)
 * and returns it. Anything else (an HTML page, an empty body, an array, cut-off JSON) becomes one
 * clear error instead of a `Cannot read properties of undefined` later. Claris documents that
 * status 200 "doesn't indicate response errors", so a non-zero `messages[0].code` is raised too.
 */
export function parseDataApiEnvelope<T extends Record<string, unknown>>(raw: RawResponse): DataApiEnvelope<T> {
  const data = raw.data;
  if (data === undefined || data === null || data === '') {
    throw notDataApi(raw, 'empty response');
  }
  if (typeof data === 'string') {
    throw notDataApi(raw, /^\s*</.test(data) ? 'it looks like a web page' : 'the text is not valid JSON, or was cut off');
  }
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw notDataApi(raw, 'JSON, but not a Data API response');
  }

  const envelope = data as Record<string, unknown>;
  const messages = envelope.messages;
  const response = envelope.response;
  if (!Array.isArray(messages) || typeof response !== 'object' || response === null || Array.isArray(response)) {
    throw notDataApi(raw, 'JSON without the Data API "response" and "messages"');
  }

  const first = messages[0] as { code?: unknown; message?: unknown } | undefined;
  const code = first?.code === undefined ? undefined : String(first.code);
  if (code !== undefined && code !== '0') {
    const info = getFileMakerErrorInfo(code);
    const text = typeof first?.message === 'string' ? first.message : 'FileMaker reported an error.';
    throw new FMClientError(
      `FileMaker API error (HTTP ${raw.status}) [${code}]: ${text}${info?.advice ? ` ${info.advice}` : ''}`,
      {
        status: raw.status,
        code,
        fmCategory: info?.category,
        docsUrl: docsUrlForCode(code),
        kind: info?.category === 'credentials' ? 'auth' : 'server',
        isRetryable: info?.retryable === true,
        details: redactValue(envelope)
      }
    );
  }

  return envelope as unknown as DataApiEnvelope<T>;
}

/**
 * Script errors that came back with a request that otherwise worked. The Data API does not
 * report them through the HTTP status or `messages` [S12]: they are `scriptError`,
 * `scriptError.prerequest` and `scriptError.presort` next to the data.
 */
export function extractScriptErrors(response: unknown): ScriptErrorReport[] {
  if (!response || typeof response !== 'object') {
    return [];
  }
  const record = response as Record<string, unknown>;
  const found: ScriptErrorReport[] = [];
  const entries: Array<[ScriptErrorReport['phase'], string]> = [
    ['script', 'scriptError'],
    ['prerequest', 'scriptError.prerequest'],
    ['presort', 'scriptError.presort']
  ];
  for (const [phase, key] of entries) {
    const value = record[key];
    const code = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
    if (code !== '' && code !== '0') {
      found.push({ phase, code });
    }
  }
  return found;
}

/** One line for a warning toast. */
export function describeScriptErrors(errors: ScriptErrorReport[]): string {
  return errors
    .map((error) => {
      const info = getFileMakerErrorInfo(error.code);
      const where = error.phase === 'script' ? 'the script' : error.phase === 'prerequest' ? 'the pre-request script' : 'the pre-sort script';
      return `${where} reported error ${error.code}${info ? ` (${info.meaning.replace(/\.$/, '')})` : ''}`;
    })
    .join('; ');
}
