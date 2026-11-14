import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';

import { RoleGuard } from '../../src/enterprise/roleGuard';
import { ROLE_RANK } from '../../src/enterprise/roles';
import {
  BADGE_STRICTER,
  BADGE_USER_ONLY,
  BADGE_WORKSPACE,
  EMPTY_NOTICE_STATE,
  POLICY_SETTINGS,
  RESTRICTED_MODE_REASON,
  badgeFor,
  explainSetting,
  fmt,
  noticeMessage,
  parseFilemakerSettings,
  pickNotices,
  policyFor,
  stripJsonc,
  type ExplainInput,
  type PolicySetting
} from '../../src/settings/settingPolicy';
import { inspectRestrictedSetting, readRestrictedSetting } from '../../src/utils/policySetting';

const root = join(__dirname, '..', '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  capabilities: { untrustedWorkspaces: { restrictedConfigurations: string[] } };
  contributes: {
    commands: Array<{ command: string; title: string; category: string }>;
    configuration: Array<{ properties: Record<string, Record<string, unknown>> }>;
  };
};
const restrictedKeys = new Set(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations);

/** The layers one setting can have, and a model of what VS Code's inspect() reports for them. */
interface Layers {
  def?: unknown;
  user?: unknown;
  remote?: unknown;
  workspace?: unknown;
  folder?: unknown;
}

/**
 * VS Code's behaviour as far as this extension relies on it: in an untrusted workspace the
 * workspace and folder values of a restricted configuration are not reported at all.
 */
function model(key: string, layers: Layers, trusted: boolean, restricted: boolean): vscode.WorkspaceConfiguration {
  const hide = !trusted && restricted;
  const workspaceValue = hide ? undefined : layers.workspace;
  const workspaceFolderValue = hide ? undefined : layers.folder;
  return {
    inspect: (name: string) =>
      name === key
        ? {
            key,
            defaultValue: layers.def,
            globalValue: layers.user,
            globalRemoteValue: layers.remote,
            workspaceValue,
            workspaceFolderValue
          }
        : undefined,
    // The merged read: folder > workspace > remote > user > default.
    get: (name: string, fallback?: unknown) =>
      name === key ? (workspaceFolderValue ?? workspaceValue ?? layers.remote ?? layers.user ?? layers.def) : fallback
  } as unknown as vscode.WorkspaceConfiguration;
}

const OPTIONS: Array<boolean | undefined> = [true, false, undefined];

describe('explainSetting for restrict-only switches (every layer, trusted and not)', () => {
  for (const restrictedValue of [true, false]) {
    for (const trusted of [true, false]) {
      for (const user of OPTIONS) {
        for (const remote of OPTIONS) {
          for (const workspace of OPTIONS) {
            for (const folder of OPTIONS) {
              const name = `restricted=${restrictedValue} trusted=${trusted} user=${user} remote=${remote} workspace=${workspace} folder=${folder}`;
              it(name, () => {
                const def = !restrictedValue;
                const setting: PolicySetting = { key: 'x.switch', kind: 'stricter-bool', restrictedValue };
                const config = model('x.switch', { def, user, remote, workspace, folder }, trusted, true);
                const reading = inspectRestrictedSetting(config, 'x.switch', def, restrictedValue);
                const effective = readRestrictedSetting(config, 'x.switch', def, restrictedValue);
                expect(reading.value).toBe(effective);

                const inspected = config.inspect('x.switch');
                const result = explainSetting({
                  setting,
                  values: {
                    default: def,
                    user: inspected?.globalValue,
                    workspace: inspected?.workspaceValue,
                    workspaceFolder: inspected?.workspaceFolderValue
                  },
                  effective,
                  trusted,
                  restrictedInUntrusted: true,
                  reading
                });

                expect(result.effective).toBe(effective);
                const shown = folder ?? workspace;
                if (!trusted) {
                  // The workspace layer is invisible and never counts.
                  expect(['Workspace', 'Workspace Folder']).not.toContain(result.source);
                  expect(result.ignored).toBe(false);
                  expect(result.note).toBe(RESTRICTED_MODE_REASON);
                  return;
                }
                expect(result.ignored).toBe(shown !== undefined && shown !== effective);
                if (result.ignored) {
                  expect(result.reason).toContain(`a workspace can only turn it ${restrictedValue ? 'on' : 'off'}`);
                  expect(result.noticeReason).toBeDefined();
                  expect(['Workspace', 'Workspace Folder']).not.toContain(result.source);
                }
                if (['Workspace', 'Workspace Folder'].includes(result.source)) {
                  expect(shown).toBe(restrictedValue);
                  expect(result.ignored).toBe(false);
                  expect(result.source).toBe(folder !== undefined ? 'Workspace Folder' : 'Workspace');
                }
                expect(result.note).toBeUndefined();
              });
            }
          }
        }
      }
    }
  }

  it('says it plainly for offline mode', () => {
    const config = model('offline.mode', { def: false, user: true, workspace: false }, true, true);
    const result = explainSetting({
      setting: policyFor('offline.mode') as PolicySetting,
      values: { default: false, user: true, workspace: false },
      effective: true,
      trusted: true,
      restrictedInUntrusted: true,
      reading: inspectRestrictedSetting(config, 'offline.mode', false, true)
    });
    expect(result.reason).toBe(
      'This workspace sets offline.mode to false but your User value is true, and a workspace can only turn it on, so it stays on.'
    );
  });

  it('reproduces the review case: untrusted, file says true, no user value, is not self-contradictory', () => {
    const config = model('offline.mode', { def: false, workspace: true }, false, true);
    const result = explainSetting({
      setting: policyFor('offline.mode') as PolicySetting,
      values: { default: false, workspaceFile: true },
      effective: readRestrictedSetting(config, 'offline.mode', false, true),
      trusted: false,
      restrictedInUntrusted: true,
      reading: inspectRestrictedSetting(config, 'offline.mode', false, true)
    });
    expect(result.source).toBe('Default');
    expect(result.reason).toBe(RESTRICTED_MODE_REASON);
    expect(result.reason).not.toContain('can only turn it on');
  });
});

describe('explainSetting for other kinds', () => {
  const userOnly = policyFor('ai.enabled') as PolicySetting;
  const base: Omit<ExplainInput, 'setting' | 'values' | 'effective'> = { trusted: true, restrictedInUntrusted: false };

  it('flags a workspace value for a user-only setting as ignored, even though VS Code hides it', () => {
    const result = explainSetting({ ...base, setting: userOnly, values: { default: false, user: false, workspaceFile: true }, effective: false });
    expect(result.ignored).toBe(true);
    expect(result.noticeWorthy).toBe(true);
    expect(result.reason).toContain('only works in User settings');
    expect(result.noticeReason).toBe('this setting only works in User settings');
    expect(result.workspaceMeaningful).toBe(false);
  });

  it('does not call an ignored value worth a notice when it equals what is in effect', () => {
    const result = explainSetting({ ...base, setting: userOnly, values: { default: false, user: false, workspaceFile: false }, effective: false });
    expect(result.ignored).toBe(true);
    expect(result.noticeWorthy).toBe(false);
  });

  it('keeps user-only settings out of Restricted Mode handling (they are never workspace-readable)', () => {
    const result = explainSetting({ ...base, trusted: false, restrictedInUntrusted: true, setting: userOnly, values: { default: false }, effective: false });
    expect(result.note).toBeUndefined();
    expect(result.source).toBe('Default');
  });

  describe('enterprise role', () => {
    const setting = policyFor('enterprise.role') as PolicySetting;
    it('lets a workspace lower the role but not raise it', () => {
      const lower = explainSetting({ ...base, restrictedInUntrusted: true, setting, values: { default: 'developer', user: 'admin', workspace: 'viewer' }, effective: 'viewer' });
      expect(lower.ignored).toBe(false);
      expect(lower.source).toBe('Workspace');
      const raise = explainSetting({ ...base, restrictedInUntrusted: true, setting, values: { default: 'developer', user: 'viewer', workspace: 'admin' }, effective: 'viewer' });
      expect(raise.ignored).toBe(true);
      expect(raise.reason).toContain('can only lower the role');
      expect(raise.noticeReason).toBe('a workspace can only lower the role');
    });

    it('treats an unknown role as ignored, and ranks come from the shared table', () => {
      const bogus = explainSetting({ ...base, restrictedInUntrusted: true, setting, values: { default: 'developer', user: 'admin', workspace: 'superuser' }, effective: 'admin' });
      expect(bogus.ignored).toBe(true);
      expect(bogus.reason).toContain('is not a role');
      expect(ROLE_RANK).toEqual({ viewer: 0, developer: 1, admin: 2 });
    });

    it('credits the enterprise file when it lowers the role', () => {
      const result = explainSetting({ ...base, restrictedInUntrusted: true, setting, values: { default: 'developer', user: 'admin', enterpriseFile: 'viewer' }, effective: 'viewer' });
      expect(result.source).toBe('Enterprise file');
    });

    it('still credits the enterprise file in Restricted Mode (it is not a workspace setting)', () => {
      const result = explainSetting({ trusted: false, restrictedInUntrusted: true, setting, values: { default: 'developer', user: 'admin', enterpriseFile: 'viewer' }, effective: 'viewer' });
      expect(result.source).toBe('Enterprise file');
      expect(result.ignored).toBe(false);
    });

    it('is Restricted Mode when untrusted: an ignored workspace role is explained, not attributed', () => {
      const result = explainSetting({ trusted: false, restrictedInUntrusted: true, setting, values: { default: 'developer', user: 'admin', workspace: 'viewer' }, effective: 'admin' });
      expect(result.ignored).toBe(true);
      expect(result.reason).toBe(RESTRICTED_MODE_REASON);
      expect(result.source).toBe('User');
    });
  });

  it('credits the enterprise file when it turns enterprise mode on', () => {
    const result = explainSetting({
      ...base,
      restrictedInUntrusted: true,
      setting: policyFor('enterprise.mode') as PolicySetting,
      values: { default: false, enterpriseFile: true },
      effective: true
    });
    expect(result.source).toBe('Enterprise file');
  });

  it('labels the union setting by who contributed', () => {
    const setting = policyFor('ai.hiddenFields') as PolicySetting;
    expect(explainSetting({ ...base, setting, values: { default: [], user: ['a'], workspace: ['b'] }, effective: ['a', 'b'] }).source).toBe('User and Workspace');
    expect(explainSetting({ ...base, setting, values: { default: [], user: ['a'] }, effective: ['a'] }).source).toBe('User');
  });

  it('reports Restricted Mode for a restricted workspace setting and for snapshots storage', () => {
    const outputDir = policyFor('typegen.outputDir') as PolicySetting;
    const untrusted = explainSetting({ trusted: false, restrictedInUntrusted: true, setting: outputDir, values: { default: 'filemaker-types', workspace: 'src/types' }, effective: 'filemaker-types' });
    expect(untrusted.ignored).toBe(true);
    expect(untrusted.reason).toBe(RESTRICTED_MODE_REASON);
    const trusted = explainSetting({ ...base, restrictedInUntrusted: true, setting: outputDir, values: { default: 'filemaker-types', workspace: 'src/types' }, effective: 'src/types' });
    expect(trusted).toMatchObject({ source: 'Workspace', ignored: false });
    const snapshots = policyFor('schema.snapshots.storage') as PolicySetting;
    const noValue = explainSetting({ trusted: false, restrictedInUntrusted: false, setting: snapshots, values: { default: 'workspaceFiles' }, effective: 'workspaceState' });
    expect(noValue.source).toBe('Restricted Mode');
    expect(noValue.note).toBe(RESTRICTED_MODE_REASON);
    expect(noValue.effective).toBe('workspaceState');
    const trustedSnap = explainSetting({ ...base, setting: snapshots, values: { default: 'workspaceFiles' }, effective: 'workspaceFiles' });
    expect(trustedSnap.source).toBe('Default');
  });
});

describe('hostile text never reaches a notification', () => {
  const hostile = '[Update required](command:workbench.action.terminal.new)';
  const huge = 'x'.repeat(100 * 1024);

  it('keeps file values out of the notice and caps them in the view text', () => {
    const entries = [
      explainSetting({ setting: policyFor('ai.connection') as PolicySetting, values: { default: '', user: '', workspaceFile: hostile }, effective: '', trusted: true, restrictedInUntrusted: false }),
      explainSetting({ setting: policyFor('ai.contextPath') as PolicySetting, values: { default: '', workspaceFile: huge }, effective: '', trusted: true, restrictedInUntrusted: false }),
      explainSetting({ setting: policyFor('enterprise.role') as PolicySetting, values: { default: 'developer', user: 'viewer', workspace: hostile }, effective: 'viewer', trusted: true, restrictedInUntrusted: true }),
      explainSetting({ setting: policyFor('offline.mode') as PolicySetting, values: { default: false, user: true, workspace: hostile }, effective: true, trusted: true, restrictedInUntrusted: true }),
      explainSetting({ trusted: false, restrictedInUntrusted: true, setting: policyFor('typegen.outputDir') as PolicySetting, values: { default: 'a', workspace: hostile }, effective: 'a' })
    ];
    for (const entry of entries) {
      expect(entry.ignored, entry.key).toBe(true);
      const single = noticeMessage([entry]);
      expect(single, entry.key).not.toContain('command:');
      expect(single, entry.key).not.toContain('](');
      expect(single, entry.key).not.toContain('xxxx');
      expect(single.length, entry.key).toBeLessThan(300);
      expect(entry.reason?.length ?? 0, entry.key).toBeLessThan(600);
    }
    const many = noticeMessage(entries);
    expect(many).not.toContain('command:');
    expect(many).toContain('5 settings that are ignored');
  });

  it('fmt caps long and unprintable values', () => {
    expect(fmt(huge).length).toBeLessThan(90);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(fmt(cyclic)).toBe('[unprintable]');
  });
});

describe('notification de-duplication', () => {
  const ignoredEntry = explainSetting({
    setting: policyFor('offline.mode') as PolicySetting,
    values: { default: false, user: true, workspace: false },
    effective: true, trusted: true, restrictedInUntrusted: true
  });
  const harmless = explainSetting({
    setting: policyFor('ai.enabled') as PolicySetting,
    values: { default: false, user: false, workspaceFile: false },
    effective: false, trusted: true, restrictedInUntrusted: false
  });

  it('announces a setting once, then never again', () => {
    const first = pickNotices([ignoredEntry], EMPTY_NOTICE_STATE);
    expect(first.show).toHaveLength(1);
    expect(pickNotices([ignoredEntry], first.next).show).toHaveLength(0);
  });

  it('stays quiet once muted and when the ignored value equals the one in effect', () => {
    expect(pickNotices([ignoredEntry], { seen: [], muted: true }).show).toHaveLength(0);
    expect(pickNotices([harmless], EMPTY_NOTICE_STATE).show).toHaveLength(0);
  });

  it('words one or several settings in a single message from keys and fixed sentences', () => {
    expect(noticeMessage([ignoredEntry])).toBe('This workspace sets filemaker.offline.mode but it is ignored: a workspace can only turn it on, so it stays on.');
    expect(noticeMessage([ignoredEntry, ignoredEntry])).toContain('2 settings that are ignored');
  });
});

describe('settings file parsing', () => {
  it('reads filemaker.* keys from JSONC with a BOM, comments and trailing commas', () => {
    const text = `${'\uFEFF'}{
      // a comment with "quotes" and a , comma
      "editor.fontSize": 12,
      "filemaker.ai.enabled": true, /* block */
      "filemaker.note": "http://x//y, }",
      "filemaker.ai.hiddenFields": ["a", "b",],
    }`;
    expect(parseFilemakerSettings(text)).toEqual({
      ok: true,
      values: { 'ai.enabled': true, note: 'http://x//y, }', 'ai.hiddenFields': ['a', 'b'] }
    });
  });

  it('reports invalid, oversized and non-object files as not ok, and reads a .code-workspace section', () => {
    expect(parseFilemakerSettings('not json')).toEqual({ ok: false });
    expect(parseFilemakerSettings('[1]')).toEqual({ ok: false });
    expect(parseFilemakerSettings(`{"filemaker.a": "${'x'.repeat(300 * 1024)}"}`)).toEqual({ ok: false });
    expect(parseFilemakerSettings('{"folders": [], "settings": {"filemaker.ai.enabled": true}}', 'settings')).toEqual({
      ok: true,
      values: { 'ai.enabled': true }
    });
    expect(parseFilemakerSettings('{"folders": []}', 'settings')).toEqual({ ok: true, values: {} });
  });

  it('strips a pathological trailing-comma file in linear time', () => {
    const text = '{"filemaker.a": [' + '1,'.repeat(120_000) + ']' + ' '.repeat(5_000) + '}';
    const started = Date.now();
    stripJsonc(text);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('registry kinds match the code that enforces each setting', () => {
  // Each probe drives the REAL enforcing code with a user layer and a workspace layer and returns
  // what ends up in effect, so a registry kind that disagrees with the code fails here.
  const fakeEnterprise = async (user: unknown, workspace: unknown, trusted: boolean) => {
    const config = model('enterprise.role', { def: 'developer', user, workspace }, trusted, true);
    const guard = new RoleGuard({ debug: () => undefined, warn: () => undefined }, {
      getConfiguration: () => config,
      isWorkspaceTrusted: () => trusted,
      getWorkspaceRoot: () => undefined,
      readConfigFile: async () => undefined
    });
    return guard.getRole();
  };

  it('stricter-bool: the workspace can move only in the restricted direction', () => {
    for (const setting of POLICY_SETTINGS.filter((entry) => entry.kind === 'stricter-bool')) {
      const restricted = setting.restrictedValue === true;
      const key = setting.key;
      const loosen = model(key, { def: !restricted, user: restricted, workspace: !restricted }, true, true);
      expect(readRestrictedSetting(loosen, key, !restricted, restricted), `${key} cannot be loosened`).toBe(restricted);
      const tighten = model(key, { def: !restricted, user: !restricted, workspace: restricted }, true, true);
      expect(readRestrictedSetting(tighten, key, !restricted, restricted), `${key} can be tightened`).toBe(restricted);
    }
  });

  it.each([[1, 10, 1, true], [8, 2, 2, false]])('explains the capped retry limit (%s, %s)', (user, workspace, effective, ignored) => {
    const explanation = explainSetting({
      setting: policyFor('connect.maxRetries')!, values: { default: 3, user, workspace },
      effective, trusted: true, restrictedInUntrusted: true
    });
    expect(explanation.ignored).toBe(ignored);
    expect(explanation.source).toBe(ignored ? 'User' : 'Workspace');
    expect(explanation.effective).toBe(effective);
  });

  it('stricter-role: the workspace can lower the role but not raise it', async () => {
    expect(await fakeEnterprise('viewer', 'admin', true)).toBe('viewer');
    expect(await fakeEnterprise('admin', 'viewer', true)).toBe('viewer');
  });

  it.each([
    'snippets.includeAuthByDefault', 'schema.hashAlgorithm', 'fmWeb.bridge.rateLimitPerSecond',
    'fmWeb.bridge.rateLimitBurst', 'fmWeb.bridge.requestBudget', 'performance.mode'
  ])('%s is user-only and restricted in untrusted workspaces', (key) => {
    const properties = Object.assign({}, ...manifest.contributes.configuration.map((section) => section.properties));
    expect(properties[`filemaker.${key}`].scope).toBe('application');
    expect(restrictedKeys.has(`filemaker.${key}`)).toBe(true);
    expect(policyFor(key)?.kind).toBe('user-only');
  });

  it('every registry key is a real setting and application-scope settings are exactly the user-only ones', () => {
    const properties = manifest.contributes.configuration.flatMap((section) => Object.entries(section.properties));
    const applicationKeys = properties.filter(([, schema]) => schema.scope === 'application').map(([key]) => key.replace(/^filemaker\./, ''));
    const userOnly = POLICY_SETTINGS.filter((entry) => entry.kind === 'user-only').map((entry) => entry.key);
    expect([...applicationKeys].sort()).toEqual([...userOnly].sort());
    for (const setting of POLICY_SETTINGS.filter((entry) => entry.kind !== 'user-only' && entry.kind !== 'stricter-union')) {
      expect(restrictedKeys.has(`filemaker.${setting.key}`) || setting.forcedWhenUntrusted === true || setting.kind === 'workspace', setting.key).toBe(true);
    }
  });
});

describe('package.json setting descriptions', () => {
  const properties = manifest.contributes.configuration.flatMap((section) => Object.entries(section.properties));
  const badges = [BADGE_USER_ONLY, BADGE_STRICTER, BADGE_WORKSPACE];

  it('gives every setting exactly one badge at the start that matches how the code treats it, and a plain description', () => {
    expect(properties.length).toBeGreaterThan(40);
    for (const [key, schema] of properties) {
      const text = String(schema.markdownDescription ?? '');
      expect(badges.filter((badge) => text.includes(badge)), key).toHaveLength(1);
      const kind = policyFor(key)?.kind;
      expect(text.startsWith(badgeFor(kind)), key).toBe(true);
      expect(schema.description, `${key} keeps a plain description for tools that read only it`).toBe(
        text.replace(/\*\*/g, '').replace(/`/g, '')
      );
      expect(String(schema.description)).not.toContain('**');
      if (schema.scope === 'application') {
        expect(kind, `${key} is application scope`).toBe('user-only');
      } else {
        expect(kind === 'user-only', `${key} is not application scope`).toBe(false);
      }
      if (kind && kind.startsWith('stricter') && key !== 'filemaker.ai.hiddenFields') {
        expect(restrictedKeys.has(key), `${key} is a restricted configuration`).toBe(true);
      }
    }
  });

  it('explains the saved-query, snapshot and type-output settings accurately', () => {
    const byKey = Object.fromEntries(properties);
    expect(byKey['filemaker.savedQueries.scope']?.enum).toEqual(['workspace', 'global']);
    const scopeText = String(byKey['filemaker.savedQueries.scope']?.markdownDescription);
    expect(scopeText).toContain('not in your project files');
    expect(scopeText).toContain('does not move queries you already saved');
    expect(String(byKey['filemaker.schema.snapshots.storage']?.markdownDescription)).toContain('.vscode/filemaker/snapshots');
    const typegen = String(byKey['filemaker.typegen.outputDir']?.markdownDescription);
    expect(typegen).toContain('relative to the project folder');
    expect(typegen).toContain('a leading `/` is dropped');
  });
});

describe('Show Effective Settings command', () => {
  it('is contributed under the FileMaker category', () => {
    const command = manifest.contributes.commands.find((entry) => entry.command === 'filemakerDataApiTools.showEffectiveSettings');
    expect(command).toMatchObject({ title: 'Show Effective Settings', category: 'FileMaker' });
  });

  describe('the unusable-folder note for typegen.outputDir', () => {
    const setting = policyFor('typegen.outputDir') as PolicySetting;
    const explain = (values: Record<string, unknown>, trusted: boolean) =>
      explainSetting({ setting, values: { default: 'filemaker-types', ...values }, effective: 'filemaker-types', trusted, restrictedInUntrusted: true });

    it('is never given because of Restricted Mode: a hidden workspace value (valid or not) is not judged', () => {
      expect(explain({ workspace: 'types' }, false).note ?? '').not.toMatch(/not a folder inside the workspace/);
      expect(explain({ workspace: '../escape' }, false).note ?? '').not.toMatch(/not a folder inside the workspace/);
    });

    it('is given for the value in force when it really is unusable', () => {
      expect(explain({ workspace: '../escape' }, true).note).toMatch(/"\.\.\/escape" is not a folder inside the workspace/);
      expect(explain({ user: '' }, false).note).toMatch(/"" is not a folder inside the workspace/);
    });

    it('is not given for a usable value', () => {
      expect(explain({ workspace: 'types' }, true).note).toBeUndefined();
      expect(explain({ user: 'out/types/' }, true).note).toBeUndefined();
    });
  });
});
