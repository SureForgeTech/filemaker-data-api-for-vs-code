import { describe, expect, it } from 'vitest';

import { FMClientError, toFMClientError } from '../../src/services/errors';
import { docsUrlForCode, docsUrlForStatus } from '../../src/utils/fileMakerCodes';
import { normalizeError } from '../../src/utils/normalizeError';

describe('normalizeError', () => {
  it('maps FileMaker 401 payload to auth error', () => {
    const error = normalizeError({
      isAxiosError: true,
      message: 'Unauthorized',
      response: {
        status: 401,
        data: {
          messages: [{ code: '952', message: 'Invalid token' }]
        },
        headers: {
          authorization: 'Bearer secret-token'
        }
      }
    });

    expect(error.kind).toBe('auth');
    expect(error.code).toBe('952');
    expect(error.message).toContain('Invalid token');
    expect(error.safeHeaders?.authorization).toBe('***');
  });

  it('maps timeout to timeout kind with retryable true', () => {
    const error = normalizeError({
      isAxiosError: true,
      code: 'ECONNABORTED',
      message: 'timeout of 1000ms exceeded',
      response: {
        status: 504,
        data: 'gateway timeout'
      }
    });

    expect(error.kind).toBe('timeout');
    expect(error.isRetryable).toBe(true);
    expect(error.status).toBe(504);
  });

  it('maps abort errors to cancellation', () => {
    const error = normalizeError(new DOMException('Aborted', 'AbortError'));

    expect(error.kind).toBe('cancellation');
    expect(error.isRetryable).toBe(false);
  });

  it('maps FMClientError preserving status and details', () => {
    const source = new FMClientError('Boom', {
      status: 500,
      code: '500',
      details: { token: 'secret' }
    });

    const error = normalizeError(source);
    expect(error.kind).toBe('server');
    expect(error.status).toBe(500);
    expect(error.code).toBe('500');
    expect(error.details).toEqual({ token: 'secret' });
  });

  it('applies fallback message and request metadata', () => {
    const error = normalizeError(
      {
        isAxiosError: true,
        message: 'Network Error',
        response: undefined
      },
      {
        fallbackMessage: 'Could not complete request.',
        requestId: 'req-1',
        endpoint: 'GET /layouts'
      }
    );

    expect(error.message).toContain('Could not complete request.');
    expect(error.requestId).toBe('req-1');
    expect(error.endpoint).toBe('GET /layouts');
  });

  it('names both sign-in causes for FileMaker 212 and links the HTTP 401 section', () => {
    const docsUrl =
      'https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/docs/TROUBLESHOOTING.md#http-401-the-server-refused-the-request';
    const error = normalizeError({
      isAxiosError: true,
      message: 'Unauthorized',
      response: {
        status: 401,
        data: {
          messages: [{ code: '212', message: 'Invalid user account and/or password' }]
        }
      }
    });

    expect(error.message).toContain('fmrest extended privilege');
    expect(error.docsUrl).toBe(docsUrl);
    expect(toFMClientError(error).toNormalized().docsUrl).toBe(docsUrl);
  });

  it('keeps the administrator advice for FileMaker 9 and links the privilege section', () => {
    const error = normalizeError({
      isAxiosError: true,
      message: 'Unauthorized',
      response: {
        status: 401,
        data: {
          messages: [{ code: '9', message: 'Insufficient privileges' }]
        }
      }
    });

    expect(error.message).toContain(
      'Ask your FileMaker administrator to change the privilege set for your account'
    );
    expect(error.docsUrl).toBe(
      'https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/docs/TROUBLESHOOTING.md#the-account-lacks-a-privilege'
    );
  });

  it('keeps the generic message and falls back to the HTTP section for a code without one', () => {
    const error = normalizeError({
      isAxiosError: true,
      message: 'Unauthorized',
      response: {
        status: 401,
        data: {
          messages: [{ code: '100', message: 'File is missing' }]
        }
      }
    });

    expect(error.message).toMatch(/^FileMaker API error \(HTTP 401\) \[100\]: File is missing/);
    expect(error.docsUrl).toBe(
      'https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/docs/TROUBLESHOOTING.md#http-401-the-server-refused-the-request'
    );
  });

  it('links the HTTP section when the server answers without a FileMaker code', () => {
    const error = normalizeError({
      isAxiosError: true,
      message: 'Forbidden',
      response: {
        status: 403,
        data: '<html>Forbidden</html>'
      }
    });

    expect(error.code).toBeUndefined();
    expect(error.docsUrl).toBe(
      'https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/docs/TROUBLESHOOTING.md#http-403-the-request-was-refused'
    );
  });

  it('links the section of the FileMaker codes that have one', () => {
    const error = normalizeError({
      isAxiosError: true,
      message: 'Error',
      response: {
        status: 500,
        data: { messages: [{ code: '956', message: 'Too many sessions' }] }
      }
    });

    expect(error.docsUrl).toBe(
      'https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/docs/TROUBLESHOOTING.md#error-956-no-free-data-api-sessions'
    );
  });

  it('links the certificate section when the connection fails on a certificate', () => {
    const error = normalizeError({
      isAxiosError: true,
      code: 'CERT_HAS_EXPIRED',
      message: 'certificate has expired',
      config: { url: 'https://fm.example/fmi/data/vLatest/databases/Contacts/sessions' }
    });

    expect(error.kind).toBe('certificate');
    expect(error.docsUrl).toBe(
      'https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/docs/TROUBLESHOOTING.md#certificate-errors-the-server-certificate-is-not-trusted'
    );
  });

  it('links the changed-certificate section when a trusted certificate no longer matches', () => {
    const error = normalizeError({
      isAxiosError: true,
      code: 'FM_CERT_PIN_MISMATCH',
      message: 'the certificate is not the one you trusted',
      config: { url: 'https://fm.example/fmi/data/vLatest/databases/Contacts/sessions' }
    });

    expect(error.kind).toBe('certificate');
    expect(error.docsUrl).toBe(
      'https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/docs/TROUBLESHOOTING.md#the-certificate-was-revoked-expired-or-replaced'
    );
  });

  it('links the unreachable section when the server cannot be reached', () => {
    const error = normalizeError({
      isAxiosError: true,
      code: 'ECONNREFUSED',
      message: 'connect ECONNREFUSED',
      config: { url: 'https://fm.example/fmi/data/vLatest/databases/Contacts/sessions' }
    });

    expect(error.kind).toBe('network');
    expect(error.docsUrl).toBe(
      'https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/docs/TROUBLESHOOTING.md#the-server-cannot-be-reached-or-times-out'
    );
  });
});

describe('docsUrlForCode', () => {
  it('gives the troubleshooting link for the codes that have a section', () => {
    expect(docsUrlForCode('212')).toBe(
      'https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/docs/TROUBLESHOOTING.md#http-401-the-server-refused-the-request'
    );
    expect(docsUrlForCode('9')).toBe(
      'https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/docs/TROUBLESHOOTING.md#the-account-lacks-a-privilege'
    );
  });

  it.each([
    ['956', 'error-956-no-free-data-api-sessions'],
    ['214', 'error-214-too-many-sign-in-attempts'],
    ['1703', 'error-1703-or-a-filemaker-cloud-sign-in']
  ])('gives the troubleshooting link for FileMaker %s', (code, anchor) => {
    expect(docsUrlForCode(code)).toBe(
      `https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/docs/TROUBLESHOOTING.md#${anchor}`
    );
  });

  it('gives no link for a code without a section', () => {
    expect(docsUrlForCode('100')).toBeUndefined();
  });
});

describe('docsUrlForStatus', () => {
  it('gives the troubleshooting link for the HTTP statuses that have a section', () => {
    expect(docsUrlForStatus(401)).toBe(
      'https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/docs/TROUBLESHOOTING.md#http-401-the-server-refused-the-request'
    );
    expect(docsUrlForStatus(403)).toBe(
      'https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/docs/TROUBLESHOOTING.md#http-403-the-request-was-refused'
    );
    expect(docsUrlForStatus(404)).toBe(
      'https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/docs/TROUBLESHOOTING.md#http-404-nothing-answered-at-that-address'
    );
  });

  it('gives no link for a status without a section', () => {
    expect(docsUrlForStatus(undefined)).toBeUndefined();
    expect(docsUrlForStatus(500)).toBeUndefined();
    expect(docsUrlForStatus(429)).toBeUndefined();
  });
});

it.each([
  ['POST', '/layouts/Contacts/_find'],
  ['POST', '/sessions'],
  ['DELETE', '/sessions/token'],
  ['GET', '/layouts/Contacts/records/1'],
  ['GET', '/layouts/Contacts/records'],
  ['GET', '/layouts'],
  ['GET', '/layouts/Contacts'],
  ['GET', '/productInfo'],
  ['POST', '/metadata'],
  ['GET', '/globals']
])('keeps a timed-out %s %s retryable with the normal timeout message', (method, path) => {
  const error = normalizeError({ isAxiosError: true, code: 'ECONNABORTED', message: 'timeout', config: { method, url: `https://fm.example${path}`, timeout: 1500 } });
  expect(error.kind).toBe('timeout');
  expect(error.message).toBe('Request timed out after 1.5 s. If the server is slow, raise the setting filemaker.requestTimeoutMs.');
  expect(error.isRetryable).toBe(true);
});

it.each([
  ['POST', '/layouts/Contacts/records'],
  ['PATCH', '/layouts/Contacts/records/1'],
  ['DELETE', '/layouts/Contacts/records/1'],
  ['POST', '/layouts/Contacts/records/1/containers/Photo/1'],
  ['PATCH', '/globals'],
  ['GET', '/layouts/Contacts/script/Slow']
])('warns against repeating an uncertain %s %s after a timeout', (method, path) => {
  const error = normalizeError({ isAxiosError: true, code: 'ECONNABORTED', message: 'timeout', config: { method, url: `https://fm.example${path}`, timeout: 1500 } });
  expect(error.message).toContain('after 1.5 s');
  expect(error.message).toContain('The change may have been applied. Check the record before trying again.');
  expect(error.isRetryable).toBe(false);
});

it.each(['createRecord', 'editRecord', 'deleteRecord', 'uploadContainer', 'runScript', 'setGlobalFields'])('uses logical operation %s without transport config', (operation) => {
  const error = normalizeError({ isAxiosError: true, code: 'ECONNABORTED', message: 'timeout' }, { operation });
  expect(error.isRetryable).toBe(false);
  expect(error.message).toContain('The change may have been applied.');
});

it.each(['script', 'script.prerequest', 'script.presort'])('treats a find carrying %s as uncertain in both body encodings and query parameters', (key) => {
  for (const config of [{ data: { [key]: 'Slow' } }, { data: JSON.stringify({ [key]: 'Slow' }) }, { params: { [key]: 'Slow' } }, { url: `https://fm.example/layouts/C/_find?${key}=Slow` }]) {
    const error = normalizeError({ isAxiosError: true, code: 'ECONNABORTED', message: 'timeout', config: { method: 'POST', url: 'https://fm.example/layouts/C/_find', ...config } }, { operation: 'findRecords' });
    expect(error.isRetryable).toBe(false);
    expect(error.message).toContain('The change may have been applied.');
  }
});

it.each([413, 429])('gives a next step for HTTP %s, including Retry-After', (status) => {
  const error = normalizeError({ isAxiosError: true, message: 'Error', response: { status, data: '<html>Error</html>', headers: { 'retry-after': '600' } } });
  expect(error.message).toMatch(status === 413 ? /smaller|fewer/i : /600.*second|second.*600/i);
  if (status === 429) expect(error.message).toMatch(/wait/i);
});

it('does not retry a timed-out read that runs an attached script', () => {
  const error = normalizeError({ isAxiosError: true, code: 'ECONNABORTED', message: 'timeout', config: { method: 'GET', url: 'https://fm.example/layouts/C/records', params: { script: 'Slow' }, timeout: 1500 } });
  expect(error.isRetryable).toBe(false);
  expect(error.message).toContain('The change may have been applied.');
});

it.each([500, 502, 504])('gives server advice for HTTP %s without a FileMaker code', (status) => {
  const error = normalizeError({ isAxiosError: true, message: 'Error', response: { status, data: '<html>Failure</html>' } });
  expect(error.message).toMatch(/try again/i);
  expect(error.message).toContain('Admin Console');
});

it('honors Retry-After even with a FileMaker-style error envelope', () => {
  const retryAfter = 'Wed, 21 Oct 2026 20:00:00 GMT';
  const error = normalizeError({ isAxiosError: true, message: 'Error', response: { status: 429, data: { messages: [{ code: '-1', message: 'Rate limit' }] }, headers: { 'Retry-After': retryAfter } } });
  expect(error.message).toContain(`Wait before trying again: Retry-After is ${retryAfter}`);
});
