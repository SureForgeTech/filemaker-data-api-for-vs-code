import { describe, expect, it } from 'vitest';

import {
  isFeatureEnabled,
  isOfflineModeOn,
  readMaxRetries,
  readPerformanceMode,
  readRestrictedSetting
} from '../../src/utils/policySetting';

function config(inspected: Record<string, unknown>) {
  return {
    get: <T>(_key: string, fallback?: T) => fallback as T,
    inspect: () => inspected
  } as never;
}

describe('restrict-only settings', () => {
  it('takes performance mode only from the user application setting', () => {
    expect(readPerformanceMode(config({ globalValue: 'high-scale', workspaceValue: 'standard' }))).toBe('high-scale');
    for (const values of [{ workspaceValue: 'high-scale' }, { workspaceFolderValue: 'high-scale' },
      { globalRemoteValue: 'high-scale' }, { globalLocalValue: 'high-scale' }, { globalValue: 'invalid' }]) {
      expect(readPerformanceMode(config(values))).toBe('standard');
    }
    expect(readPerformanceMode({ get: () => 'high-scale' } as never)).toBe('standard');
  });

  it.each([
    [{ globalValue: 1, workspaceValue: 10 }, 1],
    [{ globalValue: 8, workspaceValue: 2 }, 2],
    [{ workspaceValue: 10 }, 3],
    [{ globalValue: 8, workspaceValue: 2, workspaceFolderValue: 7 }, 2],
    [{ globalValue: 8, workspaceFolderValue: 0 }, 0],
    [{ globalValue: NaN, workspaceValue: Infinity }, 3],
    [{ globalValue: 30, workspaceValue: -2 }, 0]
  ])('only lets workspace values lower the retry limit (%j)', (values, expected) => {
    expect(readMaxRetries(config(values))).toBe(expected);
  });

  it('does not trust merged retry values without scope information', () => {
    expect(readMaxRetries({ get: () => 10 } as never)).toBe(3);
  });

  it('lets a repository switch offline mode on but never off', () => {
    expect(isOfflineModeOn(config({ defaultValue: false, workspaceValue: true }))).toBe(true);
    expect(
      isOfflineModeOn(config({ defaultValue: false, globalValue: true, workspaceValue: false }))
    ).toBe(true);
    expect(
      isOfflineModeOn(
        config({ defaultValue: false, globalValue: true, workspaceFolderValue: false })
      )
    ).toBe(true);
    expect(isOfflineModeOn(config({ defaultValue: false, workspaceValue: false }))).toBe(false);
  });

  it('lets a repository switch a feature off but never on', () => {
    const key = 'features.scriptRunner.enabled';
    expect(isFeatureEnabled(config({ defaultValue: true, workspaceValue: false }), key)).toBe(
      false
    );
    expect(
      isFeatureEnabled(
        config({ defaultValue: true, globalValue: false, workspaceValue: true }),
        key
      )
    ).toBe(false);
    expect(isFeatureEnabled(config({ defaultValue: true }), key)).toBe(true);
  });

  it('honours a remote or local user value as the baseline', () => {
    expect(
      isOfflineModeOn(
        config({ defaultValue: false, globalRemoteValue: true, workspaceValue: false })
      )
    ).toBe(true);
    expect(
      isOfflineModeOn(
        config({ defaultValue: false, globalLocalValue: true, workspaceValue: false })
      )
    ).toBe(true);
  });

  it('falls back to get() when inspect is unavailable', () => {
    const plain = {
      get: <T>(_key: string, fallback?: T) => (fallback === undefined ? undefined : true) as T
    } as never;
    expect(readRestrictedSetting(plain, 'offline.mode', false, true)).toBe(true);
  });
});
