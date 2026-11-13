import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
