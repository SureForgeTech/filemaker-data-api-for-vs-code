import { readFileSync } from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { RecordEditorPanel } from '../../../src/webviews/recordEditor';
import { JSDOM, loadPage } from '../../helpers/jsdomPage';
import { InMemoryMemento } from '../mocks';

const uiSource = readFileSync(path.resolve(__dirname, '../../../src/webviews/recordEditor/ui/index.js'), 'utf8');

function pageHtml(): string {
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
    webview: { html: '', cspSource: 'x', asWebviewUri: (u: unknown) => u, postMessage: vi.fn(async () => true), onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })) },
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    reveal: vi.fn(),
    dispose: vi.fn()
  } as never);
  (RecordEditorPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  RecordEditorPanel.createOrShow(
    { extensionUri: { fsPath: '/ext' }, workspaceState: new InMemoryMemento() } as never,
    { listProfiles: vi.fn(async () => []), getProfile: vi.fn(), getActiveProfileId: () => undefined } as never,
    {} as never,
    {} as never,
    { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never
  );
  return (vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)?.value as { webview: { html: string } }).webview.html;
}

function savePage() {
  const page = loadPage(pageHtml(), uiSource);
  page.send({ type: 'init', payload: { profiles: [{ id: 'p', name: 'P' }], activeProfileId: 'p' } });
  page.send({ type: 'layoutsLoaded', payload: { profileId: 'p', layouts: ['Layout'] } });
  page.document.getElementById('recordIdInput')!.value = '1';
  page.send({ type: 'recordLoaded', payload: { profileId: 'p', layout: 'Layout', fields: [{ name: 'Name', type: 'text' }], presentationFields: [{ name: 'Name', type: 'text' }], record: { recordId: '1', fieldData: { Name: 'before' } } } });
  page.window.eval(`const input = document.querySelector('#fieldEditor input, #fieldEditor textarea'); input.value = 'after'; input.dispatchEvent(new Event('input'));`);
  page.document.getElementById('saveButton')!.click();
  return page;
}

describe.skipIf(!JSDOM)('Record Editor Save after its extension host disconnects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
  });

  afterEach(() => vi.useRealTimers());

  it('keeps waiting when a live host acknowledges Save, then shows its trust refusal', () => {
    const page = savePage();
    page.send({ type: 'saveReceived' });
    vi.advanceTimersByTime(2500);
    expect(page.document.getElementById('status')?.textContent).toBe('Saving...');

    page.send({ type: 'error', message: 'The record editor is disabled in untrusted workspaces.' });
    expect(page.document.getElementById('status')?.textContent).toContain('untrusted workspaces');
    expect(page.document.getElementById('saveButton')?.disabled).toBe(false);
  });

  it('explains a disconnected panel instead of leaving Saving on screen forever', () => {
    const page = savePage();
    expect(page.document.getElementById('status')?.textContent).toBe('Saving...');
    vi.advanceTimersByTime(2000);

    expect(page.document.getElementById('status')?.textContent).toMatch(/did not answer Save.*workspace is now untrusted/);
    expect(page.document.getElementById('status')?.textContent).toContain('check the record before repeating Save');
    expect(page.document.getElementById('saveButton')?.disabled).toBe(false);
  });
});
