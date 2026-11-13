import { randomUUID } from 'crypto';
import { open, rm } from 'fs/promises';
import { createInterface } from 'readline';
import { atomicExport } from './atomicExport';
import { escapeCsvValue } from './exportCsv';

export type CsvRow = Record<string, unknown> | Map<string, unknown>;
export interface CsvStreamWriterOptions {
  lineEnding?: '\n' | '\r\n';
  columns?: string[];
  neutralizeFormulas?: boolean;
  excelCompatible?: boolean;
  /** Without metadata, discover the union of at most this many initial rows. */
  sampleSize?: number;
  onUnknownField?: (field: string) => void;
  /** Omit this column unless a row has a nonempty value; spool rows on disk until close. */
  optionalColumn?: string;
}
export interface CsvStreamWriter {
  append(record: CsvRow): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
  getColumns(): string[];
}

/** Bounded sampling when no schema is available; explicit columns preserve metadata order. */
export async function createCsvStreamWriter(path: string, options: CsvStreamWriterOptions = {}): Promise<CsvStreamWriter> {
  const file = await atomicExport(path);
  const spoolPath = options.optionalColumn ? `${path}.${randomUUID()}.rows.tmp` : undefined;
  let spool: Awaited<ReturnType<typeof open>> | undefined;
  try { if (spoolPath) spool = await open(spoolPath, 'wx+', 0o600); }
  catch (error) { await file.abort(); throw error; }
  let optionalUsed = false;
  const cleanSpool = async () => {
    await spool?.close();
    if (spoolPath) await rm(spoolPath, { force: true });
  };
  const lineEnding = options.lineEnding ?? '\n';
  let columns = options.columns ? [...options.columns] : undefined;
  const pending: Map<string, string>[] = [];
  let headerWritten = false;
  let closed = false;
  const keys = (row: CsvRow) => row instanceof Map ? [...row.keys()] : Object.keys(row);
  const writeRow = async (row: Map<string, string>) => {
    for (const key of keys(row)) if (!columns!.includes(key)) {
      options.onUnknownField?.(key);
    }
    if (spool) {
      optionalUsed ||= Boolean(row.get(options.optionalColumn!));
      // Newer Node readline also splits at Unicode separators; keep each JSON row on one line.
      const json = JSON.stringify([...row]).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      await spool.writeFile(json + '\n', 'utf8');
    } else await file.write(columns!.map((key) => row.get(key) ?? '').join(',') + lineEnding);
  };
  const flush = async () => {
    if (!columns) columns = [...new Set(pending.flatMap(keys))];
    if (!headerWritten) {
      if (!spool) await writeHeader();
      headerWritten = true;
    }
    for (const row of pending) await writeRow(row);
    pending.length = 0;
  };
  const writeHeader = async () => {
    await file.write((options.excelCompatible ? '\uFEFF' : '') + (columns!.length ? columns!.map((key) => escapeCsvValue(key, options)).join(',') + lineEnding : ''));
  };
  return {
    async append(record) {
      const row = new Map(keys(record).map((key) => [key, escapeCsvValue(record instanceof Map ? record.get(key) : (Object.hasOwn(record, key) ? record[key] : undefined), options)]));
      if (!columns) {
        pending.push(row);
        if (pending.length >= (options.sampleSize ?? 100)) await flush();
      } else {
        await flush();
        await writeRow(row);
      }
    },
    async close() {
      if (closed) return;
      try {
        await flush();
        if (spool) {
          if (!optionalUsed) columns = columns!.filter((key) => key !== options.optionalColumn);
          await writeHeader();
          const input = spool.createReadStream({ start: 0, autoClose: false });
          try {
            for await (const line of createInterface({ input, crlfDelay: Infinity })) {
              const row = new Map<string, string>(JSON.parse(line));
              await file.write(columns!.map((key) => row.get(key) ?? '').join(',') + lineEnding);
            }
          } finally { input.destroy(); }
        }
        await cleanSpool();
        await file.close(); closed = true;
      } catch (error) { await file.abort(); await cleanSpool(); closed = true; throw error; }
    },
    async abort() { if (closed) return; closed = true; await file.abort(); await cleanSpool(); },
    getColumns() { return columns ? [...columns] : [...new Set(pending.flatMap(keys))]; }
  };
}
