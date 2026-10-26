import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { SecretStore } from '../../../src/services/secretStore';
import type { SchemaDiffResult } from '../../../src/types/fm';
import { ConnectionWizardPanel } from '../../../src/webviews/connectionWizard';
import { LayoutModePanel } from '../../../src/webviews/layoutMode';
import { QueryBuilderPanel } from '../../../src/webviews/queryBuilder';
import { RecordEditorPanel } from '../../../src/webviews/recordEditor';
import { RecordViewerPanel } from '../../../src/webviews/recordViewer';
import { SchemaDiffPanel } from '../../../src/webviews/schemaDiff';
import { ScriptRunnerPanel } from '../../../src/webviews/scriptRunner';
import { JSDOM, loadPage } from '../../helpers/jsdomPage';
import { InMemoryMemento, InMemorySecretStorage } from '../mocks';

/**
 * Every panel page drops a "message" event whose origin is not the page's own before it reads
 * event.data. VS Code delivers its messages with the webview's own origin, so they still land.
 * Each test reuses a message the host really sends (see the *MessageRouting tests) and checks
 * both halves: the page's own origin reacts, a foreign origin changes nothing.
 */

type Page = ReturnType<typeof loadPage>;
type Webview =
  | 'connectionWizard'
  | 'layoutMode'
  | 'queryBuilder'
  | 'recordEditor'
  | 'recordViewer'
  | 'schemaDiff'
  | 'scriptRunner';

const WIZARD_ERROR = { type: 'error', message: 'The profiles could not be read.' };
const LAYOUT_INIT = { type: 'init' };
const QUERY_ERROR = { type: 'error', message: 'Clipboard unavailable' };
const EDITOR_ERROR = { type: 'error', message: 'Record is unavailable.' };
const VIEWER_ERROR = { type: 'error', message: 'The selected profile no longer exists.' };
const DIFF_ERROR = { type: 'error', message: 'The file could not be written.' };
const RUNNER_ERROR = { type: 'error', message: 'The script could not be run.' };

const profile = { id: 'p1', name: 'Dev', database: 'Sales', authMode: 'direct', serverUrl: 'https://fm.example.com' };

const diff: SchemaDiffResult = {
  profileId: 'p1',
  layout: 'Contacts',
  comparedAt: '2026-01-01T00:00:00Z',
  added: [],
  removed: [],
  changed: [],
  summary: { added: 0, removed: 0, changed: 0 },
  hasChanges: false
};

function uiSource(kind: Webview): string {
  let source = readFileSync(path.resolve(__dirname, `../../../src/webviews/${kind}/ui/index.js`), 'utf8');
  if (kind === 'queryBuilder') {
    source = readFileSync(path.resolve(__dirname, '../../../src/webviews/queryBuilder/ui/cellText.js'), 'utf8') + '\n'
      + readFileSync(path.resolve(__dirname, '../../../src/webviews/queryBuilder/ui/findForm.js'), 'utf8') + '\n' + source;
  }
  if (kind === 'schemaDiff') {
    source = 'window.requestAnimationFrame = (callback) => callback();\n' + source;
  }
  return source;
}

function webviewPanelMock() {
  return {
    webview: {
      html: '',
      cspSource: 'x',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: vi.fn(async () => true),
      onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() }))
    },
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    reveal: vi.fn(),
    dispose: vi.fn()
  };
}

/** Opens the panel once, just to build its real HTML, and runs that page's script in a real DOM. */
function open(kind: Webview): Page {
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(webviewPanelMock() as never);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
  const store = { listProfiles: async () => [profile], getProfile: async () => profile, getActiveProfileId: () => 'p1' } as never;
  const client = {} as never;
  const context = { extensionUri: { fsPath: '/ext' }, workspaceState: new InMemoryMemento() } as never;

  switch (kind) {
    case 'connectionWizard':
      (ConnectionWizardPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
      ConnectionWizardPanel.createOrShow(
        { extensionUri: { fsPath: '/ext' }, extension: { id: 'x.y' } } as never,
        { upsertProfile: vi.fn(), listProfiles: vi.fn(async () => []) } as never,
        new SecretStore(new InMemorySecretStorage() as never),
        client,
        logger
      );
      break;
    case 'layoutMode':
      (LayoutModePanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
      LayoutModePanel.createOrShow(
        context,
        {
          ensureProjectInitialized: async () => ({ name: 'Project' }),
          loadOrCreateLayout: async () => undefined,
          loadMetadataCache: async () => ({ scripts: [], layoutMetadata: [] }),
          getDesignerLayouts: async () => [],
          getAvailableFields: async () => [],
          saveLayout: async () => undefined,
          readProjectConfig: async () => undefined
        } as never,
        { getActiveProfileId: () => undefined, getProfile: async () => undefined } as never,
        { runScript: async () => undefined } as never,
        logger,
        { assertScriptRunAllowed: async () => true }
      );
      break;
    case 'queryBuilder':
      (QueryBuilderPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
      QueryBuilderPanel.createOrShow(context, store, { listSavedQueries: async () => [] } as never, client, logger);
      break;
    case 'recordEditor':
      (RecordEditorPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
      RecordEditorPanel.createOrShow(context, store, client, { getFields: async () => ({ supported: true, fields: [] }) } as never, logger);
      break;
    case 'recordViewer':
      (RecordViewerPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
      RecordViewerPanel.createOrShow(context, store, client, logger);
      break;
    case 'schemaDiff':
      (SchemaDiffPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
      SchemaDiffPanel.createOrShow({ extensionUri: { fsPath: '/ext' }, subscriptions: [] } as never, diff, { error: vi.fn() });
      break;
    case 'scriptRunner':
      (ScriptRunnerPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
      ScriptRunnerPanel.createOrShow(context, store, client, logger);
      break;
  }

  const html = (vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)?.value as { webview: { html: string } }).webview.html;
  return loadPage(html, uiSource(kind));
}

function dispatchFrom(page: Page, data: unknown, origin: string): void {
  page.window.dispatchEvent(new page.window.MessageEvent('message', { data, origin }));
}

describe.skipIf(!JSDOM)('webview pages ignore messages whose origin is not their own', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
  });

  it('connection wizard shows the host error from its own origin only', () => {
    const page = open('connectionWizard');
    const status = page.document.getElementById('status')!;
    const before = status.textContent;

    dispatchFrom(page, WIZARD_ERROR, 'https://attacker.invalid');
    expect(status.textContent).toBe(before);

    dispatchFrom(page, WIZARD_ERROR, page.window.location.origin);
    expect(status.textContent).toBe(WIZARD_ERROR.message);
  });

  it('layout mode reacts to its init message from its own origin only', () => {
    const page = open('layoutMode');
    const root = page.document.getElementById('root')!;
    const before = root.textContent;

    dispatchFrom(page, LAYOUT_INIT, 'https://attacker.invalid');
    expect(root.textContent).toBe(before);

    dispatchFrom(page, LAYOUT_INIT, page.window.location.origin);
    expect(root.textContent).toBe('Layout Mode UI bundle is missing. Build designer-ui to enable the React designer.');
  });

  it('query builder shows the host error from its own origin only', () => {
    const page = open('queryBuilder');
    const status = page.document.getElementById('status')!;
    const before = status.textContent;

    dispatchFrom(page, QUERY_ERROR, 'https://attacker.invalid');
    expect(status.textContent).toBe(before);

    dispatchFrom(page, QUERY_ERROR, page.window.location.origin);
    expect(status.textContent).toBe(QUERY_ERROR.message);
  });

  it('record editor shows the host error from its own origin only', () => {
    const page = open('recordEditor');
    const status = page.document.getElementById('status')!;
    const before = status.textContent;

    dispatchFrom(page, EDITOR_ERROR, 'https://attacker.invalid');
    expect(status.textContent).toBe(before);

    dispatchFrom(page, EDITOR_ERROR, page.window.location.origin);
    expect(status.textContent).toBe(EDITOR_ERROR.message);
  });

  it('record viewer shows the host error from its own origin only', () => {
    const page = open('recordViewer');
    const status = page.document.getElementById('status')!;
    const before = status.textContent;

    dispatchFrom(page, VIEWER_ERROR, 'https://attacker.invalid');
    expect(status.textContent).toBe(before);

    dispatchFrom(page, VIEWER_ERROR, page.window.location.origin);
    expect(status.textContent).toBe(VIEWER_ERROR.message);
  });

  it('schema diff shows the host error from its own origin only', () => {
    const page = open('schemaDiff');
    const summary = page.document.getElementById('summary')!;
    const before = summary.textContent;

    dispatchFrom(page, DIFF_ERROR, 'https://attacker.invalid');
    expect(summary.textContent).toBe(before);

    dispatchFrom(page, DIFF_ERROR, page.window.location.origin);
    expect(summary.textContent).toBe(DIFF_ERROR.message);
  });

  it('script runner shows the host error from its own origin only', () => {
    const page = open('scriptRunner');
    const status = page.document.getElementById('status')!;
    const before = status.textContent;

    dispatchFrom(page, RUNNER_ERROR, 'https://attacker.invalid');
    expect(status.textContent).toBe(before);

    dispatchFrom(page, RUNNER_ERROR, page.window.location.origin);
    expect(status.textContent).toBe(RUNNER_ERROR.message);
  });
});
