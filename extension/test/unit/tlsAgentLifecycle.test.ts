import { mkdtemp, utimes, writeFile } from 'fs/promises';
import { createServer, get, type Server } from 'https';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from 'https';

import type * as TlsAgentModule from '../../src/services/tlsAgent';
import {
  PinnedCertificateAgent,
  RETIRED_AGENT_GRACE_MS,
  createHttpsAgentForProfile,
  disposeTlsAgents,
  normalizeSha256
} from '../../src/services/tlsAgent';
import { DAY, keyToPem, makeCertificate, newKeyPair } from '../helpers/x509';

const pem = (cn: string): string =>
  makeCertificate({ subjectCn: cn, notBefore: new Date(Date.now() - DAY), notAfter: new Date(Date.now() + DAY), subjectKey: newKeyPair() }).pem;

describe('agents that are replaced or evicted are closed', () => {
  afterEach(() => {
    vi.useRealTimers();
    disposeTlsAgents();
  });

  it('closes the agent made for an earlier version of an edited CA file, after a grace period for running requests', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), 'fm-life-'));
    const caPath = join(root, 'ca.pem');
    await writeFile(caPath, pem('one'), 'utf8');
    const first = createHttpsAgentForProfile({ caBundlePath: caPath });
    const destroyFirst = vi.spyOn(first, 'destroy');

    await writeFile(caPath, `${pem('two')}${pem('three')}`, 'utf8');
    await utimes(caPath, new Date(), new Date(Date.now() + 5000));
    const second = createHttpsAgentForProfile({ caBundlePath: caPath });
    const destroySecond = vi.spyOn(second, 'destroy');

    expect(second).not.toBe(first);
    expect(destroyFirst).not.toHaveBeenCalled(); // a request already running on it is not cut off
    // The grace is a real thirty seconds (written out, so shortening the constant is caught).
    expect(RETIRED_AGENT_GRACE_MS).toBe(30_000);
    vi.advanceTimersByTime(29_999);
    expect(destroyFirst).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(destroyFirst).toHaveBeenCalledTimes(1);
    expect(destroySecond).not.toHaveBeenCalled(); // the current agent stays
    expect(createHttpsAgentForProfile({ caBundlePath: caPath })).toBe(second);
  });

  it('keeps the number of cached agents bounded: the oldest is retired, newer ones stay', () => {
    vi.useFakeTimers();
    const pins = Array.from({ length: 40 }, (_, i) => normalizeSha256(i.toString(16).padStart(2, '0').repeat(32)) as string);
    const agents = pins.map((pin) => createHttpsAgentForProfile({ pinnedCertSha256: pin }));
    const spies = agents.map((agent) => vi.spyOn(agent, 'destroy'));

    vi.advanceTimersByTime(RETIRED_AGENT_GRACE_MS);

    const destroyed = spies.filter((spy) => spy.mock.calls.length > 0).length;
    expect(destroyed).toBe(8); // 40 made, 32 kept
    expect(spies.slice(0, 8).every((spy) => spy.mock.calls.length === 1)).toBe(true);
    expect(spies.slice(8).every((spy) => spy.mock.calls.length === 0)).toBe(true);
    // A retired setting simply gets a fresh agent when it is used again.
    expect(createHttpsAgentForProfile({ pinnedCertSha256: pins[0] })).not.toBe(agents[0]);
    expect(createHttpsAgentForProfile({ pinnedCertSha256: pins[39] })).toBe(agents[39]);
  });

  it('a retiring agent does not keep the process alive (its timer is unref\'d)', () => {
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const first = createHttpsAgentForProfile({ pinnedCertSha256: 'a1'.repeat(32) });
    expect(first).toBeTruthy();
    for (let i = 0; i < 33; i += 1) {
      createHttpsAgentForProfile({ pinnedCertSha256: (i + 16).toString(16).padStart(2, '0').repeat(32) });
    }
    const retireTimer = timers.mock.results.map((result) => result.value as { hasRef?: () => boolean }).find((timer) => typeof timer?.hasRef === 'function');
    expect(retireTimer).toBeDefined();
    expect(retireTimer?.hasRef?.()).toBe(false);
    timers.mockRestore();
  });

  it('evicts the LEAST recently used agent, not the oldest one made', () => {
    vi.useFakeTimers();
    const pins = Array.from({ length: 33 }, (_, i) => normalizeSha256((i + 64).toString(16).padStart(2, '0').repeat(32)) as string);
    const agents = pins.slice(0, 32).map((pin) => createHttpsAgentForProfile({ pinnedCertSha256: pin }));
    const spies = agents.map((agent) => vi.spyOn(agent, 'destroy'));
    // Use the first one again, so the second is now the one nobody has touched the longest.
    expect(createHttpsAgentForProfile({ pinnedCertSha256: pins[0] })).toBe(agents[0]);
    createHttpsAgentForProfile({ pinnedCertSha256: pins[32] }); // the 33rd pushes one out

    vi.advanceTimersByTime(30_000);

    expect(spies[0]?.mock.calls.length).toBe(0); // kept: recently used
    expect(spies[1]?.mock.calls.length).toBe(1); // evicted
    expect(spies.slice(2).every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });

  it('disposeTlsAgents also closes agents that are waiting out their grace, and cancels their timers', () => {
    vi.useFakeTimers();
    const pins = Array.from({ length: 33 }, (_, i) => normalizeSha256((i + 100).toString(16).padStart(2, '0').repeat(32)) as string);
    const agents = pins.map((pin) => createHttpsAgentForProfile({ pinnedCertSha256: pin }));
    const retired = vi.spyOn(agents[0] as Agent, 'destroy'); // evicted by the 33rd, waiting for its timer
    expect(vi.getTimerCount()).toBe(1);

    disposeTlsAgents();

    expect(retired).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(retired).toHaveBeenCalledTimes(1); // not closed a second time by a leftover timer
  });

  it('disposeTlsAgents closes everything at once and forgets it', () => {
    const agent = createHttpsAgentForProfile({ pinnedCertSha256: 'cd'.repeat(32) });
    const destroy = vi.spyOn(agent, 'destroy');
    disposeTlsAgents();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(createHttpsAgentForProfile({ pinnedCertSha256: 'cd'.repeat(32) })).not.toBe(agent);
  });
});

describe('a pinned agent and kept-alive sockets', () => {
  const servers: Server[] = [];
  beforeAll(() => nock.restore());
  afterAll(() => {
    nock.activate();
    nock.disableNetConnect();
  });
  afterEach(async () => {
    // The agent made for the pinned certificate is closed here, so it does not stay in the
    // module's cache and change what a later test finds there.
    disposeTlsAgents();
    await Promise.all(
      servers.splice(0).map((server) => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
      })
    );
  });

  async function listen() {
    const key = newKeyPair();
    const cert = makeCertificate({ subjectCn: 'fm.internal', altNames: ['fm.internal'], notBefore: new Date(Date.now() - DAY), notAfter: new Date(Date.now() + DAY), subjectKey: key });
    let connections = 0;
    const server = createServer({ key: keyToPem(key), cert: cert.pem }, (_request, response) => {
      response.end('ok');
    });
    server.on('secureConnection', () => (connections += 1));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as AddressInfo).port, pin: normalizeSha256(cert.fingerprint256) as string, connections: () => connections };
  }

  const fetchOnce = (port: number, agent: PinnedCertificateAgent): Promise<string> =>
    new Promise((resolve) => {
      get({ host: '127.0.0.1', port, path: '/', agent }, (response) => {
        response.resume();
        response.on('end', () => resolve('OK'));
      }).on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
    });

  it('the agent the extension builds does not keep sockets alive: every request is a new, checked connection', async () => {
    const server = await listen();
    const agent = createHttpsAgentForProfile({ pinnedCertSha256: server.pin });
    expect(agent).toBeInstanceOf(PinnedCertificateAgent);
    expect((agent.options as { keepAlive?: boolean }).keepAlive).toBeFalsy();
    for (let i = 0; i < 4; i += 1) {
      expect(await fetchOnce(server.port, agent as PinnedCertificateAgent)).toBe('OK');
    }
    expect(server.connections()).toBe(4);
  });

  it('does not change the request options it is given (Node files a kept-alive socket under a name built from them, so changing them stranded the socket)', () => {
    const agent = new PinnedCertificateAgent({ keepAlive: true }, { sha256: 'ab'.repeat(32), allowExpired: false });
    const options = { host: '127.0.0.1', port: 1, servername: 'fm.internal' };
    const before = JSON.stringify(options);
    const socket = agent.createConnection(options);
    socket.on('error', () => undefined);
    socket.destroy();
    expect(JSON.stringify(options)).toBe(before);
    expect(Object.keys(options)).toEqual(['host', 'port', 'servername']);
    agent.destroy();
  });

  it('forces its own checking options even when the caller passes others (they cannot switch the check back on or replace the identity check)', async () => {
    const { Agent: HttpsAgent } = await import('https');
    const fakeSocket = { cork: vi.fn(), uncork: vi.fn(), once: vi.fn(), destroy: vi.fn(), isSessionReused: () => false };
    const spy = vi.spyOn(HttpsAgent.prototype as unknown as { createConnection: (...a: unknown[]) => unknown }, 'createConnection').mockReturnValue(fakeSocket);
    try {
      const agent = new PinnedCertificateAgent({}, { sha256: 'ab'.repeat(32), allowExpired: false });
      const mine = { host: 'h', port: 1, rejectUnauthorized: true, checkServerIdentity: () => new Error('x') };
      agent.createConnection(mine);
      const passed = spy.mock.calls[0]?.[0] as { rejectUnauthorized: boolean; checkServerIdentity: () => unknown };
      expect(passed.rejectUnauthorized).toBe(false);
      expect(passed.checkServerIdentity()).toBeUndefined();
      expect(mine.rejectUnauthorized).toBe(true); // and the caller's own object is untouched
      expect(fakeSocket.cork).toHaveBeenCalled();
      agent.destroy();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the grace for a replaced agent outlives a long request', () => {
  // The grace is a module global that is only ever raised, so this block works on its own copy
  // of the module: the tests below must not depend on the order they run in, and the grace they
  // raise must not reach any other test.
  let tls: typeof TlsAgentModule;

  beforeEach(async () => {
    vi.resetModules();
    tls = await import('../../src/services/tlsAgent');
  });

  afterEach(() => {
    vi.useRealTimers();
    tls.disposeTlsAgents();
  });

  it('is at least the request timeout plus ten seconds (and never less than thirty)', () => {
    expect(tls.retiredAgentGrace()).toBe(30_000);
    tls.noteRequestTimeout(5_000);
    expect(tls.retiredAgentGrace()).toBe(30_000);
    tls.noteRequestTimeout(120_000);
    expect(tls.retiredAgentGrace()).toBe(130_000);
    tls.noteRequestTimeout(60_000); // only ever raised
    expect(tls.retiredAgentGrace()).toBe(130_000);
    tls.noteRequestTimeout(Number.NaN);
    tls.noteRequestTimeout(-1);
    expect(tls.retiredAgentGrace()).toBe(130_000);
  });

  it('an agent replaced while a long request runs is not closed until that request could have finished', () => {
    vi.useFakeTimers();
    tls.noteRequestTimeout(120_000);
    const pins = Array.from({ length: 33 }, (_, i) => tls.normalizeSha256((i + 140).toString(16).padStart(2, '0').repeat(32)) as string);
    const agents = pins.map((pin) => tls.createHttpsAgentForProfile({ pinnedCertSha256: pin }));
    const evicted = vi.spyOn(agents[0] as Agent, 'destroy');
    vi.advanceTimersByTime(129_999);
    expect(evicted).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(evicted).toHaveBeenCalledTimes(1);
  });
});
