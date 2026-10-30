import { GenerationCancelledError, GenerationSkippedError } from '../../../src/services/generatedFileWriter';
import { mkdtemp, readFile, readdir, realpath, rm, symlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { registerTypeGenCommands } from '../../../src/commands/typeGen';
import { command, expectSafeError, layout, logger, profile, profileStore, resetCommandMocks, serviceError } from '../../helpers/commandHarness';

const arg = { profileId: profile.id, layout };
const generators = ['generateTypesForLayout', 'generateTypesForAllLayouts', 'generateSnippetsForLayout', 'generateTypeScriptClient'] as const;
const commands = [...generators, 'openGeneratedTypesFolder'];

function setup() {
  const profiles = profileStore();
  const client = { listLayouts: vi.fn().mockResolvedValue([layout, ' Other ']) };
  const service = {
    generateTypesForLayout: vi.fn().mockResolvedValue({ filePath: join('/tmp', 'generated', 'layout.ts') }),
    generateTypesForAllLayouts: vi.fn().mockResolvedValue([{ filePath: join('/tmp', 'generated', 'layout.ts') }]),
    generateSnippetsForLayout: vi.fn().mockResolvedValue({ filePath: join('/tmp', 'generated', 'layout.code-snippets') }),
    generateTypeScriptClient: vi.fn().mockResolvedValue({ readmePath: join('/tmp', 'client', 'README.md'), layouts: [layout] })
  };
  const settings = { getTypegenOutputDir: vi.fn().mockReturnValue(join('.filemaker', 'types')) };
  const log = logger();
  registerTypeGenCommands({ profileStore: profiles as never, fmClient: client as never, typeGenService: service as never,
    settingsService: settings as never, logger: log as never });
  return { profiles, client, service, settings, log };
}

describe('type generation commands', () => {
  beforeEach(resetCommandMocks);

  it.each(commands)('%s refuses Restricted Mode before reading profiles or writing files', async (name) => {
    const { profiles, client, service } = setup();
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = false;
    await command(name)(arg);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('Workspace is untrusted'), 'Learn More');
    expect(profiles.getProfile).not.toHaveBeenCalled();
    expect(client.listLayouts).not.toHaveBeenCalled();
    for (const generate of Object.values(service)) expect(generate).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.createDirectory).not.toHaveBeenCalled();
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('opens workspace trust help when requested', async () => {
    setup();
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = false;
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Learn More' as never);
    await command('generateTypesForLayout')(arg);
    expect(vscode.env.openExternal).toHaveBeenCalledWith(expect.objectContaining({ fsPath: 'https://code.visualstudio.com/docs/editor/workspace-trust' }));
  });

  it.each(generators)('%s stops if the profile does not exist', async (name) => {
    const { profiles, service } = setup();
    profiles.getProfile.mockResolvedValue(undefined);
    await command(name)(arg);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(`Connection profile ${profile.id} not found.`);
    expect(service[name]).not.toHaveBeenCalled();
  });

  it.each(['generateTypesForLayout', 'generateSnippetsForLayout'] as const)('%s passes the exact supplied layout and opens the generated file', async (name) => {
    const { service } = setup();
    await command(name)(arg);
    const path = name === 'generateTypesForLayout' ? join('/tmp', 'generated', 'layout.ts') : join('/tmp', 'generated', 'layout.code-snippets');
    expect(service[name]).toHaveBeenCalledWith(profile, layout);
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(expect.objectContaining({ fsPath: path }));
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith({}, { preview: false });
    expect(vscode.workspace.fs.createDirectory).toHaveBeenCalledWith(expect.objectContaining({ fsPath: join('/tmp', 'generated') }));
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(name === 'generateTypesForLayout' ? `Generated types for ${layout}.` : `Generated snippets for ${layout}.`);
  });

  it.each(['generateTypesForLayout', 'generateSnippetsForLayout'] as const)('%s stops if the layout picker is cancelled', async (name) => {
    const { service, client } = setup();
    await command(name)({ profileId: profile.id });
    expect(client.listLayouts).toHaveBeenCalledWith(profile);
    expect(service[name]).not.toHaveBeenCalled();
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('uses the layout chosen in the picker exactly', async () => {
    const { service } = setup();
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(layout as never);
    await command('generateTypesForLayout')({ profileId: profile.id });
    expect(service.generateTypesForLayout).toHaveBeenCalledWith(profile, layout);
  });

  it('suggests a dedicated client folder without creating it when the chooser is cancelled', async () => {
    setup();
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [{ uri: vscode.Uri.file('/tmp/project') }];
    vi.mocked(vscode.Uri.joinPath).mockImplementationOnce((base, ...segments) => vscode.Uri.file(join(base.fsPath, ...segments)));
    await command('generateTypeScriptClient')(arg);
    expect(vscode.workspace.fs.createDirectory).not.toHaveBeenCalled();
    expect(vscode.window.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultUri: expect.objectContaining({ fsPath: join('/tmp/project', '.filemaker', 'generated', 'client') }) }));
  });

  it('generates all layouts for the selected profile and reports the count', async () => {
    const { service } = setup();
    await command('generateTypesForAllLayouts')(arg);
    expect(service.generateTypesForAllLayouts).toHaveBeenCalledWith(profile);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Generated 1 layout type files.');
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it.each([1, 2])('generates a client for %s exact selected layouts and reports the count', async (count) => {
    const { service, client } = setup();
    const layouts = [layout, ' Other '].slice(0, count);
    service.generateTypeScriptClient.mockResolvedValue({ readmePath: join('/tmp', 'client', 'README.md'), layouts });
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(layouts.map((label) => ({ label })) as never);
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([vscode.Uri.file(join('/tmp', 'client'))]);
    await command('generateTypeScriptClient')({ profileId: profile.id });
    expect(client.listLayouts).toHaveBeenCalledWith(profile);
    expect(vscode.window.showQuickPick).toHaveBeenCalledWith([{ label: layout }, { label: ' Other ' }], expect.objectContaining({ canPickMany: true }));
    expect(service.generateTypeScriptClient).toHaveBeenCalledWith(profile, layouts, join('/tmp', 'client'));
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(expect.objectContaining({ fsPath: join('/tmp', 'client', 'README.md') }));
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(`Generated TypeScript client for ${count} layout${count === 1 ? '' : 's'}.`);
  });

  it('generates a client for a supplied layout without a layout picker', async () => {
    const { service, client } = setup();
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([vscode.Uri.file(join('/tmp', 'client'))]);
    await command('generateTypeScriptClient')(arg);
    expect(client.listLayouts).not.toHaveBeenCalled();
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(service.generateTypeScriptClient).toHaveBeenCalledWith(profile, [layout], join('/tmp', 'client'));
  });

  it.each(['cancel', 'empty', 'folder'])('does not generate a client after %s selection', async (reason) => {
    const { service } = setup();
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue((reason === 'empty' ? [] : undefined) as never);
    await command('generateTypeScriptClient')(reason === 'folder' ? arg : { profileId: profile.id });
    expect(service.generateTypeScriptClient).not.toHaveBeenCalled();
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    if (reason !== 'folder') expect(vscode.window.showOpenDialog).not.toHaveBeenCalled();
  });

  it.each(generators)('%s reports service failures safely and does not open output', async (name) => {
    const { service, log } = setup();
    service[name].mockRejectedValue(serviceError());
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([vscode.Uri.file(join('/tmp', 'client'))]);
    await expect(command(name)(arg)).resolves.toBeUndefined();
    expectSafeError();
    expect(log.error).toHaveBeenCalledOnce();
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('reports an error opening a generated artifact without a success toast', async () => {
    setup();
    vi.mocked(vscode.workspace.openTextDocument).mockRejectedValue(serviceError());
    await command('generateTypesForLayout')(arg);
    expectSafeError();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('refuses to open the generated types folder without a workspace', async () => {
    setup();
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
    await command('openGeneratedTypesFolder')();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Open a workspace folder first.');
    expect(vscode.workspace.fs.createDirectory).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('creates and reveals the configured generated types folder', async () => {
    setup();
    await command('openGeneratedTypesFolder')();
    expect(vscode.workspace.fs.createDirectory).toHaveBeenCalledWith(expect.objectContaining({ fsPath: join('/tmp', 'workspace', '.filemaker', 'types') }));
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('revealFileInOS', expect.objectContaining({ fsPath: join('/tmp', 'workspace', '.filemaker', 'types') }));
  });

  it('refuses a generated types folder reached through a symlink outside the workspace', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'fm-typegen-folder-')));
    const workspace = join(base, 'workspace');
    const outside = join(base, 'outside');
    const escaped = join(workspace, '.filemaker');
    const { settings } = setup();
    await import('fs/promises').then(({ mkdir }) => Promise.all([mkdir(workspace), mkdir(outside)]));
    await symlink(outside, escaped, 'dir');
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [{ uri: vscode.Uri.file(workspace) }];
    settings.getTypegenOutputDir.mockReturnValue(join('.filemaker', 'types'));

    try {
      await expect(command('openGeneratedTypesFolder')()).resolves.toBeUndefined();
      const errorCalls = vi.mocked(vscode.window.showErrorMessage).mock.calls;
      expect(errorCalls[0]?.[0]).toEqual(expect.stringMatching(/symbolic link|symlink/i));
      expect(vscode.workspace.fs.createDirectory).not.toHaveBeenCalled();
      expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('revealFileInOS', expect.anything());
      expect(await readdir(outside)).toEqual([]);
      await expect(readFile(join(outside, 'types', '.filemaker-types-check'))).rejects.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

it.each([new GenerationCancelledError(), new GenerationSkippedError('/tmp/mine.ts')])('shows generation decisions as plain information: %s', async (error) => {
  resetCommandMocks();
  const { service, log } = setup();
  service.generateTypesForLayout.mockRejectedValue(error);
  await command('generateTypesForLayout')(arg);
  expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(error.message);
  expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  expect(log.error).not.toHaveBeenCalled();
});
