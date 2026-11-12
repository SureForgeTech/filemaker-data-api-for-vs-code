import { extname } from 'path';

import type { FMClient } from './fmClient';
import { FMClientError } from './errors';
import { AdaptiveConcurrency } from '../performance/adaptiveConcurrency';
import { CircuitBreaker } from '../performance/circuitBreaker';
import type { CircuitBreakerRegistry } from '../performance/circuitBreakerRegistry';
import type {
  BatchExportFormat,
  BatchExportOptions,
  BatchExportResult,
  BatchUpdateEntry,
  BatchUpdateOptions,
  BatchUpdateResult,
  ConnectionProfile,
  FindRecordsRequest,
  FileMakerRecord,
  JobContext,
  PerformanceMode
} from '../types/fm';
import { isCredentialRejection } from '../utils/fileMakerCodes';
import { nulTextError } from '../utils/nulText';
import { createCsvStreamWriter } from '../utils/csvStreamWriter';
import { restoreFormulaText } from '../utils/exportCsv';
import { createJsonlWriter } from '../utils/jsonlWriter';
import { extractFieldsFromMetadata } from './schemaService';
import { exportColumns, exportRow, portalNotes } from '../utils/exportRecords';
import { numericText } from '../utils/numericText';
import { fieldsForGeneration } from '../utils/generatedFields';
import { fieldType, metadataForField, readOnlyFieldKind } from '../utils/fieldAccess';
import { stableStringify } from '../utils/hash';

interface BatchServiceOptions {
  getMaxRecords?: () => number;
  getConcurrency?: () => number;
  getDryRunDefault?: () => boolean;
  getPerformanceMode?: () => PerformanceMode;
  /** CSV formula protection; on unless the user turned it off. */
  getNeutralizeFormulas?: () => boolean;
  circuitBreakerRegistry?: CircuitBreakerRegistry;
}

export class BatchService {
  private readonly getMaxRecords: () => number;
  private readonly getConcurrency: () => number;
  private readonly getDryRunDefault: () => boolean;
  private readonly getPerformanceMode: () => PerformanceMode;
  private readonly getNeutralizeFormulas: () => boolean;
  private readonly circuitBreakerRegistry?: CircuitBreakerRegistry;

  public constructor(private readonly fmClient: FMClient, options?: BatchServiceOptions) {
    this.getMaxRecords = options?.getMaxRecords ?? (() => 10_000);
    this.getConcurrency = options?.getConcurrency ?? (() => 4);
    this.getDryRunDefault = options?.getDryRunDefault ?? (() => true);
    this.getPerformanceMode = options?.getPerformanceMode ?? (() => 'standard');
    this.getNeutralizeFormulas = options?.getNeutralizeFormulas ?? (() => true);
    this.circuitBreakerRegistry = options?.circuitBreakerRegistry;
  }

  public getDefaultBatchUpdateOptions(): BatchUpdateOptions {
    return {
      dryRun: this.getDryRunDefault(),
      concurrency: clampConcurrency(this.getConcurrency())
    };
  }

  public async batchExportFind(
    profile: ConnectionProfile,
    layout: string,
    request: FindRecordsRequest,
    options: BatchExportOptions,
    job?: JobContext
  ): Promise<BatchExportResult> {
    const maxRecords = normalizeMaxRecords(options.maxRecords || this.getMaxRecords());
    const performanceMode = this.getPerformanceMode();
    const pageSize = normalizePageSize(options.pageSize, performanceMode);
    const format: BatchExportFormat = performanceMode === 'high-scale' ? 'jsonl' : options.format;

    let exported = 0;
    let offset = typeof request.offset === 'number' ? request.offset : 1;
    let truncated = false;
    const jsonlWriter = format === 'jsonl' ? await createJsonlWriter(options.outputPath) : undefined;
    let fields: ReturnType<typeof extractFieldsFromMetadata> | undefined;
    if (format === 'csv') {
      try {
        const metadataFields = extractFieldsFromMetadata(await this.fmClient.getLayoutMetadata(profile, layout));
        if (metadataFields.length) fields = fieldsForGeneration(metadataFields);
      } catch { /* Use a bounded sample when metadata cannot be read. */ }
      if (!fields) job?.log('warn', 'Layout metadata unavailable. CSV columns use the first 100 records; later unknown fields will be reported.');
    }
    let csvWriter: Awaited<ReturnType<typeof createCsvStreamWriter>> | undefined;
    let meta: [string, string] = exportColumns(fields?.map((field) => field.name) ?? []);
    let noteColumn: string | undefined;
    const pendingCsv: FileMakerRecord[] = [];
    let unknownColumnValues = 0;
    const unknownColumns = new Set<string>();
    const startCsv = async (records: FileMakerRecord[]) => {
      const names = [...new Set([
        ...(fields?.map((field) => field.name) ?? []),
        ...(fields ? records : records.slice(0, 100)).flatMap((record) => Object.keys(record.fieldData))
      ])];
      meta = exportColumns(names);
      // The writer keeps this column only if any page actually has truncated portals.
      noteColumn = '__portalNote (export information)';
      while (names.includes(noteColumn)) noteColumn = '_' + noteColumn;
      csvWriter = await createCsvStreamWriter(options.outputPath, {
        columns: [...meta, ...names, noteColumn],
        optionalColumn: noteColumn,
        excelCompatible: options.excelCompatible,
        neutralizeFormulas: this.getNeutralizeFormulas(),
        onUnknownField: (field) => {
          unknownColumnValues += 1;
          unknownColumns.add(field);
        }
      });
    };

    try {
      while (exported < maxRecords) {
        if (job?.isCancellationRequested()) {
          job.log('warn', 'Batch export cancelled by user.');
          break;
        }

        const remaining = maxRecords - exported;
        const limit = Math.min(pageSize, remaining);
        const page = await this.fmClient.findRecords(profile, layout, {
          ...request,
          limit,
          offset
        });

        const records = (page.data ?? []).slice(0, remaining);
        if ((page.data?.length ?? 0) > remaining) truncated = true;
        if (format === 'csv' && fields && !csvWriter) await startCsv(records);
        if (!page.data || page.data.length === 0) {
          break;
        }

        for (const record of records) {
          if (format === 'jsonl') {
            const note = portalNotes(record);
            await jsonlWriter?.append(note ? { ...record, exportNote: note } : record);
          } else if (csvWriter) {
            await csvWriter.append(exportRow(record, meta, noteColumn));
          } else {
            pendingCsv.push(record);
            if (pendingCsv.length >= 100) {
              await startCsv(pendingCsv);
              for (const pending of pendingCsv) await csvWriter!.append(exportRow(pending, meta, noteColumn));
              pendingCsv.length = 0;
            }
          }
        }

        exported += records.length;
        offset += records.length;

        if (job) {
          job.reportProgress(Math.round((exported / maxRecords) * 100), `Exported ${exported} records.`);
        }

        if (page.data.length < limit) {
          break;
        }
      }

      // Reached the cap: "truncated" only if the layout really has another record (a found set of
      // exactly maxRecords rows is complete).
      if (exported >= maxRecords && !truncated && !job?.isCancellationRequested()) {
        try {
          const probe = await this.fmClient.findRecords(profile, layout, { ...request, limit: 1, offset });
          truncated = (probe?.data?.length ?? 0) > 0;
        } catch {
          truncated = true; // could not tell; say the export may be incomplete
        }
      }

      const cancelled = job?.isCancellationRequested() ?? false;
      if (cancelled) {
        exported = 0;
        truncated = false;
        await jsonlWriter?.abort();
        await csvWriter?.abort();
      } else {
        if (format === 'csv' && !csvWriter) {
          await startCsv(pendingCsv);
          for (const pending of pendingCsv) await csvWriter!.append(exportRow(pending, meta, noteColumn));
        }
        await jsonlWriter?.close();
        await csvWriter?.close();
      }
      const warnings = !cancelled && unknownColumnValues > 0
        ? [`${unknownColumnValues} values were not exported because their columns were unknown: ${[...unknownColumns].map((name) => JSON.stringify(name)).join(', ')}.`]
        : [];
      for (const warning of warnings) job?.log('warn', warning);
      return {
        ...(cancelled ? { cancelled: true } : {}),
        ...(warnings.length ? { warnings, unknownColumnValues } : {}),
        outputPath: options.outputPath,
        format,
        exportedRecords: exported,
        truncated
      };
    } catch (error) {
      await jsonlWriter?.abort();
      await csvWriter?.abort();
      throw error;
    }
  }

  public async batchUpdate(
    profile: ConnectionProfile,
    layout: string,
    entries: BatchUpdateEntry[],
    options?: Partial<BatchUpdateOptions>,
    job?: JobContext
  ): Promise<BatchUpdateResult> {
    const maxRecords = normalizeMaxRecords(this.getMaxRecords());
    if (entries.length > maxRecords) {
      throw new Error(`Batch update refused: ${entries.length} rows exceed filemaker.batch.maxRecords (${maxRecords}). Split the file or raise the setting before retrying.`);
    }
    const dryRun = options?.dryRun ?? this.getDryRunDefault();
    const configuredConcurrency = clampConcurrency(options?.concurrency ?? this.getConcurrency());
    const performanceMode = this.getPerformanceMode();
    const maxConcurrency = performanceMode === 'high-scale' ? Math.max(2, configuredConcurrency) : configuredConcurrency;
    const total = entries.length;

    let csvFields: ReturnType<typeof extractFieldsFromMetadata> = [];
    try { csvFields = extractFieldsFromMetadata(await this.fmClient.getLayoutMetadata(profile, layout)); }
    catch { job?.log('warn', 'Layout metadata unavailable. Read-only columns cannot be identified; CSV values will be sent as strings.'); }
    if (!csvFields.length) job?.log('warn', 'No field types available. CSV values will be sent as strings.');
    if (csvFields.some((field) => /^(recordId|modId)$/i.test(field.name)) && entries.some((entry) => entry.sourceFormat === 'csv' && (entry.csvRecordColumn ?? 'recordId') === 'recordId')) {
      throw new Error('Ambiguous CSV: this layout has a recordId or modId field. Export again and keep the reserved __recordId and __modId columns.');
    }
    const skippedColumns = [...new Set(entries.flatMap((entry) => Object.keys(entry.fieldData)))].filter((name) => {
      return readOnlyFieldKind(metadataForField(csvFields, name)) !== undefined;
    });
    const warnings = skippedColumns.map((name) => {
      const kind = readOnlyFieldKind(metadataForField(csvFields, name));
      return `Column ${JSON.stringify(name)}: ${kind === 'calculation' ? 'calculated by FileMaker' : kind === 'container' ? 'use Upload to container' : 'summary field'}; values will be skipped.`;
    });
    for (const warning of warnings) job?.log('warn', warning);
    const rowsWithModId = entries.filter((entry) => entry.modId !== undefined && entry.modId !== '').length;
    const coverage = { rowsWithModId, rowsChecked: options?.overwriteChanged ? 0 : rowsWithModId, skippedColumns, warnings };
    job?.log('info', `${rowsWithModId} rows have modId; ${coverage.rowsChecked} rows will be checked for newer changes. ${total - rowsWithModId} rows have no modId.`);
    const queue = entries.map((entry) => ({
      ...entry,
      ...(options?.overwriteChanged ? { modId: undefined } : {}),
      fieldData: Object.fromEntries(Object.entries(entry.fieldData).filter(([name]) => !skippedColumns.includes(name)).map(([name, value]) => {
        if (entry.sourceFormat !== 'csv' || fieldType(metadataForField(csvFields, name)?.result) !== 'number' || typeof value !== 'string') return [name, value];
        const numeric = numericText(value);
        if (typeof numeric === 'number') return [name, numeric];
        job?.log('warn', `Row ${entry.recordId}, field "${name}": number kept as text to avoid changing its value.`);
        return [name, value];
      }))
    }));
    const seenIds = new Set<string>();
    const duplicates = new Set<BatchUpdateEntry>();
    const duplicateReason = 'Duplicate recordId in this file; later row skipped. Only the first row with editable values for each record is used.';
    for (const entry of queue) {
      if (Object.keys(entry.fieldData).length === 0) continue;
      if (seenIds.has(entry.recordId)) {
        duplicates.add(entry);
        const warning = `Row ${entry.recordId}: ${duplicateReason}`;
        warnings.push(warning);
        job?.log('warn', warning);
      }
      seenIds.add(entry.recordId);
    }
    if (dryRun) {
      const failures = queue.flatMap((entry) => {
        const reason = duplicates.has(entry) ? duplicateReason : nulTextError(entry.fieldData);
        return reason ? [{ recordId: entry.recordId, reason }] : [];
      });
      return {
        ...coverage,
        dryRun: true,
        total,
        attempted: 0,
        successCount: 0,
        failureCount: failures.length,
        failures
      };
    }

    // Set when the account itself cannot do this (no privilege, rejected credentials): every other
    // record would fail the same way, so the job stops with one clear reason.
    let stoppedReason: string | undefined;
    let completed = 0;
    let successCount = 0;
    let skippedChanged = 0;
    const updatedIds: string[] = [];
    const failures: BatchUpdateResult['failures'] = [];
    const adaptive = new AdaptiveConcurrency({
      initial: configuredConcurrency,
      min: 1,
      max: maxConcurrency,
      targetLatencyMs: performanceMode === 'high-scale' ? 1400 : 900
    });
    const registry = this.circuitBreakerRegistry;
    const breakerName = `batchUpdate:${profile.id}:${layout}`;
    const breaker = new CircuitBreaker({
      failureThreshold: performanceMode === 'high-scale' ? 6 : 4,
      openMs: performanceMode === 'high-scale' ? 6_000 : 4_000,
      onTransition: registry
        ? (transition) => registry.recordTransition(breakerName, transition)
        : undefined
    });
    if (registry) {
      registry.register(breakerName, breaker);
    }

    const inFlight = new Set<Promise<void>>();

    const scheduleNext = (): void => {
      while (!job?.isCancellationRequested() && stoppedReason === undefined && queue.length > 0 && inFlight.size < adaptive.getLimit()) {
        if (!breaker.canRequest()) {
          return;
        }

        const next = queue.shift();
        if (!next) {
          return;
        }

        const updatePromise = (duplicates.has(next)
          ? Promise.reject(new Error(duplicateReason))
          : this.updateOneWithRetry(profile, layout, next, adaptive, breaker, csvFields, job))
          .then(() => {
            if (Object.keys(next.fieldData).length > 0) {
              successCount += 1;
              updatedIds.push(next.recordId);
            }
          })
          .catch((error) => {
            const stale = error instanceof FMClientError && error.code === '306' && !(error instanceof UnconfirmedUpdateError);
            if (stale) skippedChanged += 1;
            failures.push({
              recordId: next.recordId,
              ...(error instanceof FMClientError && error.code ? { code: error.code } : {}),
              reason: stale ? 'Changed since the export (someone edited this record). Not updated.' : error instanceof UnconfirmedUpdateError ? error.message : error instanceof FMClientError && error.code ? `FileMaker ${error.code}: ${error.message}` : error instanceof Error ? error.message : 'Unknown update failure'
            });
            if (stoppedReason === undefined && stopsTheJob(error)) {
              stoppedReason = error instanceof Error ? error.message : 'The account cannot make this change.';
              // Keep the queued ids for the partial result.
            }
          })
          .finally(() => {
            completed += 1;
            if (job) {
              job.reportProgress(Math.round((completed / total) * 100), `Processed ${completed}/${total}: ${successCount} succeeded, ${failures.length} failed`);
            }
          });

        const tracked = updatePromise.finally(() => {
          inFlight.delete(tracked);
        });
        inFlight.add(tracked);
      }
    };

    while (queue.length > 0 || inFlight.size > 0) {
      if (job?.isCancellationRequested() || stoppedReason !== undefined) {
        break;
      }

      scheduleNext();

      if (inFlight.size === 0) {
        if (!breaker.canRequest()) {
          await sleep(300);
          continue;
        }
        break;
      }

      await Promise.race(inFlight);
    }

    // A cancellation stops scheduling; edits already sent must finish before reporting the result.
    await Promise.all(inFlight);

    if (registry) {
      registry.unregister(breakerName);
    }

    return {
      ...coverage,
      skippedReadOnlyRows: entries.length - successCount - failures.length - queue.length,
      skippedChanged,
      dryRun: false,
      total,
      attempted: completed,
      successCount,
      failureCount: failures.length,
      failures,
      updatedIds,
      notAttemptedIds: queue.map((entry) => entry.recordId),
      notAttempted: queue.length,
      ...(stoppedReason !== undefined
        ? { stoppedReason, notAttempted: Math.max(0, total - completed) }
        : {})
    };
  }

  private async updateOneWithRetry(
    profile: ConnectionProfile,
    layout: string,
    entry: BatchUpdateEntry,
    adaptive: AdaptiveConcurrency,
    breaker: CircuitBreaker,
    fields: ReturnType<typeof extractFieldsFromMetadata>,
    job?: JobContext
  ): Promise<void> {
    const nulError = nulTextError(entry.fieldData);
    if (nulError) throw new Error(nulError);
    if (Object.keys(entry.fieldData).length === 0) return;
    let attempt = 0;
    let lastFailure: unknown;
    let outcomeUnknown = false;

    while (attempt < 3) {
      if (job?.isCancellationRequested()) throw lastFailure ?? new Error('Update cancelled before it was sent.');
      const startedAt = Date.now();
      try {
        if (entry.modId !== undefined && entry.modId !== '') {
          await this.fmClient.editRecord(profile, layout, entry.recordId, entry.fieldData, undefined, { modId: entry.modId });
        } else {
          await this.fmClient.editRecord(profile, layout, entry.recordId, entry.fieldData);
        }
        adaptive.recordSuccess(Date.now() - startedAt);
        breaker.recordSuccess();
        return;
      } catch (error) {
        if (outcomeUnknown && error instanceof FMClientError && error.code === '306') {
          if (job?.isCancellationRequested()) throw new UnconfirmedUpdateError();
          try {
            const current = await this.fmClient.getRecord(profile, layout, entry.recordId);
            if (Object.entries(entry.fieldData).every(([name, value]) => sameWrittenValue(current.fieldData[name], value, fieldType(metadataForField(fields, name)?.result) === 'number'))) {
              adaptive.recordSuccess(Date.now() - startedAt);
              breaker.recordSuccess();
              return;
            }
          } catch { /* A failed read cannot settle whether the first write succeeded. */ }
          throw new UnconfirmedUpdateError();
        }
        lastFailure = error;
        const status = getStatusFromError(error);
        const retryable = isBatchRetryable(error);
        // Only trouble with the connection or the server slows the job down or opens the
        // breaker. A FileMaker answer about one record (locked, validation, no privilege) says
        // nothing about server health.
        if (isServerTrouble(error)) {
          adaptive.recordFailure(status);
          breaker.recordFailure();
        }

        if (job?.isCancellationRequested() || !retryable || attempt >= 2) {
          throw error;
        }

        if (!(error instanceof FMClientError) || error.code === undefined) outcomeUnknown = true;
        const asked = error instanceof FMClientError ? (error.retryAfterMs ?? 0) : 0;
        await sleep(Math.max(adaptive.getBackoffDelayMs(attempt, status), Math.min(asked, MAX_RETRY_AFTER_MS)));
        attempt += 1;
      }
    }
  }
}

/** Compare reread values without changing the fields or values sent to FileMaker. */
function sameWrittenValue(left: unknown, right: unknown, numeric: boolean): boolean {
  const normalize = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    const text = value.replace(/\r\n?/g, '\n');
    if (!numeric) return text;
    const numberText = text.trimEnd();
    // Accept FileMaker's grouped numbers, but keep malformed or unsafe numbers exact.
    return numericText(/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(numberText)
      ? numberText.replace(/,/g, '') : numberText);
  };
  return stableStringify(normalize(left)) === stableStringify(normalize(right));
}

class UnconfirmedUpdateError extends FMClientError {
  public constructor() {
    super('Could not confirm: the first attempt may have succeeded. Reload this record and check its values before trying again.', { code: '306' });
  }
}

const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Retry a failed update only when it can succeed later: a connection or gateway problem, HTTP 429
 * or 503 (honouring Retry-After), or a FileMaker answer that clears (a record in use, 301). A
 * FileMaker business error (HTTP 500 with a code) is an answer, not an outage, and is not retried.
 */
function isBatchRetryable(error: unknown): boolean {
  if (!(error instanceof FMClientError)) {
    return false;
  }
  if (error.code === '306') return false;
  if (error.code !== undefined) {
    return error.isRetryable === true;
  }
  return error.isRetryable === true || error.status === 429 || (typeof error.status === 'number' && error.status >= 500);
}

/** Trouble that says something about the server or the connection, not about one record. */
function isServerTrouble(error: unknown): boolean {
  if (!(error instanceof FMClientError)) {
    return true;
  }
  return error.code === undefined || error.code === '956' || error.code === '1701';
}

/**
 * Codes that say the account cannot do this at all (not "this record"): insufficient privileges (9),
 * no privilege to create records (205), no privilege to change the schema (207). Anything else in
 * the privilege group, above all 200 "Record access is denied", can come from a record-level access
 * rule that hides one record and not the next, so it fails that record only.
 */
const ACCOUNT_WIDE_CODES = new Set(['9', '205', '207']);

/** The account cannot do this at all: stop instead of failing every remaining record the same way. */
function stopsTheJob(error: unknown): boolean {
  if (!(error instanceof FMClientError)) {
    return false;
  }
  return (
    (error.code !== undefined && ACCOUNT_WIDE_CODES.has(error.code)) ||
    isCredentialRejection(error.code) ||
    error.fmCategory === 'credentials'
  );
}

export function inferExportFormat(outputPath: string): BatchExportFormat {
  const extension = extname(outputPath).toLowerCase();
  if (extension === '.csv') {
    return 'csv';
  }

  return 'jsonl';
}

export function parseBatchUpdateInput(content: string, format: 'json' | 'csv'): BatchUpdateEntry[] {
  if (looksLikeJsonl(content, format === 'json')) throw new Error('This looks like a JSONL file; export as comma-separated CSV.');
  if (format === 'json') {
    const parsed = JSON.parse(content) as unknown;

    if (!Array.isArray(parsed)) {
      throw new Error('Batch update JSON must be an array.');
    }

    return parsed.map((entry) => normalizeBatchUpdateEntry(entry));
  }

  return parseCsvBatchUpdates(content);
}

function parseCsvBatchUpdates(content: string): BatchUpdateEntry[] {
  const firstLine = content.replace(/^\uFEFF/, '').split(/\r?\n/)[0] ?? '';
  if (!parseCsv(firstLine)[0]?.some((header) => /^(?:_{2,})?recordId$/.test(header)) && firstLine.includes(';') && parseCsv(firstLine, ';')[0]?.some((header) => /^(?:_{2,})?recordId$/.test(header))) {
    throw new Error('This looks like a semicolon-delimited file; export as comma-separated CSV.');
  }
  const rows = parseCsv(content.replace(/^\uFEFF/, ''));
  if (rows.length === 0) {
    return [];
  }

  const headers = rows[0]?.map(restoreFormulaText);
  if (!headers) {
    return [];
  }
  if (new Set(headers).size !== headers.length) throw new Error('Ambiguous CSV: duplicate column names. Export again with unique metadata columns.');
  const reserved = /^(_{2,})recordId$/.exec(headers[0] ?? '');
  const recordColumn = reserved && headers[1] === `${reserved[1]}modId` ? headers[0]! : 'recordId';
  const modColumn = recordColumn === 'recordId' ? 'modId' : `${reserved![1]}modId`;
  if (recordColumn === 'recordId' && !(headers[0] === 'recordId' && headers[1] === 'modId') && headers.some((header) => {
    const match = /^(_{2,})recordId$/.exec(header);
    return match && headers.includes(`${match[1]}modId`);
  })) throw new Error('Ambiguous CSV: keep the two reserved record columns together at the start of the file.');
  const recordIdIndex = headers.indexOf(recordColumn);
  if (recordIdIndex < 0) throw new Error('CSV must include a "recordId" column (or reserved __recordId and __modId columns).');

  const lastColumn = headers.length - 1;
  const exportNoteColumn = /^_+portalNote \(export information\)$/.test(headers[lastColumn] ?? '') && rows.slice(1).every((row) =>
    !row[lastColumn] || row[lastColumn]!.split('; ').every((part) => /^.+: showing \d+ of \d+$/.test(part)));
  const entries: BatchUpdateEntry[] = [];

  for (const row of rows.slice(1)) {
    const recordId = row[recordIdIndex]?.trim();
    if (!recordId) {
      continue;
    }

    const fieldData: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    headers.forEach((header, index) => {
      if (header === recordColumn || header === modColumn || (index === lastColumn && exportNoteColumn)) {
        return;
      }

      const value = row[index];
      if (value === undefined || value === '') {
        return;
      }

      fieldData[header] = restoreFormulaText(value);
    });

    const modId = row[headers.indexOf(modColumn)]?.trim();
    const entry: BatchUpdateEntry = { recordId, ...(modId !== undefined && modId !== '' ? { modId } : {}), fieldData };
    Object.defineProperties(entry, { sourceFormat: { value: 'csv' }, csvRecordColumn: { value: recordColumn } });
    entries.push(entry);
  }

  return entries;
}

function looksLikeJsonl(content: string, requireMultipleLines: boolean): boolean {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (!lines.length || (requireMultipleLines && lines.length < 2)) return false;
  return lines.every((line) => {
    try {
      const value = JSON.parse(line) as unknown;
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    } catch { return false; }
  });
}

function parseCsv(content: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentValue = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentValue += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      currentRow.push(currentValue);
      currentValue = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i += 1;
      }

      currentRow.push(currentValue);
      rows.push(currentRow);
      currentRow = [];
      currentValue = '';
      continue;
    }

    currentValue += char;
  }

  if (currentValue.length > 0 || currentRow.length > 0) {
    currentRow.push(currentValue);
    rows.push(currentRow);
  }

  return rows.filter((row) => row.some((cell) => cell.trim().length > 0));
}

function normalizeBatchUpdateEntry(input: unknown): BatchUpdateEntry {
  if (!input || typeof input !== 'object') {
    throw new Error('Batch update entries must be objects.');
  }

  const record = input as Record<string, unknown>;
  const recordId = record.recordId;
  if (typeof recordId !== 'string' || recordId.trim().length === 0) {
    throw new Error('Batch update entries must include a recordId string.');
  }

  const fieldData = record.fieldData;
  if (!fieldData || typeof fieldData !== 'object' || Array.isArray(fieldData)) {
    throw new Error('Batch update entries must include a fieldData object.');
  }

  if (record.modId !== undefined && typeof record.modId !== 'string') throw new Error('Batch update modId must be a string.');
  return {
    recordId: recordId.trim(),
    ...(typeof record.modId === 'string' && record.modId.trim() !== '' ? { modId: record.modId.trim() } : {}),
    fieldData: fieldData as Record<string, unknown>
  };
}

function normalizeMaxRecords(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    return 10_000;
  }

  return Math.min(value, 250_000);
}

function normalizePageSize(value: number | undefined, performanceMode: PerformanceMode): number {
  if (!value || !Number.isInteger(value) || value <= 0) {
    return performanceMode === 'high-scale' ? 400 : 100;
  }

  return Math.min(value, performanceMode === 'high-scale' ? 1000 : 500);
}

function clampConcurrency(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    return 4;
  }

  return Math.max(1, Math.min(value, 10));
}

function getStatusFromError(error: unknown): number | undefined {
  if (error instanceof FMClientError) {
    return error.status;
  }

  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
