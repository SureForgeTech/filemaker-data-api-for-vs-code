import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import nock from 'nock';
import { describe, expect, it, vi } from 'vitest';

import { BatchService } from '../../src/services/batchService';
import { FMClient } from '../../src/services/fmClient';
import { SecretStore } from '../../src/services/secretStore';
import type { ConnectionProfile } from '../../src/types/fm';
import { InMemorySecretStorage } from '../unit/mocks';

const server = 'https://fm.local';
const apiBase = '/fmi/data/vLatest/databases/TestDB';

function createProfile(): ConnectionProfile {
  return {
    id: 'batch-profile',
    name: 'Batch',
    authMode: 'direct',
    serverUrl: server,
    database: 'TestDB',
    username: 'admin',
    apiBasePath: '/fmi/data',
    apiVersionPath: 'vLatest'
  };
}

async function createClient() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };

  const secretStore = new SecretStore(new InMemorySecretStorage() as never);
  await secretStore.setPassword('batch-profile', 'password123');

  return new FMClient(secretStore, logger, 5_000);
}

describe('batch export + update integration (mocked HTTP)', () => {
  it('exports exactly 200 CSV rows at the cap when the probe returns HTTP 500 / FileMaker 401 (N4)', async () => {
    const profile = createProfile();
    const client = await createClient();
    const root = await mkdtemp(join(tmpdir(), 'fm-batch-n4-'));
    const outputPath = join(root, 'big.csv');
    const scope = nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'batch-token' }, messages: [{ code: '0', message: 'OK' }] })
      .get(`${apiBase}/layouts/Big`)
      .reply(200, { response: { fieldMetaData: [{ name: 'Label', result: 'text' }] }, messages: [{ code: '0', message: 'OK' }] });
    for (const offset of [1, 101]) {
      scope.post(`${apiBase}/layouts/Big/_find`, { query: [{ Label: '*' }], limit: 100, offset })
        .reply(200, {
          response: { data: Array.from({ length: 100 }, (_, i) => ({ recordId: String(offset + i), modId: '0', fieldData: { Label: `row-${offset + i}` } })) },
          messages: [{ code: '0', message: 'OK' }]
        });
    }
    scope.post(`${apiBase}/layouts/Big/_find`, { query: [{ Label: '*' }], limit: 1, offset: 201 })
      .reply(500, { response: {}, messages: [{ code: '401', message: 'No records match the request' }] });
    try {
      const result = await new BatchService(client).batchExportFind(profile, 'Big', { query: [{ Label: '*' }] }, {
        outputPath, format: 'csv', maxRecords: 200
      });
      expect(result).toMatchObject({ exportedRecords: 200, truncated: false, format: 'csv' });
      const lines = (await readFile(outputPath, 'utf8')).trimEnd().split('\n');
      expect(lines).toHaveLength(201);
      expect(lines[0]).toBe('recordId,modId,Label');
      expect(lines[200]).toBe('200,0,row-200');
      scope.done();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('exports paginated find results to JSONL', async () => {
    const profile = createProfile();
    const client = await createClient();
    const batchService = new BatchService(client);
    const root = await mkdtemp(join(tmpdir(), 'fm-batch-'));
    const outputPath = join(root, 'contacts.jsonl');

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'batch-token' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .post(`${apiBase}/layouts/Contacts/_find`, (body) => body.offset === 1 && body.limit === 2)
      .reply(200, {
        response: {
          data: [
            { recordId: '1', fieldData: { FirstName: 'Ada' } },
            { recordId: '2', fieldData: { FirstName: 'Grace' } }
          ]
        },
        messages: [{ code: '0', message: 'OK' }]
      });

    nock(server)
      .post(`${apiBase}/layouts/Contacts/_find`, (body) => body.offset === 3 && body.limit === 2)
      .reply(200, {
        response: {
          data: [{ recordId: '3', fieldData: { FirstName: 'Linus' } }]
        },
        messages: [{ code: '0', message: 'OK' }]
      });

    const result = await batchService.batchExportFind(
      profile,
      'Contacts',
      {
        query: [{ Name: '*' }]
      },
      {
        outputPath,
        format: 'jsonl',
        maxRecords: 10,
        pageSize: 2
      }
    );

    expect(result.exportedRecords).toBe(3);
    const content = await readFile(outputPath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(3);
  });

  it('handles dry-run and execute batch updates', async () => {
    const profile = createProfile();
    const client = await createClient();
    const batchService = new BatchService(client);

    const entries = [
      { recordId: '10', fieldData: { FirstName: 'Ada' } },
      { recordId: '11', fieldData: { FirstName: 'Grace' } }
    ];

    const dryRun = await batchService.batchUpdate(profile, 'Contacts', entries, {
      dryRun: true,
      concurrency: 2
    });

    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.attempted).toBe(0);

    nock(server)
      .post(`${apiBase}/sessions`)
      .reply(200, { response: { token: 'update-token' }, messages: [{ code: '0', message: 'OK' }] });

    nock(server)
      .patch(`${apiBase}/layouts/Contacts/records/10`)
      .reply(200, {
        response: { modId: '1' },
        messages: [{ code: '0', message: 'OK' }]
      });

    nock(server)
      .patch(`${apiBase}/layouts/Contacts/records/11`)
      .reply(500, {
        messages: [{ code: '500', message: 'Write failed' }]
      });

    const execute = await batchService.batchUpdate(profile, 'Contacts', entries, {
      dryRun: false,
      concurrency: 2
    });

    expect(execute.dryRun).toBe(false);
    expect(execute.attempted).toBe(2);
    expect(execute.successCount).toBe(1);
    expect(execute.failureCount).toBe(1);
  });
});
