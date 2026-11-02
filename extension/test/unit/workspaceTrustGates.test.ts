import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { registerRecordEditCommands } from '../../src/commands/recordEdit';
import { registerScriptRunnerCommands } from '../../src/commands/scriptRunner';
import { RoleGuard } from '../../src/enterprise/roleGuard';
import { RecordEditorPanel } from '../../src/webviews/recordEditor';
import { ScriptRunnerPanel } from '../../src/webviews/scriptRunner';

const workspace = vscode.workspace as unknown as { isTrusted: boolean };

function makeGuard(trusted: boolean): RoleGuard {
  return new RoleGuard(
    { debug: vi.fn(), warn: vi.fn() },
    {
      getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }) as never,
      isWorkspaceTrusted: () => trusted,
      getWorkspaceRoot: () => undefined,
      readConfigFile: async () => undefined
    }
  );
}

function commandHandler(name: string): (arg?: unknown) => Promise<unknown> {
  const call = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === name);
  if (!call) {
    throw new Error(`command not registered: ${name}`);
  }
  return call[1] as (arg?: unknown) => Promise<unknown>;
}

const profile = { id: 'p1', name: 'Dev', authMode: 'direct', serverUrl: 'https://fm.example.com', database: 'DB' };

function recordDeps(trusted: boolean) {
  const fmClient = { listLayouts: vi.fn(), uploadContainer: vi.fn(), deleteRecord: vi.fn() };
  const profileStore = {
    getProfile: vi.fn().mockResolvedValue(profile),
    listProfiles: vi.fn().mockResolvedValue([profile]),
    getActiveProfileId: vi.fn().mockReturnValue('p1')
  };
  return {
    fmClient,
    profileStore,
    deps: {
      context: { subscriptions: [], extensionUri: { fsPath: '/ext' } } as never,
      profileStore: profileStore as never,
      fmClient: fmClient as never,
      schemaService: {} as never,
      settingsService: {
        isRecordEditEnabled: vi.fn().mockReturnValue(true),
        getContainerUploadMaxBytes: vi.fn().mockReturnValue(4)
      } as never,
      roleGuard: makeGuard(trusted),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
    }
  };
}

describe('RoleGuard trust gating', () => {
  it.each(['recordEdit', 'scriptRunner', 'pluginInstall'] as const)(
    'refuses %s in an untrusted workspace and allows it in a trusted one',
    (feature) => {
      const refused = makeGuard(false).getFeatureGuard(feature);
      expect(refused.allowed).toBe(false);
      expect(refused.reason).toContain('untrusted workspaces');
      expect(makeGuard(true).getFeatureGuard(feature).allowed).toBe(true);
    }
  );

  it('does not trust-gate writeOperations (it also guards the user\'s own profile and set edits)', () => {
    expect(makeGuard(false).getFeatureGuard('writeOperations').allowed).toBe(true);
  });
});

describe('record and script commands in an untrusted workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspace.isTrusted = true;
  });

  it.each([
    ['filemakerDataApiTools.openRecordEditor', 'Open Record Editor'],
    ['filemakerDataApiTools.editRecordById', 'Edit Record by ID'],
    ['filemakerDataApiTools.createRecord', 'Create Record'],
    ['filemakerDataApiTools.uploadContainer', 'Upload to Container']
  ])('%s refuses with a clear message before touching a profile', async (command, label) => {
    const { deps, profileStore, fmClient } = recordDeps(false);
    registerRecordEditCommands(deps);

    await commandHandler(command)({});

    const message = vi.mocked(vscode.window.showWarningMessage).mock.calls[0]?.[0];
    expect(message).toContain(label);
    expect(message).toContain('untrusted workspaces');
    expect(profileStore.listProfiles).not.toHaveBeenCalled();
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
    expect(fmClient.uploadContainer).not.toHaveBeenCalled();
  });

  it('Open Script Runner refuses in an untrusted workspace', async () => {
    const { profileStore, fmClient } = recordDeps(false);
    registerScriptRunnerCommands({
      context: {} as never,
      profileStore: profileStore as never,
      fmClient: fmClient as never,
      roleGuard: makeGuard(false),
      logger: {} as never
    });

    await commandHandler('filemakerDataApiTools.openScriptRunner')({});

    const message = vi.mocked(vscode.window.showWarningMessage).mock.calls[0]?.[0];
    expect(message).toContain('untrusted workspaces');
    expect(profileStore.listProfiles).not.toHaveBeenCalled();
    expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
  });
});

function fakePanel() {
  const handlers: Array<(message: unknown) => void> = [];
  const postMessage = vi.fn(async (...args: unknown[]) => args.length >= 0);
  const panel = {
    webview: {
      html: '',
      cspSource: 'csp',
      postMessage,
      asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage: (handler: (message: unknown) => void) => {
        handlers.push(handler);
        return { dispose: vi.fn() };
      }
    },
    reveal: vi.fn(),
    onDidDispose: vi.fn()
  };
  return { panel, postMessage, send: async (m: unknown) => { handlers.forEach((h) => h(m)); await new Promise((r) => setTimeout(r, 0)); } };
}

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

describe('webview panels in an untrusted workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspace.isTrusted = true;
  });

  it('the record editor panel will not open, and refuses save/create messages if trust is lost', async () => {
    const { fmClient, profileStore } = recordDeps(true);
    workspace.isTrusted = false;
    RecordEditorPanel.createOrShow({ extensionUri: { fsPath: '/ext' } } as never, profileStore as never, fmClient as never, {} as never, logger);
    expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();

    workspace.isTrusted = true;
    const fake = fakePanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(fake.panel as never);
    RecordEditorPanel.createOrShow({ extensionUri: { fsPath: '/ext' } } as never, profileStore as never, fmClient as never, {} as never, logger);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);

    workspace.isTrusted = false;
    const draft = { profileId: 'p1', layout: 'L', recordId: '1', originalFieldData: { a: 1 }, draftFieldData: { a: 2 } };
    await fake.send({ type: 'saveRecord', payload: draft });
    await fake.send({ type: 'loadRecord', payload: draft });
    // The immediate receipt lets the page distinguish this live refusal from a disconnected panel.
    expect(fake.postMessage.mock.calls[0]?.[0]).toMatchObject({ type: 'saveReceived' });
    expect(profileStore.getProfile).not.toHaveBeenCalled();
    const errors = fake.postMessage.mock.calls
      .map((c) => JSON.stringify(c[0]))
      .filter((message) => message.includes('"type":"error"'));
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.every((e) => e.includes('untrusted workspaces'))).toBe(true);
  });

  it('the script runner panel will not open, and refuses runScript if trust is lost', async () => {
    const { fmClient, profileStore } = recordDeps(true);
    (fmClient as unknown as Record<string, unknown>).runScript = vi.fn();
    workspace.isTrusted = false;
    ScriptRunnerPanel.createOrShow({ extensionUri: { fsPath: '/ext' } } as never, profileStore as never, fmClient as never, logger);
    expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();

    workspace.isTrusted = true;
    const fake = fakePanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(fake.panel as never);
    ScriptRunnerPanel.createOrShow({ extensionUri: { fsPath: '/ext' } } as never, profileStore as never, fmClient as never, logger);

    workspace.isTrusted = false;
    await fake.send({ type: 'runScript', payload: { profileId: 'p1', layout: 'L', scriptName: 'S' } });
    expect((fmClient as unknown as { runScript: ReturnType<typeof vi.fn> }).runScript).not.toHaveBeenCalled();
    expect(JSON.stringify(fake.postMessage.mock.calls.at(-1)?.[0])).toContain('untrusted workspaces');
  });
});

describe('Delete Record policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspace.isTrusted = true;
  });

  function guardWith(options: { role?: string; disabled?: string[]; mode?: boolean }): RoleGuard {
    const guard = new RoleGuard(
      { debug: vi.fn(), warn: vi.fn() },
      {
        getConfiguration: () =>
          ({
            get: (key: string, fallback?: unknown) =>
              ({ 'enterprise.mode': options.mode ?? false, 'enterprise.role': options.role ?? 'developer' })[key] ?? fallback
          }) as never,
        isWorkspaceTrusted: () => true,
        getWorkspaceRoot: () => '/ws',
        readConfigFile: async () => (options.disabled ? JSON.stringify({ disabledFeatures: options.disabled }) : undefined)
      }
    );
    return guard;
  }

  async function runDelete(guard: RoleGuard, recordEditEnabled: boolean) {
    await guard.refresh();
    const { deps, fmClient } = recordDeps(true);
    deps.roleGuard = guard;
    (deps.settingsService as unknown as { isRecordEditEnabled: ReturnType<typeof vi.fn> }).isRecordEditEnabled.mockReturnValue(
      recordEditEnabled
    );
    registerRecordEditCommands(deps);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue('5');
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Delete' as never);
    await commandHandler('filemakerDataApiTools.deleteRecord')({ profileId: 'p1', layout: 'L' });
    return fmClient;
  }

  it('is refused when record editing is switched off by setting', async () => {
    const fmClient = await runDelete(guardWith({}), false);
    expect(fmClient.deleteRecord).not.toHaveBeenCalled();
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
  });

  it("is refused when enterprise disabledFeatures lists 'recordEdit'", async () => {
    const fmClient = await runDelete(guardWith({ disabled: ['recordEdit'] }), true);
    expect(fmClient.deleteRecord).not.toHaveBeenCalled();
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
  });

  it('is refused for the enterprise viewer role', async () => {
    const fmClient = await runDelete(guardWith({ mode: true, role: 'viewer' }), true);
    expect(fmClient.deleteRecord).not.toHaveBeenCalled();
  });

  it('opens only one Delete dialog during rapid repeated commands and allows retry after cancellation', async () => {
    const guard = guardWith({}); await guard.refresh();
    const { deps } = recordDeps(true); deps.roleGuard = guard;
    registerRecordEditCommands(deps);
    let finish!: (value: undefined) => void;
    vi.mocked(vscode.window.showInputBox).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const run = commandHandler('filemakerDataApiTools.deleteRecord');
    const pending = Array.from({ length: 15 }, () => run({ profileId: 'p1', layout: 'L' }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(vscode.window.showInputBox).toHaveBeenCalledTimes(1);
    finish(undefined); await Promise.all(pending);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined);
    await run({ profileId: 'p1', layout: 'L' });
    expect(vscode.window.showInputBox).toHaveBeenCalledTimes(2);
  });

  it('still works for a developer with record editing on', async () => {
    const fmClient = await runDelete(guardWith({}), true);
    expect(fmClient.deleteRecord).toHaveBeenCalledWith(expect.anything(), 'L', '5');
  });
});
