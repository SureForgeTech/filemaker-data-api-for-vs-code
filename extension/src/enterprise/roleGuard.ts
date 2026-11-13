import { readFile } from 'fs/promises';
import { join } from 'path';

import * as vscode from 'vscode';

import { ROLE_RANK } from './roles';
import type { EnterpriseRole, PerformanceMode } from '../types/fm';
import { isOfflineModeOn } from '../utils/policySetting';

const ENTERPRISE_CONFIG_RELATIVE_PATH = '.vscode/filemaker.config.json';

function isRole(value: unknown): value is EnterpriseRole {
  return value === 'viewer' || value === 'developer' || value === 'admin';
}

export type EnterpriseFeatureId =
  | 'recordEdit'
  | 'batchUpdate'
  | 'environmentExport'
  | 'pluginInstall'
  | 'scriptRunner'
  | 'writeOperations'
  | 'ai';

export interface EnvironmentSetSeed {
  name: string;
  profiles: string[];
}

export interface EnterpriseConfigFile {
  lockedProfiles?: string[];
  disabledFeatures?: EnterpriseFeatureId[];
  defaultEnvironmentSets?: EnvironmentSetSeed[];
  enforcedPerformanceMode?: PerformanceMode;
  enterpriseMode?: boolean;
  role?: EnterpriseRole;
}

interface RoleGuardOptions {
  getConfiguration?: () => vscode.WorkspaceConfiguration;
  isWorkspaceTrusted?: () => boolean;
  getWorkspaceRoot?: () => string | undefined;
  readConfigFile?: (absolutePath: string) => Promise<string | undefined>;
  openExternal?: (uri: vscode.Uri) => Thenable<boolean>;
}

export interface FeatureGuardResult {
  allowed: boolean;
  reason?: string;
}

export class RoleGuard {
  private enterpriseConfig: EnterpriseConfigFile | undefined;

  private readonly getConfiguration: () => vscode.WorkspaceConfiguration;
  private readonly isWorkspaceTrusted: () => boolean;
  private readonly getWorkspaceRoot: () => string | undefined;
  private readonly readConfigFile: (absolutePath: string) => Promise<string | undefined>;
  private readonly openExternal: (uri: vscode.Uri) => Thenable<boolean>;

  public constructor(
    private readonly logger: Pick<
      {
        debug: (message: string, meta?: unknown) => void;
        warn: (message: string, meta?: unknown) => void;
      },
      'debug' | 'warn'
    >,
    options?: RoleGuardOptions
  ) {
    this.getConfiguration = options?.getConfiguration ?? (() => vscode.workspace.getConfiguration('filemaker'));
    this.isWorkspaceTrusted = options?.isWorkspaceTrusted ?? (() => vscode.workspace.isTrusted);
    this.getWorkspaceRoot =
      options?.getWorkspaceRoot ?? (() => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    this.readConfigFile =
      options?.readConfigFile ??
      (async (absolutePath: string) => {
        try {
          return await readFile(absolutePath, 'utf8');
        } catch {
          return undefined;
        }
      });
    this.openExternal = options?.openExternal ?? ((uri) => vscode.env.openExternal(uri));
  }

  public async refresh(): Promise<void> {
    this.enterpriseConfig = await this.loadEnterpriseConfig();
  }

  public async applyContexts(): Promise<void> {
    await this.refresh();

    await vscode.commands.executeCommand('setContext', 'filemaker.enterprise.mode', this.isEnterpriseModeEnabled());
    await vscode.commands.executeCommand('setContext', 'filemaker.enterprise.role', this.getRole());
    await vscode.commands.executeCommand('setContext', 'filemaker.offline.mode', this.isOfflineModeEnabled());
  }

  /**
   * A setting split by where it was set. The user's own setting (or the default) is the
   * baseline a workspace cannot loosen: a repository ships `.vscode/settings.json` and
   * `.vscode/filemaker.config.json`, and neither may switch off a restriction the user
   * or their administrator chose. `workspace` is what the repository asked for.
   */
  private readSetting<T>(key: string, fallback: T): { baseline: T; workspace: T | undefined } {
    const configuration = this.getConfiguration();
    if (typeof configuration.inspect !== 'function') {
      return { baseline: configuration.get<T>(key, fallback), workspace: undefined };
    }

    const inspected = configuration.inspect<T>(key) as
      | (ReturnType<vscode.WorkspaceConfiguration['inspect']> & {
          globalLocalValue?: T;
          globalRemoteValue?: T;
        })
      | undefined;
    if (!inspected) {
      return { baseline: fallback, workspace: undefined };
    }

    return {
      baseline:
        (inspected.globalValue as T | undefined) ??
        inspected.globalRemoteValue ??
        inspected.globalLocalValue ??
        (inspected.defaultValue as T | undefined) ??
        fallback,
      workspace: (inspected.workspaceFolderValue ?? inspected.workspaceValue) as T | undefined
    };
  }

  /** A workspace may turn enterprise mode on for itself; it can never turn it off. */
  public isEnterpriseModeEnabled(): boolean {
    const setting = this.readSetting<boolean>('enterprise.mode', false);
    if (setting.workspace === false || this.enterpriseConfig?.enterpriseMode === false) {
      if (setting.baseline === true) {
        this.logger.warn('Ignored a workspace attempt to turn enterprise mode off.', {
          source: ENTERPRISE_CONFIG_RELATIVE_PATH
        });
      }
    }

    return setting.baseline === true || setting.workspace === true || this.enterpriseConfig?.enterpriseMode === true;
  }

  /** A workspace may lower the role for itself; it can never raise it above the user's own. */
  public getRole(): EnterpriseRole {
    const setting = this.readSetting<EnterpriseRole>('enterprise.role', 'developer');
    const candidates: EnterpriseRole[] = [isRole(setting.baseline) ? setting.baseline : 'developer'];
    for (const requested of [setting.workspace, this.enterpriseConfig?.role]) {
      if (isRole(requested)) {
        candidates.push(requested);
      }
    }

    return candidates.reduce((lowest, role) => (ROLE_RANK[role] < ROLE_RANK[lowest] ? role : lowest));
  }

  /** What `.vscode/filemaker.config.json` asks for, for the Effective Settings view. */
  public getEnterpriseFileSettings(): { enterpriseMode?: boolean; role?: EnterpriseRole } {
    return { enterpriseMode: this.enterpriseConfig?.enterpriseMode, role: this.enterpriseConfig?.role };
  }

  public isOfflineModeEnabled(): boolean {
    return isOfflineModeOn(this.getConfiguration());
  }

  public resolvePerformanceMode(): PerformanceMode {
    if (this.enterpriseConfig?.enforcedPerformanceMode) {
      return this.enterpriseConfig.enforcedPerformanceMode;
    }

    const configured = this.getConfiguration().get<PerformanceMode>('performance.mode', 'standard');
    return configured === 'high-scale' ? 'high-scale' : 'standard';
  }

  public isProfileLocked(profileId: string): boolean {
    return (this.enterpriseConfig?.lockedProfiles ?? []).includes(profileId);
  }

  public getDefaultEnvironmentSetSeeds(): EnvironmentSetSeed[] {
    return this.enterpriseConfig?.defaultEnvironmentSets ?? [];
  }

  public getFeatureGuard(feature: EnterpriseFeatureId): FeatureGuardResult {
    const disabledFeatures = this.enterpriseConfig?.disabledFeatures ?? [];
    if (disabledFeatures.includes(feature)) {
      return {
        allowed: false,
        reason: `This feature is disabled by ${ENTERPRISE_CONFIG_RELATIVE_PATH}.`
      };
    }

    if (!this.isWorkspaceTrusted() && TRUST_REQUIRED_FEATURES[feature]) {
      return {
        allowed: false,
        reason: `${TRUST_REQUIRED_FEATURES[feature]} is disabled in untrusted workspaces.`
      };
    }

    if (this.isOfflineModeEnabled() && WRITE_FEATURES.has(feature)) {
      return {
        allowed: false,
        reason: 'Offline mode is enabled; write operations are disabled.'
      };
    }

    if (!this.isEnterpriseModeEnabled()) {
      return { allowed: true };
    }

    const role = this.getRole();
    if (role === 'admin') {
      return { allowed: true };
    }

    if (role === 'viewer' && VIEWER_BLOCKED_FEATURES.has(feature)) {
      return {
        allowed: false,
        reason: 'Enterprise role "viewer" is read-only for this command.'
      };
    }

    if (role === 'developer' && DEVELOPER_BLOCKED_FEATURES.has(feature)) {
      return {
        allowed: false,
        reason: 'Enterprise role "developer" is restricted for this command.'
      };
    }

    return { allowed: true };
  }

  public async assertFeature(feature: EnterpriseFeatureId, actionLabel: string): Promise<boolean> {
    const guard = this.getFeatureGuard(feature);
    if (guard.allowed) {
      return true;
    }

    const showLearnMore = guard.reason?.includes('untrusted workspaces') ?? false;

    const selection = await vscode.window.showWarningMessage(
      `${actionLabel} is unavailable. ${guard.reason ?? 'Feature is restricted by policy.'}`,
      ...(showLearnMore ? ['Workspace Trust Docs'] : [])
    );

    if (selection === 'Workspace Trust Docs') {
      await this.openExternal(
        vscode.Uri.parse('https://code.visualstudio.com/docs/editor/workspace-trust')
      );
    }

    return false;
  }

  private async loadEnterpriseConfig(): Promise<EnterpriseConfigFile | undefined> {
    if (!this.isWorkspaceTrusted()) {
      return undefined;
    }
    const root = this.getWorkspaceRoot();
    if (!root) {
      return undefined;
    }

    const filePath = join(root, ENTERPRISE_CONFIG_RELATIVE_PATH);
    const content = await this.readConfigFile(filePath);
    if (!content) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      return normalizeConfig(parsed);
    } catch (error) {
      this.logger.warn('Failed to parse enterprise config file.', {
        filePath,
        error
      });
      return undefined;
    }
  }
}

/**
 * Features that need a trusted workspace, with the capability named in the refusal. A
 * repository controls `.vscode/settings.json` and the generated files these act on, so
 * an untrusted one must not be able to edit or create records or run scripts through the
 * user's saved connections. `writeOperations` is deliberately not here: it also gates
 * adding a profile and creating an environment set, which are the user's own settings.
 */
const TRUST_REQUIRED_FEATURES: Partial<Record<EnterpriseFeatureId, string>> = {
  pluginInstall: 'Plugin loading',
  recordEdit: 'Record editing',
  scriptRunner: 'Running scripts'
};

const WRITE_FEATURES = new Set<EnterpriseFeatureId>([
  'recordEdit',
  'batchUpdate',
  'writeOperations',
  'scriptRunner'
]);

const VIEWER_BLOCKED_FEATURES = new Set<EnterpriseFeatureId>([
  'recordEdit',
  'batchUpdate',
  'environmentExport',
  'pluginInstall',
  'scriptRunner',
  'writeOperations'
]);

const DEVELOPER_BLOCKED_FEATURES = new Set<EnterpriseFeatureId>(['environmentExport', 'pluginInstall']);

function normalizeConfig(parsed: Record<string, unknown>): EnterpriseConfigFile {
  const role =
    parsed.role === 'viewer' || parsed.role === 'developer' || parsed.role === 'admin'
      ? parsed.role
      : undefined;

  const enforcedPerformanceMode =
    parsed.enforcedPerformanceMode === 'standard' || parsed.enforcedPerformanceMode === 'high-scale'
      ? parsed.enforcedPerformanceMode
      : undefined;

  const disabledFeatures = Array.isArray(parsed.disabledFeatures)
    ? parsed.disabledFeatures
        .filter(
          (value): value is EnterpriseFeatureId =>
            value === 'recordEdit' ||
            value === 'batchUpdate' ||
            value === 'environmentExport' ||
            value === 'pluginInstall' ||
            value === 'scriptRunner' ||
            value === 'writeOperations' ||
            value === 'ai'
        )
        .filter((value, index, self) => self.indexOf(value) === index)
    : undefined;

  const defaultEnvironmentSets = Array.isArray(parsed.defaultEnvironmentSets)
    ? parsed.defaultEnvironmentSets
        .map((value) => toEnvironmentSetSeed(value))
        .filter((value): value is EnvironmentSetSeed => Boolean(value))
    : undefined;

  const lockedProfiles = Array.isArray(parsed.lockedProfiles)
    ? parsed.lockedProfiles.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : undefined;

  return {
    role,
    enforcedPerformanceMode,
    disabledFeatures,
    defaultEnvironmentSets,
    lockedProfiles,
    enterpriseMode: typeof parsed.enterpriseMode === 'boolean' ? parsed.enterpriseMode : undefined
  };
}

function toEnvironmentSetSeed(value: unknown): EnvironmentSetSeed | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!name) {
    return undefined;
  }

  const profiles = Array.isArray(record.profiles)
    ? record.profiles
        .filter((profile): profile is string => typeof profile === 'string' && profile.trim().length > 0)
        .map((profile) => profile.trim())
    : [];

  if (profiles.length === 0) {
    return undefined;
  }

  return {
    name,
    profiles: Array.from(new Set(profiles))
  };
}
