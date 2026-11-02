import { mkdtemp, mkdir, readdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { createBlankLayout } from '@fmweb/shared';
import { loadLayoutDefinition } from './layout-loader';

const originalCwd = process.cwd();
let tempRoot: string | undefined;

afterEach(async () => {
  process.chdir(originalCwd);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

async function useTempProject(): Promise<string> {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'fmweb-layout-loader-'));
  const project = path.join(tempRoot, 'project');
  await mkdir(project);
  process.chdir(project);
  return project;
}

describe('loadLayoutDefinition', () => {
  it('loads a layout from generated/layouts and migrates it to the current schema', async () => {
    const project = await useTempProject();
    const layouts = path.join(project, 'generated', 'layouts');
    await mkdir(layouts, { recursive: true });
    // A legacy layout exercises the shared migration path used by saved runtime layouts.
    await writeFile(path.join(layouts, 'home.layout.json'), JSON.stringify({
      schemaVersion: 0,
      id: '99999999-9999-4999-8999-999999999999',
      name: ' Home ',
      objects: []
    }));

    const loaded = await loadLayoutDefinition('home');
    expect(loaded).toMatchObject({ name: 'Home', schemaVersion: 1, objects: [] });
  });

  it('sanitizes IDs before reading and returns undefined for missing or invalid JSON', async () => {
    const project = await useTempProject();
    const layouts = path.join(project, '.fmweb', 'generated', 'layouts');
    await mkdir(layouts, { recursive: true });
    await writeFile(path.join(layouts, 'a_b.layout.json'), '{bad json');
    await expect(loadLayoutDefinition('../a')).resolves.toBeUndefined();
    await expect(loadLayoutDefinition('missing')).resolves.toBeUndefined();
    const files = await readdir(layouts);
    expect(files).toEqual(['a_b.layout.json']);
  });

  it('uses the first existing layouts directory candidate', async () => {
    await useTempProject();
    const parentLayouts = path.join(tempRoot!, 'layouts');
    await mkdir(parentLayouts, { recursive: true });
    await writeFile(path.join(parentLayouts, 'exact.layout.json'), JSON.stringify(createBlankLayout('Parent candidate')));

    const loaded = await loadLayoutDefinition('exact');
    expect(loaded?.name).toBe('Parent candidate');
  });
});
