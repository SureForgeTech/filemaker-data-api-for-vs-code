import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
import { runInNewContext } from 'vm';
import { describe, expect, it, vi } from 'vitest';
import { BatchService, parseBatchUpdateInput } from '../../../src/services/batchService';
import { portalNotes } from '../../../src/utils/exportRecords';
import { neutralizeFormula } from '../../../src/utils/exportCsv';
import { numericText } from '../../../src/utils/numericText';
import { scrubGenericText } from '../../../src/ai/aiText';
import { matchCertificateName } from '../../../src/services/connectionDiagnostics';

const profile = { id: 'p', name: 'P', serverUrl: 'https://example.test', database: 'DB', authMode: 'direct' as const };
const CellText = createRequire(import.meta.url)('../../../src/webviews/queryBuilder/ui/cellText.js') as { neutralizeFormula(value: string): string };

describe('hostile batch data', () => {
  it('B1 parses a failing portal-note backtracking string promptly without losing real fields', () => {
    const hostile = 'p: showing 1 of 2; '.repeat(24) + '!';
    const started = performance.now();
    const entries = parseBatchUpdateInput(`recordId,modId, Name ,__portalNote (export information)\n1,2, value ,${hostile}`, 'csv');
    expect(performance.now() - started).toBeLessThan(200);
    expect(entries[0]?.fieldData).toEqual({ ' Name ': ' value ', '__portalNote (export information)': hostile });
    expect(parseBatchUpdateInput('recordId,Name,__portalNote (export information)\n1,A,p: showing 1 of 2; q: showing 0 of 1', 'csv')[0]?.fieldData).toEqual({ Name: 'A' });
  });

  it('B1 omits hostile counts and bounds and escapes portal names only in export notes', () => {
    for (const [returnedCount, foundCount] of [[-1, 2], [0, Infinity], [0, 2.5], [0, Number.MAX_SAFE_INTEGER + 1], ['0', '2']]) {
      expect(portalNotes({ recordId: '1', fieldData: {}, portalDataInfo: [{ portalObjectName: 'p', returnedCount, foundCount }] } as never)).toBe('');
    }
    expect(portalNotes({ recordId: '1', fieldData: {}, portalDataInfo: [{ portalObjectName: ' p; \nq ', returnedCount: 1, foundCount: 2 }] }))
      .toBe(' p\\u003b \\nq : showing 1 of 2');
    expect(portalNotes({ recordId: '1', fieldData: {}, portalDataInfo: [{ portalObjectName: 'x'.repeat(10000), returnedCount: 0, foundCount: 1 }] }).length).toBeLessThan(300);
  });

  it.each(['CSV', 'copied table', 'shared number', 'editor number'])('B1 rejects long failing numeric text promptly in %s', async (kind) => {
    const value = '+' + '1'.repeat(30000) + '!';
    let parse: (value: string) => unknown = numericText;
    if (kind === 'CSV') parse = neutralizeFormula;
    if (kind === 'copied table') parse = CellText.neutralizeFormula;
    if (kind === 'editor number') {
      const source = await readFile(join(__dirname, '../../../src/webviews/recordEditor/ui/index.js'), 'utf8');
      const fn = source.slice(source.indexOf('function parseEditableValue('), source.indexOf('\nfunction clone('));
      const helpers = source.slice(source.indexOf('function metadataForField('), source.indexOf('function readOnlyNote('));
      const editor = runInNewContext(`${helpers}\n${fn}; parseEditableValue`, { state: { presentationFields: [{ name: 'Number', type: 'number' }] } });
      parse = (text) => editor(text, 'Number');
    }
    const started = performance.now();
    expect(parse(value)).toBe(kind === 'CSV' || kind === 'copied table' ? "'" + value : value);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('B1 rejects a hostile certificate common name promptly', () => {
    const started = performance.now();
    expect(matchCertificateName('example.test', '', 'a.'.repeat(30000) + '!')).toEqual({ nameMatch: false, noNames: true });
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('B1 scrubs hostile dotted server error text promptly without inventing a hostname', () => {
    const value = 'a.'.repeat(30000) + '!';
    const started = performance.now();
    expect(scrubGenericText(value)).toBe(value);
    expect(performance.now() - started).toBeLessThan(200);
    expect(scrubGenericText('failure from fm.example.test')).toBe('failure from [host]');
  });

  it.each(['csv', 'jsonl'] as const)('B3 enforces the remaining record cap on an oversized %s page', async (format) => {
    const root = await mkdtemp(join(tmpdir(), 'hostile-batch-'));
    try {
      const rows = Array.from({ length: 5 }, (_, i) => ({ recordId: String(i + 1), fieldData: { ' Name ': `value ${i + 1}` } }));
      const findRecords = vi.fn().mockResolvedValueOnce({ data: rows.slice(0, 2) }).mockResolvedValueOnce({ data: rows.slice(2) }).mockResolvedValue({ data: [] });
      const service = new BatchService({ findRecords, getLayoutMetadata: vi.fn().mockResolvedValue({ fieldMetaData: [{ name: ' Name ', result: 'text' }] }) } as never);
      const outputPath = join(root, `export.${format}`);
      const result = await service.batchExportFind(profile, ' Layout ', { query: [{ ' Name ': '*' }] }, { outputPath, format, maxRecords: 3, pageSize: 2 });
      expect(result).toMatchObject({ exportedRecords: 3, truncated: true });
      const text = await readFile(outputPath, 'utf8');
      expect(text).toContain('value 3');
      expect(text).not.toContain('value 4');
      expect(findRecords).toHaveBeenCalledTimes(2);
      expect(findRecords).toHaveBeenLastCalledWith(profile, ' Layout ', expect.objectContaining({ limit: 1, offset: 3 }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([true, false])('B4 refuses an update above the configured row cap before metadata or writes (dryRun=%s)', async (dryRun) => {
    const getLayoutMetadata = vi.fn(); const editRecord = vi.fn();
    const service = new BatchService({ getLayoutMetadata, editRecord } as never, { getMaxRecords: () => 1 });
    await expect(service.batchUpdate(profile, ' Layout ', [{ recordId: '1', fieldData: {} }, { recordId: '2', fieldData: {} }], { dryRun }))
      .rejects.toThrow(/2 rows exceed filemaker.batch.maxRecords \(1\)/);
    expect(getLayoutMetadata).not.toHaveBeenCalled();
    expect(editRecord).not.toHaveBeenCalled();
  });
});
