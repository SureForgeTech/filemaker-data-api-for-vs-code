import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const lazyModules = vi.hoisted(() => ({
  fmClientModuleLoaded: vi.fn(),
  fmClientConstructed: vi.fn(),
  createSession: vi.fn(async () => 'token'),
  batchServiceModuleLoaded: vi.fn(),
  circuitBreakerModuleLoaded: vi.fn(),
  backoffModuleLoaded: vi.fn(),
  retryWithBackoff: vi.fn(async (operation: () => Promise<unknown>) => operation())
}));

vi.mock('../../src/services/fmClient', () => {
  lazyModules.fmClientModuleLoaded();

  return {
    FMClient: class {
      public constructor(...args: unknown[]) {
        lazyModules.fmClientConstructed(...args);
      }

      public createSession = lazyModules.createSession;
      public deleteSession = async (): Promise<void> => {};
      public listLayouts = async (): Promise<string[]> => [];
      public listScripts = async (): Promise<string[]> => [];
      public getRecord = async (): Promise<Record<string, unknown>> => ({});
      public findRecords = async (): Promise<Record<string, unknown>> => ({});
      public getLayoutMetadata = async (): Promise<Record<string, unknown>> => ({});
      public editRecord = async (): Promise<Record<string, unknown>> => ({});
      public createRecord = async (): Promise<Record<string, unknown>> => ({});
      public deleteRecord = async (): Promise<Record<string, unknown>> => ({});
      public runScript = async (): Promise<Record<string, unknown>> => ({});
      public invalidateProfileCache(): void {}
      public onProfileInvalidated(): () => void {
        return () => undefined;
      }
      public onHealthChange(): () => void {
        return () => undefined;
      }
      public getHealth(): undefined {
        return undefined;
      }
      public isSignInPaused(): boolean {
        return false;
      }
      public clearAuthPause(): void {}
      public shouldRefreshSession(): boolean {
        return false;
      }
    }
  };
});

vi.mock('../../src/services/batchService', () => {
  lazyModules.batchServiceModuleLoaded();

  return {
    BatchService: class {
      public getDefaultBatchUpdateOptions(): { dryRun: boolean; concurrency: number } {
        return { dryRun: true, concurrency: 4 };
      }

      public batchExportFind = async (): Promise<Record<string, unknown>> => ({});
      public batchUpdate = async (): Promise<Record<string, unknown>> => ({});
    },
    inferExportFormat: vi.fn(() => 'jsonl'),
    parseBatchUpdateInput: vi.fn(() => [])
  };
});

vi.mock('../../src/performance/circuitBreakerRegistry', () => {
  lazyModules.circuitBreakerModuleLoaded();

  return {
    CircuitBreakerRegistry: class {
      public list(): unknown[] {
        return [];
      }

      public register(): void {}
      public recordTransition(): void {}
      public unregister(): void {}
    },
    renderCircuitBreakerStatus: vi.fn(() => '# Circuit breakers')
  };
});

vi.mock('../../src/utils/backoff', () => {
  lazyModules.backoffModuleLoaded();

  return {
    retryWithBackoff: lazyModules.retryWithBackoff
  };
});

describe('extension lazy FM runtime loading', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(vscode.commands.executeCommand).mockReset();
    vi.mocked(vscode.window.showWarningMessage).mockReset().mockResolvedValue(undefined);
    installActivationVsCodeMocks();
    // Avoid filesystem reads from an earlier activation completing during the next test.
    const { FmWebProjectService } = await import('../../src/services/fmWebProjectService');
    const { SchemaSnapshotStore } = await import('../../src/services/schemaSnapshotStore');
    vi.spyOn(FmWebProjectService.prototype, 'readProjectConfig').mockResolvedValue(undefined);
    vi.spyOn(SchemaSnapshotStore.prototype, 'listSnapshots').mockResolvedValue([]);
  });

  afterEach(() => vi.restoreAllMocks());

  it('keeps job progress visible while cancellation waits for pending work', async () => {
    const { JobRunner } = await import('../../src/services/jobRunner');
    const subscription = vi.spyOn(JobRunner.prototype, 'onDidChange');
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();
    await activate(context);
    const runner = subscription.mock.contexts[0] as InstanceType<typeof JobRunner>;
    let finish!: () => void;
    const handle = runner.startJob('Import', async (job) => {
      job.reportProgress(40);
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    const status = vi.mocked(vscode.window.createStatusBarItem).mock.results
      .map((result) => result.value as { command: string; text: string })
      .find((item) => item.command === 'filemakerDataApiTools.showJobs')!;
    expect(status.text).toBe('$(sync~spin) FM Job: Import 40%');
    handle.cancel();
    expect(status.text).toBe('$(sync~spin) FM Job: Import cancelling 40%');
    finish();
    await vi.waitFor(() => expect(status.text).toBe('$(history) FM Jobs: idle'));
    expect(lazyModules.fmClientConstructed).not.toHaveBeenCalled();
    disposeSubscriptions(context);
  });

  it('does not load FM client, retry, batch, or circuit-breaker modules during activation', async () => {
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();

    await activate(context);
    disposeSubscriptions(context);

    expect(lazyModules.fmClientModuleLoaded).not.toHaveBeenCalled();
    expect(lazyModules.backoffModuleLoaded).not.toHaveBeenCalled();
    expect(lazyModules.batchServiceModuleLoaded).not.toHaveBeenCalled();
    expect(lazyModules.circuitBreakerModuleLoaded).not.toHaveBeenCalled();
  });

  it('registers every contributed command during activation', async () => {
    // A command listed in package.json but never registered shows in menus and the
    // palette, then fails with "command not found" when run.
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();
    await activate(context);

    const registered = new Set(vi.mocked(vscode.commands.registerCommand).mock.calls.map(([id]) => id));
    disposeSubscriptions(context);

    const { contributes } = (await import('../../package.json')) as {
      contributes: { commands: Array<{ command: string }> };
    };
    expect(contributes.commands.map(({ command }) => command).filter((id) => !registered.has(id))).toEqual([]);
  });

  it('shows the installed version at activation: runtime version, Output line, Explorer description, status bar', async () => {
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();
    await activate(context);
    disposeSubscriptions(context);

    const { getRuntimeVersion } = await import('../../src/about/runtimeVersion');
    expect(getRuntimeVersion()).toBe('1.1.0');

    const channel = vi.mocked(vscode.window.createOutputChannel).mock.results[0]?.value as { appendLine: ReturnType<typeof vi.fn> };
    const lines = channel.appendLine.mock.calls.map(([line]) => String(line));
    expect(lines.some((line) => line.includes('FileMaker Data API Tools v1.1.0 (unknown) on VS Code 1.96.0'))).toBe(true);

    const treeCall = vi.mocked(vscode.window.createTreeView).mock.calls.findIndex(([id]) => id === 'filemakerExplorer');
    const tree = vi.mocked(vscode.window.createTreeView).mock.results[treeCall]?.value as { description?: string };
    expect(tree.description).toBe('v1.1.0');

    const tooltips = vi.mocked(vscode.window.createStatusBarItem).mock.results.map((r) => String((r.value as { tooltip?: string }).tooltip));
    expect(tooltips.some((tooltip) => tooltip.includes('FileMaker Data API Tools v1.1.0'))).toBe(true);
  });

  it('only asks the AI server controller to autostart (it starts nothing by itself), once', async () => {
    const { AiMcpController } = await import('../../src/ai/mcp/aiMcpController');
    const autostart = vi.spyOn(AiMcpController.prototype, 'autostart').mockResolvedValue(undefined);
    const start = vi.spyOn(AiMcpController.prototype, 'start').mockResolvedValue(undefined);
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();
    await activate(context);
    disposeSubscriptions(context);

    expect(autostart).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    autostart.mockRestore();
    start.mockRestore();
  });

  it('stops the AI server when the external-server permission setting changes, and ignores other settings', async () => {
    const { AiMcpController } = await import('../../src/ai/mcp/aiMcpController');
    const handle = vi.spyOn(AiMcpController.prototype, 'handleSettingChange').mockResolvedValue(undefined);
    vi.spyOn(AiMcpController.prototype, 'autostart').mockResolvedValue(undefined);
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();
    await activate(context);

    const listeners = vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls.map(([listener]) => listener);
    for (const listener of listeners) {
      listener({ affectsConfiguration: (section: string) => section === 'filemaker.offline' } as never);
    }
    expect(handle).not.toHaveBeenCalled();
    for (const listener of listeners) {
      listener({ affectsConfiguration: (section: string) => section === 'filemaker.ai.externalServer' } as never);
    }
    expect(handle).toHaveBeenCalledTimes(1);
    disposeSubscriptions(context);
    vi.restoreAllMocks();
  });

  it('refreshes connection status and AI tools when another window changes a profile or a secret', async () => {
    const { ProfileStore } = await import('../../src/services/profileStore');
    const { ConnectionStatusBar } = await import('../../src/views/connectionStatusBar');
    const { AiToolsController } = await import('../../src/ai/aiRegistration');
    const status = vi.spyOn(ConnectionStatusBar.prototype, 'refresh');
    const ai = vi.spyOn(AiToolsController.prototype, 'refresh');
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();
    await activate(context);
    status.mockClear();
    ai.mockClear();
    const profiles = [{ id: 'p2', name: 'Changed elsewhere', authMode: 'direct', serverUrl: 'https://fm.example.test', database: 'Other', aiAccess: 'none' }];
    vi.mocked(context.globalState.get).mockImplementation(((key: string, fallback: unknown) =>
      key === 'filemakerDataApiTools.profiles' ? profiles : key === 'filemakerDataApiTools.activeProfileId' ? 'p2' : fallback) as never);
    // Configuration and secret events also check shared state; a timer handles profile-only changes.
    const check = vi.spyOn(ProfileStore.prototype, 'checkForExternalChanges');
    for (const [listener] of vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls) {
      listener({ affectsConfiguration: () => false } as never);
    }
    expect(check).toHaveBeenCalled();
    expect(status).toHaveBeenCalled();
    expect(ai).toHaveBeenCalled();
    await expect.poll(() => vi.mocked(vscode.window.createStatusBarItem).mock.results
      .some((r) => String((r.value as { text: string }).text).includes('Changed elsewhere'))).toBe(true);
    status.mockClear();
    ai.mockClear();
    const secretListener = vi.mocked(context.secrets.onDidChange).mock.calls[0]?.[0];
    expect(secretListener).toBeTypeOf('function');
    secretListener?.({ key: 'filemakerDataApiTools.profile.password.p2' });
    expect(status).toHaveBeenCalled();
    expect(ai).toHaveBeenCalled();
    disposeSubscriptions(context);
    vi.restoreAllMocks();
  });

  it('loads and caches the FM client module on the first Connect command', async () => {
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();
    await activate(context);

    const connect = registeredCommand('filemakerDataApiTools.connect');
    await connect({ profileId: 'p1' });
    await connect({ profileId: 'p1' });
    disposeSubscriptions(context);

    expect(lazyModules.backoffModuleLoaded).toHaveBeenCalledTimes(1);
    expect(lazyModules.fmClientModuleLoaded).toHaveBeenCalledTimes(1);
    expect(lazyModules.fmClientConstructed).toHaveBeenCalledTimes(1);
    expect(lazyModules.retryWithBackoff).toHaveBeenCalledTimes(2);
    expect(lazyModules.createSession).toHaveBeenCalledTimes(2);
    expect(lazyModules.batchServiceModuleLoaded).not.toHaveBeenCalled();
    expect(lazyModules.circuitBreakerModuleLoaded).not.toHaveBeenCalled();
  });

  it('re-reads the Command Palette context keys when a profile is saved or removed and when the FM Web project is created', async () => {
    const { ProfileStore } = await import('../../src/services/profileStore');
    const { FmWebProjectService } = await import('../../src/services/fmWebProjectService');
    const profileListeners: Array<() => void> = [];
    const projectListeners: Array<() => void> = [];
    vi.spyOn(ProfileStore.prototype, 'onDidChange').mockImplementation((listener: () => void) => {
      profileListeners.push(listener);
      return { dispose: () => undefined };
    });
    vi.spyOn(FmWebProjectService.prototype, 'onDidChangeProject').mockImplementation((listener: () => void) => {
      projectListeners.push(listener);
      return { dispose: () => undefined };
    });
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();
    await activate(context);
    const keyCalls = (key: string) =>
      vi.mocked(vscode.commands.executeCommand).mock.calls.filter(([command, name]) => command === 'setContext' && name === key).length;
    await vi.waitFor(() => {
      expect(keyCalls('filemaker.hasProfiles')).toBeGreaterThan(0);
      expect(keyCalls('filemaker.fmWebProjectInitialized')).toBeGreaterThan(0);
    });

    expect(profileListeners).toHaveLength(1);
    expect(projectListeners).toHaveLength(1);
    const profileKeyBefore = keyCalls('filemaker.hasProfiles');
    profileListeners[0]?.();
    await vi.waitFor(() => expect(keyCalls('filemaker.hasProfiles')).toBe(profileKeyBefore + 1));

    const projectKeyBefore = keyCalls('filemaker.fmWebProjectInitialized');
    projectListeners[0]?.();
    await vi.waitFor(() => expect(keyCalls('filemaker.fmWebProjectInitialized')).toBe(projectKeyBefore + 1));

    // A project.json created, changed or deleted outside the extension is noticed as well.
    const watcherCalls = vi.mocked(vscode.workspace.createFileSystemWatcher).mock.calls.map(([pattern]) => String(pattern));
    expect(watcherCalls).toContain('**/.fmweb/project.json');
    const watcher = vi.mocked(vscode.workspace.createFileSystemWatcher).mock.results[
      vi.mocked(vscode.workspace.createFileSystemWatcher).mock.calls.findIndex(([pattern]) => String(pattern) === '**/.fmweb/project.json')
    ]?.value as Record<'onDidChange' | 'onDidCreate' | 'onDidDelete', ReturnType<typeof vi.fn>>;
    for (const event of ['onDidCreate', 'onDidChange', 'onDidDelete'] as const) {
      const callback = watcher[event].mock.calls[0]?.[0] as (() => void) | undefined;
      expect(callback, event).toBeTypeOf('function');
      const before = keyCalls('filemaker.fmWebProjectInitialized');
      callback?.();
      await vi.waitFor(() => expect(keyCalls('filemaker.fmWebProjectInitialized'), event).toBe(before + 1));
    }
    disposeSubscriptions(context);
    vi.restoreAllMocks();
  });

  it('activation registers a serializer for every webview panel type, so restored tabs are not dead', async () => {
    const { RESTORABLE_PANELS, LIVE_SERIALIZER_PANELS } = await import('../../src/webviews/common/panelRestore');
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();
    await activate(context);
    const registered = vi.mocked(vscode.window.registerWebviewPanelSerializer).mock.calls.map(([viewType]) => viewType);
    disposeSubscriptions(context);
    const expected = [...RESTORABLE_PANELS.map((panel) => panel.viewType), ...LIVE_SERIALIZER_PANELS];
    expect(registered.sort()).toEqual(expected.sort());
  });

  it.each(['openWelcomeWalkthrough', 'openUserGuide'])('opens the requested %s help surface', async (name) => {
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();
    await activate(context);
    vi.mocked(vscode.commands.executeCommand).mockClear();
    await registeredCommand(`filemakerDataApiTools.${name}`)();
    if (name === 'openWelcomeWalkthrough') {
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.openWalkthrough',
        { category: `${context.extension.id}#filemakerGettingStarted` }, false);
    } else {
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('markdown.showPreview',
        expect.objectContaining({ fsPath: 'docs/USER_GUIDE.md' }));
    }
    disposeSubscriptions(context);
  });

  it.each(['openWelcomeWalkthrough', 'openUserGuide'])('%s logs a host command failure without rejecting', async (name) => {
    const { Logger } = await import('../../src/services/logger');
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();
    await activate(context);
    vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(new Error('host unavailable'));
    await expect(registeredCommand(`filemakerDataApiTools.${name}`)()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(name === 'openWelcomeWalkthrough' ? 'Failed to open getting-started walkthrough.' : 'Failed to open user guide.', expect.anything());
    disposeSubscriptions(context);
  });

  it.each([true, false])('only marks the first-run walkthrough shown after it opens (host succeeds=%s)', async (succeeds) => {
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();
    vi.mocked(vscode.commands.executeCommand).mockImplementation((async (id: string) => {
      if (id === 'workbench.action.openWalkthrough' && !succeeds) throw new Error('host unavailable');
    }) as never);
    await activate(context);
    if (succeeds) {
      await vi.waitFor(() => expect(context.globalState.update).toHaveBeenCalledWith('filemaker.walkthrough.shownOnce', true));
    } else {
      expect(context.globalState.update).not.toHaveBeenCalledWith('filemaker.walkthrough.shownOnce', true);
    }
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.openWalkthrough',
      { category: `${context.extension.id}#filemakerGettingStarted` }, false);
    disposeSubscriptions(context);
    vi.mocked(vscode.commands.executeCommand).mockReset();
  });

  it('does not reopen the walkthrough after the first-run flag was saved', async () => {
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();
    const originalGet = vi.mocked(context.globalState.get).getMockImplementation()!;
    vi.mocked(context.globalState.get).mockImplementation(((key: string, fallback: unknown) =>
      key === 'filemaker.walkthrough.shownOnce' ? true : originalGet(key, fallback)) as never);
    await activate(context);
    expect(vi.mocked(vscode.commands.executeCommand).mock.calls.some(([id]) => id === 'workbench.action.openWalkthrough')).toBe(false);
    disposeSubscriptions(context);
  });

  it.each(['dismiss', 'settings', 'empty', 'one', 'many', 'failure'])('handles the deprecated-settings offer: %s', async (action) => {
    const { SettingsService } = await import('../../src/services/settingsService');
    vi.spyOn(SettingsService.prototype, 'consumeDeprecatedSettingsUsed').mockReturnValue(['filemakerDataApiTools.requestTimeoutMs']);
    const migrate = vi.spyOn(SettingsService.prototype, 'migrateDeprecatedSettings').mockResolvedValue(
      action === 'empty' ? [] : action === 'many' ? ['filemaker.requestTimeoutMs', 'filemaker.logging.level'] : ['filemaker.requestTimeoutMs']
    );
    if (action === 'failure') migrate.mockRejectedValue(new Error('settings locked'));
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue((action === 'dismiss' ? undefined : action === 'settings' ? 'Open Settings' : 'Migrate Settings') as never);
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();
    await activate(context);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('filemaker.requestTimeoutMs'), 'Migrate Settings', 'Open Settings');
    if (action === 'dismiss' || action === 'settings') {
      expect(migrate).not.toHaveBeenCalled();
      if (action === 'settings') expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.openSettings', 'filemakerDataApiTools');
    } else if (action === 'failure') {
      await vi.waitFor(() => expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('FileMaker: could not migrate settings. Edit them in Settings instead.'));
    } else {
      await vi.waitFor(() => expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        action === 'empty' ? 'FileMaker: nothing to migrate in user or workspace settings. Check folder-level settings.' :
          `FileMaker: migrated ${action === 'many' ? '2 settings' : '1 setting'} to the filemaker.* names.`
      ));
    }
    disposeSubscriptions(context);
    vi.mocked(vscode.window.showWarningMessage).mockReset();
  });

  it('reapplies roles and reloads plugins when workspace trust is granted', async () => {
    const { RoleGuard } = await import('../../src/enterprise/roleGuard');
    const { PluginRegistry } = await import('../../src/plugins/pluginRegistry');
    const apply = vi.spyOn(RoleGuard.prototype, 'applyContexts').mockResolvedValue(undefined);
    const reload = vi.spyOn(PluginRegistry.prototype, 'reload').mockResolvedValue(undefined);
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();
    await activate(context);
    apply.mockClear();
    reload.mockClear();
    for (const [listener] of vi.mocked(vscode.workspace.onDidGrantWorkspaceTrust).mock.calls) await listener();
    expect(apply).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
    expect(apply.mock.invocationCallOrder[0]!).toBeLessThan(reload.mock.invocationCallOrder[0]!);
    disposeSubscriptions(context);
  });

  it('serializes role changes, logs failures and still processes the next setting change', async () => {
    const { RoleGuard } = await import('../../src/enterprise/roleGuard');
    const { PluginRegistry } = await import('../../src/plugins/pluginRegistry');
    const { Logger } = await import('../../src/services/logger');
    const apply = vi.spyOn(RoleGuard.prototype, 'applyContexts').mockResolvedValue(undefined);
    const reload = vi.spyOn(PluginRegistry.prototype, 'reload').mockResolvedValue(undefined);
    const error = vi.spyOn(Logger.prototype, 'error');
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();
    await activate(context);
    apply.mockClear();
    reload.mockClear();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    apply.mockReturnValueOnce(pending).mockRejectedValueOnce(new Error('configuration failed')).mockResolvedValue(undefined);
    const notify = () => {
      for (const [listener] of vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls) {
        listener({ affectsConfiguration: (key: string) => key === 'filemaker.enterprise.role' } as never);
      }
    };
    notify();
    notify();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
    expect(reload).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('Failed to apply FileMaker configuration change.', expect.anything()));
    expect(reload).toHaveBeenCalledOnce();
    notify();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
    expect(apply).toHaveBeenCalledTimes(3);
    disposeSubscriptions(context);
  });

  it('does not run a queued role change after disposal', async () => {
    const { RoleGuard } = await import('../../src/enterprise/roleGuard');
    const { PluginRegistry } = await import('../../src/plugins/pluginRegistry');
    const apply = vi.spyOn(RoleGuard.prototype, 'applyContexts').mockResolvedValue(undefined);
    const reload = vi.spyOn(PluginRegistry.prototype, 'reload').mockResolvedValue(undefined);
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();
    await activate(context);
    apply.mockClear();
    reload.mockClear();
    for (const [listener] of vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls) {
      listener({ affectsConfiguration: (key: string) => key === 'filemaker.performance.mode' } as never);
    }
    disposeSubscriptions(context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(apply).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('selects the exact explorer layout and ignores non-layout selections', async () => {
    const { LayoutInspectorProvider } = await import('../../src/views/layoutInspector');
    const select = vi.spyOn(LayoutInspectorProvider.prototype, 'selectLayout').mockImplementation(() => undefined);
    const { activate } = await import('../../src/extension');
    const context = createActivationContext();
    await activate(context);
    const tree = vi.mocked(vscode.window.createTreeView).mock.results[0]!.value;
    const onSelection = vi.mocked(tree.onDidChangeSelection).mock.calls[0]![0];
    onSelection({ selection: [{ kind: 'profile', profileId: 'p1' }] } as never);
    expect(select).not.toHaveBeenCalled();
    onSelection({ selection: [{ kind: 'layout', profileId: 'p1', layoutName: ' Exact layout ' }] } as never);
    expect(select).toHaveBeenCalledWith('p1', ' Exact layout ');
    disposeSubscriptions(context);
  });

  it('deactivate closes the sockets of every cached TLS agent (once the TLS module has been loaded), and is harmless before', async () => {
    const { activate, deactivate } = await import('../../src/extension');
    expect(() => deactivate()).not.toThrow(); // nothing loaded yet

    const context = createActivationContext();
    await activate(context);
    await registeredCommand('filemakerDataApiTools.connect')({ profileId: 'p1' }); // loads the TLS module
    const { createHttpsAgentForProfile } = await import('../../src/services/tlsAgent');
    const agent = createHttpsAgentForProfile({ pinnedCertSha256: 'ef'.repeat(32) });
    const destroy = vi.spyOn(agent, 'destroy');

    deactivate();
    disposeSubscriptions(context);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(() => deactivate()).not.toThrow();
  });
});

function installActivationVsCodeMocks(): void {
  const disposable = () => ({ dispose: vi.fn() });
  const createStatusBarItem = (): vscode.StatusBarItem => ({
    id: 'filemaker-test',
    alignment: vscode.StatusBarAlignment.Left,
    priority: undefined,
    name: undefined,
    text: '',
    tooltip: undefined,
    command: undefined,
    color: undefined,
    backgroundColor: undefined,
    accessibilityInformation: undefined,
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn()
  });
  const configuration = {
    get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
    inspect: vi.fn(() => undefined),
    update: vi.fn()
  };

  const vscodeMock = vscode as unknown as {
    Disposable: new (callback: () => void) => vscode.Disposable;
    StatusBarAlignment: { Left: number; Right: number };
    ThemeColor: new (id: string) => unknown;
    window: typeof vscode.window & {
      createStatusBarItem: ReturnType<typeof vi.fn>;
      registerTreeDataProvider: ReturnType<typeof vi.fn>;
    };
    workspace: typeof vscode.workspace & {
      onDidGrantWorkspaceTrust: ReturnType<typeof vi.fn>;
      onDidChangeConfiguration: ReturnType<typeof vi.fn>;
    };
  };

  vscodeMock.Disposable = class {
    public constructor(private readonly callback: () => void) {}
    public dispose(): void {
      this.callback();
    }
  };
  vscodeMock.StatusBarAlignment = { Left: 1, Right: 2 };
  vscodeMock.ThemeColor = class {
    public constructor(public readonly id: string) {}
  };
  vscodeMock.window.createStatusBarItem = vi.fn(createStatusBarItem);
  vscodeMock.window.registerTreeDataProvider = vi.fn(disposable);
  vscodeMock.workspace.onDidGrantWorkspaceTrust = vi.fn(disposable);
  vscodeMock.workspace.onDidChangeConfiguration = vi.fn(disposable);
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(configuration as never);
  vi.mocked(vscode.commands.registerCommand).mockImplementation(() => disposable());
}

function createActivationContext(): vscode.ExtensionContext {
  const profile = {
    id: 'p1',
    name: 'Development',
    serverUrl: 'https://fm.example.test',
    database: 'Contacts',
    authMode: 'direct',
    username: 'admin'
  };
  const globalState = createMemento((key, defaultValue) => {
    if (key === 'filemakerDataApiTools.profiles') {
      return [profile];
    }
    return defaultValue;
  });

  return {
    subscriptions: [],
    extensionUri: vscode.Uri.file('/test/extension'),
    globalState,
    workspaceState: createMemento(),
    secrets: {
      get: vi.fn().mockResolvedValue(undefined),
      store: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      onDidChange: vi.fn()
    },
    extension: {
      id: 'SureForgeTech.filemaker-data-api-tools',
      packageJSON: { version: '1.1.0' }
    },
    extensionMode: 1,
    asAbsolutePath: (path: string) => `/test/extension/${path}`
  } as unknown as vscode.ExtensionContext;
}

function createMemento(
  getValue: (key: string, defaultValue?: unknown) => unknown = (_key, defaultValue) => defaultValue
): vscode.Memento {
  return {
    get: vi.fn(getValue),
    update: vi.fn().mockResolvedValue(undefined),
    keys: vi.fn(() => []),
    setKeysForSync: vi.fn()
  } as unknown as vscode.Memento;
}

function registeredCommand(commandId: string): (arg?: unknown) => Promise<void> {
  const call = vi
    .mocked(vscode.commands.registerCommand)
    .mock.calls.find(([registeredId]) => registeredId === commandId);
  expect(call).toBeDefined();
  return call?.[1] as (arg?: unknown) => Promise<void>;
}

function disposeSubscriptions(context: vscode.ExtensionContext): void {
  for (const subscription of context.subscriptions) {
    subscription.dispose();
  }
}
