import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { setRuntimeVersion } from '../../../src/about/runtimeVersion';
import * as csp from '../../../src/webviews/common/csp';
import { ConnectionWizardPanel } from '../../../src/webviews/connectionWizard';

const profile = {
  id: 'p1', name: 'Production', authMode: 'direct' as const,
  serverUrl: 'https://fm.example.com', database: 'Sales',
  apiBasePath: '/fmi/data', apiVersionPath: 'vLatest', username: 'alice'
};
const form = { ...profile, password: ' typed password ' };

function setup(editing = profile) {
  const events: string[] = [];
  const posted: Array<Record<string, unknown>> = [];
  const record = (event: string) => vi.fn<(...args: unknown[]) => Promise<void>>(async () => { events.push(event); });
  const webview = {
    html: '', cspSource: 'https://wizard.invalid',
    asWebviewUri: (uri: { fsPath: string }) => `https://wizard.invalid${uri.fsPath}`,
    onDidReceiveMessage: vi.fn<(handler: (message: unknown) => void) => void>(),
    postMessage: vi.fn(async (message: Record<string, unknown>) => {
      posted.push(message);
      events.push(String(message.type));
      return true;
    })
  };
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
    webview, onDidDispose: vi.fn(), reveal: vi.fn()
  } as never);
  (ConnectionWizardPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  const secrets = {
    getPassword: vi.fn(async () => 'saved password'),
    getProxyApiKey: vi.fn(async () => 'saved key'),
    setPassword: record('setPassword'), setProxyApiKey: record('setProxyApiKey'),
    deletePassword: record('deletePassword'), deleteProxyApiKey: record('deleteProxyApiKey'),
    deleteSessionToken: record('deleteSessionToken')
  };
  const client = {
    clearAuthPause: record('clearAuthPause'), invalidateProfileCache: record('invalidateProfileCache'),
    getProductInfo: vi.fn(async () => { events.push('product'); return { name: 'FileMaker Server', version: '21' }; }),
    listHostedDatabases: vi.fn(async () => { events.push('databases'); return ['Sales']; }),
    createSession: record('createSession'), deleteSession: record('deleteSession'),
    forgetProfile: record('forgetProfile')
  };
  const upsert = record('upsert');
  ConnectionWizardPanel.createOrShow(
    { extensionUri: vscode.Uri.file('/ext') } as never,
    { upsertProfile: upsert, listProfiles: vi.fn(async () => []) } as never,
    secrets as never, client as never,
    { warn: vi.fn() } as never, editing
  );
  // Call the registered receiver, then drain its fire-and-forget work without a timer or socket.
  const fire = async (message: unknown) => {
    webview.onDidReceiveMessage.mock.calls[0]?.[0](message);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return { events, posted, webview, secrets, client, upsert, fire };
}

describe('connection wizard extraction characterization', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders the HTML with the shared stylesheet, CSP, resource paths and footer', () => {
    const nonce = vi.spyOn(csp, 'createNonce').mockReturnValue('characterization-nonce');
    setRuntimeVersion('1.6.0');
    try {
      const { webview } = setup();
      // Includes the shared stylesheet link with a fixed nonce, version and resource root.
      expect(createHash('sha256').update(webview.html).digest('hex')).toBe('a6ddde597f95bac7601d4e25773e182131fc53798d821061dd5f60cf39c5f0e9');
    } finally {
      nonce.mockRestore();
    }
  });

  it('clears a moved pin and token before saving, then updates secrets in the original order', async () => {
    const h = setup({ ...profile, pinnedCertSha256: 'a'.repeat(64) } as typeof profile);
    await h.fire({ type: 'ready' });
    h.events.length = 0;
    await h.fire({ type: 'save', payload: { ...form, serverUrl: 'https://other.example.com' } });
    expect(h.events).toEqual([
      'certificateState', 'certificateNotice', 'deleteSessionToken', 'upsert',
      'clearAuthPause', 'invalidateProfileCache', 'setPassword', 'deleteProxyApiKey', 'saveSuccess'
    ]);
    expect(h.upsert).toHaveBeenCalledWith(expect.not.objectContaining({ pinnedCertSha256: expect.anything() }));
    expect(h.secrets.setPassword).toHaveBeenCalledWith('p1', ' typed password ');
  });

  it('keeps the Test Connection ladder, replies and throwaway cleanup in order', async () => {
    const h = setup();
    await h.fire({ type: 'testConnection', payload: form });
    expect(h.events).toEqual([
      'testStarted', 'testProgress', 'setPassword', 'testProgress', 'product',
      'testProgress', 'databases', 'testProgress', 'createSession', 'testProgress',
      'deleteSession', 'testSuccess', 'deletePassword', 'deleteProxyApiKey',
      'deleteSessionToken', 'forgetProfile'
    ]);
    const testId = h.secrets.setPassword.mock.calls[0]?.[0];
    expect(testId).toMatch(/^test-connection-/);
    expect(h.client.createSession).toHaveBeenCalledWith(expect.objectContaining({ id: testId }), { userInitiated: true });
    expect(h.secrets.deleteSessionToken).toHaveBeenCalledWith(testId);
    expect(h.posted.find((m) => m.type === 'testSuccess')?.message).toBe(
      'Connection successful. Session opened and closed cleanly. Server: FileMaker Server 21.'
    );
  });

  it('rejects overlong optional secrets before Save, Test or certificate review can act', async () => {
    const h = setup();
    for (const type of ['save', 'testConnection', 'reviewCertificate', 'convertLegacyCertificate']) {
      await h.fire({ type, payload: { ...form, password: 'x'.repeat(4097) } });
    }
    expect(h.posted).toEqual([
      { type: 'saveError', message: 'The form data was not valid.' },
      { type: 'testError', message: 'The form data was not valid.' },
      { type: 'saveError', message: 'The form data was not valid.' },
      { type: 'saveError', message: 'The form data was not valid.' }
    ]);
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.secrets.setPassword).not.toHaveBeenCalled();
  });
});
