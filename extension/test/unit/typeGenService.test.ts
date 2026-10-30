import { runInNewContext } from 'vm';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
// TypeScript 7 supplies the CLI; this alias keeps the compiler API for checking generated code.
import * as ts from 'typescript6';
import { describe, expect, it, vi } from 'vitest';

import { duplicatePhotoMetadata } from '../fixtures/duplicatePhoto';
import { buildLayoutInspectorModel } from '../../src/utils/layoutInspector';
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
      const service = new TypeGenService({ getLayoutSchema: vi.fn(async () => schema) } as never,
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

    const service = new TypeGenService({ getLayoutSchema: async () => ({ supported: true, fields: [{ name: ' Age ', type: 'normal', result: 'number' }, { name: 'Photo', type: 'normal', result: 'container' }] }) } as never, {} as never, {
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
      const service = new TypeGenService({ getLayoutSchema: async () => ({ supported: true, fields: [{ name: ' Name ', type: 'text' }], metadata: {} }) } as never,
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
      const service = new TypeGenService({ getLayoutSchema: vi.fn(async () => schema) } as never, {} as never,
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
        { getLayoutSchema: vi.fn(async () => ({ supported: true, fields: [], metadata: {} })) } as never,
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
          { getLayoutSchema: vi.fn(async () => ({ supported: true, fields: [{ name: 'Name', type: 'normal', result: 'text' }], metadata: {} })) } as never,
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
      { getLayoutSchema: vi.fn(async (_profile: unknown, layout: string) => ({ supported: true, fields: [{ name: `Field of ${layout}`, type: 'normal', result: 'text' }], metadata: {} })) } as never,
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

    it('writes nothing, and overwrites nothing, when the layout list is unavailable', async () => {
      await inTempDir(async (root) => {
        const existing = await make(root, async () => ['Sales']).generateTypesForLayout(createProfile(), 'Sales');
        const before = await readFile(existing.filePath, 'utf8');
        const failing = make(root, async () => { throw new Error('layout list denied'); });

        await expect(failing.generateTypesForLayout(createProfile(), 'sales')).rejects.toThrow(/layout list denied/);
        expect(await readFile(existing.filePath, 'utf8')).toBe(before);
        expect(await readdir(dirname(existing.filePath))).toEqual([basename(existing.filePath)]);
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
        const schema = { getLayoutSchema: async () => ({ supported: true, fields: [], metadata: {} }) };
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
