import { EventEmitter } from 'events';
import net, { type AddressInfo } from 'net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { probeTcpAccept, type ProbeServer, type ProbeSocket } from './tcpProbe';

type FakeSocket = ProbeSocket & EventEmitter;
const fakeSocket = (): FakeSocket => Object.assign(new EventEmitter(), { destroy: vi.fn() }) as unknown as FakeSocket;
const fakeServer = (): ProbeServer & EventEmitter => new EventEmitter() as unknown as ProbeServer & EventEmitter;

describe('probeTcpAccept', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports a listening loopback server as reachable, sends nothing and leaves no listener behind', async () => {
    const received: Buffer[] = [];
    const accepted: net.Socket[] = [];
    const server = net.createServer((socket) => {
      accepted.push(socket);
      socket.on('data', (chunk) => received.push(chunk));
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const before = server.listenerCount('connection');
      expect(await probeTcpAccept(server, '127.0.0.1', (server.address() as AddressInfo).port)).toEqual({ reachable: true });
      expect(server.listenerCount('connection')).toBe(before);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(received).toEqual([]);
      expect(accepted).toHaveLength(1);
    } finally {
      accepted.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports a refused connection with its error code', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probeTcpAccept(server, '127.0.0.1', port)).toEqual({ reachable: false, reason: `ECONNREFUSED connecting to 127.0.0.1:${port}` });
  });

  it('is not reachable when the handshake completes but the listener never accepts (a filtered LAN address)', async () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const server = fakeServer();
    const pending = probeTcpAccept(server, '192.0.2.1', 9, 500, () => socket);
    socket.emit('connect');
    await vi.advanceTimersByTimeAsync(499);
    expect(socket.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ reachable: false, reason: '192.0.2.1:9 completed a TCP handshake but the listener never accepted the connection within 500 ms' });
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(server.listenerCount('connection')).toBe(0);
    expect(socket.listenerCount('connect')).toBe(0);
    // A late error is absorbed instead of crashing the run.
    expect(() => socket.emit('error', new Error('late'))).not.toThrow();
  });

  it('is not reachable when no connection completes before the timeout', async () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const server = fakeServer();
    const pending = probeTcpAccept(server, '192.0.2.1', 9, 500, () => socket);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual({ reachable: false, reason: '192.0.2.1:9 did not complete a TCP connection within 500 ms' });
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(server.listenerCount('connection')).toBe(0);
  });

  it('clears the timer as soon as both sides have seen the connection', async () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const server = fakeServer();
    const pending = probeTcpAccept(server, '192.0.2.1', 9, 500, () => socket);
    server.emit('connection', {});
    expect(vi.getTimerCount()).toBe(1);
    socket.emit('connect');
    expect(await pending).toEqual({ reachable: true });
    expect(vi.getTimerCount()).toBe(0);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(server.listenerCount('connection')).toBe(0);
  });
});
