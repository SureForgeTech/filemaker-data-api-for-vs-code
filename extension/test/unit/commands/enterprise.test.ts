import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { EnvironmentComparePanel } from '../../../src/webviews/environmentCompare';
import { command, expectSafeError, layout, logger, profile, profileStore, resetCommandMocks, serviceError } from '../../helpers/commandHarness';

vi.mock('../../../src/webviews/environmentCompare', () => ({ EnvironmentComparePanel: { createOrShow: vi.fn() } }));

const secondProfile = { ...profile, id: 'p2', name: 'Production' };
const environmentSet = { id: 'set1', name: ' Environments ', profiles: [profile.id, secondProfile.id] };
const arg = { environmentSetId: environmentSet.id, layout };
const comparison = {
  environmentSetId: environmentSet.id, environmentSetName: environmentSet.name, generatedAt: '2026-10-20',
  rows: [{ layout, presence: { p1: true, p2: false } }], summary: { profileCount: 2, totalLayouts: 1, differentLayouts: 1 }
};

async function setup() {
  // Each registration gets fresh module state, including the cached comparison result.
  vi.resetModules();
  const { registerEnterpriseCommands } = await import('../../../src/commands/enterprise');
  const profiles = profileStore();
  profiles.listProfiles.mockResolvedValue([profile, secondProfile]);
  const store = {
    getEnvironmentSet: vi.fn().mockResolvedValue(environmentSet),
    listEnvironmentSets: vi.fn().mockResolvedValue([environmentSet]), upsertEnvironmentSet: vi.fn()
  };
  const service = {
    compareEnvironmentSet: vi.fn().mockResolvedValue(comparison),
    diffLayoutAcrossEnvironments: vi.fn().mockResolvedValue({ layout, fieldDiffs: [] }),
    toMarkdownReport: vi.fn().mockReturnValue('# Comparison\n')
  };
  const roleGuard = { assertFeature: vi.fn().mockResolvedValue(true) };
  const settings = { getBatchConcurrency: vi.fn().mockReturnValue(4), getSchemaHashAlgorithm: vi.fn().mockReturnValue('sha256') };
  const log = logger();
  const refreshExplorer = vi.fn();
  registerEnterpriseCommands({ profileStore: profiles as never, environmentSetStore: store as never, compareService: service as never,
    roleGuard: roleGuard as never, settingsService: settings as never, logger: log as never, refreshExplorer });
  return { profiles, store, service, roleGuard, log, refreshExplorer };
}

describe('enterprise commands', () => {
  beforeEach(resetCommandMocks);

  it('refuses environment set creation when the role guard denies it', async () => {
    const { roleGuard, store, profiles } = await setup();
    roleGuard.assertFeature.mockResolvedValue(false);
    await command('createEnvironmentSet')();
    expect(roleGuard.assertFeature).toHaveBeenCalledWith('writeOperations', 'Create Environment Set');
    expect(profiles.listProfiles).not.toHaveBeenCalled();
    expect(store.upsertEnvironmentSet).not.toHaveBeenCalled();
  });

  it.each(['compareEnvironments', 'diffLayoutAcrossEnvironments'])('%s refuses an untrusted workspace before resolving connections', async (name) => {
    const { profiles, store, service } = await setup();
    (vscode.workspace as { isTrusted: boolean }).isTrusted = false;
    await command(name)(arg);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('untrusted workspace'));
    expect(store.getEnvironmentSet).not.toHaveBeenCalled();
    expect(profiles.listProfiles).not.toHaveBeenCalled();
    expect(service.compareEnvironmentSet).not.toHaveBeenCalled();
    expect(service.diffLayoutAcrossEnvironments).not.toHaveBeenCalled();
    expect(EnvironmentComparePanel.createOrShow).not.toHaveBeenCalled();
  });

  it('refuses to rerun a comparison through report export in an untrusted workspace', async () => {
    const { profiles, service } = await setup();
    (vscode.workspace as { isTrusted: boolean }).isTrusted = false;
    await command('exportEnvironmentComparisonReport')(arg);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('untrusted workspace'));
    expect(profiles.listProfiles).not.toHaveBeenCalled();
    expect(service.compareEnvironmentSet).not.toHaveBeenCalled();
    expect(vscode.window.showSaveDialog).not.toHaveBeenCalled();
  });

  it('requires at least two configured profiles', async () => {
    const { profiles, store } = await setup();
    profiles.listProfiles.mockResolvedValue([profile]);
    await command('createEnvironmentSet')();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('At least two profiles are required to create an environment set.');
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    expect(store.upsertEnvironmentSet).not.toHaveBeenCalled();
  });

  it('does not create a set when the name input is cancelled', async () => {
    const { store, refreshExplorer } = await setup();
    await command('createEnvironmentSet')();
    expect(store.upsertEnvironmentSet).not.toHaveBeenCalled();
    expect(refreshExplorer).not.toHaveBeenCalled();
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it.each([undefined, [], [{ profileId: profile.id }]])('requires two selected profiles (%j)', async (picks) => {
    const { store, refreshExplorer } = await setup();
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(environmentSet.name);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(picks as never);
    await command('createEnvironmentSet')();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Select at least two profiles.');
    expect(store.upsertEnvironmentSet).not.toHaveBeenCalled();
    expect(refreshExplorer).not.toHaveBeenCalled();
  });

  it('creates a set with the exact entered name and selected profile IDs', async () => {
    const { store, refreshExplorer } = await setup();
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(environmentSet.name);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue([{ profileId: 'p2' }, { profileId: 'p1' }] as never);
    await command('createEnvironmentSet')();
    expect(store.upsertEnvironmentSet).toHaveBeenCalledWith({ name: environmentSet.name, profiles: ['p2', 'p1'] });
    expect(refreshExplorer).toHaveBeenCalledOnce();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(`Created environment set "${environmentSet.name}".`);
  });

  it.each(['compareEnvironments', 'diffLayoutAcrossEnvironments', 'openEnvironmentSetJson'])('%s reports a missing set without calling the service', async (name) => {
    const { store, service } = await setup();
    store.getEnvironmentSet.mockResolvedValue(undefined);
    await command(name)(arg);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Environment set set1 not found.');
    expect(service.compareEnvironmentSet).not.toHaveBeenCalled();
    expect(service.diffLayoutAcrossEnvironments).not.toHaveBeenCalled();
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it.each(['empty', 'cancel'])('stops resolving a set on %s', async (reason) => {
    const { store, service } = await setup();
    if (reason === 'empty') store.listEnvironmentSets.mockResolvedValue([]);
    await command('compareEnvironments')();
    if (reason === 'empty') expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('No environment sets found. Create one first.');
    expect(service.compareEnvironmentSet).not.toHaveBeenCalled();
    expect(EnvironmentComparePanel.createOrShow).not.toHaveBeenCalled();
  });

  it('compares the selected set with ordered existing profiles and configured options', async () => {
    const { store, profiles, service } = await setup();
    store.listEnvironmentSets.mockResolvedValue([{ ...environmentSet, profiles: ['p2', 'missing', 'p1'] }]);
    profiles.listProfiles.mockResolvedValue([profile, secondProfile]);
    vi.mocked(vscode.window.showQuickPick).mockImplementation((async (items: Array<{ item: unknown }>) => items[0]) as never);
    await command('compareEnvironments')();
    expect(service.compareEnvironmentSet).toHaveBeenCalledWith({ ...environmentSet, profiles: ['p2', 'missing', 'p1'] },
      [secondProfile, profile], { concurrency: 4, hashAlgorithm: 'sha256' });
    expect(EnvironmentComparePanel.createOrShow).toHaveBeenCalledWith({ compare: comparison }, `Env Compare: ${environmentSet.name}`);
  });

  it('reports comparison failures safely without opening a panel', async () => {
    const { service, log } = await setup();
    service.compareEnvironmentSet.mockRejectedValue(serviceError());
    await expect(command('compareEnvironments')(arg)).resolves.toBeUndefined();
    expectSafeError();
    expect(log.error).toHaveBeenCalledOnce();
    expect(EnvironmentComparePanel.createOrShow).not.toHaveBeenCalled();
  });

  it('requires two existing profiles before diffing a layout', async () => {
    const { profiles, service } = await setup();
    profiles.listProfiles.mockResolvedValue([profile]);
    await command('diffLayoutAcrossEnvironments')(arg);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Environment set must reference at least two existing profiles.');
    expect(service.diffLayoutAcrossEnvironments).not.toHaveBeenCalled();
  });

  it('passes the exact supplied layout to the diff service using the setId alias', async () => {
    const { service } = await setup();
    await command('diffLayoutAcrossEnvironments')({ setId: environmentSet.id, layout });
    expect(service.compareEnvironmentSet).not.toHaveBeenCalled();
    expect(service.diffLayoutAcrossEnvironments).toHaveBeenCalledWith(environmentSet, layout, [profile, secondProfile], { concurrency: 4, hashAlgorithm: 'sha256' });
    expect(EnvironmentComparePanel.createOrShow).toHaveBeenCalledWith({ layoutDiff: { layout, fieldDiffs: [] } }, `Layout Diff: ${environmentSet.name} / ${layout}`);
  });

  it('passes the exact layout chosen from comparison rows', async () => {
    const { service } = await setup();
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ layout } as never);
    await command('diffLayoutAcrossEnvironments')({ environmentSetId: environmentSet.id });
    expect(vscode.window.showQuickPick).toHaveBeenCalledWith([{ label: layout, description: 'p1:Y | p2:N', layout }], { title: 'Select layout for environment diff' });
    expect(service.diffLayoutAcrossEnvironments).toHaveBeenCalledWith(environmentSet, layout, [profile, secondProfile], expect.anything());
  });

  it('stops when layout selection is cancelled', async () => {
    const { service } = await setup();
    await command('diffLayoutAcrossEnvironments')({ environmentSetId: environmentSet.id });
    expect(service.diffLayoutAcrossEnvironments).not.toHaveBeenCalled();
    expect(EnvironmentComparePanel.createOrShow).not.toHaveBeenCalled();
  });

  it('reports layout diff failures safely', async () => {
    const { service } = await setup();
    service.diffLayoutAcrossEnvironments.mockRejectedValue(serviceError());
    await command('diffLayoutAcrossEnvironments')(arg);
    expectSafeError();
    expect(EnvironmentComparePanel.createOrShow).not.toHaveBeenCalled();
  });

  it('requires export permission before resolving sets or prompting', async () => {
    const { roleGuard, store } = await setup();
    roleGuard.assertFeature.mockResolvedValue(false);
    await command('exportEnvironmentComparisonReport')(arg);
    expect(roleGuard.assertFeature).toHaveBeenCalledWith('environmentExport', 'Export environment comparison report');
    expect(store.getEnvironmentSet).not.toHaveBeenCalled();
    expect(vscode.window.showSaveDialog).not.toHaveBeenCalled();
  });

  it('explains that a comparison is needed when there is no set or cached result', async () => {
    const { store } = await setup();
    store.listEnvironmentSets.mockResolvedValue([]);
    await command('exportEnvironmentComparisonReport')();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Run FileMaker: Compare Environments first.');
    expect(vscode.window.showSaveDialog).not.toHaveBeenCalled();
  });

  it.each(['json', 'md'])('exports a fresh comparison as %s', async (format) => {
    const { service } = await setup();
    const uri = vscode.Uri.file(join('/tmp', `report.${format}`));
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ value: format } as never);
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(uri);
    await command('exportEnvironmentComparisonReport')(arg);
    expect(service.compareEnvironmentSet).toHaveBeenCalledWith(environmentSet, [profile, secondProfile], { concurrency: 4, hashAlgorithm: 'sha256' });
    const [destination, bytes] = vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0]!;
    expect(destination).toBe(uri);
    expect(Buffer.from(bytes).toString()).toBe(format === 'json' ? JSON.stringify(comparison, null, 2) : '# Comparison\n');
    expect(service.toMarkdownReport).toHaveBeenCalledTimes(format === 'md' ? 1 : 0);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Exported environment comparison report.');
  });

  it('exports a cached comparison when no set is selected', async () => {
    const { store, service } = await setup();
    await command('compareEnvironments')(arg);
    store.listEnvironmentSets.mockResolvedValue([]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ value: 'json' } as never);
    const uri = vscode.Uri.file(join('/tmp', 'cached.json'));
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(uri);
    await command('exportEnvironmentComparisonReport')();
    expect(service.compareEnvironmentSet).toHaveBeenCalledOnce();
    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(uri, Buffer.from(JSON.stringify(comparison, null, 2)));
  });

  it.each(['format', 'destination'])('does not write a report after cancelling the %s', async (which) => {
    await setup();
    if (which === 'destination') vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ value: 'json' } as never);
    await command('exportEnvironmentComparisonReport')(arg);
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    if (which === 'format') expect(vscode.window.showSaveDialog).not.toHaveBeenCalled();
  });

  it('opens the exact environment set as JSON', async () => {
    await setup();
    await command('openEnvironmentSetJson')(arg);
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({ language: 'json', content: JSON.stringify(environmentSet, null, 2) });
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith({}, { preview: false });
  });

  it('handles report write failures without reporting success', async () => {
    await setup();
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ value: 'json' } as never);
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(vscode.Uri.file('/tmp/report.json'));
    vi.mocked(vscode.workspace.fs.writeFile).mockRejectedValue(new Error('Write failed: Bearer command-secret'));
    await expect(command('exportEnvironmentComparisonReport')(arg)).resolves.toBeUndefined();
    expectSafeError();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('handles report comparison failures without rejecting', async () => {
    const { service } = await setup();
    service.compareEnvironmentSet.mockRejectedValue(serviceError());
    await expect(command('exportEnvironmentComparisonReport')(arg)).resolves.toBeUndefined();
    expectSafeError();
  });

});
