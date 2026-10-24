import { spawnSync } from 'child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeGeneratedFiles } from '../../src/services/generatedFileWriter';
import * as vscode from 'vscode';
import { registerTypeGenCommands } from '../../src/commands/typeGen';
import { command, profile, profileStore, resetCommandMocks } from '../helpers/commandHarness';
import { TypeGenService } from '../../src/services/typeGenService';
import { FmWebProjectService } from '../../src/services/fmWebProjectService';
import { createBlankLayout, validateLayoutDefinition } from '../../src/fmweb/layoutSchema';
import { FmWebRuntimeGenerator, normalizedHash } from '../../src/services/fmWebRuntimeGenerator';

let root: string;
const logger = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'fm-followups-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function project(workspace = root) {
  const service = new FmWebProjectService({} as never, {} as never, {} as never, logger);
  vi.spyOn(service, 'getWorkspaceRoot').mockReturnValue(workspace);
  return service;
}
function runtime(workspace = root) {
  return new FmWebRuntimeGenerator({ extensionUri: { fsPath: path.resolve(__dirname, '../..') } } as never, project(workspace), logger);
}

it('accepts a workspace reached through a symlink while refusing links below its canonical root', async () => {
  const workspace = path.join(root, 'actual'); await mkdir(workspace);
  const alias = path.join(root, 'alias'); await symlink(workspace, alias);
  const target = path.join(alias, 'out/types.ts');
  await writeGeneratedFiles([{ path: target, content: 'types' }], alias);
  expect(await readFile(path.join(workspace, 'out/types.ts'), 'utf8')).toBe('types');
  await mkdir(path.join(workspace, 'real')); await symlink(path.join(workspace, 'real'), path.join(alias, 'linked'));
  await expect(writeGeneratedFiles([{ path: path.join(alias, 'linked/types.ts'), content: 'no' }], alias)).rejects.toThrow(/symlink/);
  expect(await readdir(path.join(workspace, 'real'))).toEqual([]);
});

it.each(['.fmweb', '.fmweb/generated', '.fmweb/generated/runtime-next', '.fmweb/generated/runtime-next/app'])('refuses template and env writes through %s before creating outside folders', async (folder) => {
  const outside = path.join(root, 'outside'); await mkdir(outside);
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  await mkdir(path.dirname(path.join(workspace, folder)), { recursive: true });
  await symlink(outside, path.join(workspace, folder));
  const gen = runtime(workspace);
  await expect(gen.generateRuntimeAppTemplate()).rejects.toThrow(/symlink|outside/);
  expect(await readdir(outside)).toEqual([]);
  // The env writer never traverses app; all other ancestors protect the secret too.
  if (!folder.endsWith('/app')) {
    await expect(gen.writeBridgeEnv('http://127.0.0.1:123/fm', 'private')).rejects.toThrow(/symlink|outside/);
    expect(await readdir(outside)).toEqual([]);
  }
});

it.each([false, true])('checks a linked project before initialization, including existing config=%s', async (existing) => {
  const outside = path.join(root, 'outside'); await mkdir(outside);
  if (existing) await writeFile(path.join(outside, 'project.json'), JSON.stringify({ name: 'Existing' }));
  await symlink(outside, path.join(root, '.fmweb'));
  await expect(project().ensureProjectInitialized()).rejects.toThrow(/symlink|outside/);
  expect(await readdir(outside)).toEqual(existing ? ['project.json'] : []);
});

it('refuses a project file symlink before overwriting its target', async () => {
  const service = project(); await service.ensureProjectInitialized();
  const outside = path.join(root, 'mine'); await writeFile(outside, 'keep');
  await rm(service.getProjectConfigPath()); await symlink(outside, service.getProjectConfigPath());
  await expect(service.initializeProject()).rejects.toThrow(/symlink/);
  expect(await readFile(outside, 'utf8')).toBe('keep');
});

it('allows project, template and env generation through a linked workspace', async () => {
  const alias = `${root}-alias`; await symlink(root, alias);
  try {
    const gen = runtime(alias);
    expect((await gen.generateRuntimeAppTemplate()).created.length).toBeGreaterThan(10);
    const env = await gen.writeBridgeEnv('http://127.0.0.1:123/fm', 'private');
    expect(await readFile(env, 'utf8')).toContain('NEXT_PUBLIC_FMWEB_BRIDGE_TOKEN=private');
  } finally { await rm(alias); }
});

it('all-layout generation propagates an unsafe output refusal instead of returning zero files', async () => {
  await mkdir(path.join(root, 'real')); await symlink(path.join(root, 'real'), path.join(root, 'filemaker-types'));
  const service = new TypeGenService({ getLayoutSchema: async () => ({ supported: true, fields: [{ name: ' Name ', type: 'text' }] }) } as never,
    { listLayouts: async () => [' Contacts '] } as never, logger, { getWorkspaceRoot: () => root });
  await expect(service.generateTypesForAllLayouts(profile)).rejects.toThrow(/symlink/);
  resetCommandMocks();
  registerTypeGenCommands({ profileStore: profileStore() as never, fmClient: {} as never, typeGenService: service, settingsService: {} as never, logger: logger as never });
  await command('generateTypesForAllLayouts')({ profileId: profile.id });
  expect(vscode.window.showErrorMessage).toHaveBeenCalled();
  expect(vi.mocked(vscode.window.showErrorMessage).mock.calls[0]?.[0]).toContain('symlink');
  expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  expect(await readdir(path.join(root, 'real'))).toEqual([]);
});

it('still skips unavailable metadata and files the user chose to skip in all-layout generation', async () => {
  const service = new TypeGenService({ getLayoutSchema: async (_profile: unknown, layout: string) => {
    if (layout === 'Missing') throw new Error('metadata unavailable');
    return { supported: true, fields: [] };
  } } as never, { listLayouts: async () => ['Missing', 'Keep', 'New'] } as never, logger, { getWorkspaceRoot: () => root });
  await mkdir(path.join(root, 'filemaker-types/layouts'), { recursive: true });
  await writeFile(path.join(root, 'filemaker-types/layouts/Keep.ts'), 'my types');
  vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Skip existing' as never);
  const files = await service.generateTypesForAllLayouts(profile);
  expect(files.map((file) => file.layout)).toEqual(['New']);
  expect(await readFile(path.join(root, 'filemaker-types/layouts/Keep.ts'), 'utf8')).toBe('my types');
});


it('generates a self-contained test setup with jsdom and a shared alias that exists', async () => {
  const gen = runtime(); await gen.generateRuntimeAppTemplate();
  const output = gen.getGeneratedRuntimeRoot();
  const pkg = JSON.parse(await readFile(path.join(output, 'package.json'), 'utf8'));
  expect(pkg.scripts.test).toBe('vitest run');
  expect(pkg.devDependencies.jsdom).toBeDefined();
  const config = await readFile(path.join(output, 'vitest.config.ts'), 'utf8');
  const alias = /path.resolve\(__dirname, '([^']+)'\)/.exec(config)![1]!;
  expect(await readFile(path.resolve(output, alias), 'utf8')).toContain('LayoutContainer');
  expect(pkg.dependencies['@fmweb/shared']).toBe('file:./shared');
});

it('gives the generated app no repository lint tooling, in the app manifest or the shared one', async () => {
  const gen = runtime(); await gen.generateRuntimeAppTemplate();
  const output = gen.getGeneratedRuntimeRoot();
  // The lint and coverage gates belong to this repository. A generated app runs its own
  // tests but does not lint itself, so it receives neither the scripts nor the packages.
  const tooling = ['eslint', '@eslint/js', '@typescript-eslint/parser', '@typescript-eslint/eslint-plugin', 'eslint-config-prettier', 'globals'];
  for (const manifest of ['package.json', path.join('shared', 'package.json')]) {
    const pkg = JSON.parse(await readFile(path.join(output, manifest), 'utf8'));
    expect(Object.keys(pkg.scripts ?? {}), manifest).not.toContain('lint');
    expect(Object.keys(pkg.scripts ?? {}), manifest).not.toContain('test:coverage');
    for (const name of tooling) {
      expect(Object.keys(pkg.devDependencies ?? {}), `${manifest}: ${name}`).not.toContain(name);
    }
  }
  // The app keeps what it needs: its own test script and its runtime dependencies.
  const pkg = JSON.parse(await readFile(path.join(output, 'package.json'), 'utf8'));
  expect(pkg.scripts.test).toBe('vitest run');
  expect(pkg.devDependencies.vitest).toBeDefined();
  expect(pkg.dependencies['@fmweb/shared']).toBe('file:./shared');
});

// Windows CI cannot load jsdom through a junction to the repository's node_modules (the module lookup for the jsdom test
// files fails), so the generated project's own test run is checked on Linux and macOS only; the configuration is checked everywhere above.
it.skipIf(process.platform === 'win32')('the generated project runs its own tests offline', async () => {
  const gen = runtime(); await gen.generateRuntimeAppTemplate();
  const output = gen.getGeneratedRuntimeRoot();
  // Use the installed dependencies; this runs the generated project's own test command offline.
  // npm may keep `next` (and its @next packages) inside runtime-next/node_modules instead of the root, so link every
  // root entry and let runtime-next's own copies win.
  const nodeModules = path.join(output, 'node_modules');
  await mkdir(nodeModules);
  const repoRoot = path.resolve(__dirname, '../../..');
  for (const name of await readdir(path.join(repoRoot, 'node_modules'))) {
    await symlink(path.join(repoRoot, 'node_modules', name), path.join(nodeModules, name), 'dir');
  }
  for (const name of await readdir(path.join(repoRoot, 'runtime-next', 'node_modules')).catch(() => [] as string[])) {
    if (name === '.bin') continue;
    await rm(path.join(nodeModules, name), { force: true });
    await symlink(path.join(repoRoot, 'runtime-next', 'node_modules', name), path.join(nodeModules, name), 'dir');
  }
  const result = spawnSync('npm', ['test'], { cwd: output, encoding: 'utf8', timeout: 30_000 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 30_000);

it('refreshes untouched older shared files and test config, but names and preserves edits', async () => {
  const gen = runtime(); await gen.generateRuntimeAppTemplate();
  const output = gen.getGeneratedRuntimeRoot();
  const file = path.join(output, 'shared/src/record-edit.ts');
  const legacy = await readFile(path.resolve(__dirname, '../fixtures/legacy-shared-record-edit.ts.txt'), 'utf8');
  await writeFile(file, legacy.replace(/\n/g, '\r\n'));
  const oldConfig = await readFile(path.resolve(__dirname, '../../../runtime-next/vitest.config.ts'), 'utf8');
  await writeFile(path.join(output, 'vitest.config.ts'), oldConfig);
  // The manifest of an app generated by an older release, byte for byte as it was shipped.
  // It is a checked-in fixture rather than the current template, so a change to today's
  // manifest cannot quietly turn this into a test of the present instead of of an old copy.
  const oldPkg = await readFile(path.resolve(__dirname, '../fixtures/legacy-runtime-package.json.txt'));
  expect(normalizedHash(oldPkg)).toBe('6d184961fb6759b90115ff94d15dac9455b401917d2d1527b7d3b98531b67ee8');
  await writeFile(path.join(output, 'package.json'), oldPkg);
  const result = await gen.generateRuntimeAppTemplate();
  expect(result.updated).toContain(path.join('shared', 'src/record-edit.ts'));
  expect(result.updated).toContain('vitest.config.ts');
  expect(result.updated).toContain('package.json');
  expect(await readFile(file, 'utf8')).toBe(await readFile(path.resolve(__dirname, '../../../shared/src/record-edit.ts'), 'utf8'));
  const edited = `${legacy}\n// my local change\n`;
  await writeFile(file, edited);
  const editedConfig = `${oldConfig}\n// my test settings\n`;
  await writeFile(path.join(output, 'vitest.config.ts'), editedConfig);
  const again = await gen.generateRuntimeAppTemplate();
  expect(again.needsManualUpdate).toContain(path.join('shared', 'src/record-edit.ts'));
  expect(again.needsManualUpdate).toContain('vitest.config.ts');
  expect(await readFile(file, 'utf8')).toBe(edited);
  expect(await readFile(path.join(output, 'vitest.config.ts'), 'utf8')).toBe(editedConfig);
});


it('accepts future field kinds in the extension while retaining metadata and exact names', () => {
  const layout = createBlankLayout(' Exact layout ');
  layout.objects = [{ id: '11111111-1111-4111-8111-111111111111', type: 'field', name: ' Field ', fmFieldName: ' Field ',
    x: 0, y: 0, width: 240, height: 34, kind: 'future-kind', metadata: { type: 'summary', result: 'number' } } as unknown as typeof layout.objects[number]];
  expect(validateLayoutDefinition(layout).objects[0]).toMatchObject({ kind: 'normal', fmFieldName: ' Field ', metadata: { type: 'summary', result: 'number' } });
});
