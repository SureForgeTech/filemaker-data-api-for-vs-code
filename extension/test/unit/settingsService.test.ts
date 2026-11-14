import { usableRelativeDir } from '../../src/utils/relativeDir';
import { describe, expect, it } from 'vitest';

import { SettingsService } from '../../src/services/settingsService';

type ConfigMap = Record<string, Record<string, unknown>>;

function createSettings(overrides?: ConfigMap, trusted = true): SettingsService {
  const data: ConfigMap = overrides ?? {};

  return new SettingsService({
    getConfiguration: (section?: string) =>
      ({
        get: <T>(key: string, defaultValue?: T): T => {
          const sectionData = section ? (data[section] ?? {}) : {};
          const value = sectionData[key] as T | undefined;
          return value ?? (defaultValue as T);
        },
        // Mirrors VS Code's WorkspaceConfiguration.inspect so SettingsService.getPreferred
        // can distinguish "explicitly set" from "default" in this mock. We treat any
        // present key as workspace-scoped because the test ConfigMap doesn't model scopes.
        inspect: <T>(key: string) => {
          const sectionData = section ? (data[section] ?? {}) : {};
          const value = sectionData[key] as T | undefined;
          return {
            key,
            defaultValue: undefined as T | undefined,
            globalValue: undefined as T | undefined,
            workspaceValue: value,
            workspaceFolderValue: undefined as T | undefined
          };
        }
      }) as never,
    isWorkspaceTrusted: () => trusted
  });
}

describe('SettingsService', () => {
  it('ignores workspace performance mode and caps workspace retries at the user value', () => {
    const settings = new SettingsService({
      getConfiguration: () => ({ get: () => 'high-scale', inspect: (key: string) => key === 'performance.mode'
        ? { workspaceValue: 'high-scale' } : { globalValue: 1, workspaceValue: 10 } }) as never,
      isWorkspaceTrusted: () => true
    });
    expect(settings.getPerformanceMode()).toBe('standard');
    expect(settings.getConnectBackoffPolicy().maxRetries).toBe(1);
  });

  it('uses defaults when values are missing', () => {
    const settings = createSettings();
    expect(settings.getLoggingLevel()).toBe('info');
    expect(settings.getRequestTimeoutMs()).toBe(15_000);
    expect(settings.getSavedQueriesScope()).toBe('workspace');
    expect(settings.getTypegenOutputDir()).toBe('filemaker-types');
    expect(settings.getContainerUploadMaxBytes()).toBe(100 * 1024 * 1024);
  });

  it('normalizes invalid values', () => {
    const settings = createSettings({
      filemaker: {
        'logging.level': 'verbose',
        'savedQueries.scope': 'bad',
        'batch.concurrency': 99,
        containerUploadMaxBytes: 0,
        'typegen.outputDir': '../outside'
      },
      filemakerDataApiTools: {
        requestTimeoutMs: 10
      }
    });

    expect(settings.getLoggingLevel()).toBe('info');
    expect(settings.getSavedQueriesScope()).toBe('workspace');
    expect(settings.getBatchConcurrency()).toBe(10);
    expect(settings.getRequestTimeoutMs()).toBe(1_000);
    expect(settings.getTypegenOutputDir()).toBe('filemaker-types');
    expect(settings.getContainerUploadMaxBytes()).toBe(1);
  });

  it('clamps container upload max bytes to a safe upper bound', () => {
    const settings = createSettings({
      filemaker: {
        containerUploadMaxBytes: Number.MAX_SAFE_INTEGER
      }
    });

    expect(settings.getContainerUploadMaxBytes()).toBe(2_147_483_647);
  });

  it('forces workspaceState storage in untrusted workspaces', () => {
    const settings = createSettings(
      {
        filemaker: {
          'schema.snapshots.storage': 'workspaceFiles'
        }
      },
      false
    );

    expect(settings.getSchemaSnapshotsStorage()).toBe('workspaceState');
  });

  it('falls back to the default API paths when a hand-edited value is not a non-empty string', () => {
    for (const section of ['filemaker', 'filemakerDataApiTools']) {
      for (const value of [2, null, '']) {
        const settings = createSettings({
          [section]: { defaultApiBasePath: value, defaultApiVersionPath: value }
        });
        const label = `${section} = ${JSON.stringify(value)}`;
        expect(settings.getDefaultApiBasePath(), label).toBe('/fmi/data');
        expect(settings.getDefaultApiVersionPath(), label).toBe('vLatest');
      }
    }
  });
});

describe('SettingsService.migrateDeprecatedSettings', () => {
  type Scoped = { globalValue?: unknown; workspaceValue?: unknown };
  type Store = Record<string, Record<string, Scoped>>;

  function createMigratableSettings(store: Store): {
    settings: SettingsService;
    updates: Array<[string, string, unknown, number]>;
  } {
    const updates: Array<[string, string, unknown, number]> = [];
    const settings = new SettingsService({
      getConfiguration: (section?: string) =>
        ({
          get: <T>(_key: string, defaultValue?: T): T => defaultValue as T,
          inspect: (key: string) => ({ key, ...(store[section ?? '']?.[key] ?? {}) }),
          update: async (key: string, value: unknown, target: number) => {
            updates.push([section ?? '', key, value, target]);
            const sectionStore = (store[section ?? ''] ??= {});
            const scoped = (sectionStore[key] ??= {});
            if (target === 1) {
              scoped.globalValue = value;
            } else {
              scoped.workspaceValue = value;
            }
          }
        }) as never,
      isWorkspaceTrusted: () => true
    });
    return { settings, updates };
  }

  it('moves legacy values to the new keys per scope and clears the legacy keys', async () => {
    const store: Store = {
      filemakerDataApiTools: {
        logLevel: { globalValue: 'debug' },
        requestTimeoutMs: { workspaceValue: 30000 }
      },
      filemaker: {}
    };
    const { settings, updates } = createMigratableSettings(store);

    const migrated = await settings.migrateDeprecatedSettings();

    expect(migrated.sort()).toEqual(['filemakerDataApiTools.logLevel', 'filemakerDataApiTools.requestTimeoutMs']);
    expect(store.filemaker?.['logging.level']?.globalValue).toBe('debug');
    expect(store.filemaker?.requestTimeoutMs?.workspaceValue).toBe(30000);
    expect(store.filemakerDataApiTools?.logLevel?.globalValue).toBeUndefined();
    expect(store.filemakerDataApiTools?.requestTimeoutMs?.workspaceValue).toBeUndefined();
    expect(updates).toHaveLength(4);
  });

  it('keeps an explicitly set new value and still clears the legacy one', async () => {
    const store: Store = {
      filemakerDataApiTools: { defaultApiBasePath: { globalValue: '/old' } },
      filemaker: { defaultApiBasePath: { globalValue: '/new' } }
    };
    const { settings } = createMigratableSettings(store);

    await settings.migrateDeprecatedSettings();

    expect(store.filemaker?.defaultApiBasePath?.globalValue).toBe('/new');
    expect(store.filemakerDataApiTools?.defaultApiBasePath?.globalValue).toBeUndefined();
  });

  it('copies a legacy user value even when one workspace sets the new key', async () => {
    const store: Store = {
      filemakerDataApiTools: { requestTimeoutMs: { globalValue: 60000 } },
      filemaker: { requestTimeoutMs: { workspaceValue: 30000 } }
    };
    const { settings } = createMigratableSettings(store);

    await settings.migrateDeprecatedSettings();

    // Other workspaces relied on the legacy user value; this one keeps its override.
    expect(store.filemaker?.requestTimeoutMs).toEqual({ globalValue: 60000, workspaceValue: 30000 });
    expect(store.filemakerDataApiTools?.requestTimeoutMs?.globalValue).toBeUndefined();
  });

  it('copies both legacy scopes when the new key is unset, keeping the workspace override', async () => {
    const store: Store = {
      filemakerDataApiTools: { defaultApiVersionPath: { globalValue: 'v1', workspaceValue: 'v2' } },
      filemaker: {}
    };
    const { settings } = createMigratableSettings(store);

    await settings.migrateDeprecatedSettings();

    expect(store.filemaker?.defaultApiVersionPath).toEqual({ globalValue: 'v1', workspaceValue: 'v2' });
    expect(store.filemakerDataApiTools?.defaultApiVersionPath).toEqual({
      globalValue: undefined,
      workspaceValue: undefined
    });
  });

  it('does nothing when no legacy keys are set', async () => {
    const { settings, updates } = createMigratableSettings({ filemakerDataApiTools: {}, filemaker: {} });
    expect(await settings.migrateDeprecatedSettings()).toEqual([]);
    expect(updates).toEqual([]);
  });
});

describe('SettingsService legacy resolution across workspaces', () => {
  type Scoped = Record<string, Record<string, unknown>>;
  interface Settings {
    user: Scoped;
    workspaces: Record<string, Scoped>;
  }

  /** A SettingsService for one workspace; every workspace shares the same user settings. */
  function serviceFor(settings: Settings, workspace: string): SettingsService {
    return new SettingsService({
      getConfiguration: (section?: string) => {
        const name = section ?? '';
        const user = (settings.user[name] ??= {});
        const local = ((settings.workspaces[workspace] ??= {})[name] ??= {});
        return {
          get: <T>(key: string, defaultValue?: T): T => (local[key] ?? user[key] ?? defaultValue) as T,
          inspect: (key: string) => ({ key, globalValue: user[key], workspaceValue: local[key] }),
          update: async (key: string, value: unknown, target: number) => {
            const scope = target === 1 ? user : local;
            if (value === undefined) {
              delete scope[key];
            } else {
              scope[key] = value;
            }
          }
        } as never;
      },
      isWorkspaceTrusted: () => true
    });
  }

  it('prefers the more specific scope, and the new key within a scope', () => {
    const settings: Settings = {
      user: { filemaker: { requestTimeoutMs: 20000 } },
      workspaces: { W: { filemakerDataApiTools: { requestTimeoutMs: 60000 } } }
    };
    expect(serviceFor(settings, 'W').getRequestTimeoutMs()).toBe(60000);

    settings.workspaces.W!.filemaker = { requestTimeoutMs: 30000 };
    expect(serviceFor(settings, 'W').getRequestTimeoutMs()).toBe(30000);
  });

  it('prefers a legacy folder value over a new workspace value', () => {
    const scoped: Record<string, Record<string, { workspaceFolderValue?: unknown; workspaceValue?: unknown }>> = {
      filemakerDataApiTools: { requestTimeoutMs: { workspaceFolderValue: 45000 } },
      filemaker: { requestTimeoutMs: { workspaceValue: 30000 } }
    };
    const service = new SettingsService({
      getConfiguration: (section?: string) =>
        ({
          get: <T>(_key: string, defaultValue?: T): T => defaultValue as T,
          inspect: (key: string) => ({ key, ...scoped[section ?? '']?.[key] })
        }) as never,
      isWorkspaceTrusted: () => true
    });

    expect(service.getRequestTimeoutMs()).toBe(45000);
    expect(service.consumeDeprecatedSettingsUsed()).toEqual(['filemakerDataApiTools.requestTimeoutMs']);
  });

  it('keeps every effective value in every workspace when migrating in one workspace, then the other', async () => {
    const values = { userOld: 1001, userNew: 1002, wOld: 1003, wNew: 1004, xOld: 1005, xNew: 1006 };
    const names = Object.keys(values) as Array<keyof typeof values>;

    for (let mask = 0; mask < 1 << names.length; mask += 1) {
      const set = (name: keyof typeof values): number | undefined =>
        mask & (1 << names.indexOf(name)) ? values[name] : undefined;
      const scoped = (oldValue: number | undefined, newValue: number | undefined): Scoped => ({
        filemakerDataApiTools: oldValue === undefined ? {} : { requestTimeoutMs: oldValue },
        filemaker: newValue === undefined ? {} : { requestTimeoutMs: newValue }
      });
      const settings: Settings = {
        user: scoped(set('userOld'), set('userNew')),
        workspaces: { W: scoped(set('wOld'), set('wNew')), X: scoped(set('xOld'), set('xNew')) }
      };
      const effective = (): [number, number] => [
        serviceFor(settings, 'W').getRequestTimeoutMs(),
        serviceFor(settings, 'X').getRequestTimeoutMs()
      ];

      const before = effective();
      await serviceFor(settings, 'W').migrateDeprecatedSettings();
      expect(effective(), `after W, mask ${mask}`).toEqual(before);
      await serviceFor(settings, 'X').migrateDeprecatedSettings();
      expect(effective(), `after X, mask ${mask}`).toEqual(before);

      const leftover = [settings.user, settings.workspaces.W, settings.workspaces.X].some(
        (scope) => scope?.filemakerDataApiTools?.requestTimeoutMs !== undefined
      );
      expect(leftover, `legacy value left behind, mask ${mask}`).toBe(false);
    }
  });
});

describe('configured output folder text', () => {
  it('keeps emoji presentation selectors but refuses invisible standalone selectors', () => {
    expect(usableRelativeDir('out/☀️')).toBe('out/☀️');
    for (const value of ['out/\uFE0F', 'out/a\uFE0Fb', 'out/\u3164', 'out/a\u200Bb']) {
      expect(usableRelativeDir(value), value).toBeUndefined();
    }
  });
});
