import axios, { CanceledError, type AxiosRequestConfig } from 'axios';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import nock from 'nock';
import { describe, expect, it, vi } from 'vitest';
import { requestNoAuth, requestWithAuth, requestWithAuthRaw } from '../../src/services/fmClient/transport';
import { getRecord, listRecords, findRecords } from '../../src/services/fmClient/records';
import { uploadContainer } from '../../src/services/fmClient/containers';
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

const transfers = ['upload', 'get', 'list', 'find', 'proxy upload', 'proxy get', 'proxy find'] as const;
type Transfer = typeof transfers[number];
async function transfer(kind: Transfer, http: ReturnType<typeof axios.create>, signal?: AbortSignal, options: { target?: typeof profile; content?: Buffer; timeoutMs?: number } = {}) {
  const source = options.target ?? profile;
  const client = context(http, options.timeoutMs ?? 15_000);
  client.withHistory = (_history, run) => run({ operation: 'transfer', requestId: 'r', reauthCount: 0, cacheHit: false, endpoint: '' });
  client.requestWithAuth = (target, request, retry, trace) => requestWithAuth(client, target, request, retry, trace);
  const proxy = new ProxyClient({ getProxyApiKey: async () => undefined }, logger, client.timeoutMs, http);
  const target = { ...source, authMode: 'proxy' as const, proxyEndpoint: source.serverUrl + '/proxy' };
  const file = { fileName: 'Invoices.bin', content: options.content ?? Buffer.alloc(1024 * 1024), contentType: 'application/octet-stream' };
  if (kind === 'proxy upload') return proxy.uploadContainer(target, ' Layout ', '1', ' Field ', file, { signal });
  if (kind === 'proxy get') return proxy.getRecord(target, ' Layout ', '1', signal);
  if (kind === 'proxy find') return proxy.findRecords(target, ' Layout ', { query: [{ ' Field ': '*' }] }, signal);
  if (kind === 'upload') return uploadContainer(client, source, ' Layout ', '1', ' Field ', file, { signal });
  if (kind === 'get') return getRecord(client, profile, ' Layout ', '1', { signal });
  if (kind === 'list') return listRecords(client, profile, ' Layout ', {}, { signal });
  return findRecords(client, profile, ' Layout ', { query: [{ ' Field ': '*' }] }, { signal });
}

function transferAdapter(kind: Transfer, bytesPerTick: number, finishMs = 19_000, progressSeconds = Infinity, tickMs = 1000) {
  return axios.create({ adapter: (config) => new Promise((resolve, reject) => {
    let loaded = 0;
    let ticks = 0;
    const upload = kind.includes('upload');
    const stop = () => { clearInterval(tick); clearTimeout(finish); };
    // Axios can buffer the whole upload immediately; this says nothing about remote progress.
    if (upload) config.onUploadProgress?.({ loaded: 1024 * 1024, bytes: 1024 * 1024, lengthComputable: false });
    const tick = setInterval(() => {
      if (++ticks * tickMs > progressSeconds * 1000) return;
      loaded += bytesPerTick;
      if (!upload) config.onDownloadProgress?.({ loaded, bytes: bytesPerTick, lengthComputable: false });
    }, tickMs);
    const finish = setTimeout(() => {
      stop();
      const record = { recordId: '1', fieldData: { ' Field ': 'value' } };
      const result = { recordId: '1', data: [record] };
      resolve({ data: kind.startsWith('proxy') ? { ok: true, data: { record, result } }
        : { response: result, messages: [{ code: '0', message: 'OK' }] }, status: 200, statusText: 'OK', headers: {}, config });
    }, finishMs);
    config.signal?.addEventListener?.('abort', () => {
      stop();
      reject(new CanceledError('cancelled', config));
    }, { once: true });
  }) });
}

describe('transfer progress deadlines', () => {
  it.each(['upload', 'proxy upload'] as const)('bounds the whole %s exchange using its encoded body size', async (kind) => {
    vi.useFakeTimers();
    try {
      let bodyBytes = 0;
      let settled = false;
      const http = axios.create({ adapter: (config) => new Promise((_resolve, reject) => {
        bodyBytes = Buffer.byteLength(config.data as string | Buffer);
        expect(config.timeout).toBe(0);
        expect(config.onDownloadProgress).toBeUndefined();
        config.signal?.addEventListener?.('abort', () => reject(new CanceledError('cancelled', config)), { once: true });
      }) });
      const outcome = transfer(kind, http, undefined, { content: Buffer.alloc(32 * 1024), timeoutMs: 100 })
        .then(() => 'completed', (error: unknown) => error).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      // Budget the multipart envelope or full proxy JSON, including base64 expansion.
      expect(bodyBytes).toBeGreaterThan(kind === 'upload' ? 32 * 1024 : 32 * 1024 * 4 / 3);
      const deadline = bodyBytes / (32 * 1024) * 1000;
      await vi.advanceTimersByTimeAsync(Math.floor(deadline) - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(settled).toBe(true);
      expect(await outcome).toMatchObject({ kind: 'timeout' });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(transfers.filter((kind) => !kind.includes('upload')))('caps a continuously progressing %s at 30 minutes', async (kind) => {
    vi.useFakeTimers();
    try {
      let settled = false;
      // 64 KiB per 14 seconds stays below the response cap even after 30 minutes.
      const outcome = transfer(kind, transferAdapter(kind, 64 * 1024, 31 * 60_000, Infinity, 14_000))
        .then(() => 'completed', (error: unknown) => error).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(30 * 60_000 - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(await outcome).toMatchObject({ kind: 'timeout' });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(transfers)('lets a large progressing %s finish beyond the default deadline', async (kind) => {
    vi.useFakeTimers();
    try {
      // Downloads report over 100 MiB of progress; uploads use their encoded body size.
      const outcome = transfer(kind, transferAdapter(kind, 8 * 1024 * 1024)).then(() => 'completed', () => 'aborted');
      await vi.advanceTimersByTimeAsync(19_000);
      expect(await outcome).toBe('completed');
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(transfers)('aborts a stalled %s and rejects trickling downloads', async (kind) => {
    vi.useFakeTimers();
    try {
      for (const bytes of kind.includes('upload') ? [0] : [0, 1]) {
        const outcome = transfer(kind, transferAdapter(kind, bytes), undefined, { content: Buffer.alloc(32) }).then(() => 'completed', (error: unknown) => error);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(await outcome).toMatchObject({ kind: 'timeout' });
        expect(vi.getTimerCount()).toBe(0);
      }
    } finally { vi.useRealTimers(); }
  });

  it.each(transfers.filter((kind) => !kind.includes('upload')))('times out %s after its earlier progress stops', async (kind) => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const outcome = transfer(kind, transferAdapter(kind, 8 * 1024 * 1024, 30_000, 2))
        .then(() => 'completed', (error: unknown) => error).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(16_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await outcome).toMatchObject({ kind: 'timeout' });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(transfers)('retains user cancellation for a %s beyond the default deadline', async (kind) => {
    vi.useFakeTimers();
    try {
      const caller = new AbortController();
      const outcome = transfer(kind, transferAdapter(kind, 8 * 1024 * 1024), caller.signal).then(() => 'completed', (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(16_000);
      caller.abort();
      expect(await outcome).toMatchObject({ kind: 'cancellation' });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});


describe('real HTTP upload deadlines', () => {
  it.each(['upload', 'proxy upload'] as const)('lets a slow, steadily draining %s outlast the base request timeout', async (kind) => {
    nock.restore();
    let received = 0;
    const server = createServer((request, response) => {
      // Consume at most 8 KiB every 80 ms, regardless of client socket buffering.
      // Even the direct 64 KiB body takes longer than the 300 ms base timeout.
      const reader = setInterval(() => {
        const chunk = request.read(8 * 1024) as Buffer | null;
        if (chunk) received += chunk.length;
      }, 80);
      request.on('end', () => {
        clearInterval(reader);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(kind === 'proxy upload'
          ? { ok: true, data: { result: { recordId: '1' } } } : envelope));
      });
      request.on('close', () => clearInterval(reader));
    });
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const target = { ...profile, serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
      const started = performance.now();
      await transfer(kind, axios.create({ proxy: false }), undefined, { target, content: Buffer.alloc(64 * 1024), timeoutMs: 300 });
      expect(received).toBeGreaterThanOrEqual(64 * 1024);
      expect(performance.now() - started).toBeGreaterThan(300);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      nock.activate();
      nock.disableNetConnect();
    }
  }, 10_000);

  it.each(['upload', 'proxy upload'] as const)('stops a %s when the real server stops reading', async (kind) => {
    nock.restore();
    let received = 0;
    const server = createServer((request) => {
      request.once('readable', () => { received = (request.read(1) as Buffer | null)?.length ?? 0; });
      // Leave the rest unread and never reply, even if it fits in the client's buffers.
    });
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const target = { ...profile, serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
      const started = performance.now();
      await expect(transfer(kind, axios.create({ proxy: false }), undefined, {
        target, content: Buffer.alloc(32), timeoutMs: 300
      })).rejects.toMatchObject({ kind: 'timeout' });
      expect(received).toBeGreaterThan(0);
      expect(performance.now() - started).toBeGreaterThanOrEqual(250);
      expect(performance.now() - started).toBeLessThan(5000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      nock.activate();
      nock.disableNetConnect();
    }
  }, 10_000);
});
