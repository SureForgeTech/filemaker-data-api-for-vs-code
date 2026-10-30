import { Readable } from 'stream';
import type { IncomingMessage, ServerResponse } from 'http';
import { describe, expect, it, vi } from 'vitest';

import type { ConnectionProfile, FindRecordsResult, RunScriptResult } from '../../src/types/fm';
import { FMClientError } from '../../src/services/errors';
import { FmBridgeServer } from '../../src/services/fmBridgeServer';

const profile: ConnectionProfile = {
  id: 'profile-1',
  name: 'Local Profile',
  serverUrl: 'https://example.com',
  database: 'AppDB',
  authMode: 'direct',
  username: 'dev'
};

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
};

describe('FmBridgeServer', () => {
  it.each([null, 'wrong'])('refuses a missing or wrong preview token before accessing FileMaker', async (token) => {
    const client = createFmClientStub();
    const server = new FmBridgeServer(createProfileStoreStub(), client, createFmWebProjectServiceStub(), logger);
    const result = await invokeBridgeRequest(server, '/fm/getRecord', { token, payload: { layout: 'L', recordId: '1' } });
    expect(result).toMatchObject({ status: 403, json: { error: 'Invalid or missing bridge session token.' } });
    expect(client.getRecord).not.toHaveBeenCalled();
  });

  it('allows CORS preflight without a token but refuses non-POST operations', async () => {
    const server = new FmBridgeServer(createProfileStoreStub(), createFmClientStub(), createFmWebProjectServiceStub(), logger);
    const preflight = await invokeBridgeRequest(server, '/fm/getRecord', { token: null, method: 'OPTIONS', origin: 'http://localhost:3000' });
    expect(preflight).toMatchObject({ status: 204, body: '', headers: { 'access-control-allow-origin': 'http://localhost:3000' } });
    expect(await invokeBridgeRequest(server, '/fm/getRecord', { method: 'GET' })).toMatchObject({ status: 405, json: { error: 'Only POST requests are supported.' } });
  });

  it.each(['getRecord', 'editRecord', 'deleteRecord'] as const)('trims spaces around record IDs in preview %s requests', async (route) => {
    const client = createFmClientStub();
    const server = new FmBridgeServer(createProfileStoreStub(), client, createFmWebProjectServiceStub(), logger);
    const result = await invokeBridgeRequest(server, `/fm/${route}`, {
      payload: { layout: 'Contacts', recordId: ' \t00123\r\n ', fieldData: { Name: 'Ada' } }
    });
    expect(result.status).toBe(200);
    expect(vi.mocked(client[route]).mock.calls[0]?.slice(0, 3)).toEqual([profile, 'Contacts', '00123']);
  });

  it('keeps spaces in layout and script names while trimming an optional script record ID', async () => {
    const client = createFmClientStub();
    const server = new FmBridgeServer(createProfileStoreStub(), client, createFmWebProjectServiceStub(), logger);
    const result = await invokeBridgeRequest(server, '/fm/runScript', {
      payload: { layout: ' . ', scriptName: ' .. ', recordId: ' 00123 ' }
    });
    expect(result.status).toBe(200);
    expect(client.runScript).toHaveBeenCalledWith(profile, {
      layout: ' . ', scriptName: ' .. ', scriptParam: undefined, recordId: '00123'
    }, { signal: expect.any(AbortSignal) });
  });

  it.each(['', '   ', '\n', ' \tkeep\r\nme \n'])('passes the script parameter %j through unchanged', async (scriptParam) => {
    const runScript = vi.fn().mockResolvedValue({ response: {}, messages: [] });
    const server = new FmBridgeServer(createProfileStoreStub(), createFmClientStub({ runScript }), createFmWebProjectServiceStub(), logger);
    const result = await invokeBridgeRequest(server, '/fm/runScript', { payload: { layout: 'L', scriptName: 'S', scriptParam } });
    expect(result.status).toBe(200);
    expect(runScript.mock.calls[0]?.[1].scriptParam).toBe(scriptParam);
  });

  it('keeps layout and script names intact in preview script requests', async () => {
    const runScript = vi.fn().mockResolvedValue({ response: {}, messages: [] });
    const server = new FmBridgeServer(createProfileStoreStub(), createFmClientStub({ runScript }), createFmWebProjectServiceStub(), logger);
    const result = await invokeBridgeRequest(server, '/fm/runScript', { payload: { layout: ' Exact ', scriptName: ' Script ' } });
    expect(result.status).toBe(200);
    expect(runScript).toHaveBeenCalledWith(profile, { layout: ' Exact ', scriptName: ' Script ', scriptParam: undefined, recordId: undefined }, { signal: expect.any(AbortSignal) });
  });

  it('preserves a FileMaker failure status and the exact record request names', async () => {
    const getRecord = vi.fn().mockRejectedValue(new FMClientError('Record changed', { status: 409 }));
    const server = new FmBridgeServer(createProfileStoreStub(), createFmClientStub({ getRecord }), createFmWebProjectServiceStub(), logger);
    const result = await invokeBridgeRequest(server, '/fm/getRecord', { payload: { layout: ' Exact ', recordId: '1' } });
    expect(result).toMatchObject({ status: 409, json: { error: 'Record changed' } });
    expect(getRecord).toHaveBeenCalledWith(profile, ' Exact ', '1', { signal: expect.any(AbortSignal) });
  });

  it('forwards the loaded modId and returns FileMaker error 306 without retrying', async () => {
    const editRecord = vi.fn().mockRejectedValue(new FMClientError('Record modification ID does not match.', { code: '306', status: 500 }));
    const server = new FmBridgeServer(createProfileStoreStub(), createFmClientStub({ editRecord }), createFmWebProjectServiceStub(), logger);
    const result = await invokeBridgeRequest(server, '/fm/editRecord', {
      payload: { layout: ' Exact ', recordId: '19', modId: '7', fieldData: { ' Field ': 'changed' } }
    });
    expect(editRecord).toHaveBeenCalledExactlyOnceWith(profile, ' Exact ', '19', { ' Field ': 'changed' }, { signal: expect.any(AbortSignal) }, { modId: '7' });
    expect(result).toMatchObject({ status: 500, json: { code: '306', error: 'Record modification ID does not match.' } });
  });

  it.each(['/editRecord', '/createRecord'].flatMap((route) =>
    ['A\0B', 'A\0B\0C', ['safe', 'A\0B\0C'], { nested: 'A\0B\0C' }].map((value) => ({ route, value }))
  ))('refuses NUL on $route before calling FileMaker: $value', async ({ route, value }) => {
    const client = createFmClientStub();
    const server = new FmBridgeServer(createProfileStoreStub(), client, createFmWebProjectServiceStub(), logger);
    const response = await invokeBridgeRequest(server, `/fm${route}`, {
      payload: { layout: 'Contacts', recordId: '1', fieldData: { ' Name ': value, Other: 'safe' } }
    });
    expect(response.status).toBe(400);
    expect(response.json).toEqual({ error: 'NUL character (U+0000) in field(s):  Name . On the FileMaker server we tested, FileMaker kept only the text before this character and dropped the rest. Nothing in this row was written. Remove the character from the source and try again.' });
    expect(client.editRecord).not.toHaveBeenCalled();
    expect(client.createRecord).not.toHaveBeenCalled();
  });

  it.each(['/editRecord', '/createRecord'])('passes safe field text through $route unchanged', async (route) => {
    const client = createFmClientStub();
    const server = new FmBridgeServer(createProfileStoreStub(), client, createFmWebProjectServiceStub(), logger);
    const fields = { ' Name ': 'A\u200bB\ufeffC' };
    const response = await invokeBridgeRequest(server, `/fm${route}`, {
      payload: { layout: 'Contacts', recordId: '1', fieldData: fields }
    });
    expect(response.status).toBe(200);
    if (route === '/editRecord') {
      expect(client.editRecord).toHaveBeenCalledWith(profile, 'Contacts', '1', fields, expect.anything(), undefined);
    } else {
      expect(client.createRecord).toHaveBeenCalledWith(profile, 'Contacts', fields, expect.anything());
    }
  });

  it.each([[], [{}]].map((query) => ({ query })))('lists records for Find All $query without sending a find', async ({ query }) => {
    const listRecords = vi.fn(async () => ({ data: [{ recordId: '4', fieldData: {} }] }));
    const client = createFmClientStub({ listRecords });
    const server = new FmBridgeServer(createProfileStoreStub(), client, createFmWebProjectServiceStub(), logger);
    const response = await invokeBridgeRequest(server, '/fm/find', { payload: { layout: ' Contacts ', query, limit: 10, offset: 3, sort: [{ fieldName: ' Name ', sortOrder: 'ascend' }] } });
    expect(response.status).toBe(200);
    expect(listRecords).toHaveBeenCalledWith(profile, ' Contacts ', { limit: 10, offset: 3, sort: [{ fieldName: ' Name ', sortOrder: 'ascend' }] }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(client.findRecords).not.toHaveBeenCalled();
  });

  it('refuses a mixed valid and empty bridge find instead of listing everything', async () => {
    const client = createFmClientStub();
    const server = new FmBridgeServer(createProfileStoreStub(), client, createFmWebProjectServiceStub(), logger);
    const response = await invokeBridgeRequest(server, '/fm/find', { payload: { layout: 'Contacts', query: [{ Name: 'Ada' }, {}] } });
    expect(response.json).toMatchObject({ error: expect.stringContaining('Enter at least one field value to search') });
    expect(client.findRecords).not.toHaveBeenCalled();
    expect(client.listRecords).not.toHaveBeenCalled();
  });

  it('handles runScript requests through FMClient', async () => {
    const server = new FmBridgeServer(
      createProfileStoreStub(),
      createFmClientStub({
        runScript: vi.fn(async () => ({
          response: { scriptResult: 'ok' },
          messages: [{ code: '0', message: 'OK' }]
        }))
      }),
      createFmWebProjectServiceStub(),
      logger
    );

    const response = await invokeBridgeRequest(server, '/fm/runScript', {
      origin: 'http://localhost:3000',
      payload: {
        layout: 'Contacts',
        scriptName: 'Run_Web_Action',
        scriptParam: 'id=42'
      }
    });

    expect(response.status).toBe(200);
    const body = response.json as RunScriptResult;
    expect(body.response).toEqual({ scriptResult: 'ok' });
  });

  it('refuses a route the policy hook refuses, before touching FileMaker', async () => {
    const deleteRecord = vi.fn();
    const findRecords = vi.fn(async () => ({ data: [], dataInfo: {} }) as unknown as FindRecordsResult);
    const server = new FmBridgeServer(
      createProfileStoreStub(),
      createFmClientStub({ deleteRecord, findRecords }),
      createFmWebProjectServiceStub(),
      logger,
      { authorizeRoute: async (route) => (route === '/deleteRecord' ? 'Offline mode is enabled.' : undefined) }
    );

    const refused = await invokeBridgeRequest(server, '/fm/deleteRecord', {
      origin: 'http://localhost:3000',
      payload: { layout: 'Contacts', recordId: '1' }
    });
    const allowed = await invokeBridgeRequest(server, '/fm/find', {
      origin: 'http://localhost:3000',
      payload: { layout: 'Contacts', query: [{}] }
    });

    expect(refused.status).toBe(403);
    expect((refused.json as { error: string }).error).toContain('Offline mode');
    expect(deleteRecord).not.toHaveBeenCalled();
    expect(allowed.status).toBe(200);
  });

  it('refuses a request that names a different profile than the active one', async () => {
    const findRecords = vi.fn();
    const server = new FmBridgeServer(
      createProfileStoreStub(),
      createFmClientStub({ findRecords }),
      createFmWebProjectServiceStub(),
      logger
    );

    const other = await invokeBridgeRequest(server, '/fm/find', {
      origin: 'http://localhost:3000',
      payload: { layout: 'Contacts', query: [{}], profileId: 'someone-elses-profile' }
    });

    expect(other.status).toBe(403);
    expect(findRecords).not.toHaveBeenCalled();
  });

  it('rejects disallowed origins', async () => {
    const server = new FmBridgeServer(
      createProfileStoreStub(),
      createFmClientStub(),
      createFmWebProjectServiceStub(),
      logger
    );

    const response = await invokeBridgeRequest(server, '/fm/find', {
      origin: 'https://evil.example',
      payload: {
        layout: 'Contacts',
        query: [{}]
      }
    });

    expect(response.status).toBe(403);
    const body = response.json as { error: string };
    expect(body.error).toContain('Origin');
  });

  it('returns timeout/abort failures from route handlers', async () => {
    const findRecords = vi.fn(
      async (_profile: ConnectionProfile, _layout: string, _request: unknown, control?: { signal?: AbortSignal }) =>
        new Promise<FindRecordsResult>((_resolve, reject) => {
          control?.signal?.addEventListener('abort', () => reject(new Error('Request timed out.')));
        })
    );

    const server = new FmBridgeServer(
      createProfileStoreStub(),
      createFmClientStub({
        findRecords
      }),
      createFmWebProjectServiceStub(),
      logger
    );

    const response = await invokeBridgeRequest(server, '/fm/find', {
      origin: 'http://localhost:3000',
      payload: {
        layout: 'Contacts',
        query: [{ Name: '*' }],
        timeoutMs: 10
      }
    });

    expect(response.status).toBe(500);
    const body = response.json as { error: string };
    expect(body.error).toContain('timed out');
    expect(findRecords).toHaveBeenCalledTimes(1);
  });
});

async function invokeBridgeRequest(
  server: FmBridgeServer,
  route: string,
  input: {
    origin?: string;
    payload?: Record<string, unknown>;
    remoteAddress?: string;
    token?: string | null;
    method?: string;
  }
): Promise<{ status: number; body: string; json: unknown; headers: Record<string, string> }> {
  const request = buildRequest(route, input.origin, input.payload, input.remoteAddress);
  // These tests call the handler without starting the server, so give it a session token and
  // present it, as the preview app does. (Tests of a missing or wrong token use a real server.)
  (server as unknown as { sessionToken: string }).sessionToken = 'test-session-token';
  if (input.token !== null) request.headers['x-fm-bridge-token'] = input.token ?? 'test-session-token';
  if (input.method) request.method = input.method;
  const response = buildResponse();

  const bridge = server as unknown as {
    handleRequest: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  };
  await bridge.handleRequest(request, response.response);

  let json: unknown = {};
  if (response.body.trim().length > 0) {
    json = JSON.parse(response.body) as unknown;
  }

  return {
    status: response.status,
    body: response.body,
    json,
    headers: response.headers
  };
}

function buildRequest(
  route: string,
  origin: string | undefined,
  payload: Record<string, unknown> | undefined,
  remoteAddress = '127.0.0.1'
): IncomingMessage {
  const readable = new Readable({
    read() {}
  }) as IncomingMessage;

  readable.method = 'POST';
  readable.url = route;
  readable.headers = {
    'content-type': 'application/json',
    ...(origin ? { origin } : {})
  };
  (readable as IncomingMessage & { socket: { remoteAddress?: string } }).socket = {
    remoteAddress
  } as IncomingMessage['socket'];

  readable.push(JSON.stringify(payload ?? {}));
  readable.push(null);
  return readable;
}

function buildResponse(): {
  response: ServerResponse;
  status: number;
  body: string;
  headers: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  let status = 200;
  let body = '';
  let headersSent = false;

  const response = {
    get statusCode() {
      return status;
    },
    set statusCode(value: number) {
      status = value;
    },
    get headersSent() {
      return headersSent;
    },
    setHeader(name: string, value: number | string | readonly string[]) {
      const rendered = Array.isArray(value) ? value.join(', ') : String(value);
      headers[name.toLowerCase()] = rendered;
      return this as unknown as ServerResponse;
    },
    end(chunk?: string | Buffer) {
      headersSent = true;
      if (chunk) {
        body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      }
      return this as unknown as ServerResponse;
    }
  } as unknown as ServerResponse;

  return {
    response,
    get status() {
      return status;
    },
    get body() {
      return body;
    },
    headers
  };
}

function createProfileStoreStub(): {
  getActiveProfileId: () => string | undefined;
  getProfile: (profileId: string) => Promise<ConnectionProfile | undefined>;
} {
  return {
    getActiveProfileId: () => profile.id,
    getProfile: vi.fn(async (profileId: string) => (profileId === profile.id ? profile : undefined))
  };
}

type BridgeClient = ConstructorParameters<typeof FmBridgeServer>[1];

function createFmClientStub(overrides: Partial<BridgeClient> = {}): BridgeClient {
  return {
    listRecords: vi.fn(async () => ({ data: [] })),
    findRecords: vi.fn(async () => ({ data: [] })),
    getRecord: vi.fn(async () => ({ recordId: '1', fieldData: {} })),
    editRecord: vi.fn(async () => ({ recordId: '1', response: {}, messages: [] })),
    createRecord: vi.fn(async () => ({ recordId: '1', response: {}, messages: [] })),
    deleteRecord: vi.fn(async () => ({ recordId: '1', response: {}, messages: [] })),
    runScript: vi.fn(async () => ({ response: {}, messages: [] })),
    ...overrides
  };
}

function createFmWebProjectServiceStub(): ConstructorParameters<typeof FmBridgeServer>[2] {
  const now = new Date().toISOString();
  return {
    isWorkspaceTrusted: () => true,
    readProjectConfig: vi.fn(async () => ({
      schemaVersion: 1,
      name: 'Test Project',
      activeProfileId: profile.id,
      environments: [],
      featureFlags: {
        runtimeGenerationEnabled: true,
        bridgeServerEnabled: true,
        commercialModeEnabled: false
      },
      createdAt: now,
      updatedAt: now
    }))
  };
}
