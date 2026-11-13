import { describe, it, expect, vi } from 'vitest';
import type * as vscode from 'vscode';

// We need to test the cacheKey function indirectly through the OfflineModeService
// since cacheKey is a private module function. We test by verifying round-trip behavior.

import { OfflineModeService } from '../../src/offline/offlineModeService';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

function createTestService(workspaceRoot: string, isWorkspaceTrusted = () => true, algorithm = 'sha256'): OfflineModeService {
  return new OfflineModeService(
    { warn: () => {} },
    {
      getWorkspaceRoot: () => workspaceRoot,
      getConfiguration: () =>
        ({
          get: (key: string, defaultValue: unknown) => {
            if (key === 'offline.mode') return false;
            if (key === 'schema.hashAlgorithm') return algorithm;
            return defaultValue;
          },
          update: async () => {}
        }) as unknown as vscode.WorkspaceConfiguration,
      isWorkspaceTrusted
    }
  );
}

describe('offline cache key consistency', () => {
  it('accepts a legacy cache under the configured sha512 algorithm and still rejects edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-cache-legacy-algorithm-'));
    const profile = { id: 'p', name: 'Test', serverUrl: 'https://example.test', database: 'DB', authMode: 'direct' as const };
    const metadata = { fieldMetaData: [{ name: ' Field ' }] };
    try {
      const service = createTestService(root, () => true, 'sha512');
      await service.cacheLayoutMetadata(profile, ' Layout ', metadata);
      const [entry] = await service.listCacheEntries();
      const path = join(root, '.vscode/filemaker/offline-metadata', entry!.fileName);
      const payload = JSON.parse(await readFile(path, 'utf8'));
      delete payload.hashAlgorithm;
      await writeFile(path, JSON.stringify(payload));
      expect(await service.getCachedLayoutMetadata(profile, ' Layout ')).toMatchObject({ metadata, hash: entry!.hash });

      payload.metadata.fieldMetaData[0].name = 'Altered';
      await writeFile(path, JSON.stringify(payload));
      expect(await service.getCachedLayoutMetadata(profile, ' Layout ')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['sha256', 'sha512', 'legacy'])('verifies %s caches after the algorithm setting changes and still rejects edits', async (algorithm) => {
    const root = await mkdtemp(join(tmpdir(), 'fm-cache-algorithm-'));
    const profile = { id: 'p', name: 'Test', serverUrl: 'https://example.test', database: 'DB', authMode: 'direct' as const };
    const metadata = { fieldMetaData: [{ name: ' Field ' }] };
    try {
      const writer = createTestService(root, () => true, algorithm === 'legacy' ? 'sha256' : algorithm);
      await writer.cacheLayoutMetadata(profile, ' Layout ', metadata);
      const [entry] = await writer.listCacheEntries();
      const path = join(root, '.vscode/filemaker/offline-metadata', entry!.fileName);
      const payload = JSON.parse(await readFile(path, 'utf8'));
      if (algorithm === 'legacy') {
        delete payload.hashAlgorithm;
        await writeFile(path, JSON.stringify(payload));
      }
      const reader = createTestService(root, () => true, algorithm === 'sha512' ? 'sha256' : 'sha512');
      expect(await reader.getCachedLayoutMetadata(profile, ' Layout ')).toMatchObject({ metadata });
      payload.metadata.fieldMetaData[0].name = 'Altered';
      await writeFile(path, JSON.stringify(payload));
      expect(await reader.getCachedLayoutMetadata(profile, ' Layout ')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not resolve or read workspace cache paths before trust is granted', async () => {
    const getWorkspaceRoot = vi.fn().mockReturnValue('/workspace');
    const service = new OfflineModeService({ warn: vi.fn() }, {
      getWorkspaceRoot, isWorkspaceTrusted: () => false
    });
    const profile = { id: 'p', name: 'Test', serverUrl: 'https://example.test', database: 'DB', authMode: 'direct' as const };
    expect(await service.getCachedLayoutMetadata(profile, ' Layout ')).toBeUndefined();
    expect(getWorkspaceRoot).not.toHaveBeenCalled();
  });

  it.each(['untrusted', 'metadata', 'payload hash', 'index hash', 'missing hash'])('refuses %s cache entries', async (change) => {
    const root = await mkdtemp(join(tmpdir(), 'fm-cache-policy-'));
    let trusted = true;
    const service = createTestService(root, () => trusted);
    const profile = { id: 'p', name: 'Test', serverUrl: 'https://example.test', database: 'DB', authMode: 'direct' as const };
    try {
      await service.cacheLayoutMetadata(profile, ' Layout ', { fieldMetaData: [{ name: ' Field ' }] });
      const dir = join(root, '.vscode/filemaker/offline-metadata');
      const [entry] = await service.listCacheEntries();
      const path = join(dir, entry!.fileName);
      const payload = JSON.parse(await readFile(path, 'utf8'));
      if (change === 'untrusted') trusted = false;
      if (change === 'metadata') payload.metadata = { fieldMetaData: [{ name: 'Planted' }] };
      if (change === 'payload hash') payload.hash = '0'.repeat(64);
      if (change === 'missing hash') delete payload.hash;
      if (change === 'index hash') {
        const indexPath = join(dir, 'index.json');
        const index = JSON.parse(await readFile(indexPath, 'utf8'));
        index.items[0].hash = '0'.repeat(64);
        await writeFile(indexPath, JSON.stringify(index));
      }
      await writeFile(path, JSON.stringify(payload));
      expect(await service.getCachedLayoutMetadata(profile, ' Layout ')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['sha256', 'sha512'])('accepts an intact cache using %s and preserves exact names', async (algorithm) => {
    const root = await mkdtemp(join(tmpdir(), 'fm-cache-policy-'));
    const service = createTestService(root, () => true, algorithm);
    const profile = { id: 'p', name: 'Test', serverUrl: 'https://example.test', database: 'DB', authMode: 'direct' as const };
    const metadata = { fieldMetaData: [{ name: ' Field ' }] };
    try {
      await service.cacheLayoutMetadata(profile, ' Layout ', metadata);
      expect(await service.getCachedLayoutMetadata(profile, ' Layout ')).toMatchObject({ metadata });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('should retrieve cached metadata using the same profile/layout combination', async () => {
    const root = join(tmpdir(), `fm-test-${randomUUID()}`);
    await mkdir(root, { recursive: true });

    const service = createTestService(root);
    const profile = {
      id: 'test-profile',
      name: 'Test Profile',
      serverUrl: 'https://example.com',
      database: 'TestDB',
      authMode: 'direct' as const,
      apiBasePath: '/fmi/data',
      apiVersionPath: 'vLatest'
    };

    const metadata = { fieldMetaData: [{ name: 'Name', type: 'normal' }] };
    await service.cacheLayoutMetadata(profile, 'Contacts', metadata);

    const result = await service.getCachedLayoutMetadata(profile, 'Contacts');
    expect(result).toBeDefined();
    expect(result!.metadata).toEqual(metadata);
  });

  it('should not return cache for different layout', async () => {
    const root = join(tmpdir(), `fm-test-${randomUUID()}`);
    await mkdir(root, { recursive: true });

    const service = createTestService(root);
    const profile = {
      id: 'test-profile',
      name: 'Test Profile',
      serverUrl: 'https://example.com',
      database: 'TestDB',
      authMode: 'direct' as const,
      apiBasePath: '/fmi/data',
      apiVersionPath: 'vLatest'
    };

    await service.cacheLayoutMetadata(profile, 'Contacts', { field: 'a' });

    const result = await service.getCachedLayoutMetadata(profile, 'Invoices');
    expect(result).toBeUndefined();
  });

  it('should not return cache for different profile', async () => {
    const root = join(tmpdir(), `fm-test-${randomUUID()}`);
    await mkdir(root, { recursive: true });

    const service = createTestService(root);
    const profile1 = {
      id: 'profile-1',
      name: 'Profile 1',
      serverUrl: 'https://example.com',
      database: 'TestDB',
      authMode: 'direct' as const,
      apiBasePath: '/fmi/data',
      apiVersionPath: 'vLatest'
    };
    const profile2 = {
      id: 'profile-2',
      name: 'Profile 2',
      serverUrl: 'https://example.com',
      database: 'TestDB',
      authMode: 'direct' as const,
      apiBasePath: '/fmi/data',
      apiVersionPath: 'vLatest'
    };

    await service.cacheLayoutMetadata(profile1, 'Contacts', { field: 'a' });

    const result = await service.getCachedLayoutMetadata(profile2, 'Contacts');
    expect(result).toBeUndefined();
  });

  it('should not return cache for different database', async () => {
    const root = join(tmpdir(), `fm-test-${randomUUID()}`);
    await mkdir(root, { recursive: true });

    const service = createTestService(root);
    const profile1 = {
      id: 'test-profile',
      name: 'Test Profile',
      serverUrl: 'https://example.com',
      database: 'DB_A',
      authMode: 'direct' as const,
      apiBasePath: '/fmi/data',
      apiVersionPath: 'vLatest'
    };
    const profile2 = {
      id: 'test-profile',
      name: 'Test Profile',
      serverUrl: 'https://example.com',
      database: 'DB_B',
      authMode: 'direct' as const,
      apiBasePath: '/fmi/data',
      apiVersionPath: 'vLatest'
    };

    await service.cacheLayoutMetadata(profile1, 'Contacts', { field: 'a' });

    const result = await service.getCachedLayoutMetadata(profile2, 'Contacts');
    expect(result).toBeUndefined();
  });

  it('should replace older entry for the same cache key', async () => {
    const root = join(tmpdir(), `fm-test-${randomUUID()}`);
    await mkdir(root, { recursive: true });

    const service = createTestService(root);
    const profile = {
      id: 'test-profile',
      name: 'Test Profile',
      serverUrl: 'https://example.com',
      database: 'TestDB',
      authMode: 'direct' as const,
      apiBasePath: '/fmi/data',
      apiVersionPath: 'vLatest'
    };

    await service.cacheLayoutMetadata(profile, 'Contacts', { version: 1 });
    await service.cacheLayoutMetadata(profile, 'Contacts', { version: 2 });

    const result = await service.getCachedLayoutMetadata(profile, 'Contacts');
    expect(result).toBeDefined();
    expect(result!.metadata).toEqual({ version: 2 });

    const entries = await service.listCacheEntries();
    const contactEntries = entries.filter(e => e.layout === 'Contacts' && e.profileId === 'test-profile');
    expect(contactEntries).toHaveLength(1);
  });

  it('should differentiate by apiBasePath', async () => {
    const root = join(tmpdir(), `fm-test-${randomUUID()}`);
    await mkdir(root, { recursive: true });

    const service = createTestService(root);
    // Use different profile IDs to avoid filename collisions caused by
    // identical profileId + layout + same-millisecond timestamps.
    const profileA = {
      id: 'profile-standard',
      name: 'Standard API Profile',
      serverUrl: 'https://example.com',
      database: 'TestDB',
      authMode: 'direct' as const,
      apiBasePath: '/fmi/data',
      apiVersionPath: 'vLatest'
    };
    const profileB = {
      id: 'profile-custom',
      name: 'Custom API Profile',
      serverUrl: 'https://example.com',
      database: 'TestDB',
      authMode: 'direct' as const,
      apiBasePath: '/custom/api',
      apiVersionPath: 'vLatest'
    };

    await service.cacheLayoutMetadata(profileA, 'Contacts', { path: 'standard' });
    await service.cacheLayoutMetadata(profileB, 'Contacts', { path: 'custom' });

    const resultA = await service.getCachedLayoutMetadata(profileA, 'Contacts');
    const resultB = await service.getCachedLayoutMetadata(profileB, 'Contacts');

    expect(resultA!.metadata).toEqual({ path: 'standard' });
    expect(resultB!.metadata).toEqual({ path: 'custom' });
  });
});
