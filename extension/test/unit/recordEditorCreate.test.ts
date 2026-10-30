import { readFileSync } from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import net from 'net';
import path from 'path';

import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { FMClient } from '../../src/services/fmClient';
import { SchemaService } from '../../src/services/schemaService';
import { SecretStore } from '../../src/services/secretStore';
import { RecordEditorPanel } from '../../src/webviews/recordEditor';
import { InMemorySecretStorage } from './mocks';
import { JSDOM, loadPage } from '../helpers/jsdomPage';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const workspace = vscode.workspace as unknown as { isTrusted: boolean; getConfiguration: ReturnType<typeof vi.fn> };

const profile = (serverUrl: string) => ({
  id: 'p1',
  name: 'Mock',
  authMode: 'direct' as const,
  serverUrl,
  database: 'Sales',
  username: 'tester',
  apiBasePath: '/fmi/data',
  apiVersionPath: 'vLatest'
});

/**
 * How many event-loop turns a message gets to answer on. The panel answers from promise
 * continuations, so a handful of turns is plenty; the budget only has to be big enough for
 * the slowest reply, and the answer is watched for rather than waited out.
 */
const ANSWER_TURNS = 200;

function openPanel(deps: { profileStore: unknown; fmClient: unknown; schemaService: unknown }) {
  const handlers: Array<(message: unknown) => void> = [];
  const posted: Array<{ type?: string; message?: string; payload?: Record<string, unknown> }> = [];
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
    webview: {
      html: '',
      cspSource: 'csp',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: vi.fn(async (message: never) => {
        posted.push(message);
        return true;
      }),
      onDidReceiveMessage: (handler: (message: unknown) => void) => {
        handlers.push(handler);
        return { dispose: vi.fn() };
      }
    },
    reveal: vi.fn(),
    onDidDispose: vi.fn()
  } as never);
  (RecordEditorPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  RecordEditorPanel.createOrShow(
    { extensionUri: { fsPath: '/ext' } } as never,
    deps.profileStore as never,
    deps.fmClient as never,
    deps.schemaService as never,
    logger,
    { mode: 'create' }
  );
  return {
    posted,
    /**
     * Sends a message and waits for the panel's answer.
     *
     * The panel answers on its own schedule, and it never answers a message it refuses to
     * parse. Each poll yields an event-loop turn rather than sleeping, so the wait keeps the
     * same number of chances to see the answer without costing a fixed second on every
     * message the panel ignores. A fixed sleep is what used to push this file past the test
     * timeout on a busy runner.
     */
    send: async (message: unknown) => {
      const before = posted.length;
      handlers.forEach((handler) => handler(message));
      for (let i = 0; i < ANSWER_TURNS && posted.length === before; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
    last: (type: string) => [...posted].reverse().find((m) => m.type === type)
  };
}

describe('Record Editor create mode (stubbed services)', () => {
  const fields = [{ name: 'Name' }, { name: 'Age' }];
  let createRecord: ReturnType<typeof vi.fn>;
  let panel: ReturnType<typeof openPanel>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.window.showWarningMessage).mockReset();
    workspace.isTrusted = true;
    workspace.getConfiguration.mockImplementation(() => ({ get: (_k: string, d?: unknown) => d }));
    createRecord = vi.fn(async () => ({ recordId: '501', modId: '0', response: {}, messages: [] }));
    panel = openPanel({
      profileStore: { getProfile: vi.fn(async () => profile('https://fm.example.com')), listProfiles: vi.fn(async () => []), getActiveProfileId: vi.fn() },
      fmClient: { createRecord },
      schemaService: { getFields: vi.fn(async () => ({ supported: true, fields, fromCache: false })) }
    });
  });

  const create = { type: 'createRecord', payload: { profileId: 'p1', layout: 'People', fieldData: { Name: 'Ada', Age: 36, Blank: '' } } };

  it.each(['Connection timed out', 'Connection timed out.'])('defensively reports a failed uncached field lookup: %s', async (reason) => {
    const getFields = vi.fn().mockRejectedValueOnce(new Error(reason))
      .mockResolvedValue({ supported: true, fields, fromCache: false });
    panel = openPanel({
      profileStore: { getProfile: vi.fn(async () => profile('https://fm.example.com')), listProfiles: vi.fn(async () => []), getActiveProfileId: vi.fn() },
      fmClient: { createRecord },
      schemaService: { getFields }
    });
    await panel.send(create);
    expect(panel.last('error')).toEqual({ type: 'error', message: "Could not load the layout's fields: Connection timed out. Try again." });
    expect(createRecord).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Create' as never);
    await panel.send(create);
    expect(getFields).toHaveBeenCalledTimes(2);
    expect(createRecord).toHaveBeenCalledOnce();
    expect(panel.last('recordCreated')?.payload).toMatchObject({ recordId: '501' });
  });

  it('reports field-list failures without presenting fields and can request the list again', async () => {
    const getFields = vi.fn().mockRejectedValueOnce(new Error('Fields unavailable'))
      .mockResolvedValueOnce({ supported: true, fields, fromCache: false });
    panel = openPanel({
      profileStore: { getProfile: vi.fn(async () => profile('https://fm.example.com')), listProfiles: vi.fn(async () => []), getActiveProfileId: vi.fn() },
      fmClient: { createRecord }, schemaService: { getFields }
    });
    const request = { type: 'loadLayoutFields', payload: { profileId: 'p1', layout: 'People' } };
    await panel.send(request);
    expect(panel.last('error')).toEqual({ type: 'error', message: 'Fields unavailable' });
    expect(panel.last('layoutFields')).toBeUndefined();
    expect(createRecord).not.toHaveBeenCalled();
    await panel.send(request);
    expect(panel.last('layoutFields')?.payload).toMatchObject({ fields });
  });

  it.skipIf(!JSDOM)('guards a real form submission after switching to a layout whose fields failed to load', async () => {
    const getFields = vi.fn().mockResolvedValueOnce({ supported: true, fields, fromCache: false })
      .mockRejectedValue(new Error('Connection timed out.'));
    panel = openPanel({
      profileStore: { getProfile: vi.fn(async () => profile('https://fm.example.com')), listProfiles: vi.fn(async () => []), getActiveProfileId: vi.fn() },
      fmClient: { createRecord }, schemaService: { getFields }
    });
    const html = (vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)?.value as { webview: { html: string } }).webview.html;
    const page = loadPage(html, readFileSync(path.resolve(__dirname, '../../src/webviews/recordEditor/ui/index.js'), 'utf8'));
    page.send({ type: 'init', payload: { profiles: [{ id: 'p1', name: 'P' }], activeProfileId: 'p1', defaults: { mode: 'create', profileId: 'p1', layout: 'People' } } });
    page.send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['People', 'Other'] } });
    await panel.send(page.posted.find((message) => message.type === 'loadLayoutFields'));
    page.send(panel.last('layoutFields'));
    page.window.eval("const input = document.querySelector('#fieldEditor input, #fieldEditor textarea'); input.value = 'Ada'; input.dispatchEvent(new Event('input')); const layout = document.getElementById('layoutSelect'); layout.value = 'Other'; layout.dispatchEvent(new Event('change'));");
    await panel.send(page.posted.filter((message) => message.type === 'loadLayoutFields').at(-1));
    page.send(panel.last('error'));
    page.document.getElementById('createButton')!.click();
    const submission = page.posted.find((message) => message.type === 'createRecord');
    expect(submission).toMatchObject({ payload: { layout: 'Other', fieldData: { Name: 'Ada' } } });
    await panel.send(submission);
    expect(panel.last('error')?.message).toBe("Could not load the layout's fields: Connection timed out. Try again.");
    page.send(panel.last('error'));
    expect(page.document.getElementById('createButton')!.getAttribute('disabled')).toBeNull();
    expect(getFields).toHaveBeenCalledTimes(3);
    expect(createRecord).not.toHaveBeenCalled();
  });

  it('uses the cached fields after the create form receives them', async () => {
    const getFields = vi.fn().mockResolvedValueOnce({ supported: true, fields, fromCache: false })
      .mockRejectedValue(new Error('Connection timed out.'));
    panel = openPanel({
      profileStore: { getProfile: vi.fn(async () => profile('https://fm.example.com')), listProfiles: vi.fn(async () => []), getActiveProfileId: vi.fn() },
      fmClient: { createRecord },
      schemaService: { getFields }
    });
    await panel.send({ type: 'loadLayoutFields', payload: { profileId: 'p1', layout: 'People' } });
    expect(panel.last('layoutFields')?.payload).toMatchObject({ fields });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Create' as never);
    await panel.send(create);
    expect(getFields).toHaveBeenCalledOnce();
    expect(createRecord).toHaveBeenCalledWith(expect.anything(), 'People', { Name: 'Ada', Age: 36 });
    expect(panel.last('error')).toBeUndefined();
  });

  it.each(['A\0B\u200bC\ufeffD', 'A\0B\0C\u200bD\ufeffE'].flatMap((value) =>
    [undefined, 'Cancel', 'Remove the character and continue'].map((choice) => ({ value, choice }))
  ))('handles NUL before creating: $value / $choice', async ({ value, choice }) => {
    vi.mocked(vscode.window.showWarningMessage).mockReset().mockResolvedValueOnce(choice as never).mockResolvedValueOnce('Create' as never);
    await panel.send({ ...create, payload: { ...create.payload, fieldData: { Name: value } } });
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Name'), { modal: true }, 'Remove the character and continue'
    );
    expect(vi.mocked(vscode.window.showWarningMessage).mock.calls[0]?.[0]).toContain('On the FileMaker server we tested, FileMaker kept only the text before this character and dropped the rest.');
    if (choice === 'Remove the character and continue') {
      expect(createRecord).toHaveBeenCalledWith(expect.anything(), 'People', { Name: value === 'A\0B\u200bC\ufeffD' ? 'AB\u200bC\ufeffD' : 'ABC\u200bD\ufeffE' });
    } else {
      expect(createRecord).not.toHaveBeenCalled();
      expect(panel.last('saveCancelled')).toBeDefined();
    }
  });

  it.each([undefined, 'Cancel', 'Remove the character and continue'])('warns that an all-NUL create value will be sent empty: %s', async (choice) => {
    vi.mocked(vscode.window.showWarningMessage).mockReset().mockResolvedValueOnce(choice as never).mockResolvedValueOnce('Create' as never);
    await panel.send({ ...create, payload: { ...create.payload, fieldData: { Name: '\0\0' } } });
    expect(vi.mocked(vscode.window.showWarningMessage).mock.calls[0]?.[0]).toContain('Removing the character will leave these fields empty: Name. They will be sent as empty values if you continue.');
    if (choice === 'Remove the character and continue') {
      expect(createRecord).toHaveBeenCalledWith(expect.anything(), 'People', { Name: '' });
    } else {
      expect(createRecord).not.toHaveBeenCalled();
      expect(panel.last('saveCancelled')).toBeDefined();
    }
  });

  it('names a repeating field made empty by removing NUL, and sends the cleaned repeats only after consent', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockReset().mockResolvedValueOnce('Remove the character and continue' as never).mockResolvedValueOnce('Create' as never);
    await panel.send({ ...create, payload: { ...create.payload, fieldData: { Name: ['\0'] } } });
    expect(vi.mocked(vscode.window.showWarningMessage).mock.calls[0]?.[0]).toContain('will leave these fields empty: Name.');
    expect(createRecord).toHaveBeenCalledWith(expect.anything(), 'People', { Name: [''] });
  });

  it('lists the layout fields without any record id', async () => {
    await panel.send({ type: 'loadLayoutFields', payload: { profileId: 'p1', layout: 'People' } });
    expect(panel.last('layoutFields')?.payload).toMatchObject({ metadataSupported: true, fields: [{ name: 'Name' }, { name: 'Age' }] });
  });

  it('passes field kind and global scope to the create form', async () => {
    const fields = [{ name: ' Calc ', type: 'calculation', result: 'number' }, { name: 'Global', type: 'normal', result: 'text', global: true }];
    const panel = openPanel({
      profileStore: { getProfile: vi.fn(async () => profile('https://fm.example.com')), listProfiles: vi.fn(async () => []), getActiveProfileId: vi.fn() },
      fmClient: { createRecord },
      schemaService: { getFields: vi.fn(async () => ({ supported: true, fields, fromCache: false })) }
    });
    await panel.send({ type: 'loadLayoutFields', payload: { profileId: 'p1', layout: ' Layout ' } });
    expect(panel.last('layoutFields')?.payload).toMatchObject({ layout: ' Layout ', fields });
  });

  it('creates without requiring values for read-only calculation, summary and container fields', async () => {
    const fields = [
      { name: ' Name ', type: 'normal', result: 'text', required: true },
      { name: 'Calc', type: 'calculation', result: 'number', required: true },
      { name: 'Summary', type: 'summary', result: 'number', required: true },
      { name: 'Photo', type: 'normal', result: 'container', required: true },
      { name: 'Global', type: 'normal', result: 'text', global: true, required: true }
    ];
    const panel = openPanel({
      profileStore: { getProfile: vi.fn(async () => profile('https://fm.example.com')), listProfiles: vi.fn(async () => []), getActiveProfileId: vi.fn() },
      fmClient: { createRecord },
      schemaService: { getFields: vi.fn(async () => ({ supported: true, fields, fromCache: false })) }
    });
    await panel.send({ type: 'loadLayoutFields', payload: { profileId: 'p1', layout: ' Layout ' } });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Create' as never);
    await panel.send({ type: 'createRecord', payload: { profileId: 'p1', layout: ' Layout ', fieldData: { ' Name ': 'Ada', Global: 'session' } } });
    expect(createRecord).toHaveBeenCalledWith(expect.anything(), ' Layout ', { ' Name ': 'Ada', Global: 'session' });
    createRecord.mockClear();
    await panel.send({ type: 'createRecord', payload: { profileId: 'p1', layout: ' Layout ', fieldData: { ' Name ': 'Ada' } } });
    expect(createRecord).not.toHaveBeenCalled();
    expect(panel.last('error')?.message).toContain('Global: Field is required');
  });

  it('filters read-only repetition values in the host create handler and keeps exact editable names', async () => {
    const fields = [
      { name: ' Name ', type: 'normal', required: true },
      { name: 'Calc', type: ' Calculation ', required: true },
      { name: 'Summary', type: ' SUMMARY ', required: true },
      { name: 'Photo', result: ' Container ', required: true },
      { name: 'Qty', result: 'number', maxRepeat: 2 }
    ];
    const panel = openPanel({
      profileStore: { getProfile: vi.fn(async () => profile('https://fm.example.com')), listProfiles: vi.fn(async () => []), getActiveProfileId: vi.fn() },
      fmClient: { createRecord },
      schemaService: { getFields: vi.fn(async () => ({ supported: true, fields })) }
    });
    await panel.send({ type: 'loadLayoutFields', payload: { profileId: 'p1', layout: ' Layout ' } });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Create' as never);
    await panel.send({ type: 'createRecord', payload: { profileId: 'p1', layout: ' Layout ', fieldData: { ' Name ': 'Ada', 'Calc(1)': 5, 'Summary(2)': 6, 'Photo(1)': 'url', 'Qty(2)': 3 } } });
    expect(createRecord).toHaveBeenCalledWith(expect.anything(), ' Layout ', { ' Name ': 'Ada', 'Qty(2)': 3 });
  });

  it('uses host metadata to filter a create request even before the page has loaded fields', async () => {
    const panel = openPanel({
      profileStore: { getProfile: vi.fn(async () => profile('https://fm.example.com')), listProfiles: vi.fn(async () => []), getActiveProfileId: vi.fn() },
      fmClient: { createRecord },
      schemaService: { getFields: vi.fn(async () => ({ supported: true, fields: [{ name: 'Name' }, { name: 'Calc', type: 'calculation' }] })) }
    });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Create' as never);
    await panel.send({ type: 'createRecord', payload: { profileId: 'p1', layout: 'People', fieldData: { Name: 'Ada', 'Calc(2)': 5 } } });
    expect(createRecord).toHaveBeenCalledWith(expect.anything(), 'People', { Name: 'Ada' });
  });

  it('refuses names that are not fields of the layout, before asking or calling FileMaker', async () => {
    await panel.send({ type: 'loadLayoutFields', payload: { profileId: 'p1', layout: 'People' } });
    await panel.send({ ...create, payload: { ...create.payload, fieldData: { Name: 'Ada', Extra: 'x' } } });
    expect(panel.last('error')?.message).toMatch(/not fields on layout "People": Extra/);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(createRecord).not.toHaveBeenCalled();
  });

  it('creates after confirmation (empty values dropped) and shows the id', async () => {
    await panel.send({ type: 'loadLayoutFields', payload: { profileId: 'p1', layout: 'People' } });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Create' as never);
    await panel.send({ ...create, payload: { ...create.payload, fieldData: { Name: 'Ada', Age: '' } } });
    expect(createRecord).toHaveBeenCalledWith(expect.anything(), 'People', { Name: 'Ada' });
    expect(panel.last('recordCreated')?.payload).toMatchObject({ recordId: '501', layout: 'People' });
    expect(vi.mocked(vscode.window.showWarningMessage).mock.calls[0]?.[1]).toMatchObject({ modal: true });
  });

  it('does nothing when the confirmation is declined', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);
    await panel.send({ ...create, payload: { ...create.payload, fieldData: { Name: 'Ada' } } });
    expect(createRecord).not.toHaveBeenCalled();
    expect(panel.last('saveCancelled')).toBeDefined();
  });

  it('refuses an empty form, malformed payloads, offline mode, and a user switch-off of record editing', async () => {
    await panel.send({ ...create, payload: { ...create.payload, fieldData: { Name: '' } } });
    expect(panel.last('error')?.message).toMatch(/At least one field/);

    const before = panel.posted.length;
    await panel.send({ type: 'createRecord', payload: { profileId: 'p1', layout: 'People', fieldData: [1] } });
    await panel.send({ type: 'createRecord', payload: { profileId: 'p1', fieldData: { a: 1 } } });
    expect(panel.posted.length).toBe(before); // unparsable messages are ignored
    expect(createRecord).not.toHaveBeenCalled();

    workspace.getConfiguration.mockImplementation(() => ({
      get: (_k: string, d?: unknown) => d,
      inspect: (key: string) => (key === 'features.recordEdit.enabled' ? { defaultValue: true, globalValue: false } : undefined)
    }));
    await panel.send(create);
    expect(panel.last('error')?.message).toMatch(/features\.recordEdit\.enabled/);

    workspace.getConfiguration.mockImplementation(() => ({
      get: (_k: string, d?: unknown) => d,
      inspect: (key: string) => (key === 'offline.mode' ? { defaultValue: false, globalValue: true } : undefined)
    }));
    await panel.send(create);
    expect(panel.last('error')?.message).toMatch(/Offline mode/);
    expect(createRecord).not.toHaveBeenCalled();
    // Five messages wait for an answer here, so the default five-second timeout is a margin
    // for a loaded runner rather than a budget for the work.
  }, 20_000);

  it('refuses in an untrusted workspace', async () => {
    workspace.isTrusted = false;
    await panel.send(create);
    expect(panel.last('error')?.message).toMatch(/untrusted workspaces/);
    expect(createRecord).not.toHaveBeenCalled();
  });

  it('shows the field list and form controls for create mode in the page', () => {
    const html = (vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)?.value as { webview: { html: string } }).webview.html;
    expect(html).toContain('id="createButton"');
    expect(html).toContain('id="recordIdRow"');
  });
});

describe('Record Editor create mode against the mock FileMaker server', () => {
  let child: ChildProcess;
  let base = '';

  beforeAll(async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port: free } = probe.address() as net.AddressInfo;
        probe.close(() => resolve(free));
      });
    });
    child = spawn(process.execPath, [path.resolve(__dirname, '../mock-server/server.mjs')], {
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore'
    });
    base = `http://127.0.0.1:${port}`;
    nock.enableNetConnect('127.0.0.1');
    for (let i = 0; i < 100; i += 1) {
      try {
        await fetch(`${base}/__admin/reset`, { method: 'POST' });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error('mock server did not start');
  }, 20_000);

  afterAll(() => {
    child?.kill();
    nock.disableNetConnect();
  });

  afterEach(() => {
    workspace.isTrusted = true;
  });

  it('lists the fields, creates a record through the real client, and the record exists', async () => {
    workspace.isTrusted = true;
    workspace.getConfiguration.mockImplementation(() => ({ get: (_k: string, d?: unknown) => d }));
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    await secrets.setPassword('p1', 'testpass1');
    const fmClient = new FMClient(secrets, { debug() {}, info() {}, warn() {}, error() {} } as never, 5000);
    const schemaService = new SchemaService(fmClient, { debug() {}, info() {}, warn() {}, error() {} });
    const p = profile(base);
    const panel = openPanel({
      profileStore: { getProfile: vi.fn(async () => p), listProfiles: vi.fn(async () => [p]), getActiveProfileId: vi.fn(() => 'p1') },
      fmClient,
      schemaService
    });

    await panel.send({ type: 'loadLayoutFields', payload: { profileId: 'p1', layout: 'Contacts' } });
    const listed = panel.last('layoutFields')?.payload as { fields: Array<{ name: string }> };
    expect(listed.fields.map((f) => f.name)).toContain('Email');

    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Create' as never);
    await panel.send({
      type: 'createRecord',
      payload: { profileId: 'p1', layout: 'Contacts', fieldData: { FirstName: 'Created', Email: 'created@example.test', Notes: '' } }
    });

    const created = panel.last('recordCreated')?.payload as { recordId: string };
    expect(created.recordId).toMatch(/^\d+$/);
    const fetched = await fmClient.getRecord(p, 'Contacts', created.recordId);
    expect(fetched.fieldData).toMatchObject({ FirstName: 'Created', Email: 'created@example.test' });

    // A field the layout does not have is refused before FileMaker is asked.
    const errors = panel.posted.filter((m) => m.type === 'error').length;
    await panel.send({ type: 'createRecord', payload: { profileId: 'p1', layout: 'Contacts', fieldData: { NoSuchField: 'x' } } });
    expect(panel.posted.filter((m) => m.type === 'error').length).toBe(errors + 1);
  }, 20_000);
});
