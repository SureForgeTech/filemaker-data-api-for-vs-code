import { describe, expect, it } from 'vitest';

import type { NormalizedError } from '../../src/types/errors';
import { renderErrorReport } from '../../src/utils/errorUx';

function baseError(): NormalizedError {
  return {
    kind: 'server',
    message: 'Failed to list layouts.',
    isRetryable: false
  };
}

describe('renderErrorReport (#42)', () => {
  it('renders message, kind, retryable for a minimal error', () => {
    const out = renderErrorReport(baseError());
    expect(out).toContain('# FileMaker Data API — Error Report');
    expect(out).toContain('**Message:** Failed to list layouts.');
    expect(out).toContain('**Kind:** server');
    expect(out).toContain('**Retryable:** false');
  });

  it('includes retry count and final attempt index when present', () => {
    const out = renderErrorReport({
      ...baseError(),
      retryCount: 3,
      finalAttemptIndex: 3
    });
    expect(out).toContain('**Retry count:** 3');
    expect(out).toContain('**Final attempt index:** 3');
  });

  it('renders the request chain as a markdown table', () => {
    const out = renderErrorReport({
      ...baseError(),
      requestChain: [
        {
          attempt: 0,
          method: 'POST',
          url: 'https://fm.example.com/fmi/data/vLatest/sessions',
          status: 500,
          elapsedMs: 412,
          at: '2026-05-04T16:30:00Z',
          note: 'transient'
        },
        {
          attempt: 1,
          method: 'POST',
          url: 'https://fm.example.com/fmi/data/vLatest/sessions',
          status: 500,
          elapsedMs: 401,
          at: '2026-05-04T16:30:01Z'
        }
      ]
    });
    expect(out).toContain('## Request chain');
    expect(out).toContain('| # | Method | URL | Status | Elapsed | When | Note |');
    expect(out).toMatch(/\|\s*0\s*\|\s*POST\s*\|.*sessions\s*\|\s*500\s*\|\s*412ms\s*\|/);
    expect(out).toContain('| 1 | POST |');
  });

  it('redacts authorization headers but keeps non-sensitive ones', () => {
    const out = renderErrorReport({
      ...baseError(),
      safeHeaders: {
        'Content-Type': 'application/json',
        Authorization: '[redacted]'
      }
    });
    expect(out).toContain('## Response headers (redacted)');
    expect(out).toContain('Content-Type: application/json');
    expect(out).toContain('Authorization: [redacted]');
  });

  it('extracts and redacts stack from raw error when normalized has none', () => {
    const raw = new Error('boom');
    raw.stack = 'Error: boom\n    at Authorization=Bearer secrettoken\n    at z()';
    const out = renderErrorReport(baseError(), raw);
    expect(out).toContain('## Stack trace (redacted)');
    expect(out).not.toContain('secrettoken');
  });

  it('includes details JSON when present', () => {
    const out = renderErrorReport({
      ...baseError(),
      details: { code: '102', message: 'Not found' }
    });
    expect(out).toContain('## Details (redacted)');
    expect(out).toContain('"code": "102"');
  });

  it('omits sections that are empty', () => {
    const out = renderErrorReport(baseError());
    expect(out).not.toContain('## Request chain');
    expect(out).not.toContain('## Response headers');
    expect(out).not.toContain('## Stack trace');
  });

  it('redacts Bearer tokens in the message summary field', () => {
    const out = renderErrorReport({
      ...baseError(),
      message: 'Request failed with header Bearer abc123secret'
    });
    expect(out).not.toContain('abc123secret');
    expect(out).toContain('Bearer ***');
  });

  it('redacts query-param secrets in endpoint summary field', () => {
    const out = renderErrorReport({
      ...baseError(),
      endpoint: 'GET /layouts?token=secrettoken'
    });
    expect(out).not.toContain('secrettoken');
    expect(out).toContain('token=***');
  });

  it('redacts secrets in request-chain URL cells', () => {
    const out = renderErrorReport({
      ...baseError(),
      requestChain: [
        {
          attempt: 0,
          method: 'GET',
          url: 'https://fm.example.com/api?api_key=verysecretkey',
          note: 'retried after 401'
        }
      ]
    });
    expect(out).not.toContain('verysecretkey');
    expect(out).toContain('api_key=***');
  });

  it('redacts Bearer tokens in request-chain note cells', () => {
    const out = renderErrorReport({
      ...baseError(),
      requestChain: [
        {
          attempt: 0,
          method: 'GET',
          url: 'https://fm.example.com/api',
          note: 'auth header was Bearer leakedtoken'
        }
      ]
    });
    expect(out).not.toContain('leakedtoken');
  });

  it('includes the troubleshooting link when the error carries one', () => {
    const docsUrl =
      'https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/docs/TROUBLESHOOTING.md#http-401-the-server-refused-the-request';
    const out = renderErrorReport({
      ...baseError(),
      docsUrl
    });
    expect(out).toContain('Troubleshooting:');
    expect(out).toContain(docsUrl);
  });

  it('omits the troubleshooting link when the error has none', () => {
    const out = renderErrorReport(baseError());
    expect(out).not.toContain('Troubleshooting:');
  });

  it('accepts a deterministic generatedAt for stable output', () => {
    const fixedDate = new Date('2026-01-01T00:00:00.000Z');
    const out = renderErrorReport(baseError(), undefined, { generatedAt: fixedDate });
    expect(out).toContain('_Generated at 2026-01-01T00:00:00.000Z_');
  });
});
