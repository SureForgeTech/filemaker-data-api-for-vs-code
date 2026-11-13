import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';

import { parseProfileId, parseLayoutArg, formatError } from '../../../src/commands/common';
import * as certificateTrust from '../../../src/services/certificateTrust';
import { setAgentReplacedPolicy } from '../../../src/services/tlsAgent';
import { registerCoreCommands } from '../../../src/commands/index';
import { registerRecordEditCommands } from '../../../src/commands/recordEdit';
import { registerScriptRunnerCommands } from '../../../src/commands/scriptRunner';
import { registerFmWebProjectCommands } from '../../../src/commands/fmWebProject';
import { RecordViewerPanel } from '../../../src/webviews/recordViewer';
import { RecordEditorPanel } from '../../../src/webviews/recordEditor';
import { ScriptRunnerPanel } from '../../../src/webviews/scriptRunner';

describe('parseProfileId', () => {
  it('returns profileId from valid arg', () => {
    expect(parseProfileId({ profileId: 'p1' })).toBe('p1');
  });

  it('returns undefined for null arg', () => {
    expect(parseProfileId(null)).toBeUndefined();
  });

  it('returns undefined for non-object arg', () => {
    expect(parseProfileId('string')).toBeUndefined();
  });

  it('returns undefined when profileId is not a string', () => {
    expect(parseProfileId({ profileId: 42 })).toBeUndefined();
  });
});

describe('parseLayoutArg', () => {
  it('extracts layout from arg with layout field', () => {
    const result = parseLayoutArg({ profileId: 'p1', layout: 'Contacts' });
    expect(result).toEqual({ profileId: 'p1', layout: 'Contacts' });
  });

  it('extracts layout from arg with layoutName field', () => {
    const result = parseLayoutArg({ layoutName: 'Invoices' });
    expect(result).toEqual({ profileId: undefined, layout: 'Invoices' });
  });

  it('prefers layout over layoutName', () => {
    const result = parseLayoutArg({ layout: 'A', layoutName: 'B' });
    expect(result.layout).toBe('A');
  });

  it('returns empty object for null arg', () => {
    expect(parseLayoutArg(null)).toEqual({});
  });
});

describe('formatError', () => {
  it('extracts message from Error', () => {
    expect(formatError(new Error('boom'))).toContain('boom');
  });

  it('handles non-Error input', () => {
    expect(formatError('text')).toBeTruthy();
  });
});

describe('registerCoreCommands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.window.showInputBox).mockReset();
    vi.mocked(vscode.window.showQuickPick).mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  function createMockDeps() {
    return {
      context: {
        subscriptions: [],
        extensionUri: { fsPath: '/ext' }
      } as unknown as vscode.ExtensionContext,
      profileStore: {
        upsertProfile: vi.fn(),
        removeProfile: vi.fn(),
        getProfile: vi.fn(),
        listProfiles: vi.fn().mockResolvedValue([]),
        getActiveProfileId: vi.fn().mockReturnValue(undefined),
        setActiveProfileId: vi.fn()
      } as never,
      secretStore: {
        setPassword: vi.fn(),
        deletePassword: vi.fn(),
        setProxyApiKey: vi.fn(),
        deleteProxyApiKey: vi.fn(),
        clearProfileSecrets: vi.fn(),
        getPassword: vi.fn(),
        getProxyApiKey: vi.fn()
      } as never,
      savedQueriesStore: {
        removeQueriesForProfile: vi.fn()
      } as never,
      fmClient: {
        createSession: vi.fn(),
        deleteSession: vi.fn(),
        invalidateProfileCache: vi.fn(),
        listLayouts: vi.fn().mockResolvedValue([]),
        findRecords: vi.fn().mockResolvedValue({ data: [] })
      } as never,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      } as never,
      roleGuard: {
        assertFeature: vi.fn().mockResolvedValue(true),
        isProfileLocked: vi.fn().mockReturnValue(false)
      } as never,
      refreshExplorer: vi.fn(),
      onProfileDisconnected: vi.fn()
    };
  }

  it.each(['Cancel', undefined, 'Remove'])('removes a profile and its secrets only after Remove: %s', async (choice) => {
    const deps = createMockDeps();
    const profile = { id: 'p1', name: 'Development' };
    Object.assign(deps.profileStore, { getProfile: vi.fn().mockResolvedValue(profile) });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(choice as never);
    registerCoreCommands(deps);
    const remove = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === 'filemakerDataApiTools.removeConnectionProfile')![1];
    await remove({ profileId: 'p1' });
    for (const [object, method] of [[deps.profileStore, 'removeProfile'], [deps.savedQueriesStore, 'removeQueriesForProfile'], [deps.secretStore, 'clearProfileSecrets'], [deps.fmClient, 'invalidateProfileCache']] as const) {
      const fn = (object as Record<string, unknown>)[method];
      if (choice === 'Remove') expect(fn).toHaveBeenCalledWith('p1');
      else expect(fn).not.toHaveBeenCalled();
    }
    expect(deps.refreshExplorer).toHaveBeenCalledTimes(choice === 'Remove' ? 1 : 0);
  });

  it('logs out while the profile and secrets still exist before removing them', async () => {
    const deps = createMockDeps();
    const profile = { id: 'p1', name: 'Development' };
    Object.assign(deps.profileStore, { getProfile: vi.fn().mockResolvedValue(profile) });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Remove' as never);
    registerCoreCommands(deps);
    const remove = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === 'filemakerDataApiTools.removeConnectionProfile')![1];
    await remove({ profileId: 'p1' });
    const logout = (deps.fmClient as { deleteSession: ReturnType<typeof vi.fn> }).deleteSession;
    const clear = (deps.secretStore as { clearProfileSecrets: ReturnType<typeof vi.fn> }).clearProfileSecrets;
    const removeProfile = (deps.profileStore as { removeProfile: ReturnType<typeof vi.fn> }).removeProfile;
    expect(logout).toHaveBeenCalledExactlyOnceWith(profile);
    expect(logout.mock.invocationCallOrder[0]).toBeLessThan(clear.mock.invocationCallOrder[0]!);
    expect(logout.mock.invocationCallOrder[0]).toBeLessThan(removeProfile.mock.invocationCallOrder[0]!);
  });

  it('warns once per remote HTTP profile per session on Connect, without blocking', async () => {
    const deps = createMockDeps();
    const getProfile = vi.fn().mockResolvedValue({ id: 'p1', name: 'Remote', authMode: 'direct', serverUrl: 'http://fm.example.test', database: 'Sales' });
    Object.assign(deps.profileStore, { getProfile });
    registerCoreCommands(deps);
    const connect = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === 'filemakerDataApiTools.connect')![1];
    await connect({ profileId: 'p1' });
    await connect({ profileId: 'p1' });
    expect(vscode.window.showWarningMessage).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('unencrypted'));
    getProfile.mockResolvedValue({ id: 'p2', name: 'Other', authMode: 'direct', serverUrl: 'http://other.example.test', database: 'Sales' });
    await connect({ profileId: 'p2' });
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(2);
    expect((deps.fmClient as { createSession: ReturnType<typeof vi.fn> }).createSession).toHaveBeenCalledTimes(3);
  });

  it('warns about an HTTP proxy endpoint even if its FileMaker server URL is HTTPS', async () => {
    const deps = createMockDeps();
    Object.assign(deps.profileStore, { getProfile: vi.fn().mockResolvedValue({ id: 'p1', name: 'Proxy', authMode: 'proxy', serverUrl: 'https://fm.example.test', proxyEndpoint: 'http://proxy.example.test', database: 'Sales' }) });
    registerCoreCommands(deps);
    await vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === 'filemakerDataApiTools.connect')![1]({ profileId: 'p1' });
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('unencrypted'));
    expect((deps.fmClient as { createSession: ReturnType<typeof vi.fn> }).createSession).toHaveBeenCalled();
  });

  it.each(['https://fm.example.test', 'http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080'])(
    'does not warn on Connect to %s', async (serverUrl) => {
      const deps = createMockDeps();
      Object.assign(deps.profileStore, { getProfile: vi.fn().mockResolvedValue({ id: 'p1', name: 'Safe', authMode: 'direct', serverUrl, database: 'Sales' }) });
      registerCoreCommands(deps);
      await vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === 'filemakerDataApiTools.connect')![1]({ profileId: 'p1' });
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect((deps.fmClient as { createSession: ReturnType<typeof vi.fn> }).createSession).toHaveBeenCalled();
    }
  );

  it.each(['locked', 'writeOperations'])('refuses certificate trust when %s policy blocks profile changes', async (restriction) => {
    const deps = createMockDeps();
    Object.assign(deps.profileStore, { getProfile: vi.fn().mockResolvedValue({ id: 'p1', name: 'Test' }) });
    Object.assign(deps.roleGuard, {
      isProfileLocked: vi.fn().mockReturnValue(restriction === 'locked'),
      assertFeature: vi.fn().mockResolvedValue(restriction !== 'writeOperations')
    });
    const review = vi.spyOn(certificateTrust, 'reviewAndTrustCertificate').mockResolvedValue(undefined);
    registerCoreCommands(deps);
    const run = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === 'filemakerDataApiTools.trustServerCertificate')![1];
    await run({ profileId: 'p1' });
    expect(review).not.toHaveBeenCalled();
    expect((deps.profileStore as { upsertProfile: ReturnType<typeof vi.fn> }).upsertProfile).not.toHaveBeenCalled();
    if (restriction === 'locked') expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('locked'));
    else expect((deps.roleGuard as { assertFeature: ReturnType<typeof vi.fn> }).assertFeature).toHaveBeenCalledWith('writeOperations', expect.any(String));
  });

  it('offers to connect after trusting under override, without asking for a settings change', async () => {
    const deps = createMockDeps();
    const profile = { id: 'p1', name: 'LAN', authMode: 'direct' as const, serverUrl: 'https://192.0.2.1', database: 'Sales', username: 'tester' };
    const upsertProfile = vi.fn();
    Object.assign(deps.profileStore, { getProfile: vi.fn(async () => profile), upsertProfile });
    const clearAuthPause = vi.fn();
    Object.assign(deps.fmClient, { clearAuthPause });
    vi.spyOn(certificateTrust, 'reviewAndTrustCertificate').mockResolvedValue({ sha256: 'a'.repeat(64), allowExpired: false });
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue('Connect' as never);
    setAgentReplacedPolicy(() => true);
    try {
      registerCoreCommands(deps);
      const command = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([name]) => name === 'filemakerDataApiTools.trustServerCertificate')?.[1];
      expect(command).toBeDefined();
      await command!({ profileId: 'p1' });
      expect(upsertProfile).toHaveBeenCalledWith(expect.objectContaining({ pinnedCertSha256: 'a'.repeat(64) }));
      expect(clearAuthPause).toHaveBeenCalledWith('p1');
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Certificate trusted for "LAN". Connect now?', 'Connect');
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('filemakerDataApiTools.connect', { profileId: 'p1' });
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    } finally {
      setAgentReplacedPolicy(() => false);
    }
  });

  it('registers multiple command disposables', () => {
    const deps = createMockDeps();
    const disposables = registerCoreCommands(deps);

    expect(disposables.length).toBeGreaterThan(0);
    expect(vi.mocked(vscode.commands.registerCommand)).toHaveBeenCalled();
  });

  it('registers the connect command', () => {
    const deps = createMockDeps();
    registerCoreCommands(deps);

    const registeredNames = vi
      .mocked(vscode.commands.registerCommand)
      .mock.calls.map(([name]) => name);
    expect(registeredNames).toContain('filemakerDataApiTools.connect');
  });

  it('registers the disconnect command', () => {
    const deps = createMockDeps();
    registerCoreCommands(deps);

    const registeredNames = vi
      .mocked(vscode.commands.registerCommand)
      .mock.calls.map(([name]) => name);
    expect(registeredNames).toContain('filemakerDataApiTools.disconnect');
  });

  it('registers the addConnectionProfile command', () => {
    const deps = createMockDeps();
    registerCoreCommands(deps);

    const registeredNames = vi
      .mocked(vscode.commands.registerCommand)
      .mock.calls.map(([name]) => name);
    expect(registeredNames).toContain('filemakerDataApiTools.addConnectionProfile');
  });

  it('registers the removeConnectionProfile command', () => {
    const deps = createMockDeps();
    registerCoreCommands(deps);

    const registeredNames = vi
      .mocked(vscode.commands.registerCommand)
      .mock.calls.map(([name]) => name);
    expect(registeredNames).toContain('filemakerDataApiTools.removeConnectionProfile');
  });

  it('registers the editConnectionProfile command', () => {
    const deps = createMockDeps();
    registerCoreCommands(deps);

    const registeredNames = vi
      .mocked(vscode.commands.registerCommand)
      .mock.calls.map(([name]) => name);
    expect(registeredNames).toContain('filemakerDataApiTools.editConnectionProfile');
  });

  const profile = {
    id: 'p1',
    name: 'Dev',
    database: 'Contacts',
    authMode: 'direct',
    serverUrl: 'https://fm.example.com'
  };

  function command(name: string) {
    const callback = vi
      .mocked(vscode.commands.registerCommand)
      .mock.calls.find(([id]) => id === `filemakerDataApiTools.${name}`)?.[1];
    if (!callback) throw new Error(`Command ${name} was not registered`);
    return callback;
  }

  function createSelectionDeps() {
    const deps = createMockDeps();
    Object.assign(deps.profileStore, {
      getProfile: vi.fn().mockResolvedValue(profile),
      listProfiles: vi.fn().mockResolvedValue([profile]),
      getActiveProfileId: vi.fn().mockReturnValue(profile.id)
    });
    Object.assign(deps.fmClient, { listLayouts: vi.fn().mockResolvedValue(['Contacts']) });
    return {
      ...deps,
      schemaService: {} as never,
      settingsService: { isRecordEditEnabled: vi.fn().mockReturnValue(true) } as never,
      fmWebProjectService: { setActiveProfile: vi.fn() } as never,
      fmWebRuntimeGenerator: {} as never,
      fmBridgeServer: {} as never
    };
  }

  it.each([0, 1, 2, 3])('stops Run Find when input step %i is cancelled', async (step) => {
    const deps = createSelectionDeps();
    registerCoreCommands(deps);
    const inputs = ['[{}]', '', '', ''];
    for (const input of inputs.slice(0, step)) {
      vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(input);
    }
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);
    await command('runFindJson')({ profileId: profile.id, layout: 'Contacts' });
    expect(vscode.window.showInputBox).toHaveBeenCalledTimes(step + 1);
    expect(
      (deps.fmClient as { findRecords: ReturnType<typeof vi.fn> }).findRecords
    ).not.toHaveBeenCalled();
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('accepts blank optional find inputs and validates mistakes before submission', async () => {
    const deps = createSelectionDeps();
    registerCoreCommands(deps);
    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce('[{"Name":"Alice"}]')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');
    await command('runFindJson')({ profileId: profile.id, layout: 'Contacts' });
    expect(
      (deps.fmClient as { findRecords: ReturnType<typeof vi.fn> }).findRecords
    ).toHaveBeenCalledWith(profile, 'Contacts', {
      query: [{ Name: 'Alice' }],
      sort: undefined,
      limit: undefined,
      offset: undefined
    });
    const prompts = vi.mocked(vscode.window.showInputBox).mock.calls.map(([options]) => options);
    expect(prompts[0]?.validateInput?.('{')).toContain('valid JSON');
    expect(prompts[1]?.validateInput?.('{}')).toContain('array');
    expect(prompts[1]?.validateInput?.('')).toBeUndefined();
    expect(prompts[2]?.validateInput?.('-1')).toContain('must be at least 1');
    expect(prompts[3]?.validateInput?.('1.5')).toContain('must be at least 1');
  });

  it('warns when a script reported an error next to a find that worked, and stays quiet otherwise', async () => {
    const deps = createSelectionDeps();
    registerCoreCommands(deps);
    const findRecords = (deps.fmClient as { findRecords: ReturnType<typeof vi.fn> }).findRecords;
    const answers = () => ['[{"Name":"Alice"}]', '', '', ''].forEach((value) => vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(value));

    findRecords.mockResolvedValueOnce({ data: [], scriptErrors: [{ phase: 'presort', code: '102' }] });
    answers();
    await command('runFindJson')({ profileId: profile.id, layout: 'Contacts' });
    expect(vi.mocked(vscode.window.showWarningMessage).mock.calls.map((call) => String(call[0])).join('\n')).toMatch(
      /The find worked, but the pre-sort script reported error 102/
    );

    vi.mocked(vscode.window.showWarningMessage).mockClear();
    findRecords.mockResolvedValueOnce({ data: [] });
    answers();
    await command('runFindJson')({ profileId: profile.id, layout: 'Contacts' });
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  const panels = [
    { name: 'openRecordViewer', register: registerCoreCommands, panel: RecordViewerPanel },
    { name: 'openRecordEditor', register: registerRecordEditCommands, panel: RecordEditorPanel },
    { name: 'openScriptRunner', register: registerScriptRunnerCommands, panel: ScriptRunnerPanel }
  ];

  it.each(panels)(
    '$name does not open after cancelling layout selection',
    async ({ name, register, panel }) => {
      const deps = createSelectionDeps();
      const open = vi.spyOn(panel, 'createOrShow').mockImplementation(() => {});
      register(deps);
      vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);
      await command(name)({ profileId: profile.id });
      expect(open).not.toHaveBeenCalled();
      expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    }
  );

  it.each(panels)(
    '$name stops when the optional record prompt is cancelled',
    async ({ name, register, panel }) => {
      const deps = createSelectionDeps();
      const open = vi.spyOn(panel, 'createOrShow').mockImplementation(() => {});
      register(deps);
      vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);
      await command(name)({ profileId: profile.id, layout: 'Contacts' });
      expect(open).not.toHaveBeenCalled();
    }
  );

  it.each(panels)(
    '$name accepts a blank record ID to browse',
    async ({ name, register, panel }) => {
      const deps = createSelectionDeps();
      const open = vi.spyOn(panel, 'createOrShow').mockImplementation(() => {});
      register(deps);
      vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('  ');
      await command(name)({ profileId: profile.id, layout: 'Contacts' });
      expect(open).toHaveBeenCalledOnce();
      expect(open.mock.calls[0]?.at(-1)).toEqual({
        profileId: profile.id,
        layout: 'Contacts',
        recordId: undefined
      });
    }
  );

  it('allows selecting another FM Web profile even when one is active', async () => {
    const deps = createSelectionDeps();
    const other = { ...profile, id: 'p2', name: 'Staging' };
    Object.assign(deps.profileStore, { listProfiles: vi.fn().mockResolvedValue([profile, other]) });
    registerFmWebProjectCommands(deps);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: other.name,
      profile: other
    } as never);
    await command('selectActiveProfile')();
    expect(
      (deps.fmWebProjectService as { setActiveProfile: ReturnType<typeof vi.fn> }).setActiveProfile
    ).toHaveBeenCalledWith(other.id);
  });

  it('does not reopen the FM Web profile picker after cancellation', async () => {
    const deps = createSelectionDeps();
    registerFmWebProjectCommands(deps);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);
    await command('selectActiveProfile')();
    expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
    expect(
      (deps.fmWebProjectService as { setActiveProfile: ReturnType<typeof vi.fn> }).setActiveProfile
    ).not.toHaveBeenCalled();
  });
});
