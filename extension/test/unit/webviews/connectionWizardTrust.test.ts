import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { SecretStore } from '../../../src/services/secretStore';
import { ConnectionWizardPanel } from '../../../src/webviews/connectionWizard';
import { InMemorySecretStorage } from '../mocks';

/**
 * The wizard must never let saved credentials follow an edited address to a different server,
 * never touch a real profile's secrets while testing, and ask before sending credentials to
 * an address the workspace chose or to a remote http:// address.
 */

interface Harness {
  fire: (message: unknown) => Promise<void>;
  posted: Array<{ type?: string; message?: string }>;
  secrets: SecretStore;
  createSession: ReturnType<typeof vi.fn>;
  deleteSession: ReturnType<typeof vi.fn>;
  upsertProfile: ReturnType<typeof vi.fn>;
  passwordSeenByClient: Array<string | undefined>;
  profileIdsSeenByClient: string[];
}

const saved = {
  id: 'p1',
  name: 'Production',
  authMode: 'direct' as const,
  serverUrl: 'https://fm.example.com',
  database: 'Sales',
  apiBasePath: '/fmi/data',
  apiVersionPath: 'vLatest',
  username: 'alice'
};

const form = {
  name: 'Production',
  authMode: 'direct',
  serverUrl: 'https://fm.example.com',
  database: 'Sales',
  apiBasePath: '/fmi/data',
  apiVersionPath: 'vLatest',
  username: 'alice'
};

async function setup(options: { editing?: typeof saved; knownProfiles?: Array<Record<string, unknown>> } = {}): Promise<Harness> {
  const posted: Harness['posted'] = [];
  let handler: ((message: unknown) => unknown) | undefined;

  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
    webview: {
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: vi.fn((message: never) => {
        posted.push(message);
        return Promise.resolve(true);
      }),
      onDidReceiveMessage: (callback: (message: unknown) => unknown) => {
        handler = callback;
        return { dispose: vi.fn() };
      }
    },
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    reveal: vi.fn(),
    dispose: vi.fn()
  } as never);
  (ConnectionWizardPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;

  const secrets = new SecretStore(new InMemorySecretStorage() as never);
  let testSecrets = secrets;
  const passwordSeenByClient: Array<string | undefined> = [];
  const profileIdsSeenByClient: string[] = [];
  const createSession = vi.fn(async (profile: { id: string }) => {
    profileIdsSeenByClient.push(profile.id);
    passwordSeenByClient.push(await testSecrets.getPassword(profile.id));
    await testSecrets.setSessionToken(profile.id, 'token-from-test');
    return 'token-from-test';
  });
  const deleteSession = vi.fn(async () => undefined);
  const upsertProfile = vi.fn(async () => undefined);
  const profileStore = {
    upsertProfile,
    listProfiles: vi.fn(async () => options.knownProfiles ?? [])
  };
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const client = {
    createSession, deleteSession,
    getProductInfo: vi.fn(async () => ({ name: 'FileMaker Server', version: '21.0.1' })),
    listHostedDatabases: vi.fn(async () => undefined), forgetProfile: vi.fn()
  };
  Object.assign(client, { createIsolatedClient: (temporary: SecretStore) => { testSecrets = temporary; return client; } });

  ConnectionWizardPanel.createOrShow(
    { extensionUri: { fsPath: '/ext' }, extension: { id: 'x.y' } } as never,
    profileStore as never,
    secrets,
    client as never,
    logger as never,
    options.editing as never
  );

  return {
    fire: async (message) => {
      await handler?.(message);
      await new Promise((resolve) => setImmediate(resolve));
    },
    posted,
    secrets,
    createSession,
    deleteSession,
    upsertProfile,
    passwordSeenByClient,
    profileIdsSeenByClient
  };
}

const types = (h: Harness): Array<string | undefined> => h.posted.map((m) => m.type);
const lastMessage = (h: Harness, type: string): string | undefined =>
  [...h.posted].reverse().find((m) => m.type === type)?.message;

describe('Connection wizard credential safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (vscode.workspace.fs.readFile as unknown as ReturnType<typeof vi.fn>).mockRejectedValue({ code: 'FileNotFound' });
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined as never);
  });

  describe('editing a saved profile', () => {
    it('refuses to save a changed server address without the password being typed again', async () => {
      const h = await setup({ editing: saved });
      await h.secrets.setPassword('p1', 'saved-secret');

      await h.fire({ type: 'save', payload: { ...form, serverUrl: 'https://other-host.example.net' } });

      expect(lastMessage(h, 'saveError')).toMatch(/Enter the password again/);
      expect(h.upsertProfile).not.toHaveBeenCalled();
      expect(await h.secrets.getPassword('p1')).toBe('saved-secret');
    });

    it('refuses to save a changed user name without the password', async () => {
      const h = await setup({ editing: saved });
      await h.fire({ type: 'save', payload: { ...form, username: 'mallory' } });
      expect(types(h)).toContain('saveError');
      expect(h.upsertProfile).not.toHaveBeenCalled();
    });

    it('saves a changed address when the password is typed, and drops the old session token', async () => {
      const h = await setup({ editing: saved });
      await h.secrets.setPassword('p1', 'saved-secret');
      await h.secrets.setSessionToken('p1', 'old-host-token');

      await h.fire({ type: 'save', payload: { ...form, serverUrl: 'https://new.example.com', password: 'typed-again' } });

      expect(h.upsertProfile).toHaveBeenCalledTimes(1);
      expect(await h.secrets.getPassword('p1')).toBe('typed-again');
      expect(await h.secrets.getSessionToken('p1')).toBeUndefined();
    });

    it('keeps the saved password and session when only unrelated fields change', async () => {
      const h = await setup({ editing: saved });
      await h.secrets.setPassword('p1', 'saved-secret');
      await h.secrets.setSessionToken('p1', 'still-valid');

      await h.fire({ type: 'save', payload: { ...form, name: 'Renamed', database: 'Other' } });

      expect(types(h)).toContain('saveSuccess');
      expect(await h.secrets.getPassword('p1')).toBe('saved-secret');
      expect(await h.secrets.getSessionToken('p1')).toBe('still-valid');
    });

    it('tests with the saved password under a throwaway id and leaves the profile untouched', async () => {
      const h = await setup({ editing: saved });
      await h.secrets.setPassword('p1', 'saved-secret');
      await h.secrets.setSessionToken('p1', 'live-token');

      await h.fire({ type: 'testConnection', payload: form });

      expect(types(h)).toContain('testSuccess');
      expect(h.profileIdsSeenByClient[0]).toMatch(/^test-connection-/);
      expect(h.passwordSeenByClient[0]).toBe('saved-secret');
      expect(await h.secrets.getPassword('p1')).toBe('saved-secret');
      expect(await h.secrets.getSessionToken('p1')).toBe('live-token');
      expect(await h.secrets.getPassword(h.profileIdsSeenByClient[0]!)).toBeUndefined();
      expect(await h.secrets.getSessionToken(h.profileIdsSeenByClient[0]!)).toBeUndefined();
    });

    it('does not send the saved password to a changed address when testing', async () => {
      const h = await setup({ editing: saved });
      await h.secrets.setPassword('p1', 'saved-secret');

      await h.fire({ type: 'testConnection', payload: { ...form, serverUrl: 'https://attacker.example' } });

      expect(lastMessage(h, 'testError')).toMatch(/changed/);
      expect(h.createSession).not.toHaveBeenCalled();
    });

    it('never overwrites the saved password with a typed one just by testing', async () => {
      const h = await setup({ editing: saved });
      await h.secrets.setPassword('p1', 'saved-secret');

      await h.fire({ type: 'testConnection', payload: { ...form, password: 'typed-but-not-saved' } });

      expect(h.passwordSeenByClient[0]).toBe('typed-but-not-saved');
      expect(await h.secrets.getPassword('p1')).toBe('saved-secret');
    });
  });

  describe('a new profile', () => {
    it('tests with a typed password that is not kept afterwards', async () => {
      const h = await setup();
      await h.fire({ type: 'testConnection', payload: { ...form, password: 'typed' } });

      expect(types(h)).toContain('testSuccess');
      expect(h.passwordSeenByClient).toEqual(['typed']);
      expect(await h.secrets.getPassword(h.profileIdsSeenByClient[0]!)).toBeUndefined();
    });

    it('asks for a password instead of calling the server without one', async () => {
      const h = await setup();
      await h.fire({ type: 'testConnection', payload: form });
      expect(lastMessage(h, 'testError')).toMatch(/Enter a password/);
      expect(h.createSession).not.toHaveBeenCalled();
    });
  });

  describe('addresses chosen by the workspace', () => {
    const templateFile = {
      name: 'Team',
      authMode: 'direct',
      serverUrl: 'https://attacker.example',
      database: 'Sales',
      username: 'alice'
    };
    const loadTemplate = async (h: Harness): Promise<void> => {
      await h.fire({ type: 'ready' });
    };
    const useTemplate = (): void => {
      (vscode.workspace.fs.readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        Buffer.from(JSON.stringify(templateFile))
      );
    };

    it('names the template address on the page', async () => {
      useTemplate();
      const h = await setup();
      await loadTemplate(h);
      const loaded = h.posted.find((m) => m.type === 'loadTemplate') as unknown as { payload: { hosts: string[]; lockedFields: string[] } };
      expect(loaded.payload.hosts).toEqual(['https://attacker.example']);
      expect(loaded.payload.lockedFields).not.toContain('serverUrl');
    });

    it('asks before testing against the template address, and stops if declined', async () => {
      useTemplate();
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);
      const h = await setup();
      await loadTemplate(h);

      await h.fire({ type: 'testConnection', payload: { ...form, serverUrl: 'https://attacker.example', password: 'real-password' } });

      const prompt = vi.mocked(vscode.window.showWarningMessage).mock.calls[0]?.[0] as string;
      expect(prompt).toContain('https://attacker.example');
      expect(prompt).toContain('workspace file');
      expect(h.createSession).not.toHaveBeenCalled();
      expect(lastMessage(h, 'testError')).toMatch(/cancelled/);
    });

    it('asks before saving the template address, and does not save if declined', async () => {
      useTemplate();
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);
      const h = await setup();
      await loadTemplate(h);

      await h.fire({ type: 'save', payload: { ...form, serverUrl: 'https://attacker.example', password: 'real-password' } });

      expect(h.upsertProfile).not.toHaveBeenCalled();
      expect(types(h)).toContain('saveError');
    });

    it('proceeds when the user confirms', async () => {
      useTemplate();
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Continue' as never);
      const h = await setup();
      await loadTemplate(h);

      await h.fire({ type: 'testConnection', payload: { ...form, serverUrl: 'https://attacker.example', password: 'pw' } });

      expect(h.createSession).toHaveBeenCalledTimes(1);
    });

    it('does not ask again for an address the user already has a profile for', async () => {
      useTemplate();
      const h = await setup({ knownProfiles: [{ ...saved, serverUrl: 'https://attacker.example' }] });
      await loadTemplate(h);

      await h.fire({ type: 'testConnection', payload: { ...form, serverUrl: 'https://attacker.example', password: 'pw' } });

      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(h.createSession).toHaveBeenCalledTimes(1);
    });

    it('does not ask for an address the user typed themselves', async () => {
      useTemplate();
      const h = await setup();
      await loadTemplate(h);

      await h.fire({ type: 'testConnection', payload: { ...form, serverUrl: 'https://my-own-server.example.com', password: 'pw' } });

      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });
  });

  describe('proxy mode', () => {
    const proxyForm = {
      ...form,
      authMode: 'proxy',
      serverUrl: 'https://backend.example.com',
      proxyEndpoint: 'https://proxy.example.com/api',
      username: undefined
    };
    const savedProxy = {
      ...saved,
      authMode: 'proxy' as const,
      serverUrl: 'https://backend.example.com',
      proxyEndpoint: 'https://proxy.example.com/api',
      username: undefined
    };

    it('also asks about a backend address chosen by the workspace when the proxy is already known', async () => {
      (vscode.workspace.fs.readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        Buffer.from(
          JSON.stringify({
            authMode: 'proxy',
            serverUrl: 'https://attacker.example',
            proxyEndpoint: 'https://proxy.example.com/api',
            database: 'Sales'
          })
        )
      );
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);
      const h = await setup({ knownProfiles: [savedProxy] });
      await h.fire({ type: 'ready' });

      await h.fire({
        type: 'testConnection',
        payload: { ...proxyForm, serverUrl: 'https://attacker.example', proxyApiKey: 'key' }
      });

      expect(vi.mocked(vscode.window.showWarningMessage).mock.calls[0]?.[0]).toContain('https://attacker.example');
      expect(h.createSession).not.toHaveBeenCalled();
    });

    it('requires the API key again when only the backend address of a saved proxy profile changes', async () => {
      const h = await setup({ editing: savedProxy as never });
      await h.fire({ type: 'save', payload: { ...proxyForm, serverUrl: 'https://other-backend.example.com' } });
      expect(lastMessage(h, 'saveError')).toMatch(/Enter the proxy API key again/);
      expect(h.upsertProfile).not.toHaveBeenCalled();
    });
  });

  describe('saving order', () => {
    it('drops the old session token before the profile points at the new address', async () => {
      const h = await setup({ editing: saved });
      const dropToken = vi.spyOn(h.secrets, 'deleteSessionToken');

      await h.fire({ type: 'save', payload: { ...form, serverUrl: 'https://new.example.com', password: 'typed' } });

      expect(dropToken.mock.invocationCallOrder[0]).toBeLessThan(h.upsertProfile.mock.invocationCallOrder[0]!);
    });
  });

  describe('cleartext http', () => {
    it('warns before using a remote http address and stops if declined', async () => {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);
      const h = await setup();

      await h.fire({ type: 'testConnection', payload: { ...form, serverUrl: 'http://fm.example.com', password: 'pw' } });

      expect(vi.mocked(vscode.window.showWarningMessage).mock.calls[0]?.[0]).toMatch(/unencrypted/);
      expect(h.createSession).not.toHaveBeenCalled();
    });

    it('goes ahead when the user accepts the warning', async () => {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Continue anyway' as never);
      const h = await setup();
      await h.fire({ type: 'testConnection', payload: { ...form, serverUrl: 'http://fm.example.com', password: 'pw' } });
      expect(h.createSession).toHaveBeenCalledTimes(1);
    });

    it('does not warn for http on this machine', async () => {
      const h = await setup();
      await h.fire({ type: 'testConnection', payload: { ...form, serverUrl: 'http://127.0.0.1:18080', password: 'pw' } });
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(h.createSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('form data from the page', () => {
    it('rejects a form with the wrong shape', async () => {
      const h = await setup();
      await h.fire({ type: 'save', payload: { ...form, serverUrl: 42 } });
      await h.fire({ type: 'testConnection', payload: { ...form, authMode: 'ssh' } });
      expect(types(h)).toEqual(expect.arrayContaining(['saveError', 'testError']));
      expect(h.upsertProfile).not.toHaveBeenCalled();
      expect(h.createSession).not.toHaveBeenCalled();
    });

    it('rejects an address with a password in it and an invalid proxy endpoint', async () => {
      const h = await setup();
      await h.fire({ type: 'save', payload: { ...form, serverUrl: 'https://admin:pw@fm.example.com' } });
      expect(lastMessage(h, 'saveError')).toMatch(/must not contain a username or password/);

      await h.fire({ type: 'save', payload: { ...form, authMode: 'proxy', proxyEndpoint: 'not a url', proxyApiKey: 'k' } });
      expect(lastMessage(h, 'saveError')).toMatch(/Proxy endpoint/);
      expect(h.upsertProfile).not.toHaveBeenCalled();
    });
  });
});

describe('wizard certificate address binding', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(['https://other.example.com', 'https://fm.example.com:8443'])('clears a saved pin on address change to %s and does not restore it on return', async (serverUrl) => {
    const h = await setup({ editing: { ...saved, pinnedCertSha256: 'a'.repeat(64) } as typeof saved });
    await h.fire({ type: 'ready' });
    await h.fire({ type: 'addressChanged', payload: { ...form, serverUrl } });
    const states = h.posted.filter((m) => m.type === 'certificateState') as Array<{ payload: { pin?: unknown } }>;
    expect(states.at(-1)?.payload.pin).toBeUndefined();
    expect(lastMessage(h, 'certificateNotice')).toMatch(/trusted certificate was cleared/);
    await h.fire({ type: 'addressChanged', payload: form });
    await h.fire({ type: 'save', payload: { ...form, password: 'typed' } });
    expect(h.upsertProfile).toHaveBeenCalledWith(expect.not.objectContaining({ pinnedCertSha256: expect.anything() }));
  });
  it('clears the pin even if a changed address arrives only with Save', async () => {
    const h = await setup({ editing: { ...saved, pinnedCertSha256: 'a'.repeat(64) } as typeof saved });
    await h.fire({ type: 'ready' });
    await h.fire({ type: 'save', payload: { ...form, serverUrl: 'https://other.example.com', password: 'typed' } });
    expect(h.upsertProfile).toHaveBeenCalledWith(expect.not.objectContaining({ pinnedCertSha256: expect.anything() }));
  });
  it('also clears a proxy profile pin when its backend server address changes', async () => {
    const proxy = { ...saved, authMode: 'proxy', proxyEndpoint: 'https://proxy.example.com/api', pinnedCertSha256: 'a'.repeat(64) };
    const h = await setup({ editing: proxy as typeof saved });
    await h.fire({ type: 'ready' });
    await h.fire({ type: 'addressChanged', payload: { ...form, authMode: 'proxy', proxyEndpoint: proxy.proxyEndpoint, serverUrl: 'https://other.example.com' } });
    expect(lastMessage(h, 'certificateNotice')).toMatch(/trusted certificate was cleared/);
    const state = h.posted.filter((m) => m.type === 'certificateState').at(-1) as { payload: { pin?: unknown } };
    expect(state.payload.pin).toBeUndefined();
  });

});
