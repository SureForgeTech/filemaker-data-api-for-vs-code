import * as vscode from 'vscode';
import type { SecretStore } from './secretStore';

import type { ConnectionProfile, SavedQuery } from '../types/fm';
import { FMClientError } from './errors';
import { normalizeSha256 } from './tlsAgent';
import { validateDatabaseName, validateProfileId, validateServerUrl } from '../utils/jsonValidate';

const PROFILES_KEY = 'filemakerDataApiTools.profiles';
const ACTIVE_PROFILE_KEY = 'filemakerDataApiTools.activeProfileId';
const SAVED_QUERIES_KEY = 'filemakerDataApiTools.savedQueries';

export class ProfileStore {
  private readonly changeListeners = new Set<() => void>();

  private observedState: string;
  private migration: Promise<void> | undefined;
  private readonly credentialWarnings = new Set<string>();

  public constructor(
    private readonly globalState: vscode.Memento,
    private readonly workspaceState: vscode.Memento,
    private readonly secrets?: Pick<SecretStore, 'getPassword' | 'setPassword'>
  ) {
    this.observedState = this.profileState();
  }

  private profileState(): string {
    return JSON.stringify([this.globalState.get(PROFILES_KEY), this.globalState.get(ACTIVE_PROFILE_KEY)]);
  }

  /** Memento has no public change event; observe updates delivered from other VS Code windows. */
  public watchExternalChanges(): { dispose(): void } {
    const timer = setInterval(() => this.checkForExternalChanges(), 2000);
    timer.unref();
    return { dispose: () => clearInterval(timer) };
  }

  public checkForExternalChanges(): void {
    if (this.profileState() !== this.observedState) {
      this.fireChange();
    }
  }

  /** Calls `listener` after profiles are added, changed or removed, or the active profile changes. */
  public onDidChange(listener: () => void): { dispose(): void } {
    this.changeListeners.add(listener);
    return { dispose: () => void this.changeListeners.delete(listener) };
  }

  private fireChange(): void {
    this.observedState = this.profileState();
    for (const listener of [...this.changeListeners]) {
      try {
        listener();
      } catch {
        // a listener must not break a save
      }
    }
  }

  public async listProfiles(): Promise<ConnectionProfile[]> {
    await this.migrateUrlCredentials();
    return this.listProfilesSync();
  }

  private async migrateUrlCredentials(): Promise<void> {
    if (this.migration) return this.migration;
    this.migration = this.removeUrlCredentials();
    try {
      await this.migration;
    } finally {
      this.migration = undefined;
    }
  }

  private async removeUrlCredentials(): Promise<void> {
    const raw = this.globalState.get<unknown>(PROFILES_KEY, []);
    if (!Array.isArray(raw)) return;
    let changed = false;
    const profiles: unknown[] = [];
    for (const value of raw) {
      const normalized = normalizeProfile(value);
      if (!normalized) { profiles.push(value); continue; }
      const original = value as ConnectionProfile;
      const url = new URL(original.serverUrl);
      if (!url.username && !url.password) { profiles.push(value); continue; }
      changed = true;
      if (!this.credentialWarnings.has(normalized.id)) {
        this.credentialWarnings.add(normalized.id);
        void vscode.window.showWarningMessage(
          'Removed credentials from a saved FileMaker server address. Re-enter or confirm the credential in Edit Connection Profile before connecting.'
        );
      }
      // Never overwrite a separately saved password. An unusable URL password is discarded.
      if (original.authMode === 'direct' && url.password && this.secrets) {
        let password: string | undefined;
        try { password = decodeURIComponent(url.password); } catch { /* ask the user to re-enter it */ }
        try {
          if (password !== undefined && await this.secrets.getPassword(normalized.id) === undefined) {
            await this.secrets.setPassword(normalized.id, password);
          }
        } catch {
          // Keep the profile usable and the address safe even when SecretStorage is unavailable.
          // The warning above asks the user to re-enter the credential.
        }
      }
      profiles.push(normalized);
    }
    if (changed) {
      await this.globalState.update(PROFILES_KEY, profiles);
      this.fireChange();
    }
  }

  /** The stored profiles without waiting; a webview needs them before its first paint. */
  public listProfilesSync(): ConnectionProfile[] {
    const rawProfiles = this.globalState.get<unknown>(PROFILES_KEY, []);
    if (!Array.isArray(rawProfiles)) {
      return [];
    }

    return rawProfiles
      .map((profile) => normalizeProfile(profile))
      .filter((profile): profile is ConnectionProfile => Boolean(profile));
  }

  public async getProfile(id: string): Promise<ConnectionProfile | undefined> {
    const profiles = await this.listProfiles();
    return profiles.find((profile) => profile.id === id);
  }

  public async upsertProfile(profile: ConnectionProfile): Promise<void> {
    const normalizedProfile = validateConnectionProfile(profile);
    const profiles = await this.listProfiles();
    const existingIndex = profiles.findIndex((item) => item.id === normalizedProfile.id);

    if (existingIndex >= 0) {
      profiles[existingIndex] = normalizedProfile;
    } else {
      profiles.push(normalizedProfile);
    }

    await this.globalState.update(PROFILES_KEY, profiles);
    this.fireChange();
  }

  public async removeProfile(profileId: string): Promise<void> {
    const profiles = await this.listProfiles();
    const filtered = profiles.filter((profile) => profile.id !== profileId);
    await this.globalState.update(PROFILES_KEY, filtered);

    const activeProfileId = this.getActiveProfileId();
    if (activeProfileId === profileId) {
      await this.setActiveProfileId(undefined);
    }

    const savedQueries = this.listSavedQueries();
    const remaining = savedQueries.filter((query) => query.profileId !== profileId);
    await this.workspaceState.update(SAVED_QUERIES_KEY, remaining);
    this.fireChange();
  }

  public getActiveProfileId(): string | undefined {
    return this.globalState.get<string>(ACTIVE_PROFILE_KEY);
  }

  public async setActiveProfileId(profileId: string | undefined): Promise<void> {
    await this.globalState.update(ACTIVE_PROFILE_KEY, profileId);
    this.fireChange();
  }

  public listSavedQueries(): SavedQuery[] {
    return this.workspaceState.get<SavedQuery[]>(SAVED_QUERIES_KEY, []);
  }

  public async saveQuery(query: SavedQuery): Promise<void> {
    const queries = this.listSavedQueries();
    const existingIndex = queries.findIndex((item) => item.id === query.id);

    if (existingIndex >= 0) {
      queries[existingIndex] = query;
    } else {
      queries.push(query);
    }

    await this.workspaceState.update(SAVED_QUERIES_KEY, queries);
  }

  public async removeSavedQuery(queryId: string): Promise<void> {
    const queries = this.listSavedQueries();
    await this.workspaceState.update(
      SAVED_QUERIES_KEY,
      queries.filter((query) => query.id !== queryId)
    );
  }
}

function normalizeProfile(value: unknown): ConnectionProfile | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  try {
    // Reading is lenient about a user name or password in the address: a profile saved
    // that way before it was rejected must stay visible so it can be fixed, not vanish
    // (and be dropped for good the next time the list is written back).
    const profile = validateConnectionProfile(value as ConnectionProfile, { allowCredentialsInUrl: true });
    const url = new URL(profile.serverUrl);
    url.username = '';
    url.password = '';
    return { ...profile, serverUrl: url.toString().replace(/\/+$/, '') };
  } catch {
    return undefined;
  }
}

function validateConnectionProfile(
  profile: ConnectionProfile,
  options: { allowCredentialsInUrl?: boolean } = {}
): ConnectionProfile {
  const idValidation = validateProfileId(profile.id);
  if (!idValidation.ok || !idValidation.value) {
    throw new FMClientError(idValidation.error ?? 'Profile ID is invalid.');
  }

  const serverUrlValidation = validateServerUrl(profile.serverUrl, 'Server URL', {
    allowCredentials: options.allowCredentialsInUrl
  });
  if (!serverUrlValidation.ok || !serverUrlValidation.value) {
    throw new FMClientError(serverUrlValidation.error ?? 'Server URL is invalid.');
  }

  const databaseValidation = validateDatabaseName(profile.database);
  if (!databaseValidation.ok || !databaseValidation.value) {
    throw new FMClientError(databaseValidation.error ?? 'Database name is invalid.');
  }

  if (profile.authMode !== 'direct' && profile.authMode !== 'proxy') {
    throw new FMClientError('Auth mode must be "direct" or "proxy".');
  }

  return {
    ...profile,
    id: idValidation.value,
    name: profile.name.trim(),
    serverUrl: serverUrlValidation.value,
    database: databaseValidation.value,
    username: profile.username?.trim() || undefined,
    apiBasePath: profile.apiBasePath?.trim() || undefined,
    apiVersionPath: profile.apiVersionPath?.trim() || undefined,
    proxyEndpoint: profile.proxyEndpoint?.trim() || undefined,
    allowSelfSigned: profile.allowSelfSigned === true ? true : undefined,
    caBundlePath: profile.caBundlePath?.trim() || undefined,
    // Hydration is lenient: an unusable value is dropped, never an error.
    pinnedCertSha256: normalizeSha256(profile.pinnedCertSha256),
    pinnedCertAllowExpired:
      normalizeSha256(profile.pinnedCertSha256) !== undefined && profile.pinnedCertAllowExpired === true
        ? true
        : undefined,
    // Anything but a known value is "none"; the stored default is no key at all.
    aiAccess: profile.aiAccess === 'read' || profile.aiAccess === 'write' ? profile.aiAccess : undefined
  };
}
