import { mkdtemp, readFile, readdir } from 'fs/promises';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { FMClient } from '../../src/services/fmClient';
import { SecretStore } from '../../src/services/secretStore';
import { executeSavedQueryAgainstClient } from '../../src/services/savedQueryRunner';
import { TypeGenService } from '../../src/services/typeGenService';
import type { ConnectionProfile, SavedQuery } from '../../src/types/fm';
import { executeBehaviorBinding } from '../../src/webviews/layoutMode/behaviorExecution';
import { ScriptRunnerPanel } from '../../src/webviews/scriptRunner';
import { makeHarness } from './ai/harness';
import { InMemoryMemento, InMemorySecretStorage } from './mocks';

/**
 * Two layouts `Sales` and ` Sales` (a leading space) both exist. The Data API addresses a layout by its exact
 * name, so picking ` Sales` must never be turned into `Sales`: a container upload, a script run, a find or a
 * generated file would otherwise go to the wrong layout (a write to the record with the same id in `Sales`).
 */
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

describe('layout (and script and field) names are used exactly, ` Sales` is not `Sales`', () => {
  const servers: Server[] = [];
  beforeAll(() => nock.restore());
  afterAll(() => {
    nock.activate();
    nock.disableNetConnect();
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });

  async function serve() {
    const paths: string[] = [];
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        paths.push(`${request.method} ${request.url}`);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ response: { data: [], scriptError: '0', modId: '1', recordId: '7' }, messages: [{ code: '0', message: 'OK' }] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    await secrets.setPassword('p1', 'pw');
    await secrets.setSessionToken('p1', 'tok');
    const profile: ConnectionProfile = { id: 'p1', name: 'T', authMode: 'direct', serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, database: 'Db', username: 'u' };
    return { fm: new FMClient(secrets, logger, 3000), profile, paths };
  }
  const forLayout = (paths: string[]) => paths.filter((line) => /\/layouts\//.test(line));
  const wrongLayout = (paths: string[]) => paths.filter((line) => /\/layouts\/Sales[/?]/.test(line));

  it('a container upload to ` Sales` goes to ` Sales`, in the exact field ` Photo`, never to `Sales`', async () => {
    const { fm, profile, paths } = await serve();
    await fm.uploadContainer(profile, ' Sales', '7', ' Photo', { fileName: 'a.png', content: Buffer.from('x'), contentType: 'image/png' });
    const sent = forLayout(paths);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^POST \/fmi\/data\/vLatest\/databases\/Db\/layouts\/%20Sales\/records\/7\/containers\/%20Photo\/1$/);
    expect(wrongLayout(paths)).toEqual([]);
  });

  it('a blank layout or field is still refused', async () => {
    const { fm, profile, paths } = await serve();
    await expect(fm.uploadContainer(profile, '   ', '7', 'Photo', { fileName: 'a.png', content: Buffer.from('x') })).rejects.toThrow(/Layout is required/);
    await expect(fm.uploadContainer(profile, 'Sales', '7', '  ', { fileName: 'a.png', content: Buffer.from('x') })).rejects.toThrow(/field name is required/);
    expect(forLayout(paths)).toEqual([]);
  });

  it('reads, finds and edits use the exact name too', async () => {
    const { fm, profile, paths } = await serve();
    await fm.getRecord(profile, ' Sales', '7').catch(() => undefined);
    await fm.findRecords(profile, ' Sales', { query: [{ Name: '*' }] });
    await fm.editRecord(profile, ' Sales', '7', { A: '1' }).catch(() => undefined);
    expect(forLayout(paths).every((line) => /\/layouts\/%20Sales\//.test(line))).toBe(true);
    expect(forLayout(paths).length).toBeGreaterThanOrEqual(3);
    expect(wrongLayout(paths)).toEqual([]);
  });

  describe('running a script', () => {
    const request = { layout: ' Sales', scriptName: ' Echo', scriptParam: ' x ' };

    it('FMClient: every request carries the exact layout and script name', async () => {
      const { fm, profile, paths } = await serve();
      await fm.runScript(profile, request);
      const sent = forLayout(paths);
      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent.every((line) => /\/layouts\/%20Sales\//.test(line))).toBe(true);
      expect(sent[0]).toContain('/script/%20Echo');
      expect(wrongLayout(paths)).toEqual([]);
    });

    it('Script Runner: the panel does not trim the layout, the script name or the parameter', async () => {
      let onMessage: ((message: unknown) => void) | undefined;
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
        webview: { html: '', cspSource: 'x', asWebviewUri: (u: unknown) => u, postMessage: vi.fn(async () => true), onDidReceiveMessage: (cb: (m: unknown) => void) => ((onMessage = cb), { dispose: vi.fn() }) },
        onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
        reveal: vi.fn(),
        dispose: vi.fn()
      } as never);
      (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
      (ScriptRunnerPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
      const { fm, profile, paths } = await serve();
      ScriptRunnerPanel.createOrShow(
        { extensionUri: { fsPath: '/ext' }, workspaceState: new InMemoryMemento() } as never,
        { listProfiles: async () => [profile], getProfile: async () => profile, getActiveProfileId: () => 'p1' } as never,
        { listLayouts: async () => [' Sales', 'Sales'], listScripts: async () => [], runScript: (p: ConnectionProfile, r: never) => fm.runScript(p, r) } as never,
        logger
      );
      onMessage?.({ type: 'runScript', payload: { profileId: 'p1', layout: ' Sales', scriptName: ' Echo', scriptParam: ' x ' } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const sent = forLayout(paths);
      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent.every((line) => /\/layouts\/%20Sales\//.test(line))).toBe(true);
      expect(sent[0]).toContain('/script/%20Echo');
      expect(wrongLayout(paths)).toEqual([]);
    });

    it('the AI tool fm_run_script passes the exact names (the script allowlist and the request agree)', async () => {
      const h = makeHarness({ settings: { scriptAllowlist: { p1: [' Echo'] } } });
      const { fm, profile, paths } = await serve();
      h.client.listScripts.mockResolvedValue([' Echo']);
      h.client.listLayouts.mockResolvedValue(['Sales', ' Sales']);
      h.client.runScript.mockImplementation(async (_p: unknown, r: never) => fm.runScript(profile, r));
      h.confirm.mockResolvedValue(true);
      h.state.now += 120_000;
      await h.service.invoke('fm_run_script', { layout: ' Sales', script: ' Echo', parameter: 'p' });
      const sent = forLayout(paths);
      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent.every((line) => /\/layouts\/%20Sales\//.test(line))).toBe(true);
      expect(sent[0]).toContain('/script/%20Echo');
    });

    it('Layout Mode script binding', async () => {
      const { fm, profile, paths } = await serve();
      await executeBehaviorBinding({
        behavior: { type: 'runScript', scriptName: ' Echo', parameter: ' p ' },
        objectName: 'B',
        layoutName: ' Sales',
        fmLayoutName: ' Sales',
        profile,
        runScript: (p, r) => fm.runScript(p, r)
      });
      expect(forLayout(paths).every((line) => /\/layouts\/%20Sales\//.test(line))).toBe(true);
      expect(forLayout(paths)[0]).toContain('/script/%20Echo');
    });
  });

  it('a saved query on ` Sales` runs against ` Sales`', async () => {
    const { fm, profile, paths } = await serve();
    const query = { id: 'q', name: 'q', profileId: 'p1', database: 'Db', layout: ' Sales', findJson: [{ A: '1' }], createdAt: 'x', updatedAt: 'x' } as SavedQuery;
    await executeSavedQueryAgainstClient(query, profile, fm);
    expect(forLayout(paths)).toEqual(['POST /fmi/data/vLatest/databases/Db/layouts/%20Sales/_find']);
  });

  describe('type generation keeps ` Sales` and `Sales` apart', () => {
    const fields = [{ name: 'Name', type: 'text' }];
    const make = async () => {
      const root = await mkdtemp(join(tmpdir(), 'fm-exact-'));
      const getLayoutSchema = vi.fn().mockResolvedValue({ supported: true, fromCache: false, metadata: { fieldMetaData: fields }, fields });
      const service = new TypeGenService({ isOfflineModeEnabled: () => false, getLayoutSchema } as never, { listLayouts: vi.fn().mockResolvedValue(['Sales', ' Sales']) } as never, logger, {
        getOutputDir: () => 'types',
        getWorkspaceRoot: () => root,
        isWorkspaceTrusted: () => true
      });
      return { root, service, getLayoutSchema };
    };
    const profile: ConnectionProfile = { id: 'p1', name: 'T', authMode: 'direct', serverUrl: 'https://fm.local', database: 'Db', username: 'u' };

    it('the client generator lists both, asks for each by its exact name, and gives them different identifiers', async () => {
      const { root, service, getLayoutSchema } = await make();
      const out = join(root, 'client');
      const result = await service.generateTypeScriptClient(profile, ['Sales', ' Sales', ' Sales'], out);
      expect(result.layouts).toEqual(['Sales', ' Sales']); // an identical name once, nothing trimmed
      expect(getLayoutSchema.mock.calls.map((call) => call[1])).toEqual(['Sales', ' Sales']);
      const client = await readFile(result.clientPath, 'utf8');
      expect(client).toContain(JSON.stringify(' Sales')); // the exact name is in the generated code, not a trimmed one
      const types = await readFile(result.typesPath, 'utf8');
      const interfaces = [...types.matchAll(/export interface (\w+FieldData)\b/g)].map((match) => match[1]).filter((name) => /Sales/i.test(name ?? ''));
      expect(interfaces).toHaveLength(2);
      expect(new Set(interfaces).size).toBe(2);
    });

    it('type files get different names (the second carries a hash), and neither overwrites the other', async () => {
      const { root, service } = await make();
      const a = await service.generateTypesForLayout(profile, 'Sales');
      const b = await service.generateTypesForLayout(profile, ' Sales');
      expect(a.filePath).not.toBe(b.filePath);
      expect(a.filePath).toMatch(/layouts[\\/]Sales\.ts$/);
      expect(b.filePath).toMatch(/layouts[\\/]Sales-[0-9a-f]{8}\.ts$/);
      expect((await readdir(join(root, 'types', 'layouts'))).sort()).toHaveLength(2);
    });

    it('snippet keys differ, so the second layout does not replace the first', async () => {
      const { service } = await make();
      await service.generateSnippetsForLayout(profile, 'Sales');
      const second = await service.generateSnippetsForLayout(profile, ' Sales');
      const keys = Object.keys(JSON.parse(second.content.replace(/^\/\/[^\n]*\n/, '')) as Record<string, unknown>);
      expect(keys).toHaveLength(4);
      expect(keys).toContain('Sales Find Records');
      expect(keys.filter((key) => /^Sales-[0-9a-f]{8} /.test(key))).toHaveLength(2);
    });
  });
});

describe('validateDatabaseName', () => {
  it('trims a database name typed in a form', async () => {
    const { validateDatabaseName } = await import('../../src/utils/jsonValidate');
    // A database name is typed into the profile form, where a stray space is a typo, not part of the name.
    expect(validateDatabaseName(' Sales ')).toEqual({ ok: true, value: 'Sales' });
  });
});
