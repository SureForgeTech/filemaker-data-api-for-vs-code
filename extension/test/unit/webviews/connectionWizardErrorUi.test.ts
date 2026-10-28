import { readFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { SecretStore } from '../../../src/services/secretStore';
import { ConnectionWizardPanel } from '../../../src/webviews/connectionWizard';
import { InMemorySecretStorage } from '../mocks';

// The page script is run in a real DOM (jsdom, which the designer-ui workspace installs).
interface DomElement {
  value: string;
  textContent: string | null;
  click(): void;
  contains(other: unknown): boolean;
}
interface JsdomWindow {
  document: {
    getElementById(id: string): DomElement | null;
    body: { textContent: string | null };
    dispatchEvent(event: unknown): boolean;
  };
  eval(code: string): void;
  dispatchEvent(event: unknown): boolean;
  MessageEvent: new (type: string, init: { data: unknown; origin?: string }) => unknown;
  Event: new (type: string) => unknown;
  location: { origin: string };
}
type JsdomCtor = new (html: string, options: { runScripts: string; url: string }) => { window: JsdomWindow };
let JSDOM: JsdomCtor | undefined;
try {
  JSDOM = (createRequire(path.resolve(__dirname, '../../../../designer-ui/package.json'))('jsdom') as { JSDOM: JsdomCtor }).JSDOM;
} catch {
  JSDOM = undefined;
}

const uiSource = readFileSync(path.resolve(__dirname, '../../../src/webviews/connectionWizard/ui/index.js'), 'utf8');

function pageHtml(): string {
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
    webview: { html: '', cspSource: 'x', asWebviewUri: (u: unknown) => u, postMessage: vi.fn(async () => true), onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })) },
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    reveal: vi.fn(),
    dispose: vi.fn()
  } as never);
  (ConnectionWizardPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  ConnectionWizardPanel.createOrShow(
    { extensionUri: { fsPath: '/ext' }, extension: { id: 'x.y' } } as never,
    { upsertProfile: vi.fn(), listProfiles: vi.fn(async () => []) } as never,
    new SecretStore(new InMemorySecretStorage() as never),
    {} as never,
    { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never
  );
  return (vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)?.value as { webview: { html: string } }).webview.html;
}

describe.skipIf(!JSDOM)('Test Connection failure in the wizard page', () => {
  beforeEach(() => vi.clearAllMocks());

  function load() {
    const dom = new (JSDOM as JsdomCtor)(pageHtml().replace(/<script[^>]*src=[^>]*><\/script>/g, ''), { runScripts: 'outside-only', url: 'https://wizard.invalid/' });
    const { window } = dom;
    const posted: Array<Record<string, unknown>> = [];
    (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(m) });
    window.eval(uiSource);
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    const send = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data, origin: window.location.origin }));
    return { window, document: window.document, posted, send };
  }

  const MESSAGE = "This server uses a certificate that is not trusted (FileMaker Server's default certificate is self-signed). You can trust this certificate in the wizard.";
  const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

  it('shows the error once: the badge only says the test failed, the message box has the reason', () => {
    const { document, send } = load();
    send({ type: 'init', testPolicy: 'warn' });
    send({ type: 'testError', message: MESSAGE, trust: 'trust' });

    expect(document.getElementById('testBadge')?.textContent).toBe('🔴 Test failed');
    expect(document.getElementById('status')?.textContent).toContain(MESSAGE);
    expect(occurrences(document.body.textContent ?? '', MESSAGE)).toBe(1);
  });

  it('puts the Trust this certificate… action with the error for certificate problems, and it asks for the review', () => {
    const { document, send, posted } = load();
    (document.getElementById('profileName') as DomElement).value = 'P';
    (document.getElementById('serverUrl') as DomElement).value = 'https://fm.example.com';
    (document.getElementById('database') as DomElement).value = 'D';
    (document.getElementById('username') as DomElement).value = 'u';
    send({ type: 'testError', message: MESSAGE, trust: 'trust' });

    const button = document.getElementById('trustCertFromErrorBtn') as DomElement;
    expect(button.textContent).toBe('Trust this certificate…');
    expect(document.getElementById('status')?.contains(button)).toBe(true);
    button.click();
    expect(posted.find((m) => m.type === 'reviewCertificate')).toBeDefined();
  });

  it('a changed certificate says Review and re-trust; other failures get no trust button', () => {
    const { document, send } = load();
    send({ type: 'testError', message: 'The certificate changed.', trust: 'retrust' });
    expect(document.getElementById('trustCertFromErrorBtn')?.textContent).toBe('Review and re-trust');

    send({ type: 'testError', message: 'Nothing is listening on host:443.' });
    expect(document.getElementById('trustCertFromErrorBtn')).toBeNull();
    expect(document.getElementById('status')?.textContent).toBe('Nothing is listening on host:443.');
  });
});
