import axios from 'axios';
import { EventEmitter } from 'events';
import http, { Agent, type ClientRequest, type IncomingMessage, type RequestOptions } from 'http';
import { PassThrough } from 'stream';
import nock from 'nock';
import { afterEach, expect, it, vi } from 'vitest';

import { uploadDeadlineMs, withRequestLimits } from '../../src/services/requestLimits';

// Exercise axios' real HTTP adapter without connecting any sockets. The supplied
// transport stands in for the pin/legacy TLS transport and must still be used.
function fixture(uploadBytes = 32 * 1024) {
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
  }), undefined, 'upload', transport, uploadBytes);
  // Attach rejection handling before advancing fake timers.
  const outcome = pending.then((response) => ({ response }), (error: unknown) => ({ error }));
  return { transport, socket, caller, oldTimeout, outcome, request: () => req! };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); if (!nock.isActive()) nock.activate(); nock.disableNetConnect(); });

it.each([false, true])('allows a connected upload to exceed the base timeout (initially connecting: %s)', async (connecting) => {
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
    expect(test.oldTimeout).toHaveBeenCalledWith(0);
    expect(test.socket.setTimeout).not.toHaveBeenCalled();
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

it.each(['deadline', 'cancel'] as const)('stops a connected upload awaiting a response on %s', async (action) => {
  vi.useFakeTimers();
  const test = fixture();
  try {
    await vi.advanceTimersByTimeAsync(0);
    test.request().emit('socket', test.socket);
    await vi.advanceTimersByTimeAsync(999);
    expect(test.request().destroyed).toBe(false);
    if (action === 'deadline') await vi.advanceTimersByTimeAsync(1);
    else test.caller.abort();
    expect(await test.outcome).toMatchObject({ error: { code: action === 'deadline' ? 'ECONNABORTED' : 'ERR_CANCELED' } });
    expect(test.request().destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally { test.request()?.destroy(); }
});

it('bounds a socket that is still connecting by the base timeout', async () => {
  vi.useFakeTimers();
  const test = fixture();
  try {
    await vi.advanceTimersByTimeAsync(0);
    test.socket.connecting = true;
    test.request().emit('socket', test.socket);
    await vi.advanceTimersByTimeAsync(100);
    expect(await test.outcome).toMatchObject({ error: { code: 'ECONNABORTED' } });
    expect(test.request().destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally { test.request()?.destroy(); }
});

it.each([
  [15_000, 0, 15_000],
  [15_000, 32, 15_000],
  [100, 32 * 1024, 1000],
  [15_000, 1024 * 1024, 32_000],
  [15_000, 64 * 1024 * 1024, 30 * 60_000],
  [31 * 60_000, 32, 30 * 60_000]
])('budgets an upload with base %i ms and %i bytes at %i ms', (base, bytes, expected) => {
  expect(uploadDeadlineMs(base, bytes)).toBe(expected);
});

it('aborts a connected large upload at the 30 minute ceiling', async () => {
  vi.useFakeTimers();
  const test = fixture(64 * 1024 * 1024);
  try {
    await vi.advanceTimersByTimeAsync(0);
    test.request().emit('socket', test.socket);
    await vi.advanceTimersByTimeAsync(30 * 60_000 - 1);
    expect(test.request().destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await test.outcome).toMatchObject({ error: { code: 'ECONNABORTED' } });
    expect(vi.getTimerCount()).toBe(0);
  } finally { test.request()?.destroy(); }
});
