import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { BatchService } from '../../../src/services/batchService';
import { FMClientError } from '../../../src/services/errors';
import type { FMClient } from '../../../src/services/fmClient';
import type { EnterpriseFeatureId } from '../../../src/enterprise/roleGuard';

const profile = { id: 'p', name: 'Test', serverUrl: 'https://example.test', database: 'DB', authMode: 'direct' as const };
const entries = ['1', '2', '3'].map((recordId) => ({ recordId, fieldData: { ' Field ': ' value ' } }));
let settings: Record<string, unknown>;
let denied: EnterpriseFeatureId | undefined;
let roots: string[];

function setup() {
  const client = {
    getLayoutMetadata: vi.fn().mockResolvedValue({}),
    editRecord: vi.fn().mockResolvedValue({}),
    findRecords: vi.fn()
  };
  const roleGuard = { getFeatureGuard: vi.fn((feature: EnterpriseFeatureId) => ({
    allowed: feature !== denied, reason: feature === denied ? `${feature} disabled by policy` : undefined
  })) };
  const service = new BatchService(client as unknown as FMClient, { roleGuard });
  return { client, service, roleGuard };
}

beforeEach(() => {
  settings = {};
  denied = undefined;
  roots = [];
  (vscode.workspace as { isTrusted: boolean }).isTrusted = true;
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: (key: string, fallback: unknown) => settings[key] ?? fallback
  } as never);
});
afterEach(async () => {
  vi.mocked(vscode.workspace.getConfiguration).mockReset();
  (vscode.workspace as { isTrusted: boolean }).isTrusted = true;
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('batch policy', () => {
  it.each(['offline', 'recordEdit', 'writeOperations', 'batchUpdate', 'editSwitch'])('allows explicit and default dry runs under %s without writes', async (restriction) => {
    const { client, service } = setup();
    if (restriction === 'offline') settings['offline.mode'] = true;
    else if (restriction === 'editSwitch') settings['features.recordEdit.enabled'] = false;
    else denied = restriction as EnterpriseFeatureId;
    for (const options of [{ dryRun: true }, undefined]) {
      const result = await service.batchUpdate(profile, ' Layout ', entries, options);
      expect(result).toMatchObject({ dryRun: true, total: 3, attempted: 0 });
    }
    expect(client.editRecord).not.toHaveBeenCalled();
    expect(client.findRecords).not.toHaveBeenCalled();
    if (restriction === 'offline') expect(client.getLayoutMetadata).not.toHaveBeenCalled();
  });

  it.each(['features.recordEdit.enabled', 'features.batch.enabled', 'offline.mode'])('refuses service updates under %s', async (key) => {
    const { client, service } = setup();
    settings[key] = key === 'offline.mode';
    await expect(service.batchUpdate(profile, ' Layout ', entries, { dryRun: false })).rejects.toThrow(/disabled|Offline/);
    expect(client.getLayoutMetadata).not.toHaveBeenCalled();
    expect(client.editRecord).not.toHaveBeenCalled();
  });

  it.each(['recordEdit', 'writeOperations', 'batchUpdate'] as const)('refuses service updates under %s policy', async (feature) => {
    const { client, service } = setup();
    denied = feature;
    await expect(service.batchUpdate(profile, ' Layout ', entries, { dryRun: false })).rejects.toThrow(`${feature} disabled by policy`);
    expect(client.getLayoutMetadata).not.toHaveBeenCalled();
    expect(client.editRecord).not.toHaveBeenCalled();
  });

  it.each(['offline', 'recordEdit', 'writeOperations', 'batchUpdate', 'editSwitch', 'batchSwitch', 'trust'])('stops queued rows when %s changes during a write', async (change) => {
    const { client, service } = setup();
    client.editRecord.mockImplementationOnce(async () => {
      if (change === 'offline') settings['offline.mode'] = true;
      else if (change === 'editSwitch') settings['features.recordEdit.enabled'] = false;
      else if (change === 'batchSwitch') settings['features.batch.enabled'] = false;
      else if (change === 'trust') (vscode.workspace as { isTrusted: boolean }).isTrusted = false;
      else denied = change as EnterpriseFeatureId;
      return {};
    });
    const result = await service.batchUpdate(profile, ' Layout ', entries, { dryRun: false, concurrency: 1 });
    expect(client.editRecord).toHaveBeenCalledExactlyOnceWith(profile, ' Layout ', '1', { ' Field ': ' value ' });
    expect(result).toMatchObject({ successCount: 1, attempted: 1, notAttempted: 2, notAttemptedIds: ['2', '3'], stoppedReason: expect.stringMatching(/disabled|Offline|untrusted/) });
  });

  it.each(['offline', 'writeOperations'])('rechecks %s before retrying a row after a failed write', async (change) => {
    const { client, service } = setup();
    client.editRecord.mockImplementationOnce(async () => {
      if (change === 'offline') settings['offline.mode'] = true;
      else denied = 'writeOperations';
      throw new FMClientError('Temporary error', { isRetryable: true });
    });
    const result = await service.batchUpdate(profile, 'L', entries, { dryRun: false, concurrency: 1 });
    expect(client.editRecord).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ attempted: 1, successCount: 0, notAttempted: 2, stoppedReason: expect.stringMatching(/Offline mode|writeOperations disabled/) });
  });

  it.each(['jsonl', 'csv'] as const)('stops a %s export before its next page when offline mode changes', async (format) => {
    await checkExportBoundary(format, 'page');
  });

  it.each(['row', 'probe', 'batchSwitch'])('stops an export at the %s boundary and preserves the previous file', async (boundary) => {
    await checkExportBoundary('jsonl', boundary);
  });
});

async function checkExportBoundary(format: 'jsonl' | 'csv', boundary: string) {
  const { client, service } = setup();
  const root = await mkdtemp(join(tmpdir(), 'fm-batch-policy-'));
  roots.push(root);
  const outputPath = join(root, `out.${format}`);
  await writeFile(outputPath, 'previous export');
  client.findRecords.mockImplementationOnce(async () => {
    if (boundary === 'row') settings['offline.mode'] = true;
    return { data: Array.from({ length: 100 }, () => ({ recordId: '1', fieldData: { Name: 'A' } })) };
  }).mockResolvedValue({ data: [] });
  const job = {
    log: vi.fn(), isCancellationRequested: () => false,
    reportProgress: () => { settings[boundary === 'batchSwitch' ? 'features.batch.enabled' : 'offline.mode'] = boundary !== 'batchSwitch'; }
  };
  await expect(service.batchExportFind(profile, 'L', { query: [{}] }, {
    outputPath, format, maxRecords: boundary === 'probe' ? 100 : 200, pageSize: 100
  }, job)).rejects.toThrow(/Offline mode|disabled by settings/);
  expect(client.findRecords).toHaveBeenCalledTimes(1);
  expect(await readFile(outputPath, 'utf8')).toBe('previous export');
}
