import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import nock from 'nock';

import { ProfileStore } from '../../src/services/profileStore';
import { SecretStore } from '../../src/services/secretStore';
import { FMClient } from '../../src/services/fmClient';
import { buildEndpoint } from '../../src/services/fmClient/transport';
import { InMemoryMemento, InMemorySecretStorage } from './mocks';

const profile = { id: 'legacy', name: 'Legacy', authMode: 'direct' as const,
  serverUrl: 'https://old-user:url%20password@fm.example.test', database: 'Sales', username: 'admin' };
const key = 'filemakerDataApiTools.profiles';

describe('legacy profile URL credential hygiene', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([undefined, '', 'separately saved'])('removes persisted userinfo and preserves an existing password (%s)', async (existing) => {
    const global = new InMemoryMemento();
    await global.update(key, [profile]);
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    if (existing !== undefined) await secrets.setPassword(profile.id, existing);
    const store = new ProfileStore(global as never, new InMemoryMemento() as never, secrets);
    expect(store.listProfilesSync()[0]?.serverUrl).toBe('https://fm.example.test');
    expect((await store.getProfile(profile.id))?.serverUrl).toBe('https://fm.example.test');
    expect(await secrets.getPassword(profile.id)).toBe(existing ?? 'url password');
    expect(global.get<Array<{ serverUrl: string }>>(key)?.[0]?.serverUrl).toBe('https://fm.example.test');
    await store.listProfiles();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/Re-enter or confirm/));
    expect(JSON.stringify(vi.mocked(vscode.window.showWarningMessage).mock.calls)).not.toContain('url%20password');
  });

  it('keeps a sanitized profile visible when the secret store is unavailable', async () => {
    const global = new InMemoryMemento();
    await global.update(key, [profile]);
    const unavailable = { getPassword: vi.fn().mockRejectedValue(new Error('unavailable')), setPassword: vi.fn() };
    const store = new ProfileStore(global as never, new InMemoryMemento() as never, unavailable);
    expect((await store.listProfiles())[0]?.serverUrl).toBe('https://fm.example.test');
    expect(global.get<Array<{ serverUrl: string }>>(key)?.[0]?.serverUrl).toBe('https://fm.example.test');
    expect(unavailable.setPassword).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('Re-enter or confirm'));
  });

  it('does not put a URL password into the proxy key or overwrite a proxy credential', async () => {
    const global = new InMemoryMemento();
    await global.update(key, [{ ...profile, authMode: 'proxy' }]);
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    await secrets.setProxyApiKey(profile.id, 'saved proxy key');
    const store = new ProfileStore(global as never, new InMemoryMemento() as never, secrets);
    expect((await store.listProfiles())[0]?.serverUrl).toBe('https://fm.example.test');
    expect(await secrets.getPassword(profile.id)).toBeUndefined();
    expect(await secrets.getProxyApiKey(profile.id)).toBe('saved proxy key');
  });

  it('strips userinfo at the endpoint boundary without changing the requested name', () => {
    expect(buildEndpoint(profile, '/layouts/Exact%20Name%20')).toBe('https://fm.example.test/fmi/data/vLatest/databases/Sales/layouts/Exact%20Name%20');
  });

  it('preserves Bearer authorization even for a profile bypassing the store', async () => {
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    await secrets.setSessionToken(profile.id, 'session-fixture');
    const client = new FMClient(secrets, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    const request = nock('https://fm.example.test', { reqheaders: { authorization: 'Bearer session-fixture' } })
      .get('/fmi/data/vLatest/databases/Sales/layouts').reply(200, { response: { layouts: [] }, messages: [{ code: '0', message: 'OK' }] });
    await expect(client.listLayouts(profile)).resolves.toEqual([]);
    expect(request.isDone()).toBe(true);
  });
});
