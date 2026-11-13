import { cpSync, readFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Application, EntryPointStrategy, TSConfigReader, type Reflection } from 'typedoc';
import { expect, it } from 'vitest';

it('discovers nested API entries and excludes internal and dependency files through TypeDoc', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'typedoc-globs-')));
  try {
    for (const [file, symbol] of Object.entries({
      'public/visible.ts': 'PublicType',
      'nested/deep/visible.ts': 'NestedType',
      'nested/deep/hidden.internal.ts': 'InternalType',
      'public/node_modules/leak.ts': 'DependencyType'
    })) {
      const target = join(root, 'src', file);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, `export interface ${symbol} { value: string }\n`);
    }
    const tsconfig = join(root, 'tsconfig.json');
    writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { target: 'ES2022', types: [], strict: true }, include: ['src/**/*.ts'] }));
    const app = await Application.bootstrap({
      entryPoints: [`${root.replaceAll('\\', '/')}/src/**/*.ts`],
      entryPointStrategy: EntryPointStrategy.Expand,
      exclude: ['**/*.internal.ts'],
      tsconfig,
      readme: 'none',
      logLevel: 'Error',
      name: 'API glob regression'
    }, [new TSConfigReader()]);
    expect(app.logger.hasErrors()).toBe(false);
    const project = await app.convert();
    expect(project).toBeDefined();
    expect(app.logger.hasErrors()).toBe(false);
    const names: string[] = [];
    const collect = (reflection: Reflection) => {
      names.push(reflection.name);
      reflection.traverse(child => { collect(child); return true; });
    };
    collect(project!);
    expect(names).toContain('PublicType');
    expect(names).toContain('NestedType');
    expect(names).not.toContain('InternalType');
    expect(names).not.toContain('DependencyType');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

it('keeps nested wildcard exclusions bounded in the real TypeDoc matcher', () => {
  const script = `
    import { createRequire } from 'node:module';
    import { dirname, join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const require = createRequire(process.cwd() + '/package.json');
    const file = join(dirname(require.resolve('typedoc')), 'node-utils.js');
    const { MinimatchSet } = await import(pathToFileURL(file).href);
    const excludes = new MinimatchSet(['**/*(*(*(a|b)))']);
    if (excludes.matchesAny('src/' + 'a'.repeat(26) + 'z')) throw new Error('unexpected exclusion');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 15_000);

it('refuses an unrecognized TypeDoc dependency before changing its source', () => {
  const root = mkdtempSync(join(tmpdir(), 'typedoc-patch-refusal-'));
  try {
    mkdirSync(join(root, 'tools'), { recursive: true });
    mkdirSync(join(root, 'extension'), { recursive: true });
    mkdirSync(join(root, 'node_modules/typedoc/dist'), { recursive: true });
    writeFileSync(join(root, 'extension/package.json'), '{}');
    writeFileSync(join(root, 'node_modules/typedoc/package.json'), JSON.stringify({ name: 'typedoc', main: 'dist/index.js' }));
    writeFileSync(join(root, 'node_modules/typedoc/dist/index.js'), '');
    const target = join(root, 'node_modules/typedoc/dist/node-utils.js');
    const original = 'unrecognized fixture source';
    writeFileSync(target, original);
    cpSync(resolve(__dirname, '../../../../tools/patch-typedoc-glob.mjs'), join(root, 'tools/patch-typedoc-glob.mjs'));
    const result = spawnSync(process.execPath, [join(root, 'tools/patch-typedoc-glob.mjs')], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unknown TypeDoc source');
    expect(readFileSync(target, 'utf8')).toBe(original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
