import { FMClientError } from '../services/errors';

/**
 * Portal (related) row support for Create Record.
 *
 * FileMaker's Data API accepts `portalData` on record creation: rows without a
 * `recordId` become new related rows, linked through the portal's match field.
 * Names are preserved exactly as FileMaker reports them; never trim them.
 */

/** A portal of the layout, with the display names of the fields a new row may set. */
export interface PortalRowSpec {
  /** The portal name: the key of the layout metadata's `portalMetaData`. */
  portal: string;
  /** Field names with any `Portal::` prefix stripped (as the create form shows them). */
  fields: string[];
}

/** Related rows to create, keyed by portal name (the Data API `portalData` shape). */
export type CreatePortalData = Record<string, Array<Record<string, unknown>>>;

export const MAX_PORTAL_ROWS_PER_PORTAL = 100;
export const MAX_PORTAL_ROWS_TOTAL = 500;

function portalMetaDataOf(metadata: unknown): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }
  const record = metadata as Record<string, unknown>;
  const direct = record.portalMetaData;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }
  const response = record.response;
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const nested = (response as Record<string, unknown>).portalMetaData;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
  }
  return undefined;
}

/** Field display name: the Data API names portal fields `Portal::Field`; show only the field part. */
export function stripPortalPrefix(portal: string, fieldName: string): string {
  return fieldName.startsWith(`${portal}::`) ? fieldName.slice(portal.length + 2) : fieldName;
}

/**
 * Read the layout metadata's `portalMetaData` into create-row specs.
 * Returns an empty array when the metadata carries no portal information.
 */
export function extractPortalSpecs(metadata: unknown): PortalRowSpec[] {
  const portalMetaData = portalMetaDataOf(metadata);
  if (!portalMetaData) {
    return [];
  }
  return Object.entries(portalMetaData).map(([portal, entries]) => ({
    portal,
    fields: Array.isArray(entries)
      ? entries
          .filter((entry) => entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).name === 'string')
          .map((entry) => stripPortalPrefix(portal, String((entry as Record<string, unknown>).name)))
      : []
  }));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function emptyValue(value: unknown): boolean {
  return value === '' || value === undefined || value === null;
}

/**
 * Validate and normalize raw `portalData` for a create.
 *
 * Rows are new related rows, so a `recordId` or `modId` key is refused; values must
 * be scalar (text, number or boolean). Empty values and fully empty rows are dropped.
 * Returns `undefined` when no row carries a value, so callers keep their old call
 * shape; throws an FMClientError describing the first problem found.
 */
export function sanitizeCreatePortalData(raw: unknown): CreatePortalData | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!isPlainObject(raw)) {
    throw new FMClientError('portalData must be an object keyed by portal name.', { status: 400 });
  }

  const portalNames = Object.keys(raw);
  if (portalNames.length === 0) {
    return undefined;
  }

  const result: CreatePortalData = {};
  let total = 0;
  for (const portal of portalNames) {
    const rows = raw[portal];
    if (!Array.isArray(rows)) {
      throw new FMClientError(`Portal "${portal}" rows must be an array.`, { status: 400 });
    }
    if (rows.length > MAX_PORTAL_ROWS_PER_PORTAL) {
      throw new FMClientError(`Portal "${portal}" has ${rows.length} rows; at most ${MAX_PORTAL_ROWS_PER_PORTAL} related rows can be created at once.`, { status: 400 });
    }

    const kept: Array<Record<string, unknown>> = [];
    for (const [index, row] of rows.entries()) {
      if (!isPlainObject(row)) {
        throw new FMClientError(`Portal "${portal}" row ${index + 1} must be an object of field values.`, { status: 400 });
      }
      if (row.recordId !== undefined || row.modId !== undefined) {
        throw new FMClientError(`Portal "${portal}" row ${index + 1} sets recordId/modId; create only adds new related rows.`, { status: 400 });
      }
      const fields = Object.fromEntries(
        Object.entries(row).filter(([, value]) => {
          if (emptyValue(value)) return false;
          if (!isScalar(value)) {
            throw new FMClientError(`Portal "${portal}" row ${index + 1} has a non-text value; related rows accept only text, number or boolean values.`, { status: 400 });
          }
          return true;
        })
      );
      if (Object.keys(fields).length > 0) {
        kept.push(fields);
      }
    }

    if (kept.length > 0) {
      result[portal] = kept;
      total += kept.length;
    }
    if (total > MAX_PORTAL_ROWS_TOTAL) {
      throw new FMClientError(`At most ${MAX_PORTAL_ROWS_TOTAL} related rows can be created at once.`, { status: 400 });
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
