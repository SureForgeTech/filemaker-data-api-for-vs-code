import { mkdtemp, mkdir, readdir, readFile, realpath, rm, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PathConfinementError, resolveConfinedFile } from '../../src/utils/pathConfinement';
import { writeGeneratedFiles } from '../../src/services/generatedFileWriter';
import { resolveConfinedWorkspaceFile, TypeGenService } from '../../src/services/typeGenService';

const profile = { id: 'p', name: 'Dev', database: 'DB' } as never;
const logger = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };
const roots: string[] = [];

/** A workspace root with a sibling folder outside it. */
async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'fm-write-confinement-')));
  roots.push(base);
  const workspace = join(base, 'workspace');
  const outside = join(base, 'outside');
  await mkdir(workspace);
  await mkdir(outside);
  return { base, workspace, outside };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('write path confinement', () => {
  it('refuses a ".." segment that would leave the workspace root', async () => {
    const { workspace, outside } = await fixture();

    await expect(resolveConfinedWorkspaceFile(workspace, '..', 'escaped.ts')).rejects.toThrow(PathConfinementError);
    await expect(resolveConfinedWorkspaceFile(workspace, 'layouts', '..', '..', 'escaped.ts')).rejects.toThrow(
      PathConfinementError
    );
    await expect(resolveConfinedFile('../escaped.ts', workspace, [workspace])).rejects.toThrow(/\.\./);

    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses an absolute path that points outside the workspace root', async () => {
    const { workspace, outside } = await fixture();

    await expect(resolveConfinedWorkspaceFile(workspace, join(outside, 'escaped.ts'))).rejects.toThrow(
      PathConfinementError
    );
    await expect(resolveConfinedFile(join(outside, 'escaped.ts'), workspace, [workspace])).rejects.toThrow(
      PathConfinementError
    );

    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses a folder that is a symbolic link pointing out of the workspace root', async () => {
    const { workspace, outside } = await fixture();
    await symlink(outside, join(workspace, 'linked'), 'dir');

    await expect(resolveConfinedWorkspaceFile(workspace, 'linked', 'escaped.ts')).rejects.toThrow(/symbolic link/);

    expect(await readdir(outside)).toEqual([]);
  });

  it('writes nothing outside the workspace root when a generated file tries to escape', async () => {
    const { workspace, outside } = await fixture();

    await expect(
      writeGeneratedFiles([{ path: join(outside, 'escaped.ts'), content: 'generated' }], workspace)
    ).rejects.toThrow(/outside the workspace/);

    expect(await readdir(outside)).toEqual([]);
  });

  it('keeps a generated type file inside the workspace when the output folder tries to escape', async () => {
    const { base, workspace, outside } = await fixture();
    const service = new TypeGenService(
      { getLayoutSchema: async () => ({ supported: true, fields: [{ name: ' Name ', type: 'text' }] }) } as never,
      { listLayouts: async () => ['Contacts'] } as never,
      logger,
      { getWorkspaceRoot: () => workspace, getOutputDir: () => '../../escape' }
    );

    const artifact = await service.generateTypesForLayout(profile, 'Contacts');

    expect(artifact.filePath.startsWith(workspace)).toBe(true);
    await expect(readFile(join(outside, 'escape', 'layouts', 'Contacts.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(base)).sort()).toEqual(['outside', 'workspace']);
  });

  it('keeps a generated type file inside the workspace when the layout name tries to escape', async () => {
    const { base, workspace, outside } = await fixture();
    const service = new TypeGenService(
      { getLayoutSchema: async () => ({ supported: true, fields: [{ name: ' Name ', type: 'text' }] }) } as never,
      { listLayouts: async () => ['../../evil'] } as never,
      logger,
      { getWorkspaceRoot: () => workspace }
    );

    const artifact = await service.generateTypesForLayout(profile, '../../evil');

    expect(artifact.filePath.startsWith(workspace)).toBe(true);
    expect(await readdir(outside)).toEqual([]);
    expect((await readdir(base)).sort()).toEqual(['outside', 'workspace']);
  });
});
