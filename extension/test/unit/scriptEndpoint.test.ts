import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { Readable } from 'stream';

import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { FmBridgeServer } from '../../src/services/fmBridgeServer';
import { FMClient, MAX_SCRIPT_URL_LENGTH } from '../../src/services/fmClient';
import type { FMClientError } from '../../src/services/errors';
import { SecretStore } from '../../src/services/secretStore';
import type { ConnectionProfile } from '../../src/types/fm';
import { executeBehaviorBinding } from '../../src/webviews/layoutMode/behaviorExecution';
import { ScriptRunnerPanel } from '../../src/webviews/scriptRunner';
import { makeHarness } from './ai/harness';
import { InMemoryMemento, InMemorySecretStorage } from './mocks';

/**
 * Claris Data API Guide, "Run a script" (https://help.claris.com/en/data-api-guide/content/run-a-script.html):
 * "To independently run a FileMaker script, use an HTTP GET method with the `script` API endpoint", at
 * /fmi/data/<version>/databases/<database>/layouts/<layout>/script/<script>, with the query parameter `script.param`.
 */
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const ok = (response: Record<string, unknown>) => JSON.stringify({ response, messages: [{ code: '0', message: 'OK' }] });
const fmError = (code: string) => JSON.stringify({ response: {}, messages: [{ code, message: 'x' }] });

interface Seen {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
}
type Handler = (seen: Seen, response: ServerResponse) => void;

describe('running a script uses the documented endpoint', () => {
  const servers: Server[] = [];
  beforeEach(() => vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Run script' as never));
  beforeAll(() => nock.restore());
  afterAll(() => {
    nock.activate();
    nock.disableNetConnect();
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });

  async function serve(handler: Handler): Promise<{ url: string; seen: Seen[] }> {
    const seen: Seen[] = [];
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let raw = '';
      request.on('data', (chunk) => (raw += chunk));
      request.on('end', () => {
        const url = new URL(request.url ?? '/', 'http://x');
        const entry: Seen = { method: request.method ?? '', url: request.url ?? '', path: url.pathname, query: url.searchParams, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
        seen.push(entry);
        response.setHeader('Content-Type', 'application/json');
        handler(entry, response);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
  }

  /** The server: sessions work; everything else goes to `handler`. */
  const withLogin = (handler: Handler): Handler => (entry, response) => {
    if (entry.method === 'POST' && entry.path.endsWith('/sessions')) {
      response.end(ok({ token: 'tok' }));
      return;
    }
    handler(entry, response);
  };

  async function client(url: string) {
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    await secrets.setPassword('p1', 'pw');
    await secrets.setSessionToken('p1', 'tok');
    const profile: ConnectionProfile = { id: 'p1', name: 'T', authMode: 'direct', serverUrl: url, database: 'Sales Db', username: 'u' };
    return { fm: new FMClient(secrets, logger, 3000), profile };
  }

  const calls = (seen: Seen[]) => seen.filter((entry) => !entry.path.endsWith('/sessions'));
  const scriptOk = (entry: Seen, response: ServerResponse) => {
    void entry;
    response.end(ok({ scriptResult: '{"n":1}', scriptError: '0' }));
  };

  describe('the documented request', () => {
    it('is one GET to /layouts/<layout>/script/<script> with script.param in the URL, and nothing else', async () => {
      const server = await serve(withLogin(scriptOk));
      const { fm, profile } = await client(server.url);

      const result = await fm.runScript(profile, { layout: 'Contacts', scriptName: 'Echo', scriptParam: 'id=42' });

      const sent = calls(server.seen);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ method: 'GET', path: '/fmi/data/vLatest/databases/Sales%20Db/layouts/Contacts/script/Echo' });
      expect(sent[0]?.query.get('script.param')).toBe('id=42');
      expect([...sent[0]!.query.keys()]).toEqual(['script.param']);
      expect(sent[0]?.body).toEqual({});
      expect(result.response).toEqual({ scriptResult: '{"n":1}', scriptError: '0' });
      expect(result.messages[0]?.code).toBe('0');
    });

    it('sends no query at all when there is no parameter, and no record is read or found', async () => {
      const server = await serve(withLogin(scriptOk));
      const { fm, profile } = await client(server.url);
      await fm.runScript(profile, { layout: 'Contacts', scriptName: 'Echo' });
      const sent = calls(server.seen);
      expect(sent.map((entry) => `${entry.method} ${entry.url.split('/databases/')[1]}`)).toEqual(['GET Sales%20Db/layouts/Contacts/script/Echo']);
      expect(server.seen.some((entry) => /\/records|_find/.test(entry.path))).toBe(false);
    });

    it('encodes names and parameters exactly: spaces as %20, a slash as %2F, a pipe as %7C, a plus as %2B, unicode as UTF-8', async () => {
      const server = await serve(withLogin(scriptOk));
      const { fm, profile } = await client(server.url);
      const name = 'Run / Ünï 100% [x]?#&=';
      const param = 'a b|c+d&e=f#g?h/ü€ 日本\n"q"';

      await fm.runScript(profile, { layout: 'Odd Layout/Ünï', scriptName: name, scriptParam: param });

      const sent = calls(server.seen)[0]!;
      const raw = sent.url;
      expect(raw).toContain('/layouts/Odd%20Layout%2F%C3%9Cn%C3%AF/script/Run%20%2F%20%C3%9Cn%C3%AF%20100%25%20%5Bx%5D%3F%23%26%3D');
      expect(raw).toContain('script.param=a%20b%7Cc%2Bd%26e%3Df%23g%3Fh%2F%C3%BC%E2%82%AC%20%E6%97%A5%E6%9C%AC%0A%22q%22');
      expect(raw).not.toMatch(/\+/); // a space is never a plus
      expect(decodeURIComponent(sent.path.split('/script/')[1] as string)).toBe(name);
      expect(sent.query.get('script.param')).toBe(param);
    });

    it('passes scriptResult through unchanged, whether it is plain text or JSON text', async () => {
      for (const scriptResult of ['plain text', '{"a":[1,2]}', '', '0']) {
        const server = await serve(withLogin((_entry, response) => response.end(ok({ scriptResult, scriptError: '0' }))));
        const { fm, profile } = await client(server.url);
        const result = await fm.runScript(profile, { layout: 'L', scriptName: 'S' });
        expect(result.response.scriptResult, JSON.stringify(scriptResult)).toBe(scriptResult);
      }
    });

    it('shows a non-zero scriptError in the result (the request itself worked)', async () => {
      const server = await serve(withLogin((_entry, response) => response.end(ok({ scriptResult: '', scriptError: '3' }))));
      const { fm, profile } = await client(server.url);
      const result = await fm.runScript(profile, { layout: 'L', scriptName: 'Fail' });
      expect(result.response.scriptError).toBe('3');
    });

    it('a FileMaker error answer (script missing, 105 or 104) is reported as that, with no second request', async () => {
      const server = await serve(withLogin((_entry, response) => ((response.statusCode = 500), response.end(fmError('104')))));
      const { fm, profile } = await client(server.url);
      const error = await fm.runScript(profile, { layout: 'L', scriptName: 'Nope' }).catch((e: FMClientError) => e);
      expect((error as FMClientError).code).toBe('104');
      expect(calls(server.seen)).toHaveLength(1);
    });
  });

  describe('the documented alternative, only where the endpoint itself is refused', () => {
    it('on HTTP 405 the script is attached to GET records limited to one, with query parameters', async () => {
      const server = await serve(
        withLogin((entry, response) => {
          if (entry.path.includes('/script/')) {
            response.statusCode = 405;
            response.end('{"messages":[{"code":"-1","message":"Method not allowed"}]}');
            return;
          }
          response.end(ok({ data: [], scriptResult: 'via records', scriptError: '0' }));
        })
      );
      const { fm, profile } = await client(server.url);

      const result = await fm.runScript(profile, { layout: 'Contacts', scriptName: 'Echo', scriptParam: 'x y' });

      const sent = calls(server.seen);
      expect(sent.map((entry) => entry.method)).toEqual(['GET', 'GET']);
      expect(sent[1]?.path).toMatch(/\/layouts\/Contacts\/records$/);
      expect(Object.fromEntries(sent[1]!.query)).toEqual({ _limit: '1', script: 'Echo', 'script.param': 'x y' });
      expect(result.response.scriptResult).toBe('via records');
    });

    it('a bare 404 (wrong address, Data API off) is NOT taken for "unsupported": one request, an error', async () => {
      const server = await serve(withLogin((_entry, response) => ((response.statusCode = 404), response.setHeader('Content-Type', 'text/html'), response.end('<html>not found</html>'))));
      const { fm, profile } = await client(server.url);
      await expect(fm.runScript(profile, { layout: 'L', scriptName: 'S' })).rejects.toBeTruthy();
      expect(calls(server.seen)).toHaveLength(1);
    });

    it('when the alternative is refused too, the answer is "not supported on this server"', async () => {
      const server = await serve(withLogin((_entry, response) => ((response.statusCode = 405), response.end('{}'))));
      const { fm, profile } = await client(server.url);
      const error = (await fm.runScript(profile, { layout: 'L', scriptName: 'S' }).catch((e: FMClientError) => e)) as FMClientError;
      expect(error.code).toBe('SCRIPT_UNSUPPORTED');
    });

    it('reports an empty layout after HTTP 405 without calling it unsupported', async () => {
      const server = await serve(withLogin((entry, response) => {
        if (entry.path.includes('/script/')) {
          response.statusCode = 405;
          response.end('{}');
        } else response.end(fmError('401'));
      }));
      const { fm, profile } = await client(server.url);
      await expect(fm.runScript(profile, { layout: 'L', scriptName: 'S' })).rejects.toMatchObject({
        code: '401', message: expect.stringContaining('The script did not run because this layout has no records')
      });
      expect(calls(server.seen).map((entry) => entry.method)).toEqual(['GET', 'GET']);
    });

    it('a record in context uses GET records/<id>?script=...&script.param=... (query parameters, as documented for GET)', async () => {
      const server = await serve(withLogin((_entry, response) => response.end(ok({ data: [], scriptResult: 'r', scriptError: '0' }))));
      const { fm, profile } = await client(server.url);
      await fm.runScript(profile, { layout: 'Contacts', scriptName: 'Echo', scriptParam: 'a b', recordId: '12' });
      const sent = calls(server.seen);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ method: 'GET', path: expect.stringMatching(/\/layouts\/Contacts\/records\/12$/) });
      expect(sent[0]?.query.get('script')).toBe('Echo');
      expect(sent[0]?.query.get('script.param')).toBe('a b');
      expect(sent[0]?.url).not.toContain('+');
    });
  });

  describe('a long parameter', () => {
    it('uses a wildcard text find for a long parameter, limited to one record', async () => {
      const server = await serve(withLogin((entry, response) => {
        if (entry.path.endsWith('/layouts/Contacts')) response.end(ok({ fieldMetaData: [{ name: ' Exact text ', result: 'text' }] }));
        else response.end(ok({ data: [{ recordId: '1', fieldData: { Private: 'hidden' } }], scriptResult: 'long ok', scriptError: '0' }));
      }));
      const { fm, profile } = await client(server.url);
      const param = 'é|'.repeat(3000);
      const result = await fm.runScript(profile, { layout: 'Contacts', scriptName: 'Echo', scriptParam: param });
      expect(calls(server.seen).map((entry) => entry.method)).toEqual(['GET', 'POST']);
      expect(calls(server.seen)[1]).toMatchObject({ path: expect.stringMatching(/\/_find$/), body: { query: [{ ' Exact text ': '*' }], limit: 1, script: 'Echo', 'script.param': param } });
      expect(result.response).toEqual({ scriptResult: 'long ok', scriptError: '0' });
    });

    it('returns the script result when scriptError is present even with empty data', async () => {
      const server = await serve(withLogin((entry, response) => {
        if (entry.path.endsWith('/layouts/L')) response.end(ok({ fieldMetaData: [{ name: 'Name', result: 'text', type: 'normal' }] }));
        else response.end(ok({ data: [], scriptResult: 'ran', scriptError: '0' }));
      }));
      const { fm, profile } = await client(server.url);
      const result = await fm.runScript(profile, { layout: 'L', scriptName: 'S', scriptParam: 'x'.repeat(5000) });
      expect(result.response).toEqual({ scriptResult: 'ran', scriptError: '0' });
      expect(calls(server.seen).map((entry) => entry.method)).toEqual(['GET', 'POST']);
    });

    it('reports that the script did not run after a 401 find and an empty layout read', async () => {
      const server = await serve(withLogin((entry, response) => {
        if (entry.path.endsWith('/layouts/L')) response.end(ok({ fieldMetaData: [{ name: 'Name', result: 'text', type: 'normal' }] }));
        else response.end(fmError('401'));
      }));
      const { fm, profile } = await client(server.url);
      await expect(fm.runScript(profile, { layout: 'L', scriptName: 'S', scriptParam: 'x'.repeat(5000) })).rejects.toMatchObject({
        code: '401', message: expect.stringContaining('The script did not run because this layout has no records')
      });
      const sent = calls(server.seen);
      expect(sent.map((entry) => entry.method)).toEqual(['GET', 'POST', 'GET']);
      expect(sent[2]?.path).toMatch(/\/records$/);
      expect(Object.fromEntries(sent[2]!.query)).toEqual({ _limit: '1' });
    });

    it.each([[], [{ recordId: '1', fieldData: {} }]].map((data) => ({ data })))('requires scriptError even when a find returns scriptResult (data=$data)', async ({ data }) => {
      const server = await serve(withLogin((entry, response) => {
        if (entry.path.endsWith('/layouts/L')) response.end(ok({ fieldMetaData: [{ name: 'Name', result: 'text', type: 'normal' }] }));
        else response.end(ok({ data, scriptResult: 'unconfirmed' }));
      }));
      const { fm, profile } = await client(server.url);
      await expect(fm.runScript(profile, { layout: 'L', scriptName: 'S', scriptParam: 'x'.repeat(5000) })).rejects.toMatchObject({
        code: 'SCRIPT_NOT_CONFIRMED', isRetryable: false
      });
      expect(calls(server.seen).map((entry) => entry.method)).toEqual(['GET', 'POST']);
    });

    it('stays on the script endpoint at the limit and uses a find just over it', async () => {
      const server = await serve(withLogin((entry, response) => {
        if (entry.path.endsWith('/layouts/L')) response.end(ok({ fieldMetaData: [{ name: 'Name', result: 'text' }] }));
        else response.end(ok({ scriptError: '0' }));
      }));
      const { fm, profile } = await client(server.url);
      const prefix = `${server.url}/fmi/data/vLatest/databases/Sales%20Db/layouts/L/script/S?script.param=`.length;
      await fm.runScript(profile, { layout: 'L', scriptName: 'S', scriptParam: 'a'.repeat(MAX_SCRIPT_URL_LENGTH - prefix) });
      await fm.runScript(profile, { layout: 'L', scriptName: 'S', scriptParam: 'a'.repeat(MAX_SCRIPT_URL_LENGTH - prefix + 1) });
      expect(calls(server.seen).map((entry) => entry.method)).toEqual(['GET', 'GET', 'POST']);
      await fm.runScript(profile, { layout: 'L', scriptName: 'S', scriptParam: 'x'.repeat(5000) });
      expect(calls(server.seen).map((entry) => entry.method)).toEqual(['GET', 'GET', 'POST', 'POST']);
    });

    it('with a record in context there is no body form, so a too-long parameter is a clear error and nothing is sent', async () => {
      const server = await serve(withLogin(scriptOk));
      const { fm, profile } = await client(server.url);
      const error = (await fm
        .runScript(profile, { layout: 'L', scriptName: 'S', scriptParam: 'x'.repeat(5000), recordId: '1' })
        .catch((e: FMClientError) => e)) as FMClientError;
      expect(error.code).toBe('SCRIPT_PARAMETER_TOO_LONG');
      expect(error.message).toContain('This parameter is too long to send.');
      expect(calls(server.seen)).toHaveLength(0);
    });
  });

  describe('the Copy as curl / fetch snippets show the same request', () => {
    async function snippets(request: Record<string, unknown>) {
      let onMessage: ((message: unknown) => void) | undefined;
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
        webview: { html: '', cspSource: 'x', asWebviewUri: (u: unknown) => u, postMessage: vi.fn(async () => true), onDidReceiveMessage: (cb: (m: unknown) => void) => ((onMessage = cb), { dispose: vi.fn() }) },
        onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
        reveal: vi.fn(),
        dispose: vi.fn()
      } as never);
      (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
      (ScriptRunnerPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
      const profile: ConnectionProfile = { id: 'p1', name: 'T', authMode: 'direct', serverUrl: 'https://fm.example.com/', database: 'Sales Db', username: 'u' };
      ScriptRunnerPanel.createOrShow(
        { extensionUri: { fsPath: '/ext' }, workspaceState: new InMemoryMemento() } as never,
        { listProfiles: async () => [profile], getProfile: async () => profile, getActiveProfileId: () => 'p1' } as never,
        { listLayouts: async () => [], listScripts: async () => [] } as never,
        logger
      );
      const written: string[] = [];
      (vscode.env as unknown as { clipboard: { writeText: (t: string) => Promise<void> } }).clipboard = { writeText: async (t) => void written.push(t) };
      for (const type of ['copyCurl', 'copyFetch']) {
        onMessage?.({ type, payload: { profileId: 'p1', layout: 'Contacts', scriptName: 'Run It', ...request } });
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return written;
    }

    it('are GET requests to the script endpoint with script.param in the URL, and no body', async () => {
      const [curl, fetchSnippet] = (await snippets({ scriptParam: 'a b|c' })) as [string, string];
      for (const text of [curl, fetchSnippet]) {
        expect(text).toContain('https://fm.example.com/fmi/data/vLatest/databases/Sales%20Db/layouts/Contacts/script/Run%20It?script.param=a%20b%7Cc');
        expect(text).not.toMatch(/\bPOST\b/);
        expect(text).not.toMatch(/scriptParam|recordId/);
      }
      expect(curl).not.toContain('-d ');
    });

    it('with a record id they GET that record with the script attached', async () => {
      const [curl] = (await snippets({ scriptParam: 'x', recordId: '7' })) as [string];
      expect(curl).toContain('/layouts/Contacts/records/7?script=Run%20It&script.param=x');
    });

    it('with no parameter there is no query', async () => {
      const [curl] = (await snippets({})) as [string];
      expect(curl).toContain("/script/Run%20It'");
    });
  });

  describe('script and layout names that are dot segments', () => {
    it.each([['..', 'L'], ['.', 'L'], ['S', '..'], ['S', '.']])('script %s on layout %s is refused before anything is sent', async (scriptName, layout) => {
      const server = await serve(withLogin(scriptOk));
      const { fm, profile } = await client(server.url);
      const error = (await fm.runScript(profile, { layout, scriptName, scriptParam: 'x' }).catch((e: FMClientError) => e)) as FMClientError;
      expect(error.code).toBe('NAME_NOT_USABLE_IN_URL');
      expect(error.message).toMatch(/cannot be used in a request/);
      expect(calls(server.seen)).toHaveLength(0);
    });

    it('names that merely contain dots are ordinary names and are sent', async () => {
      const server = await serve(withLogin(scriptOk));
      const { fm, profile } = await client(server.url);
      for (const scriptName of ['...', 'a..b', '.hidden']) {
        await fm.runScript(profile, { layout: 'L', scriptName });
      }
      expect(calls(server.seen)).toHaveLength(3);
      expect(calls(server.seen)[0]?.path).toMatch(/\/script\/\.\.\.$/);
    });

    it('Script Runner: the panel answers with an error and sends nothing', async () => {
      let onMessage: ((message: unknown) => void) | undefined;
      const posted: Array<Record<string, unknown>> = [];
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
        webview: { html: '', cspSource: 'x', asWebviewUri: (u: unknown) => u, postMessage: vi.fn(async (m: Record<string, unknown>) => (posted.push(m), true)), onDidReceiveMessage: (cb: (m: unknown) => void) => ((onMessage = cb), { dispose: vi.fn() }) },
        onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
        reveal: vi.fn(),
        dispose: vi.fn()
      } as never);
      (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
      (ScriptRunnerPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
      const server = await serve(withLogin(scriptOk));
      const { fm, profile } = await client(server.url);
      const runScript = vi.fn((p: ConnectionProfile, r: never) => fm.runScript(p, r));
      ScriptRunnerPanel.createOrShow(
        { extensionUri: { fsPath: '/ext' }, workspaceState: new InMemoryMemento() } as never,
        { listProfiles: async () => [profile], getProfile: async () => profile, getActiveProfileId: () => 'p1' } as never,
        { listLayouts: async () => ['L'], listScripts: async () => [], runScript } as never,
        logger
      );
      onMessage?.({ type: 'runScript', payload: { profileId: 'p1', layout: 'L', scriptName: '..' } });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(runScript).not.toHaveBeenCalled();
      expect(posted.some((m) => m.type === 'error' && /cannot be used in a request/.test(String(m.message)))).toBe(true);
      expect(calls(server.seen)).toHaveLength(0);
    });

    it('the AI tool refuses them even if the script is on the allowlist', async () => {
      const h = makeHarness({ settings: { scriptAllowlist: { p1: ['..'] } } });
      h.client.listScripts.mockResolvedValue(['..']);
      h.client.listLayouts.mockResolvedValue(['L', '..']);
      h.confirm.mockResolvedValue(true);
      h.state.now += 120_000;
      await expect(h.service.invoke('fm_run_script', { layout: 'L', script: '..' })).rejects.toThrow(/cannot be used in a request/);
      await expect(h.service.invoke('fm_run_script', { layout: '..', script: '..' })).rejects.toThrow(/cannot be used in a request/);
      expect(h.client.runScript).not.toHaveBeenCalled();
    });
  });

  describe('a script run returns the script\'s answer, not a record', () => {
    const withRecord: Handler = (entry, response) => {
      if (entry.method === 'GET' && /\/script\//.test(entry.path)) {
        response.statusCode = 405;
        response.end('{"messages":[{"code":"-1","message":"Method not allowed"}]}');
        return;
      }
      response.end(ok({ data: [{ recordId: '1', modId: '0', fieldData: { Secret: 'top secret' } }], dataInfo: { foundCount: 1 }, scriptResult: 'r', scriptError: '0' }));
    };

    it('after the fallback to GET records, FMClient drops data and dataInfo and keeps the script keys', async () => {
      const server = await serve(withLogin(withRecord));
      const { fm, profile } = await client(server.url);
      const result = await fm.runScript(profile, { layout: 'L', scriptName: 'S' });
      expect(result.response).toEqual({ scriptResult: 'r', scriptError: '0' });
      expect(JSON.stringify(result)).not.toContain('top secret');
    });

    it('with a record id (GET of that record) as well', async () => {
      const server = await serve(withLogin(withRecord));
      const { fm, profile } = await client(server.url);
      const result = await fm.runScript(profile, { layout: 'L', scriptName: 'S', recordId: '1' });
      expect(result.response).toEqual({ scriptResult: 'r', scriptError: '0' });
    });

    it('refuses a long parameter when the metadata has no text field', async () => {
      const server = await serve(withLogin((entry, response) => {
        if (entry.path.endsWith('/layouts/L')) response.end(ok({ fieldMetaData: [{ name: 'Count', result: 'number', type: 'normal' }] }));
        else response.end(ok({ data: [{ recordId: '1', fieldData: { Count: 1 } }] }));
      }));
      const { fm, profile } = await client(server.url);
      await expect(fm.runScript(profile, { layout: 'L', scriptName: 'S', scriptParam: 'x'.repeat(5000) })).rejects.toMatchObject({ code: 'SCRIPT_PARAMETER_TOO_LONG' });
      expect(calls(server.seen).map((entry) => entry.method)).toEqual(['GET', 'GET']);
      expect(calls(server.seen)[0]?.path).toMatch(/\/layouts\/L$/);
      expect(calls(server.seen)[1]?.path).toMatch(/\/layouts\/L\/records$/);
      expect(Object.fromEntries(calls(server.seen)[1]!.query)).toEqual({ _limit: '1' });
    });

    it('reports that a long-parameter script did not run when a no-text-field layout has zero records', async () => {
      const server = await serve(withLogin((entry, response) => {
        if (entry.path.endsWith('/layouts/L')) response.end(ok({ fieldMetaData: [] }));
        else response.end(ok({ data: [] }));
      }));
      const { fm, profile } = await client(server.url);
      await expect(fm.runScript(profile, { layout: 'L', scriptName: 'S', scriptParam: 'x'.repeat(5000) })).rejects.toMatchObject({
        code: '401', message: expect.stringContaining('The script did not run because this layout has no records')
      });
      expect(calls(server.seen).map((entry) => entry.method)).toEqual(['GET', 'GET']);
    });

    it('Layout Mode\'s result detail and the preview bridge\'s reply carry no record', async () => {
      const server = await serve(withLogin(withRecord));
      const { fm, profile } = await client(server.url);
      const layoutMode = await executeBehaviorBinding({
        behavior: { type: 'runScript', scriptName: 'S' },
        objectName: 'B',
        layoutName: 'L',
        fmLayoutName: 'L',
        profile,
        runScript: (p, r) => fm.runScript(p, r)
      });
      expect(JSON.stringify(layoutMode)).not.toContain('top secret');
      expect(layoutMode.ok).toBe(true);

      const bridge = new FmBridgeServer(
        { getActiveProfileId: () => profile.id, getProfile: async () => profile } as never,
        fm as never,
        { isWorkspaceTrusted: () => true, readProjectConfig: async () => ({ schemaVersion: 1, name: 'P', activeProfileId: profile.id, environments: [], featureFlags: { runtimeGenerationEnabled: true, bridgeServerEnabled: true, commercialModeEnabled: false } }) } as never,
        logger
      );
      (bridge as unknown as { sessionToken: string }).sessionToken = 't';
      const readable = new Readable({ read() {} }) as IncomingMessage;
      readable.method = 'POST';
      readable.url = '/fm/runScript';
      readable.headers = { 'content-type': 'application/json', origin: 'http://localhost:3000', 'x-fm-bridge-token': 't' };
      (readable as unknown as { socket: unknown }).socket = { remoteAddress: '127.0.0.1' };
      readable.push(JSON.stringify({ layout: 'L', scriptName: 'S', recordId: '1' }));
      readable.push(null);
      const out = { status: 200, body: '' };
      const response = {
        get statusCode() {
          return out.status;
        },
        set statusCode(v: number) {
          out.status = v;
        },
        headersSent: false,
        setHeader: () => response,
        end: (chunk?: string) => ((out.body += chunk ?? ''), response)
      } as unknown as ServerResponse;
      await (bridge as unknown as { handleRequest: (a: IncomingMessage, b: ServerResponse) => Promise<void> }).handleRequest(readable, response);
      expect(out.status).toBe(200);
      expect(out.body).toContain('"scriptResult":"r"');
      expect(out.body).not.toContain('top secret');
      expect(out.body).not.toContain('"data"');
    });
  });

  describe('every way of running a script goes through it', () => {
    const run = async (use: (fm: FMClient, profile: ConnectionProfile) => Promise<unknown>) => {
      const server = await serve(withLogin((_entry, response) => response.end(ok({ scriptResult: 'done', scriptError: '0' }))));
      const { fm, profile } = await client(server.url);
      await use(fm, profile);
      return calls(server.seen);
    };
    const expectOnlyTheScriptCall = (sent: Seen[], script: string, param: string) => {
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ method: 'GET' });
      expect(sent[0]?.path).toMatch(new RegExp(`/layouts/Contacts/script/${script}$`));
      expect(sent[0]?.query.get('script.param')).toBe(param);
    };

    it('Script Runner panel', async () => {
      (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
      let onMessage: ((message: unknown) => void) | undefined;
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
        webview: { html: '', cspSource: 'x', asWebviewUri: (u: unknown) => u, postMessage: vi.fn(async () => true), onDidReceiveMessage: (cb: (m: unknown) => void) => ((onMessage = cb), { dispose: vi.fn() }) },
        onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
        reveal: vi.fn(),
        dispose: vi.fn()
      } as never);
      (ScriptRunnerPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
      const sent = await run(async (fm, profile) => {
        ScriptRunnerPanel.createOrShow(
          { extensionUri: { fsPath: '/ext' }, workspaceState: new InMemoryMemento() } as never,
          { listProfiles: async () => [profile], getProfile: async () => profile, getActiveProfileId: () => 'p1' } as never,
          { listLayouts: async () => ['Contacts'], listScripts: async () => [], runScript: (p: ConnectionProfile, r: never) => fm.runScript(p, r) } as never,
          logger
        );
        onMessage?.({ type: 'runScript', payload: { profileId: 'p1', layout: 'Contacts', scriptName: 'Echo', scriptParam: 'from panel' } });
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      expectOnlyTheScriptCall(sent, 'Echo', 'from panel');
    });

    it('Layout Mode script binding', async () => {
      const sent = await run((fm, profile) =>
        executeBehaviorBinding({
          behavior: { type: 'runScript', scriptName: 'Echo', parameter: 'from layout mode' },
          objectName: 'B',
          layoutName: 'Contacts',
          fmLayoutName: 'Contacts',
          profile,
          runScript: (p, r) => fm.runScript(p, r)
        })
      );
      expectOnlyTheScriptCall(sent, 'Echo', 'from layout mode');
    });

    it('the AI tool fm_run_script', async () => {
      const h = makeHarness({ settings: { scriptAllowlist: { p1: ['Echo'] } } });
      const sent = await run(async (fm, profile) => {
        h.client.listScripts.mockResolvedValue(['Echo']);
        h.client.runScript.mockImplementation(async (_p: unknown, request: never) => fm.runScript(profile, request));
        // The tool asks first; the harness answers yes.
        h.confirm.mockResolvedValue(true);
        h.state.now += 120_000;
        await h.service.invoke('fm_run_script', { layout: 'Contacts', script: 'Echo', parameter: 'from the AI' });
      });
      expectOnlyTheScriptCall(sent, 'Echo', 'from the AI');
    });

    it('the preview bridge /runScript', async () => {
      const sent = await run(async (fm, profile) => {
        const bridge = new FmBridgeServer(
          { getActiveProfileId: () => profile.id, getProfile: async () => profile } as never,
          fm as never,
          { isWorkspaceTrusted: () => true, readProjectConfig: async () => ({ schemaVersion: 1, name: 'P', activeProfileId: profile.id, environments: [], featureFlags: { runtimeGenerationEnabled: true, bridgeServerEnabled: true, commercialModeEnabled: false } }) } as never,
          logger
        );
        (bridge as unknown as { sessionToken: string }).sessionToken = 't';
        const readable = new Readable({ read() {} }) as IncomingMessage;
        readable.method = 'POST';
        readable.url = '/fm/runScript';
        readable.headers = { 'content-type': 'application/json', origin: 'http://localhost:3000', 'x-fm-bridge-token': 't' };
        (readable as unknown as { socket: unknown }).socket = { remoteAddress: '127.0.0.1' };
        readable.push(JSON.stringify({ layout: 'Contacts', scriptName: 'Echo', scriptParam: 'from the bridge' }));
        readable.push(null);
        const out = { status: 200, body: '' };
        const response = {
          get statusCode() {
            return out.status;
          },
          set statusCode(v: number) {
            out.status = v;
          },
          headersSent: false,
          setHeader: () => response,
          end: (chunk?: string) => ((out.body += chunk ?? ''), response)
        } as unknown as ServerResponse;
        await (bridge as unknown as { handleRequest: (a: IncomingMessage, b: ServerResponse) => Promise<void> }).handleRequest(readable, response);
        expect(out.status).toBe(200);
      });
      expectOnlyTheScriptCall(sent, 'Echo', 'from the bridge');
    });
  });
});
