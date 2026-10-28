import * as crypto from 'crypto';
import type * as vscode from 'vscode';

import type { Logger } from './logger';

const PASSWORD_PREFIX = 'filemakerDataApiTools.profile.password';
const TOKEN_PREFIX = 'filemakerDataApiTools.profile.sessionToken';
const PROXY_KEY_PREFIX = 'filemakerDataApiTools.profile.proxyApiKey';
const FALLBACK_KEY = 'filemakerDataApiTools.fallbackSecrets.v1';

function profileKey(prefix: string, profileId: string): string {
  return `${prefix}.${profileId}`;
}

export type SecretFallbackMode = 'vscode-only' | 'workspace-state' | 'disabled';

interface FallbackEnvelope {
  v: 1;
  saltHex: string;
  ivHex: string;
  ciphertextHex: string;
  tagHex: string;
}

type FallbackMap = Record<string, FallbackEnvelope>;

type SecretLogger = Pick<Logger, 'warn' | 'info' | 'error'>;

export interface SecretStoreOptions {
  /**
   * Fallback strategy when vscode.SecretStorage throws or is unavailable.
   * - 'vscode-only' (default): rethrow; no fallback (preserves prior behavior)
   * - 'workspace-state': obfuscate and persist to Memento; for headless CI / remote agents.
   *   The key comes from the machine id, which anyone who can read the Memento on this machine
   *   can also read, so this hides secrets from casual viewing only. It is not protection
   *   against local access.
   * - 'disabled': do not persist any secrets; reads return undefined; writes are no-ops
   */
  fallbackMode?: SecretFallbackMode;
  /** Memento used as the workspace-state fallback. Required when fallbackMode === 'workspace-state'. */
  workspaceState?: vscode.Memento;
  /**
   * Stable identifier mixed into the obfuscation key. Defaults to empty string.
   * Pass vscode.env.machineId at the call site so a copied Memento does not open on a different
   * machine. The machine id is not secret, so this does not protect against local access.
   */
  machineId?: string;
  /** Logger for fallback warnings. */
  logger?: SecretLogger;
  /** Called once per instance when the fallback is first engaged. Inject the toast at the call site. */
  onFallbackEngaged?: (mode: SecretFallbackMode, reason: string) => void;
}

export class SecretStore {
  private readonly fallbackMode: SecretFallbackMode;
  private readonly workspaceState?: vscode.Memento;
  private readonly machineId: string;
  private readonly logger?: SecretLogger;
  private readonly onFallbackEngaged: NonNullable<SecretStoreOptions['onFallbackEngaged']>;
  private fallbackNotified = false;

  public constructor(
    private readonly secrets: vscode.SecretStorage,
    options: SecretStoreOptions = {}
  ) {
    this.fallbackMode = options.fallbackMode ?? 'vscode-only';
    this.workspaceState = options.workspaceState;
    this.machineId = options.machineId ?? '';
    this.logger = options.logger;
    this.onFallbackEngaged = options.onFallbackEngaged ?? (() => {});

    if (this.fallbackMode === 'workspace-state' && !this.workspaceState) {
      throw new Error(
        "SecretStore: fallbackMode='workspace-state' requires options.workspaceState"
      );
    }
  }

  public async setPassword(profileId: string, password: string): Promise<void> {
    await this.set(profileKey(PASSWORD_PREFIX, profileId), password);
  }

  public async getPassword(profileId: string): Promise<string | undefined> {
    return this.get(profileKey(PASSWORD_PREFIX, profileId));
  }

  public async deletePassword(profileId: string): Promise<void> {
    await this.delete(profileKey(PASSWORD_PREFIX, profileId));
  }

  public async setSessionToken(profileId: string, token: string): Promise<void> {
    await this.set(profileKey(TOKEN_PREFIX, profileId), token);
  }

  public async getSessionToken(profileId: string): Promise<string | undefined> {
    return this.get(profileKey(TOKEN_PREFIX, profileId));
  }

  public async deleteSessionToken(profileId: string): Promise<void> {
    await this.delete(profileKey(TOKEN_PREFIX, profileId));
  }

  public async setProxyApiKey(profileId: string, apiKey: string): Promise<void> {
    await this.set(profileKey(PROXY_KEY_PREFIX, profileId), apiKey);
  }

  public async getProxyApiKey(profileId: string): Promise<string | undefined> {
    return this.get(profileKey(PROXY_KEY_PREFIX, profileId));
  }

  public async deleteProxyApiKey(profileId: string): Promise<void> {
    await this.delete(profileKey(PROXY_KEY_PREFIX, profileId));
  }

  public async clearProfileSecrets(profileId: string): Promise<void> {
    await Promise.all([
      this.deletePassword(profileId),
      this.deleteSessionToken(profileId),
      this.deleteProxyApiKey(profileId)
    ]);
  }

  // --- internals ---

  private async set(key: string, value: string): Promise<void> {
    if (this.fallbackMode === 'disabled') {
      this.logger?.warn(
        `[secretStore] fallback=disabled; skipping persist for ${maskKey(key)}`
      );
      return;
    }
    try {
      await this.secrets.store(key, value);
      // Successful primary write supersedes any prior fallback for this key.
      if (this.workspaceState) {
        await this.clearFallbackEntry(key).catch(() => {});
      }
    } catch (err) {
      if (this.fallbackMode === 'workspace-state') {
        this.notifyFallback('SecretStorage.store failed', err);
        await this.fallbackSet(key, value);
        return;
      }
      throw err;
    }
  }

  private async get(key: string): Promise<string | undefined> {
    if (this.fallbackMode === 'disabled') {
      return undefined;
    }
    try {
      const value = await this.secrets.get(key);
      if (value !== undefined) {
        return value;
      }
      if (this.fallbackMode === 'workspace-state') {
        return this.fallbackGet(key);
      }
      return undefined;
    } catch (err) {
      if (this.fallbackMode === 'workspace-state') {
        this.notifyFallback('SecretStorage.get failed', err);
        return this.fallbackGet(key);
      }
      throw err;
    }
  }

  private async delete(key: string): Promise<void> {
    if (this.fallbackMode === 'disabled') {
      return;
    }
    try {
      await this.secrets.delete(key);
    } catch (err) {
      if (this.fallbackMode !== 'workspace-state') {
        throw err;
      }
      this.notifyFallback('SecretStorage.delete failed', err);
    } finally {
      if (this.fallbackMode === 'workspace-state') {
        await this.clearFallbackEntry(key).catch(() => {});
      }
    }
  }

  private notifyFallback(reason: string, err: unknown): void {
    this.logger?.warn(
      `[secretStore] using ${this.fallbackMode} fallback (${reason}): ${describeError(err)}`
    );
    if (!this.fallbackNotified) {
      this.fallbackNotified = true;
      this.onFallbackEngaged(this.fallbackMode, reason);
    }
  }

  private async fallbackSet(key: string, value: string): Promise<void> {
    if (!this.workspaceState) return;
    const envelope = this.encrypt(value);
    const map: FallbackMap = { ...this.readFallbackMap(), [key]: envelope };
    await this.workspaceState.update(FALLBACK_KEY, map);
  }

  private fallbackGet(key: string): string | undefined {
    if (!this.workspaceState) return undefined;
    const entry = this.readFallbackMap()[key];
    if (!entry) return undefined;
    try {
      return this.decrypt(entry);
    } catch (err) {
      this.logger?.error(
        `[secretStore] fallback decrypt failed for ${maskKey(key)}: ${describeError(err)}`
      );
      return undefined;
    }
  }

  private async clearFallbackEntry(key: string): Promise<void> {
    if (!this.workspaceState) return;
    const map = this.readFallbackMap();
    if (!(key in map)) return;
    const next: FallbackMap = { ...map };
    delete next[key];
    await this.workspaceState.update(FALLBACK_KEY, next);
  }

  private readFallbackMap(): FallbackMap {
    return this.workspaceState?.get<FallbackMap>(FALLBACK_KEY) ?? {};
  }

  // AES-GCM under a key derived from the machine id (not a secret). This is obfuscation: it
  // keeps secrets out of plain sight in the Memento but does not stop a local reader (ADR-0002).
  private encrypt(plaintext: string): FallbackEnvelope {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = this.deriveKey(salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      v: 1,
      saltHex: salt.toString('hex'),
      ivHex: iv.toString('hex'),
      ciphertextHex: ct.toString('hex'),
      tagHex: tag.toString('hex')
    };
  }

  private decrypt(envelope: FallbackEnvelope): string {
    const salt = Buffer.from(envelope.saltHex, 'hex');
    const iv = Buffer.from(envelope.ivHex, 'hex');
    const ct = Buffer.from(envelope.ciphertextHex, 'hex');
    const tag = Buffer.from(envelope.tagHex, 'hex');
    const key = this.deriveKey(salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  private deriveKey(salt: Buffer): Buffer {
    const material = `${this.machineId}|filemakerDataApiTools`;
    return crypto.pbkdf2Sync(material, salt, 100_000, 32, 'sha256');
  }
}

function maskKey(key: string): string {
  const idx = key.lastIndexOf('.');
  return idx > 0 ? `${key.slice(0, idx)}.***` : '***';
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
