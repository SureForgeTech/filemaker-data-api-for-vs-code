import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OfflineModeService } from '../../src/offline/offlineModeService';
import { SchemaSnapshotStore } from '../../src/services/schemaSnapshotStore';

const profile = { id: 'p', name: 'Dev', database: 'DB' } as never;
const roots: string[] = [];

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'fm-cache-confinement-')));
  roots.push(base);
  const workspace = join(base, 'workspace');
  const outside = join(base, 'outside');
  await mkdir(join(workspace, '.vscode'), { recursive: true });
  await mkdir(outside);
  return { workspace, outside };
}

function offlineService(workspace: string, warn = vi.fn()) {
  return new OfflineModeService(
    { warn },
    {
      getWorkspaceRoot: () => workspace,
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) as never,
      isWorkspaceTrusted: () => true
    }
  );
}

function snapshotStore(workspace: string, warn = vi.fn(), maxPerLayout = 20) {
  return new SchemaSnapshotStore(
    { get: <T>(_key: string, fallback?: T) => fallback as T, update: async () => undefined } as never,
    { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    {
      getStorageMode: () => 'workspaceFiles',
      getWorkspaceRoot: () => workspace,
      isWorkspaceTrusted: () => true,
      getMaxPerLayout: () => maxPerLayout
    }
  );
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('offline metadata cache confinement', () => {
  it('writes nothing outside the workspace when .vscode/filemaker is a link', async () => {
    const { workspace, outside } = await fixture();
    await symlink(outside, join(workspace, '.vscode', 'filemaker'), 'dir');

    await expect(offlineService(workspace).cacheLayoutMetadata(profile, 'Contacts', { a: 1 })).rejects.toThrow(/symlink/);

    expect(await readdir(outside)).toEqual([]);
  });

  it('writes nothing outside the workspace when the cache folder itself is a link', async () => {
    const { workspace, outside } = await fixture();
    await mkdir(join(workspace, '.vscode', 'filemaker'));
    await symlink(outside, join(workspace, '.vscode', 'filemaker', 'offline-metadata'), 'dir');

    await expect(offlineService(workspace).cacheLayoutMetadata(profile, 'Contacts', { a: 1 })).rejects.toThrow(/symlink/);

    expect(await readdir(outside)).toEqual([]);
  });

  it('does not overwrite a file outside the workspace through a linked index.json', async () => {
    const { workspace, outside } = await fixture();
    const dir = join(workspace, '.vscode', 'filemaker', 'offline-metadata');
    await mkdir(dir, { recursive: true });
    const victim = join(outside, 'victim.json');
    await writeFile(victim, '{"keep":"me"}');
    await symlink(victim, join(dir, 'index.json'));

    await expect(offlineService(workspace).cacheLayoutMetadata(profile, 'Contacts', { a: 1 })).rejects.toThrow(/symbolic link/);

    expect(await readFile(victim, 'utf8')).toBe('{"keep":"me"}');
  });

  it('does not read a payload outside the workspace through a linked cache file', async () => {
    const { workspace, outside } = await fixture();
    const service = offlineService(workspace);
    await service.cacheLayoutMetadata(profile, 'Contacts', { a: 1 });
    const dir = join(workspace, '.vscode', 'filemaker', 'offline-metadata');
    const [payloadName] = (await readdir(dir)).filter((name) => name !== 'index.json');
    const secret = join(outside, 'secret.json');
    await writeFile(secret, JSON.stringify({ metadata: { stolen: true }, hash: 'h', capturedAt: 'c' }));
    await rm(join(dir, payloadName as string));
    await symlink(secret, join(dir, payloadName as string));

    const warn = vi.fn();
    expect(await offlineService(workspace, warn).getCachedLayoutMetadata(profile, 'Contacts')).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('does not read an index outside the workspace through a linked index.json', async () => {
    const { workspace, outside } = await fixture();
    const dir = join(workspace, '.vscode', 'filemaker', 'offline-metadata');
    await mkdir(dir, { recursive: true });
    const foreignIndex = join(outside, 'index.json');
    await writeFile(
      foreignIndex,
      JSON.stringify({
        schemaVersion: 1,
        items: [
          { profileId: 'p', database: 'DB', apiBasePath: '/fmi/data', apiVersionPath: 'vLatest', layout: 'Contacts', capturedAt: 'c', hash: 'h', fileName: 'x.json' }
        ]
      })
    );
    await symlink(foreignIndex, join(dir, 'index.json'));

    expect(await offlineService(workspace).listCacheEntries()).toEqual([]);
  });

  it('still caches and reads normally inside a real folder', async () => {
    const { workspace } = await fixture();
    const service = offlineService(workspace);

    await service.cacheLayoutMetadata(profile, 'Contacts', { a: 1 });

    expect((await service.getCachedLayoutMetadata(profile, 'Contacts'))?.metadata).toEqual({ a: 1 });
  });
});

describe.skipIf(process.platform === 'win32')('schema snapshot file confinement', () => {
  const input = { profileId: 'p', layout: 'L', source: 'manual', metadata: { a: 1 } } as const;

  it('writes nothing outside the workspace when .vscode/filemaker is a link', async () => {
    const { workspace, outside } = await fixture();
    await symlink(outside, join(workspace, '.vscode', 'filemaker'), 'dir');

    await expect(snapshotStore(workspace).captureSnapshot(input)).rejects.toThrow(/symlink/);

    expect(await readdir(outside)).toEqual([]);
  });

  it('does not overwrite a file outside the workspace through a linked index.json', async () => {
    const { workspace, outside } = await fixture();
    const dir = join(workspace, '.vscode', 'filemaker', 'snapshots');
    await mkdir(dir, { recursive: true });
    const victim = join(outside, 'victim.json');
    await writeFile(victim, '{"keep":"me"}');
    await symlink(victim, join(dir, 'index.json'));

    await expect(snapshotStore(workspace).captureSnapshot(input)).rejects.toThrow(/symbolic link/);

    expect(await readFile(victim, 'utf8')).toBe('{"keep":"me"}');
  });

  it('does not list a snapshot file that links outside the workspace', async () => {
    const { workspace, outside } = await fixture();
    const dir = join(workspace, '.vscode', 'filemaker', 'snapshots');
    await mkdir(dir, { recursive: true });
    const foreign = join(outside, 'foreign.json');
    await writeFile(
      foreign,
      JSON.stringify({ snapshot: { id: 'x', profileId: 'p', layout: 'L', capturedAt: 'c', source: 'manual', metadata: {} } })
    );
    await symlink(foreign, join(dir, 'foreign.json'));

    const warn = vi.fn();
    expect(await snapshotStore(workspace, warn).listSnapshots()).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('does not delete a file outside the workspace when pruning through a linked snapshot file', async () => {
    const { workspace, outside } = await fixture();
    const dir = join(workspace, '.vscode', 'filemaker', 'snapshots');
    await mkdir(dir, { recursive: true });
    const victim = join(outside, 'victim.json');
    await writeFile(victim, 'keep me');
    await symlink(victim, join(dir, 'old.json'));
    await writeFile(
      join(dir, 'index.json'),
      JSON.stringify({
        schemaVersion: 1,
        items: [{ id: 'old', profileId: 'p', layout: 'L', capturedAt: '2000-01-01T00:00:00.000Z', source: 'manual', schemaVersion: 1, fileName: 'old.json' }]
      })
    );

    const warn = vi.fn();
    await snapshotStore(workspace, warn, 1).captureSnapshot(input);

    expect(await readFile(victim, 'utf8')).toBe('keep me');
    expect(warn).toHaveBeenCalledWith('Failed to delete pruned snapshot file.', { fileName: 'old.json' });
  });

  it('does not prune through a snapshots folder that is a link', async () => {
    const { workspace, outside } = await fixture();
    await mkdir(join(workspace, '.vscode', 'filemaker'), { recursive: true });
    await symlink(outside, join(workspace, '.vscode', 'filemaker', 'snapshots'), 'dir');
    await writeFile(join(outside, 'index.json'), 'untouched');

    await expect(snapshotStore(workspace, vi.fn(), 1).captureSnapshot(input)).rejects.toThrow(/symlink/);

    expect(await readFile(join(outside, 'index.json'), 'utf8')).toBe('untouched');
    expect(await readdir(outside)).toEqual(['index.json']);
  });
});
