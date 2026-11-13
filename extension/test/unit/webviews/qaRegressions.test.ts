import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { QueryBuilderPanel } from '../../../src/webviews/queryBuilder';
import { ScriptRunnerPanel } from '../../../src/webviews/scriptRunner';
import { RecordEditorPanel } from '../../../src/webviews/recordEditor';
import { RecordViewerPanel } from '../../../src/webviews/recordViewer';
import { ConnectionWizardPanel } from '../../../src/webviews/connectionWizard';
import { JSDOM, loadPage } from '../../helpers/jsdomPage';
import { InMemoryMemento } from '../mocks';

const profile = { id: 'p1', name: 'Dev', database: 'Sales', authMode: 'direct', serverUrl: 'https://fm.example.com' };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function open(kind: 'queryBuilder' | 'scriptRunner' | 'recordEditor' | 'recordViewer' | 'connectionWizard', client: object = {}) {
  let receive: (message: unknown) => void = () => undefined;
  const panel = { webview: { html: '', cspSource: 'x', asWebviewUri: (u: unknown) => u, postMessage: vi.fn(async () => true),
    onDidReceiveMessage: (cb: typeof receive) => ((receive = cb), { dispose: vi.fn() }) },
    onDidDispose: vi.fn(), reveal: vi.fn() };
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(panel as never);
  const context = { extensionUri: { fsPath: '/ext' }, workspaceState: new InMemoryMemento() } as never;
  const store = { listProfiles: async () => [profile], getProfile: async () => profile, getActiveProfileId: () => 'p1' } as never;
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never;
  const saved = { listSavedQueries: async () => [] } as never;
  const cls = { queryBuilder: QueryBuilderPanel, scriptRunner: ScriptRunnerPanel, recordEditor: RecordEditorPanel, recordViewer: RecordViewerPanel, connectionWizard: ConnectionWizardPanel }[kind];
  (cls as unknown as { currentPanel: unknown }).currentPanel = undefined;
  if (kind === 'queryBuilder') QueryBuilderPanel.createOrShow(context, store, saved, client as never, logger);
  if (kind === 'scriptRunner') ScriptRunnerPanel.createOrShow(context, store, client as never, logger);
  if (kind === 'recordEditor') RecordEditorPanel.createOrShow(context, store, client as never, { getFields: async () => ({ supported: true, fields: [{ name: ' Name ', type: 'text' }] }) } as never, logger);
  if (kind === 'recordViewer') RecordViewerPanel.createOrShow(context, store, client as never, logger);
  if (kind === 'connectionWizard') ConnectionWizardPanel.createOrShow(context, store, {} as never, client as never, logger);
  let source = readFileSync(path.resolve(__dirname, `../../../src/webviews/${kind}/ui/index.js`), 'utf8');
  if (kind === 'queryBuilder') source = readFileSync(path.resolve(__dirname, '../../../src/webviews/queryBuilder/ui/cellText.js'), 'utf8') + '\n' + readFileSync(path.resolve(__dirname, '../../../src/webviews/queryBuilder/ui/findForm.js'), 'utf8') + '\n' + readFileSync(path.resolve(__dirname, '../../../src/webviews/queryBuilder/ui/resultModel.js'), 'utf8') + '\n' + source;
  return { html: panel.webview.html, source, receive, panel };
}
const init = { profiles: [profile], activeProfileId: 'p1' };
const layouts = { profileId: 'p1', layouts: [' Contacts '] };

beforeEach(() => { vi.clearAllMocks(); (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true; });

describe('host request guards', () => {
  it.each(['queryBuilder', 'scriptRunner', 'recordViewer', 'recordEditor'] as const)('%s ignores duplicate data requests while one is pending', async (kind) => {
    let finish!: (result: never) => void;
    const operation = vi.fn(() => new Promise((resolve) => { finish = resolve as typeof finish; }));
    const client = { getLayoutMetadata: async () => ({}), findRecords: operation, runScript: operation, getRecord: operation };
    const { receive } = open(kind, client);
    const type = kind === 'queryBuilder' ? 'runQuery' : kind === 'scriptRunner' ? 'runScript' : 'loadRecord';
    const payload = { profileId: 'p1', layout: ' Contacts ', recordId: '42', scriptName: ' Go ', findJson: '[{" Name ":"*"}]', runId: 1 };
    for (let i = 0; i < 15; i++) receive({ type, payload });
    await tick();
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    finish({ data: [], response: {}, messages: [], recordId: '42', fieldData: {} } as never);
    await tick();
    receive({ type, payload });
    await tick();
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(2));
    finish({ data: [], response: {}, messages: [], recordId: '42', fieldData: {} } as never);
    await tick();
  });
  it.each(['saveRecord', 'createRecord'] as const)('host keeps one %s confirmation open during repeated messages', async (type) => {
    const target = { profileId: 'p1', layout: ' Contacts ', recordId: '42' };
    const mutate = vi.fn(async () => ({ recordId: '42', modId: '2', messages: [], response: {} }));
    const { receive } = open('recordEditor', { getRecord: async () => ({ recordId: '42', modId: '1', fieldData: { ' Name ': 'old' } }), editRecord: mutate, createRecord: mutate });
    receive({ type: 'loadRecord', payload: target }); await tick();
    let finish!: (choice: never) => void;
    vi.mocked(vscode.window.showWarningMessage).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const payload = { ...target, originalFieldData: { ' Name ': 'old' }, draftFieldData: { ' Name ': 'new' }, fieldData: { ' Name ': 'new' } };
    for (let i = 0; i < 15; i++) receive({ type, payload });
    await tick();
    await vi.waitFor(() => expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1));
    finish((type === 'createRecord' ? 'Create' : 'Save') as never); await tick();
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
  });
});

describe.skipIf(!JSDOM)('webview regression checks', () => {
  it.each(['form', 'json'])('offers an explicit list action for empty %s criteria and pages the list', (mode) => {
    const view = open('queryBuilder');
    const { document, window, send, posted } = loadPage(view.html, view.source);
    send({ type: 'init', payload: init }); send({ type: 'layoutsLoaded', payload: layouts });
    document.getElementById('addSortButton')!.click();
    window.eval(`const sortField = document.querySelector('.sort-field'); sortField.value = ' Name '; sortField.dispatchEvent(new Event('input'));`);
    if (mode === 'json') {
      document.getElementById('jsonTab')!.click();
      document.getElementById('findJson')!.value = '[{}]';
    }
    document.getElementById('limitInput')!.value = '2';
    document.getElementById('offsetInput')!.value = '3';
    document.getElementById('runButton')!.click();
    expect(posted.filter((m) => m.type === 'runQuery')).toHaveLength(0);
    const button = document.getElementById('listRecordsButton');
    expect(button?.textContent).toBe('List records instead');
    expect(button?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('status')?.textContent).toMatch(/at least one field|criteria are empty/i);
    button!.click(); button!.click();
    const runs = posted.filter((m) => m.type === 'runQuery');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.payload).toMatchObject({ listRecords: true, layout: ' Contacts ', limit: 2, offset: 3 });
    expect(JSON.parse((runs[0]!.payload as { sortJson: string }).sortJson)).toEqual([{ fieldName: ' Name ', sortOrder: 'ascend' }]);
    send({ type: 'queryResult', payload: { query: runs[0]!.payload, result: { data: [{ recordId: '3', fieldData: {} }, { recordId: '4', fieldData: {} }], dataInfo: { foundCount: 9 } } } });
    document.getElementById('nextButton')!.click();
    expect(posted.filter((m) => m.type === 'runQuery').at(-1)?.payload).toMatchObject({ listRecords: true, offset: 5, limit: 2 });
  });
  it('offers the list action when the host rejects a form with an empty field value', () => {
    const view = open('queryBuilder');
    const { document, send } = loadPage(view.html, view.source);
    send({ type: 'init', payload: init }); send({ type: 'layoutsLoaded', payload: layouts });
    send({ type: 'error', message: 'Find criteria are empty. Enter at least one field value to search.', runId: 0 });
    expect(document.getElementById('listRecordsButton')?.classList.contains('hidden')).toBe(false);
  });

  it.each(['queryBuilder', 'scriptRunner'] as const)('%s clears previous results on failure and prevents repeated clicks', (kind) => {
    const view = open(kind);
    const { document, send, posted } = loadPage(view.html, view.source);
    send({ type: 'init', payload: init });
    send({ type: 'layoutsLoaded', payload: layouts });
    if (kind === 'scriptRunner') document.getElementById('scriptNameInput')!.value = ' Go ';
    if (kind === 'queryBuilder') {
      document.getElementById('jsonTab')?.click();
      document.getElementById('findJson')!.value = '[{"Name":"*"}]';
      send({ type: 'queryResult', payload: { query: { layout: ' Contacts ' }, result: { data: [{ recordId: '1', fieldData: { Name: 'OLD RESULT' } }] } } });
    } else send({ type: 'scriptResult', payload: { result: { response: { scriptResult: 'OLD RESULT' } } } });
    const button = document.getElementById('runButton')!;
    for (let i = 0; i < 15; i++) button.click();
    const type = kind === 'queryBuilder' ? 'runQuery' : 'runScript';
    expect(posted.filter((m) => m.type === type)).toHaveLength(1);
    expect(button.getAttribute('disabled')).not.toBeNull();
    send({ type: 'error', message: 'New run failed', runId: 1 });
    expect(document.body.textContent).not.toContain('OLD RESULT');
    expect(document.getElementById(kind === 'queryBuilder' ? 'resultSummary' : 'summary')?.textContent).not.toMatch(/completed|Showing/);
    button.click();
    expect(posted.filter((m) => m.type === type)).toHaveLength(2);
  });

  it('query validation, copy and unrelated host errors preserve displayed results, while a failed run clears them', () => {
    const view = open('queryBuilder');
    const { document, window, send, posted } = loadPage(view.html, view.source);
    send({ type: 'init', payload: init }); send({ type: 'layoutsLoaded', payload: layouts });
    send({ type: 'queryResult', payload: { query: { layout: ' Contacts ' }, result: { data: [{ recordId: '1', fieldData: { Name: 'KEPT RESULT' } }] } } });
    // Enable the control as if the saved-query list changed before the click.
    window.eval("document.getElementById('loadSavedButton').disabled = false");
    document.getElementById('loadSavedButton')!.click();
    expect(document.getElementById('status')?.textContent).toContain('Choose a saved query');
    expect(document.body.textContent).toContain('KEPT RESULT');
    send({ type: 'error', message: 'Clipboard unavailable' });
    expect(document.body.textContent).toContain('KEPT RESULT');
    document.getElementById('copyTableButton')!.click();
    expect(posted.some((m) => m.type === 'copyText' && String(m.text).includes('KEPT RESULT'))).toBe(true);
    send({ type: 'queryResult', payload: { query: { layout: ' Contacts ' }, result: { data: [{ recordId: '1', fieldData: { Name: 'x'.repeat(5_000_001) } }] } } });
    document.getElementById('copyTableButton')!.click();
    expect(document.getElementById('status')?.textContent).toContain('too large to copy');
    expect(document.getElementById('resultSummary')?.textContent).toContain('Showing');
    document.getElementById('jsonTab')!.click(); document.getElementById('findJson')!.value = '[{"Name":"*"}]';
    document.getElementById('runButton')!.click();
    send({ type: 'error', message: 'Failed run', runId: 1 });
    expect(document.getElementById('resultSummary')?.textContent).not.toContain('Showing');
  });

  it.each(['serverUrl', 'username', 'modeProxyBtn'])('wizard stops advertising password reuse when %s changes', (field) => {
    const view = open('connectionWizard');
    const { document, window, send } = loadPage(view.html, view.source);
    send({ type: 'loadProfile', payload: { ...profile, username: 'alice' }, hasPassword: true });
    expect(document.getElementById('password')?.getAttribute('placeholder')).toContain('(saved)');
    if (field === 'modeProxyBtn') document.getElementById(field)!.click();
    else {
      document.getElementById(field)!.value = field === 'serverUrl' ? 'https://other.example.com' : 'bob';
      window.eval(`document.getElementById('${field}').dispatchEvent(new Event('input', { bubbles: true }))`);
    }
    expect(document.getElementById('password')?.getAttribute('placeholder')).toBe('Enter the password again');
  });

  it.each(['recordViewer', 'recordEditor'] as const)('%s disables Load and recovers after errors', (kind) => {
    const view = open(kind);
    const { document, send, posted } = loadPage(view.html, view.source);
    send({ type: 'init', payload: init }); send({ type: 'layoutsLoaded', payload: layouts });
    document.getElementById('recordIdInput')!.value = '42';
    const button = document.getElementById('loadButton')!;
    for (let i = 0; i < 15; i++) button.click();
    expect(posted.filter((m) => m.type === 'loadRecord')).toHaveLength(1);
    expect(button.getAttribute('disabled')).not.toBeNull();
    send({ type: 'error', message: 'Failed' }); button.click();
    expect(posted.filter((m) => m.type === 'loadRecord')).toHaveLength(2);
  });

  it('Record Editor loads a supplied ID once, after layouts arrive', () => {
    const view = open('recordEditor');
    const { send, posted } = loadPage(view.html, view.source);
    send({ type: 'init', payload: { ...init, defaults: { profileId: 'p1', layout: ' Contacts ', recordId: '42' } } });
    send({ type: 'layoutsLoaded', payload: layouts }); send({ type: 'layoutsLoaded', payload: layouts });
    expect(posted.filter((m) => m.type === 'loadRecord')).toEqual([{ type: 'loadRecord', payload: { profileId: 'p1', layout: ' Contacts ', recordId: '42' } }]);
  });

  it.each(['saveRecord', 'createRecord'] as const)('Record Editor disables %s until a reply, including a cancelled save', (type) => {
    const view = open('recordEditor');
    const { document, window, send, posted } = loadPage(view.html, view.source);
    const creating = type === 'createRecord';
    send({ type: 'init', payload: { ...init, defaults: { mode: creating ? 'create' : 'edit' } } });
    send({ type: 'layoutsLoaded', payload: layouts });
    document.getElementById('recordIdInput')!.value = '42';
    if (creating) send({ type: 'layoutFields', payload: { ...layouts, layout: ' Contacts ', metadataSupported: true, fields: [{ name: ' Name ' }] } });
    else send({ type: 'recordLoaded', payload: { profileId: 'p1', layout: ' Contacts ', record: { recordId: '42', fieldData: { ' Name ': 'old' } } } });
    const input = document.querySelectorAll('#fieldEditor input:not([type="checkbox"]):not([type="radio"]), #fieldEditor textarea')[0]!;
    input.value = 'new';
    (input as unknown as { dispatchEvent(event: unknown): void }).dispatchEvent(new window.Event('input'));
    const button = document.getElementById(creating ? 'createButton' : 'saveButton')!;
    for (let i = 0; i < 15; i++) button.click();
    expect(posted.filter((m) => m.type === type)).toHaveLength(1);
    expect(button.getAttribute('disabled')).not.toBeNull();
    send({ type: 'saveCancelled' }); button.click();
    expect(posted.filter((m) => m.type === type)).toHaveLength(2);
  });

  it('Query Builder disables Save and Run until saving finishes, including a cancelled name dialog', () => {
    const view = open('queryBuilder');
    const { document, send, posted } = loadPage(view.html, view.source);
    send({ type: 'init', payload: init }); send({ type: 'layoutsLoaded', payload: layouts });
    document.getElementById('jsonTab')!.click(); document.getElementById('findJson')!.value = '[{"Name":"*"}]';
    const save = document.getElementById('saveButton')!;
    for (let i = 0; i < 15; i++) save.click();
    expect(posted.filter((m) => m.type === 'saveQuery')).toHaveLength(1);
    expect(save.getAttribute('disabled')).not.toBeNull();
    expect(document.getElementById('runButton')!.getAttribute('disabled')).not.toBeNull();
    send({ type: 'querySaveFinished' }); save.click();
    expect(posted.filter((m) => m.type === 'saveQuery')).toHaveLength(2);
  });

  it('Record Editor also auto-loads a supplied ID when layouts are cached', () => {
    const view = open('recordEditor');
    const { send, posted } = loadPage(view.html, view.source);
    send({ type: 'init', payload: init }); send({ type: 'layoutsLoaded', payload: layouts });
    send({ type: 'init', payload: { ...init, defaults: { profileId: 'p1', layout: ' Contacts ', recordId: '43' } } });
    expect(posted.filter((m) => m.type === 'loadRecord')).toEqual([{ type: 'loadRecord', payload: { profileId: 'p1', layout: ' Contacts ', recordId: '43' } }]);
  });

  it('Query Builder lets fieldsets and grid cells shrink and its pager wrap in a narrow editor', () => {
    const view = open('queryBuilder');
    const css = readFileSync(path.resolve(__dirname, '../../../src/webviews/queryBuilder/ui/styles.css'), 'utf8');
    const { document, window } = loadPage(view.html.replace('</head>', `<style>${css}</style></head>`), view.source);
    const style = (selector: string) => (window as unknown as { getComputedStyle(element: unknown): { minInlineSize: string; flexWrap: string } }).getComputedStyle(document.querySelectorAll(selector)[0]);
    expect(style('fieldset').minInlineSize).toBe('0px');
    expect(style('.grid > div').minInlineSize).toBe('0px');
    expect(style('.pager').flexWrap).toBe('wrap');
  });

  it('loading a proxy profile sends only its complete address, so it cannot clear its saved pin while populating', () => {
    const view = open('connectionWizard');
    const { send, posted } = loadPage(view.html, view.source);
    send({ type: 'loadProfile', payload: { ...profile, authMode: 'proxy', proxyEndpoint: 'https://proxy.example.com/api', pinnedCertSha256: 'a'.repeat(64) } });
    const addresses = posted.filter((message) => message.type === 'addressChanged');
    expect(addresses).toHaveLength(1);
    expect(addresses[0]?.payload).toMatchObject({ authMode: 'proxy', proxyEndpoint: 'https://proxy.example.com/api' });
  });

  it('wizard keeps a newly typed password exactly, including its spaces', () => {
    const view = open('connectionWizard');
    const { document, send, posted } = loadPage(view.html, view.source);
    send({ type: 'init', testPolicy: 'off' });
    send({ type: 'loadProfile', payload: { ...profile, username: 'alice' }, hasPassword: true });
    document.getElementById('password')!.value = ' new password ';
    document.getElementById('saveBtn')!.click();
    expect((posted.find((m) => m.type === 'save')?.payload as { password: string }).password).toBe(' new password ');
  });

  it('changing the password after a successful test requires a new test or Save anyway', () => {
    const view = open('connectionWizard');
    const { document, window, send, posted } = loadPage(view.html, view.source);
    send({ type: 'init', testPolicy: 'warn' });
    send({ type: 'loadProfile', payload: { ...profile, username: 'alice' }, hasPassword: true });
    document.getElementById('testBtn')!.click(); send({ type: 'testSuccess', message: 'Connected' });
    expect(document.getElementById('testBadge')!.textContent).toContain('Test passed');
    document.getElementById('password')!.value = 'different';
    (document.getElementById('wizardForm') as unknown as { dispatchEvent(event: unknown): void }).dispatchEvent(new window.Event('input'));
    document.getElementById('saveBtn')!.click();
    expect(document.getElementById('status')!.textContent).toContain('Test the connection first');
    expect(posted.some((message) => message.type === 'save')).toBe(false);
  });

  it('wizard offers a visible Save anyway choice and a saved-password placeholder', () => {
    const view = open('connectionWizard');
    const { document, send, posted } = loadPage(view.html, view.source);
    send({ type: 'init', testPolicy: 'warn' });
    send({ type: 'loadProfile', payload: { ...profile, username: 'alice' }, hasPassword: true });
    expect(document.getElementById('password')?.getAttribute('placeholder')).toBe('••••••• (saved)');
    expect(document.getElementById('password')?.value).toBe('');
    document.getElementById('saveBtn')!.click();
    expect(document.getElementById('status')?.textContent).toContain('Test the connection first, or choose Save anyway');
    expect(posted.some((m) => m.type === 'save')).toBe(false);
    document.getElementById('saveAnywayBtn')!.click();
    expect(posted.filter((m) => m.type === 'save')).toHaveLength(1);
  });
});
