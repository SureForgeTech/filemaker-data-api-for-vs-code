import { describe, expect, it, vi } from 'vitest';

import { selectErrorActions } from '../../src/utils/errorUx';
import { normalizeError } from '../../src/utils/normalizeError';
import { isRetryableConnectError } from '../../src/commands';
import { FMClient, MAX_SCRIPT_URL_LENGTH } from '../../src/services/fmClient';
import { SecretStore } from '../../src/services/secretStore';
import type { ConnectionProfile } from '../../src/types/fm';
import { createAxiosResponse, InMemorySecretStorage } from './mocks';

class FakeAxios {
  public readonly request = vi.fn();
}

function createProfile(): ConnectionProfile {
  return {
    id: 'profile-1',
    name: 'Dev',
    authMode: 'direct',
    serverUrl: 'https://fm.example.com',
    database: 'TestDB',
    username: 'admin',
    apiBasePath: '/fmi/data',
    apiVersionPath: 'vLatest'
  };
}

describe('FMClient (unit)', () => {
  it.each([
    { recordId: ' ', fileName: 'photo.png', content: Buffer.from('x'), message: 'Record ID is required' },
    { recordId: '1', fileName: ' ', content: Buffer.from('x'), message: 'Upload file name is required' },
    { recordId: '1', fileName: 'photo.png', content: Buffer.alloc(0), message: 'Upload file is empty' },
    { recordId: '1', fileName: 'photo.png', content: Buffer.from('xx'), maxBytes: 1, message: 'exceeds the configured limit' }
  ])('refuses an invalid container upload before signing in: $message', async ({ recordId, fileName, content, maxBytes, message }) => {
    const http = new FakeAxios();
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    const client = new FMClient(secrets, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, 3000, http as never);
    await expect(client.uploadContainer(createProfile(), ' Exact layout ', recordId, ' Photo ', { fileName, content }, { maxBytes }))
      .rejects.toThrow(message);
    expect(http.request).not.toHaveBeenCalled();
  });

  describe('verified script parameter carriers', () => {
    const layout = ' Exact/Layout ü ';
    const textName = ' Table::First text / ü ';
    const noRecordsMessage = 'The script did not run because this layout has no records. Add a record or use a layout that has records.';
    const tooLongMessage = 'This parameter is too long to send. Shorten it or run the script from a layout with a text field';
    const reply = (response: Record<string, unknown>, code = '0', status = 200) => ({
      ...createAxiosResponse({ data: { response, messages: [{ code, message: code === '0' ? 'OK' : 'No records match the request' }] } }), status
    });
    async function harness(fields: unknown[] = [{ name: 'Number', result: 'number', type: 'text' }, { name: textName, result: 'text', type: 'normal' }, { name: 'Second text', result: 'text' }]) {
      const secrets = new SecretStore(new InMemorySecretStorage() as never);
      const profile = createProfile();
      await secrets.setSessionToken(profile.id, 'tok');
      const http = new FakeAxios();
      http.request.mockResolvedValue(reply({ scriptError: '0', scriptResult: 'done', data: [{ fieldData: { Private: 'hidden' } }], dataInfo: { foundCount: 1 } }));
      http.request.mockResolvedValueOnce(reply({ fieldMetaData: fields }));
      const client = new FMClient(secrets, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, 3000, http as never);
      return { client, profile, http };
    }

    it.each([false, true])('uses the first text result field exactly, limit 1 and a body parameter (cached=%s)', async (cached) => {
      const h = await harness();
      if (cached) await h.client.getLayoutMetadata(h.profile, layout);
      const signal = new AbortController().signal;
      const scriptParam = 'é|& +'.repeat(600);
      const result = await h.client.runScript(h.profile, { layout, scriptName: ' Echo/ü ', scriptParam }, { signal });
      expect(h.http.request).toHaveBeenCalledTimes(2);
      expect(h.http.request.mock.calls[0]?.[0]).toMatchObject({ method: 'GET', url: expect.stringContaining(`/layouts/${encodeURIComponent(layout)}`) });
      expect(h.http.request.mock.calls[1]?.[0]).toMatchObject({
        method: 'POST', url: expect.stringContaining(`/layouts/${encodeURIComponent(layout)}/_find`), signal,
        data: { query: [{ [textName]: '*' }], limit: 1, script: ' Echo/ü ', 'script.param': scriptParam }
      });
      expect(h.http.request.mock.calls[1]?.[0].params).toBeUndefined();
      expect(result.response).toEqual({ scriptError: '0', scriptResult: 'done' });
    });

    it.each([200, 404, 500])('confirms an empty layout after a no-match find on HTTP %s without running another script', async (status) => {
      const h = await harness();
      h.http.request.mockResolvedValueOnce(reply({}, '401', status)).mockResolvedValueOnce(reply({}, '401', status));
      await expect(h.client.runScript(h.profile, { layout, scriptName: 'Echo', scriptParam: 'x'.repeat(3000) }))
        .rejects.toMatchObject({ code: '401', message: noRecordsMessage, isRetryable: false });
      expect(h.http.request).toHaveBeenCalledTimes(3);
      expect(h.http.request.mock.calls.at(-1)?.[0]).toMatchObject({ method: 'GET', params: { _limit: 1 } });
    });

    it('chooses a normal stored text field ahead of global, summary and calculated results, preserving its name', async () => {
      const h = await harness([
        { name: 'Type omitted', result: 'TEXT' },
        { name: 'Global', type: 'NORMAL', result: 'TEXT', global: true },
        { name: 'Summary', type: 'SUMMARY', result: 'TEXT' },
        { name: 'Calculation', type: 'CALCULATION', result: 'TEXT' },
        { name: 'Global type', type: 'GLOBAL', result: 'TEXT' },
        { name: textName, type: 'NORMAL', result: 'TEXT', global: false }
      ]);
      await h.client.runScript(h.profile, { layout, scriptName: ' Echo ', scriptParam: 'x'.repeat(3000) });
      expect(h.http.request.mock.calls[1]?.[0].data.query).toEqual([{ [textName]: '*' }]);
    });

    it.each(['0', 0])('accepts a confirmed find with empty data (scriptError=%s) without a probe', async (scriptError) => {
      const h = await harness([{ name: textName, result: 'text' }]);
      h.http.request.mockResolvedValueOnce(reply({ data: [], scriptResult: 'ran', scriptError }));
      await expect(h.client.runScript(h.profile, { layout, scriptName: 'Echo', scriptParam: 'x'.repeat(3000) }))
        .resolves.toMatchObject({ response: { scriptResult: 'ran', scriptError } });
      expect(h.http.request).toHaveBeenCalledTimes(2);
      expect(h.http.request.mock.calls[1]?.[0]).toMatchObject({ method: 'POST', data: { query: [{ [textName]: '*' }] } });
    });

    it.each([[], [{ recordId: '1', fieldData: {} }]].map((data) => ({ data })))('does not confirm or probe a find without scriptError (data=$data)', async ({ data }) => {
      const h = await harness();
      h.http.request.mockResolvedValueOnce(reply({ data, scriptResult: 'unconfirmed' }));
      await expect(h.client.runScript(h.profile, { layout, scriptName: 'Echo', scriptParam: 'x'.repeat(3000) }))
        .rejects.toMatchObject({ code: 'SCRIPT_NOT_CONFIRMED', isRetryable: false });
      expect(h.http.request).toHaveBeenCalledTimes(2);
    });

    it('uses the endpoint at the limit, then a find over it with metadata fetched only once', async () => {
      const h = await harness([{ name: textName, result: 'text' }]);
      h.http.request.mockReset().mockResolvedValue(reply({ scriptError: '0', scriptResult: 'done' }));
      const prefix = `${h.profile.serverUrl}/fmi/data/vLatest/databases/TestDB/layouts/L/script/S?script.param=`.length;
      await h.client.runScript(h.profile, { layout: 'L', scriptName: 'S', scriptParam: 'x'.repeat(MAX_SCRIPT_URL_LENGTH - prefix) });
      h.http.request.mockResolvedValueOnce(reply({ fieldMetaData: [{ name: textName, result: 'text' }] }));
      for (const extra of [1, 2]) {
        await h.client.runScript(h.profile, { layout: 'L', scriptName: 'S', scriptParam: 'x'.repeat(MAX_SCRIPT_URL_LENGTH - prefix + extra) });
      }
      expect(h.http.request.mock.calls.map(([config]) => config.method)).toEqual(['GET', 'GET', 'POST', 'POST']);
      expect(h.http.request.mock.calls.filter(([config]) => config.url.endsWith('/records'))).toHaveLength(0);
    });

    it.each([
      { name: 'Global', type: 'NORMAL', result: 'TEXT', global: true },
      { name: 'Global', type: 'NORMAL', result: 'TEXT', global: 'true' },
      { name: 'Summary', type: 'SUMMARY', result: 'TEXT' },
      { name: 'Calculation', type: 'CALCULATION', result: 'TEXT' },
      { name: 'Global type', type: 'GLOBAL', result: 'TEXT' }
    ])('uses the bounded read or clear length error when the only text field is $type / $global', async (field) => {
      const h = await harness([field]);
      await expect(h.client.runScript(h.profile, { layout, scriptName: 'Echo', scriptParam: 'x'.repeat(3000) }))
        .rejects.toMatchObject({ code: 'SCRIPT_PARAMETER_TOO_LONG', message: tooLongMessage });
      expect(h.http.request.mock.calls.map(([config]) => config.method)).toEqual(['GET', 'GET']);
      expect(h.http.request.mock.calls.at(-1)?.[0].params).toEqual({ _limit: 1 });
    });

    it('does not call a layout empty when its first stored text field has no non-empty values', async () => {
      const h = await harness();
      h.http.request.mockResolvedValueOnce(reply({}, '401'));
      h.http.request.mockResolvedValueOnce(reply({ data: [{ recordId: '1', fieldData: { [textName]: '' } }] }));
      await expect(h.client.runScript(h.profile, { layout, scriptName: 'Echo', scriptParam: 'x'.repeat(3000) }))
        .rejects.toMatchObject({ code: 'SCRIPT_PARAMETER_TOO_LONG', message: tooLongMessage });
      expect(h.http.request.mock.calls.at(-1)?.[0]).toMatchObject({ method: 'GET', params: { _limit: 1 } });
      expect(h.http.request.mock.calls.filter(([config]) => config.data?.script)).toHaveLength(1);
    });

    it.each([200, 404, 500])('explains an empty no-text-field layout on HTTP %s instead of raw 401', async (status) => {
      const h = await harness([]);
      h.http.request.mockResolvedValueOnce(reply({}, '401', status));
      await expect(h.client.runScript(h.profile, { layout, scriptName: 'Long name'.repeat(40), scriptParam: 'x'.repeat(1500) }))
        .rejects.toMatchObject({ code: '401', message: noRecordsMessage });
    });

    it('explains an empty no-text-field layout when a bounded read returns empty data', async () => {
      const h = await harness([]);
      h.http.request.mockResolvedValueOnce(reply({ data: [] }));
      await expect(h.client.runScript(h.profile, { layout, scriptName: 'Echo', scriptParam: 'x'.repeat(3000) }))
        .rejects.toMatchObject({ code: '401', message: noRecordsMessage });
      expect(h.http.request).toHaveBeenCalledTimes(2);
      expect(h.http.request.mock.calls[1]?.[0]).toMatchObject({ method: 'GET', params: { _limit: 1 } });
    });

    it('an unsupported endpoint followed by an empty layout reports not run, not unsupported', async () => {
      const h = await harness();
      h.http.request.mockReset().mockRejectedValueOnce({ isAxiosError: true, response: { status: 405 } }).mockResolvedValueOnce(reply({}, '401', 500));
      await expect(h.client.runScript(h.profile, { layout, scriptName: 'Echo' }))
        .rejects.toMatchObject({ code: '401', message: noRecordsMessage });
    });

    it('preserves other find errors without attempting the script again', async () => {
      const h = await harness();
      h.http.request.mockResolvedValueOnce(reply({}, '102', 500));
      await expect(h.client.runScript(h.profile, { layout, scriptName: 'Echo', scriptParam: 'x'.repeat(3000) }))
        .rejects.toMatchObject({ code: '102' });
      expect(h.http.request).toHaveBeenCalledTimes(2);
    });

    it.each([[], [{ name: 'Only number', type: 'text', result: 'number' }], [{ name: 'Unknown', result: 42 }]].map((fields) => ({ fields })))('refuses an unsafe URL without a text result field: $fields', async ({ fields }) => {
      const h = await harness(fields);
      await expect(h.client.runScript(h.profile, { layout, scriptName: 'Echo', scriptParam: 'x'.repeat(3000) }))
        .rejects.toMatchObject({ code: 'SCRIPT_PARAMETER_TOO_LONG', message: tooLongMessage });
      expect(h.http.request).toHaveBeenCalledTimes(2);
    });

    it('without text fields uses GET records only within the encoded URL limit, and refuses one character more', async () => {
      const h = await harness([]);
      const scriptName = 'Long script name ü'.repeat(8);
      h.http.request.mockReset().mockRejectedValueOnce({ isAxiosError: true, response: { status: 405 } }).mockResolvedValue(reply({ scriptError: '0', scriptResult: 'done' }));
      const recordsUrl = `${h.profile.serverUrl}/fmi/data/vLatest/databases/TestDB/layouts/L/records`;
      const prefix = `${recordsUrl}?_limit=1&script=${encodeURIComponent(scriptName)}&script.param=`;
      const scriptParam = 'x'.repeat(MAX_SCRIPT_URL_LENGTH - prefix.length);
      expect(scriptParam.length).toBeGreaterThan(1500);
      const result = await h.client.runScript(h.profile, { layout: 'L', scriptName, scriptParam });
      expect(result.response).toEqual({ scriptError: '0', scriptResult: 'done' });
      const sent = h.http.request.mock.calls.at(-1)?.[0];
      expect(sent).toMatchObject({ method: 'GET', url: recordsUrl, params: { _limit: 1, script: scriptName, 'script.param': scriptParam } });
      expect(`${prefix}${scriptParam}`).toHaveLength(MAX_SCRIPT_URL_LENGTH);
      h.http.request.mockRejectedValueOnce({ isAxiosError: true, response: { status: 405 } });
      await expect(h.client.runScript(h.profile, { layout: 'L', scriptName, scriptParam: scriptParam + 'x' }))
        .rejects.toMatchObject({ code: 'SCRIPT_PARAMETER_TOO_LONG', message: tooLongMessage });
      expect(h.http.request).toHaveBeenCalledTimes(3);
    });

    it.each(['endpoint', 'find', 'record', 'records', 'proxy'])('requires scriptError from the %s carrier even when scriptResult exists', async (carrier) => {
      const h = await harness();
      h.http.request.mockReset().mockResolvedValue(reply({ scriptResult: 'unconfirmed' }));
      if (carrier === 'find') h.http.request.mockResolvedValueOnce(reply({ fieldMetaData: [{ name: textName, result: 'text', type: 'normal' }] }));
      if (carrier === 'records') h.http.request.mockRejectedValueOnce({ isAxiosError: true, response: { status: 405 } });
      const proxy = { runScript: vi.fn(async () => ({ response: { scriptResult: 'unconfirmed' }, messages: [{ code: '0', message: 'OK' }] })) };
      if (carrier === 'proxy') h.client = new FMClient(new SecretStore(new InMemorySecretStorage() as never), { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, 3000, h.http as never, proxy as never);
      await expect(h.client.runScript({ ...h.profile, authMode: carrier === 'proxy' ? 'proxy' : 'direct' }, {
        layout, scriptName: 'Echo', scriptParam: carrier === 'find' ? 'x'.repeat(3000) : 'short', recordId: carrier === 'record' ? '12' : undefined
      })).rejects.toMatchObject({ code: 'SCRIPT_NOT_CONFIRMED', isRetryable: false, message: expect.stringContaining('no scriptError') });
      expect(h.http.request).toHaveBeenCalledTimes(carrier === 'proxy' ? 0 : ['find', 'records'].includes(carrier) ? 2 : 1);
    });
  });

  it.each((['direct', 'proxy'] as const).flatMap((authMode) => [
    { operation: 'createSession', uncertain: false, call: (client: FMClient, profile: ConnectionProfile) => client.createSession(profile) },
    { operation: 'deleteSession', uncertain: false, call: (client: FMClient, profile: ConnectionProfile) => client.deleteSession(profile) },
    { operation: 'findRecords', uncertain: false, call: (client: FMClient, profile: ConnectionProfile) => client.findRecords(profile, 'Contacts', { query: [{ Name: '*' }] }) },
    { operation: 'getLayoutMetadata', uncertain: false, call: (client: FMClient, profile: ConnectionProfile) => client.getLayoutMetadata(profile, 'Contacts') },
    { operation: 'createRecord', uncertain: true, call: (client: FMClient, profile: ConnectionProfile) => client.createRecord(profile, 'Contacts', {}) },
    { operation: 'editRecord', uncertain: true, call: (client: FMClient, profile: ConnectionProfile) => client.editRecord(profile, 'Contacts', '1', { Name: 'Changed' }) },
    { operation: 'deleteRecord', uncertain: true, call: (client: FMClient, profile: ConnectionProfile) => client.deleteRecord(profile, 'Contacts', '1') },
    { operation: 'uploadContainer', uncertain: true, call: (client: FMClient, profile: ConnectionProfile) => client.uploadContainer(profile, 'Contacts', '1', 'Photo', { fileName: 'photo.png', content: Buffer.from('photo'), contentType: 'image/png' }) },
    { operation: 'runScript', uncertain: true, call: (client: FMClient, profile: ConnectionProfile) => client.runScript(profile, { layout: 'Contacts', scriptName: 'Slow' }) },
    ...(['script', 'script.prerequest', 'script.presort'] as const).map((key) => ({
      operation: `findRecords with ${key}`, uncertain: true,
      call: (client: FMClient, profile: ConnectionProfile) => client.findRecords(profile, 'Contacts', { query: [{ Name: '*' }], [key]: 'Slow' })
    }))
  ].map((test) => ({ authMode, ...test }))))('classifies $authMode $operation timeout by the logical request', async ({ authMode, operation, uncertain, call }) => {
    // Some adapters omit axios config on errors; the recorded request must suffice.
    const timeout = { isAxiosError: true, code: 'ECONNABORTED', message: 'timeout' };
    const axios = { request: vi.fn().mockRejectedValue(timeout), post: vi.fn().mockRejectedValue(timeout) };
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    const profile = { ...createProfile(), authMode, proxyEndpoint: 'https://proxy.example/api' };
    await secrets.setPassword(profile.id, 'password');
    await secrets.setSessionToken(profile.id, 'token');
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const client = new FMClient(secrets, logger, 1500, axios as never);
    const result = await call(client, profile).then(() => undefined, (error: unknown) => error);
    const error = operation === 'deleteSession'
      ? logger.warn.mock.calls.find(([message]) => message === 'Failed to delete session cleanly during disconnect.')?.[1]?.error
      : result;
    expect(error).toMatchObject({ kind: 'timeout', isRetryable: !uncertain });
    expect((error as Error).message.includes('The change may have been applied. Check the record before trying again.')).toBe(uncertain);
    expect((error as Error).message).toContain('filemaker.requestTimeoutMs');
    if (operation === 'createSession') expect(isRetryableConnectError(error)).toBe(true);
    expect(selectErrorActions(normalizeError(error), { retry: vi.fn() }).includes('Retry')).toBe(!uncertain);
    if (operation.startsWith('findRecords with ') && authMode === 'direct') {
      const key = operation.slice('findRecords with '.length);
      expect(axios.request).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ [key]: 'Slow' }) }));
    }
  });

  it.each((['direct', 'proxy'] as const).flatMap((authMode) =>
    (['editRecord', 'createRecord'] as const).flatMap((operation) =>
      ['A\0B', 'A\0B\0C', ['A\0B\0C'], { nested: 'A\0B\0C' }].map((value) => ({ authMode, operation, value }))
    )
  ))('refuses NUL before any $authMode $operation request: $value', async ({ authMode, operation, value }) => {
    const axios = new FakeAxios();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    const proxy = { editRecord: vi.fn(), createRecord: vi.fn() };
    const client = new FMClient(secrets, logger, 15_000, axios as never, proxy as never);
    const profile = { ...createProfile(), authMode };
    const fields = { Name: value };
    const pending = operation === 'editRecord'
      ? client.editRecord(profile, 'Contacts', '1', fields)
      : client.createRecord(profile, 'Contacts', fields);
    await expect(pending).rejects.toMatchObject({ status: 400, isRetryable: false, message: expect.stringContaining('NUL character (U+0000) in field(s): Name.') });
    expect(axios.request).not.toHaveBeenCalled();
    expect(proxy.editRecord).not.toHaveBeenCalled();
    expect(proxy.createRecord).not.toHaveBeenCalled();
  });

  it.each([false, true])('omits ancillary metadata history (failure=%s) while retaining record history, metrics and normal metadata history', async (failMetadata) => {
    const axios = new FakeAxios();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    const profile = createProfile();
    await secrets.setSessionToken(profile.id, 'token');
    const response = (data: unknown) => createAxiosResponse({ data: { response: data, messages: [{ code: '0', message: 'OK' }] } });
    axios.request.mockResolvedValue(response({ fieldMetaData: [] }));
    const history = { record: vi.fn(async () => undefined) };
    const metrics = { record: vi.fn(async () => undefined) };
    const client = new FMClient(secrets, logger, 15_000, axios as never, undefined, history, metrics);
    if (failMetadata) axios.request.mockRejectedValueOnce(new Error('metadata failed'));
    const lookup = client.getLayoutMetadata(profile, ' Exact layout ', { recordHistory: false });
    if (failMetadata) await expect(lookup).rejects.toThrow('metadata failed');
    else await lookup;
    expect(history.record).not.toHaveBeenCalled();
    expect(metrics.record).toHaveBeenCalledWith(expect.objectContaining({ operation: 'getLayoutMetadata', success: !failMetadata }));
    axios.request.mockResolvedValueOnce(response({ data: [{ recordId: '1', fieldData: { Value: ' exact ' } }] }));
    await client.getRecord(profile, ' Exact layout ', '1');
    expect(history.record).toHaveBeenCalledTimes(1);
    expect(history.record).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'getRecord', layout: ' Exact layout ' }));
    await client.getLayoutMetadata(profile, ' Exact layout ');
    expect(history.record).toHaveBeenCalledTimes(2);
    expect(history.record).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'getLayoutMetadata' }));
  });

  it('constructs authenticated request headers for Data API calls', async () => {
    const axios = new FakeAxios();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const secretStore = new SecretStore(new InMemorySecretStorage() as never);
    const profile = createProfile();

    await secretStore.setPassword(profile.id, 'pass');

    axios.request
      .mockResolvedValueOnce(createAxiosResponse({
        data: {
          response: {
            token: 'token-a'
          },
          messages: [{ code: '0', message: 'OK' }]
        }
      }))
      .mockResolvedValueOnce(createAxiosResponse({
        data: {
          response: {
            layouts: [{ name: 'Contacts' }]
          },
          messages: [{ code: '0', message: 'OK' }]
        }
      }));

    const client = new FMClient(secretStore, logger, 15_000, axios as never);
    await client.listLayouts(profile);

    expect(axios.request).toHaveBeenCalledTimes(2);
    const listRequest = axios.request.mock.calls[1]?.[0] as Record<string, unknown>;
    const headers = listRequest.headers as Record<string, string>;
    expect(String(listRequest.url)).toContain('/fmi/data/vLatest/databases/TestDB/layouts');
    expect(headers.Authorization).toBe('Bearer token-a');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('maps FileMaker error payloads to helpful errors', async () => {
    const axios = new FakeAxios();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const secretStore = new SecretStore(new InMemorySecretStorage() as never);
    const profile = createProfile();

    await secretStore.setPassword(profile.id, 'pass');

    axios.request
      .mockResolvedValueOnce(createAxiosResponse({
        data: {
          response: {
            token: 'token-a'
          },
          messages: [{ code: '0', message: 'OK' }]
        }
      }))
      .mockRejectedValueOnce({
        isAxiosError: true,
        message: 'Request failed with status code 500',
        response: {
          status: 500,
          data: {
            messages: [{ code: '500', message: 'Internal server error' }]
          }
        }
      });

    const client = new FMClient(secretStore, logger, 15_000, axios as never);

    await expect(client.listLayouts(profile)).rejects.toThrow(
      'FileMaker API error (HTTP 500) [500]'
    );
  });

  it('re-authenticates once on 401 and retries request', async () => {
    const axios = new FakeAxios();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const secretStore = new SecretStore(new InMemorySecretStorage() as never);
    const profile = createProfile();

    await secretStore.setPassword(profile.id, 'pass');

    axios.request
      .mockResolvedValueOnce(createAxiosResponse({
        data: {
          response: {
            token: 'old-token'
          },
          messages: [{ code: '0', message: 'OK' }]
        }
      }))
      .mockRejectedValueOnce({
        isAxiosError: true,
        message: 'Unauthorized',
        response: {
          status: 401,
          data: {
            messages: [{ code: '952', message: 'Invalid token' }]
          }
        }
      })
      .mockResolvedValueOnce(createAxiosResponse({
        data: {
          response: {
            token: 'new-token'
          },
          messages: [{ code: '0', message: 'OK' }]
        }
      }))
      .mockResolvedValueOnce(createAxiosResponse({ data: { response: {}, messages: [{ code: '0', message: 'OK' }] } }))
      .mockResolvedValueOnce(createAxiosResponse({
        data: {
          response: {
            layouts: [{ name: 'Contacts' }]
          },
          messages: [{ code: '0', message: 'OK' }]
        }
      }));

    const client = new FMClient(secretStore, logger, 15_000, axios as never);

    await expect(client.listLayouts(profile)).resolves.toEqual(['Contacts']);
    await expect(secretStore.getSessionToken(profile.id)).resolves.toBe('new-token');
    expect(axios.request).toHaveBeenCalledTimes(5);
  });

  it.each([
    ['image upload', 'photo.png', 'image/png'],
    ['PDF upload', 'report.pdf', 'application/pdf'],
    ['binary upload', 'archive.bin', 'application/octet-stream']
  ])(
    'uploads container data as multipart form-data for %s',
    async (_label, fileName, contentType) => {
      const axios = new FakeAxios();
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      };
      const secretStore = new SecretStore(new InMemorySecretStorage() as never);
      const profile = createProfile();

      await secretStore.setSessionToken(profile.id, 'token-a');

      axios.request.mockResolvedValueOnce(createAxiosResponse({
        data: {
          response: {},
          messages: [{ code: '0', message: 'OK' }]
        }
      }));

      const client = new FMClient(secretStore, logger, 15_000, axios as never);
      const result = await client.uploadContainer(
        profile,
        'Contacts',
        '42',
        'Attachment',
        {
          fileName,
          content: Buffer.from(`content:${fileName}`, 'utf8'),
          contentType
        },
        {
          maxBytes: 1024
        }
      );

      expect(result.recordId).toBe('42');
      expect(axios.request).toHaveBeenCalledTimes(1);

      const uploadRequest = axios.request.mock.calls[0]?.[0] as Record<string, unknown>;
      const headers = uploadRequest.headers as Record<string, string>;
      const body = uploadRequest.data as Buffer;

      expect(String(uploadRequest.url)).toContain(
        '/fmi/data/vLatest/databases/TestDB/layouts/Contacts/records/42/containers/Attachment/1'
      );
      expect(headers.Authorization).toBe('Bearer token-a');
      expect(headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
      expect(headers['Content-Length']).toBe(String(body.byteLength));
      expect(body.toString('utf8')).toContain('name="upload"');
      expect(body.toString('utf8')).toContain(`filename="${fileName}"`);
      expect(body.toString('utf8')).toContain(`Content-Type: ${contentType}`);
      expect(body.toString('utf8')).toContain(`content:${fileName}`);
    }
  );

  it('rejects container uploads larger than the configured limit before sending a request', async () => {
    const axios = new FakeAxios();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const secretStore = new SecretStore(new InMemorySecretStorage() as never);
    const profile = createProfile();
    const client = new FMClient(secretStore, logger, 15_000, axios as never);

    await expect(
      client.uploadContainer(
        profile,
        'Contacts',
        '42',
        'Attachment',
        {
          fileName: 'too-large.bin',
          content: Buffer.alloc(11),
          contentType: 'application/octet-stream'
        },
        {
          maxBytes: 10
        }
      )
    ).rejects.toThrow('Container upload exceeds the configured limit');

    expect(axios.request).not.toHaveBeenCalled();
  });
});

it.each([200, 404, 500])('preserves foundCount for an empty page with FileMaker 401 on HTTP %s', async (status) => {
  const axios = new FakeAxios();
  const secrets = new SecretStore(new InMemorySecretStorage() as never);
  const profile = createProfile();
  await secrets.setSessionToken(profile.id, 'token');
  const data = { response: { data: [], dataInfo: { foundCount: 157, returnedCount: 0, totalRecordCount: 200 } }, messages: [{ code: '401', message: 'No records match' }] };
  if (status === 200) axios.request.mockResolvedValueOnce(createAxiosResponse({ data }));
  else axios.request.mockRejectedValueOnce({ isAxiosError: true, response: { status, data } });
  const client = new FMClient(secrets, { debug() {}, info() {}, warn() {}, error() {} }, 15_000, axios as never);
  const result = await client.findRecords(profile, 'Contacts', { query: [{ Name: '*' }], offset: 158 });
  expect(result).toEqual({ data: [], dataInfo: { foundCount: 157, returnedCount: 0, totalRecordCount: 200 } });
});

describe('record portal totals', () => {
  it.each(['record', 'dataInfo', 'response'] as const)('preserves portalDataInfo supplied on %s in getRecord and findRecords', async (where) => {
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    const profile = createProfile();
    await secrets.setSessionToken(profile.id, 'token');
    const info = [{ portalObjectName: ' Lines ', foundCount: 60, returnedCount: 20 }];
    const record = { recordId: '1', fieldData: {}, portalData: { ' Lines ': [] }, ...(where === 'record' ? { portalDataInfo: info } : {}) };
    const axios = new FakeAxios();
    axios.request.mockResolvedValue(createAxiosResponse({ data: { response: { data: [record], ...(where === 'dataInfo' ? { dataInfo: { portalDataInfo: info } } : {}), ...(where === 'response' ? { portalDataInfo: info } : {}) }, messages: [{ code: '0', message: 'OK' }] } }));
    const client = new FMClient(secrets, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, 1500, axios as never);
    expect(await client.getRecord(profile, ' Contacts ', '1')).toMatchObject({ portalDataInfo: info });
    expect(await client.findRecords(profile, ' Contacts ', { query: [{ Name: '*' }] })).toMatchObject({ data: [{ portalDataInfo: info }] });
  });
});

it.each(['dataInfo', 'response'] as const)('does not copy first-record %s portal counts onto multiple find records', async (where) => {
  const secrets = new SecretStore(new InMemorySecretStorage() as never);
  const profile = createProfile(); await secrets.setSessionToken(profile.id, 'tok');
  const first = [{ portalObjectName: ' Lines ', foundCount: 80, returnedCount: 50 }];
  const second = [{ portalObjectName: ' Lines ', foundCount: 2, returnedCount: 2 }];
  const data = [{ recordId: '1', fieldData: {} }, { recordId: '2', fieldData: {}, portalDataInfo: second }, { recordId: '3', fieldData: {} }];
  const http = new FakeAxios(); http.request.mockResolvedValue(createAxiosResponse({ data: { response: { data,
    ...(where === 'dataInfo' ? { dataInfo: { portalDataInfo: first } } : { portalDataInfo: first }) }, messages: [{ code: '0', message: 'OK' }] } }));
  const client = new FMClient(secrets, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, 1500, http as never);
  const result = await client.findRecords(profile, ' Exact ', { query: [{ ' Name ': '*' }] });
  expect(result.data.map((record) => record.portalDataInfo)).toEqual([undefined, second, undefined]);
});

describe('createRecord with related (portal) rows', () => {
  it('posts fieldData and portalData together with a direct connection', async () => {
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    const profile = createProfile();
    await secrets.setSessionToken(profile.id, 'tok');
    const http = new FakeAxios();
    http.request.mockResolvedValue(createAxiosResponse({ data: { response: { recordId: '501', modId: '1' }, messages: [{ code: '0', message: 'OK' }] } }));
    const client = new FMClient(secrets, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, 1500, http as never);

    const result = await client.createRecord(profile, ' Contacts ', { Name: 'Ada' }, undefined, {
      portalData: { Orders: [{ 'Orders::Total': 10 }, { Total: 2 }] }
    });

    expect(http.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      url: expect.stringContaining(`/layouts/${encodeURIComponent(' Contacts ')}/records`),
      data: {
        fieldData: { Name: 'Ada' },
        portalData: { Orders: [{ 'Orders::Total': 10 }, { Total: 2 }] }
      }
    }));
    expect(result).toMatchObject({ recordId: '501', modId: '1' });
  });

  it('keeps the plain create request when the portal rows carry no values', async () => {
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    const profile = createProfile();
    await secrets.setSessionToken(profile.id, 'tok');
    const http = new FakeAxios();
    http.request.mockResolvedValue(createAxiosResponse({ data: { response: { recordId: '1' }, messages: [{ code: '0', message: 'OK' }] } }));
    const client = new FMClient(secrets, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, 1500, http as never);

    await client.createRecord(profile, 'Contacts', { Name: 'Ada' }, undefined, { portalData: { Orders: [{}] } });

    const [config] = http.request.mock.calls[0]!;
    expect(config.data).toEqual({ fieldData: { Name: 'Ada' } });
  });

  it('refuses portal rows through a proxy profile before calling either endpoint', async () => {
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    const profile = { ...createProfile(), authMode: 'proxy' as const, proxyEndpoint: 'https://proxy.example/api' };
    const http = new FakeAxios();
    const proxy = { createRecord: vi.fn(), editRecord: vi.fn() };
    const client = new FMClient(secrets, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, 1500, http as never, proxy as never);

    await expect(
      client.createRecord(profile, 'Contacts', { Name: 'Ada' }, undefined, { portalData: { Orders: [{ Total: 1 }] } })
    ).rejects.toMatchObject({ message: expect.stringContaining('not supported through a proxy connection'), isRetryable: false });
    expect(proxy.createRecord).not.toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
  });

  it.each([
    [[{ recordId: '9' }], 'recordId'],
    [[{ modId: '1' }], 'recordId'],
    [[{ Total: { nested: 1 } }], 'non-text value'],
    ['not rows', 'must be an array'],
    [new Array(101).fill({ Total: 1 }), 'at most']
  ])('refuses invalid portal rows before any request: %j', async (rows, messagePart) => {
    const secrets = new SecretStore(new InMemorySecretStorage() as never);
    const profile = createProfile();
    await secrets.setSessionToken(profile.id, 'tok');
    const http = new FakeAxios();
    const client = new FMClient(secrets, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, 1500, http as never);

    await expect(
      client.createRecord(profile, 'Contacts', { Name: 'Ada' }, undefined, { portalData: { Orders: rows as unknown as Array<Record<string, unknown>> } })
    ).rejects.toMatchObject({ status: 400, isRetryable: false, message: expect.stringContaining(messagePart) });
    expect(http.request).not.toHaveBeenCalled();
  });
});
