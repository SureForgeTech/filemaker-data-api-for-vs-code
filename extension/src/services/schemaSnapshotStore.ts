import { isPlainJsonFileName } from '../utils/safeText';
import { randomUUID } from 'crypto';
import { mkdir, readdir, readFile, unlink, writeFile } from 'fs/promises';
import { join } from 'path';

import type * as vscode from 'vscode';

import type {
  SchemaSnapshot,
  SchemaSnapshotSource,
  SchemaSnapshotStorage,
  SchemaSnapshotSummary
} from '../types/fm';
import type { Logger } from './logger';

const SNAPSHOT_SCHEMA_VERSION = 1;
const SNAPSHOT_KEY = 'filemaker.schema.snapshots.items';
const SNAPSHOT_VERSION_KEY = 'filemaker.schema.snapshots.version';
const SNAPSHOT_FILE_DIR = '.vscode/filemaker/snapshots';
const SNAPSHOT_INDEX_FILE = 'index.json';

interface SnapshotIndexFile {
  schemaVersion: number;
  items: Array<SchemaSnapshotSummary & { fileName: string }>;
}

interface CaptureSnapshotInput {
  profileId: string;
  layout: string;
  source: SchemaSnapshotSource;
  metadata: Record<string, unknown>;
}

interface SnapshotStoreOptions {
  getStorageMode?: () => SchemaSnapshotStorage;
  getWorkspaceRoot?: () => string | undefined;
  isWorkspaceTrusted?: () => boolean;
  getMaxPerLayout?: () => number;
}

export class SchemaSnapshotStore {
  private initializedState = false;
  private readonly getStorageModeFromConfig: () => SchemaSnapshotStorage;
  private readonly getWorkspaceRoot: () => string | undefined;
  private readonly isWorkspaceTrusted: () => boolean;
  private readonly getMaxPerLayout: () => number;

  public constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>,
    options?: SnapshotStoreOptions
  ) {
    this.getStorageModeFromConfig = options?.getStorageMode ?? (() => 'workspaceState');
    this.getWorkspaceRoot = options?.getWorkspaceRoot ?? (() => undefined);
    this.isWorkspaceTrusted = options?.isWorkspaceTrusted ?? (() => true);
    this.getMaxPerLayout = options?.getMaxPerLayout ?? (() => 20);
  }

  public async captureSnapshot(input: CaptureSnapshotInput): Promise<SchemaSnapshot> {
    const snapshot: SchemaSnapshot = {
      id: randomUUID(),
      profileId: input.profileId,
      layout: input.layout,
      capturedAt: new Date().toISOString(),
      source: input.source,
      metadata: sanitizeMetadata(input.metadata),
      schemaVersion: SNAPSHOT_SCHEMA_VERSION
    };

    const storageMode = this.resolveStorageMode();
    if (storageMode === 'workspaceFiles') {
      await this.persistToWorkspaceFiles(snapshot);
    } else {
      await this.persistToWorkspaceState(snapshot);
    }

    await this.pruneSnapshots(snapshot.profileId, snapshot.layout);

    return snapshot;
  }

  public async listSnapshots(filter?: {
    profileId?: string;
    layout?: string;
  }): Promise<SchemaSnapshotSummary[]> {
    const snapshots = await this.loadAllSnapshots();

    return snapshots
      .filter((snapshot) => !filter?.profileId || snapshot.profileId === filter.profileId)
      .filter((snapshot) => !filter?.layout || snapshot.layout === filter.layout)
      .map((snapshot) => toSummary(snapshot))
      .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
  }

  public async getSnapshot(snapshotId: string): Promise<SchemaSnapshot | undefined> {
    const snapshots = await this.loadAllSnapshots();
    return snapshots.find((snapshot) => snapshot.id === snapshotId);
  }

  public async getLatestSnapshot(
    profileId: string,
    layout: string
  ): Promise<SchemaSnapshot | undefined> {
    const snapshots = await this.listSnapshots({ profileId, layout });
    const latest = snapshots[0];
    if (!latest) {
      return undefined;
    }

    return this.getSnapshot(latest.id);
  }

  private async pruneSnapshots(profileId: string, layout: string): Promise<void> {
    const maxPerLayout = this.getMaxPerLayout();
    const mode = this.resolveStorageMode();

    try {
      if (mode === 'workspaceFiles') {
        await this.pruneWorkspaceFileSnapshots(profileId, layout, maxPerLayout);
      } else {
        await this.pruneWorkspaceStateSnapshots(profileId, layout, maxPerLayout);
      }
    } catch (error) {
      this.logger.warn('Failed to prune old snapshots.', { profileId, layout, error });
    }
  }

  private async pruneWorkspaceStateSnapshots(
    profileId: string,
    layout: string,
    maxPerLayout: number
  ): Promise<void> {
    await this.ensureWorkspaceStateInitialized();
    const all = this.workspaceState.get<SchemaSnapshot[]>(SNAPSHOT_KEY, []);

    const matching = all
      .filter((s) => s.profileId === profileId && s.layout === layout)
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));

    if (matching.length <= maxPerLayout) {
      return;
    }

    const idsToRemove = new Set(matching.slice(maxPerLayout).map((s) => s.id));
    const pruned = all.filter((s) => !idsToRemove.has(s.id));
    await this.workspaceState.update(SNAPSHOT_KEY, pruned);

    this.logger.info(`Pruned ${idsToRemove.size} old snapshot(s) for layout "${layout}".`);
  }

  private async pruneWorkspaceFileSnapshots(
    profileId: string,
    layout: string,
    maxPerLayout: number
  ): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) {
      return;
    }

    const dir = join(root, SNAPSHOT_FILE_DIR);
    const indexPath = join(dir, SNAPSHOT_INDEX_FILE);
    const index = await this.readIndexFile(indexPath);

    const matching = index.items
      .filter((item) => item.profileId === profileId && item.layout === layout)
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));

    if (matching.length <= maxPerLayout) {
      return;
    }

    const toRemove = matching.slice(maxPerLayout);
    const idsToRemove = new Set(toRemove.map((item) => item.id));

    for (const item of toRemove) {
      try {
        // path-join disposition: the file name comes from the index file and is checked by isIndexEntry/isPlainJsonFileName, so it has no separator and no ".." segment.
        await unlink(join(dir, item.fileName));
      } catch {
        this.logger.warn('Failed to delete pruned snapshot file.', { fileName: item.fileName });
      }
    }

    index.items = index.items.filter((item) => !idsToRemove.has(item.id));
    await writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8');

    this.logger.info(`Pruned ${toRemove.length} old snapshot(s) for layout "${layout}".`);
  }

  private resolveStorageMode(): SchemaSnapshotStorage {
    if (!this.isWorkspaceTrusted()) {
      return 'workspaceState';
    }

    if (this.getStorageModeFromConfig() === 'workspaceFiles' && this.getWorkspaceRoot()) {
      return 'workspaceFiles';
    }

    return 'workspaceState';
  }

  private async persistToWorkspaceState(snapshot: SchemaSnapshot): Promise<void> {
    await this.ensureWorkspaceStateInitialized();

    const existing = this.workspaceState.get<SchemaSnapshot[]>(SNAPSHOT_KEY, []);
    existing.push(snapshot);
    await this.workspaceState.update(SNAPSHOT_KEY, existing);
  }

  private async ensureWorkspaceStateInitialized(): Promise<void> {
    if (this.initializedState) {
      return;
    }

    const version = this.workspaceState.get<number>(SNAPSHOT_VERSION_KEY);
    if (version !== SNAPSHOT_SCHEMA_VERSION) {
      const snapshots = this.workspaceState.get<SchemaSnapshot[]>(SNAPSHOT_KEY, []);
      const normalized = snapshots
        .map((snapshot) => normalizeSnapshot(snapshot))
        .filter((snapshot): snapshot is SchemaSnapshot => Boolean(snapshot));
      await this.workspaceState.update(SNAPSHOT_KEY, normalized);
      await this.workspaceState.update(SNAPSHOT_VERSION_KEY, SNAPSHOT_SCHEMA_VERSION);
    }

    this.initializedState = true;
  }

  private async persistToWorkspaceFiles(snapshot: SchemaSnapshot): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) {
      this.logger.warn('Workspace root not available for workspaceFiles snapshot storage.');
      await this.persistToWorkspaceState(snapshot);
      return;
    }

    const dir = join(root, SNAPSHOT_FILE_DIR);
    await mkdir(dir, { recursive: true });

    const safeProfile = toSafeFileName(snapshot.profileId);
    const safeLayout = toSafeFileName(snapshot.layout);
    const safeId = toSafeFileName(snapshot.id);
    const safeDate = snapshot.capturedAt.replace(/[:.]/g, '-');
    const fileName = `${safeProfile}__${safeLayout}__${safeDate}__${safeId}.json`;
    // path-join disposition: the name is built from toSafeFileName values, so it has no separator and no ".." segment.
    const snapshotPath = join(dir, fileName);
    await writeFile(snapshotPath, JSON.stringify({ snapshot }, null, 2), 'utf8');

    const indexPath = join(dir, SNAPSHOT_INDEX_FILE);
    const index = await this.readIndexFile(indexPath);

    index.items.push({
      ...toSummary(snapshot),
      fileName
    });

    await writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8');
  }

  private async loadAllSnapshots(): Promise<SchemaSnapshot[]> {
    const mode = this.resolveStorageMode();
    if (mode === 'workspaceFiles') {
      return this.loadFromWorkspaceFiles();
    }

    await this.ensureWorkspaceStateInitialized();
    return this.workspaceState
      .get<SchemaSnapshot[]>(SNAPSHOT_KEY, [])
      .map((snapshot) => normalizeSnapshot(snapshot))
      .filter((snapshot): snapshot is SchemaSnapshot => Boolean(snapshot));
  }

  private async loadFromWorkspaceFiles(): Promise<SchemaSnapshot[]> {
    const root = this.getWorkspaceRoot();
    if (!root) {
      return [];
    }

    const dir = join(root, SNAPSHOT_FILE_DIR);
    let fileNames: string[];
    try {
      fileNames = await readdir(dir);
    } catch {
      return [];
    }

    const snapshots: SchemaSnapshot[] = [];

    for (const fileName of fileNames) {
      if (!fileName.endsWith('.json') || fileName === SNAPSHOT_INDEX_FILE) {
        continue;
      }

      try {
        const content = await readFile(join(dir, fileName), 'utf8');
        const parsed = JSON.parse(content) as { snapshot?: SchemaSnapshot };
        const normalized = normalizeSnapshot(parsed.snapshot);
        if (normalized) {
          snapshots.push(normalized);
        }
      } catch (error) {
        this.logger.warn('Failed to parse schema snapshot file.', { fileName, error });
      }
    }

    return snapshots.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
  }

  private async readIndexFile(indexPath: string): Promise<SnapshotIndexFile> {
    try {
      const content = await readFile(indexPath, 'utf8');
      const parsed = JSON.parse(content) as SnapshotIndexFile;
      if (!Array.isArray(parsed.items)) {
        throw new Error('Invalid index file.');
      }

      return {
        schemaVersion:
          typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : SNAPSHOT_SCHEMA_VERSION,
        items: parsed.items.filter(isIndexEntry)
      };
    } catch {
      return {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        items: []
      };
    }
  }
}

function toSummary(snapshot: SchemaSnapshot): SchemaSnapshotSummary {
  return {
    id: snapshot.id,
    profileId: snapshot.profileId,
    layout: snapshot.layout,
    capturedAt: snapshot.capturedAt,
    source: snapshot.source,
    schemaVersion: snapshot.schemaVersion
  };
}

function normalizeSnapshot(snapshot: SchemaSnapshot | undefined): SchemaSnapshot | undefined {
  if (!snapshot) {
    return undefined;
  }

  if (
    typeof snapshot.id !== 'string' ||
    typeof snapshot.profileId !== 'string' ||
    typeof snapshot.layout !== 'string' ||
    typeof snapshot.capturedAt !== 'string' ||
    typeof snapshot.source !== 'string' ||
    !snapshot.metadata ||
    typeof snapshot.metadata !== 'object'
  ) {
    return undefined;
  }

  if (snapshot.source !== 'manual' && snapshot.source !== 'auto') {
    return undefined;
  }

  return {
    id: snapshot.id,
    profileId: snapshot.profileId,
    layout: snapshot.layout,
    capturedAt: snapshot.capturedAt,
    source: snapshot.source,
    metadata: snapshot.metadata,
    schemaVersion:
      typeof snapshot.schemaVersion === 'number' ? snapshot.schemaVersion : SNAPSHOT_SCHEMA_VERSION
  };
}

function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return sanitizeValue(metadata) as Record<string, unknown>;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const [key, entryValue] of Object.entries(record)) {
      if (/password|token|authorization|api[_-]?key/i.test(key)) {
        sanitized[key] = '***';
        continue;
      }

      sanitized[key] = sanitizeValue(entryValue);
    }

    return sanitized;
  }

  return value;
}

/**
 * The index file sits in the workspace, so a cloned repository can ship its own. An entry is
 * only used when it is well formed and names a plain snapshot file in this folder; otherwise
 * `join(dir, fileName)` could point anywhere the user can write (pruning deletes that file).
 */
function isIndexEntry(value: unknown): value is SchemaSnapshotSummary & { fileName: string } {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.profileId === 'string' &&
    typeof entry.layout === 'string' &&
    typeof entry.capturedAt === 'string' &&
    typeof entry.fileName === 'string' &&
    isPlainJsonFileName(entry.fileName) &&
    entry.fileName !== SNAPSHOT_INDEX_FILE
  );
}

function toSafeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_');
}
