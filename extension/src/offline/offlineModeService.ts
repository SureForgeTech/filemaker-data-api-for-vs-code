import { isPlainJsonFileName } from '../utils/safeText';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

import * as vscode from 'vscode';

import type { ConnectionProfile } from '../types/fm';
import { assertSafeOutputFolder } from '../services/generatedFileWriter';
import { hashObjectWithAlgorithm } from '../utils/hash';
import { resolveConfinedFile } from '../utils/pathConfinement';
import { isOfflineModeOn } from '../utils/policySetting';

const OFFLINE_CACHE_DIR = '.vscode/filemaker/offline-metadata';
const OFFLINE_INDEX_FILE = 'index.json';
const OFFLINE_SCHEMA_VERSION = 1;

interface OfflineIndexRecord {
  profileId: string;
  database: string;
  apiBasePath: string;
  apiVersionPath: string;
  layout: string;
  capturedAt: string;
  hash: string;
  fileName: string;
}

interface OfflineIndexDocument {
  schemaVersion: number;
  items: OfflineIndexRecord[];
}

export interface OfflineToggleResult {
  /** What the toggle asked for. */
  requested: boolean;
  /** Offline mode as it is in effect after the change. */
  effective: boolean;
  /** Set when the mode is still on although the toggle asked for off. */
  keptOnBy?: string;
}

interface OfflineModeServiceOptions {
  getWorkspaceRoot?: () => string | undefined;
  getConfiguration?: () => vscode.WorkspaceConfiguration;
  isWorkspaceTrusted?: () => boolean;
}

export class OfflineModeService {
  private readonly getWorkspaceRoot: () => string | undefined;
  private readonly getConfiguration: () => vscode.WorkspaceConfiguration;
  private readonly isWorkspaceTrusted: () => boolean;

  public constructor(
    private readonly logger: Pick<
      {
        warn: (message: string, meta?: unknown) => void;
      },
      'warn'
    >,
    options?: OfflineModeServiceOptions
  ) {
    this.getWorkspaceRoot = options?.getWorkspaceRoot ?? (() => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    this.getConfiguration = options?.getConfiguration ?? (() => vscode.workspace.getConfiguration('filemaker'));
    this.isWorkspaceTrusted = options?.isWorkspaceTrusted ?? (() => vscode.workspace.isTrusted);
  }

  public isOfflineModeEnabled(): boolean {
    return isOfflineModeOn(this.getConfiguration());
  }

  /**
   * Switches offline mode in the user's own settings. It never writes the workspace scope:
   * that needs an open folder, drops a `.vscode/settings.json` into the repository, and a
   * repository could not loosen the mode anyway (a workspace value only counts when it turns
   * offline mode ON). The result carries the mode that is in effect afterwards, because
   * another setting (a workspace one, or a remote machine's) can keep it on.
   */
  public async toggleOfflineMode(enabled?: boolean): Promise<OfflineToggleResult> {
    const requested = enabled ?? !this.isOfflineModeEnabled();
    await this.getConfiguration().update('offline.mode', requested, vscode.ConfigurationTarget.Global);

    const effective = this.isOfflineModeEnabled();
    const result: OfflineToggleResult = { requested, effective };
    if (effective && !requested) {
      result.keptOnBy = this.findOfflineModeSource();
    }
    return result;
  }

  /** Where an `offline.mode: true` that outlives the user's own switch is coming from. */
  private findOfflineModeSource(): string {
    const inspect = this.getConfiguration().inspect?.<boolean>('offline.mode') as
      | (ReturnType<vscode.WorkspaceConfiguration['inspect']> & {
          globalLocalValue?: boolean;
          globalRemoteValue?: boolean;
        })
      | undefined;
    if (inspect?.workspaceFolderValue === true) {
      return 'the workspace folder settings';
    }
    if (inspect?.workspaceValue === true) {
      return 'the workspace settings';
    }
    if (inspect?.globalRemoteValue === true) {
      return 'the remote machine settings';
    }
    if (inspect?.globalValue === true || inspect?.globalLocalValue === true) {
      return 'your user settings';
    }
    return 'another settings source';
  }

  public async cacheLayoutMetadata(
    profile: ConnectionProfile,
    layout: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    const dir = await this.ensureCacheDir();
    if (!dir) {
      return;
    }

    const hashAlgorithm = this.getConfiguration().get<string>('schema.hashAlgorithm', 'sha256');
    const hash = hashObjectWithAlgorithm(metadata, hashAlgorithm);
    const capturedAt = new Date().toISOString();

    const safeProfileId = sanitizeFileName(profile.id);
    const safeLayout = sanitizeFileName(layout);
    const fileName = `${safeProfileId}__${safeLayout}__${capturedAt.replace(/[:.]/g, '-')}.json`;

    const payload = {
      schemaVersion: OFFLINE_SCHEMA_VERSION,
      profile: {
        id: profile.id,
        database: profile.database,
        apiBasePath: profile.apiBasePath ?? '/fmi/data',
        apiVersionPath: profile.apiVersionPath ?? 'vLatest'
      },
      layout,
      capturedAt,
      hash,
      metadata
    };

    await writeFile(await this.confinedCacheFile(fileName), JSON.stringify(payload, null, 2), 'utf8');

    const index = await this.readIndex(OFFLINE_INDEX_FILE);
    const key = cacheKey(profile.id, profile.database, profile.apiBasePath, profile.apiVersionPath, layout);

    const retained = index.items.filter((item) => {
      return cacheKey(item.profileId, item.database, item.apiBasePath, item.apiVersionPath, item.layout) !== key;
    });

    retained.unshift({
      profileId: profile.id,
      database: profile.database,
      apiBasePath: profile.apiBasePath ?? '/fmi/data',
      apiVersionPath: profile.apiVersionPath ?? 'vLatest',
      layout,
      capturedAt,
      hash,
      fileName
    });

    index.items = retained.slice(0, 1000);
    await writeFile(await this.confinedCacheFile(OFFLINE_INDEX_FILE), JSON.stringify(index, null, 2), 'utf8');
  }

  public async getCachedLayoutMetadata(
    profile: ConnectionProfile,
    layout: string
  ): Promise<{
    metadata: Record<string, unknown>;
    hash: string;
    capturedAt: string;
  } | undefined> {
    if (!this.getCacheDir()) {
      return undefined;
    }

    const index = await this.readIndex(OFFLINE_INDEX_FILE);
    const key = cacheKey(profile.id, profile.database, profile.apiBasePath, profile.apiVersionPath, layout);

    const match = index.items.find(
      (item) =>
        cacheKey(item.profileId, item.database, item.apiBasePath, item.apiVersionPath, item.layout) === key
    );

    if (!match) {
      return undefined;
    }

    try {
      const raw = await readFile(await this.confinedCacheFile(match.fileName), 'utf8');
      const parsed = JSON.parse(raw) as {
        metadata?: Record<string, unknown>;
        hash?: string;
        capturedAt?: string;
      };

      if (!parsed.metadata || typeof parsed.metadata !== 'object') {
        return undefined;
      }

      return {
        metadata: parsed.metadata,
        hash: typeof parsed.hash === 'string' ? parsed.hash : match.hash,
        capturedAt: typeof parsed.capturedAt === 'string' ? parsed.capturedAt : match.capturedAt
      };
    } catch (error) {
      this.logger.warn('Failed to read offline metadata cache file.', {
        fileName: match.fileName,
        error
      });
      return undefined;
    }
  }

  public async refreshCache(
    profile: ConnectionProfile,
    listLayouts: () => Promise<string[]>,
    loadMetadata: (layout: string) => Promise<Record<string, unknown>>
  ): Promise<{ cached: number; failed: number }> {
    if (!this.isWorkspaceTrusted()) {
      throw new Error('Workspace is untrusted. Offline cache refresh is disabled.');
    }

    const layouts = await listLayouts();
    let cached = 0;
    let failed = 0;

    for (const layout of layouts) {
      try {
        const metadata = await loadMetadata(layout);
        await this.cacheLayoutMetadata(profile, layout, metadata);
        cached += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn('Failed to refresh offline metadata for layout.', {
          profileId: profile.id,
          layout,
          error
        });
      }
    }

    return { cached, failed };
  }

  public async listCacheEntries(): Promise<OfflineIndexRecord[]> {
    if (!this.getCacheDir()) {
      return [];
    }

    const index = await this.readIndex(OFFLINE_INDEX_FILE);
    return [...index.items];
  }

  private getCacheDir(): string | undefined {
    const root = this.getWorkspaceRoot();
    if (!root) {
      return undefined;
    }

    return join(root, OFFLINE_CACHE_DIR);
  }

  private async ensureCacheDir(): Promise<string | undefined> {
    if (!this.isWorkspaceTrusted()) {
      return undefined;
    }

    const dir = this.getCacheDir();
    if (!dir) {
      return undefined;
    }

    const root = this.getWorkspaceRoot() as string;
    await assertSafeOutputFolder(dir, root);
    await mkdir(dir, { recursive: true });
    await assertSafeOutputFolder(dir, root);
    return dir;
  }

  /** A file in the cache folder, proved to have no link anywhere on its path below the workspace root. */
  private async confinedCacheFile(fileName: string): Promise<string> {
    const root = this.getWorkspaceRoot() as string;
    return (await resolveConfinedFile(join(OFFLINE_CACHE_DIR, fileName), root, [root])).path;
  }

  private async readIndex(fileName: string): Promise<OfflineIndexDocument> {
    try {
      const raw = await readFile(await this.confinedCacheFile(fileName), 'utf8');
      const parsed = JSON.parse(raw) as OfflineIndexDocument;

      if (!Array.isArray(parsed.items)) {
        throw new Error('Invalid offline metadata index.');
      }

      return {
        schemaVersion:
          typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : OFFLINE_SCHEMA_VERSION,
        items: parsed.items.filter((item): item is OfflineIndexRecord => isOfflineIndexRecord(item))
      };
    } catch {
      return {
        schemaVersion: OFFLINE_SCHEMA_VERSION,
        items: []
      };
    }
  }
}

function isOfflineIndexRecord(value: unknown): value is OfflineIndexRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const item = value as Record<string, unknown>;
  return (
    typeof item.profileId === 'string' &&
    typeof item.database === 'string' &&
    typeof item.apiBasePath === 'string' &&
    typeof item.apiVersionPath === 'string' &&
    typeof item.layout === 'string' &&
    typeof item.capturedAt === 'string' &&
    typeof item.hash === 'string' &&
    isPlainJsonFileName(item.fileName)
  );
}

function cacheKey(
  profileId: string,
  database: string,
  apiBasePath: string | undefined,
  apiVersionPath: string | undefined,
  layout: string
): string {
  return `${profileId}::${database}::${apiBasePath ?? '/fmi/data'}::${apiVersionPath ?? 'vLatest'}::${layout}`;
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_');
}
