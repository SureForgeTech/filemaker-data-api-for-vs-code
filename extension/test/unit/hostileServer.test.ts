import axios, { CanceledError, type AxiosRequestConfig } from 'axios';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import nock from 'nock';
import { describe, expect, it, vi } from 'vitest';
import { requestNoAuth, requestWithAuth, requestWithAuthRaw } from '../../src/services/fmClient/transport';
import { requestServerLevel } from '../../src/services/fmClient/server';
import type { ClientContext } from '../../src/services/fmClient/context';
import { createSelfTestClient } from '../../src/services/serverSelfTestClient';
import { ProxyClient } from '../../src/services/proxyClient';
import { FMClient } from '../../src/services/fmClient';
import { SecretStore } from '../../src/services/secretStore';
import { DEFAULT_MAX_RESPONSE_BYTES, withRequestLimits } from '../../src/services/requestLimits';
import { InMemorySecretStorage } from './mocks';

const profile = { id: 'p', name: 'Dev', authMode: 'direct' as const, serverUrl: 'http://127.0.0.1', database: 'DB' };
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const envelope = { response: { layouts: [] }, messages: [{ code: '0', message: 'OK' }] };
function context(httpClient: unknown, timeoutMs = 120): ClientContext {
  return {
    httpClient, timeoutMs, logger, ensureSessionToken: vi.fn().mockResolvedValue('token'),
    explainPinnedFailure: (_profile: unknown, error: unknown) => error,
    refineCertificateError: async (_profile: unknown, error: unknown) => error
  } as unknown as ClientContext;
}
const kinds = ['authenticated', 'raw', 'login', 'logout', 'server', 'proxy', 'logout probe'] as const;
type Kind = typeof kinds[number];
async function call(kind: Kind, client: ClientContext, target = profile, signal?: AbortSignal, maxResponseBytes?: number) {
  const request = { method: 'GET' as const, path: '/layouts', signal, maxResponseBytes };
  if (kind === 'logout probe') {
    const factory = vi.spyOn(axios, 'create').mockReturnValueOnce(client.httpClient);
    try {
      const selfTest = await createSelfTestClient(target, new SecretStore(new InMemorySecretStorage() as never), logger as never, client.timeoutMs);
      return selfTest.verifyLoggedOut(target, 'token', signal);
    } finally { factory.mockRestore(); }
  }
  if (kind === 'raw') return requestWithAuthRaw(client, target, request);
  if (kind === 'login') return requestNoAuth(client, target, { ...request, method: 'POST', path: '/sessions' });
  if (kind === 'logout') return requestWithAuth(client, target, { ...request, method: 'DELETE', path: '/sessions/token' }, false);
  if (kind === 'server') return requestServerLevel(client, target, '/productInfo', { signal, maxResponseBytes }, 'Server failed');
  if (kind === 'proxy') return new ProxyClient({ getProxyApiKey: async () => undefined }, logger, client.timeoutMs, client.httpClient)
    .listLayouts({ ...target, authMode: 'proxy', proxyEndpoint: target.serverUrl + '/proxy' }, signal);
  return requestWithAuth(client, target, request);
}

describe('hostile FileMaker response budgets', () => {
  it.each(kinds)('B2 applies a default size budget and a deadline to %s', async (kind) => {
    const configs: AxiosRequestConfig[] = [];
    const capture = async (config: AxiosRequestConfig) => {
      configs.push(config);
      return { data: kind === 'proxy' ? { ok: true, data: { layouts: [] } } : envelope, status: 200, headers: {} };
    };
    const http = { request: capture, get: (_url: string, config: AxiosRequestConfig) => capture(config), interceptors: { response: { use: vi.fn() } }, post: (_url: string, _data: unknown, config: AxiosRequestConfig) => capture(config) };
    const caller = new AbortController();
    await call(kind, context(http), profile, caller.signal);
    expect(configs[0]).toMatchObject({ timeout: 120, maxContentLength: DEFAULT_MAX_RESPONSE_BYTES, maxBodyLength: 3 * 1024 * 1024 * 1024 });
    expect(configs[0]?.signal).toBeDefined();
    expect(configs[0]?.signal).not.toBe(caller.signal);
  });

  it.each(['authenticated', 'raw', 'login', 'server'] as const)('B2 retains an explicit response budget for %s', async (kind) => {
    const request = vi.fn().mockResolvedValue({ data: envelope, status: 200, headers: {} });
    await call(kind, context({ request }), profile, undefined, 1024);
    expect(request.mock.calls[0]![0]).toHaveProperty('maxContentLength', 1024);
  });

  it('B2 budgets retired sessions too', async () => {
    const request = vi.fn().mockResolvedValue({ data: envelope, status: 200, headers: {} });
    const client = new FMClient(new SecretStore(new InMemorySecretStorage() as never), logger, 120, { request } as never);
    await (client as unknown as { retireSession(target: typeof profile, token: string): Promise<void> }).retireSession(profile, 'token');
    expect(request.mock.calls[0]![0]).toMatchObject({ maxContentLength: DEFAULT_MAX_RESPONSE_BYTES, maxBodyLength: 3 * 1024 * 1024 * 1024 });
  });

  it('B2 retains caller cancellation and removes listeners and timers after completion or failure', async () => {
    vi.useFakeTimers();
    try {
      const caller = new AbortController();
      const remove = vi.spyOn(caller.signal, 'removeEventListener');
      let combined: AxiosRequestConfig['signal'];
      const pending = withRequestLimits(100, caller.signal, async (limits) => {
        combined = limits.signal;
        return new Promise((_resolve, reject) => limits.signal!.addEventListener!('abort', () => reject(new Error('cancelled'))));
      });
      caller.abort();
      await expect(pending).rejects.toThrow('cancelled');
      expect(combined?.aborted).toBe(true);
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
      await withRequestLimits(100, caller.signal, async (limits) => expect(limits.signal?.aborted).toBe(true));
      await expect(withRequestLimits(100, undefined, async () => { throw new Error('failure'); })).rejects.toThrow('failure');
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(kinds)('B2 aborts a dripping adapter by deadline for %s even without a caller signal', async (kind) => {
    vi.useFakeTimers();
    try {
      let bytes = 0;
      const http = axios.create({ adapter: (config) => new Promise((resolve, reject) => {
        const drip = setInterval(() => { bytes++; }, 20);
        const finish = setTimeout(() => {
          clearInterval(drip);
          resolve({ data: kind === 'proxy' ? { ok: true, data: { layouts: [] } } : envelope, status: 200, statusText: 'OK', headers: {}, config });
        }, 1000);
        config.signal?.addEventListener?.('abort', () => {
          clearInterval(drip); clearTimeout(finish);
          reject(new CanceledError('cancelled', config));
        }, { once: true });
      }) });
      const outcome = call(kind, context(http)).then((value) => ({ value }), (error: unknown) => ({ error }));
      await vi.advanceTimersByTimeAsync(1100);
      expect(await outcome).toMatchObject({ error: kind === 'login' || kind === 'logout probe' ? { code: 'ECONNABORTED' } : { kind: 'timeout' } });
      expect(bytes).toBeGreaterThan(0);
      expect(bytes).toBeLessThan(10);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(kinds)('B2 aborts a loopback drip response by wall clock for %s', async (kind) => {
    nock.restore();
    let sawRequest = false;
    const server = createServer((request, response) => {
      sawRequest = true;
      request.resume();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      // Valid JSON with whitespace dripping much faster than the socket inactivity timeout.
      response.write(' ');
      const drip = setInterval(() => response.write(' '), 20);
      const finish = setTimeout(() => response.end(JSON.stringify(kind === 'proxy' ? { ok: true, data: { layouts: [] } } : envelope)), 1000);
      response.on('close', () => { clearInterval(drip); clearTimeout(finish); });
    });
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const target = { ...profile, serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
      const started = performance.now();
      await expect(call(kind, context(axios.create({ proxy: false })), target)).rejects.toMatchObject(kind === 'login' || kind === 'logout probe' ? { code: 'ECONNABORTED' } : { kind: 'timeout' });
      expect(performance.now() - started).toBeLessThan(800);
      expect(sawRequest).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      nock.activate();
      nock.disableNetConnect();
    }
  });

  it('B2 accepts a legitimate multi-megabyte page under the default and refuses one above an explicit limit', async () => {
    const body = { response: { data: [{ recordId: '1', fieldData: { Text: 'x'.repeat(2 * 1024 * 1024) } }] }, messages: [] };
    nock(profile.serverUrl).get('/fmi/data/vLatest/databases/DB/layouts').twice().reply(200, body);
    const http = axios.create({ proxy: false });
    const failures: unknown[] = [];
    http.interceptors.response.use(undefined, (error: unknown) => { failures.push(error); return Promise.reject(error); });
    const client = context(http, 5000);
    const result = await requestWithAuth(client, profile, { method: 'GET', path: '/layouts' });
    expect(result.response).toEqual(body.response);
    await expect(requestWithAuth(client, profile, { method: 'GET', path: '/layouts', maxResponseBytes: 1024 })).rejects.toBeInstanceOf(Error);
    expect(failures).toEqual([expect.objectContaining({ code: 'ERR_BAD_RESPONSE', message: expect.stringContaining('maxContentLength') })]);
  });
});
