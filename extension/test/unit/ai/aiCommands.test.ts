import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { AiToolsController } from '../../../src/ai/aiRegistration';
import { AiStatusBar, auditLogPath, registerAiToolCommands } from '../../../src/commands/aiTools';
import { makeHarness } from './harness';

describe('AI commands', () => {
  let roleGuard: { isProfileLocked: ReturnType<typeof vi.fn>; assertFeature: ReturnType<typeof vi.fn> };
  let update: ReturnType<typeof vi.fn>;
  let profileStore: { getProfile: ReturnType<typeof vi.fn>; listProfiles: ReturnType<typeof vi.fn>; upsertProfile: ReturnType<typeof vi.fn>; getActiveProfileId: ReturnType<typeof vi.fn> };
  let h: ReturnType<typeof makeHarness>;
  let audit: { read: ReturnType<typeof vi.fn> };
  let controller: AiToolsController;

  const command = (name: string) => {
    const callback = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === name)?.[1];
    if (!callback) throw new Error(`${name} not registered`);
    return callback;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    h = makeHarness();
    update = vi.fn(async () => undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((_k: string, d?: unknown) => d),
      inspect: vi.fn((key: string) => (key === 'ai.enabled' ? { globalValue: true } : key === 'ai.connection' ? { globalValue: 'p1' } : undefined)),
      update
    } as never);
    profileStore = {
      getProfile: vi.fn(async () => h.profile),
      listProfiles: vi.fn(async () => [h.profile]),
      upsertProfile: vi.fn(async () => undefined),
      getActiveProfileId: vi.fn(() => undefined)
    };
    audit = { read: vi.fn(async () => '{"tool":"a"}\n') };
    controller = new AiToolsController(h.service, { lm: undefined });
    const statusBar = new AiStatusBar({ service: h.service, controller, profileStore: profileStore as never, reportHiddenFieldsProblem: vi.fn() });
    roleGuard = { isProfileLocked: vi.fn().mockReturnValue(false), assertFeature: vi.fn().mockResolvedValue(true) };
    registerAiToolCommands({
      service: h.service,
      controller,
      audit: audit as never,
      profileStore: profileStore as never,
      roleGuard: roleGuard as never,
      statusBar
    });
    (vscode as unknown as { ConfigurationTarget: { Global: number } }).ConfigurationTarget.Global = 1;
  });

  it('reports malformed hidden fields on status refresh', async () => {
    const reportHiddenFieldsProblem = vi.fn();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (_key: string, fallback?: unknown) => fallback,
      inspect: (key: string) => key === 'ai.hiddenFields' ? { globalValue: 'SSN, Password' } : undefined
    } as never);
    const statusBar = new AiStatusBar({
      service: h.service, controller, profileStore: profileStore as never, reportHiddenFieldsProblem
    });
    await statusBar.refresh();
    expect(reportHiddenFieldsProblem).toHaveBeenCalledWith({ scope: 'globalValue', kind: 'string-as-name', count: 1 });
    statusBar.dispose();
  });

  it('the kill switch turns tools off at once, and asks in a modal before turning them back on', async () => {
    await command('filemakerDataApiTools.toggleAiKillSwitch')();
    expect(h.service.isKilled()).toBe(true);
    await expect(h.service.invoke('fm_list_layouts', {})).rejects.toThrow(/switched off/);

    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never); // dismissed
    await command('filemakerDataApiTools.toggleAiKillSwitch')();
    expect(h.service.isKilled()).toBe(true);
    expect(vi.mocked(vscode.window.showWarningMessage).mock.calls.at(-1)?.[1]).toMatchObject({ modal: true });

    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Switch On' as never);
    await command('filemakerDataApiTools.toggleAiKillSwitch')();
    expect(h.service.isKilled()).toBe(false);
    await expect(h.service.invoke('fm_list_layouts', {})).resolves.toBeDefined();
  });

  it('does not set the kill switch while AI is not enabled, so enabling AI later is not blocked', async () => {
    (h as unknown as { settings: { enabled: boolean } }).settings.enabled = false;
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(undefined as never);
    await command('filemakerDataApiTools.toggleAiKillSwitch')();

    expect(h.service.isKilled()).toBe(false);
    expect(vi.mocked(vscode.window.showInformationMessage).mock.calls.at(-1)?.[0]).toMatch(/nothing to switch off.*filemaker\.ai\.enabled/);

    // The user then turns AI on: tools work at once, with no modal to switch them back on.
    (h as unknown as { settings: { enabled: boolean } }).settings.enabled = true;
    await expect(h.service.invoke('fm_list_layouts', {})).resolves.toBeDefined();
    vi.mocked(vscode.window.showWarningMessage).mockClear();
    await command('filemakerDataApiTools.toggleAiKillSwitch')();
    expect(h.service.isKilled()).toBe(true);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['offline mode', (state: typeof h.state) => (state.offline = true), /Offline mode/],
    ['an untrusted workspace', (state: typeof h.state) => (state.trusted = false), /untrusted workspace/],
    ['enterprise policy', (state: typeof h.state) => state.denyFeatures.add('ai'), /ai is disabled by policy/],
    ['a features switch', (state: typeof h.state) => (state.featureSwitch = false), /filemaker\.features\.ai\.enabled/]
  ])('names the true cause when AI is off because of %s', async (_label, apply, expected) => {
    apply(h.state);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(undefined as never);
    await command('filemakerDataApiTools.toggleAiKillSwitch')();

    const [message, ...actions] = vi.mocked(vscode.window.showInformationMessage).mock.calls.at(-1) ?? [];
    expect(String(message)).toMatch(expected);
    expect(String(message)).not.toMatch(/Turn them on with filemaker\.ai\.enabled/);
    expect(actions).toEqual([]); // opening the AI settings would not help
    expect(h.service.isKilled()).toBe(false);
  });

  it('a new session resets counters and approvals only after the user confirms', async () => {
    await h.service.invoke('fm_describe_layout', { layout: 'Contacts' });
    await h.service.invoke('fm_get_record', { layout: 'Contacts', recordId: '1' });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);
    await command('filemakerDataApiTools.newAiSession')();
    expect(h.service.status().recordsUsed).toBe(1);

    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Start New Session' as never);
    await command('filemakerDataApiTools.newAiSession')();
    expect(h.service.status().recordsUsed).toBe(0);
    expect(vi.mocked(vscode.window.showWarningMessage).mock.calls.at(-1)?.[1]).toMatchObject({ modal: true });
  });

  it('shows the activity log in an untitled document, or a note when it is empty', async () => {
    await command('filemakerDataApiTools.showAiActivity')();
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({ content: '{"tool":"a"}\n', language: 'jsonc' });
    audit.read.mockResolvedValue('');
    await command('filemakerDataApiTools.showAiActivity')();
    expect(vi.mocked(vscode.workspace.openTextDocument).mock.calls.at(-1)?.[0]).toMatchObject({ content: expect.stringContaining('no AI tool activity') });
  });

  it('sets AI access on the chosen profile, and offers the restricted-account advice and the connection setting', async () => {
    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({ profile: h.profile } as never) // profile pick
      .mockResolvedValueOnce({ label: 'Read', access: 'read' } as never);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue('Use for AI Tools' as never);
    await command('filemakerDataApiTools.setAiAccess')();

    expect(profileStore.upsertProfile).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1', aiAccess: 'read' }));
    const advice = String(vi.mocked(vscode.window.showInformationMessage).mock.calls[0]?.[0]);
    expect(advice).toMatch(/dedicated account/);
    expect(advice).toContain('ai_reader');
    expect(update).toHaveBeenCalledWith('ai.connection', 'p1', 1);
  });

  it('refuses AI access changes when writeOperations is denied', async () => {
    roleGuard.assertFeature.mockResolvedValue(false);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({ profile: h.profile } as never);
    await command('filemakerDataApiTools.setAiAccess')();
    expect(roleGuard.assertFeature).toHaveBeenCalledWith('writeOperations', expect.any(String));
    expect(profileStore.upsertProfile).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('choosing None clears access and does not touch the connection setting', async () => {
    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({ profile: h.profile } as never)
      .mockResolvedValueOnce({ label: 'None', access: 'none' } as never);
    await command('filemakerDataApiTools.setAiAccess')();
    expect(profileStore.upsertProfile).toHaveBeenCalledWith(expect.objectContaining({ aiAccess: undefined }));
    expect(update).not.toHaveBeenCalled();
  });

  it('does nothing when the pick is cancelled or the profile is locked', async () => {
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined as never);
    await command('filemakerDataApiTools.setAiAccess')();
    expect(profileStore.upsertProfile).not.toHaveBeenCalled();

    vi.mocked(vscode.commands.registerCommand).mockClear();
    registerAiToolCommands({
      service: h.service,
      controller,
      audit: audit as never,
      profileStore: profileStore as never,
      roleGuard: { isProfileLocked: () => true } as never,
      statusBar: { refresh: vi.fn() } as never
    });
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({ profile: h.profile } as never);
    await command('filemakerDataApiTools.setAiAccess')();
    expect(profileStore.upsertProfile).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('locked'));
  });

  it('keeps the audit log in extension storage, not the workspace', () => {
    expect(auditLogPath('/home/me/.vscode/globalStorage/x')).toBe(join('/home/me/.vscode/globalStorage/x', 'ai-audit.log'));
  });
});
