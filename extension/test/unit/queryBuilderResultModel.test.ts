/* eslint-disable @typescript-eslint/no-require-imports -- Tests load the same UMD module used by the webview. */
import { describe, expect, it } from 'vitest';

// The production webview consumes this classic-script module; CommonJS exposes the same API to tests.
const model = require('../../src/webviews/queryBuilder/ui/resultModel.js') as {
  getCellRaw: (record: Record<string, unknown>, column: string) => unknown;
  sortRecords: (records: Array<Record<string, unknown>>, sort?: { column: string; direction: 'ascending' | 'descending' }) => Array<Record<string, unknown>>;
  toCellValue: (value: unknown) => string;
};

describe('Query Builder result model', () => {
  it('reads record IDs and field values without assuming valid fieldData', () => {
    expect(model.getCellRaw({ recordId: 12 }, 'recordId')).toBe(12);
    expect(model.getCellRaw({ fieldData: { Name: 'Ada' } }, 'Name')).toBe('Ada');
    expect(model.getCellRaw({ fieldData: null }, 'Name')).toBeUndefined();
  });

  it('sorts numerically, keeps empty values last, and remains stable for ties', () => {
    const records = [
      { fieldData: { Value: 10 }, id: 'ten' },
      { fieldData: { Value: '' }, id: 'empty' },
      { fieldData: { Value: 2 }, id: 'two-a' },
      { fieldData: { Value: 2 }, id: 'two-b' }
    ];
    expect(model.sortRecords(records, { column: 'Value', direction: 'ascending' }).map((row) => row.id))
      .toEqual(['two-a', 'two-b', 'ten', 'empty']);
    expect(model.sortRecords(records, { column: 'Value', direction: 'descending' }).map((row) => row.id))
      .toEqual(['ten', 'two-a', 'two-b', 'empty']);
    expect(model.sortRecords(records)).toBe(records);
  });

  it('sorts FileMaker dates chronologically and safely renders complex values', () => {
    const dates = [
      { fieldData: { Date: '12/31/2025' } },
      { fieldData: { Date: '01/01/2025' } }
    ];
    expect(model.sortRecords(dates, { column: 'Date', direction: 'ascending' }).map((row) => row.fieldData))
      .toEqual([{ Date: '01/01/2025' }, { Date: '12/31/2025' }]);
    expect(model.toCellValue({ ok: true })).toBe('{"ok":true}');
    expect(model.toCellValue(null)).toBe('');
  });
});
