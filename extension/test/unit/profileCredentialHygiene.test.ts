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

  it.each(['missing', 'read failure', 'write failure'])('retains persisted credentials on %s and warns once', async (failure) => {
    const global = new InMemoryMemento();
    await global.update(key, [profile]);
    const unavailable = {
      getPassword: failure === 'read failure' ? vi.fn().mockRejectedValue(new Error('unavailable')) : vi.fn().mockResolvedValue(undefined),
      setPassword: vi.fn().mockRejectedValue(new Error('unavailable'))
    };
    const store = new ProfileStore(global as never, new InMemoryMemento() as never, failure === 'missing' ? undefined : unavailable);
    expect((await store.listProfiles())[0]?.serverUrl).toBe('https://fm.example.test');
    expect(global.get(key)).toEqual([profile]);
    await store.listProfiles();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Re-enter or confirm'));
    if (failure !== 'missing') {
      unavailable.getPassword.mockResolvedValue(undefined);
      unavailable.setPassword.mockResolvedValue(undefined);
      await new ProfileStore(global as never, new InMemoryMemento() as never, unavailable).listProfiles();
      expect(global.get<Array<{ serverUrl: string }>>(key)?.[0]?.serverUrl).toBe('https://fm.example.test');
    }
  });

  it.each(['edit', 'replace', 'remove'])('preserves concurrent additions and a profile %s during secret storage', async (change) => {
    const global = new InMemoryMemento();
    const other = { ...profile, id: 'other', serverUrl: 'https://other.example.test' };
    const added = { ...other, id: 'added' };
    const edited = { ...profile, name: 'Edited', ...(change === 'replace' ? { serverUrl: 'https://new.example.test' } : {}) };
    await global.update(key, [profile, other]);
    let release!: () => void;
    const pendingWrite = new Promise<void>((resolve) => { release = resolve; });
    const secrets = { getPassword: vi.fn().mockResolvedValue(undefined), setPassword: vi.fn(() => pendingWrite) };
    const store = new ProfileStore(global as never, new InMemoryMemento() as never, secrets);
    const migration = store.listProfiles();
    await new Promise((resolve) => setImmediate(resolve));
    expect(secrets.setPassword).toHaveBeenCalledOnce();
    const current = [...(change === 'remove' ? [] : [edited]), other, added];
    await global.update(key, current);
    release();
    await migration;
    expect(global.get(key)).toEqual(current);
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
