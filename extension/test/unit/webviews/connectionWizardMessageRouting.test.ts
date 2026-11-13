import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionWizardPanel } from '../../../src/webviews/connectionWizard';

/**
 * Which message of the Connection Wizard reaches which service, what the panel answers, and what
 * it refuses. The panel is not changed here: every expectation reads what the code does today.
 */

type Handler = (message: unknown) => void;

const profile = {
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
  username: 'alice',
  password: 'secret',
  proxyEndpoint: '',
  proxyApiKey: '',
  caBundlePath: ''
};

const pinnedSha256 = 'a'.repeat(64);

/** Lets every pending promise of the panel settle before the expectations run. */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

interface Overrides {
  editingProfile?: Record<string, unknown>;
  getPassword?: () => Promise<unknown>;
}

function open(overrides: Overrides = {}) {
  let handler: Handler | undefined;
  let onDispose: (() => void) | undefined;
  const posted: Array<Record<string, unknown>> = [];
  const reveal = vi.fn();

  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
    webview: {
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: vi.fn(async (message: Record<string, unknown>) => {
        posted.push(message);
        return true;
      }),
      onDidReceiveMessage: (callback: Handler) => {
        handler = callback;
        return { dispose: vi.fn() };
      }
    },
    reveal,
    onDidDispose: (callback: () => void) => {
      onDispose = callback;
      return { dispose: vi.fn() };
    }
  } as never);

  const profileStore = {
    listProfiles: vi.fn(async () => [profile]),
    upsertProfile: vi.fn(async (saved: Record<string, unknown>) => saved)
  };
  const secretStore = {
    getPassword: vi.fn(overrides.getPassword ?? (async () => 'stored password')),
    getProxyApiKey: vi.fn(async () => undefined),
    setPassword: vi.fn(async () => undefined),
    setProxyApiKey: vi.fn(async () => undefined),
    deletePassword: vi.fn(async () => undefined),
    deleteProxyApiKey: vi.fn(async () => undefined),
    deleteSessionToken: vi.fn(async () => undefined)
  };
  const fmClient = {
    getProductInfo: vi.fn(async () => ({ name: 'FileMaker Server', version: '21' })),
    listHostedDatabases: vi.fn(async () => ['Sales']),
    createSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    forgetProfile: vi.fn(),
    clearAuthPause: vi.fn(),
    invalidateProfileCache: vi.fn()
  };
  Object.assign(fmClient, { createIsolatedClient: vi.fn(() => fmClient) });
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

  (ConnectionWizardPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  ConnectionWizardPanel.createOrShow(
    { extensionUri: { fsPath: '/ext' } } as never,
    profileStore as never,
    secretStore as never,
    fmClient as never,
    logger as never,
    ('editingProfile' in overrides ? overrides.editingProfile : profile) as never
  );

  const send = async (message: unknown): Promise<void> => {
    handler?.(message);
    await flush();
  };

  return {
    send,
    posted,
    reveal,
    profileStore,
    secretStore,
    fmClient,
    logger,
    close: () => onDispose?.()
  };
}

describe('Connection Wizard: message routing', () => {
  let panel: ReturnType<typeof open>;

  beforeEach(() => {
    vi.clearAllMocks();
    panel = open();
  });

  afterEach(() => {
    panel.close();
    (ConnectionWizardPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  });

  describe('every message reaches its handler', () => {
    it('answers "ready" with the init state and the profile being edited', async () => {
      await panel.send({ type: 'ready' });

      expect(panel.posted).toContainEqual({ type: 'init', testPolicy: 'warn', restricted: false });
      expect(panel.posted).toContainEqual({ type: 'loadProfile', payload: profile, hasPassword: true });
      expect(panel.secretStore.getPassword).toHaveBeenCalledWith('p1');
    });

    it('asks VS Code to open the workspace trust manager for "manageWorkspaceTrust"', async () => {
      await panel.send({ type: 'manageWorkspaceTrust' });

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.trust.manage');
      expect(panel.posted).toEqual([]);
    });

    it('saves the profile for "save"', async () => {
      await panel.send({ type: 'save', payload: form });

      expect(panel.profileStore.upsertProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'p1',
          name: 'Production',
          authMode: 'direct',
          serverUrl: 'https://fm.example.com',
          database: 'Sales',
          username: 'alice'
        })
      );
      expect(panel.secretStore.setPassword).toHaveBeenCalledWith('p1', 'secret');
      expect(panel.secretStore.deleteProxyApiKey).toHaveBeenCalledWith('p1');
      expect(panel.posted).toContainEqual({ type: 'saveSuccess', message: 'Profile "Production" saved.' });
    });

    it('refuses a "save" whose form the host cannot use', async () => {
      await panel.send({ type: 'save', payload: { name: 'Production' } });

      expect(panel.posted).toContainEqual({ type: 'saveError', message: 'The form data was not valid.' });
      expect(panel.profileStore.upsertProfile).not.toHaveBeenCalled();
      expect(panel.secretStore.setPassword).not.toHaveBeenCalled();
    });

    it.each(['reviewCertificate', 'convertLegacyCertificate'])(
      'sends "%s" to the certificate review, which refuses an address it cannot use',
      async (type) => {
        await panel.send({ type, payload: { ...form, serverUrl: 'not a url' } });

        expect(panel.posted).toContainEqual({ type: 'saveError', message: 'Server URL is invalid.' });
      }
    );

    it('clears the pinned certificate for "addressChanged" when the address changed', async () => {
      panel.close();
      panel = open({ editingProfile: { ...profile, pinnedCertSha256: pinnedSha256 } });
      await panel.send({ type: 'ready' });

      await panel.send({ type: 'addressChanged', payload: { serverUrl: 'https://other.example.com' } });

      expect(panel.posted).toContainEqual({ type: 'certificateState', payload: { pin: undefined, legacy: false } });
      expect(panel.posted).toContainEqual({
        type: 'certificateNotice',
        message:
          'The server address changed. The trusted certificate was cleared. Review the certificate for this address before trusting it.'
      });
    });

    it('keeps the pinned certificate for "addressChanged" when the address did not change', async () => {
      panel.close();
      panel = open({ editingProfile: { ...profile, pinnedCertSha256: pinnedSha256 } });
      await panel.send({ type: 'ready' });
      const before = panel.posted.length;

      await panel.send({ type: 'addressChanged', payload: { serverUrl: 'https://fm.example.com' } });

      expect(panel.posted.slice(before)).toEqual([]);
    });

    it('forgets the pinned certificate for "forgetCertificate"', async () => {
      panel.close();
      panel = open({ editingProfile: { ...profile, pinnedCertSha256: pinnedSha256 } });
      await panel.send({ type: 'ready' });
      expect(panel.posted).toContainEqual({
        type: 'certificateState',
        payload: { pin: { sha256: pinnedSha256, allowExpired: false }, legacy: false }
      });

      await panel.send({ type: 'forgetCertificate' });

      expect(panel.posted).toContainEqual({ type: 'certificateState', payload: { pin: undefined, legacy: false } });
    });

    it('stops skipping certificate checks for "stopSkippingCertificateChecks"', async () => {
      panel.close();
      panel = open({ editingProfile: { ...profile, allowSelfSigned: true } });
      await panel.send({ type: 'ready' });
      expect(panel.posted).toContainEqual({ type: 'certificateState', payload: { pin: undefined, legacy: true } });

      await panel.send({ type: 'stopSkippingCertificateChecks' });

      expect(panel.posted).toContainEqual({ type: 'certificateState', payload: { pin: undefined, legacy: false } });
    });

    it('runs the connection test for "testConnection"', async () => {
      await panel.send({ type: 'testConnection', payload: form });

      expect(panel.posted).toContainEqual({ type: 'testStarted', timeoutMs: 15_000 });
      expect(panel.fmClient.getProductInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Production',
          serverUrl: 'https://fm.example.com',
          database: 'Sales'
        })
      );
      expect(panel.fmClient.createSession).toHaveBeenCalledWith(expect.anything(), { userInitiated: true });
      expect(panel.posted).toContainEqual({
        type: 'testSuccess',
        message: 'Connection successful. Session opened and closed cleanly. Server: FileMaker Server 21.'
      });
    });

    it('refuses a "testConnection" whose form the host cannot use', async () => {
      await panel.send({ type: 'testConnection', payload: { name: 'Production' } });

      expect(panel.posted).toContainEqual({ type: 'testError', message: 'The form data was not valid.' });
      expect(panel.fmClient.getProductInfo).not.toHaveBeenCalled();
    });
  });

  describe('a message the panel cannot use is ignored', () => {
    it('ignores a message of an unknown type: nothing is posted and no service is called', async () => {
      await panel.send({ type: 'somethingElse', payload: { name: 'Production' } });

      expect(panel.posted).toEqual([]);
      expect(panel.profileStore.listProfiles).not.toHaveBeenCalled();
      expect(panel.profileStore.upsertProfile).not.toHaveBeenCalled();
      expect(panel.secretStore.getPassword).not.toHaveBeenCalled();
      expect(panel.fmClient.getProductInfo).not.toHaveBeenCalled();
      expect(panel.logger.error).not.toHaveBeenCalled();
    });

    it('ignores a message that is not an object', async () => {
      for (const message of [null, 'ready', 42]) {
        await panel.send(message);
      }

      expect(panel.posted).toEqual([]);
      expect(panel.profileStore.listProfiles).not.toHaveBeenCalled();
    });
  });

  describe('a failure is posted to the webview as an error', () => {
    it('reports a failure inside the request in the panel error shape', async () => {
      panel.close();
      panel = open({
        getPassword: async () => {
          throw new Error('The stored password could not be read.');
        }
      });

      await panel.send({ type: 'ready' });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'The stored password could not be read.' });
      expect(panel.logger.error).toHaveBeenCalledWith('Connection wizard request failed.', {
        type: 'ready',
        error: expect.any(Error)
      });
    });

    it('reports a failure that is not an Error with a plain reason', async () => {
      panel.close();
      panel = open({
        getPassword: async () => {
          throw 'the socket closed';
        }
      });

      await panel.send({ type: 'ready' });

      expect(panel.posted).toContainEqual({
        type: 'error',
        message: 'Unexpected error in the connection wizard.'
      });
    });

    it('writes the failure to the log when the page cannot be told about it', async () => {
      const postMessage = vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)?.value.webview
        .postMessage as ReturnType<typeof vi.fn>;
      postMessage.mockRejectedValue(new Error('The webview is gone.'));

      await panel.send({ type: 'ready' });

      expect(panel.logger.error).toHaveBeenCalledWith('Connection wizard request failed.', expect.anything());
      expect(panel.logger.error).toHaveBeenCalledWith(
        'Could not post the Connection wizard request failure to the page.',
        expect.anything()
      );
    });
  });

  describe('the panel is opened once and reused', () => {
    it('reveals the open panel and sends the new profile instead of opening a second one', async () => {
      await panel.send({ type: 'ready' });
      const before = panel.posted.length;
      const other = { ...profile, id: 'p2', name: 'Staging' };

      ConnectionWizardPanel.createOrShow(
        { extensionUri: { fsPath: '/ext' } } as never,
        panel.profileStore as never,
        panel.secretStore as never,
        panel.fmClient as never,
        panel.logger as never,
        other as never
      );
      await flush();

      expect(vi.mocked(vscode.window.createWebviewPanel)).toHaveBeenCalledTimes(1);
      expect(panel.reveal).toHaveBeenCalledTimes(1);
      expect(panel.posted.slice(before)).toContainEqual({ type: 'loadProfile', payload: other, hasPassword: true });
    });

    it('sends the init state again when the workspace is trusted', async () => {
      const listener = vi.mocked(vscode.workspace.onDidGrantWorkspaceTrust).mock.calls.at(-1)?.[0];
      expect(listener).toBeTypeOf('function');

      listener?.();
      await flush();

      expect(panel.posted).toContainEqual({ type: 'init', testPolicy: 'warn', restricted: false });
    });

    it('stops listening and lets the next request open a new panel', async () => {
      const trustListener = vi.mocked(vscode.workspace.onDidGrantWorkspaceTrust).mock.results.at(-1)?.value as {
        dispose: ReturnType<typeof vi.fn>;
      };

      panel.close();

      expect(trustListener.dispose).toHaveBeenCalled();
      ConnectionWizardPanel.createOrShow(
        { extensionUri: { fsPath: '/ext' } } as never,
        panel.profileStore as never,
        panel.secretStore as never,
        panel.fmClient as never,
        panel.logger as never,
        profile as never
      );
      expect(vi.mocked(vscode.window.createWebviewPanel)).toHaveBeenCalledTimes(2);
    });
  });
});
