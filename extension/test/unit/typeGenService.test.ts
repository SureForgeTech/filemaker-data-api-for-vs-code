import { runInNewContext } from 'vm';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
// TypeScript 7 supplies the CLI; this alias keeps the compiler API for checking generated code.
import * as ts from 'typescript6';
import { describe, expect, it, vi } from 'vitest';

import { duplicatePhotoMetadata } from '../fixtures/duplicatePhoto';
import { buildLayoutInspectorModel } from '../../src/utils/layoutInspector';
import { OfflineModeService } from '../../src/offline/offlineModeService';
import { SchemaService } from '../../src/services/schemaService';
import { TypeGenService } from '../../src/services/typeGenService';
import type { ConnectionProfile } from '../../src/types/fm';

function createProfile(): ConnectionProfile {
  return {
    id: 'profile-a',
    name: 'Dev',
    authMode: 'direct',
    serverUrl: 'https://fm.local',
    database: 'TestDB',
    username: 'admin'
  };
}

describe('TypeGenService', () => {
  it('generates unique compiling keys for duplicate Photo, repeating Phones and literal Phones(2) together', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-duplicate-types-'));
    try {
      const fields = [
        ...duplicatePhotoMetadata.fieldMetaData,
        { name: 'Phones', type: 'normal', result: 'text', maxRepeat: 3 },
        { name: 'Phones(2)', type: 'normal', result: 'text' }
      ];
      const schema = { supported: true, fromCache: false, fields, metadata: duplicatePhotoMetadata };
      const service = new TypeGenService({ isOfflineModeEnabled: () => false, getLayoutSchema: vi.fn(async () => schema) } as never,
        { listLayouts: vi.fn().mockResolvedValue(['Contact Details']) } as never, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, { getWorkspaceRoot: () => root });
      const artifact = await service.generateTypesForLayout(createProfile(), 'Contact Details');
      const client = await service.generateTypeScriptClient(createProfile(), ['Contact Details'], join(root, 'client'));
      const expected = ['Photo', 'Phones(1)', 'Phones(2)', 'Phones(3)'];
      for (const source of [artifact.content, await readFile(client.typesPath, 'utf8')]) {
        const rawKeys = [...source.matchAll(/^ {2}"([^"\n]+)"\?:/gm)].map((match) => match[1]);
        expect(rawKeys).toEqual(expected);
        expect(source).not.toContain('photo2');
      }
      const snippets = await service.generateSnippetsForLayout(createProfile(), 'Contact Details');
      for (const entry of Object.values(JSON.parse(snippets.content.replace(/^\/\/[^\n]*\n/, ''))) as Array<{ description: string }>) {
        const keys = entry.description.split(' Fields: ')[1]!.split('; ').map((field) => field.split(':')[0]);
        expect(keys).toEqual(expected);
      }
      expect(buildLayoutInspectorModel(schema).fields.map((field) => field.name)).toEqual(expected);
      const config = join(root, 'tsconfig.json');
      await writeFile(config, JSON.stringify({ compilerOptions: { noEmit: true, strict: true, types: [], skipLibCheck: true, lib: ['es2020', 'dom'] }, files: [artifact.filePath, client.typesPath, client.clientPath] }));
      expect(() => execFileSync(process.execPath, [join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc'), '-p', config], { encoding: 'utf8' })).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('generates layout type files with field maps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-typegen-'));

    const schemaService = {
      isOfflineModeEnabled: () => false,
      getLayoutSchema: vi.fn().mockResolvedValue({
        supported: true,
        fromCache: false,
        metadata: { fieldMetaData: [{ name: 'First Name', type: 'text' }] },
        fields: [
          { name: 'First Name', type: 'text' },
          { name: 'Age', type: 'normal', result: 'number' },
          { name: ' Photo ', type: 'normal', result: 'container' },
          { name: 'Birthday', type: 'normal', result: 'date' },
          { name: 'Clock', type: 'normal', result: 'time' },
          { name: 'Stamp', type: 'normal', result: 'timeStamp' },
          { name: 'Repeats', type: 'normal', result: 'number', maxRepeat: 3 },
          ...['__proto__', 'constructor', 'toString', 'hasOwnProperty'].map((name) => ({ name, type: 'normal', result: 'text' }))
        ]
      })
    };

    const fmClient = {
      listLayouts: vi.fn().mockResolvedValue(['Contacts'])
    };

    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const service = new TypeGenService(schemaService as never, fmClient as never, logger as never, {
      getOutputDir: () => 'filemaker-types',
      getWorkspaceRoot: () => root,
      isWorkspaceTrusted: () => true
    });

    const artifact = await service.generateTypesForLayout(createProfile(), 'Contacts');
    expect(artifact.filePath).toContain(join('filemaker-types', 'layouts', 'Contacts.ts'));
    expect(artifact.content).toContain('export interface ContactsFieldData');
    expect(artifact.content).toContain('ContactsFieldNameMap');

    const content = await readFile(artifact.filePath, 'utf8');
    expect(content).toContain('"firstName": "First Name"');
    expect(content).toContain('"Age"?: number;');
    expect(content).toContain('" Photo "?: string;');
    expect(content).toContain('"Repeats(3)"?: number;');
    expect(content).not.toContain('"Repeats"?:');
  });

  it('generates snippets file for a layout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-snippets-'));

    const service = new TypeGenService({ isOfflineModeEnabled: () => false, getLayoutSchema: async () => ({ supported: true, fields: [{ name: ' Age ', type: 'normal', result: 'number' }, { name: 'Photo', type: 'normal', result: 'container' }] }) } as never, {} as never, {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as never, {
      getWorkspaceRoot: () => root,
      isWorkspaceTrusted: () => true
    });

    const snippets = await service.generateSnippetsForLayout(createProfile(), 'Contacts');
    expect(snippets.filePath).toContain(join('snippets', 'filemaker-data-api.code-snippets'));
    expect(snippets.content).toContain('Contacts Find Records');
    const entries = Object.values(JSON.parse(snippets.content.replace(/^\/\/[^\n]*\n/, ''))) as Array<{ description: string }>;
    for (const entry of entries) {
      expect(entry.description).toContain(' Age : number (kind: normal)');
      expect(entry.description).toContain('Photo: container (kind: normal)');
    }
  });

  it('generated finds refuse empty criteria before fetch and the example supplies a field', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-generated-find-'));
    try {
      const service = new TypeGenService({ isOfflineModeEnabled: () => false, getLayoutSchema: async () => ({ supported: true, fields: [{ name: ' Name ', type: 'text' }], metadata: {} }) } as never,
        {} as never, { debug() {}, info() {}, warn() {}, error() {} }, { getWorkspaceRoot: () => root });
      const artifacts = await service.generateTypeScriptClient(createProfile(), ['Contacts'], root);
      const source = await readFile(artifacts.clientPath, 'utf8');
      const exports: { FileMakerDataApiClient?: new (config: unknown) => { findContacts(request: unknown): Promise<unknown> } } = {};
      runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports });
      const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>().mockResolvedValue(new Response(JSON.stringify({ response: { data: [] }, messages: [] })));
      const client = new exports.FileMakerDataApiClient!({ serverUrl: 'https://fm.local', database: 'Sales', token: 't', fetch });
      for (const query of [[], [{}], [{ omit: 'true' }], [{ ' Name ': '' }]]) {
        await expect(client.findContacts({ query })).rejects.toThrow('Enter at least one field value to search');
      }
      expect(fetch).not.toHaveBeenCalled();
      await client.findContacts({ query: [{ ' Name ': '*' }] });
      expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toMatchObject({ query: [{ ' Name ': '*' }] });
      expect(await readFile(artifacts.readmePath, 'utf8')).not.toContain('query: [{}]');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('generates a compiling TypeScript client with typed find results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-clientgen-'));

    const schemaService = {
      isOfflineModeEnabled: () => false,
      getLayoutSchema: vi.fn().mockResolvedValue({
        supported: true,
        fromCache: false,
        metadata: { fieldMetaData: [{ name: 'First Name', type: 'text' }] },
        fields: [
          { name: 'First Name', type: 'text' },
          { name: 'Age', type: 'normal', result: 'number' },
          { name: ' Photo ', type: 'normal', result: 'container' },
          { name: 'Birthday', type: 'normal', result: 'date' },
          { name: 'Clock', type: 'normal', result: 'time' },
          { name: 'Stamp', type: 'normal', result: 'timeStamp' },
          { name: 'Repeats', type: 'normal', result: 'number', maxRepeat: 3 },
          ...['__proto__', 'constructor', 'toString', 'hasOwnProperty'].map((name) => ({ name, type: 'normal', result: 'text' }))
        ]
      })
    };

    const service = new TypeGenService(schemaService as never, {} as never, {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as never, {
      getWorkspaceRoot: () => root,
      isWorkspaceTrusted: () => true
    });

    const artifacts = await service.generateTypeScriptClient(createProfile(), ['Contacts', ' Contacts', 'Contacts', '__proto__', 'constructor', 'toString', 'hasOwnProperty'], root);
    const types = await readFile(artifacts.typesPath, 'utf8');
    const client = await readFile(artifacts.clientPath, 'utf8');
    const readme = await readFile(artifacts.readmePath, 'utf8');

    expect(types).toContain('export interface ContactsFieldData');
    expect(types).toContain('"First Name"?: string;');
    expect(types).toContain('"Age"?: number;');
    for (const name of [' Photo ', 'Birthday', 'Clock', 'Stamp']) expect(types).toContain(`${JSON.stringify(name)}?: string;`);
    for (const n of [1, 2, 3]) expect(types).toContain(`"Repeats(${n})"?: number;`);
    expect(types).not.toContain('"Repeats"?:');
    expect(types).toContain('2^53');
    expect(types).toContain('locale');
    expect(types).toContain('URL');
    expect(client).toContain('public async findContacts');
    expect(client).toContain('public async createContacts');
    expect(readme).toContain('Regenerating this client overwrites these files');

    const usagePath = join(root, 'usage.ts');
    await writeFile(
      usagePath,
      `import { FileMakerDataApiClient } from './client';

const criteria: import('./types').ContactsFieldData = Object.create(null);
criteria["First Name"] = "Ada";

const fetchImpl: typeof fetch = async () =>
  new Response(JSON.stringify({ response: { data: [] }, messages: [] }));

const client = new FileMakerDataApiClient({
  serverUrl: 'https://fm.local',
  database: 'TestDB',
  token: 'token',
  fetch: fetchImpl
});

async function run(): Promise<string | undefined> {
  const records = await client.findContacts({ query: [criteria] });
  const amount: number | undefined = records[0]?.fieldData["Repeats(3)"];
  const photo: string | undefined = records[0]?.fieldData[" Photo "];
  const special: string | undefined = records[0]?.fieldData["__proto__"];
  void special;
  void amount; void photo;
  return records[0]?.fieldData["First Name"];
}

void run;
`,
      'utf8'
    );

    const program = ts.createProgram([artifacts.typesPath, artifacts.clientPath, usagePath], {
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      // TypeScript 6.0 deprecates the node10 resolver; this inline program
      // still targets it deliberately (it mirrors a consumer's classic
      // CommonJS tsconfig). Silence the deprecation so the diagnostics
      // assertion below stays focused on the generated code, not tooling.
      ignoreDeprecations: '6.0',
      lib: ['lib.es2020.d.ts', 'lib.dom.d.ts'],
      types: [],
      skipLibCheck: true
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);

    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
  }, 30_000);

  it('keeps a layout called FileMaker from redeclaring the FileMakerRecord helper in the client', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-client-reserved-'));
    try {
      const schema = { supported: true, fromCache: false, fields: [{ name: 'Name', type: 'normal', result: 'text' }], metadata: {} };
      const service = new TypeGenService({ isOfflineModeEnabled: () => false, getLayoutSchema: vi.fn(async () => schema) } as never, {} as never,
        { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never, { getWorkspaceRoot: () => root });
      const layouts = ['FileMaker', 'FileMakerLayout', 'Sales'];
      const client = await service.generateTypeScriptClient(createProfile(), layouts, join(root, 'client'));
      const types = await readFile(client.typesPath, 'utf8');
      const source = await readFile(client.clientPath, 'utf8');

      expect(types.match(/\bFileMakerRecord\b(?=<TFieldData>)/g)).toHaveLength(1);
      expect(types).toContain('export type FileMakerLayout2Record = FileMakerRecord<FileMakerLayout2FieldData>;');
      // Names that do not collide keep their usual spelling, and the API mapping keeps the raw layout names.
      expect(types).toContain('export type FileMakerLayoutRecord = FileMakerRecord<FileMakerLayoutFieldData>;');
      expect(types).toContain('export type SalesRecord = FileMakerRecord<SalesFieldData>;');
      expect(types).toContain('"FileMaker": FileMakerLayout2Record;');
      expect(types).toContain('"FileMakerLayout": FileMakerLayoutRecord;');
      expect(source).toContain('findFileMakerLayout2(');
      expect(source).toContain('encodeURIComponent("FileMaker")');

      const program = ts.createProgram([client.typesPath, client.clientPath], {
        noEmit: true, strict: true, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10, ignoreDeprecations: '6.0',
        lib: ['lib.es2020.d.ts', 'lib.dom.d.ts'], types: [], skipLibCheck: true
      });
      expect(ts.getPreEmitDiagnostics(program).map(formatDiagnostic)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('writes layouts whose names differ only by case or by sanitizing to distinct files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-case-files-'));
    try {
      const layouts = ['Sales', 'sales', 'SALES', 'Sales ', 'Orders'];
      const service = new TypeGenService(
        { isOfflineModeEnabled: () => false, getLayoutSchema: vi.fn(async () => ({ supported: true, fields: [], metadata: {} })) } as never,
        { listLayouts: vi.fn(async () => layouts) } as never,
        { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
        { getWorkspaceRoot: () => root }
      );

      const first = await service.generateTypesForAllLayouts(createProfile());
      const second = await service.generateTypesForAllLayouts(createProfile());

      expect(first.map((artifact) => artifact.layout)).toEqual(layouts);
      const names = first.map((artifact) => basename(artifact.filePath));
      expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(layouts.length);
      // Every member of a colliding set gets a hashed name; a name that does not collide keeps its usual name.
      for (const name of names.slice(0, 3)) {
        expect(name).toMatch(/^[Ss][Aa][Ll][Ee][Ss]-[0-9a-f]{8}\.ts$/);
      }
      expect(names).not.toContain('Sales.ts');
      expect(names[4]).toBe('Orders.ts');
      // The same list gives the same names, so a refresh rewrites the same files.
      expect(second.map((artifact) => artifact.filePath)).toEqual(first.map((artifact) => artifact.filePath));
      for (const artifact of first) {
        expect(await readFile(artifact.filePath, 'utf8')).toContain(` * Layout: ${artifact.layout}\n`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('gives each layout the same file and content whatever order the server lists layouts in', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-order-files-'));
    try {
      const hashOfSales = createHash('sha1').update('Sales').digest('hex').slice(0, 8);
      // `Sales-<hash>` is an explicit layout that looks like the hashed name of `Sales`; `Sales ` and `A/B`
      // sanitize to names that already carry a hash of their own.
      const layouts = ['Sales', 'sales', 'SALES', `Sales-${hashOfSales}`, 'Sales ', 'A/B', 'a_b', 'Orders'];
      const outputByOrder: Array<Map<string, { filePath: string; content: string }>> = [];
      for (const order of [layouts, [...layouts].reverse(), [layouts[3]!, layouts[1]!, layouts[7]!, layouts[0]!, layouts[5]!, layouts[2]!, layouts[6]!, layouts[4]!]]) {
        const service = new TypeGenService(
          { isOfflineModeEnabled: () => false, getLayoutSchema: vi.fn(async () => ({ supported: true, fields: [{ name: 'Name', type: 'normal', result: 'text' }], metadata: {} })) } as never,
          { listLayouts: vi.fn(async () => order) } as never,
          { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
          { getWorkspaceRoot: () => root }
        );
        const artifacts = await service.generateTypesForAllLayouts(createProfile());
        expect(artifacts.map((artifact) => artifact.layout)).toEqual(order);
        outputByOrder.push(new Map(await Promise.all(artifacts.map(async (artifact) =>
          [artifact.layout, { filePath: artifact.filePath, content: (await readFile(artifact.filePath, 'utf8')).replace(/^ \* Generated at: .*$/m, '') }] as const))));
      }

      const [forward, ...others] = outputByOrder;
      for (const other of others) {
        for (const layout of layouts) {
          expect(other.get(layout)).toEqual(forward!.get(layout));
          expect(other.get(layout)!.content).toContain(` * Layout: ${layout}\n`);
        }
      }

      const paths = layouts.map((layout) => forward!.get(layout)!.filePath);
      expect(new Set(paths.map((path) => path.toLowerCase())).size).toBe(layouts.length);
      // No member of the case-colliding set owns the bare name, and the explicit hashed-looking layout does not
      // take `Sales`'s hashed name (the earlier raw name keeps it).
      expect(paths.map((path) => basename(path))).not.toContain('Sales.ts');
      expect(basename(forward!.get('Sales')!.filePath)).toBe(`Sales-${hashOfSales}.ts`);
      expect(basename(forward!.get(`Sales-${hashOfSales}`)!.filePath)).toBe(`Sales-${hashOfSales}-1.ts`);
      expect(basename(forward!.get('Orders')!.filePath)).toBe('Orders.ts');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  describe('single-layout generation uses the same collision-safe file names', () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    const make = (root: string, listLayouts: () => Promise<string[]>) => new TypeGenService(
      { isOfflineModeEnabled: () => false, getLayoutSchema: vi.fn(async (_profile: unknown, layout: string) => ({ supported: true, fields: [{ name: `Field of ${layout}`, type: 'normal', result: 'text' }], metadata: {} })) } as never,
      { listLayouts: vi.fn(listLayouts) } as never,
      logger,
      { getWorkspaceRoot: () => root }
    );
    const inTempDir = async (run: (root: string) => Promise<void>) => {
      const root = await mkdtemp(join(tmpdir(), 'fm-single-files-'));
      try {
        await run(root);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    };

    it('keeps `Sales` and `sales` generated one at a time in separate files with their own contents', async () => {
      await inTempDir(async (root) => {
        const service = make(root, async () => ['Sales', 'sales']);
        const upper = await service.generateTypesForLayout(createProfile(), 'Sales');
        const lower = await service.generateTypesForLayout(createProfile(), 'sales');

        expect(upper.filePath.toLowerCase()).not.toBe(lower.filePath.toLowerCase());
        expect(await readFile(upper.filePath, 'utf8')).toContain(' * Layout: Sales\n');
        expect(await readFile(lower.filePath, 'utf8')).toContain(' * Layout: sales\n');
        expect(await readFile(upper.filePath, 'utf8')).toContain('Field of Sales');
        expect(await readFile(lower.filePath, 'utf8')).toContain('Field of sales');
      });
    });

    it('uses the same paths whether layouts are generated one at a time or all together', async () => {
      await inTempDir(async (root) => {
        const layouts = ['Sales', 'sales', 'Orders'];
        const service = make(root, async () => layouts);
        const single = [await service.generateTypesForLayout(createProfile(), 'sales'), await service.generateTypesForLayout(createProfile(), 'Orders')];
        const batch = await service.generateTypesForAllLayouts(createProfile());

        expect(single[0]!.filePath).toBe(batch[1]!.filePath);
        expect(single[1]!.filePath).toBe(batch[2]!.filePath);
        expect(basename(single[1]!.filePath)).toBe('Orders.ts');
      });
    });

    it('gives the same path whatever order the server lists layouts in', async () => {
      await inTempDir(async (root) => {
        const forward = await make(root, async () => ['Sales', 'sales', 'SALES']).generateTypesForLayout(createProfile(), 'sales');
        const reversed = await make(root, async () => ['SALES', 'sales', 'Sales']).generateTypesForLayout(createProfile(), 'sales');
        expect(reversed.filePath).toBe(forward.filePath);
      });
    });

    it('keeps the plain file name when the layout collides with nothing', async () => {
      await inTempDir(async (root) => {
        const result = await make(root, async () => ['Contacts', 'Orders']).generateTypesForLayout(createProfile(), 'Contacts');
        expect(basename(result.filePath)).toBe('Contacts.ts');
      });
    });

    it('counts the selected layout even when the server list leaves it out', async () => {
      await inTempDir(async (root) => {
        const result = await make(root, async () => ['Sales']).generateTypesForLayout(createProfile(), 'sales');
        const other = await make(root, async () => ['Sales']).generateTypesForLayout(createProfile(), 'Sales');
        expect(result.filePath.toLowerCase()).not.toBe(other.filePath.toLowerCase());
        expect(await readFile(result.filePath, 'utf8')).toContain(' * Layout: sales\n');
      });
    });

    it('names the file from the files on disk, and overwrites nothing, when the layout list is unavailable', async () => {
      await inTempDir(async (root) => {
        const existing = await make(root, async () => ['Sales']).generateTypesForLayout(createProfile(), 'Sales');
        const before = await readFile(existing.filePath, 'utf8');
        const failing = make(root, async () => { throw new Error('layout list denied'); });

        const lower = await failing.generateTypesForLayout(createProfile(), 'sales');
        expect(lower.filePath.toLowerCase()).not.toBe(existing.filePath.toLowerCase());
        expect(await readFile(existing.filePath, 'utf8')).toBe(before);
        expect(await readFile(lower.filePath, 'utf8')).toContain(' * Layout: sales\n');
        expect((await readdir(dirname(existing.filePath))).length).toBe(2);
      });
    });
  });

  describe('single-layout generation with the real schema and offline services', () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const header = (layout: string, identity = '') => `/**\n * Generated by FileMaker Data API Tools.\n * AUTO-GENERATED FILE. DO NOT EDIT.\n${identity} * Generated at: 2020-01-01T00:00:00.000Z\n * Profile: Dev (profile-a)\n * Layout: ${layout}\n * Metadata hash (sha256): 0\n */\n\nexport interface Old {}\n`;
    const shortHash = (layout: string) => createHash('sha1').update(layout).digest('hex').slice(0, 8);
    const sha256Of = (layout: string) => createHash('sha256').update(JSON.stringify(layout), 'utf8').digest('hex');

    async function setup(root: string) {
      const state = { offline: false, metadata: true, layouts: ['Sales', 'sales'] as string[] | Error };
      const fm = {
        getLayoutMetadata: vi.fn(async (_profile: unknown, layout: string) => {
          if (state.offline) throw new Error('network down');
          return { fieldMetaData: [{ name: `Field of ${layout}`, type: 'normal', result: 'text' }] };
        }),
        listLayouts: vi.fn(async () => {
          if (state.layouts instanceof Error) throw state.layouts;
          return state.layouts;
        })
      };
      const offlineModeService = new OfflineModeService({ warn: vi.fn() }, {
        getWorkspaceRoot: () => root,
        isWorkspaceTrusted: () => true,
        getConfiguration: () => ({ get: (key: string, fallback: unknown) => (key === 'offline.mode' ? state.offline : fallback) }) as never
      });
      const schemaService = new SchemaService(fm as never, logger, {
        offlineModeService,
        isMetadataEnabled: () => state.metadata,
        getCacheTtlMs: () => 0
      });
      const service = new TypeGenService(schemaService, fm as never, logger, { getWorkspaceRoot: () => root });
      const layoutsDir = join(root, 'filemaker-types', 'layouts');
      return { state, fm, service, layoutsDir };
    }
    const inTempDir = async (run: (root: string) => Promise<void>) => {
      const root = await mkdtemp(join(tmpdir(), 'fm-real-services-'));
      try {
        await run(root);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    };

    it('generates from the cached schema while offline, even though the layout list cannot be read', async () => {
      await inTempDir(async (root) => {
        const { state, service } = await setup(root);
        const online = await service.generateTypesForLayout(createProfile(), 'Orders');
        state.offline = true;
        state.layouts = new Error('network down');

        const offline = await service.generateTypesForLayout(createProfile(), 'Orders');

        expect(offline.filePath).toBe(online.filePath);
        expect(await readFile(offline.filePath, 'utf8')).toContain('Field of Orders');
      });
    });

    it('refuses with the setting message before asking for the layout list when metadata is disabled', async () => {
      await inTempDir(async (root) => {
        const { state, fm, service, layoutsDir } = await setup(root);
        state.metadata = false;

        await expect(service.generateTypesForLayout(createProfile(), 'Sales')).rejects.toThrow(/filemaker\.schema\.metadataEnabled/);

        expect(fm.listLayouts).not.toHaveBeenCalled();
        await expect(readdir(layoutsDir)).rejects.toThrow(/ENOENT/);
      });
    });

    it('refuses with the offline message, without a layout list, when nothing is cached', async () => {
      await inTempDir(async (root) => {
        const { state, fm, service } = await setup(root);
        state.offline = true;
        await expect(service.generateTypesForLayout(createProfile(), 'Sales')).rejects.toThrow(/no cached metadata/);
        expect(fm.listLayouts).not.toHaveBeenCalled();
      });
    });

    it('does not ask for the layout list or the server schema while offline, and still updates the same file', async () => {
      await inTempDir(async (root) => {
        const { state, fm, service, layoutsDir } = await setup(root);
        const online = await service.generateTypesForLayout(createProfile(), 'Sales');
        expect(basename(online.filePath)).toBe(`Sales-${shortHash('Sales')}.ts`);
        await writeFile(online.filePath, header('Sales', ` * Layout SHA-256: ${sha256Of('Sales')}\n`), 'utf8');
        state.offline = true;
        fm.listLayouts.mockClear();
        fm.getLayoutMetadata.mockClear();

        const offline = await service.generateTypesForLayout(createProfile(), 'Sales');

        expect(fm.listLayouts).not.toHaveBeenCalled();
        expect(fm.getLayoutMetadata).not.toHaveBeenCalled();
        expect(offline.filePath).toBe(online.filePath);
        expect(await readFile(offline.filePath, 'utf8')).toContain('Field of Sales');
        expect(await readdir(layoutsDir)).toHaveLength(1);
      });
    });

    it('still asks for the layout list while online', async () => {
      await inTempDir(async (root) => {
        const { fm, service } = await setup(root);
        await service.generateTypesForLayout(createProfile(), 'Sales');
        expect(fm.listLayouts).toHaveBeenCalledTimes(1);
      });
    });

    it('updates the numbered file a batch gave a lookalike layout, with no list, in the same place', async () => {
      await inTempDir(async (root) => {
        const { state, fm, service, layoutsDir } = await setup(root);
        const lookalike = `Sales-${shortHash('Sales')}`;
        state.layouts = ['Sales', 'sales', lookalike, 'SALES'];
        const batch = await service.generateTypesForAllLayouts(createProfile());
        const batchPath = batch.find((artifact) => artifact.layout === lookalike)!.filePath;
        expect(basename(batchPath)).toBe(`${lookalike}-1.ts`);
        const before = await readdir(layoutsDir);
        expect(before).toHaveLength(4);
        await writeFile(batchPath, header(lookalike, ` * Layout SHA-256: ${sha256Of(lookalike)}\n`), 'utf8');

        state.layouts = new Error('network down');
        const online = await service.generateTypesForLayout(createProfile(), lookalike);
        expect(online.filePath).toBe(batchPath);

        await writeFile(batchPath, header(lookalike, ` * Layout SHA-256: ${sha256Of(lookalike)}\n`), 'utf8');
        state.offline = true;
        state.layouts = [];
        fm.listLayouts.mockClear();
        const offline = await service.generateTypesForLayout(createProfile(), lookalike);

        expect(fm.listLayouts).not.toHaveBeenCalled();
        expect(offline.filePath).toBe(batchPath);
        expect(await readFile(batchPath, 'utf8')).toContain(`Field of ${lookalike}`);
        expect(await readFile(batchPath, 'utf8')).not.toContain('interface Old');
        expect((await readdir(layoutsDir)).sort()).toEqual(before.sort());
      });
    });

    it('reuses the numbered file its layout owns past gaps, and leaves the other numbered files alone', async () => {
      await inTempDir(async (root) => {
        const { state, fm, service, layoutsDir } = await setup(root);
        const layout = `Sales-${shortHash('Sales')}`;
        state.layouts = [layout];
        const primed = await service.generateTypesForLayout(createProfile(), layout);
        const foreign = '// written by hand\nexport const mine = 1;\n';
        const otherOwner = header('Sales', ` * Layout SHA-256: ${sha256Of('Sales')}\n`);
        await writeFile(primed.filePath, otherOwner, 'utf8');
        await writeFile(join(layoutsDir, `${layout}-1.ts`), foreign, 'utf8');
        await writeFile(join(layoutsDir, `${layout}-01.ts`), foreign, 'utf8');
        await writeFile(join(layoutsDir, `${layout}-3.ts`), header(layout, ` * Layout SHA-256: ${sha256Of(layout)}\n`), 'utf8');
        state.offline = true;
        fm.listLayouts.mockClear();

        const result = await service.generateTypesForLayout(createProfile(), layout);

        expect(fm.listLayouts).not.toHaveBeenCalled();
        expect(basename(result.filePath)).toBe(`${layout}-3.ts`);
        expect(await readFile(result.filePath, 'utf8')).toContain(`Field of ${layout}`);
        expect(await readFile(primed.filePath, 'utf8')).toBe(otherOwner);
        expect(await readFile(join(layoutsDir, `${layout}-1.ts`), 'utf8')).toBe(foreign);
        expect(await readdir(layoutsDir)).toHaveLength(4);
      });
    });

    it('keeps `Sales` and `sales` apart, one after the other, with no layout list, in either order and when repeated', async () => {
      for (const order of [['Sales', 'sales'], ['sales', 'Sales']]) {
        await inTempDir(async (root) => {
          const { state, service, layoutsDir } = await setup(root);
          for (const layout of order) await service.generateTypesForLayout(createProfile(), layout);
          state.offline = true;
          state.layouts = new Error('network down');

          const first = await service.generateTypesForLayout(createProfile(), order[0]!);
          const second = await service.generateTypesForLayout(createProfile(), order[1]!);
          const again = await service.generateTypesForLayout(createProfile(), order[0]!);

          expect(first.filePath.toLowerCase()).not.toBe(second.filePath.toLowerCase());
          expect(again.filePath).toBe(first.filePath);
          expect(await readFile(first.filePath, 'utf8')).toContain(` * Layout: ${order[0]}\n`);
          expect(await readFile(second.filePath, 'utf8')).toContain(` * Layout: ${order[1]}\n`);
          expect(await readdir(layoutsDir)).toHaveLength(2);
        });
      }
    });

    it('writes a safe identity line that names the raw layout without printing it', async () => {
      await inTempDir(async (root) => {
        const { service } = await setup(root);
        const hostile = 'A */ \n export const x = 1; //';
        const result = await service.generateTypesForLayout(createProfile(), hostile);
        const text = await readFile(result.filePath, 'utf8');
        const lines = text.split('\n');
        expect(lines[3]).toBe(` * Layout SHA-256: ${createHash('sha256').update(JSON.stringify(hostile), 'utf8').digest('hex')}`);
        const headerLines = lines.slice(0, lines.indexOf(' */'));
        expect(headerLines.every((line, index) => index === 0 ? line === '/**' : line.startsWith(' * '))).toBe(true);
        expect(headerLines.filter((line) => line.startsWith(' * Layout SHA-256: '))).toHaveLength(1);
        expect(lines.some((line) => line.startsWith('export const x'))).toBe(false);
      });
    });

    it('leaves a generated file for another layout alone when the layout list is stale or incomplete', async () => {
      await inTempDir(async (root) => {
        const { state, service, layoutsDir } = await setup(root);
        await mkdir(layoutsDir, { recursive: true });
        const legacy = join(layoutsDir, 'Sales.ts');
        await writeFile(legacy, header('sales'), 'utf8');
        state.layouts = ['Sales'];

        const result = await service.generateTypesForLayout(createProfile(), 'Sales');

        expect(result.filePath).not.toBe(legacy);
        expect(basename(result.filePath)).toBe(`Sales-${shortHash('Sales')}.ts`);
        expect(await readFile(legacy, 'utf8')).toBe(header('sales'));
        expect(await readFile(result.filePath, 'utf8')).toContain('Field of Sales');
      });
    });

    it('leaves a generated file alone when its header cannot prove which layout it belongs to', async () => {
      await inTempDir(async (root) => {
        const { state, service, layoutsDir } = await setup(root);
        const layout = 'Q "1"';
        state.layouts = [layout];
        const first = await service.generateTypesForLayout(createProfile(), layout);
        const ambiguous = header('Q \\"1\\"');
        await writeFile(first.filePath, ambiguous, 'utf8');

        const second = await service.generateTypesForLayout(createProfile(), layout);

        expect(second.filePath).not.toBe(first.filePath);
        expect(await readFile(first.filePath, 'utf8')).toBe(ambiguous);
        expect(await readdir(layoutsDir)).toHaveLength(2);
      });
    });

    it('preserves every writer-recognised generated marker form that cannot prove ownership, and writes elsewhere', async () => {
      const marker = 'Generated by FileMaker Data API Tools.';
      const forms = [
        `// ${marker}\nexport const otherLayout = true;\n`,
        `<!-- ${marker} -->\n<p>other</p>\n`,
        `{\n  "$comment": "${marker}",\n  "other": true\n}\n`
      ];
      for (const original of forms) {
        await inTempDir(async (root) => {
          const { state, service, layoutsDir } = await setup(root);
          state.layouts = ['Sales'];
          await mkdir(layoutsDir, { recursive: true });
          const existing = join(layoutsDir, 'Sales.ts');
          await writeFile(existing, original, 'utf8');

          const result = await service.generateTypesForLayout(createProfile(), 'Sales');

          expect(result.filePath).not.toBe(existing);
          expect(basename(result.filePath)).toBe(`Sales-${shortHash('Sales')}.ts`);
          expect(await readFile(existing, 'utf8')).toBe(original);
          expect(await readFile(result.filePath, 'utf8')).toContain('Field of Sales');
        });
      }
    });

    it('keeps layouts whose raw names differ only by lone surrogates in separate files with separate owners', async () => {
      const first = '\uD800';
      const second = '\uD801';
      await inTempDir(async (root) => {
        const { state, service, layoutsDir } = await setup(root);
        state.layouts = [first, second];

        const batch = await service.generateTypesForAllLayouts(createProfile());
        expect(batch).toHaveLength(2);
        expect(new Set(batch.map((artifact) => artifact.filePath.toLowerCase())).size).toBe(2);
        expect(await readdir(layoutsDir)).toHaveLength(2);

        const pathOf = (layout: string) => batch.find((artifact) => artifact.layout === layout)!.filePath;
        const identity = (text: string) => text.split('\n').find((line) => line.startsWith(' * Layout SHA-256: '));
        expect(identity(await readFile(pathOf(first), 'utf8'))).not.toBe(identity(await readFile(pathOf(second), 'utf8')));

        const alone = await service.generateTypesForLayout(createProfile(), second);
        expect(alone.filePath).toBe(pathOf(second));
        const again = await service.generateTypesForLayout(createProfile(), first);
        expect(again.filePath).toBe(pathOf(first));
        for (const layout of [first, second]) {
          const text = await readFile(pathOf(layout), 'utf8');
          const escaped = (name: string) => `Field of ${JSON.stringify(name).slice(1, -1)}`;
          expect(text).toContain(escaped(layout));
          expect(text).not.toContain(escaped(layout === first ? second : first));
        }

        state.layouts = new Error('network down');
        const offline = await service.generateTypesForLayout(createProfile(), second);
        expect(offline.filePath).toBe(pathOf(second));
        expect(await readdir(layoutsDir)).toHaveLength(2);
      });
    });

    it('keeps updating the file this layout already owns, found by its identity line or an unambiguous older header', async () => {
      await inTempDir(async (root) => {
        const { state, service, layoutsDir } = await setup(root);
        state.layouts = ['Sales'];
        const first = await service.generateTypesForLayout(createProfile(), 'Sales');
        state.layouts = ['Sales', 'sales'];
        const second = await service.generateTypesForLayout(createProfile(), 'Sales');
        expect(second.filePath).toBe(first.filePath);
        expect(basename(first.filePath)).toBe('Sales.ts');

        const legacy = join(layoutsDir, 'Contacts.ts');
        await writeFile(legacy, header('Contacts'), 'utf8');
        state.layouts = ['Contacts'];
        const refreshed = await service.generateTypesForLayout(createProfile(), 'Contacts');
        expect(refreshed.filePath).toBe(legacy);
        expect(await readFile(legacy, 'utf8')).toContain('Field of Contacts');
        expect(await readFile(legacy, 'utf8')).toContain(' * Layout SHA-256: ');
      });
    });

    it('never replaces or follows a link where a file would go', async () => {
      await inTempDir(async (root) => {
        const { service, layoutsDir } = await setup(root);
        await mkdir(layoutsDir, { recursive: true });
        const outside = join(root, 'outside.ts');
        await writeFile(outside, 'keep me', 'utf8');
        await symlink(outside, join(layoutsDir, 'Sales.ts'));

        await expect(service.generateTypesForLayout(createProfile(), 'Sales')).rejects.toThrow(/not a regular file/);
        expect(await readFile(outside, 'utf8')).toBe('keep me');
      });
    });

    it('does not hide a refusal to write as an optional layout list failure', async () => {
      await inTempDir(async (root) => {
        const { state, service, layoutsDir } = await setup(root);
        state.layouts = new Error('network down');
        await mkdir(join(root, 'elsewhere'));
        await mkdir(join(root, 'filemaker-types'));
        await symlink(join(root, 'elsewhere'), layoutsDir);

        await expect(service.generateTypesForLayout(createProfile(), 'Sales')).rejects.toThrow(/symlink/);
        expect(await readdir(join(root, 'elsewhere'))).toEqual([]);
      });
    });

    it('gives each layout one path whether generated alone or in a batch, whatever order the list is in, including hash-lookalike names', async () => {
      const lookalike = `Sales-${shortHash('Sales')}`;
      const layouts = ['Sales', 'sales', lookalike, 'SALES'];
      const results: Array<Map<string, string>> = [];
      for (const list of [layouts, [...layouts].reverse()]) {
        for (const mode of ['single', 'batch']) {
          await inTempDir(async (root) => {
            const { state, service } = await setup(root);
            state.layouts = list;
            const paths = new Map<string, string>();
            if (mode === 'batch') {
              for (const artifact of await service.generateTypesForAllLayouts(createProfile())) paths.set(artifact.layout, artifact.filePath);
            } else {
              for (const layout of [...layouts].reverse()) {
                paths.set(layout, (await service.generateTypesForLayout(createProfile(), layout)).filePath);
              }
            }
            expect(new Set([...paths.values()].map((path) => path.toLowerCase())).size).toBe(layouts.length);
            for (const [layout, path] of paths) expect(await readFile(path, 'utf8')).toContain(`Field of ${layout}`);
            results.push(new Map([...paths].map(([layout, path]) => [layout, basename(path)])));
          });
        }
      }
      for (const result of results) expect([...result].sort()).toEqual([...results[0]!].sort());
    });

    it('does not let a mixed batch and single run replace another layout\'s file when the list is stale', async () => {
      await inTempDir(async (root) => {
        const { state, service } = await setup(root);
        state.layouts = ['Sales', 'sales'];
        const batch = await service.generateTypesForAllLayouts(createProfile());
        state.layouts = ['Sales'];
        const upper = await service.generateTypesForLayout(createProfile(), 'Sales');
        state.layouts = new Error('network down');
        const lower = await service.generateTypesForLayout(createProfile(), 'sales');

        expect(upper.filePath).toBe(batch.find((artifact) => artifact.layout === 'Sales')!.filePath);
        expect(lower.filePath).toBe(batch.find((artifact) => artifact.layout === 'sales')!.filePath);
        expect(await readFile(upper.filePath, 'utf8')).toContain(' * Layout: Sales\n');
        expect(await readFile(lower.filePath, 'utf8')).toContain(' * Layout: sales\n');
      });
    });
  });
});

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (!diagnostic.file || diagnostic.start === undefined) {
    return message;
  }

  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1} ${message}`;
}

  it('uses the default output folder for invisible selectors and keeps visible emoji folders exact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-typegen-folder-'));
    try {
      for (const [configured, expected] of [['out/\uFE0F', 'filemaker-types'], ['out/☀️', 'out/☀️']]) {
        const schema = { isOfflineModeEnabled: () => false, getLayoutSchema: async () => ({ supported: true, fields: [], metadata: {} }) };
        const service = new TypeGenService(schema as never, { listLayouts: async () => ['Contacts'] } as never,
          { debug() {}, info() {}, warn() {}, error() {} } as never,
          { getOutputDir: () => configured!, getWorkspaceRoot: () => root, isWorkspaceTrusted: () => true });
        const result = await service.generateTypesForLayout(createProfile(), 'Contacts');
        expect(result.filePath).toBe(join(root, expected!, 'layouts', 'Contacts.ts'));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


describe('offline numeric catalog filename boundary', () => {
  it('reuses an existing catalog suffix beyond the fallback allocation limit while offline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-numeric-boundary-'));
    let offline = false;
    const hash = createHash('sha1').update('Sales').digest('hex').slice(0, 8);
    const selected = 'sales-' + hash;
    const layouts = ['Sales', 'sales', selected,
      ...Array.from({ length: 1000 }, (_, index) => 'SALES-' + hash + '-' + (index + 1))];
    const listLayouts = vi.fn(async () => layouts);
    const service = new TypeGenService({
      isOfflineModeEnabled: () => offline,
      getLayoutSchema: async (_profile: ConnectionProfile, layout: string) => ({
        supported: !layout.startsWith('SALES-'),
        fields: [{ name: offline ? 'OfflineValue' : 'OnlineValue', type: 'text' }],
        metadata: { offline }
      })
    } as never, { listLayouts } as never,
    { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    { getWorkspaceRoot: () => root, getOutputDir: () => 'filemaker-types', isWorkspaceTrusted: () => true });
    try {
      const batch = await service.generateTypesForAllLayouts(createProfile());
      // The catalog reserves 1,000 natural names, but only these three layouts return metadata.
      expect(batch).toHaveLength(3);
      const original = batch.find((artifact) => artifact.layout === selected)!;
      expect(basename(original.filePath)).toBe(selected + '-1001.ts');
      expect(listLayouts).toHaveBeenCalledTimes(1);
      listLayouts.mockClear();
      offline = true;
      const refreshed = await service.generateTypesForLayout(createProfile(), selected);
      expect(listLayouts).not.toHaveBeenCalled();
      expect(refreshed.filePath).toBe(original.filePath);
      expect(await readFile(original.filePath, 'utf8')).toContain('OfflineValue');
      expect(await readdir(dirname(original.filePath))).toHaveLength(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
