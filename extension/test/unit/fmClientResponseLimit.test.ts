import { describe, expect, it, vi } from 'vitest';

import { FMClient } from '../../src/services/fmClient';
import { SecretStore } from '../../src/services/secretStore';
import { createAxiosResponse, InMemorySecretStorage } from './mocks';

class FakeAxios {
  public readonly request = vi.fn();
}

const profile = {
  id: 'p',
  name: 'Dev',
  authMode: 'direct' as const,
  serverUrl: 'https://fm.example.com',
  database: 'DB',
  username: 'u',
  apiBasePath: '/fmi/data',
  apiVersionPath: 'vLatest'
};

async function run(call: (client: FMClient) => Promise<unknown>, responses: unknown[]): Promise<FakeAxios> {
  const axios = new FakeAxios();
  const secretStore = new SecretStore(new InMemorySecretStorage() as never);
  await secretStore.setPassword('p', 'pw');
  axios.request.mockResolvedValueOnce(createAxiosResponse({ data: { response: { token: 't' }, messages: [] } }));
  for (const response of responses) {
    axios.request.mockResolvedValueOnce(createAxiosResponse({ data: { response, messages: [{ code: '0', message: 'OK' }] } }));
  }
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  await call(new FMClient(secretStore, logger, 5000, axios as never));
  return axios;
}

describe('FMClient response size limit (used by the AI tools)', () => {
  it('sets maxContentLength on list, get and find calls when asked, and uses the default otherwise', async () => {
    const limited = await run(
      async (client) => {
        await client.listLayouts(profile, { maxResponseBytes: 1234 } as never);
        await client.getRecord(profile, 'L', '1', { maxResponseBytes: 1234 } as never);
        await client.findRecords(profile, 'L', { query: [{ a: 'b' }] }, { maxResponseBytes: 1234 } as never);
        await client.listScripts(profile, { maxResponseBytes: 1234 } as never);
      },
      [{ layouts: [] }, { data: [{ recordId: '1', fieldData: {} }] }, { data: [] }, { scripts: [] }]
    );
    const configs = limited.request.mock.calls.slice(1).map((call) => call[0] as Record<string, unknown>);
    expect(configs).toHaveLength(4);
    expect(configs.every((config) => config.maxContentLength === 1234)).toBe(true);

    const plain = await run((client) => client.listLayouts(profile), [{ layouts: [] }]);
    expect((plain.request.mock.calls[1]?.[0] as Record<string, unknown>).maxContentLength).toBe(64 * 1024 * 1024);
  });
});
