import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCsvStreamWriter } from '../../../src/utils/csvStreamWriter';

describe('createCsvStreamWriter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'csv-stream-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('leaves missing prototype-like fields blank in later rows', async () => {
    const columns = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
    const file = join(dir, 'names.csv');
    const writer = await createCsvStreamWriter(file);
    try {
      await writer.append(Object.fromEntries(columns.map((name) => [name, 'value'])));
      await writer.append({});
    } finally {
      await writer.close();
    }
    expect(await readFile(file, 'utf8')).toBe(columns.join(',') + '\nvalue,value,value,value\n,,,\n');
  });

  it('discovers columns from initial rows and writes header + data', async () => {
    const file = join(dir, 'out.csv');
    const writer = await createCsvStreamWriter(file);
    await writer.append({ recordId: '1', name: 'Alice', age: 30 });
    await writer.append({ recordId: '2', name: 'Bob', age: 25 });
    await writer.close();
    const text = await readFile(file, 'utf8');
    expect(text).toBe('recordId,name,age\n1,Alice,30\n2,Bob,25\n');
  });

  it('respects explicit columns option and writes header eagerly', async () => {
    const file = join(dir, 'out.csv');
    const writer = await createCsvStreamWriter(file, { columns: ['a', 'b'] });
    await writer.append({ b: 2, a: 1, c: 99 }); // c is dropped, order is a then b
    await writer.close();
    const text = await readFile(file, 'utf8');
    expect(text).toBe('a,b\n1,2\n');
  });

  it('includes fields absent from the first row within the sample', async () => {
    const file = join(dir, 'out.csv');
    const writer = await createCsvStreamWriter(file);
    await writer.append({ a: 1, b: 2 });
    await writer.append({ a: 10, b: 20, c: 'extra' }); // c is dropped
    await writer.close();
    const text = await readFile(file, 'utf8');
    expect(text).toBe('a,b,c\n1,2,\n10,20,extra\n');
  });

  it('escapes commas, quotes, and newlines inside cells', async () => {
    const file = join(dir, 'out.csv');
    const writer = await createCsvStreamWriter(file);
    await writer.append({ name: 'Doe, John', note: 'quote: "hi"', body: 'line1\nline2' });
    await writer.close();
    const text = await readFile(file, 'utf8');
    expect(text).toBe(
      'name,note,body\n"Doe, John","quote: ""hi""","line1\nline2"\n'
    );
  });

  it.each(['', 'portal truncated'])('preserves Unicode separators in spooled CSV (portal note: %j)', async (note) => {
    const file = join(dir, 'unicode.csv');
    const field = 'line\u2028paragraph\u2029';
    const value = '山田🚀\u2028middle\u2029' + 'x'.repeat(70_000) + '\r\n"end"';
    const writer = await createCsvStreamWriter(file, {
      columns: [field, 'note'], optionalColumn: 'note'
    });
    await writer.append({ [field]: value, note });
    await writer.append({ [field]: 'last\u2029row\u2028' });
    await writer.close();
    expect(await readFile(file, 'utf8')).toBe(
      field + (note ? ',note' : '') + '\n' +
      '"' + value.replace(/"/g, '""') + '"' + (note ? ',' + note : '') + '\n' +
      'last\u2029row\u2028' + (note ? ',' : '') + '\n'
    );
  });

  it('produces an empty file when no rows are written and no columns preset', async () => {
    const file = join(dir, 'out.csv');
    const writer = await createCsvStreamWriter(file);
    await writer.close();
    const text = await readFile(file, 'utf8');
    expect(text).toBe('');
  });

  it('handles undefined and null cell values as empty strings', async () => {
    const file = join(dir, 'out.csv');
    const writer = await createCsvStreamWriter(file);
    await writer.append({ a: 1, b: null, c: undefined });
    await writer.close();
    const text = await readFile(file, 'utf8');
    expect(text).toBe('a,b,c\n1,,\n');
  });

  it('supports CRLF line endings', async () => {
    const file = join(dir, 'out.csv');
    const writer = await createCsvStreamWriter(file, { lineEnding: '\r\n' });
    await writer.append({ a: 1, b: 2 });
    await writer.close();
    const text = await readFile(file, 'utf8');
    expect(text).toBe('a,b\r\n1,2\r\n');
  });

  it('close() is idempotent', async () => {
    const file = join(dir, 'out.csv');
    const writer = await createCsvStreamWriter(file);
    await writer.append({ a: 1 });
    await writer.close();
    await writer.close();
    const text = await readFile(file, 'utf8');
    expect(text).toBe('a\n1\n');
  });

  it('does not hold all rows in memory (smoke test with 5k rows)', async () => {
    const file = join(dir, 'big.csv');
    const writer = await createCsvStreamWriter(file);
    for (let i = 0; i < 5000; i += 1) {
      await writer.append({ id: i, label: `row-${i}` });
    }
    await writer.close();
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n');
    expect(lines[0]).toBe('id,label');
    expect(lines[1]).toBe('0,row-0');
    expect(lines[5000]).toBe('4999,row-4999');
  });
  it('warns when a field appears after the bounded discovery sample', async () => {
    const file = join(dir, 'out.csv');
    const onUnknownField = vi.fn();
    const writer = await createCsvStreamWriter(file, { sampleSize: 2, onUnknownField });
    await writer.append({ a: 1 });
    await writer.append({ b: 2 });
    await writer.append({ c: 3 });
    await writer.close();
    expect(await readFile(file, 'utf8')).toBe('a,b\n1,\n,2\n,\n');
    expect(onUnknownField).toHaveBeenCalledWith('c');
  });

  it('captures each appended value even when the caller reuses a row during sampling', async () => {
    const file = join(dir, 'out.csv');
    const writer = await createCsvStreamWriter(file);
    const row = { a: 1, nested: [1] };
    await writer.append(row);
    row.a = 2;
    row.nested[0] = 2;
    await writer.append(row);
    await writer.close();
    expect(await readFile(file, 'utf8')).toBe('a,nested\n1,[1]\n2,[2]\n');
  });

});
