import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy';
import { POST } from '../app/api/bridge/[route]/route';

let dir: string;
const secret = 'test-private-bridge-canary';
const session = 's'.repeat(64);
const launch = 'l'.repeat(64);
const request = (url: string, cookie?: string, host = '127.0.0.1:3000') => new NextRequest(`http://127.0.0.1:3000${url}`, {
  method: url.startsWith('/api/') ? 'POST' : 'GET',
  headers: { host, origin: 'http://127.0.0.1:3000', ...(cookie ? { cookie: `fmweb_preview=${cookie}` } : {}) },
  ...(url.startsWith('/api/') ? { body: '{"layout":"L"}' } : {})
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'preview-auth-'));
  vi.stubEnv('FMWEB_BRIDGE_TOKEN', secret);
  vi.stubEnv('FMWEB_BRIDGE_URL', 'http://127.0.0.1:1234/fm');
  vi.stubEnv('FMWEB_PREVIEW_SESSION', session);
  vi.stubEnv('FMWEB_LAUNCH_CODE', launch);
  vi.stubEnv('FMWEB_LAUNCH_EXPIRES', String(Date.now() + 120000));
  vi.stubEnv('FMWEB_LAUNCH_STATE', path.join(dir, 'used'));
});
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }); });

describe('A8 private preview', () => {
  it('requires a cookie for pages, assets, and the proxy route', async () => {
    for (const url of ['/', '/layouts/example', '/_next/static/chunk.js', '/api/bridge/find']) {
      expect((await proxy(request(url))).status).toBe(401);
    }
    expect((await POST(request('/api/bridge/find'), { params: Promise.resolve({ route: 'find' }) })).status).toBe(401);
  });
  it('exchanges the code once for a strict HttpOnly cookie and removes the query', async () => {
    const first = await proxy(request(`/?launch=${launch}`));
    expect(first.status).toBe(303);
    expect(first.headers.get('location')).toBe('http://127.0.0.1:3000/');
    expect(first.headers.get('set-cookie')).toContain('HttpOnly');
    expect(first.headers.get('set-cookie')).toContain('SameSite=strict');
    expect(first.headers.get('set-cookie')).toContain('Path=/');
    expect((await proxy(request(`/?launch=${launch}`))).status).toBe(401);
    expect((await proxy(request('/', session))).status).toBe(200);
  });
  it('atomically refuses concurrent reuse, wrong codes and expired launches', async () => {
    expect((await proxy(request('/?launch=wrong'))).status).toBe(401);
    vi.stubEnv('FMWEB_LAUNCH_EXPIRES', String(Date.now() - 1));
    expect((await proxy(request(`/?launch=${launch}`))).status).toBe(401);
    vi.stubEnv('FMWEB_LAUNCH_EXPIRES', String(Date.now() + 120000));
    const result = await Promise.all([proxy(request(`/?launch=${launch}`)), proxy(request(`/?launch=${launch}`))]);
    expect(result.map((r) => r.status).sort()).toEqual([303, 401]);
  });
  it.each(['evil.test:3000', '127.0.0.1:3001', 'localhost.evil:3000'])('rejects wrong Host %s even with a cookie', async (host) => {
    expect((await proxy(request('/', session, host))).status).toBe(403);
    expect((await POST(request('/api/bridge/find', session, host), { params: Promise.resolve({ route: 'find' }) })).status).toBe(403);
  });
  it('adds the token only on the server and returns no upstream headers or secrets', async () => {
    const fetcher = vi.fn(async () => Response.json({ data: [] }, { headers: { 'x-debug': secret } }));
    vi.stubGlobal('fetch', fetcher);
    const response = await POST(request('/api/bridge/find', session), { params: Promise.resolve({ route: 'find' }) });
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:1234/fm/find', expect.objectContaining({ headers: expect.objectContaining({ 'X-FM-Bridge-Token': secret, Origin: 'http://127.0.0.1:3000' }) }));
    expect(await response.text()).not.toContain(secret);
    expect(response.headers.get('x-debug')).toBeNull();
  });
  it('rejects forged/missing Origin, cookies and unknown routes without calling the bridge', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect((await POST(request('/api/bridge/find', 'wrong'), { params: Promise.resolve({ route: 'find' }) })).status).toBe(401);
    const forged = request('/api/bridge/find', session); forged.headers.set('origin', 'http://evil.test');
    expect((await POST(forged, { params: Promise.resolve({ route: 'find' }) })).status).toBe(403);
    expect((await POST(request('/api/bridge/evil', session), { params: Promise.resolve({ route: 'evil' }) })).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('has no public credential in the client source graph or config', async () => {
    for (const file of ['lib/runtime-data.ts', 'lib/runtime-behavior.ts', 'lib/bridge-client.ts', 'app/layouts/[id]/runtime-layout-client.tsx', 'next.config.ts']) {
      const source = await readFile(path.resolve(file), 'utf8');
      expect(source).not.toMatch(/NEXT_PUBLIC_FMWEB_BRIDGE_TOKEN|process\.env\.FMWEB_BRIDGE_TOKEN|preview-security|bridge-proxy/);
    }
  });
});
