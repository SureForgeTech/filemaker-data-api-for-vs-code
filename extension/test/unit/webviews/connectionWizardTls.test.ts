import { readFileSync } from 'fs';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { FMClientError } from '../../../src/services/errors';
import { SecretStore } from '../../../src/services/secretStore';
import { ConnectionWizardPanel } from '../../../src/webviews/connectionWizard';
import { JSDOM, loadPage } from '../../helpers/jsdomPage';
import { DAY, makeCertificate, newKeyPair } from '../../helpers/x509';
import { InMemorySecretStorage } from '../mocks';

const review = vi.hoisted(() => ({ decision: undefined as unknown, calls: [] as unknown[][] }));
vi.mock('../../../src/services/certificateTrust', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    reviewAndTrustCertificate: vi.fn(async (...args: unknown[]) => {
      review.calls.push(args);
      return review.decision;
    })
  };
});

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
  username: 'alice',
  password: 'pw'
};

const PIN = 'ab'.repeat(32);
const CERT = makeCertificate({ subjectCn: 'ca', notBefore: new Date(Date.now() - DAY), notAfter: new Date(Date.now() + DAY), subjectKey: newKeyPair() }).pem;

type Posted = { type?: string; message?: string; payload?: Record<string, unknown> };

async function setup(editing?: Record<string, unknown>, client: Record<string, unknown> = {}) {
  const posted: Posted[] = [];
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

  const upsertProfile = vi.fn(async () => undefined);
  const createSession = vi.fn(async () => 'token');
  const fmClient = {
    createSession,
    deleteSession: vi.fn(async () => undefined),
    getProductInfo: vi.fn(async () => ({ name: 'FileMaker Server', version: '21.1' })),
    listHostedDatabases: vi.fn(async () => undefined),
    forgetProfile: vi.fn(),
    ...client
  };
  ConnectionWizardPanel.createOrShow(
    { extensionUri: { fsPath: '/ext' }, extension: { id: 'x.y' } } as never,
    { upsertProfile, listProfiles: vi.fn(async () => []) } as never,
    new SecretStore(new InMemorySecretStorage() as never),
    fmClient as never,
    { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    editing as never
  );
  const fire = async (message: unknown) => {
    const before = posted.length;
    await handler?.(message);
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 100 && !posted.slice(before).some((m) => /^(save|test)(Success|Error)$|^certificateState$/.test(m.type ?? '')); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  await fire({ type: 'ready' });
  return {
    fire,
    posted,
    upsertProfile,
    fmClient,
    savedProfile: () => (upsertProfile.mock.calls.at(-1) as unknown as [Record<string, unknown>] | undefined)?.[0],
    last: (type: string) => [...posted].reverse().find((m) => m.type === type)
  };
}

describe('Connection wizard certificate trust', () => {
  let dir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    review.decision = undefined;
    review.calls.length = 0;
    dir = await mkdtemp(path.join(tmpdir(), 'wizard-ca-'));
    (vscode.workspace.fs.readFile as unknown as ReturnType<typeof vi.fn>).mockRejectedValue({ code: 'FileNotFound' });
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined as never);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const selfSignedFailure = () =>
    new FMClientError('This server presents a self-signed certificate.', { networkCode: 'DEPTH_ZERO_SELF_SIGNED_CERT', kind: 'certificate', isRetryable: false });

  it('Test Connection that meets a certificate problem offers to trust it, and tests again with the pin', async () => {
    const getProductInfo = vi.fn().mockRejectedValueOnce(selfSignedFailure()).mockResolvedValue({ name: 'FileMaker Server', version: '21.1' });
    const h = await setup(undefined, { getProductInfo });
    review.decision = { sha256: PIN, allowExpired: false };

    await h.fire({ type: 'testConnection', payload: form });

    expect(review.calls).toHaveLength(1);
    expect(review.calls[0]?.[1]).toMatchObject({ networkCode: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    expect(h.last('certificateState')?.payload).toMatchObject({ pin: { sha256: PIN, allowExpired: false }, legacy: false });
    expect(getProductInfo).toHaveBeenCalledTimes(2);
    expect(getProductInfo.mock.calls[1]?.[0]).toMatchObject({ pinnedCertSha256: PIN });
    expect(h.last('testSuccess')?.message).toMatch(/Connection successful.*FileMaker Server 21\.1/);

    // Saving keeps the pin, and never the older blanket flag.
    await h.fire({ type: 'save', payload: form });
    expect(h.savedProfile()).toMatchObject({ pinnedCertSha256: PIN });
    expect(h.savedProfile()?.allowSelfSigned).toBeUndefined();
    expect(h.savedProfile()?.pinnedCertAllowExpired).toBeUndefined();
  });

  it('declining leaves the test failed, the error explained, and nothing trusted', async () => {
    const getProductInfo = vi.fn().mockRejectedValue(selfSignedFailure());
    const h = await setup(undefined, { getProductInfo });

    await h.fire({ type: 'testConnection', payload: form });

    expect(h.last('testError')?.message).toMatch(/Could not reach the Data API: .*self-signed/);
    await h.fire({ type: 'save', payload: form });
    expect(h.savedProfile()?.pinnedCertSha256).toBeUndefined();
  });

  it('does not offer to trust failures that are not certificate problems', async () => {
    const getProductInfo = vi.fn().mockRejectedValue(new FMClientError('Nothing is listening', { networkCode: 'ECONNREFUSED', kind: 'network', isRetryable: true }));
    const h = await setup(undefined, { getProductInfo });
    await h.fire({ type: 'testConnection', payload: form });
    expect(review.calls).toHaveLength(0);
    expect(h.last('testError')?.message).toMatch(/Could not reach the Data API: Nothing is listening/);
  });

  it('a changed certificate is reviewed as a change (the old fingerprint goes to the dialog)', async () => {
    const mismatch = new FMClientError('changed', { networkCode: 'FM_CERT_PIN_MISMATCH', kind: 'certificate', isRetryable: false });
    const getProductInfo = vi.fn().mockRejectedValueOnce(mismatch).mockResolvedValue({});
    const h = await setup({ ...saved, pinnedCertSha256: PIN }, { getProductInfo });
    review.decision = { sha256: 'cd'.repeat(32), allowExpired: false };

    await h.fire({ type: 'testConnection', payload: form });

    expect(review.calls[0]?.[1]).toMatchObject({ networkCode: 'FM_CERT_PIN_MISMATCH', previousSha256: PIN });
    await h.fire({ type: 'save', payload: form });
    expect(h.savedProfile()?.pinnedCertSha256).toBe('cd'.repeat(32));
  });

  it('shows an older "skip all checks" profile with a warning, keeps it on save, and converts it to a pin on request', async () => {
    const h = await setup({ ...saved, allowSelfSigned: true });
    expect(h.last('certificateState')?.payload).toMatchObject({ legacy: true });

    await h.fire({ type: 'save', payload: form });
    expect(h.savedProfile()).toMatchObject({ allowSelfSigned: true }); // existing profiles keep working

    review.decision = { sha256: PIN, allowExpired: true };
    await h.fire({ type: 'convertLegacyCertificate', payload: form });
    expect(h.last('certificateState')?.payload).toMatchObject({ legacy: false, pin: { sha256: PIN, allowExpired: true } });
    await h.fire({ type: 'save', payload: form });
    expect(h.savedProfile()).toMatchObject({ pinnedCertSha256: PIN, pinnedCertAllowExpired: true });
    expect(h.savedProfile()?.allowSelfSigned).toBeUndefined();
  });

  it('the user can go back to normal checking (drop the older flag) or forget a pin', async () => {
    const h = await setup({ ...saved, allowSelfSigned: true, pinnedCertSha256: PIN });
    await h.fire({ type: 'stopSkippingCertificateChecks' });
    expect(h.last('certificateState')?.payload).toMatchObject({ legacy: false, pin: { sha256: PIN } });
    await h.fire({ type: 'forgetCertificate' });
    expect(h.last('certificateState')?.payload).toMatchObject({ legacy: false });
    expect(h.last('certificateState')?.payload?.pin).toBeUndefined();
    await h.fire({ type: 'save', payload: form });
    expect(h.savedProfile()?.pinnedCertSha256).toBeUndefined();
    expect(h.savedProfile()?.allowSelfSigned).toBeUndefined();
  });

  it('the form cannot set a pin or the older flag: such fields are ignored', async () => {
    const h = await setup();
    await h.fire({ type: 'save', payload: { ...form, pinnedCertSha256: PIN, pinnedCertAllowExpired: true, allowSelfSigned: true } });
    expect(h.savedProfile()).toBeDefined();
    expect(h.savedProfile()?.pinnedCertSha256).toBeUndefined();
    expect(h.savedProfile()?.pinnedCertAllowExpired).toBeUndefined();
    expect(h.savedProfile()?.allowSelfSigned).toBeUndefined();
  });

  it('refuses a review for an http address', async () => {
    const h = await setup();
    await h.fire({ type: 'reviewCertificate', payload: { ...form, serverUrl: 'http://localhost:8080' } });
    expect(h.last('saveError')?.message).toMatch(/only apply to https/);
    expect(review.calls).toHaveLength(0);
  });

  it('Test Connection says which step failed', async () => {
    const reach = await setup(undefined, { getProductInfo: vi.fn().mockRejectedValue(new FMClientError('web page', { code: 'NOT_DATA_API_RESPONSE' })) });
    await reach.fire({ type: 'testConnection', payload: form });
    expect(reach.last('testError')?.message).toMatch(/^Could not reach the Data API: web page/);

    const signIn = await setup(undefined, {
      createSession: vi.fn().mockRejectedValue(new FMClientError('FileMaker API error (HTTP 401) [212]: Invalid user account and/or password', { code: '212', status: 401 })),
      listHostedDatabases: vi.fn(async () => ['Sales'])
    });
    await signIn.fire({ type: 'testConnection', payload: form });
    expect(signIn.last('testError')?.message).toMatch(/^Reached the server, but sign-in failed: .*\[212\]/);

    const noDb = await setup(undefined, {
      createSession: vi.fn().mockRejectedValue(new FMClientError('[802] Unable to open file', { code: '802', status: 500, fmCategory: 'config' })),
      listHostedDatabases: vi.fn(async () => ['Inventory', 'HR'])
    });
    await noDb.fire({ type: 'testConnection', payload: form });
    expect(noDb.last('testError')?.message).toMatch(/lists these databases: Inventory, HR/);
  });

  it('a successful test mentions a database the server does not list', async () => {
    const h = await setup(undefined, { listHostedDatabases: vi.fn(async () => ['Other']) });
    await h.fire({ type: 'testConnection', payload: form });
    expect(h.last('testSuccess')?.message).toMatch(/does not list a database called "Sales".*Other/);
  });

  it('saves a valid custom CA file path and refuses an invalid one', async () => {
    const ca = path.join(dir, 'ca.pem');
    await writeFile(ca, CERT);
    const good = await setup();
    await good.fire({ type: 'save', payload: { ...form, caBundlePath: `  ${ca} ` } });
    expect(good.savedProfile()).toMatchObject({ caBundlePath: ca });

    const bad = await setup();
    await bad.fire({ type: 'save', payload: { ...form, caBundlePath: path.join(dir, 'missing.pem') } });
    expect(bad.last('saveError')?.message).toMatch(/could not be read/);
    expect(bad.upsertProfile).not.toHaveBeenCalled();
  });

  it('keeps AI access when a profile is edited without moving it, and resets it when the target changes', async () => {
    const same = await setup({ ...saved, aiAccess: 'read' });
    await same.fire({ type: 'save', payload: form });
    expect(same.savedProfile()).toMatchObject({ aiAccess: 'read' });

    for (const change of [{ database: 'Other' }, { apiBasePath: '/fmi/other' }, { apiVersionPath: 'v1' }]) {
      const moved = await setup({ ...saved, aiAccess: 'write' });
      await moved.fire({ type: 'save', payload: { ...form, ...change } });
      expect(moved.savedProfile()).toBeDefined();
      expect(moved.savedProfile()?.aiAccess).toBeUndefined();
    }
  });

  it('confirms an address that came from the workspace template before reviewing its certificate', async () => {
    (vscode.workspace.fs.readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      Buffer.from(JSON.stringify({ name: 'Team', authMode: 'direct', serverUrl: 'https://template.example.com', database: 'App' }))
    );
    const h = await setup();
    const fromTemplate = { ...form, serverUrl: 'https://template.example.com' };

    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never); // declined
    await h.fire({ type: 'reviewCertificate', payload: fromTemplate });
    expect(String(vi.mocked(vscode.window.showWarningMessage).mock.calls[0]?.[0])).toMatch(/came from the workspace file/);
    expect(review.calls).toHaveLength(0);
    expect(h.last('saveError')?.message).toMatch(/did not confirm/);

    review.decision = { sha256: PIN, allowExpired: false };
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Continue' as never);
    await h.fire({ type: 'reviewCertificate', payload: fromTemplate });
    expect(review.calls).toHaveLength(1);

    // An address the user typed needs no such confirmation.
    review.calls.length = 0;
    vi.mocked(vscode.window.showWarningMessage).mockClear();
    await h.fire({ type: 'reviewCertificate', payload: form });
    expect(review.calls).toHaveLength(1);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('removes the throwaway test profile from the client when a test ends', async () => {
    const h = await setup();
    await h.fire({ type: 'testConnection', payload: form });
    const forgotten = (h.fmClient.forgetProfile as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
    expect(forgotten.some((id) => id.startsWith('test-connection-'))).toBe(true);
  });

  it('shows a review button and no checkbox that turns checks off', async () => {
    await setup();
    const html = (vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)?.value as { webview: { html: string } }).webview.html;
    expect(html).toContain('id="reviewCertBtn"');
    expect(html).toContain('id="caBundlePath"');
    expect(html).not.toContain('id="allowSelfSigned"');
    expect(html).toContain('skips ALL certificate checks');
  });

  describe('the CA bundle picker', () => {
    const uiSource = readFileSync(path.resolve(__dirname, '../../../src/webviews/connectionWizard/ui/index.js'), 'utf8');

    /** The page the wizard renders, in a real DOM (jsdom, which the designer-ui workspace installs). */
    function page() {
      const html = (vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)?.value as { webview: { html: string } }).webview.html;
      return loadPage(html, uiSource);
    }

    it('the host asks VS Code for a certificate file and answers with the path that was chosen', async () => {
      const h = await setup();
      vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([vscode.Uri.file('/picked/company-ca.pem')]);

      await h.fire({ type: 'pickCaBundle' });

      const [call] = vi.mocked(vscode.window.showOpenDialog).mock.calls;
      expect(call?.[0]).toEqual({
        canSelectFiles: true,
        canSelectMany: false,
        filters: { Certificates: ['pem', 'crt', 'cer'] },
        title: 'Select the CA certificate file'
      });
      expect(h.posted.find((m) => m.type === 'caBundlePicked')).toMatchObject({
        type: 'caBundlePicked',
        path: '/picked/company-ca.pem'
      });
    });

    it('a cancelled file dialog answers with an empty path', async () => {
      const h = await setup();
      vi.mocked(vscode.window.showOpenDialog).mockResolvedValue(undefined as never);

      await h.fire({ type: 'pickCaBundle' });

      expect(h.posted.find((m) => m.type === 'caBundlePicked')).toMatchObject({ type: 'caBundlePicked', path: '' });
    });

    describe.skipIf(!JSDOM)('the page', () => {
      it('offers a Browse button that asks the host for a file', async () => {
        await setup();
        const p = page();

        const button = p.document.getElementById('pickCaBundle');
        expect(button?.textContent).toBe('Browse…');

        button?.click();

        expect(p.posted.filter((m) => m.type === 'pickCaBundle')).toEqual([{ type: 'pickCaBundle' }]);
      });

      it('puts the path the host picked into the CA field', async () => {
        const h = await setup();
        const p = page();
        vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([vscode.Uri.file('/picked/company-ca.pem')]);

        await h.fire({ type: 'pickCaBundle' });

        const reply = h.posted.find((m) => m.type === 'caBundlePicked');
        expect(reply).toMatchObject({ type: 'caBundlePicked', path: '/picked/company-ca.pem' });

        p.send(reply);

        expect(p.document.getElementById('caBundlePath')?.value).toBe('/picked/company-ca.pem');
      });

      it('a cancelled pick clears the path that was there', async () => {
        await setup();
        const p = page();

        const field = p.document.getElementById('caBundlePath');
        if (field) {
          field.value = '/old/ca.pem';
        }
        expect(p.document.getElementById('caBundlePath')?.value).toBe('/old/ca.pem');

        p.send({ type: 'caBundlePicked', path: '' });

        expect(p.document.getElementById('caBundlePath')?.value).toBe('');
      });
    });
  });
});
