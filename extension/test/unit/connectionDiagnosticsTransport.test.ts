import axios from 'axios';
import * as vscode from 'vscode';
import { setAgentReplacedPolicy } from '../../src/services/tlsAgent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDiagnosticProbes } from '../../src/services/connectionDiagnostics';
import { FMClient } from '../../src/services/fmClient';
import type { ConnectionProfile } from '../../src/types/fm';

const profile: ConnectionProfile = { id: 'p', name: 'Office', serverUrl: 'https://fm.example.test', database: 'DB', authMode: 'direct', username: 'admin' };
function client() {
  const request = vi.fn().mockResolvedValue({ status: 200, data: { response: { productInfo: { name: 'FileMaker Server', version: '22' } }, messages: [{ code: '0', message: 'OK' }] } });
  const secrets = { getPassword: vi.fn(), getToken: vi.fn(), getProxyApiKey: vi.fn() };
  const fm = new FMClient(secrets as never, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, 5000, { request } as never);
  return { fm, request, secrets };
}

describe('diagnosis uses the real FMClient unauthenticated transport', () => {
  it('reports actual HTTP status and envelope code, without session or credential access', async () => {
    const { fm, request, secrets } = client();
    const caller = new AbortController();
    const signal = caller.signal;
    request.mockImplementationOnce(async (options) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.signal).not.toBe(signal);
      expect(options.signal.aborted).toBe(false);
      caller.abort();
      expect(options.signal.aborted).toBe(true);
      return { status: 201, data: { response: { productInfo: { name: 'Server', version: '23' } }, messages: [{ code: '0' }] } };
    });
    expect(await createDiagnosticProbes(fm).product(profile, signal)).toEqual({ status: 201, code: '0', name: 'Server', version: '23' });
    const options = request.mock.calls[0]![0];
    expect(options).toMatchObject({ method: 'GET', url: 'https://fm.example.test/fmi/data/vLatest/productInfo', headers: { Accept: 'application/json' }, maxRedirects: 0, timeout: 5000 });
    expect(options.headers).toEqual({ Accept: 'application/json' });
    expect(options.auth).toBeUndefined(); expect(secrets.getPassword).not.toHaveBeenCalled(); expect(secrets.getToken).not.toHaveBeenCalled(); expect(secrets.getProxyApiKey).not.toHaveBeenCalled();
  });
  it('provides a deadline signal even without caller cancellation', async () => {
    vi.useFakeTimers();
    try {
      const { fm, request } = client();
      request.mockImplementationOnce(async (options) => {
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(options.signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(5000);
        expect(options.signal.aborted).toBe(true);
        return { status: 200, data: { response: { productInfo: {} }, messages: [{ code: '0' }] } };
      });
      await fm.getProductInfoDiagnostics(profile);
    } finally {
      vi.useRealTimers();
    }
  });
  it('uses the path prefix in the real unauthenticated request', async () => {
    const { fm, request } = client();
    await createDiagnosticProbes(fm).product({ ...profile, serverUrl: 'https://fm.example.test/fm' }, new AbortController().signal);
    expect(request.mock.calls[0]![0].url).toBe('https://fm.example.test/fm/fmi/data/vLatest/productInfo');
  });
  it('retains HTTP/FileMaker errors without starting another uncancellable certificate inspection', async () => {
    const { fm, request } = client();
    request.mockResolvedValueOnce({ status: 200, data: { response: {}, messages: [{ code: '802', message: 'Unavailable' }] } });
    await expect(fm.getProductInfoDiagnostics(profile)).rejects.toMatchObject({ status: 200, code: '802' });
    const refine = vi.spyOn(fm as never as { refineCertificateError: () => Promise<never> }, 'refineCertificateError');
    request.mockRejectedValueOnce(new axios.AxiosError('certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT'));
    await expect(fm.getProductInfoDiagnostics(profile)).rejects.toMatchObject({ networkCode: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    expect(refine).not.toHaveBeenCalled();
  });
  it('refuses a non-Data-API success without printing the body', async () => {
    const { fm, request } = client(); request.mockResolvedValueOnce({ status: 200, data: '<html>proxy sign-in</html>' });
    await expect(fm.getProductInfoDiagnostics(profile)).rejects.toMatchObject({ status: 200, code: 'NOT_DATA_API_RESPONSE' });
  });
});

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); setAgentReplacedPolicy(() => false); });
it.each(['fallback', 'on', 'off'])('names an unreachable environment proxy for legacy self-signed profiles (%s)', async (proxySupport) => {
  vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({ get: (key: string, fallback: unknown) => key === 'proxySupport' ? proxySupport : fallback } as never);
  vi.stubEnv('https_proxy', ''); vi.stubEnv('ALL_PROXY', ''); vi.stubEnv('all_proxy', ''); vi.stubEnv('NO_PROXY', ''); vi.stubEnv('no_proxy', ''); vi.stubEnv('HTTPS_PROXY', 'http://user:secret@127.0.0.9:4321'); // set last: Windows env names ignore case
  const { fm, request } = client();
  request.mockImplementationOnce(async (config) => {
    throw Object.assign(new axios.AxiosError('connect ECONNREFUSED 127.0.0.9:4321', 'ECONNREFUSED', config), { cause: { code: 'ECONNREFUSED', address: '127.0.0.9', port: 4321 } });
  });
  await expect(fm.getProductInfoDiagnostics({ ...profile, allowSelfSigned: true })).rejects.toMatchObject({ code: 'PROXY_UNREACHABLE', networkCode: 'ECONNREFUSED', message: expect.stringMatching(/proxy.*could not be reached.*HTTPS_PROXY.*http.proxySupport/i) });
  const config = request.mock.calls[0]![0];
  expect(config.transport).toBeUndefined(); // use axios's async proxy agent, not a native ClientRequest
  expect(config.httpsAgent.options.rejectUnauthorized).toBe(false);
});
it('keeps server advice when the failed address is the server, even with an environment proxy set', async () => {
  vi.stubEnv('https_proxy', ''); vi.stubEnv('NO_PROXY', ''); vi.stubEnv('no_proxy', ''); vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.9:4321'); // set last: Windows env names ignore case
  const { fm, request } = client();
  request.mockImplementationOnce(async (config) => { throw Object.assign(new axios.AxiosError('refused', 'ECONNREFUSED', config), { cause: { address: '192.0.2.1', port: 443 } }); });
  await expect(fm.getProductInfoDiagnostics(profile)).rejects.toMatchObject({ message: expect.stringContaining('Nothing is listening on fm.example.test') });
});
it('identifies the proxy selected by a VS Code proxy agent without exposing sign-in details', async () => {
  const { fm, request } = client();
  request.mockImplementationOnce(async (config) => {
    const req = { agent: { proxy: new URL('http://user:secret@proxy.example.test:3128') } };
    throw Object.assign(new axios.AxiosError('refused', 'ECONNREFUSED', config, req), { cause: { address: '192.0.2.9', port: 3128 } });
  });
  try { await fm.getProductInfoDiagnostics(profile); throw new Error('expected a failure'); }
  catch (error) {
    expect(error).toMatchObject({ code: 'PROXY_UNREACHABLE', message: expect.stringMatching(/proxy.*proxy.example.test:3128.*http.proxy.*http.proxySupport/i) });
    expect((error as Error).message).not.toMatch(/user|secret|Nothing is listening/);
  }
});

it('recognizes a failed VS Code proxy address when the host replaces the agent', async () => {
  vi.stubEnv('HTTPS_PROXY', ''); vi.stubEnv('https_proxy', ''); vi.stubEnv('ALL_PROXY', ''); vi.stubEnv('all_proxy', '');
  setAgentReplacedPolicy(() => true);
  vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({ get: (key: string, fallback: unknown) => key === 'proxy' ? 'http://user:secret@127.0.0.8:3128' : key === 'proxySupport' ? 'override' : fallback } as never);
  const { fm, request } = client();
  request.mockImplementationOnce(async (config) => { throw Object.assign(new axios.AxiosError('refused', 'ECONNREFUSED', config), { cause: { address: '127.0.0.8', port: 3128 } }); });
  await expect(fm.getProductInfoDiagnostics(profile)).rejects.toMatchObject({ code: 'PROXY_UNREACHABLE', message: expect.stringMatching(/proxy.*127.0.0.8:3128.*VS Code http.proxy.*http.proxySupport/i) });
});
