import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FmBridgeServer } from '../../src/services/fmBridgeServer';
import { FmWebRuntimeGenerator } from '../../src/services/fmWebRuntimeGenerator';
import type { ConnectionProfile } from '../../src/types/fm';

const profile: ConnectionProfile = {
  id: 'profile-1',
  name: 'Local',
  serverUrl: 'https://example.com',
  database: 'AppDB',
  authMode: 'direct',
  username: 'dev'
};

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeServer() {
  const findRecords = vi.fn(async () => ({ data: [{ recordId: '1', fieldData: { a: 1 } }] }));
  const server = new FmBridgeServer(
    { getActiveProfileId: () => profile.id, getProfile: async () => profile },
    {
      findRecords,
      getRecord: vi.fn(),
      editRecord: vi.fn(),
      createRecord: vi.fn(),
      deleteRecord: vi.fn(),
      runScript: vi.fn()
    } as never,
    { isWorkspaceTrusted: () => true, readProjectConfig: async () => undefined } as never,
    logger
  );
  return { server, findRecords };
}

// The preview app's own client, loaded from its source. Imported by a computed path so
// the extension's type-check does not pull the other package in.
async function loadRuntimeClient(): Promise<{
  RuntimeBridgeClient: new (baseUrl?: string, fetchFn?: typeof fetch, token?: string) => {
    find(request: { layout: string; query: Array<Record<string, unknown>> }): Promise<unknown>;
  };
}> {
  const file = path.resolve(__dirname, '../../../runtime-next/lib/bridge-client.ts');
  return import(/* @vite-ignore */ pathToFileURL(file).href);
}

const previewFetch: typeof fetch = (url, init) => fetch(url, {
  ...init, headers: { ...init?.headers, Origin: 'http://localhost:3000' }
});

describe('FM Web preview bridge token (real server, real preview client)', () => {
  beforeEach(() => {
    nock.enableNetConnect('127.0.0.1');
  });

  afterEach(() => {
    nock.disableNetConnect();
  });

  it('refuses the preview client without the token and serves it with the token', async () => {
    const { server, findRecords } = makeServer();
    const { baseUrl } = await server.ensureStarted();
    try {
      const { RuntimeBridgeClient } = await loadRuntimeClient();
      const request = { layout: 'Contacts', query: [{ Name: '*' }] };

      await expect(new RuntimeBridgeClient(baseUrl, previewFetch).find(request)).rejects.toThrow(/bridge session token/);
      await expect(new RuntimeBridgeClient(baseUrl, previewFetch, 'wrong-token').find(request)).rejects.toThrow(
        /bridge session token/
      );
      expect(findRecords).not.toHaveBeenCalled();

      const token = server.getSessionToken();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      const result = (await new RuntimeBridgeClient(baseUrl, previewFetch, token).find(request)) as {
        data: unknown[];
      };
      expect(result.data).toHaveLength(1);
      expect(findRecords).toHaveBeenCalledTimes(1);
    } finally {
      await server.stop();
    }
  });

  it('rejects tokens of the wrong length, the right length, and none, without erroring', async () => {
    const { server, findRecords } = makeServer();
    const { baseUrl } = await server.ensureStarted();
    try {
      const real = server.getSessionToken() as string;
      const post = (token?: string) =>
        fetch(`${baseUrl}/find`, {
          method: 'POST',
          headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json', ...(token ? { 'X-FM-Bridge-Token': token } : {}) },
          body: JSON.stringify({ layout: 'L', query: [{ a: 1 }] })
        });
      expect((await post()).status).toBe(403);
      expect((await post('short')).status).toBe(403);
      expect((await post('x'.repeat(real.length))).status).toBe(403);
      expect((await post(`${real}0`)).status).toBe(403);
      expect(findRecords).not.toHaveBeenCalled();
      expect((await post(real)).status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it('never logs the token', async () => {
    const { server } = makeServer();
    await server.ensureStarted();
    const token = server.getSessionToken() as string;
    await server.stop();
    const logged = JSON.stringify([
      ...logger.debug.mock.calls,
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls
    ]);
    expect(logged).not.toContain(token);
  });
});

describe('writeBridgeEnv', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fmweb-env-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function generator(trusted = true): FmWebRuntimeGenerator {
    return new FmWebRuntimeGenerator(
      { extensionUri: { fsPath: dir } } as never,
      {
        isWorkspaceTrusted: () => trusted,
        getGeneratedDirPath: () => dir,
        getWorkspaceRoot: () => dir,
        ensureProjectInitialized: async () => undefined
      } as never,
      logger
    );
  }

  it('writes only a non-secret notice, owner-only, and keeps it out of git', async () => {
    const envPath = await generator().writeBridgeEnv('http://127.0.0.1:5000/fm', 'abc123');
    const text = await readFile(envPath, 'utf8');
    expect(text).not.toContain('NEXT_PUBLIC_');
    expect(text).not.toContain('abc123');
    if (process.platform !== 'win32') {
      expect((await stat(envPath)).mode & 0o777).toBe(0o600);
    }
    const ignore = await readFile(path.join(dir, 'runtime-next', '.gitignore'), 'utf8');
    expect(ignore.split('\n')).toContain('.env.local');
  });

  it('never persists credentials on a later start', async () => {
    const gen = generator();
    const envPath = await gen.writeBridgeEnv('http://127.0.0.1:5000/fm', 'old-token');
    await gen.writeBridgeEnv('http://127.0.0.1:6000/fm', 'new-token');
    const text = await readFile(envPath, 'utf8');
    expect(text).not.toContain('old-token');
    expect(text).not.toContain('new-token');
    expect(text).not.toContain(':6000');
  });

  it('A3 removes saved bridge entries on cancel while preserving unrelated env values', async () => {
    const gen = generator();
    const envPath = await gen.writeBridgeEnv('http://127.0.0.1:5000/fm', 'old-token');
    const { writeFile } = await import('fs/promises');
    await writeFile(envPath, `${await readFile(envPath, 'utf8')}OTHER=value\n export NEXT_PUBLIC_FMWEB_BRIDGE_TOKEN=stale\n`);
    await gen.clearBridgeEnv();
    expect(await readFile(envPath, 'utf8')).toContain('OTHER=value\n');

  });

  it('A3 removes an env file containing only bridge entries and tolerates repeated cleanup', async () => {
    const gen = generator();
    const envPath = await gen.writeBridgeEnv('http://127.0.0.1:5000/fm', 'old-token');
    await gen.clearBridgeEnv();
    await expect(stat(envPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(gen.clearBridgeEnv()).resolves.toBeUndefined();
  });

  it('refuses values that could add lines to the env file, and refuses in an untrusted workspace', async () => {
    await expect(generator().writeBridgeEnv('http://127.0.0.1:1/fm', 'a\nEVIL=1')).rejects.toThrow(/env file/);
    await expect(generator(false).writeBridgeEnv('http://127.0.0.1:1/fm', 'abc')).rejects.toThrow(/trust/);
  });
});
