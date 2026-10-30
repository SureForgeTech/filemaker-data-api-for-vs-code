import { readFileSync } from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { QueryBuilderPanel } from '../../src/webviews/queryBuilder';
import { JSDOM, loadPage, type JsdomWindow } from '../helpers/jsdomPage';
import { InMemoryMemento } from './mocks';

/**
 * What VS Code does with a Query Builder tab after a window reload: it hands the tab back to the
 * extension's serializer, and the serializer has to put the real page back. The page then reads the
 * snapshot it stored itself, so the panel comes back with the work in it.
 */

const devProfile = { id: 'p1', name: 'Dev', database: 'Sales', authMode: 'direct', serverUrl: 'https://fm.example.com' };
const prodProfile = { id: 'p2', name: 'Prod', database: 'Sales', authMode: 'direct', serverUrl: 'https://fm2.example.com' };

type Handler = (message: unknown) => void;

/** A revived webview, as VS Code hands it to a serializer. */
function revivedPanel() {
  const handlers: Handler[] = [];
  const posted: Array<Record<string, unknown>> = [];
  return {
    title: 'FileMaker Query Builder',
    webview: {
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: vi.fn(async (message: Record<string, unknown>) => {
        posted.push(message);
        return true;
      }),
      onDidReceiveMessage: vi.fn((callback: Handler) => {
        handlers.push(callback);
        return { dispose: vi.fn() };
      })
    },
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    reveal: vi.fn(),
    dispose: vi.fn(),
    handlers,
    posted
  };
}

/** Registers the Query Builder serializer the way activation does, and hands it back. */
function registerSerializer() {
  QueryBuilderPanel.registerSerializer(
    { extensionUri: { fsPath: '/ext' }, workspaceState: new InMemoryMemento() } as never,
    { listProfiles: async () => [devProfile, prodProfile], getActiveProfileId: () => 'p1' } as never,
    { listSavedQueries: async () => [] } as never,
    undefined,
    {} as never,
    { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never
  );

  const call = vi.mocked(vscode.window.registerWebviewPanelSerializer).mock.calls.find(
    ([viewType]) => viewType === 'filemakerQueryBuilder'
  );
  if (!call) {
    throw new Error('The Query Builder serializer was not registered.');
  }
  return call[1];
}

/** The panel's own HTML and page script, as VS Code hands them to the webview. */
function open() {
  const panel = {
    webview: {
      html: '', cspSource: 'x', asWebviewUri: (uri: unknown) => uri, postMessage: vi.fn(async () => true),
      onDidReceiveMessage: () => ({ dispose: vi.fn() })
    },
    onDidDispose: vi.fn(), reveal: vi.fn()
  };
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(panel as never);
  const context = { extensionUri: { fsPath: '/ext' }, workspaceState: new InMemoryMemento() } as never;
  const store = { listProfiles: async () => [devProfile], getProfile: async () => devProfile, getActiveProfileId: () => 'p1' } as never;
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never;
  const saved = { listSavedQueries: async () => [] } as never;
  (QueryBuilderPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  QueryBuilderPanel.createOrShow(context, store, saved, {} as never, logger);
  const source = [
    readFileSync(path.resolve(__dirname, '../../src/webviews/queryBuilder/ui/cellText.js'), 'utf8'),
    readFileSync(path.resolve(__dirname, '../../src/webviews/queryBuilder/ui/findForm.js'), 'utf8'),
    readFileSync(path.resolve(__dirname, '../../src/webviews/queryBuilder/ui/index.js'), 'utf8')
  ].join('\n');
  // A window reload leaves no panel behind, so the serializer revives a new one.
  (QueryBuilderPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  return { html: panel.webview.html, source };
}

function element(window: JsdomWindow, id: string) {
  const found = window.document.getElementById(id) as unknown as {
    value: string;
    dispatchEvent(event: unknown): void;
  } | null;
  if (!found) {
    throw new Error(`The page has no #${id}.`);
  }
  return found;
}

/** Picks another option in a select, the way a user does. */
function choose(window: JsdomWindow, id: string, value: string): void {
  const select = element(window, id);
  select.value = value;
  select.dispatchEvent(new window.Event('change'));
}

/** Types into a text box, the way a user does. */
function typeText(window: JsdomWindow, id: string, value: string): void {
  const input = element(window, id);
  input.value = value;
  input.dispatchEvent(new window.Event('input'));
}

beforeEach(() => {
  vi.clearAllMocks();
  (QueryBuilderPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
});

describe.skipIf(!JSDOM)('Query Builder restore', () => {
  it('gives a restored Query Builder tab the real page, not the reopen page', async () => {
    const panel = revivedPanel();
    const serializer = registerSerializer();

    await serializer.deserializeWebviewPanel(panel as never, { v: 1 });

    expect(vi.mocked(vscode.window.registerWebviewPanelSerializer).mock.calls.map(([viewType]) => viewType))
      .toEqual(['filemakerQueryBuilder']);
    expect(panel.webview.html).toContain('<title>FileMaker Query Builder');
    expect(panel.webview.html).toContain('id="findJson"');
    expect(panel.webview.html).not.toContain('Close this tab and open it again');
    // The tab is revived, not opened a second time.
    expect(vi.mocked(vscode.window.createWebviewPanel)).not.toHaveBeenCalled();
  });

  it('brings the snapshot back through the serializer path', async () => {
    const view = open();
    const states: unknown[] = [];
    const first = loadPage(view.html, view.source, 'https://panel.invalid/', {
      onSetState: (value) => states.push(value)
    });
    first.send({ type: 'init', payload: { profiles: [devProfile, prodProfile], activeProfileId: 'p1' } });
    first.send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Contacts', 'Orders'] } });
    choose(first.window, 'profileSelect', 'p2');
    first.send({ type: 'layoutsLoaded', payload: { profileId: 'p2', layouts: ['Invoices'] } });
    first.document.getElementById('jsonTab')!.click();
    typeText(first.window, 'findJson', '[{"Name":"*"}]');
    const snapshot = states.at(-1);
    expect(snapshot).toBeDefined();

    // VS Code hands the tab back to the serializer, with the snapshot it stored.
    const panel = revivedPanel();
    const serializer = registerSerializer();
    await serializer.deserializeWebviewPanel(panel as never, snapshot);

    // The page the serializer wrote, loaded with the state the serializer was given.
    const restored = loadPage(panel.webview.html, view.source, 'https://panel.invalid/', { state: snapshot });
    restored.send({ type: 'init', payload: { profiles: [devProfile, prodProfile], activeProfileId: 'p1' } });
    restored.send({ type: 'layoutsLoaded', payload: { profileId: 'p2', layouts: ['Contacts', 'Invoices'] } });

    expect(restored.document.getElementById('profileSelect')!.value).toBe('p2');
    expect(restored.document.getElementById('layoutSelect')!.value).toBe('Invoices');
    expect(restored.document.getElementById('jsonTab')!.getAttribute('aria-selected')).toBe('true');
    expect(restored.document.getElementById('findJson')!.value).toBe('[{"Name":"*"}]');
  });

  it('persists page size and offset through the serializer reload path', async () => {
    const view = open();
    const states: unknown[] = [];
    const first = loadPage(view.html, view.source, 'https://panel.invalid/', {
      onSetState: (value) => states.push(value)
    });
    first.send({ type: 'init', payload: { profiles: [devProfile, prodProfile], activeProfileId: 'p1' } });
    first.send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Contacts'] } });
    typeText(first.window, 'limitInput', '007');
    typeText(first.window, 'offsetInput', '0009');
    const snapshot = states.at(-1) as Record<string, unknown>;
    expect(snapshot).toMatchObject({ limit: '007', offset: '0009' });

    const panel = revivedPanel();
    const serializer = registerSerializer();
    await serializer.deserializeWebviewPanel(panel as never, snapshot);
    const restored = loadPage(panel.webview.html, view.source, 'https://panel.invalid/', { state: snapshot });
    restored.send({ type: 'init', payload: { profiles: [devProfile, prodProfile], activeProfileId: 'p1' } });
    restored.send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Contacts'] } });
    expect(element(restored.window, 'limitInput').value).toBe('007');
    expect(element(restored.window, 'offsetInput').value).toBe('0009');
  });

  it('wires a revived panel like a created one, and keeps one panel open', async () => {
    const panel = revivedPanel();
    const serializer = registerSerializer();
    await serializer.deserializeWebviewPanel(panel as never, { v: 1 });

    // The revived page talks to the host the same way a created one does.
    expect(panel.webview.onDidReceiveMessage).toHaveBeenCalled();
    const handler = panel.handlers[0];
    expect(handler).toBeTypeOf('function');
    handler!({ type: 'ready' });
    await vi.waitFor(() => expect(panel.posted.map((message) => String(message.type))).toContain('init'));
    expect(panel.posted).toContainEqual(
      expect.objectContaining({
        type: 'init',
        payload: expect.objectContaining({ activeProfileId: 'p1', savedQueries: [] })
      })
    );

    // Only one Query Builder is open at a time, so a revived duplicate is closed again.
    const revived = (QueryBuilderPanel as unknown as { currentPanel: unknown }).currentPanel;
    expect(revived).toBeDefined();
    const duplicate = revivedPanel();
    await serializer.deserializeWebviewPanel(duplicate as never, { v: 1 });
    expect(duplicate.dispose).toHaveBeenCalled();
    expect(duplicate.webview.html).toBe('');
    expect((QueryBuilderPanel as unknown as { currentPanel: unknown }).currentPanel).toBe(revived);
  });
});
