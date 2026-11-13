import { readFileSync } from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { FMClientError } from '../../../src/services/errors';
import { ScriptRunnerPanel } from '../../../src/webviews/scriptRunner';
import { JSDOM, loadPage } from '../../helpers/jsdomPage';
import { InMemoryMemento } from '../mocks';

const uiSource = readFileSync(path.resolve(__dirname, '../../../src/webviews/scriptRunner/ui/index.js'), 'utf8');
const profile = { id: 'p1', name: 'Dev', authMode: 'direct', serverUrl: 'https://fm.example.com', database: 'Sales' };

function open(runScript: ReturnType<typeof vi.fn>) {
  let onMessage: ((message: unknown) => void) | undefined;
  const posted: Array<Record<string, unknown>> = [];
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
    webview: {
      html: '',
      cspSource: 'x',
      asWebviewUri: (u: unknown) => u,
      postMessage: vi.fn(async (m: Record<string, unknown>) => (posted.push(m), true)),
      onDidReceiveMessage: (cb: (message: unknown) => void) => ((onMessage = cb), { dispose: vi.fn() })
    },
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    reveal: vi.fn(),
    dispose: vi.fn()
  } as never);
  (ScriptRunnerPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  ScriptRunnerPanel.createOrShow(
    { extensionUri: { fsPath: '/ext' }, workspaceState: new InMemoryMemento() } as never,
    { listProfiles: vi.fn(async () => [profile]), getProfile: vi.fn(async () => profile), getActiveProfileId: () => 'p1' } as never,
    { listLayouts: vi.fn(async () => ['Contacts']), listScripts: vi.fn(async () => ['Go']), runScript } as never,
    { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never
  );
  const html = (vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)?.value as { webview: { html: string } }).webview.html;
  const run = async () => {
    onMessage?.({ type: 'runScript', payload: { profileId: 'p1', layout: 'Contacts', scriptName: 'Go' } });
    // The handler reads the enterprise policy from disk before it runs the script, which takes
    // longer on slow machines, so wait for its answer instead of a fixed pause.
    for (let i = 0; i < 400 && !posted.some((message) => message.type === 'scriptResult' || message.type === 'error'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  return { html, posted, run };
}

describe('Script Runner: a script that ran but reported an error', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
  });

  it('the panel sends the script error codes and their meaning with the result', async () => {
    const runScript = vi.fn(async () => ({ response: { scriptError: '3', scriptResult: '' }, messages: [{ code: '0', message: 'OK' }] }));
    const { posted, run } = open(runScript);
    await run();
    const result = posted.find((message) => message.type === 'scriptResult') as { payload: { scriptErrors: Array<{ code: string }>; scriptErrorText: string } };
    expect(result.payload.scriptErrors).toEqual([{ phase: 'script', code: '3' }]);
    expect(result.payload.scriptErrorText).toMatch(/the script reported error 3 \(/);
  });

  it('sends no script errors for a script that worked, or reported 0', async () => {
    for (const response of [{ scriptResult: 'done' }, { scriptError: '0' }]) {
      const { posted, run } = open(vi.fn(async () => ({ response, messages: [{ code: '0', message: 'OK' }] })));
      await run();
      const result = posted.find((message) => message.type === 'scriptResult') as { payload: { scriptErrors: unknown[]; scriptErrorText?: string } };
      expect(result.payload.scriptErrors).toEqual([]);
      expect(result.payload.scriptErrorText).toBeUndefined();
    }
  });

  it('a timeout says the script may still be running', async () => {
    const { posted, run } = open(vi.fn(async () => { throw new FMClientError('Connecting to fm timed out.', { kind: 'timeout' }); }));
    await run();
    const error = posted.find((message) => message.type === 'error') as { message: string };
    expect(error.message).toMatch(/timed out\. The script may still be running on the server\./);
  });

  describe.skipIf(!JSDOM)('what the page shows', () => {
    const page = async (response: Record<string, unknown>) => {
      const { html, posted, run } = open(vi.fn(async () => ({ response, messages: [{ code: '0', message: 'OK' }] })));
      await run();
      const { document, send } = loadPage(html, uiSource);
      send((posted.find((message) => message.type === 'scriptResult') as Record<string, unknown>));
      return document;
    };

    it('shows a failure state with the error code and meaning instead of "Script execution completed"', async () => {
      const document = await page({ scriptError: '3' });
      const summary = document.getElementById('summary');
      const status = document.getElementById('status');
      expect(summary?.textContent).toMatch(/^Script reported an error: the script reported error 3/);
      expect(summary?.classList.contains('error')).toBe(true);
      expect(status?.textContent).toBe('Script ran, but it reported an error.');
      expect(status?.classList.contains('error')).toBe(true);
      expect(document.body.textContent).not.toContain('Script execution completed');
    });

    it('refuses a script or layout named "." or ".." in the page, before anything is posted', async () => {
      const { html } = open(vi.fn());
      const { document, send, posted } = loadPage(html, uiSource);
      send({ type: 'init', payload: { profiles: [{ id: 'p1', name: 'Dev', database: 'Sales' }], activeProfileId: 'p1', scriptRunnerEnabled: true } });
      send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Contacts', '..'] } });
      const set = (id: string, value: string) => ((document.getElementById(id) as unknown as { value: string }).value = value);
      set('layoutSelect', 'Contacts');
      for (const name of ['..', '.']) {
        set('scriptNameInput', name);
        document.getElementById('runButton')?.click();
        expect(document.getElementById('status')?.textContent).toMatch(/named "\." or "\.\." cannot be used/);
      }
      set('scriptNameInput', 'Echo');
      set('layoutSelect', '..');
      document.getElementById('runButton')?.click();
      expect(document.getElementById('status')?.textContent).toMatch(/cannot be used/);
      expect(posted.filter((m) => m.type === 'runScript')).toHaveLength(0);
      set('layoutSelect', 'Contacts');
      document.getElementById('runButton')?.click();
      expect(posted.filter((m) => m.type === 'runScript')).toHaveLength(1);
    });

    it('still says completed, without the error styling, when the script worked', async () => {
      const document = await page({ scriptResult: 'ok' });
      expect(document.getElementById('status')?.textContent).toBe('Script execution completed.');
      expect(document.getElementById('status')?.classList.contains('error')).toBe(false);
      expect(document.getElementById('summary')?.classList.contains('error')).toBe(false);
    });
  });
});
