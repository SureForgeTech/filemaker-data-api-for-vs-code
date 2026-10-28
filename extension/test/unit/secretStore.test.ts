import { assert, beforeEach, describe, expect, it, vi } from 'vitest';

import { SecretStore, type SecretStoreOptions } from '../../src/services/secretStore';
import { InMemoryMemento, InMemorySecretStorage } from './mocks';

class FailingSecretStorage {
  public storeFailures = 0;
  public getFailures = 0;
  public deleteFailures = 0;

  public async storeSecret(): Promise<void> {
    this.storeFailures += 1;
    throw new Error('SecretStorage unavailable: store');
  }

  public async store(): Promise<void> {
    this.storeFailures += 1;
    throw new Error('SecretStorage unavailable: store');
  }

  public async get(): Promise<string | undefined> {
    this.getFailures += 1;
    throw new Error('SecretStorage unavailable: get');
  }

  public async delete(): Promise<void> {
    this.deleteFailures += 1;
    throw new Error('SecretStorage unavailable: delete');
  }
}

function createSilentLogger() {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn()
  };
}

describe('SecretStore', () => {
  describe('vscode-only mode (default)', () => {
    it('stores and retrieves profile secrets when SecretStorage works', async () => {
      const storage = new InMemorySecretStorage();
      const store = new SecretStore(storage as never);

      await store.setPassword('profile-1', 'pass-1');
      await store.setSessionToken('profile-1', 'token-1');
      await store.setProxyApiKey('profile-1', 'proxy-1');

      await expect(store.getPassword('profile-1')).resolves.toBe('pass-1');
      await expect(store.getSessionToken('profile-1')).resolves.toBe('token-1');
      await expect(store.getProxyApiKey('profile-1')).resolves.toBe('proxy-1');

      await store.clearProfileSecrets('profile-1');

      await expect(store.getPassword('profile-1')).resolves.toBeUndefined();
      await expect(store.getSessionToken('profile-1')).resolves.toBeUndefined();
      await expect(store.getProxyApiKey('profile-1')).resolves.toBeUndefined();
    });

    it('propagates errors when SecretStorage throws and no fallback configured', async () => {
      const failing = new FailingSecretStorage();
      const store = new SecretStore(failing as never);

      await expect(store.setPassword('p', 'x')).rejects.toThrow(/SecretStorage unavailable/);
      await expect(store.getPassword('p')).rejects.toThrow(/SecretStorage unavailable/);
      await expect(store.deletePassword('p')).rejects.toThrow(/SecretStorage unavailable/);
    });
  });

  describe('workspace-state fallback mode', () => {
    let memento: InMemoryMemento;
    let logger: ReturnType<typeof createSilentLogger>;
    let onFallbackEngaged: ReturnType<typeof vi.fn<NonNullable<SecretStoreOptions['onFallbackEngaged']>>>;

    beforeEach(() => {
      memento = new InMemoryMemento();
      logger = createSilentLogger();
      onFallbackEngaged = vi.fn();
    });

    it('throws at construction when workspaceState is missing', () => {
      const storage = new InMemorySecretStorage();
      expect(() => new SecretStore(storage as never, { fallbackMode: 'workspace-state' })).toThrow(
        /requires options.workspaceState/
      );
    });

    it('uses the obfuscated Memento fallback when SecretStorage.store fails', async () => {
      const failing = new FailingSecretStorage();
      const store = new SecretStore(failing as never, {
        fallbackMode: 'workspace-state',
        workspaceState: memento as never,
        machineId: 'machine-A',
        logger,
        onFallbackEngaged
      });

      await store.setPassword('p1', 'super-secret');
      await expect(store.getPassword('p1')).resolves.toBe('super-secret');

      // Persisted as an obfuscated envelope, not plaintext
      const map = memento.get<Record<string, unknown>>('filemakerDataApiTools.fallbackSecrets.v1') ?? {};
      const keys = Object.keys(map);
      expect(keys).toHaveLength(1);
      const [key] = keys;
      assert.isDefined(key);
      const envelope = map[key] as Record<string, string>;
      expect(envelope.ciphertextHex).toBeDefined();
      expect(envelope.ciphertextHex).not.toContain('super-secret');
      expect(envelope.tagHex).toBeDefined();
      expect(envelope.ivHex).toBeDefined();

      // Engaged callback fires once per instance
      expect(onFallbackEngaged).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalled();

      // A second failed call does not re-fire the callback
      await store.setSessionToken('p1', 'tok-1');
      expect(onFallbackEngaged).toHaveBeenCalledTimes(1);
    });

    it('reads from fallback when SecretStorage.get throws', async () => {
      const failing = new FailingSecretStorage();
      const store = new SecretStore(failing as never, {
        fallbackMode: 'workspace-state',
        workspaceState: memento as never,
        machineId: 'machine-A',
        logger,
        onFallbackEngaged
      });

      await store.setPassword('p2', 'hello');
      await expect(store.getPassword('p2')).resolves.toBe('hello');
      await store.deletePassword('p2');
      await expect(store.getPassword('p2')).resolves.toBeUndefined();
    });

    it('returns undefined and logs error when ciphertext was written by a different machineId', async () => {
      // Write with machine-A
      const failing = new FailingSecretStorage();
      const writer = new SecretStore(failing as never, {
        fallbackMode: 'workspace-state',
        workspaceState: memento as never,
        machineId: 'machine-A',
        logger,
        onFallbackEngaged
      });
      await writer.setPassword('p3', 'private');

      // Read with machine-B (different machine, same workspaceState)
      const reader = new SecretStore(failing as never, {
        fallbackMode: 'workspace-state',
        workspaceState: memento as never,
        machineId: 'machine-B',
        logger,
        onFallbackEngaged
      });
      await expect(reader.getPassword('p3')).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalled();
    });

    it('returns undefined and logs error when the auth tag is truncated', async () => {
      const failing = new FailingSecretStorage();
      const store = new SecretStore(failing as never, {
        fallbackMode: 'workspace-state',
        workspaceState: memento as never,
        machineId: 'machine-A',
        logger,
        onFallbackEngaged
      });
      await store.setPassword('p6', 'tamper-me');

      // Cut one byte off the stored 16-byte GCM auth tag
      const mapKey = 'filemakerDataApiTools.fallbackSecrets.v1';
      const map = memento.get<Record<string, Record<string, string>>>(mapKey) ?? {};
      const [entryKey] = Object.keys(map);
      assert.isDefined(entryKey);
      const envelope = map[entryKey as string];
      assert.isDefined(envelope);
      const originalTagHex = envelope.tagHex;
      if (originalTagHex === undefined) {
        throw new Error('expected the stored envelope to carry an auth tag');
      }
      expect(originalTagHex).toHaveLength(32); // 16 bytes
      envelope.tagHex = originalTagHex.slice(0, -2); // 15 bytes
      await memento.update(mapKey, map);

      await expect(store.getPassword('p6')).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalled();
    });

    it('round-trips secrets written before the auth tag length was pinned', async () => {
      const failing = new FailingSecretStorage();
      const store = new SecretStore(failing as never, {
        fallbackMode: 'workspace-state',
        workspaceState: memento as never,
        machineId: 'machine-A',
        logger,
        onFallbackEngaged
      });

      await store.setPassword('p7', 'still-works');

      // Stored envelope keeps the original shape: v=1, 12-byte IV, 16-byte tag
      const map = memento.get<Record<string, Record<string, string>>>(
        'filemakerDataApiTools.fallbackSecrets.v1'
      ) ?? {};
      const [entryKey] = Object.keys(map);
      assert.isDefined(entryKey);
      const envelope = map[entryKey as string];
      assert.isDefined(envelope);
      const { ivHex, tagHex } = envelope;
      if (ivHex === undefined || tagHex === undefined) {
        throw new Error('expected the stored envelope to carry an iv and auth tag');
      }
      expect(Buffer.from(ivHex, 'hex')).toHaveLength(12);
      expect(Buffer.from(tagHex, 'hex')).toHaveLength(16);

      await expect(store.getPassword('p7')).resolves.toBe('still-works');
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('successful primary write supersedes prior fallback entry', async () => {
      const flaky = new InMemorySecretStorage();
      const failing = new FailingSecretStorage();
      // First write fails: store falls back
      const store1 = new SecretStore(failing as never, {
        fallbackMode: 'workspace-state',
        workspaceState: memento as never,
        machineId: 'machine-A',
        logger,
        onFallbackEngaged
      });
      await store1.setPassword('p4', 'old-via-fallback');

      // Second write succeeds via working SecretStorage; fallback entry should clear
      const store2 = new SecretStore(flaky as never, {
        fallbackMode: 'workspace-state',
        workspaceState: memento as never,
        machineId: 'machine-A',
        logger,
        onFallbackEngaged
      });
      await store2.setPassword('p4', 'new-via-primary');

      const map =
        memento.get<Record<string, unknown>>('filemakerDataApiTools.fallbackSecrets.v1') ?? {};
      expect(Object.keys(map)).toHaveLength(0);
    });
  });

  describe('disabled mode', () => {
    it('skips persistence and returns undefined for reads', async () => {
      const storage = new InMemorySecretStorage();
      const logger = createSilentLogger();
      const store = new SecretStore(storage as never, {
        fallbackMode: 'disabled',
        logger
      });

      await store.setPassword('p5', 'should-not-store');
      await expect(store.getPassword('p5')).resolves.toBeUndefined();

      // Underlying storage was never touched
      const internal = await storage.get('filemakerDataApiTools.profile.password.p5');
      expect(internal).toBeUndefined();

      // Disabled deletes are no-ops, do not throw
      await expect(store.deletePassword('p5')).resolves.toBeUndefined();

      // Set was logged as skipped
      expect(logger.warn).toHaveBeenCalled();
    });
  });
});
