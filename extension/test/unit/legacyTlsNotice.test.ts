import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { notifyAboutLegacyTlsProfiles, profilesSkippingCertificateChecks } from '../../src/services/legacyTlsNotice';
import type { ConnectionProfile } from '../../src/types/fm';
import { InMemoryMemento } from './mocks';
import { ProfileStore } from '../../src/services/profileStore';

const review = vi.hoisted(() => ({ decision: undefined as unknown }));
vi.mock('../../src/services/certificateTrust', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, reviewAndTrustCertificate: vi.fn(async () => review.decision) };
});

const profile = (id: string, extra: Partial<ConnectionProfile> = {}): ConnectionProfile => ({
  id, name: `Profile ${id}`, authMode: 'direct', serverUrl: 'https://fm.example.com', database: 'D', username: 'u', ...extra
});

describe('one-time notice about profiles that skip all certificate checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    review.decision = undefined;
  });

  it('only profiles with the older flag and no pin are affected', () => {
    const list = [profile('a', { allowSelfSigned: true }), profile('b'), profile('c', { allowSelfSigned: true, pinnedCertSha256: 'ab'.repeat(32) })];
    expect(profilesSkippingCertificateChecks(list).map((p) => p.id)).toEqual(['a']);
  });

  it('asks once per profile, and converts to a pinned certificate on request', async () => {
    const upsertProfile = vi.fn(async (...profiles: unknown[]) => profiles.length && undefined);
    const store = { listProfiles: async () => [profile('a', { allowSelfSigned: true }), profile('b')], upsertProfile };
    const state = new InMemoryMemento();
    const onChanged = vi.fn();
    review.decision = { sha256: 'cd'.repeat(32), allowExpired: false };
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Convert to pinned certificate' as never);

    await notifyAboutLegacyTlsProfiles(store as never, state as never, onChanged);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(vscode.window.showWarningMessage).mock.calls[0]?.[0])).toContain('Profile a');
    expect(upsertProfile).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', pinnedCertSha256: 'cd'.repeat(32) }));
    expect(upsertProfile.mock.calls[0]?.[0]).not.toHaveProperty('allowSelfSigned', true);
    expect(onChanged).toHaveBeenCalled();

    // A later start does not ask again.
    vi.mocked(vscode.window.showWarningMessage).mockClear();
    await notifyAboutLegacyTlsProfiles(store as never, state as never, onChanged);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('"Not now" changes nothing and is remembered', async () => {
    const upsertProfile = vi.fn();
    const store = { listProfiles: async () => [profile('a', { allowSelfSigned: true })], upsertProfile };
    const state = new InMemoryMemento();
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Not now' as never);

    await notifyAboutLegacyTlsProfiles(store as never, state as never, vi.fn());
    await notifyAboutLegacyTlsProfiles(store as never, state as never, vi.fn());

    expect(upsertProfile).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('converts legacy TLS without losing a legacy password when secret storage fails', async () => {
    const global = new InMemoryMemento();
    const raw = profile('legacy', { allowSelfSigned: true, serverUrl: 'https://user:fixture-password@fm.example.test' });
    await global.update('filemakerDataApiTools.profiles', [raw]);
    const store = new ProfileStore(global as never, new InMemoryMemento() as never, {
      getPassword: async () => undefined,
      setPassword: async () => { throw new Error('unavailable'); }
    });
    const onChanged = vi.fn();
    review.decision = { sha256: 'cd'.repeat(32), allowExpired: false };
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Convert to pinned certificate' as never);

    await notifyAboutLegacyTlsProfiles(store, global as never, onChanged);

    expect(global.get('filemakerDataApiTools.profiles')).toEqual([
      expect.objectContaining({ serverUrl: raw.serverUrl, allowSelfSigned: undefined, pinnedCertSha256: 'cd'.repeat(32) })
    ]);
    expect(onChanged).toHaveBeenCalledOnce();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('Re-enter or confirm'));
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(2);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });
});
