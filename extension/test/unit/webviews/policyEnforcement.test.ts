import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { RoleGuard } from '../../../src/enterprise/roleGuard';
import { registerRecordEditCommands } from '../../../src/commands/recordEdit';
import { RecordEditorPanel } from '../../../src/webviews/recordEditor';
import { ScriptRunnerPanel } from '../../../src/webviews/scriptRunner';
import { InMemoryMemento } from '../mocks';

const profile = { id: 'p1', name: 'Test', authMode: 'direct', serverUrl: 'https://fm.example.test', database: 'Sales' };
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const selection = { profileId: 'p1', layout: ' Exact Layout ', recordId: '1' };
const workspace = vscode.workspace as unknown as { getConfiguration: unknown; workspaceFolders: unknown; isTrusted: boolean };

describe('write policy at commands and open panels', () => {
  let root: string;
  let role: string;
  let posted: Array<Record<string, unknown>>;
  let profileStore: { getProfile: ReturnType<typeof vi.fn>; listProfiles: ReturnType<typeof vi.fn>; getActiveProfileId: ReturnType<typeof vi.fn> };
  let fmClient: { createRecord: ReturnType<typeof vi.fn>; editRecord: ReturnType<typeof vi.fn>; getRecord: ReturnType<typeof vi.fn>; runScript: ReturnType<typeof vi.fn> };
  const context = { extensionUri: { fsPath: '/ext' }, workspaceState: new InMemoryMemento() } as never;
  const schema = { getFields: vi.fn(async () => ({ supported: true, fields: [{ name: ' Exact Field ' }] })) };

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(join(tmpdir(), 'fm-policy-'));
    await mkdir(join(root, '.vscode'));
    role = 'developer';
    workspace.isTrusted = true;
    workspace.workspaceFolders = [{ uri: { fsPath: root } }];
    workspace.getConfiguration = vi.fn(() => ({ get: (key: string, fallback?: unknown) => key === 'enterprise.mode' ? true : key === 'enterprise.role' ? role : fallback }));
    posted = [];
    vi.mocked(vscode.window.createWebviewPanel).mockImplementation(() => ({
      webview: { html: '', cspSource: 'csp', asWebviewUri: (uri: unknown) => uri,
        postMessage: vi.fn(async (message) => { posted.push(message); return true; }), onDidReceiveMessage: vi.fn() },
      reveal: vi.fn(), onDidDispose: vi.fn()
    }) as never);
    vi.mocked(vscode.window.showWarningMessage).mockImplementation((async (message: string) => message.startsWith('Create') ? 'Create' : 'Save') as never);
    profileStore = { getProfile: vi.fn(async () => profile), listProfiles: vi.fn(async () => [profile]), getActiveProfileId: vi.fn(() => 'p1') };
    fmClient = {
      createRecord: vi.fn(async () => ({ recordId: '2', response: {}, messages: [] })),
      editRecord: vi.fn(async () => ({ recordId: '1', response: {}, messages: [] })),
      getRecord: vi.fn(async () => ({ recordId: '1', fieldData: { ' Exact Field ': 'old' } })),
      runScript: vi.fn(async () => ({ response: {}, messages: [] }))
    };
    (RecordEditorPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
    (ScriptRunnerPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

  async function disable(feature: string) {
    await writeFile(join(root, '.vscode/filemaker.config.json'), JSON.stringify({ disabledFeatures: [feature] }));
  }

  it.each(['openRecordEditor', 'editRecordById', 'createRecord', 'uploadContainer'])(
    'refuses command %s when writeOperations is disabled', async (command) => {
      await disable('writeOperations');
      const guard = new RoleGuard(logger);
      await guard.refresh();
      const open = vi.spyOn(RecordEditorPanel, 'createOrShow').mockImplementation(() => {});
      registerRecordEditCommands({ context, profileStore, fmClient, schemaService: schema,
        logger, roleGuard: guard, settingsService: { isRecordEditEnabled: () => true } } as never);
      await vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === `filemakerDataApiTools.${command}`)![1](selection);
      expect(profileStore.getProfile).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('disabled by'));
    }
  );

  function editor() {
    RecordEditorPanel.createOrShow(context, profileStore as never, fmClient as never, schema as never, logger as never);
    return (RecordEditorPanel as unknown as { currentPanel: { handleMessage(message: unknown): Promise<void> } }).currentPanel;
  }

  it.each(['saveRecord', 'createRecord'])(
    'refuses %s after the role changes while the editor is open', async (type) => {
      const panel = editor();
      await panel.handleMessage({ type: 'loadRecord', payload: selection });
      role = 'viewer';
      await panel.handleMessage({ type, payload: { ...selection, originalFieldData: { ' Exact Field ': 'old' }, draftFieldData: { ' Exact Field ': 'new' }, fieldData: { ' Exact Field ': 'new' } } });
      expect(fmClient.editRecord).not.toHaveBeenCalled();
      expect(fmClient.createRecord).not.toHaveBeenCalled();
      expect(posted).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringContaining('viewer') }));
    }
  );

  it.each(['saveRecord', 'createRecord'])('rechecks policy after the %s confirmation', async (type) => {
    const panel = editor();
    await panel.handleMessage({ type: 'loadRecord', payload: selection });
    vi.mocked(vscode.window.showWarningMessage).mockImplementation((async () => {
      role = 'viewer';
      return type === 'saveRecord' ? 'Save' : 'Create';
    }) as never);
    await panel.handleMessage({ type, payload: { ...selection, originalFieldData: { ' Exact Field ': 'old' }, draftFieldData: { ' Exact Field ': 'new' }, fieldData: { ' Exact Field ': 'new' } } });
    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    expect(fmClient.editRecord).not.toHaveBeenCalled();
    expect(fmClient.createRecord).not.toHaveBeenCalled();
    expect(posted).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringContaining('viewer') }));
  });

  it.each(['writeOperations', 'recordEdit'])(
    'refuses an open editor write after disabling %s in the enterprise file', async (feature) => {
      const panel = editor();
      await disable(feature);
      await panel.handleMessage({ type: 'createRecord', payload: { ...selection, fieldData: { ' Exact Field ': 'new' } } });
      expect(fmClient.createRecord).not.toHaveBeenCalled();
      expect(posted).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringContaining('disabled by') }));
    }
  );

  it.each(['role', 'feature'])('refuses an open Script Runner after a %s restriction', async (restriction) => {
    ScriptRunnerPanel.createOrShow(context, profileStore as never, fmClient as never, logger as never);
    if (restriction === 'role') role = 'viewer';
    else await disable('scriptRunner');
    const panel = (ScriptRunnerPanel as unknown as { currentPanel: { handleMessage(message: unknown): Promise<void> } }).currentPanel;
    await panel.handleMessage({ type: 'runScript', payload: { ...selection, scriptName: ' Exact Script ' } });
    expect(fmClient.runScript).not.toHaveBeenCalled();
    expect(posted).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringMatching(/viewer|disabled by/) }));
  });

  it('permits an allowed script with exact layout and script names', async () => {
    ScriptRunnerPanel.createOrShow(context, profileStore as never, fmClient as never, logger as never);
    const panel = (ScriptRunnerPanel as unknown as { currentPanel: { handleMessage(message: unknown): Promise<void> } }).currentPanel;
    await panel.handleMessage({ type: 'runScript', payload: { ...selection, scriptName: ' Exact Script ' } });
    expect(fmClient.runScript).toHaveBeenCalledWith(profile, expect.objectContaining({ layout: ' Exact Layout ', scriptName: ' Exact Script ' }));
  });
});
