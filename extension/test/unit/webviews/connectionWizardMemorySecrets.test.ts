import { describe, expect, it, vi } from 'vitest';
import nock from 'nock';

import { FMClient } from '../../../src/services/fmClient';
import { SecretStore } from '../../../src/services/secretStore';
import { handleTestConnection } from '../../../src/webviews/connectionWizard/testConnection';
import type { WizardContext } from '../../../src/webviews/connectionWizard/context';
import { InMemorySecretStorage } from '../mocks';

const form = { name: 'Test', authMode: 'direct' as const, serverUrl: 'https://fm.example.test', database: 'Sales',
  username: 'tester', password: ' typed fixture ', apiBasePath: '/fmi/data', apiVersionPath: 'vLatest' };
const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };

it.each([false, true])('keeps typed passwords and session tokens out of real SecretStorage (login failure: %s)', async (fail) => {
  const storage = new InMemorySecretStorage();
  const secrets = new SecretStore(storage as never);
  await secrets.setPassword('live', 'saved fixture');
  await secrets.setSessionToken('live', 'live fixture');
  const writes = vi.spyOn(storage, 'store');
  const deletes = vi.spyOn(storage, 'delete');
  const client = new FMClient(secrets, logger);
  const create = client.createIsolatedClient.bind(client);
  let testId: string | undefined;
  const fork = vi.spyOn(client, 'createIsolatedClient').mockImplementation((temporary) => {
    const set = temporary.setPassword.bind(temporary);
    vi.spyOn(temporary, 'setPassword').mockImplementation(async (id, password) => { testId = id; await set(id, password); });
    return create(temporary);
  });
  const posted: Array<{ type: string }> = [];
  const ctx = {
    panel: { webview: { postMessage: async (message: { type: string }) => { posted.push(message); } } },
    secretStore: secrets, fmClient: client, logger, options: {}, certState: { legacy: false }, templateOrigins: new Set()
  } as unknown as WizardContext;
  const server = nock(form.serverUrl)
    .get('/fmi/data/vLatest/productInfo').reply(200, { response: { productInfo: { name: 'FileMaker Server', version: '21' } }, messages: [{ code: '0', message: 'OK' }] })
    .get('/fmi/data/vLatest/databases').reply(200, { response: { databases: [{ name: 'Sales' }] }, messages: [{ code: '0', message: 'OK' }] })
    .post('/fmi/data/vLatest/databases/Sales/sessions')
    .matchHeader('Authorization', `Basic ${Buffer.from('tester: typed fixture ').toString('base64')}`)
    .reply(fail ? 401 : 200, fail ? { messages: [{ code: '212', message: 'Rejected' }] } : { response: { token: 'test-session-fixture' }, messages: [{ code: '0', message: 'OK' }] });
  if (!fail) server.delete('/fmi/data/vLatest/databases/Sales/sessions/test-session-fixture')
    .matchHeader('Authorization', 'Bearer test-session-fixture')
    .reply(200, { response: {}, messages: [{ code: '0', message: 'OK' }] });

  await handleTestConnection(ctx, form);

  expect(posted).toContainEqual(expect.objectContaining({ type: fail ? 'testError' : 'testSuccess' }));
  expect(server.isDone()).toBe(true);
  expect(writes).not.toHaveBeenCalled();
  expect(deletes).not.toHaveBeenCalled();
  expect(await secrets.getPassword('live')).toBe('saved fixture');
  expect(await secrets.getSessionToken('live')).toBe('live fixture');
  const memory = fork.mock.calls[0]?.[0];
  expect(memory).toBeDefined();
  // Every temporary credential is gone even after a failed sign-in.
  expect(await memory!.getPassword(testId!)).toBeUndefined();
  expect(await memory!.getSessionToken(testId!)).toBeUndefined();
  writes.mockRestore(); deletes.mockRestore(); fork.mockRestore();
});

describe('proxy test credentials', () => {
  it('uses only the isolated secret store for a typed API key', async () => {
    const secrets = { setPassword: vi.fn(), setProxyApiKey: vi.fn(), deletePassword: vi.fn(), deleteProxyApiKey: vi.fn(), deleteSessionToken: vi.fn() };
    let id: string | undefined;
    let memory: SecretStore | undefined;
    const seen: string[] = [];
    const isolated = {
      createSession: vi.fn(async (profile: { id: string }) => {
        id = profile.id;
        seen.push((await memory!.getProxyApiKey(profile.id))!);
        await memory!.setSessionToken(profile.id, 'temporary-token');
      }),
      deleteSession: vi.fn(), forgetProfile: vi.fn()
    };
    const ctx = {
      panel: { webview: { postMessage: vi.fn() } }, secretStore: secrets, logger,
      fmClient: { createIsolatedClient: (temporary: SecretStore) => { memory = temporary; return isolated; } },
      options: {}, certState: { legacy: false }, templateOrigins: new Set()
    } as unknown as WizardContext;
    await handleTestConnection(ctx, { ...form, authMode: 'proxy', proxyEndpoint: 'https://proxy.example.test', proxyApiKey: ' typed key ' });
    expect(seen).toEqual([' typed key ']);
    for (const fn of Object.values(secrets)) expect(fn).not.toHaveBeenCalled();
    expect(await memory!.getProxyApiKey(id!)).toBeUndefined();
    expect(await memory!.getSessionToken(id!)).toBeUndefined();
    expect(isolated.deleteSession).toHaveBeenCalled();
    expect(isolated.forgetProfile).toHaveBeenCalledWith(id);
  });
});
