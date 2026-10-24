import { createHash } from 'crypto';
import { createRequire } from 'module';
import { chmod, link, lstat, mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import nock from 'nock';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardFieldSize } from '@fmweb/shared/dist/field-standards';
import { createBlankLayout } from '../../src/fmweb/layoutSchema';
import { FmBridgeServer } from '../../src/services/fmBridgeServer';
import {
  FmWebRuntimeGenerator,
  RUNTIME_TEMPLATE_VERSION,
  RuntimeTemplateUnavailableError,
  SHIPPED_MARKED_HASHES,
  SHIPPED_SHARED_HASHES,
  decideManagedRefresh,
  normalizedHash,
  withoutMonorepoTooling,
  writeManagedFile
} from '../../src/services/fmWebRuntimeGenerator';

const extensionDir = path.resolve(__dirname, '../..');
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('FM Web runtime template', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fmweb-template-'));
  });

  afterEach(async () => {
    nock.disableNetConnect();
    await rm(dir, { recursive: true, force: true });
  });

  function generator(extensionRoot = extensionDir, trusted = true): FmWebRuntimeGenerator {
    return new FmWebRuntimeGenerator(
      { extensionUri: { fsPath: extensionRoot } } as never,
      {
        isWorkspaceTrusted: () => trusted,
        getGeneratedDirPath: () => dir,
        getProjectRoot: () => path.dirname(dir),
        ensureProjectInitialized: async () => undefined
      } as never,
      logger
    );
  }

  it('generated web layouts retain standard geometry and ship the shared view presentation', async () => {
    const layoutsDir = path.join(dir, 'layouts');
    await mkdir(layoutsDir);
    const layout = createBlankLayout(' Exact view ', ' Source ');
    layout.objects = ['text', 'number', 'date', 'long text', 'container'].map((type, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: type, type: 'field',
      fmFieldName: ` ${type} `, displayType: 'editBox', format: 'text', labelPosition: 'top', required: false,
      ...standardFieldSize({ type }), x: 24, y: 24 + i * 220, zIndex: i,
      anchors: { top: true, left: true, right: false, bottom: false }
    }));
    await writeFile(path.join(layoutsDir, 'view.layout.json'), JSON.stringify(layout));
    const gen = new FmWebRuntimeGenerator({ extensionUri: { fsPath: extensionDir } } as never, {
      isWorkspaceTrusted: () => true, ensureProjectInitialized: async () => undefined,
      getGeneratedDirPath: () => path.join(dir, 'generated'), getProjectRoot: () => dir, getLayoutsDirPath: () => layoutsDir
    } as never, logger);
    const generated = await gen.generateLayoutPage(layout.id);
    const saved = JSON.parse(await readFile(generated.outputPath, 'utf8')) as typeof layout;
    expect(saved.name).toBe(' Exact view ');
    expect(saved.fmLayoutName).toBe(' Source ');
    expect(saved.objects.map((object) => [object.width, object.height])).toEqual([[240, 34], [120, 34], [160, 34], [240, 96], [240, 160]]);
    expect(saved.objects.map((object) => object.type === 'field' && object.labelPosition)).toEqual(Array(5).fill('top'));
    await gen.generateRuntimeAppTemplate();
    const page = await readFile(path.join(gen.getGeneratedRuntimeRoot(), 'app/layouts/[id]/page.tsx'), 'utf8');
    expect(page).toContain('standardFieldsCss()');
    expect(page).toContain('data-fm-field-layout="standard"');
    const client = await readFile(path.join(gen.getGeneratedRuntimeRoot(), 'app/layouts/[id]/runtime-layout-client.tsx'), 'utf8');
    expect(client).toContain('LayoutContainer');
    expect(client).toContain('fieldValues: edit ? edit.draft : runtime.runtimeData.fieldValues');
  });

  it('writes a working runtime and its shared source dependency with all screen fixes', async () => {
    const gen = generator();
    await gen.generateRuntimeAppTemplate();
    const output = gen.getGeneratedRuntimeRoot();
    const page = await readFile(path.join(output, 'app/layouts/[id]/page.tsx'), 'utf8');
    expect(page).toContain('const { id } = await params');
    expect(page).toContain('await searchParams');
    const client = await readFile(path.join(output, 'app/layouts/[id]/runtime-layout-client.tsx'), 'utf8');
    expect(client).toContain('Cancel'); expect(client).toContain('computeRecordPatch');
    expect(client).not.toMatch(/Save Stamp|LastViewedAt/);
    const css = await readFile(path.join(output, 'app/styles.css'), 'utf8');
    expect(css).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(await readFile(path.join(output, 'lib/runtime-data.ts'), 'utf8')).toContain('fieldData, modId');
    const shared = path.join(output, 'shared');
    const pkg = JSON.parse(await readFile(path.join(output, 'package.json'), 'utf8'));
    expect(pkg.dependencies['@fmweb/shared']).toBe('file:./shared');
    // Model already-installed runtime dependencies, without installing anything.
    await symlink(path.join(extensionDir, '..', 'node_modules'), path.join(output, 'node_modules'));
    expect(createRequire(path.join(shared, 'src/index.ts')).resolve('zod')).toContain('node_modules');
    expect(JSON.parse(await readFile(path.join(shared, 'package.json'), 'utf8')).main).toBe('src/index.ts');
    for (const file of ['ui-renderer.tsx', 'layout-schema.ts', 'record-edit.ts', 'field-order.ts', 'field-standards.ts', 'index.ts']) {
      expect(await readFile(path.join(shared, 'src', file), 'utf8')).toBe(await readFile(path.join(extensionDir, '../shared/src', file), 'utf8'));
    }
    expect(await readFile(path.join(output, 'next.config.ts'), 'utf8')).toContain("transpilePackages: ['@fmweb/shared']");
    // Regeneration must preserve local shared edits, just like managed runtime edits.
    await writeFile(path.join(shared, 'src/ui-renderer.tsx'), '// my change');
    const again = await gen.generateRuntimeAppTemplate();
    expect(again.needsManualUpdate).toContain(path.join('shared', 'src/ui-renderer.tsx'));
    expect(await readFile(path.join(shared, 'src/ui-renderer.tsx'), 'utf8')).toBe('// my change');
  });

  it('updates an unedited generated dependency path and preserves an edited package file', async () => {
    const gen = generator();
    const pkgPath = path.join(gen.getGeneratedRuntimeRoot(), 'package.json');
    await mkdir(path.dirname(pkgPath), { recursive: true });
    await writeFile(pkgPath, await readFile(path.join(extensionDir, '../runtime-next/package.json')));
    expect((await gen.generateRuntimeAppTemplate()).updated).toContain('package.json');
    expect(JSON.parse(await readFile(pkgPath, 'utf8')).dependencies['@fmweb/shared']).toBe('file:./shared');
    await writeFile(pkgPath, '{"name":"my-app","dependencies":{}}');
    expect((await gen.generateRuntimeAppTemplate()).needsManualUpdate).toContain('package.json');
    expect(JSON.parse(await readFile(pkgPath, 'utf8')).name).toBe('my-app');
  });

  it('refreshes the shipped old frame stylesheet, preserves edited CSS, and refuses linked shared folders', async () => {
    const gen = generator();
    const cssPath = path.join(gen.getGeneratedRuntimeRoot(), 'app/styles.css');
    await mkdir(path.dirname(cssPath), { recursive: true });
    const legacy = await readFile(path.join(extensionDir, 'test/fixtures/legacy-runtime-styles.css.txt'));
    await writeFile(cssPath, legacy);
    expect((await gen.generateRuntimeAppTemplate()).updated).toContain(path.join('app', 'styles.css'));
    expect(await readFile(cssPath, 'utf8')).toContain('grid-template-columns: minmax(0, 1fr)');
    await writeFile(cssPath, `${legacy.toString()}\n/* my edit */\n`);
    expect((await gen.generateRuntimeAppTemplate()).needsManualUpdate).toContain(path.join('app', 'styles.css'));
    expect(await readFile(cssPath, 'utf8')).toContain('my edit');
    const outside = path.join(dir, 'outside-shared'); await mkdir(outside);
    const shared = path.join(gen.getGeneratedRuntimeRoot(), 'shared'); await rm(shared, { recursive: true }); await symlink(outside, shared);
    await expect(gen.generateRuntimeAppTemplate()).rejects.toThrow(/symlink/);
    expect(await readdir(outside)).toEqual([]);
  });

  it('asks before replacing unrelated generated layout pages and marks new pages', async () => {
    const layoutsDir = path.join(dir, 'layouts'); await mkdir(layoutsDir);
    const layout = createBlankLayout(' Exact view ', ' Source ');
    await writeFile(path.join(layoutsDir, 'view.layout.json'), JSON.stringify(layout));
    const gen = new FmWebRuntimeGenerator({ extensionUri: { fsPath: extensionDir } } as never, {
      isWorkspaceTrusted: () => true, ensureProjectInitialized: async () => undefined,
      getGeneratedDirPath: () => path.join(dir, 'generated'), getProjectRoot: () => dir, getLayoutsDirPath: () => layoutsDir
    } as never, logger);
    const first = await gen.generateLayoutPage(layout.id);
    expect(JSON.parse(await readFile(first.outputPath, 'utf8')).$comment).toBe('Generated by FileMaker Data API Tools.');
    await writeFile(first.outputPath, 'user page');
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Skip existing' as never);
    await expect(gen.generateLayoutPage(layout.id)).rejects.toThrow(/Skipped existing/);
    expect(await readFile(first.outputPath, 'utf8')).toBe('user page');
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining(first.outputPath), { modal: true }, 'Overwrite', 'Skip existing');
  });

  const bridgeClientPath = () => path.join(dir, 'runtime-next', 'lib', 'bridge-client.ts');

  it('generates the managed files with the current template version marker', async () => {
    const summary = await generator().generateRuntimeAppTemplate();
    expect(summary.created).toContain(path.join('lib', 'bridge-client.ts'));
    for (const file of ['lib/bridge-client.ts', 'lib/runtime-data.ts', 'lib/runtime-behavior.ts', 'app/layouts/[id]/runtime-layout-client.tsx']) {
      const first = (await readFile(path.join(dir, 'runtime-next', file), 'utf8')).split('\n', 1)[0];
      expect(first, file).toContain(`fmweb-managed: runtime template v${RUNTIME_TEMPLATE_VERSION}`);
    }
    // Local env files from the template folder are never copied into a generated app.
    expect(summary.created.some((file) => file.startsWith('.env'))).toBe(false);
    // The lint configuration of the repository is not copied either: a generated app does
    // not lint itself. The template folder really has that file, so the check means something.
    await expect(readFile(path.join(extensionDir, '..', 'runtime-next', 'eslint.config.mjs'), 'utf8')).resolves.toContain('@eslint/js');
    expect(summary.created).not.toContain('eslint.config.mjs');
    // Nor is the coverage report of the repository's own gates.
    expect(summary.created.some((file) => file.split(path.sep)[0] === 'coverage')).toBe(false);
  });

  it('never copies the repository lint config or coverage output into a generated app', async () => {
    // A stand-in template folder, so the repository's own runtime-next stays untouched.
    const fake = path.join(dir, 'fake');
    const template = path.join(fake, 'runtime-next');
    await mkdir(path.join(template, 'coverage'), { recursive: true });
    await writeFile(path.join(template, 'coverage', 'summary.json'), '{}\n');
    await writeFile(path.join(template, 'eslint.config.mjs'), 'export default [];\n');
    await writeFile(path.join(template, 'package.json'), `${JSON.stringify({
      name: '@fmweb/runtime-next',
      version: '0.1.0',
      private: true,
      scripts: { test: 'vitest run' },
      dependencies: {},
      devDependencies: { vitest: '^5.0.5' }
    }, null, 2)}\n`);
    const shared = path.join(fake, 'shared');
    await mkdir(path.join(shared, 'src'), { recursive: true });
    await writeFile(path.join(shared, 'package.json'), `${JSON.stringify({ name: '@fmweb/shared', version: '0.1.0' }, null, 2)}\n`);
    await writeFile(path.join(shared, 'src', 'index.ts'), 'export {};\n');

    const summary = await generator(path.join(fake, 'ext')).generateRuntimeAppTemplate();

    expect(summary.created).toContain('package.json');
    expect(summary.created).not.toContain(path.join('coverage', 'summary.json'));
    expect(summary.created).not.toContain('eslint.config.mjs');
    const generated = await readdir(path.join(dir, 'runtime-next'));
    expect(generated).not.toContain('coverage');
    expect(generated).not.toContain('eslint.config.mjs');
  });

  it('refreshes an app generated by an older version: unmodified shipped copies and older markers', async () => {
    const legacy = await readFile(path.join(extensionDir, 'test/fixtures/legacy-bridge-client.ts.txt'), 'utf8');
    expect(createHash('sha256').update(legacy.replace(/\r\n/g, '\n')).digest('hex')).toBe(
      '5498ff7031a1e12b4c74b1d1a5d8c08f286754732f5c26006760f8ea95d58d1f'
    );
    await mkdir(path.dirname(bridgeClientPath()), { recursive: true });
    await writeFile(bridgeClientPath(), legacy);
    expect(legacy).not.toContain('X-FM-Bridge-Token');

    const first = await generator().generateRuntimeAppTemplate();
    expect(first.updated).toContain(path.join('lib', 'bridge-client.ts'));
    expect(first.needsManualUpdate).toEqual([]);
    expect(await readFile(bridgeClientPath(), 'utf8')).toContain('X-FM-Bridge-Token');

    // The current copy is left as it is.
    const second = await generator().generateRuntimeAppTemplate();
    expect(second.updated).toEqual([]);
  });

  it.each([
    ['legacy-runtime-page.tsx.txt', '0da7442c0152dd6bc59d53741a7bca633723afad470e5afb095e73590412b266'],
    ['v1.0.0-runtime-page.tsx.txt', '645ed91229d76841ea407279e6d0472f9d8af64dd3dcd4313c7aa566789ae814']
  ])('refreshes shipped page %s but preserves edits and skips symlinks', async (fixture, hash) => {
    const legacy = await readFile(path.join(extensionDir, 'test/fixtures', fixture));
    // Pin this historical file independently of the current template hash list.
    expect(normalizedHash(legacy)).toBe(hash);
    const page = path.join(dir, 'runtime-next', 'app/layouts/[id]/page.tsx');
    await mkdir(path.dirname(page), { recursive: true });
    // Windows-generated copies must be recognised too.
    await writeFile(page, legacy.toString('utf8').replace(/\n/g, '\r\n'));
    const first = await generator().generateRuntimeAppTemplate();
    expect(first.updated).toContain(path.join('app', 'layouts', '[id]', 'page.tsx'));
    expect(await readFile(page, 'utf8')).toBe(await readFile(path.join(extensionDir, '../runtime-next/app/layouts/[id]/page.tsx'), 'utf8'));
    const edited = Buffer.concat([legacy, Buffer.from('\n// my application change\n')]);
    await writeFile(page, edited);
    const second = await generator().generateRuntimeAppTemplate();
    expect(second.needsManualUpdate).toContain(path.join('app', 'layouts', '[id]', 'page.tsx'));
    expect(await readFile(page)).toEqual(edited);

    const outside = path.join(dir, 'original-page.tsx');
    await writeFile(outside, legacy);
    await rm(page);
    await symlink(outside, page);
    const third = await generator().generateRuntimeAppTemplate();
    expect(third.updated).not.toContain(path.join('app', 'layouts', '[id]', 'page.tsx'));
    expect(third.skipped).toContain(path.join('app', 'layouts', '[id]', 'page.tsx'));
    expect(third.needsManualUpdate).toContain(path.join('app', 'layouts', '[id]', 'page.tsx'));
    expect((await lstat(page)).isSymbolicLink()).toBe(true);
    expect(await readFile(outside)).toEqual(legacy);
  });

  it('does not overwrite a user-edited file that still carries an older marker: it is left alone and named', async () => {
    await mkdir(path.dirname(bridgeClientPath()), { recursive: true });
    const edited = '// fmweb-managed: runtime template v1\nexport const mine = true;\n';
    await writeFile(bridgeClientPath(), edited);

    const summary = await generator().generateRuntimeAppTemplate();

    expect(summary.updated).not.toContain(path.join('lib', 'bridge-client.ts'));
    expect(summary.needsManualUpdate).toEqual([path.join('lib', 'bridge-client.ts')]);
    expect(await readFile(bridgeClientPath(), 'utf8')).toBe(edited);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('edited'), { file: path.join('lib', 'bridge-client.ts') });
  });

  describe('decideManagedRefresh', () => {
    const shipped = Buffer.from('// fmweb-managed: runtime template v1\nshipped();\n');
    const shippedHash = normalizedHash(shipped);

    it('refreshes an older marker only when the content is a version that was shipped with a marker (line endings aside)', () => {
      expect(decideManagedRefresh(shipped, [], [shippedHash], 2)).toBe('refresh');
      expect(decideManagedRefresh(Buffer.from(shipped.toString().replace(/\n/g, '\r\n')), [], [shippedHash], 2)).toBe('refresh');
      expect(decideManagedRefresh(Buffer.from(`${shipped.toString()}// my change\n`), [], [shippedHash], 2)).toBe('edited');
      expect(decideManagedRefresh(shipped, [], [], 2)).toBe('edited');
    });

    it('leaves a current or newer marker alone, and refreshes an unmarked copy only when it is a known pre-marker version', () => {
      expect(decideManagedRefresh(Buffer.from('// fmweb-managed: runtime template v2\nx\n'), [], [], 2)).toBe('current');
      expect(decideManagedRefresh(Buffer.from('// fmweb-managed: runtime template v3\nx\n'), [], [], 2)).toBe('current');
      const unmarked = Buffer.from('export const old = 1;\n');
      expect(decideManagedRefresh(unmarked, [normalizedHash(unmarked)], [], 2)).toBe('refresh');
      expect(decideManagedRefresh(unmarked, ['0'.repeat(64)], [], 2)).toBe('edited');
    });
  });

  it('records the hash of every managed file in the template, so a template change cannot ship without deciding about older copies', async () => {
    for (const [file, hashes] of Object.entries(SHIPPED_MARKED_HASHES)) {
      const current = normalizedHash(await readFile(path.resolve(extensionDir, '..', 'runtime-next', file)));
      expect(hashes, `${file}: bump RUNTIME_TEMPLATE_VERSION and ADD this hash (keep the older ones): ${current}`).toContain(current);
    }
  });

  it('records every current shared source hash so future refreshes recognize this release', async () => {
    for (const [file, hashes] of Object.entries(SHIPPED_SHARED_HASHES)) {
      let content = await readFile(path.resolve(extensionDir, '..', 'shared', file));
      if (file === 'package.json') {
        const pkg = JSON.parse(content.toString());
        // The same manifest the generator writes: the repository's own lint tooling removed.
        content = Buffer.from(`${JSON.stringify({ ...withoutMonorepoTooling(pkg), main: 'src/index.ts', types: 'src/index.ts', scripts: {} }, null, 2)}\n`);
      }
      expect(hashes, file).toContain(normalizedHash(content));
    }
  });

  it('never writes through a symbolic link: a managed file that is a link is left alone and reported', async () => {
    const outside = path.join(dir, 'outside.ts');
    await writeFile(outside, 'untouched');
    await mkdir(path.dirname(bridgeClientPath()), { recursive: true });
    await symlink(outside, bridgeClientPath());

    const summary = await generator().generateRuntimeAppTemplate();

    expect(summary.needsManualUpdate).toEqual([path.join('lib', 'bridge-client.ts')]);
    expect(summary.updated).toEqual([]);
    expect(await readFile(outside, 'utf8')).toBe('untouched');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('symbolic link'), { file: path.join('lib', 'bridge-client.ts') });
  });

  it('a dangling link at a template file is not written through either', async () => {
    const target = path.join(dir, 'does-not-exist.ts');
    await mkdir(path.dirname(bridgeClientPath()), { recursive: true });
    await symlink(target, bridgeClientPath());

    await generator().generateRuntimeAppTemplate();

    await expect(stat(target)).rejects.toThrow();
  });

  it('a link at an ordinary (not managed) template file is skipped without a warning', async () => {
    const files = (await generator().generateRuntimeAppTemplate()).created;
    const plain = files.find((file) => !['bridge-client.ts', 'runtime-data.ts', 'runtime-behavior.ts', 'runtime-layout-client.tsx'].includes(path.basename(file)) && file.endsWith('tsconfig.json'));
    expect(plain).toBeTruthy();
    const target = path.join(dir, 'runtime-next', plain as string);
    const outside = path.join(dir, 'elsewhere.json');
    await writeFile(outside, 'untouched');
    await rm(target);
    await symlink(outside, target);

    const summary = await generator().generateRuntimeAppTemplate();

    expect(summary.skipped).toContain(plain);
    expect(summary.needsManualUpdate).toEqual([]);
    expect(await readFile(outside, 'utf8')).toBe('untouched');
  });

  it('writeManagedFile replaces a link planted at the target instead of following it, and leaves the link target alone', async () => {
    const outside = path.join(dir, 'victim.txt');
    await writeFile(outside, 'untouched');
    const target = path.join(dir, 'managed.ts');
    await symlink(outside, target);

    await writeManagedFile(target, 'fresh');

    expect(await readFile(outside, 'utf8')).toBe('untouched');
    expect(await readFile(target, 'utf8')).toBe('fresh');
    expect((await lstat(target)).isSymbolicLink()).toBe(false);
    // No temporary files are left behind.
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('writeManagedFile does not write through a hard link: the other name keeps its content', async () => {
    const original = path.join(dir, 'original.ts');
    await writeFile(original, 'original');
    const target = path.join(dir, 'managed.ts');
    await link(original, target);

    await writeManagedFile(target, 'fresh');

    expect(await readFile(original, 'utf8')).toBe('original');
    expect(await readFile(target, 'utf8')).toBe('fresh');
  });

  it.skipIf(process.platform === 'win32')('writeManagedFile keeps the permission bits of the file it replaces', async () => {
    const executable = path.join(dir, 'run.sh');
    await writeFile(executable, 'old');
    await chmod(executable, 0o755);
    const ownerOnly = path.join(dir, 'private.ts');
    await writeFile(ownerOnly, 'old');
    await chmod(ownerOnly, 0o600);

    await writeManagedFile(executable, 'new');
    await writeManagedFile(ownerOnly, 'new');

    expect((await stat(executable)).mode & 0o777).toBe(0o755);
    expect((await stat(ownerOnly)).mode & 0o777).toBe(0o600);
    expect(await readFile(ownerOnly, 'utf8')).toBe('new');
  });

  it.skipIf(process.platform === 'win32')('writeManagedFile drops setuid, setgid and sticky bits', async () => {
    const target = path.join(dir, 'special.sh');
    await writeFile(target, 'old');
    await chmod(target, 0o7755);
    expect((await stat(target)).mode & 0o7000).not.toBe(0);
    await writeManagedFile(target, 'new');
    expect((await stat(target)).mode & 0o7777).toBe(0o755);
  });

  it.skipIf(process.platform === 'win32')('writeManagedFile creates temporary exports owner-only even with a permissive umask', async () => {
    const target = path.join(dir, 'export.json');
    const oldMask = process.umask(0);
    try {
      async function* content(): AsyncGenerator<string> {
        const temporary = (await readdir(dir)).find((name) => name.endsWith('.tmp'));
        expect(temporary).toBeDefined();
        expect((await stat(path.join(dir, temporary!))).mode & 0o7777).toBe(0o600);
        yield 'private export';
      }
      await writeManagedFile(target, content() as never);
      expect((await stat(target)).mode & 0o7777).toBe(0o600);
    } finally {
      process.umask(oldMask);
    }
  });

  it('writeManagedFile leaves no .tmp behind when the write fails part way, and the target is untouched', async () => {
    const target = path.join(dir, 'managed.ts');
    await writeFile(target, 'original');
    async function* failing(): AsyncGenerator<string> {
      yield 'partial';
      throw new Error('disk full');
    }

    await expect(writeManagedFile(target, failing() as never)).rejects.toThrow('disk full');

    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(await readFile(target, 'utf8')).toBe('original');
  });

  it('a folder where a file belongs gets a plain message, not EISDIR (writeManagedFile and the generator)', async () => {
    const target = path.join(dir, 'managed.ts');
    await mkdir(target);
    await expect(writeManagedFile(target, 'x')).rejects.toThrow(/is a folder, not a file/);
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    await mkdir(path.join(dir, 'runtime-next', 'lib', 'bridge-client.ts'), { recursive: true });
    await expect(generator().generateRuntimeAppTemplate()).rejects.toThrow(/lib.bridge-client\.ts in the generated runtime is a folder, not a file/);
  });

  it('refreshing through a folder that links outside is refused, and the file there is left as it was', async () => {
    const elsewhere = path.join(dir, 'elsewhere-dir');
    await mkdir(elsewhere);
    const legacy = await readFile(path.join(extensionDir, 'test/fixtures/legacy-bridge-client.ts.txt'), 'utf8');
    // Every other template file of that folder is already there, so the refresh is the only write that could happen.
    const templateLib = path.resolve(extensionDir, '..', 'runtime-next', 'lib');
    for (const name of await readdir(templateLib)) {
      await writeFile(path.join(elsewhere, name), await readFile(path.join(templateLib, name)));
    }
    await writeFile(path.join(elsewhere, 'bridge-client.ts'), legacy); // a shipped old copy: would be refreshed
    await mkdir(path.join(dir, 'runtime-next'), { recursive: true });
    await symlink(elsewhere, path.join(dir, 'runtime-next', 'lib'));

    await expect(generator().generateRuntimeAppTemplate()).rejects.toThrow(/symlink/);
    expect(await readFile(path.join(elsewhere, 'bridge-client.ts'), 'utf8')).toBe(legacy);
  });

  it('refuses to create files through a folder that is a link to somewhere else', async () => {
    const elsewhere = path.join(dir, 'elsewhere-dir');
    await mkdir(elsewhere);
    await mkdir(path.join(dir, 'runtime-next'), { recursive: true });
    await symlink(elsewhere, path.join(dir, 'runtime-next', 'lib'));

    await expect(generator().generateRuntimeAppTemplate()).rejects.toThrow(/symlink/);
    await expect(stat(path.join(elsewhere, 'bridge-client.ts'))).rejects.toThrow();
  });

  it('leaves an edited managed file alone and reports it', async () => {
    await mkdir(path.dirname(bridgeClientPath()), { recursive: true });
    await writeFile(bridgeClientPath(), '// my own bridge client\nexport {};\n');

    const summary = await generator().generateRuntimeAppTemplate();

    expect(summary.needsManualUpdate).toEqual([path.join('lib', 'bridge-client.ts')]);
    expect(await readFile(bridgeClientPath(), 'utf8')).toBe('// my own bridge client\nexport {};\n');
  });

  it('says plainly that the preview is unavailable when the template is not installed (Marketplace layout)', async () => {
    const marketplace = path.join(dir, 'ext');
    await mkdir(marketplace, { recursive: true });
    await expect(generator(marketplace).generateRuntimeAppTemplate()).rejects.toBeInstanceOf(RuntimeTemplateUnavailableError);
    await expect(generator(marketplace).generateRuntimeAppTemplate()).rejects.toThrow(/Marketplace extension does not include/);
    // No half-built fallback app is left behind.
    await expect(stat(path.join(dir, 'runtime-next'))).rejects.toThrow();
  });

  it('the VSIX really leaves the runtime template out (so the message above is what a Marketplace user sees)', async () => {
    const ignore = (await readFile(path.join(extensionDir, '.vscodeignore'), 'utf8')).split(/\r?\n/);
    expect(ignore).toContain('../**');
  });

  it('writes .env.local without following a symbolic link, and refuses a link at the target', async () => {
    const gen = generator();
    await gen.generateRuntimeAppTemplate();
    const envPath = path.join(dir, 'runtime-next', '.env.local');
    const outside = path.join(dir, 'outside.txt');
    await writeFile(outside, 'untouched');
    await symlink(outside, envPath);

    await expect(gen.writeBridgeEnv('http://127.0.0.1:1/fm', 'abc')).rejects.toThrow(/symbolic link/);
    expect(await readFile(outside, 'utf8')).toBe('untouched');

    await rm(envPath);
    await gen.writeBridgeEnv('http://127.0.0.1:1/fm', 'abc');
    expect(await readFile(envPath, 'utf8')).toContain('NEXT_PUBLIC_FMWEB_BRIDGE_TOKEN=abc');
  });

  it('end to end: the generated bridge client, with the written env values, talks to the real bridge server', async () => {
    const gen = generator();
    await gen.generateRuntimeAppTemplate();

    const findRecords = vi.fn(async () => ({ data: [{ recordId: '9', fieldData: { A: 1 } }] }));
    const profile = { id: 'p', name: 'p', serverUrl: 'https://x.example.com', database: 'd', authMode: 'direct' as const };
    const server = new FmBridgeServer(
      { getActiveProfileId: () => 'p', getProfile: async () => profile },
      { findRecords, getRecord: vi.fn(), editRecord: vi.fn(), createRecord: vi.fn(), deleteRecord: vi.fn(), runScript: vi.fn() } as never,
      { isWorkspaceTrusted: () => true, readProjectConfig: async () => undefined } as never,
      logger
    );
    nock.enableNetConnect('127.0.0.1');
    const { baseUrl } = await server.ensureStarted();
    try {
      const envPath = await gen.writeBridgeEnv(baseUrl, server.getSessionToken());
      const env = Object.fromEntries(
        (await readFile(envPath, 'utf8')).trim().split('\n').map((line) => line.split(/=(.*)/s).slice(0, 2))
      ) as Record<string, string>;

      const generated = (await import(/* @vite-ignore */ pathToFileURL(bridgeClientPath()).href)) as {
        RuntimeBridgeClient: new (url?: string, fetchFn?: typeof fetch, token?: string) => {
          find(request: { layout: string; query: Array<Record<string, unknown>> }): Promise<{ data: unknown[] }>;
        };
      };
      const request = { layout: 'L', query: [{ A: '*' }] };
      // The way the generated app builds its client from NEXT_PUBLIC_* env values.
      const ok = new generated.RuntimeBridgeClient(env.NEXT_PUBLIC_FMWEB_BRIDGE_URL, undefined, env.NEXT_PUBLIC_FMWEB_BRIDGE_TOKEN);
      expect((await ok.find(request)).data).toHaveLength(1);
      await expect(new generated.RuntimeBridgeClient(env.NEXT_PUBLIC_FMWEB_BRIDGE_URL).find(request)).rejects.toThrow(
        /bridge session token/
      );
    } finally {
      await server.stop();
    }
  });
});
