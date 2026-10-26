import { standardControlFor } from '@fmweb/shared/dist/field-standards';
import { access, mkdir, readdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

import * as vscode from 'vscode';

import {
  createBlankLayout,
  migrateLayoutDefinition,
  validateLayoutDefinition,
  type LayoutDefinition
} from '../fmweb/layoutSchema';

import type { FMClient } from './fmClient';
import type { Logger } from './logger';
import type { ProfileStore } from './profileStore';
import type { SchemaService } from './schemaService';
import type { ConnectionProfile } from '../types/fm';
import {
  FMWEB_METADATA_SCHEMA_VERSION,
  FMWEB_PROJECT_SCHEMA_VERSION,
  type FmWebFeatureFlags,
  type FmWebEnvironmentProfile,
  type FmWebLayoutLoadResult,
  type FmWebMetadataCache,
  type FmWebProjectConfig,
  type FmWebSyncSummary
} from '../types/fmWeb';
import { distinctFileName } from '../utils/safeText';
import { assertSafeOutputFolder } from './generatedFileWriter';
import { resolveConfinedFile } from '../utils/pathConfinement';
import { designerLayoutMetadata, type DesignerLayoutMetadata } from '../fmweb/fieldMetadata';

const FMWEB_FOLDER = '.fmweb';
const DEFAULT_FEATURE_FLAGS: FmWebFeatureFlags = {
  runtimeGenerationEnabled: true,
  bridgeServerEnabled: true,
  commercialModeEnabled: false
};

export class FmWebProjectService {
  private readonly changeListeners = new Set<() => void>();

  public constructor(
    private readonly profileStore: Pick<ProfileStore, 'setActiveProfileId'>,
    private readonly fmClient: Pick<FMClient, 'listLayouts' | 'getLayoutMetadata' | 'listScripts'>,
    private readonly schemaService: Pick<SchemaService, 'getLayoutSchema'>,
    private readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>
  ) {}

  /** Calls `listener` after this service writes the project file (the project now exists, or changed). */
  public onDidChangeProject(listener: () => void): { dispose(): void } {
    this.changeListeners.add(listener);
    return { dispose: () => void this.changeListeners.delete(listener) };
  }

  public getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  public isWorkspaceTrusted(): boolean {
    return vscode.workspace.isTrusted;
  }

  public getProjectRoot(): string {
    return path.join(this.requireWorkspaceRoot(), FMWEB_FOLDER);
  }

  public async initializeProject(projectName?: string): Promise<FmWebProjectConfig> {
    this.assertWorkspaceTrusted();

    const now = new Date().toISOString();
    const existing = await this.readProjectConfig();

    const project: FmWebProjectConfig = {
      schemaVersion: FMWEB_PROJECT_SCHEMA_VERSION,
      name: projectName?.trim() || existing?.name || 'FM Web Project',
      activeProfileId: existing?.activeProfileId,
      activeEnvironmentId: existing?.activeEnvironmentId,
      environments: existing?.environments ?? [],
      featureFlags: existing?.featureFlags ?? DEFAULT_FEATURE_FLAGS,
      license: existing?.license,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    await this.ensureProjectDirectories();
    await this.writeJson(this.getProjectConfigPath(), project);
    for (const listener of [...this.changeListeners]) {
      try {
        listener();
      } catch {
        // a listener must not break initialising
      }
    }

    return project;
  }

  public async ensureProjectInitialized(): Promise<FmWebProjectConfig> {
    await assertSafeOutputFolder(this.getProjectRoot(), this.requireWorkspaceRoot());
    const existing = await this.readProjectConfig();
    if (existing) {
      return existing;
    }

    return this.initializeProject();
  }

  public async readProjectConfig(): Promise<FmWebProjectConfig | undefined> {
    const filePath = this.getProjectConfigPath();
    const value = await this.readJsonSafe<unknown>(filePath);

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    const raw = value as Record<string, unknown>;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) {
      return undefined;
    }

    return {
      schemaVersion:
        typeof raw.schemaVersion === 'number' && Number.isInteger(raw.schemaVersion)
          ? raw.schemaVersion
          : FMWEB_PROJECT_SCHEMA_VERSION,
      name,
      activeProfileId: typeof raw.activeProfileId === 'string' ? raw.activeProfileId : undefined,
      activeEnvironmentId: typeof raw.activeEnvironmentId === 'string' ? raw.activeEnvironmentId : undefined,
      environments: parseEnvironmentProfiles(raw.environments),
      featureFlags: parseFeatureFlags(raw.featureFlags),
      license: parseLicense(raw.license),
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString()
    };
  }

  public async setActiveProfile(profileId: string): Promise<void> {
    await this.profileStore.setActiveProfileId(profileId);

    if (!this.isWorkspaceTrusted()) {
      return;
    }

    const project = await this.ensureProjectInitialized();
    project.activeProfileId = profileId;
    project.updatedAt = new Date().toISOString();
    await this.writeJson(this.getProjectConfigPath(), project);
  }

  public async loadMetadataCache(): Promise<FmWebMetadataCache | undefined> {
    return this.readJsonSafe<FmWebMetadataCache>(this.getMetadataIndexPath());
  }

  public async syncMetadata(profile: ConnectionProfile): Promise<FmWebSyncSummary> {
    this.assertWorkspaceTrusted();

    await this.ensureProjectInitialized();

    const layouts = await this.fmClient.listLayouts(profile);
    const scripts = await this.safeListScripts(profile);

    const layoutMetadata: FmWebMetadataCache['layoutMetadata'] = [];
    const tableOccurrences = new Set<string>();
    const allFields = new Set<string>();

    for (const layoutName of layouts) {
      try {
        const metadata = await this.fmClient.getLayoutMetadata(profile, layoutName);
        const fields = await this.resolveLayoutFields(profile, layoutName, metadata);
        const occurrences = extractTableOccurrences(metadata);

        for (const fieldName of fields) {
          allFields.add(fieldName);
        }

        for (const occurrence of occurrences) {
          tableOccurrences.add(occurrence);
        }

        const metadataFileName = `${toSafeFileName(layoutName)}.json`;
        // path-join disposition: the file name is built from toSafeFileName, so it has no separator and no ".." segment.
        const metadataFilePath = path.join(this.getMetadataLayoutsDirPath(), metadataFileName);

        await this.writeJson(metadataFilePath, {
          profileId: profile.id,
          layoutName,
          fields,
          tableOccurrences: occurrences,
          metadata
        });

        layoutMetadata.push({
          layoutName,
          fields,
          tableOccurrences: occurrences,
          metadataFile: metadataFileName
        });
      } catch (error) {
        this.logger.warn('Failed to sync metadata for layout.', {
          profileId: profile.id,
          layoutName,
          error
        });
      }
    }

    const cache: FmWebMetadataCache = {
      schemaVersion: FMWEB_METADATA_SCHEMA_VERSION,
      syncedAt: new Date().toISOString(),
      profileId: profile.id,
      profileName: profile.name,
      database: profile.database,
      layouts,
      scripts,
      layoutMetadata
    };

    await this.writeJson(this.getMetadataIndexPath(), cache);

    return {
      layoutCount: cache.layouts.length,
      scriptCount: cache.scripts.length,
      tableOccurrenceCount: tableOccurrences.size,
      fieldCount: allFields.size
    };
  }

  public async loadOrCreateLayout(layoutId?: string): Promise<FmWebLayoutLoadResult> {
    this.assertWorkspaceTrusted();
    await this.ensureProjectInitialized();

    const explicitId = sanitizeLayoutId(layoutId);
    if (explicitId) {
      const explicitPath = this.getLayoutFilePath(explicitId);
      if (await exists(explicitPath)) {
        const loaded = await this.readLayoutFromPath(explicitPath);
        return {
          layout: loaded,
          source: 'existing',
          filePath: explicitPath
        };
      }
    }

    const directory = this.getLayoutsDirPath();
    const entries = await readdir(directory);
    const layoutFileName = entries.find((entry) => entry.endsWith('.layout.json'));

    if (layoutFileName) {
      const fullPath = path.join(directory, layoutFileName);
      const loaded = await this.readLayoutFromPath(fullPath);

      return {
        layout: loaded,
        source: 'existing',
        filePath: fullPath
      };
    }

    const blank = createBlankLayout('Main Layout');
    const blankPath = this.getLayoutFilePath(blank.id);
    await this.writeJson(blankPath, blank);

    return {
      layout: blank,
      source: 'created',
      filePath: blankPath
    };
  }

  public async saveLayout(layout: LayoutDefinition): Promise<string> {
    this.assertWorkspaceTrusted();
    await this.ensureProjectInitialized();

    const validated = validateLayoutDefinition(await this.prepareLayout(layout));
    const filePath = this.getLayoutFilePath(validated.id);
    await this.writeJson(filePath, validated);

    return filePath;
  }

  public async prepareLayout(layout: LayoutDefinition): Promise<LayoutDefinition> {
    if (!layout.fmLayoutName) return layout;
    const [metadata] = await this.getDesignerLayouts([layout.fmLayoutName]);
    // The generated page shows the fields in the order of the FileMaker layout.
    const fieldOrder = metadata?.fields.map((field) => field.name);
    return { ...layout, fieldOrder: fieldOrder?.length ? fieldOrder : layout.fieldOrder, objects: layout.objects.map((object) => {
      if (object.type !== 'field') return object;
      const field = metadata?.fields.find((item) => item.name === object.fmFieldName);
      if (!field) return object;
      const control = standardControlFor(field);
      return { ...object, kind: field.kind ?? object.kind, result: field.type ?? object.result,
        displayType: object.displayType !== 'editBox' ? object.displayType : control.kind === 'select' ? 'dropdown'
          : control.kind === 'checkbox' ? 'checkbox' : control.kind === 'radio' ? 'radio' : 'editBox',
        multiline: control.kind === 'textarea' || object.multiline,
        options: field.options ?? object.options, required: field.required ?? object.required };
    }) };
  }

  public async getAvailableFields(layoutName?: string): Promise<string[]> {
    const cache = await this.loadMetadataCache();
    if (!cache) {
      return [];
    }

    if (layoutName) {
      const exact = cache.layoutMetadata.find((item) => item.layoutName === layoutName);
      return exact ? exact.fields : [];
    }

    const fields = new Set<string>();
    for (const entry of cache.layoutMetadata) {
      for (const field of entry.fields) {
        fields.add(field);
      }
    }

    return [...fields].sort((a, b) => a.localeCompare(b));
  }

  public async getDesignerLayouts(layoutNames?: string[]): Promise<DesignerLayoutMetadata[]> {
    const cache = await this.loadMetadataCache();
    return Promise.all((cache?.layoutMetadata ?? []).filter((entry) => !layoutNames || layoutNames.includes(entry.layoutName)).map(async (entry) => {
      // The index is a workspace file. A metadata filename must stay inside its directory.
      const fileName = path.basename(entry.metadataFile);
      let stored: { metadata?: Record<string, unknown> } | undefined;
      if (fileName === entry.metadataFile) {
        try {
          const confined = await resolveConfinedFile(
            path.join(this.getMetadataLayoutsDirPath(), fileName), this.getProjectRoot(), [this.getProjectRoot()]
          );
          stored = await this.readJsonSafe(confined.path);
        } catch {
          // Old/missing metadata or an unsafe path falls back to the cached names.
        }
      }
      const parsed = designerLayoutMetadata(entry.layoutName, stored?.metadata ?? {});
      return { ...parsed, fields: parsed.fields.length ? parsed.fields : entry.fields.map((name) => ({ name })) };
    }));
  }

  public getProjectConfigPath(): string {
    return path.join(this.getProjectRoot(), 'project.json');
  }

  public getMetadataIndexPath(): string {
    return path.join(this.getProjectRoot(), 'metadata', 'index.json');
  }

  public getMetadataLayoutsDirPath(): string {
    return path.join(this.getProjectRoot(), 'metadata', 'layouts');
  }

  public getLayoutsDirPath(): string {
    return path.join(this.getProjectRoot(), 'layouts');
  }

  public getGeneratedDirPath(): string {
    return path.join(this.getProjectRoot(), 'generated');
  }

  private async ensureProjectDirectories(): Promise<void> {
    const projectRoot = this.getProjectRoot();
    const directories = [projectRoot, path.join(projectRoot, 'metadata'), path.join(projectRoot, 'metadata', 'layouts'),
      path.join(projectRoot, 'layouts'), path.join(projectRoot, 'generated')];
    for (const directory of directories) await assertSafeOutputFolder(directory, this.requireWorkspaceRoot());
    for (const directory of directories) await mkdir(directory, { recursive: true });
  }

  private async readLayoutFromPath(filePath: string): Promise<LayoutDefinition> {
    const raw = await readFile(filePath, 'utf8');
    return migrateLayoutDefinition(JSON.parse(raw));
  }

  private getLayoutFilePath(layoutId: string): string {
    const safeId = sanitizeLayoutId(layoutId) ?? 'layout';
    return path.join(this.getLayoutsDirPath(), `${safeId}.layout.json`);
  }

  private async resolveLayoutFields(
    profile: ConnectionProfile,
    layoutName: string,
    metadata: Record<string, unknown>
  ): Promise<string[]> {
    const fromMetadata = extractFieldNames(metadata);
    if (fromMetadata.length > 0) {
      return fromMetadata;
    }

    try {
      const schema = await this.schemaService.getLayoutSchema(profile, layoutName);
      return schema.fields
        .map((field) => field.name)
        .filter((name) => typeof name === 'string' && name.length > 0);
    } catch {
      return [];
    }
  }

  private async safeListScripts(profile: ConnectionProfile): Promise<string[]> {
    try {
      return await this.fmClient.listScripts(profile);
    } catch (error) {
      this.logger.warn('Script list endpoint not available for metadata sync.', {
        profileId: profile.id,
        error
      });
      return [];
    }
  }

  private async writeJson(filePath: string, payload: unknown): Promise<void> {
    await assertSafeOutputFolder(filePath, this.requireWorkspaceRoot());
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  private async readJsonSafe<T>(filePath: string): Promise<T | undefined> {
    if (!(await exists(filePath))) {
      return undefined;
    }

    try {
      const raw = await readFile(filePath, 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  private requireWorkspaceRoot(): string {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error('Open a workspace folder to use FM Web project features.');
    }

    return workspaceRoot;
  }

  private assertWorkspaceTrusted(): void {
    if (!this.isWorkspaceTrusted()) {
      throw new Error('Workspace trust is required for FM Web project filesystem operations.');
    }
  }
}

function parseEnvironmentProfiles(value: unknown): FmWebEnvironmentProfile[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const parsed: FmWebEnvironmentProfile[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }

    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const profileId = typeof record.profileId === 'string' ? record.profileId.trim() : '';
    if (!id || !name || !profileId) {
      continue;
    }

    parsed.push({
      id,
      name,
      profileId,
      database: typeof record.database === 'string' ? record.database.trim() ? record.database : undefined : undefined
    });
  }

  return parsed;
}

function parseFeatureFlags(value: unknown): FmWebFeatureFlags {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_FEATURE_FLAGS;
  }

  const record = value as Record<string, unknown>;
  return {
    runtimeGenerationEnabled:
      typeof record.runtimeGenerationEnabled === 'boolean'
        ? record.runtimeGenerationEnabled
        : DEFAULT_FEATURE_FLAGS.runtimeGenerationEnabled,
    bridgeServerEnabled:
      typeof record.bridgeServerEnabled === 'boolean'
        ? record.bridgeServerEnabled
        : DEFAULT_FEATURE_FLAGS.bridgeServerEnabled,
    commercialModeEnabled:
      typeof record.commercialModeEnabled === 'boolean'
        ? record.commercialModeEnabled
        : DEFAULT_FEATURE_FLAGS.commercialModeEnabled
  };
}

function parseLicense(value: unknown): FmWebProjectConfig['license'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const tier = typeof record.tier === 'string' ? record.tier.trim() : '';
  const keyId = typeof record.keyId === 'string' ? record.keyId.trim() : '';
  if (!tier && !keyId) {
    return undefined;
  }

  return {
    tier: tier || undefined,
    keyId: keyId || undefined
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function extractFieldNames(metadata: Record<string, unknown>): string[] {
  const fields = new Set<string>();
  const candidates: unknown[] = [
    metadata.fieldMetaData,
    metadata.fieldMetadata,
    metadata.fields,
    getNested(metadata, ['response', 'fieldMetaData']),
    getNested(metadata, ['layout', 'fieldMetaData'])
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }

    for (const item of candidate) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        continue;
      }

      const record = item as Record<string, unknown>;
      const fieldName =
        typeof record.name === 'string'
          ? record.name
          : typeof record.fieldName === 'string'
            ? record.fieldName
            : undefined;

      if (fieldName && fieldName.trim().length > 0) {
        fields.add(fieldName);
      }
    }
  }

  return [...fields];
}

function extractTableOccurrences(metadata: Record<string, unknown>): string[] {
  const occurrences = new Set<string>();
  const candidates: unknown[] = [
    metadata.tableOccurrence,
    metadata.tableOccurrenceName,
    metadata.baseTable,
    getNested(metadata, ['response', 'tableOccurrence']),
    getNested(metadata, ['response', 'tableOccurrenceName']),
    getNested(metadata, ['layoutInfo', 'tableOccurrence'])
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      occurrences.add(candidate.trim());
      continue;
    }

    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (typeof item === 'string' && item.trim().length > 0) {
          occurrences.add(item.trim());
        }
      }
    }
  }

  return [...occurrences].sort((a, b) => a.localeCompare(b));
}

function getNested(value: Record<string, unknown>, pathSegments: string[]): unknown {
  let current: unknown = value;

  for (const segment of pathSegments) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function toSafeFileName(raw: string): string {
  const sanitized = raw
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);

  return distinctFileName(raw, sanitized);
}

function sanitizeLayoutId(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }

  const safe = raw.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 120);
  return safe.length > 0 ? safe : undefined;
}
