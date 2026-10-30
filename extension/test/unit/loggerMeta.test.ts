import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Logger } from '../../src/services/logger';

function createLogger() {
  const lines: string[] = [];
  vi.mocked(vscode.window.createOutputChannel).mockReturnValueOnce({
    appendLine: (line: string) => lines.push(line),
    show: vi.fn(),
    dispose: vi.fn()
  } as never);
  const logger = new Logger('test', { getLoggingLevel: () => 'debug' } as never);
  return { logger, lines };
}

describe('Logger metadata', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the message and code of a nested Error', () => {
    const { logger, lines } = createLogger();
    const error = Object.assign(new Error('Layout "Contacts" is missing'), { code: 'ENOENT' });

    logger.warn('Failed to fetch', { layout: 'Contacts', error });

    expect(lines[0]).toContain('"message":"Layout \\"Contacts\\" is missing"');
    expect(lines[0]).toContain('"name":"Error"');
    expect(lines[0]).toContain('"code":"ENOENT"');
  });

  it('logs only name, message and code, never request or response data', () => {
    const { logger, lines } = createLogger();
    const error = Object.assign(new Error('Request failed'), {
      code: 'ERR_BAD_REQUEST',
      config: { headers: { Authorization: 'Bearer top-secret-token' }, data: 'plain-body-secret' },
      response: { data: 'plain-response-secret' },
      cause: new Error('plain-cause-secret')
    });

    logger.error('Failed', error);

    expect(lines[0]).toContain('Request failed');
    expect(lines[0]).not.toContain('top-secret-token');
    expect(lines[0]).not.toContain('plain-body-secret');
    expect(lines[0]).not.toContain('plain-response-secret');
    expect(lines[0]).not.toContain('plain-cause-secret');
  });

  describe('real AxiosError (toJSON runs before the replacer)', () => {
    function createAxiosError() {
      const config = {
        headers: { Authorization: 'Bearer axios-header-secret' },
        data: '{"password":"axios-body-secret"}',
        auth: { username: 'axios-user-secret', password: 'axios-auth-secret' }
      } as unknown as InternalAxiosRequestConfig;
      const error = new AxiosError('Request failed with status code 401', 'ERR_BAD_REQUEST', config, {
        socketSecret: 'axios-request-secret'
      }, {
        status: 401,
        statusText: 'Unauthorized',
        headers: {},
        config,
        data: 'axios-response-secret'
      });
      (error as { cause?: unknown }).cause = new Error('axios-cause-secret');
      return error;
    }

    function expectOnlySafeFields(line: string) {
      expect(line).toContain('Request failed with status code 401');
      expect(line).toContain('"code":"ERR_BAD_REQUEST"');
      for (const secret of [
        'axios-header-secret',
        'axios-body-secret',
        'axios-user-secret',
        'axios-auth-secret',
        'axios-request-secret',
        'axios-response-secret',
        'axios-cause-secret'
      ]) {
        expect(line).not.toContain(secret);
      }
      expect(line).not.toContain('"config"');
      expect(line).not.toContain('"stack"');
      expect(line).not.toContain('"request"');
      expect(line).not.toContain('"response"');
      expect(line).not.toContain('"cause"');
    }

    it('keeps only name, message and code for a root AxiosError', () => {
      const { logger, lines } = createLogger();

      logger.error('Failed', createAxiosError());

      expectOnlySafeFields(lines[0] ?? '');
    });

    it('keeps only name, message and code for a nested AxiosError', () => {
      const { logger, lines } = createLogger();

      logger.error('Failed', { layout: 'Contacts', nested: { error: createAxiosError() }, list: [createAxiosError()] });

      expect(lines[0]).toContain('"layout":"Contacts"');
      expectOnlySafeFields(lines[0] ?? '');
    });
  });

  it('ignores a custom toJSON on a plain Error', () => {
    const { logger, lines } = createLogger();
    const error = Object.assign(new Error('Custom failure'), {
      code: 'E_CUSTOM',
      toJSON: () => ({ config: { data: 'custom-json-secret' }, stack: 'custom-stack-secret' })
    });

    logger.error('Failed', error);
    logger.error('Failed', { error });

    for (const line of lines) {
      expect(line).toContain('Custom failure');
      expect(line).toContain('"code":"E_CUSTOM"');
      expect(line).not.toContain('custom-json-secret');
      expect(line).not.toContain('custom-stack-secret');
    }
  });

  it('redacts a secret that appears in an Error message', () => {
    const { logger, lines } = createLogger();

    logger.warn('Failed', { error: new Error('GET /fmi/data?token=abc123secret failed with Bearer xyz789secret') });

    expect(lines[0]).toContain('failed with Bearer ***');
    expect(lines[0]).not.toContain('abc123secret');
    expect(lines[0]).not.toContain('xyz789secret');
  });

  it('does not throw on a circular value or one that cannot become text', () => {
    const { logger, lines } = createLogger();
    const cyclic: Record<string, unknown> = { error: new Error('still here') };
    cyclic.self = cyclic;

    expect(() => logger.info('Cycle', cyclic)).not.toThrow();
    const bare = Object.create(null) as Record<string, unknown>;
    bare.self = bare;
    expect(() => logger.info('Bare', bare)).not.toThrow();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('[unserializable log data]');
  });
});
