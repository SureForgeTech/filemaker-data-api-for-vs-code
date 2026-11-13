import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { RoleGuard } from '../../src/enterprise/roleGuard';
import { SettingsService } from '../../src/services/settingsService';
import {
  announceIgnored,
  collectExplanations,
  handlePanelMessage,
  openSettingsTab,
  readSettingsFile,
  readWorkspaceFiles,
  registerEffectiveSettings,
  renderEffectiveSettingsHtml,
  type Collected,
  type Dependencies
} from '../../src/settings/effectiveSettings';
import { RESTRICTED_MODE_REASON, explainSetting, policyFor, type PolicySetting } from '../../src/settings/settingPolicy';

const manifest = {
  capabilities: {
    untrustedWorkspaces: {
      restrictedConfigurations: [
        'filemaker.offline.mode',
        'filemaker.enterprise.mode',
        'filemaker.enterprise.role',
        'filemaker.features.ai.enabled',
        'filemaker.features.batch.enabled',
        'filemaker.features.recordEdit.enabled',
        'filemaker.features.scriptRunner.enabled',
        'filemaker.typegen.outputDir',
        'filemaker.batch.maxRecords',
        'filemaker.batch.concurrency',
        'filemaker.batch.dryRunDefault',
        'filemaker.snippets.includeAuthByDefault',
        'filemaker.schema.hashAlgorithm',
        'filemaker.fmWeb.bridge.rateLimitPerSecond',
        'filemaker.fmWeb.bridge.rateLimitBurst',
        'filemaker.fmWeb.bridge.requestBudget'
      ]
    }
  }
};

interface Layers {
  def?: unknown;
  user?: unknown;
  workspace?: unknown;
  folder?: unknown;
}

const DEFAULTS: Record<string, unknown> = {
  'offline.mode': false,
  'features.ai.enabled': true,
  'features.batch.enabled': true,
  'features.recordEdit.enabled': true,
  'features.scriptRunner.enabled': true,
  'enterprise.mode': false,
  'enterprise.role': 'developer',
  'ai.hiddenFields': [],
  'ai.enabled': false,
  'ai.allowWrites': false,
  'ai.allowScripts': false,
  'ai.scriptAllowlist': {},
  'ai.readableLayouts': {},
  'ai.connection': '',
  'ai.contextPath': '',
  'ai.externalServer.enabled': false,
  'secrets.fallback': 'vscode-only',
  'export.neutralizeFormulas': true,
  'savedQueries.scope': 'workspace',
  'typegen.outputDir': 'filemaker-types',
  'schema.snapshots.storage': 'workspaceFiles',
  'batch.maxRecords': 10000,
  'batch.concurrency': 4,
  'batch.dryRunDefault': true
};

/** A configuration over all keys, shaped like VS Code's, with the merged `get` that would leak a workspace value. */
function makeConfig(layers: Record<string, Layers>, trusted: boolean, restricted: Set<string>): vscode.WorkspaceConfiguration {
  const layer = (key: string): Layers => ({ def: DEFAULTS[key], ...layers[key] });
  const hidden = (key: string): boolean => !trusted && restricted.has(`filemaker.${key}`);
  return {
    inspect: (key: string) => {
      const l = layer(key);
      return {
        key,
        defaultValue: l.def,
        globalValue: l.user,
        workspaceValue: hidden(key) ? undefined : l.workspace,
        workspaceFolderValue: hidden(key) ? undefined : l.folder
      };
    },
    get: (key: string, fallback?: unknown) => {
      const l = layer(key);
      return (hidden(key) ? undefined : (l.folder ?? l.workspace)) ?? l.user ?? l.def ?? fallback;
    }
  } as unknown as vscode.WorkspaceConfiguration;
}

interface World {
  layers?: Record<string, Layers>;
  trusted?: boolean;
  enterpriseFile?: string;
  workspaceState?: Map<string, unknown>;
}

function setup(world: World = {}): Dependencies & { state: Map<string, unknown> } {
  const trusted = world.trusted ?? true;
  const restricted = new Set(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations);
  const config = makeConfig(world.layers ?? {}, trusted, restricted);
  (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = trusted;
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(config);
  const roleGuard = new RoleGuard({ debug: () => undefined, warn: () => undefined }, {
    getConfiguration: () => config,
    isWorkspaceTrusted: () => trusted,
    getWorkspaceRoot: () => '/w',
    readConfigFile: async () => world.enterpriseFile
  });
  const settingsService = new SettingsService({ getConfiguration: () => config, isWorkspaceTrusted: () => trusted });
  const state = world.workspaceState ?? new Map<string, unknown>();
  const context = {
    extension: { packageJSON: manifest },
    workspaceState: {
      get: (key: string, fallback: unknown) => (state.has(key) ? state.get(key) : fallback),
      update: vi.fn(async (key: string, value: unknown) => {
        state.set(key, value);
      })
    }
  } as unknown as vscode.ExtensionContext;
  return { context, roleGuard, settingsService, state };
}

const find = (collected: Collected, key: string) => {
  const row = collected.rows.find((entry) => entry.key === `filemaker.${key}`);
  if (!row) {
    throw new Error(`no row for ${key}`);
  }
  return row;
};

const tempRoots: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'effective-'));
  tempRoots.push(dir);
  return dir;
};
const workspace = vscode.workspace as unknown as {
  workspaceFolders: unknown;
  workspaceFile: unknown;
  isTrusted: boolean;
};
const originalFolders = workspace.workspaceFolders;

beforeEach(() => {
  vi.clearAllMocks();
  workspace.workspaceFolders = originalFolders;
  workspace.workspaceFile = undefined;
});
afterEach(() => {
  workspace.workspaceFolders = originalFolders;
  workspace.workspaceFile = undefined;
  workspace.isTrusted = true;
});
afterAll(() => {
  for (const dir of tempRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('effective values come from the enforcing readers', () => {
  it('uses the enforcing type guards: a string "true" is OFF and a string "false" leaves protection ON', async () => {
    const deps = setup({ layers: { 'ai.allowWrites': { user: 'true' }, 'ai.enabled': { user: true }, 'export.neutralizeFormulas': { user: 'false' } } });
    const collected = await collectExplanations(deps);
    expect(find(collected, 'ai.allowWrites').effective).toBe(false);
    expect(find(collected, 'ai.enabled').effective).toBe(true);
    expect(find(collected, 'export.neutralizeFormulas').effective).toBe(true);
    const off = setup({ layers: { 'export.neutralizeFormulas': { user: false } } });
    expect(find(await collectExplanations(off), 'export.neutralizeFormulas').effective).toBe(false);
  });

  it('ignores a merged workspace value for user-only settings', async () => {
    const deps = setup({ layers: { 'ai.enabled': { user: false, workspace: true }, 'ai.externalServer.enabled': { workspace: true }, 'ai.contextPath': { workspace: '/tmp/x' } } });
    const collected = await collectExplanations(deps);
    expect(find(collected, 'ai.enabled').effective).toBe(false);
    expect(find(collected, 'ai.externalServer.enabled').effective).toBe(false);
    expect(find(collected, 'ai.contextPath').effective).toBe('');
  });

  it('shows the clamped batch values SettingsService uses, and the sanitized output folder', async () => {
    const deps = setup({
      layers: {
        'batch.maxRecords': { workspace: 99_999_999 },
        'batch.concurrency': { workspace: 500 },
        'typegen.outputDir': { workspace: '/etc/types' }
      }
    });
    const collected = await collectExplanations(deps);
    expect(find(collected, 'batch.maxRecords').effective).toBe(1_000_000);
    expect(find(collected, 'batch.concurrency').effective).toBe(10);
    expect(find(collected, 'typegen.outputDir').effective).toBe('etc/types');
  });

  it('User true beats Workspace false for offline mode and says why', async () => {
    const collected = await collectExplanations(setup({ layers: { 'offline.mode': { user: true, workspace: false } } }));
    expect(find(collected, 'offline.mode')).toMatchObject({ effective: true, source: 'User', ignored: true, noticeWorthy: true });
  });

  it('credits the enterprise file and applies Restricted Mode to every restricted kind', async () => {
    const enterprise = setup({ enterpriseFile: JSON.stringify({ enterpriseMode: true, role: 'viewer' }) });
    await enterprise.roleGuard.refresh();
    const collected = await collectExplanations(enterprise);
    expect(find(collected, 'enterprise.mode')).toMatchObject({ effective: true, source: 'Enterprise file' });
    expect(find(collected, 'enterprise.role')).toMatchObject({ effective: 'viewer', source: 'Enterprise file' });

    const untrusted = await collectExplanations(setup({ trusted: false, layers: { 'offline.mode': { workspace: true }, 'enterprise.role': { user: 'admin', workspace: 'viewer' } } }));
    expect(find(untrusted, 'offline.mode')).toMatchObject({ effective: false, source: 'Default', ignored: false, note: RESTRICTED_MODE_REASON });
    expect(find(untrusted, 'enterprise.role')).toMatchObject({ effective: 'admin', source: 'User' });
    expect(find(untrusted, 'schema.snapshots.storage')).toMatchObject({ effective: 'workspaceState', source: 'Restricted Mode' });
    expect(find(untrusted, 'typegen.outputDir').note).toBe(RESTRICTED_MODE_REASON);
  });

  it('treats a setting as restricted only when package.json lists it', async () => {
    const deps = setup({ trusted: false, layers: { 'savedQueries.scope': { workspace: 'global' } } });
    // savedQueries.scope is not a restricted configuration, so VS Code still reports its workspace value.
    expect(find(await collectExplanations(deps), 'savedQueries.scope')).toMatchObject({ effective: 'global', source: 'Workspace', ignored: false });
  });
});

describe('workspace settings files', () => {
  it('reads application-scope keys from .vscode/settings.json in a trusted single folder', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.vscode'));
    writeFileSync(join(dir, '.vscode', 'settings.json'), '﻿{ // c\n "filemaker.ai.allowWrites": true, }');
    workspace.workspaceFolders = [{ uri: { fsPath: dir } }];
    const collected = await collectExplanations(setup());
    expect(find(collected, 'ai.allowWrites')).toMatchObject({ ignored: true, noticeWorthy: true, effective: false });
  });

  it('does not attribute folder-file values to window-wide settings that inspect() already covers', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.vscode'));
    writeFileSync(join(dir, '.vscode', 'settings.json'), '{"filemaker.savedQueries.scope": "global", "filemaker.offline.mode": true}');
    workspace.workspaceFolders = [{ uri: { fsPath: dir } }, { uri: { fsPath: tempDir() } }];
    const collected = await collectExplanations(setup());
    expect(find(collected, 'savedQueries.scope')).toMatchObject({ effective: 'workspace', source: 'Default', workspaceValue: undefined });
    expect(find(collected, 'offline.mode').source).toBe('Default');
    expect(collected.notes.join(' ')).toContain('multi-root workspace');
  });

  it('reads application-scope keys from the .code-workspace file', async () => {
    const dir = tempDir();
    const file = join(dir, 'x.code-workspace');
    writeFileSync(file, '{"folders": [], "settings": {"filemaker.ai.enabled": true}}');
    workspace.workspaceFile = { scheme: 'file', fsPath: file };
    const collected = await collectExplanations(setup());
    expect(find(collected, 'ai.enabled')).toMatchObject({ ignored: true, effective: false });
  });

  it('does not read settings files at all in an untrusted workspace, and says so', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.vscode'));
    writeFileSync(join(dir, '.vscode', 'settings.json'), '{"filemaker.ai.enabled": true}');
    workspace.workspaceFolders = [{ uri: { fsPath: dir } }];
    workspace.isTrusted = false;
    const files = await readWorkspaceFiles();
    expect(files).toMatchObject({ values: {}, skippedUntrusted: true });
    const collected = await collectExplanations(setup({ trusted: false }));
    expect(find(collected, 'ai.enabled').ignored).toBe(false);
    expect(collected.notes.join(' ')).toContain('Restricted Mode');
  });

  it('reports a file it cannot read instead of silently using nothing', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.vscode'));
    writeFileSync(join(dir, '.vscode', 'settings.json'), '{ not json');
    workspace.workspaceFolders = [{ uri: { fsPath: dir } }];
    const collected = await collectExplanations(setup());
    expect(collected.notes.join(' ')).toContain('Could not read a settings file (.vscode/settings.json is not valid JSON)');
  });

  describe('readSettingsFile', () => {
    it('is missing for an absent file, bounded in size, and refuses links and escapes', async () => {
      const dir = tempDir();
      expect(await readSettingsFile(join(dir, 'nope.json'), dir)).toEqual({ status: 'missing' });

      writeFileSync(join(dir, 'big.json'), `{"filemaker.a": "${'x'.repeat(300 * 1024)}"}`);
      expect(await readSettingsFile(join(dir, 'big.json'), dir)).toEqual({ status: 'unreadable', reason: 'is too large' });

      const outside = tempDir();
      writeFileSync(join(outside, 'secret.json'), '{"filemaker.ai.enabled": true}');
      symlinkSync(join(outside, 'secret.json'), join(dir, 'link.json'));
      expect(await readSettingsFile(join(dir, 'link.json'), dir)).toEqual({ status: 'unreadable', reason: 'is a link or not a regular file' });

      symlinkSync(outside, join(dir, 'linked-dir'));
      expect(await readSettingsFile(join(dir, 'linked-dir', 'secret.json'), dir)).toEqual({ status: 'unreadable', reason: 'is outside the folder' });

      writeFileSync(join(dir, 'ok.json'), '{"filemaker.ai.enabled": true}');
      expect(await readSettingsFile(join(dir, 'ok.json'), dir)).toEqual({ status: 'ok', values: { 'ai.enabled': true } });
    });

    it('stays fast on a file full of commas', async () => {
      const dir = tempDir();
      writeFileSync(join(dir, 'commas.json'), '{"filemaker.a": [' + '1,'.repeat(100_000) + ']}');
      const started = Date.now();
      const result = await readSettingsFile(join(dir, 'commas.json'), dir);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(result.status).toBe('ok');
    });
  });
});

describe('the Effective Settings view', () => {
  const rows = (): Collected => ({
    rows: [
      explainSetting({
        setting: policyFor('ai.enabled') as PolicySetting,
        values: { default: false, workspaceFile: '"><img src=x onerror=alert(1)> \' & <b>' },
        effective: false, trusted: true, restrictedInUntrusted: false
      }),
      explainSetting({
        setting: policyFor('typegen.outputDir') as PolicySetting,
        values: { default: 'x'.repeat(100_000) }, effective: 'x'.repeat(100_000), trusted: true, restrictedInUntrusted: true
      })
    ],
    notes: ['<script>alert(1)</script>']
  });

  it('escapes every value, caps long ones, and keeps the script nonce', () => {
    const html = renderEffectiveSettingsHtml(rows(), "default-src 'none'", 'NONCE123');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&quot;');
    expect(html).toContain('&#39;');
    expect(html).toContain('&amp;');
    expect(html).toContain('<script nonce="NONCE123">');
    expect(html).toContain('<style nonce="NONCE123">');
    expect(html.length).toBeLessThan(20_000);
  });

  it('is responsive and wraps long values', () => {
    const html = renderEffectiveSettingsHtml(rows(), "default-src 'none'", 'N');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('@media (max-width: 640px)');
    expect(html).toContain('overflow-wrap: anywhere');
    expect(html).toContain('data-label="Workspace value"');
  });

  it('shows the Workspace button only where a workspace value matters, and a Refresh button with a time stamp', () => {
    const html = renderEffectiveSettingsHtml(rows(), "default-src 'none'", 'N', '10:11:12');
    expect(html.match(/data-open="workspace"/g)).toHaveLength(1);
    expect(html.match(/data-open="user"/g)).toHaveLength(2);
    expect(html).toContain('id="refresh"');
    expect(html).toContain('snapshot taken at 10:11:12');
  });

  it('opens the User and Workspace tabs with the setting id', async () => {
    const execute = vi.mocked(vscode.commands.executeCommand);
    await openSettingsTab('user', 'filemaker.ai.enabled');
    await openSettingsTab('workspace', 'filemaker.typegen.outputDir');
    expect(execute).toHaveBeenNthCalledWith(1, 'workbench.action.openGlobalSettings', { query: '@id:filemaker.ai.enabled' });
    expect(execute).toHaveBeenNthCalledWith(2, 'workbench.action.openWorkspaceSettings', { query: '@id:filemaker.typegen.outputDir' });
  });
});

describe('messages from the view', () => {
  beforeEach(() => vi.mocked(vscode.commands.executeCommand).mockClear());

  it('opens the requested tab for a known setting id', () => {
    handlePanelMessage({ type: 'open', target: 'user', key: 'filemaker.ai.enabled' }, vi.fn());
    handlePanelMessage({ type: 'open', target: 'workspace', key: 'filemaker.typegen.outputDir' }, vi.fn());
    expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(2);
  });

  it('drops an unknown key, a key without the filemaker. prefix, a bad target, and non-objects', () => {
    const refresh = vi.fn();
    for (const message of [
      { type: 'open', target: 'user', key: 'editor.fontSize' },
      { type: 'open', target: 'user', key: 'ai.enabled' },
      { type: 'open', target: 'user', key: 'filemaker.nope' },
      { type: 'open', target: 'machine', key: 'filemaker.ai.enabled' },
      { type: 'open', key: 'filemaker.ai.enabled' },
      { type: 'run', target: 'user', key: 'filemaker.ai.enabled' },
      null,
      'open',
      42
    ]) {
      handlePanelMessage(message, refresh);
    }
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes on request', () => {
    const refresh = vi.fn();
    handlePanelMessage({ type: 'refresh' }, refresh);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('showPanel and announceIgnored', () => {
  function stubPanel() {
    let handler: (message: unknown) => void = () => undefined;
    const panel = {
      webview: { html: '', cspSource: 'csp', onDidReceiveMessage: vi.fn((fn: (message: unknown) => void) => { handler = fn; }) },
      onDidDispose: vi.fn(),
      reveal: vi.fn()
    };
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(panel as never);
    return { panel, send: (message: unknown) => handler(message) };
  }

  it('creates one locked-down panel, then reveals it', async () => {
    vi.resetModules();
    const fresh = await import('../../src/settings/effectiveSettings');
    const { panel } = stubPanel();
    const deps = setup();
    await fresh.showPanel(deps);
    await fresh.showPanel(deps);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(vi.mocked(vscode.window.createWebviewPanel).mock.calls[0]?.[3]).toMatchObject({ enableScripts: true, localResourceRoots: [] });
    expect(panel.reveal).toHaveBeenCalledTimes(1);
    expect(panel.webview.html).toContain('Effective settings');
  });

  it('announces an ignored setting once, with fixed text, and remembers it', async () => {
    const deps = setup({ layers: { 'offline.mode': { user: true, workspace: false } } });
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined);
    await announceIgnored(deps);
    await announceIgnored(deps);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    const [message, ...buttons] = vi.mocked(vscode.window.showInformationMessage).mock.calls[0] as string[];
    expect(message).toBe('This workspace sets filemaker.offline.mode but it is ignored: a workspace can only turn it on, so it stays on.');
    expect(buttons).toEqual(['Open Effective Settings', "Don't show again for this workspace"]);
  });

  it('puts no file text in the notification, even for a command link', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.vscode'));
    writeFileSync(join(dir, '.vscode', 'settings.json'), JSON.stringify({ 'filemaker.ai.connection': '[Update required](command:workbench.action.terminal.new)' }));
    workspace.workspaceFolders = [{ uri: { fsPath: dir } }];
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined);
    await announceIgnored(setup({ layers: { 'ai.connection': { user: 'p1' } } }));
    const message = String(vi.mocked(vscode.window.showInformationMessage).mock.calls[0]?.[0]);
    expect(message).toBe('This workspace sets filemaker.ai.connection but it is ignored: this setting only works in User settings.');
  });

  it('persists "Don\'t show again" and then stays quiet for new ignored settings', async () => {
    const deps = setup({ layers: { 'offline.mode': { user: true, workspace: false } } });
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce("Don't show again for this workspace" as never);
    await announceIgnored(deps);
    expect(deps.state.get('filemaker.settingsNoticeState')).toMatchObject({ muted: true });
    const again = setup({ layers: { 'features.batch.enabled': { user: false, workspace: true } }, workspaceState: deps.state });
    await announceIgnored(again);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it('opens the view when asked, and says nothing when nothing is ignored', async () => {
    vi.resetModules();
    const fresh = await import('../../src/settings/effectiveSettings');
    stubPanel();
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Open Effective Settings' as never);
    await fresh.announceIgnored(setup({ layers: { 'offline.mode': { user: true, workspace: false } } }));
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    vi.mocked(vscode.window.showInformationMessage).mockClear();
    await fresh.announceIgnored(setup());
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });
});

describe('every combination of trust, user, workspace and file layers (model of inspect())', () => {
  it('never attributes a hidden or ignored workspace value, for every restricted switch', async () => {
    const keys = ['offline.mode', 'features.batch.enabled', 'features.ai.enabled', 'enterprise.mode'];
    for (const trusted of [true, false]) {
      for (const key of keys) {
        for (const user of [undefined, true, false]) {
          for (const ws of [undefined, true, false]) {
            const deps = setup({ trusted, layers: { [key]: { user, workspace: ws } } });
            const row = find(await collectExplanations(deps), key);
            const label = `${key} trusted=${trusted} user=${user} ws=${ws}`;
            if (!trusted) {
              expect(['Workspace', 'Workspace Folder'], label).not.toContain(row.source);
              expect(row.ignored, label).toBe(false);
              expect(row.note, label).toBe(RESTRICTED_MODE_REASON);
            } else if (row.ignored) {
              expect(row.reason, label).toContain('can only turn it');
              expect(row.source, label).not.toBe('Workspace');
            }
          }
        }
      }
    }
  });
});


describe('values the extension does not use as written are explained', () => {
  it("an invalid enterprise.role in User settings is explained as 'treated as developer'", async () => {
    const collected = await collectExplanations(setup({ layers: { 'enterprise.role': { user: 'bogus' } } }));
    const row = find(collected, 'enterprise.role');
    expect(row.effective).toBe('developer');
    expect(row.note).toBe('Your User value "bogus" is not a role (viewer, developer or admin), so it is treated as developer.');
    const html = renderEffectiveSettingsHtml(collected, "default-src 'none'", 'n');
    expect(html).toContain('treated as developer');
  });

  it('a valid role, or no value, gets no such note', async () => {
    for (const user of [undefined, 'viewer', 'admin']) {
      const row = find(await collectExplanations(setup({ layers: { 'enterprise.role': { user } } })), 'enterprise.role');
      expect(row.note, String(user)).toBeUndefined();
    }
  });

  it('the invalid-role note and an ignored workspace value are both shown', async () => {
    const collected = await collectExplanations(setup({ layers: { 'enterprise.role': { user: 'bogus', workspace: 'nonsense' } } }));
    const row = find(collected, 'enterprise.role');
    expect(row.reason).toContain('is not a role');
    expect(row.note).toContain('treated as developer');
    const html = renderEffectiveSettingsHtml(collected, "default-src 'none'", 'n');
    expect(html).toContain('is not a role, so it is ignored');
    expect(html).toContain('treated as developer');
  });

  it('a typegen.outputDir that sanitizes to the default says so, whichever scope holds it', async () => {
    for (const layers of [{ workspace: '../escape' }, { user: '' }, { workspace: '   ' }, { folder: 'a/../b' }]) {
      const row = find(await collectExplanations(setup({ layers: { 'typegen.outputDir': layers } })), 'typegen.outputDir');
      expect(row.effective, JSON.stringify(layers)).toBe('filemaker-types');
      expect(row.note, JSON.stringify(layers)).toMatch(/is not a folder inside the workspace .* so the default "filemaker-types" is used\./);
    }
  });

  it('Restricted Mode is never given as the reason: an untrusted workspace with a VALID value gets no unusable-value note', async () => {
    const row = find(
      await collectExplanations(setup({ trusted: false, layers: { 'typegen.outputDir': { workspace: 'types' } } })),
      'typegen.outputDir'
    );
    expect(row.effective).toBe('filemaker-types'); // the default stays in effect because of Restricted Mode
    expect(row.note).not.toMatch(/not a folder inside the workspace/);
    expect(row.reason ?? row.note).toMatch(/Restricted Mode/);
  });

  it('an untrusted workspace with an invalid value is not blamed for it either (the value is hidden); trusting it shows the note', async () => {
    const layers = { 'typegen.outputDir': { workspace: '../escape' } };
    expect(find(await collectExplanations(setup({ trusted: false, layers })), 'typegen.outputDir').note ?? '').not.toMatch(/not a folder inside the workspace/);
    expect(find(await collectExplanations(setup({ trusted: true, layers })), 'typegen.outputDir').note).toMatch(/"\.\.\/escape" is not a folder inside the workspace/);
  });

  it('a User value that is invalid is explained in either trust state (it is the value in force)', async () => {
    for (const trusted of [true, false]) {
      const row = find(await collectExplanations(setup({ trusted, layers: { 'typegen.outputDir': { user: '/' } } })), 'typegen.outputDir');
      expect(row.note, String(trusted)).toMatch(/is not a folder inside the workspace/);
    }
  });

  it('trusted + a valid value: no such note', async () => {
    const row = find(await collectExplanations(setup({ trusted: true, layers: { 'typegen.outputDir': { workspace: 'types' } } })), 'typegen.outputDir');
    expect(row.effective).toBe('types');
    expect(row.note).toBeUndefined();
  });

  it('a typegen.outputDir that is used (as written, or tidied) gets no such note', async () => {
    for (const workspaceValue of ['types', 'out/types', 'out/types/', 'filemaker-types', '/etc/types']) {
      const row = find(await collectExplanations(setup({ layers: { 'typegen.outputDir': { workspace: workspaceValue } } })), 'typegen.outputDir');
      expect(row.note, workspaceValue).toBeUndefined();
    }
  });
});

describe('the view refreshes when the situation changes', () => {
  type Listener = () => void;

  function watcherStub() {
    const listeners: Record<string, Listener[]> = { change: [], create: [], delete: [] };
    return {
      listeners,
      onDidChange: vi.fn((fn: Listener) => (listeners['change'] as Listener[]).push(fn) && { dispose: vi.fn() }),
      onDidCreate: vi.fn((fn: Listener) => (listeners['create'] as Listener[]).push(fn) && { dispose: vi.fn() }),
      onDidDelete: vi.fn((fn: Listener) => (listeners['delete'] as Listener[]).push(fn) && { dispose: vi.fn() }),
      dispose: vi.fn()
    };
  }

  function arm(workspaceFile?: { scheme: string; fsPath: string }) {
    vi.useFakeTimers();
    workspace.workspaceFile = workspaceFile;
    const deps = setup();
    const reads = vi.fn();
    const get = (deps.context.workspaceState as unknown as { get: (k: string, f: unknown) => unknown }).get;
    (deps.context.workspaceState as unknown as { get: unknown }).get = (key: string, fallback: unknown) => {
      reads();
      return get(key, fallback);
    };
    const watchers: Array<ReturnType<typeof watcherStub>> = [];
    vi.mocked(vscode.workspace.createFileSystemWatcher).mockImplementation((() => {
      const stub = watcherStub();
      watchers.push(stub);
      return stub;
    }) as never);
    const disposables = registerEffectiveSettings(deps);
    // The first schedule() from registration has run its course.
    vi.advanceTimersByTime(1000);
    reads.mockClear();
    return { deps, reads, watchers, disposables };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-checks (after the short delay) when the workspace is trusted', async () => {
    const { reads } = arm();
    const grant = vi.mocked(vscode.workspace.onDidGrantWorkspaceTrust).mock.calls.at(-1)?.[0] as Listener;
    expect(typeof grant).toBe('function');

    grant();
    expect(reads).not.toHaveBeenCalled(); // debounced
    await vi.advanceTimersByTimeAsync(800);

    expect(reads).toHaveBeenCalled(); // announceIgnored looked at the notice state, so the settings were read again
  });

  it('several trust and setting changes in a row cause one re-check', async () => {
    const { reads } = arm();
    const grant = vi.mocked(vscode.workspace.onDidGrantWorkspaceTrust).mock.calls.at(-1)?.[0] as Listener;
    grant();
    grant();
    grant();
    await vi.advanceTimersByTimeAsync(800);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('watches the .code-workspace file, and re-checks when it changes, appears or goes', async () => {
    const { reads, watchers } = arm({ scheme: 'file', fsPath: '/tmp/w/project.code-workspace' });

    expect(vi.mocked(vscode.workspace.createFileSystemWatcher)).toHaveBeenCalledTimes(2);
    const pattern = vi.mocked(vscode.workspace.createFileSystemWatcher).mock.calls[1]?.[0] as unknown as { base: string; pattern: string };
    expect(pattern).toMatchObject({ base: '/tmp/w', pattern: 'project.code-workspace' });

    for (const kind of ['change', 'create', 'delete']) {
      reads.mockClear();
      for (const fn of (watchers[1] as ReturnType<typeof watcherStub>).listeners[kind] as Listener[]) {
        fn();
      }
      await vi.advanceTimersByTimeAsync(800);
      expect(reads, kind).toHaveBeenCalled();
    }
  });

  it('does not create a second watcher when there is no .code-workspace file (or it is not a local file)', () => {
    arm();
    expect(vi.mocked(vscode.workspace.createFileSystemWatcher)).toHaveBeenCalledTimes(1);
    vi.mocked(vscode.workspace.createFileSystemWatcher).mockClear();
    arm({ scheme: 'vscode-remote', fsPath: '/tmp/w/project.code-workspace' });
    expect(vi.mocked(vscode.workspace.createFileSystemWatcher)).toHaveBeenCalledTimes(1);
  });
});

  it('Show Effective Settings warns that a bare hiddenFields string still hides one exact name', async () => {
    const deps = setup({ layers: { 'ai.hiddenFields': { user: 'SSN, Password', workspace: [' Exact '] } } });
    const collected = await collectExplanations(deps);
    const row = collected.rows.find((r) => r.key === 'filemaker.ai.hiddenFields');
    expect(row?.effective).toEqual(['SSN, Password', ' Exact ']);
    const html = renderEffectiveSettingsHtml(collected, 'csp', 'nonce');
    expect(html).toContain('filemaker.ai.hiddenFields');
    expect(html).toContain('still hides one exact field name');
    expect(html).toContain('commas are not separators');
    expect(collected.notes).toContain('filemaker.ai.hiddenFields (globalValue): the value is a string, so it still hides one exact field name (commas are not separators); use an array of exact field names, for example ["SSN", "Password"].');
    expect(html).toContain('array');
  });
