import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

import { SchemaSnapshotStore } from '../../src/services/schemaSnapshotStore';

/** The snapshot index lives in the workspace, so a cloned repository can ship its own. */
describe('snapshot index from the workspace', () => {
  it('keeps workspace snapshots committable and preserves user ignore rules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-snapidx-'));
    const store = new SchemaSnapshotStore(
      { get: <T>(_key: string, fallback?: T) => fallback as T, update: async () => undefined } as never,
      { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      { getStorageMode: () => 'workspaceFiles', getWorkspaceRoot: () => root, isWorkspaceTrusted: () => true }
    );
    const input = { profileId: 'p', layout: ' Layout ', source: 'manual' as const, metadata: { valueLists: ['Private'] } };
    const ignore = join(root, '.vscode/filemaker/snapshots/.gitignore');
    await store.captureSnapshot(input);
    expect(existsSync(ignore)).toBe(false);
    expect((await store.listSnapshots()).map((snapshot) => snapshot.layout)).toEqual([' Layout ']);
    await writeFile(ignore, '# keep custom rules\n*\n');
    await store.captureSnapshot(input);
    expect(await readFile(ignore, 'utf8')).toBe('# keep custom rules\n*\n');
  });

  it('does not delete a file outside the snapshot folder when pruning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-snapidx-'));
    const dir = join(root, '.vscode', 'filemaker', 'snapshots');
    await mkdir(dir, { recursive: true });
    const victim = join(root, '.vscode', 'victim.txt');
    await writeFile(victim, 'keep me');
    await writeFile(
      join(dir, 'index.json'),
      JSON.stringify({
        schemaVersion: 1,
        items: [
          { id: 'old', profileId: 'p', layout: 'L', capturedAt: '2000-01-01T00:00:00.000Z', source: 'manual', schemaVersion: 1, fileName: '../../victim.txt' },
          'not an object',
          { id: 5 }
        ]
      })
    );

    const store = new SchemaSnapshotStore(
      { get: <T>(_key: string, fallback?: T) => fallback as T, update: async () => undefined } as never,
      { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      {
        getStorageMode: () => 'workspaceFiles',
        getWorkspaceRoot: () => root,
        isWorkspaceTrusted: () => true,
        getMaxPerLayout: () => 1
      }
    );

    await store.captureSnapshot({ profileId: 'p', layout: 'L', source: 'manual', metadata: {} });
    await store.captureSnapshot({ profileId: 'p', layout: 'L', source: 'manual', metadata: {} });

    expect(existsSync(victim)).toBe(true);
  });
});
