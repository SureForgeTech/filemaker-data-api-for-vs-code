import { getHashes } from 'crypto';

import * as vscode from 'vscode';

import type { EnterpriseRole, PerformanceMode, SavedQueryScope, SchemaSnapshotStorage } from '../types/fm';
import type { LogLevel } from './logger';
import type { SecretFallbackMode } from './secretStore';
import { DEFAULT_CONTAINER_UPLOAD_MAX_BYTES, normalizeContainerUploadMaxBytes } from '../utils/containerUpload';
import { usableRelativeDir } from '../utils/relativeDir';
import { isFeatureEnabled, isOfflineModeOn, readMaxRetries, readPerformanceMode } from '../utils/policySetting';
import { isFormulaNeutralizationOn } from '../utils/userScopeSetting';

/**
 * Lazily computed allow-list of crypto hash algorithms available on this Node
 * runtime. We cache it because getHashes() is moderately expensive and the set
 * is fixed for the process lifetime.
 */
let cachedHashAlgorithms: Set<string> | undefined;
function supportedHashAlgorithms(): Set<string> {
  if (!cachedHashAlgorithms) {
    cachedHashAlgorithms = new Set(getHashes().map((name) => name.toLowerCase()));
  }
  return cachedHashAlgorithms;
}

const LEGACY_SECTION = 'filemakerDataApiTools';

/** Deprecated `filemakerDataApiTools.<old>` keys and their `filemaker.<new>` replacements. */
export const DEPRECATED_SETTING_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['logLevel', 'logging.level'],
  ['requestTimeoutMs', 'requestTimeoutMs'],
  ['defaultApiBasePath', 'defaultApiBasePath'],
  ['defaultApiVersionPath', 'defaultApiVersionPath']
];

interface SettingsServiceOptions {
  getConfiguration?: (section?: string) => vscode.WorkspaceConfiguration;
  isWorkspaceTrusted?: () => boolean;
}

export class SettingsService {
  private readonly getConfiguration: (section?: string) => vscode.WorkspaceConfiguration;
  private readonly isWorkspaceTrusted: () => boolean;

  /**
   * Tracks which deprecated `filemakerDataApiTools.*` setting names we've already
   * surfaced to the user this session. Lets `getDeprecatedSettingsUsed` report
   * once per key so onActivate can show a single toast covering everything.
   */
  private readonly deprecatedKeysSeen = new Set<string>();

  public constructor(options?: SettingsServiceOptions) {
    this.getConfiguration = options?.getConfiguration ?? ((section) => vscode.workspace.getConfiguration(section));
    this.isWorkspaceTrusted = options?.isWorkspaceTrusted ?? (() => vscode.workspace.isTrusted);
  }

  /**
   * Resolves a setting that moved from `filemakerDataApiTools.<oldKey>` to
   * `filemaker.<newKey>` scope by scope, most specific first: folder, then
   * workspace, then user. Within a scope the new key wins over the old one.
   * When the old key supplies the value it is recorded in deprecatedKeysSeen so
   * the caller can offer a one-time migration.
   */
  private getPreferred<T>(
    newSection: string,
    newKey: string,
    oldSection: string,
    oldKey: string,
    defaultValue: T
  ): T {
    const newConfig = this.getConfiguration(newSection);
    const newInspect = newConfig.inspect<T>(newKey);
    const oldInspect = this.getConfiguration(oldSection).inspect<T>(oldKey);
    const scopes = ['workspaceFolderValue', 'workspaceValue', 'globalValue'] as const;

    for (const scope of scopes) {
      const newValue = newInspect?.[scope];
      if (newValue !== undefined) {
        return newValue;
      }
      const oldValue = oldInspect?.[scope];
      if (oldValue !== undefined) {
        this.deprecatedKeysSeen.add(`${oldSection}.${oldKey}`);
        return oldValue;
      }
    }

    return newConfig.get<T>(newKey, defaultValue);
  }

  /**
   * Moves explicitly set deprecated `filemakerDataApiTools.*` values to their
   * `filemaker.*` replacements and removes the old values. Because getPreferred
   * resolves scope by scope with the new key winning inside each scope, copying
   * old to new in a scope where the new key is unset (and dropping an old value
   * the new key already shadows) leaves every effective value unchanged, in this
   * workspace and in any other workspace sharing the user settings. Covers user
   * and workspace scopes; folder-level values are left alone. Returns the old
   * keys that were migrated.
   */
  public async migrateDeprecatedSettings(): Promise<string[]> {
    const oldConfig = this.getConfiguration(LEGACY_SECTION);
    const newConfig = this.getConfiguration('filemaker');
    const scopes: Array<['globalValue' | 'workspaceValue', vscode.ConfigurationTarget]> = [
      ['globalValue', vscode.ConfigurationTarget.Global],
      ['workspaceValue', vscode.ConfigurationTarget.Workspace]
    ];
    const migrated = new Set<string>();

    for (const [oldKey, newKey] of DEPRECATED_SETTING_KEYS) {
      const oldInspect = oldConfig.inspect<unknown>(oldKey);
      const newInspect = newConfig.inspect<unknown>(newKey);
      for (const [scope, target] of scopes) {
        const oldValue = oldInspect?.[scope];
        if (oldValue === undefined) {
          continue;
        }
        if (newInspect?.[scope] === undefined) {
          await newConfig.update(newKey, oldValue, target);
        }
        await oldConfig.update(oldKey, undefined, target);
        migrated.add(`${LEGACY_SECTION}.${oldKey}`);
      }
    }

    return [...migrated];
  }

  /** Returns the deprecated setting keys observed this session and clears the set. */
  public consumeDeprecatedSettingsUsed(): string[] {
    const out = [...this.deprecatedKeysSeen];
    this.deprecatedKeysSeen.clear();
    return out;
  }

  public getLoggingLevel(): LogLevel {
    const configured = this.getPreferred<string | undefined>(
      'filemaker',
      'logging.level',
      'filemakerDataApiTools',
      'logLevel',
      undefined
    );

    if (configured === 'debug' || configured === 'info' || configured === 'warn' || configured === 'error') {
      return configured;
    }

    return 'info';
  }

  public getRequestTimeoutMs(): number {
    const configured = this.getPreferred<number>(
      'filemaker',
      'requestTimeoutMs',
      'filemakerDataApiTools',
      'requestTimeoutMs',
      15_000
    );
    if (!Number.isFinite(configured)) {
      return 15_000;
    }

    return clamp(Math.round(configured), 1_000, 120_000);
  }

  public getDefaultApiBasePath(): string {
    const configured = this.getPreferred<unknown>(
      'filemaker',
      'defaultApiBasePath',
      'filemakerDataApiTools',
      'defaultApiBasePath',
      '/fmi/data'
    );
    // A hand-edited settings.json can hold any JSON type here.
    if (typeof configured !== 'string') {
      return '/fmi/data';
    }

    return normalizeApiPath(configured, '/fmi/data');
  }

  public getDefaultApiVersionPath(): string {
    const configured = this.getPreferred<unknown>(
      'filemaker',
      'defaultApiVersionPath',
      'filemakerDataApiTools',
      'defaultApiVersionPath',
      'vLatest'
    );
    if (typeof configured !== 'string') {
      return 'vLatest';
    }
    const trimmed = configured.trim();

    return trimmed.length > 0 ? trimmed.replace(/^\/+|\/+$/g, '') : 'vLatest';
  }

  public getSavedQueriesScope(): SavedQueryScope {
    const configured = this.getConfiguration('filemaker').get<string>('savedQueries.scope', 'workspace');
    return configured === 'global' ? 'global' : 'workspace';
  }

  public getSchemaCacheTtlSeconds(): number {
    const configured = this.getConfiguration('filemaker').get<number>('schema.cacheTtlSeconds', 300);
    if (!Number.isFinite(configured)) {
      return 300;
    }

    return clamp(Math.round(configured), 10, 86_400);
  }

  public isSchemaMetadataEnabled(): boolean {
    return this.getConfiguration('filemaker').get<boolean>('schema.metadataEnabled', true);
  }

  public getHistoryMaxEntries(): number {
    const configured = this.getConfiguration('filemaker').get<number>('history.maxEntries', 10);
    if (!Number.isInteger(configured) || configured <= 0) {
      return 10;
    }

    return clamp(configured, 1, 200);
  }

  public shouldIncludeAuthInSnippetsByDefault(): boolean {
    return this.getConfiguration('filemaker').get<boolean>('snippets.includeAuthByDefault', false);
  }

  public isScriptRunnerEnabled(): boolean {
    return isFeatureEnabled(this.getConfiguration('filemaker'), 'features.scriptRunner.enabled');
  }

  public getSchemaSnapshotsStorage(): SchemaSnapshotStorage {
    const configured = this.getConfiguration('filemaker').get<string>(
      'schema.snapshots.storage',
      this.isWorkspaceTrusted() ? 'workspaceFiles' : 'workspaceState'
    );

    if (!this.isWorkspaceTrusted()) {
      return 'workspaceState';
    }

    return configured === 'workspaceState' ? 'workspaceState' : 'workspaceFiles';
  }

  public getSnapshotsMaxPerLayout(): number {
    const configured = this.getConfiguration('filemaker').get<number>('schema.snapshots.maxPerLayout', 20);
    if (!Number.isFinite(configured)) {
      return 20;
    }

    return clamp(Math.round(configured), 1, 100);
  }

  public isSchemaDiagnosticsEnabled(): boolean {
    return this.getConfiguration('filemaker').get<boolean>('schema.diagnostics.enabled', false);
  }

  public getTypegenOutputDir(): string {
    const configured = this.getConfiguration('filemaker').get<string>('typegen.outputDir', 'filemaker-types');
    return sanitizeRelativeDir(configured, 'filemaker-types');
  }

  public getBatchMaxRecords(): number {
    const configured = this.getConfiguration('filemaker').get<number>('batch.maxRecords', 10_000);
    if (!Number.isFinite(configured)) {
      return 10_000;
    }

    return clamp(Math.round(configured), 1, 1_000_000);
  }

  public getBatchConcurrency(): number {
    const configured = this.getConfiguration('filemaker').get<number>('batch.concurrency', 4);
    if (!Number.isFinite(configured)) {
      return 4;
    }

    return clamp(Math.round(configured), 1, 10);
  }

  public getBatchDryRunDefault(): boolean {
    return this.getConfiguration('filemaker').get<boolean>('batch.dryRunDefault', true);
  }

  public isRecordEditEnabled(): boolean {
    return isFeatureEnabled(this.getConfiguration('filemaker'), 'features.recordEdit.enabled');
  }

  public isBatchEnabled(): boolean {
    return isFeatureEnabled(this.getConfiguration('filemaker'), 'features.batch.enabled');
  }

  public getContainerUploadMaxBytes(): number {
    return normalizeContainerUploadMaxBytes(
      this.getConfiguration('filemaker').get<number>(
        'containerUploadMaxBytes',
        DEFAULT_CONTAINER_UPLOAD_MAX_BYTES
      )
    );
  }

  public isEnterpriseModeEnabled(): boolean {
    return this.getConfiguration('filemaker').get<boolean>('enterprise.mode', false);
  }

  /**
   * Controls whether the advanced/diagnostic command palette entries
   * (Show Jobs, Open Diagnostics Dashboard, Circuit Breaker, plugins,
   * profile import/export) surface in the FileMaker command palette.
   * Default false to keep the palette focused for new users.
   */
  public isPowerUserModeEnabled(): boolean {
    return this.getConfiguration('filemaker').get<boolean>('advanced.powerUserMode', false);
  }

  public getEnterpriseRole(): EnterpriseRole {
    const configured = this.getConfiguration('filemaker').get<string>('enterprise.role', 'developer');
    if (configured === 'viewer' || configured === 'developer' || configured === 'admin') {
      return configured;
    }

    return 'developer';
  }

  public getPerformanceMode(): PerformanceMode {
    return readPerformanceMode(this.getConfiguration('filemaker'));
  }

  public isOfflineModeEnabled(): boolean {
    return isOfflineModeOn(this.getConfiguration('filemaker'));
  }

  public getOfflineStaleCacheWarnHours(): number {
    const configured = this.getConfiguration('filemaker').get<number>('offline.staleCacheWarnHours', 24);
    if (!Number.isFinite(configured) || configured < 0) {
      return 24;
    }
    return Math.round(configured);
  }

  /**
   * Returns a hash algorithm name that is guaranteed to be supported by the
   * current Node `crypto` runtime. Unknown / empty values silently fall back to
   * `sha256` and are reported via the optional warning callback so the user
   * sees the rejection.
   */
  public getSchemaHashAlgorithm(onInvalid?: (configured: string) => void): string {
    const raw = this.getConfiguration('filemaker').get<string>('schema.hashAlgorithm', 'sha256').trim();
    if (raw.length === 0) {
      return 'sha256';
    }
    const supported = supportedHashAlgorithms();
    const normalized = raw.toLowerCase();
    if (supported.has(normalized)) {
      return raw;
    }
    onInvalid?.(raw);
    return 'sha256';
  }

  public getConnectBackoffPolicy(): {
    maxRetries: number;
    initialMs: number;
    maxMs: number;
    multiplier: number;
  } {
    const config = this.getConfiguration('filemaker');
    const maxRetries = readMaxRetries(config);
    const initialMs = config.get<number>('connect.backoffInitialMs', 1_000);
    const maxMs = config.get<number>('connect.backoffMaxMs', 30_000);
    const multiplier = config.get<number>('connect.backoffMultiplier', 2);
    return {
      maxRetries: clamp(Number.isFinite(maxRetries) ? Math.round(maxRetries) : 3, 0, 10),
      initialMs: clamp(Number.isFinite(initialMs) ? Math.round(initialMs) : 1_000, 100, 60_000),
      maxMs: clamp(Number.isFinite(maxMs) ? Math.round(maxMs) : 30_000, 1_000, 300_000),
      multiplier:
        Number.isFinite(multiplier) && multiplier >= 1 ? Math.min(10, multiplier) : 2
    };
  }

  public getBridgeRateLimitConfig(): { perSecond: number; burst: number; budget: number } {
    const config = this.getConfiguration('filemaker');
    const perSecond = config.get<number>('fmWeb.bridge.rateLimitPerSecond', 20);
    const burst = config.get<number>('fmWeb.bridge.rateLimitBurst', 60);
    const budget = config.get<number>('fmWeb.bridge.requestBudget', 10_000);
    return {
      perSecond: clamp(Number.isFinite(perSecond) ? Math.round(perSecond) : 20, 1, 1_000),
      burst: clamp(Number.isFinite(burst) ? Math.round(burst) : 60, 1, 10_000),
      budget: clamp(Number.isFinite(budget) ? Math.round(budget) : 10_000, 100, 10_000_000)
    };
  }

  public getConnectionWizardTestPolicy(): 'off' | 'warn' | 'block' {
    const configured = this.getConfiguration('filemaker').get<string>(
      'connectionWizard.requireTestBeforeSave',
      'warn'
    );
    if (configured === 'off' || configured === 'block') {
      return configured;
    }
    return 'warn';
  }

  public getSessionMaxAgeMs(): number {
    const minutes = this.getConfiguration('filemaker').get<number>('session.maxAgeMinutes', 14);
    if (!Number.isFinite(minutes)) {
      return 14 * 60_000;
    }
    return clamp(Math.round(minutes), 1, 30) * 60_000;
  }

  public getSessionRefreshLeadMs(): number {
    const seconds = this.getConfiguration('filemaker').get<number>('session.refreshLeadSeconds', 30);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return 30_000;
    }
    return clamp(Math.round(seconds), 0, 300) * 1_000;
  }

  /** `filemaker.export.neutralizeFormulas`: user settings only; on unless the user turned it off. */
  public getNeutralizeExportFormulas(): boolean {
    return isFormulaNeutralizationOn(this.getConfiguration('filemaker'));
  }

  public getSecretsFallbackMode(): SecretFallbackMode {
    const configured = this.getConfiguration('filemaker').get<string>(
      'secrets.fallback',
      'vscode-only'
    );
    if (configured === 'workspace-state' || configured === 'disabled') {
      return configured;
    }
    return 'vscode-only';
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeApiPath(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  if (!trimmed.startsWith('/')) {
    return `/${trimmed.replace(/\/+$/, '')}`;
  }

  return trimmed.replace(/\/+$/, '');
}

function sanitizeRelativeDir(value: string, fallback: string): string {
  return usableRelativeDir(value) ?? fallback;
}
