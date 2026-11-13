import { createHash } from 'crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as vscode from 'vscode';

const commandHandlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();

vi.mock('vscode', () => {
  return {
    commands: {
      registerCommand: vi.fn(
        (command: string, handler: (...args: unknown[]) => Promise<void> | void) => {
          commandHandlers.set(command, handler);
          return {
            dispose: () => commandHandlers.delete(command)
          };
        }
      ),
      executeCommand: vi.fn(async () => undefined)
    },
    window: {
      registerTreeDataProvider: vi.fn(() => ({ dispose: () => undefined })),
      showInformationMessage: vi.fn(async () => undefined),
      showWarningMessage: vi.fn(async () => undefined)
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
      isTrusted: true
    }
  };
});

import { PluginRegistry } from '../../src/plugins/pluginRegistry';
import type { FileMakerPlugin } from '../../src/plugins/pluginTypes';

describe('PluginRegistry', () => {
  beforeEach(() => {
    commandHandlers.clear();
  });

  it('A7 visibly escapes plugin filenames in the default consent without changing approval hashing', async () => {
    const name = 'safe\n\u202e\u034f.js';
    const update = vi.fn(async () => undefined);
    const registry = new PluginRegistry({} as never, {} as never,
      { getFeatureGuard: () => ({ allowed: true }) } as never,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, {
        getWorkspaceRoot: () => '/workspace', isWorkspaceTrusted: () => true,
        readDir: async () => [name], listFiles: async () => [join('/workspace/.vscode/filemaker-plugins', name)],
        readFileBytes: async () => Buffer.from('same bytes'),
        approvalState: { get: (_key: string, fallback?: unknown) => fallback, update } as never,
        importModule: async () => ({ default: { id: 'test', name: 'test', activate: async () => undefined } })
      });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Run plugins' as never);
    await registry.reload();
    const prompt = String(vi.mocked(vscode.window.showWarningMessage).mock.calls.at(-1)?.[0]);
    expect(prompt).toContain('safe\\n\\u202e\\u034f.js');
    expect(prompt).not.toContain(name);
    const expectedHash = createHash('sha256').update(name).update('\0').update('same bytes').update('\0').digest('hex');
    expect(update).toHaveBeenCalledWith('filemakerDataApiTools.approvedWorkspacePlugins', { '/workspace|.vscode/filemaker-plugins': expectedHash });
    registry.dispose();
  });

  it('loads internal plugins and registers plugin commands', async () => {
    const run = vi.fn(async () => undefined);
    const plugin: FileMakerPlugin = {
      id: 'demo',
      name: 'Demo Plugin',
      activate: vi.fn(),
      commands: [
        {
          id: 'hello',
          title: 'Hello',
          run
        }
      ]
    };

    const registry = new PluginRegistry(
      {
        listProfiles: vi.fn(async () => []),
        getProfile: vi.fn(async () => undefined)
      } as never,
      {
        listLayouts: vi.fn(async () => []),
        getLayoutMetadata: vi.fn(async () => ({}))
      } as never,
      {
        getFeatureGuard: vi.fn(() => ({ allowed: true })),
        assertFeature: vi.fn(async () => true)
      } as never,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      },
      {
        internalPlugins: [plugin],
        isWorkspaceTrusted: () => true,
        getWorkspaceRoot: () => '/workspace',
        readDir: async () => []
      }
    );

    await registry.reload();

    expect(registry.listActivePlugins()).toHaveLength(1);
    const command = commandHandlers.get('filemakerDataApiTools.plugin.demo.hello');
    expect(command).toBeTypeOf('function');

    await command?.();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('skips workspace plugin loading in untrusted workspaces', async () => {
    const importModule = vi.fn(async () => ({
      default: {
        id: 'workspace-plugin',
        name: 'Workspace Plugin',
        activate: async () => undefined
      }
    }));

    const registry = new PluginRegistry(
      {
        listProfiles: vi.fn(async () => []),
        getProfile: vi.fn(async () => undefined)
      } as never,
      {
        listLayouts: vi.fn(async () => []),
        getLayoutMetadata: vi.fn(async () => ({}))
      } as never,
      {
        getFeatureGuard: vi.fn(() => ({ allowed: true })),
        assertFeature: vi.fn(async () => true)
      } as never,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      },
      {
        internalPlugins: [],
        isWorkspaceTrusted: () => false,
        getWorkspaceRoot: () => '/workspace',
        readDir: async () => ['demo.js'],
        importModule
      }
    );

    await registry.reload();

    expect(importModule).not.toHaveBeenCalled();
    expect(registry.listActivePlugins()).toHaveLength(0);
  });

  it('enforces requiresAdmin command restrictions', async () => {
    const run = vi.fn(async () => undefined);
    const plugin: FileMakerPlugin = {
      id: 'admin-tools',
      name: 'Admin Tools',
      activate: vi.fn(),
      commands: [
        {
          id: 'danger',
          title: 'Dangerous Command',
          requiresAdmin: true,
          run
        }
      ]
    };

    const roleGuard = {
      getFeatureGuard: vi.fn(() => ({ allowed: true })),
      assertFeature: vi.fn(async () => false)
    };

    const registry = new PluginRegistry(
      {
        listProfiles: vi.fn(async () => []),
        getProfile: vi.fn(async () => undefined)
      } as never,
      {
        listLayouts: vi.fn(async () => []),
        getLayoutMetadata: vi.fn(async () => ({}))
      } as never,
      roleGuard as never,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      },
      {
        internalPlugins: [plugin],
        isWorkspaceTrusted: () => true,
        getWorkspaceRoot: () => '/workspace',
        readDir: async () => []
      }
    );

    await registry.reload();

    const command = commandHandlers.get('filemakerDataApiTools.plugin.admin-tools.danger');
    await command?.();

    expect(roleGuard.assertFeature).toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  describe('workspace plugin consent', () => {
    const dir = '/workspace/.vscode/filemaker-plugins';

    function makeRegistry(options: {
      files: () => Record<string, string>;
      askConsent: (request: { fileNames: string[]; workspaceRoot: string }) => Promise<boolean>;
      approvalState: {
        get: <T>(key: string, fallback?: T) => T;
        update: (key: string, value: unknown) => Promise<void>;
      };
      root?: string;
      importModule: ReturnType<typeof vi.fn>;
      listFiles?: () => Promise<string[]>;
      logger?: {
        info: ReturnType<typeof vi.fn>;
        warn: ReturnType<typeof vi.fn>;
        error: ReturnType<typeof vi.fn>;
      };
    }): PluginRegistry {
      return new PluginRegistry(
        { listProfiles: vi.fn(async () => []), getProfile: vi.fn(async () => undefined) } as never,
        { listLayouts: vi.fn(async () => []), getLayoutMetadata: vi.fn(async () => ({})) } as never,
        {
          getFeatureGuard: vi.fn(() => ({ allowed: true })),
          assertFeature: vi.fn(async () => true)
        } as never,
        (options.logger ?? { info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as never,
        {
          internalPlugins: [],
          isWorkspaceTrusted: () => true,
          getWorkspaceRoot: () => options.root ?? '/workspace',
          readDir: async () => Object.keys(options.files()).filter((name) => !name.includes('/')),
          listFiles:
            options.listFiles ??
            (async () => Object.keys(options.files()).map((name) => `${dir}/${name}`)),
          readFileBytes: async (path) =>
            Buffer.from(options.files()[path.replace(`${dir}/`, '')] ?? ''),
          importModule: options.importModule as never,
          approvalState: options.approvalState,
          askConsent: options.askConsent
        }
      );
    }

    function memento() {
      const values = new Map<string, unknown>();
      return {
        get: <T>(key: string, fallback?: T): T =>
          values.has(key) ? (values.get(key) as T) : (fallback as T),
        update: async (key: string, value: unknown) => {
          values.set(key, value);
        }
      };
    }

    const pluginModule = () =>
      vi.fn(async () => ({
        default: {
          id: 'workspace-plugin',
          name: 'Workspace Plugin',
          activate: async () => undefined
        }
      }));

    it('does not import a plugin the user declines', async () => {
      const importModule = pluginModule();
      const askConsent = vi.fn(async () => false);
      const registry = makeRegistry({
        files: () => ({ 'demo.js': 'v1' }),
        askConsent,
        approvalState: memento(),
        importModule
      });

      await registry.reload();

      expect(askConsent).toHaveBeenCalledWith({
        fileNames: ['demo.js'],
        workspaceRoot: '/workspace'
      });
      expect(importModule).not.toHaveBeenCalled();
      expect(registry.listActivePlugins()).toHaveLength(0);
    });

    it('imports approved plugins and does not ask again for the same folder content', async () => {
      const importModule = pluginModule();
      const askConsent = vi.fn<
        (request: { fileNames: string[]; workspaceRoot: string }) => Promise<boolean>
      >(async () => true);
      const registry = makeRegistry({
        files: () => ({ 'demo.js': 'v1', 'other.js': 'v1' }),
        askConsent,
        approvalState: memento(),
        importModule
      });

      await registry.reload();
      await registry.reload();

      expect(askConsent).toHaveBeenCalledTimes(1);
      expect(askConsent.mock.calls[0]?.[0].fileNames.sort()).toEqual(['demo.js', 'other.js']);
      expect(importModule).toHaveBeenCalledTimes(4);
    });

    it('asks again when an approved plugin file changes', async () => {
      const askConsent = vi.fn(async () => true);
      let version = 'v1';
      const registry = makeRegistry({
        files: () => ({ 'demo.js': version }),
        askConsent,
        approvalState: memento(),
        importModule: pluginModule()
      });

      await registry.reload();
      version = 'v2 with something else in it';
      await registry.reload();

      expect(askConsent).toHaveBeenCalledTimes(2);
    });

    it('asks again when a file the plugin loads from the same folder changes, appears or goes', async () => {
      const askConsent = vi.fn(async () => true);
      let files: Record<string, string> = {
        'demo.js': "import './lib/payload.js'",
        'lib/payload.js': 'safe()'
      };
      const registry = makeRegistry({
        files: () => files,
        askConsent,
        approvalState: memento(),
        importModule: pluginModule()
      });

      await registry.reload();
      files = { ...files, 'lib/payload.js': 'steal()' };
      await registry.reload();
      files = { ...files, 'lib/extra.js': 'more()' };
      await registry.reload();
      files = Object.fromEntries(Object.entries(files).filter(([name]) => name !== 'lib/extra.js'));
      await registry.reload();

      expect(askConsent).toHaveBeenCalledTimes(4);
    });

    it('asks again in a different workspace', async () => {
      const state = memento();
      const first = makeRegistry({
        files: () => ({ 'demo.js': 'v1' }),
        askConsent: async () => true,
        approvalState: state,
        importModule: pluginModule()
      });
      await first.reload();

      const askOther = vi.fn(async () => false);
      const importOther = pluginModule();
      const other = makeRegistry({
        files: () => ({ 'demo.js': 'v1' }),
        askConsent: askOther,
        approvalState: state,
        root: '/another/repo',
        importModule: importOther
      });
      await other.reload();

      expect(askOther).toHaveBeenCalledWith({
        fileNames: ['demo.js'],
        workspaceRoot: '/another/repo'
      });
      expect(importOther).not.toHaveBeenCalled();
    });

    it('does not ask when the folder has no plugin files', async () => {
      const askConsent = vi.fn(async () => true);
      const registry = makeRegistry({
        files: () => ({ 'notes.txt': 'hello' }),
        askConsent,
        approvalState: memento(),
        importModule: pluginModule()
      });

      await registry.reload();

      expect(askConsent).not.toHaveBeenCalled();
    });

    it('refuses a plugin folder that cannot be listed safely, such as one with a symbolic link', async () => {
      const askConsent = vi.fn(async () => true);
      const importModule = pluginModule();
      const registry = makeRegistry({
        files: () => ({ 'demo.js': 'v1' }),
        askConsent,
        approvalState: memento(),
        importModule,
        listFiles: async () => {
          throw new Error('Symbolic link in plugin folder');
        }
      });

      await registry.reload();

      expect(askConsent).not.toHaveBeenCalled();
      expect(importModule).not.toHaveBeenCalled();
      expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    });

    it('does not load a plugin folder holding a real symbolic link', async () => {
      const root = mkdtempSync(join(tmpdir(), 'fm-plugins-'));
      try {
        const pluginDir = join(root, '.vscode', 'filemaker-plugins');
        mkdirSync(pluginDir, { recursive: true });
        writeFileSync(join(root, 'payload.js'), 'export default {}');
        symlinkSync(join(root, 'payload.js'), join(pluginDir, 'demo.js'));
        const askConsent = vi.fn(async () => true);
        const importModule = pluginModule();
        const registry = new PluginRegistry(
          { listProfiles: vi.fn(async () => []), getProfile: vi.fn(async () => undefined) } as never,
          { listLayouts: vi.fn(async () => []), getLayoutMetadata: vi.fn(async () => ({})) } as never,
          { getFeatureGuard: vi.fn(() => ({ allowed: true })), assertFeature: vi.fn(async () => true) } as never,
          { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
          {
            internalPlugins: [],
            isWorkspaceTrusted: () => true,
            getWorkspaceRoot: () => root,
            importModule: importModule as never,
            approvalState: memento(),
            askConsent
          }
        );

        await registry.reload();

        expect(askConsent).not.toHaveBeenCalled();
        expect(importModule).not.toHaveBeenCalled();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('refuses a plugin folder that is too big to check', async () => {
      const files: Record<string, string> = { 'demo.js': 'v1' };
      for (let index = 0; index < 600; index += 1) {
        files[`lib/f${index}.js`] = 'x';
      }
      const askConsent = vi.fn(async () => true);
      const importModule = pluginModule();
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const registry = makeRegistry({
        files: () => files,
        askConsent,
        approvalState: memento(),
        importModule,
        logger
      });

      await registry.reload();

      expect(askConsent).not.toHaveBeenCalled();
      expect(importModule).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });
  });
});
