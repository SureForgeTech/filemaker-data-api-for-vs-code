import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  return {
    workspace: {
      getConfiguration: () => ({
        get: () => undefined
      })
    },
    commands: {
      executeCommand: vi.fn(async () => undefined)
    },
    env: {
      openExternal: vi.fn(async () => true)
    },
    window: {
      showWarningMessage: vi.fn(async () => undefined)
    },
    Uri: {
      parse: (value: string) => ({ toString: () => value })
    }
  };
});

import { RoleGuard } from '../../src/enterprise/roleGuard';

function createConfiguration(values: Record<string, unknown>) {
  return {
    get<T>(key: string, fallback?: T): T {
      if (key in values) {
        return values[key] as T;
      }

      return fallback as T;
    },
    update: vi.fn(async () => undefined)
  };
}

describe('RoleGuard', () => {
  it('ignores the enterprise file until workspace trust is granted, then reloads it', async () => {
    let trusted = false;
    const readConfigFile = vi.fn().mockResolvedValue(JSON.stringify({
      enterpriseMode: true, role: 'viewer', enforcedPerformanceMode: 'high-scale',
      lockedProfiles: ['p1'], disabledFeatures: ['ai'], defaultEnvironmentSets: [{ name: 'Set', profiles: ['p1'] }]
    }));
    const guard = new RoleGuard({ debug: vi.fn(), warn: vi.fn() }, {
      getConfiguration: () => createConfiguration({ 'enterprise.role': 'admin' }) as never,
      isWorkspaceTrusted: () => trusted, getWorkspaceRoot: () => '/workspace', readConfigFile
    });
    await guard.applyContexts();
    expect(readConfigFile).not.toHaveBeenCalled();
    expect(guard.isEnterpriseModeEnabled()).toBe(false);
    expect(guard.getRole()).toBe('admin');
    expect(guard.resolvePerformanceMode()).toBe('standard');
    expect(guard.isProfileLocked('p1')).toBe(false);
    expect(guard.getFeatureGuard('ai').allowed).toBe(true);
    expect(guard.getDefaultEnvironmentSetSeeds()).toEqual([]);
    expect(guard.getEnterpriseFileSettings()).toEqual({ enterpriseMode: undefined, role: undefined });
    trusted = true;
    await guard.applyContexts();
    expect(readConfigFile).toHaveBeenCalledOnce();
    expect(guard.isEnterpriseModeEnabled()).toBe(true);
    expect(guard.getRole()).toBe('viewer');
    expect(guard.resolvePerformanceMode()).toBe('high-scale');
    expect(guard.isProfileLocked('p1')).toBe(true);
    expect(guard.getFeatureGuard('ai').allowed).toBe(false);
    expect(guard.getDefaultEnvironmentSetSeeds()).toEqual([{ name: 'Set', profiles: ['p1'] }]);
  });

  it('applies viewer restrictions when enterprise mode is enabled', async () => {
    const guard = new RoleGuard(
      {
        debug: vi.fn(),
        warn: vi.fn()
      },
      {
        getConfiguration: () =>
          createConfiguration({
            'enterprise.mode': true,
            'enterprise.role': 'viewer',
            'offline.mode': false
          }) as never,
        isWorkspaceTrusted: () => true,
        getWorkspaceRoot: () => '/workspace',
        readConfigFile: async () => undefined
      }
    );

    await guard.refresh();

    expect(guard.getRole()).toBe('viewer');
    expect(guard.getFeatureGuard('recordEdit').allowed).toBe(false);
    expect(guard.getFeatureGuard('batchUpdate').allowed).toBe(false);
    expect(guard.getFeatureGuard('environmentExport').allowed).toBe(false);
  });

  it('enforces config-file disabled features and forced performance mode', async () => {
    const guard = new RoleGuard(
      {
        debug: vi.fn(),
        warn: vi.fn()
      },
      {
        getConfiguration: () =>
          createConfiguration({
            'enterprise.mode': false,
            'enterprise.role': 'admin',
            'performance.mode': 'standard',
            'offline.mode': false
          }) as never,
        isWorkspaceTrusted: () => true,
        getWorkspaceRoot: () => '/workspace',
        readConfigFile: async () =>
          JSON.stringify({
            enterpriseMode: true,
            role: 'developer',
            disabledFeatures: ['environmentExport'],
            enforcedPerformanceMode: 'high-scale'
          })
      }
    );

    await guard.refresh();

    expect(guard.isEnterpriseModeEnabled()).toBe(true);
    expect(guard.getRole()).toBe('developer');
    expect(guard.resolvePerformanceMode()).toBe('high-scale');
    expect(guard.getFeatureGuard('environmentExport').allowed).toBe(false);
  });

  it('blocks write operations when offline mode is enabled', async () => {
    const guard = new RoleGuard(
      {
        debug: vi.fn(),
        warn: vi.fn()
      },
      {
        getConfiguration: () =>
          createConfiguration({
            'enterprise.mode': false,
            'offline.mode': true
          }) as never,
        isWorkspaceTrusted: () => true,
        getWorkspaceRoot: () => '/workspace',
        readConfigFile: async () => undefined
      }
    );

    await guard.refresh();

    expect(guard.getFeatureGuard('recordEdit').allowed).toBe(false);
    expect(guard.getFeatureGuard('writeOperations').allowed).toBe(false);
    expect(guard.getFeatureGuard('environmentExport').allowed).toBe(true);
  });

  describe('workspace content can only make policy stricter', () => {
    /** A configuration that reports where each value was set, as VS Code's inspect() does. */
    function scopedConfiguration(user: Record<string, unknown>, workspace: Record<string, unknown> = {}) {
      const defaults: Record<string, unknown> = {
        'enterprise.mode': false,
        'enterprise.role': 'developer',
        'offline.mode': false
      };
      return {
        get<T>(key: string, fallback?: T): T {
          return (workspace[key] ?? user[key] ?? defaults[key] ?? fallback) as T;
        },
        inspect: (key: string) => ({
          key,
          defaultValue: defaults[key],
          globalValue: user[key],
          workspaceValue: workspace[key]
        })
      };
    }

    async function guardFor(
      user: Record<string, unknown>,
      workspace: Record<string, unknown>,
      file?: Record<string, unknown>
    ): Promise<RoleGuard> {
      const guard = new RoleGuard(
        { debug: vi.fn(), warn: vi.fn() },
        {
          getConfiguration: () => scopedConfiguration(user, workspace) as never,
          isWorkspaceTrusted: () => true,
          getWorkspaceRoot: () => '/workspace',
          readConfigFile: async () => (file ? JSON.stringify(file) : undefined)
        }
      );
      await guard.refresh();
      return guard;
    }

    it('cannot switch enterprise mode off from workspace settings or the repo config file', async () => {
      const guard = await guardFor(
        { 'enterprise.mode': true, 'enterprise.role': 'developer' },
        { 'enterprise.mode': false },
        { enterpriseMode: false, role: 'admin' }
      );

      expect(guard.isEnterpriseModeEnabled()).toBe(true);
      expect(guard.getRole()).toBe('developer');
    });

    it('keeps blocking plugin loading for a developer when the repo tries to unlock it', async () => {
      const guard = await guardFor(
        { 'enterprise.mode': true, 'enterprise.role': 'developer' },
        { 'enterprise.mode': false, 'enterprise.role': 'admin' },
        { enterpriseMode: false, role: 'admin' }
      );

      expect(guard.getFeatureGuard('pluginInstall').allowed).toBe(false);
    });

    it('cannot raise the role above the user\'s own', async () => {
      expect((await guardFor({}, { 'enterprise.role': 'admin' }, { role: 'admin' })).getRole()).toBe('developer');
      expect((await guardFor({ 'enterprise.role': 'viewer' }, {}, { role: 'admin' })).getRole()).toBe('viewer');
    });

    it('lets a repo turn enterprise mode on and lower the role for itself', async () => {
      const guard = await guardFor({ 'enterprise.role': 'admin' }, { 'enterprise.mode': true }, { role: 'viewer' });

      expect(guard.isEnterpriseModeEnabled()).toBe(true);
      expect(guard.getRole()).toBe('viewer');
      expect(guard.getFeatureGuard('recordEdit').allowed).toBe(false);
    });

    it('leaves everything off when nobody asked for enterprise mode', async () => {
      const guard = await guardFor({}, {}, { enterpriseMode: false });
      expect(guard.isEnterpriseModeEnabled()).toBe(false);
      expect(guard.getFeatureGuard('pluginInstall').allowed).toBe(true);
    });
  });
});
