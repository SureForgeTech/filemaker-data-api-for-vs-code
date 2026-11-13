import axios from 'axios';
import { EventEmitter } from 'events';
import http, { Agent, type ClientRequest, type IncomingMessage, type RequestOptions } from 'http';
import { PassThrough } from 'stream';
import nock from 'nock';
import { afterEach, expect, it, vi } from 'vitest';

import { withRequestLimits } from '../../src/services/requestLimits';

// Exercise axios' real HTTP adapter without connecting any sockets. The supplied
// transport stands in for the pin/legacy TLS transport and must still be used.
function fixture() {
  nock.restore();
  const agent = new Agent();
  vi.spyOn(agent as Agent & { addRequest(req: ClientRequest): void }, 'addRequest').mockImplementation(() => undefined);
  let req: ClientRequest;
  const oldTimeout = vi.fn();
  const transport = { request: vi.fn((_options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    req = new http.ClientRequest({ hostname: 'unused.invalid', agent }, callback);
    req.setTimeout = oldTimeout;
    return req;
  }) };
  const socket = Object.assign(new EventEmitter(), { connecting: false, setTimeout: vi.fn(), setKeepAlive: vi.fn() });
  const caller = new AbortController();
  const pending = withRequestLimits(100, caller.signal, (limits) => axios.post('http://unused.invalid/upload', Buffer.alloc(32), {
    ...limits, maxRedirects: 0, proxy: false
  }), undefined, 'upload', transport);
  // Attach rejection handling before advancing fake timers.
  const outcome = pending.then((response) => ({ response }), (error: unknown) => ({ error }));
  return { transport, socket, caller, oldTimeout, outcome, request: () => req! };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); nock.activate(); nock.disableNetConnect(); });

it.each([false, true])('uses native idle timeout after the upload socket connects (initially connecting: %s)', async (connecting) => {
  vi.useFakeTimers();
  const test = fixture();
  try {
    await vi.advanceTimersByTimeAsync(0);
    const req = test.request();
    test.socket.connecting = connecting;
    req.emit('socket', test.socket);
    if (connecting) {
      await vi.advanceTimersByTimeAsync(99);
      test.socket.connecting = false;
      test.socket.emit('connect');
    }
    await vi.advanceTimersByTimeAsync(150);
    expect(test.transport.request).toHaveBeenCalledOnce();
    expect(test.oldTimeout).not.toHaveBeenCalled();
    expect(test.socket.setTimeout).toHaveBeenCalledWith(100);
    expect(req.destroyed).toBe(false);
    const response = Object.assign(new PassThrough(), { statusCode: 200, statusMessage: 'OK', headers: {}, req });
    req.emit('response', response);
    response.end('{"ok":true}');
    expect(await test.outcome).toMatchObject({ response: { data: { ok: true } } });
    expect(vi.getTimerCount()).toBe(0);
  } finally { test.request()?.destroy(); }
});

it.each(['timeout', 'cancel'] as const)('stops an upload awaiting a socket on %s', async (action) => {
  vi.useFakeTimers();
  const test = fixture();
  try {
    await vi.advanceTimersByTimeAsync(0);
    if (action === 'timeout') await vi.advanceTimersByTimeAsync(100);
    else test.caller.abort();
    expect(await test.outcome).toMatchObject({ error: { code: action === 'timeout' ? 'ECONNABORTED' : 'ERR_CANCELED' } });
    expect(test.request().destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally { test.request()?.destroy(); }
});

it('stops a connected upload when its idle timeout fires', async () => {
  vi.useFakeTimers();
  const test = fixture();
  try {
    await vi.advanceTimersByTimeAsync(0);
    test.request().emit('socket', test.socket);
    await vi.advanceTimersByTimeAsync(150);
    test.request().emit('timeout');
    expect(await test.outcome).toMatchObject({ error: { code: 'ECONNABORTED' } });
    expect(test.request().destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally { test.request()?.destroy(); }
});
