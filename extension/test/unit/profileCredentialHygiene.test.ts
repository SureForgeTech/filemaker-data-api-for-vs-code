import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['missing', 'read failure', 'write failure'])(
    'keeps same-id edits and the recoverable password with %s secret storage', async (failure) => {
      const global = new InMemoryMemento();
      const other = { ...profile, id: 'other', serverUrl: 'https://other.example.test' };
      await global.update(key, [profile, other]);
      const secrets = new SecretStore(new InMemorySecretStorage() as never);
      if (failure === 'read failure') vi.spyOn(secrets, 'getPassword').mockRejectedValue(new Error('unavailable'));
      if (failure === 'write failure') vi.spyOn(secrets, 'setPassword').mockRejectedValue(new Error('unavailable'));
      const store = new ProfileStore(global as never, new InMemoryMemento() as never, failure === 'missing' ? undefined : secrets);
      const [visible] = await store.listProfiles();
      const edited = { ...visible!, pinnedCertSha256: 'ab'.repeat(32), aiAccess: 'read' as const };

      await expect(store.upsertProfile(edited)).resolves.toBeUndefined();
      const saved = { ...edited, serverUrl: profile.serverUrl };
      expect(global.get(key)).toEqual([saved, other]);
      await store.removeProfile(other.id);
      expect(global.get(key)).toEqual([saved]);
      expect(vscode.window.showWarningMessage).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Re-enter or confirm'));
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();

      vi.restoreAllMocks();
      const recovered = new ProfileStore(global as never, new InMemoryMemento() as never, secrets);
      await recovered.upsertProfile(edited);
      expect(await secrets.getPassword(profile.id)).toBe('url password');
      expect(global.get(key)).toEqual([edited]);
    }
  );

  it('retains every unmigrated duplicate until storage works, then replaces them with one edited profile', async () => {
    const global = new InMemoryMemento();
    const duplicate = { ...profile, name: 'Duplicate', serverUrl: 'https://other-user:other-password@fm.example.test' };
    const other = { ...profile, id: 'other', serverUrl: 'https://other.example.test' };
    await global.update(key, [profile, other, duplicate]);
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    const write = vi.spyOn(secrets, 'setPassword').mockRejectedValue(new Error('unavailable'));
    const store = new ProfileStore(global as never, new InMemoryMemento() as never, secrets);
    const edited = { ...store.listProfilesSync()[0]!, aiAccess: 'write' as const };

    await store.upsertProfile(edited);
    const retained = { ...edited, serverUrl: profile.serverUrl };
    expect(global.get(key)).toEqual([retained, other, { ...edited, serverUrl: duplicate.serverUrl }]);
    write.mockRestore();
    await store.upsertProfile(edited);
    expect(await secrets.getPassword(profile.id)).toBe('url password');
    expect(global.get(key)).toEqual([edited, other]);
  });

  it.each(['first read', 'second read', 'write', 'confirmation read'].flatMap((hungOperation) =>
    ['edit', 'remove'].map((action) => ({ hungOperation, action }))
  ))(
    'finishes $action after five seconds when the migration $hungOperation hangs', async ({ hungOperation, action }) => {
      vi.useFakeTimers();
      const global = new InMemoryMemento();
      const other = { ...profile, id: 'other', serverUrl: 'https://other.example.test' };
      await global.update(key, [profile, other]);
      const pending = new Promise<never>(() => {});
      const getPassword = vi.fn().mockResolvedValue(undefined);
      const setPassword = vi.fn().mockResolvedValue(undefined);
      if (hungOperation === 'first read') getPassword.mockImplementation(() => pending);
      if (hungOperation === 'second read') getPassword.mockResolvedValueOnce(undefined).mockImplementation(() => pending);
      if (hungOperation === 'write') setPassword.mockImplementation(() => pending);
      if (hungOperation === 'confirmation read') {
        getPassword.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockImplementation(() => pending);
      }
      const store = new ProfileStore(global as never, new InMemoryMemento() as never, { getPassword, setPassword });
      const edited = { ...store.listProfilesSync()[0]!, aiAccess: 'read' as const };
      let completed = false;
      const operation = action === 'edit' ? store.upsertProfile(edited) : store.removeProfile(other.id);
      const write = operation.then(() => { completed = true; });

      await vi.advanceTimersByTimeAsync(4999);
      expect(completed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(completed).toBe(true);
      await write;
      expect(global.get(key)).toEqual(action === 'edit' ? [{ ...edited, serverUrl: profile.serverUrl }, other] : [profile]);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('retains credentials when password persistence is disabled', async () => {
    const global = new InMemoryMemento();
    await global.update(key, [profile]);
    const secrets = new SecretStore(new InMemorySecretStorage() as never, { fallbackMode: 'disabled' });
    const store = new ProfileStore(global as never, new InMemoryMemento() as never, secrets);
    const edited = { ...store.listProfilesSync()[0]!, aiAccess: 'read' as const };
    await store.upsertProfile(edited);
    expect(global.get(key)).toEqual([{ ...edited, serverUrl: profile.serverUrl }]);
    expect(await secrets.getPassword(profile.id)).toBeUndefined();
  });

  it('does not resume a timed-out read and overwrite a password saved afterwards', async () => {
    vi.useFakeTimers();
    const global = new InMemoryMemento();
    await global.update(key, [profile]);
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    let release!: () => void;
    const pending = new Promise<undefined>((resolve) => { release = () => resolve(undefined); });
    vi.spyOn(secrets, 'getPassword').mockImplementationOnce(() => pending);
    const write = vi.spyOn(secrets, 'setPassword');
    const store = new ProfileStore(global as never, new InMemoryMemento() as never, secrets);
    const edited = { ...store.listProfilesSync()[0]!, aiAccess: 'read' as const };
    const upsert = store.upsertProfile(edited);
    await vi.advanceTimersByTimeAsync(5000);
    await upsert;
    await secrets.setPassword(profile.id, 'newer password');
    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(write).toHaveBeenCalledExactlyOnceWith(profile.id, 'newer password');
    expect(global.get(key)).toEqual([{ ...edited, serverUrl: profile.serverUrl }]);
    await store.upsertProfile(edited);
    expect(global.get(key)).toEqual([edited]);
    expect(await secrets.getPassword(profile.id)).toBe('newer password');
    expect(vi.getTimerCount()).toBe(0);
  });

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
      unavailable.setPassword.mockImplementation(async () => {
        unavailable.getPassword.mockResolvedValue('url password');
      });
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
    const getPassword = vi.fn().mockResolvedValue(undefined);
    const secrets = { getPassword, setPassword: vi.fn(async () => {
      await pendingWrite;
      getPassword.mockResolvedValue('url password');
    }) };
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

  it.each(['missing', 'write failure'])('preserves unmigrated credentials across unrelated writes with %s secret storage', async (failure) => {
    const global = new InMemoryMemento();
    const other = { ...profile, id: 'other', serverUrl: 'https://other.example.test' };
    const removed = { ...other, id: 'removed' };
    const added = { ...other, id: 'added' };
    await global.update(key, [profile, other, removed]);
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    const write = vi.spyOn(secrets, 'setPassword').mockRejectedValue(new Error('unavailable'));
    const store = new ProfileStore(global as never, new InMemoryMemento() as never, failure === 'missing' ? undefined : secrets);

    await store.listProfiles();
    await store.upsertProfile(added);
    expect(global.get(key)).toEqual([profile, other, removed, added]);
    const edited = { ...other, name: 'Edited' };
    await store.upsertProfile(edited);
    expect(global.get(key)).toEqual([profile, edited, removed, added]);
    await store.removeProfile(removed.id);
    expect(global.get(key)).toEqual([profile, edited, added]);

    write.mockRestore();
    await new ProfileStore(global as never, new InMemoryMemento() as never, secrets).listProfiles();
    expect(await secrets.getPassword(profile.id)).toBe('url password');
    expect(global.get<Array<{ serverUrl: string }>>(key)?.[0]?.serverUrl).toBe('https://fm.example.test');
  });

  it.each(['', 'wizard password'])('preserves a password saved while migration is reading secrets (%s)', async (password) => {
    const global = new InMemoryMemento();
    await global.update(key, [profile]);
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    let release!: () => void;
    const staleRead = new Promise<undefined>((resolve) => { release = () => resolve(undefined); });
    vi.spyOn(secrets, 'getPassword').mockImplementationOnce(() => staleRead);
    const write = vi.spyOn(secrets, 'setPassword');
    const store = new ProfileStore(global as never, new InMemoryMemento() as never, secrets);

    const migration = store.listProfiles();
    await secrets.setPassword(profile.id, password);
    release();
    await migration;

    expect(await secrets.getPassword(profile.id)).toBe(password);
    expect(write).toHaveBeenCalledExactlyOnceWith(profile.id, password);
    expect(global.get<Array<{ serverUrl: string }>>(key)?.[0]?.serverUrl).toBe('https://fm.example.test');
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
    expect(global.get(key)).toEqual([{ ...profile, authMode: 'proxy' }]);
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
