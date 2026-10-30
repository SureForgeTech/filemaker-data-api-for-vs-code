/** Pure record rules shared by the Record Editor and generated FM Web pages. */
export interface RecordFieldMetadata {
  name: string;
  type?: string;
  result?: string;
  required?: boolean;
  notEmpty?: boolean;
  validation?: unknown;
  global?: unknown;
}

export type FieldKind = 'normal' | 'calculation' | 'summary' | 'container' | 'global';

export function layoutFieldKind(field: RecordFieldMetadata): FieldKind {
  const readOnly = readOnlyFieldKind(field);
  if (readOnly) return readOnly;
  return field.global === true || fieldType(field.global) === 'true' || fieldType(field.type) === 'global' ? 'global' : 'normal';
}

export function fieldType(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function readOnlyFieldKind(field?: RecordFieldMetadata): 'calculation' | 'summary' | 'container' | undefined {
  const type = fieldType(field?.type);
  if (type === 'calculation' || type === 'summary') return type;
  const result = fieldType(field?.result);
  if (result === 'calculation' || result === 'summary') return result;
  if (result === 'container' || type === 'container') return 'container';
  return undefined;
}

/** Resolve access hints even for layouts saved before kind was recorded. */
export function runtimeFieldKind(field: { fmFieldName: string; kind?: string; result?: string; metadata?: { type?: string; result?: string } }): FieldKind {
  const readOnly = readOnlyFieldKind({ name: field.fmFieldName, type: field.kind, result: field.result })
    ?? readOnlyFieldKind({ name: field.fmFieldName, ...field.metadata });
  if (readOnly) return readOnly;
  return field.kind === 'global' ? 'global' : 'normal';
}

export function fieldKindNote(kind?: FieldKind): string | undefined {
  if (kind === 'calculation') return 'Calculated by FileMaker; cannot be edited';
  if (kind === 'summary') return 'Summary field; cannot be edited';
  if (kind === 'container') return 'Use Upload to container';
  if (kind === 'global') return 'Session-wide: changes apply throughout this session.';
  return undefined;
}

/**
 * The key a record holds the value of the field `name` under: the exact name when the record has
 * it, otherwise the lowest numbered repetition, which is where the record keeps its value.
 * An edit must be written back under the key the value came from, so that one repetition of a
 * repeating field never overwrites another.
 */
export function recordFieldKey(values: Record<string, unknown>, name: string): string {
  if (Object.prototype.hasOwnProperty.call(values, name)) return name;
  const first = `${name}(1)`;
  if (Object.prototype.hasOwnProperty.call(values, first)) return first;
  const prefix = `${name}(`;
  let lowest: { key: string; number: number } | undefined;
  for (const key of Object.keys(values)) {
    if (!key.startsWith(prefix) || !key.endsWith(')')) continue;
    const repetition = key.slice(prefix.length, -1);
    if (!/^\d+$/.test(repetition)) continue;
    const number = Number(repetition);
    if (Number.isSafeInteger(number) && number >= 2 && (!lowest || number < lowest.number)) lowest = { key, number };
  }
  return lowest?.key ?? name;
}

export function computeRecordPatch(originalFieldData: Record<string, unknown>, draftFieldData: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const keys = new Set([...Object.keys(originalFieldData), ...Object.keys(draftFieldData)]);

  for (const key of keys) {
    const before = originalFieldData[key];
    const after = draftFieldData[key];

    if (!deepEqual(before, after)) {
      patch[key] = after;
    }
  }

  return patch;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return left === right || stableRecordStringify(left) === stableRecordStringify(right);
}

export function stableRecordStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableRecordStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableRecordStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function validateRecordDraft(draftFieldData: Record<string, unknown>, fields?: RecordFieldMetadata[]): { valid: boolean; errors: Array<{ field: string; message: string }> } {
  const errors: Array<{ field: string; message: string }> = [];

  for (const [name, value] of Object.entries(draftFieldData)) {
    const reason = getJsonUnsafeReason(value);
    if (reason) {
      errors.push({
        field: name,
        message: reason
      });
    }
  }

  if (fields) {
    for (const field of fields) {
      if (readOnlyFieldKind(field)) continue;
      const required = recordFieldRequired(field);
      if (!required) {
        continue;
      }

      // A repeated field keeps its value under its lowest available repetition, so the record holds it under that
      // key; the required check looks where the value is, not under the bare field name.
      const value = draftFieldData[recordFieldKey(draftFieldData, field.name)];
      if (value === undefined || value === null || value === '') {
        errors.push({
          field: field.name,
          message: 'Field is required by metadata hints.'
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function getJsonUnsafeReason(value: unknown): string | undefined {
  if (value === undefined) {
    return 'Undefined values are not valid JSON values.';
  }

  if (typeof value === 'bigint') {
    return 'BigInt values are not supported by JSON serialization.';
  }

  if (typeof value === 'function') {
    return 'Function values are not valid JSON values.';
  }

  if (typeof value === 'symbol') {
    return 'Symbol values are not valid JSON values.';
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const reason = getJsonUnsafeReason(entry);
      if (reason) {
        return reason;
      }
    }
  }

  if (value && typeof value === 'object') {
    for (const entryValue of Object.values(value as Record<string, unknown>)) {
      const reason = getJsonUnsafeReason(entryValue);
      if (reason) {
        return reason;
      }
    }
  }

  return undefined;
}

export function recordFieldRequired(field: RecordFieldMetadata): boolean {
  if (typeof field.required === 'boolean') {
    return field.required;
  }

  if (typeof field.notEmpty === 'boolean') {
    return field.notEmpty;
  }

  if (field.validation && typeof field.validation === 'object') {
    const record = field.validation as Record<string, unknown>;
    if (typeof record.required === 'boolean') {
      return record.required;
    }

    if (typeof record.notEmpty === 'boolean') {
      return record.notEmpty;
    }
  }

  return false;
}

/** Convert only finite decimal text whose exact magnitude is in the safe integer range. */
export function numericText(value: string): number | string {
  const match = /^[-+]?(\d+\.?\d*|\.\d+)(?:[eE]([-+]?\d+))?$/.exec(value);
  if (!match) return value;
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  const mantissa = match[1]!;
  const digits = mantissa.replace('.', '').replace(/^0+/, '');
  if (!digits) return number;
  if (number === 0) return value; // A nonzero decimal underflowed.
  const places = digits.length + Number(match[2] ?? 0) - (mantissa.split('.')[1]?.length ?? 0);
  if (places < 16) return number;
  if (places > 16) return value;
  const integer = digits.slice(0, places).padEnd(places, '0');
  if (integer < '9007199254740991') return number;
  if (integer === '9007199254740991' && /^0*$/.test(digits.slice(places))) return number;
  return value;
}

/** Observed on the FileMaker server we tested; refuse NUL to prevent possible data loss. */
export const NUL_TEXT_WARNING = 'On the FileMaker server we tested, FileMaker kept only the text before this character and dropped the rest.';

export function containsNulText(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\0');
  if (Array.isArray(value)) return value.some(containsNulText);
  if (value && typeof value === 'object') return Object.values(value).some(containsNulText);
  return false;
}

export function nulTextFields(fields: Record<string, unknown>): string[] {
  return Object.keys(fields).filter((name) => containsNulText(fields[name]));
}

/** Remove only U+0000 from values, preserving all field names and all following text. */
export function removeNulText(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('\0', '');
  if (Array.isArray(value)) return value.map(removeNulText);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, removeNulText(item)]));
  }
  return value;
}

export function nulTextError(fields: Record<string, unknown>): string | undefined {
  const names = nulTextFields(fields);
  return names.length ? `NUL character (U+0000) in field(s): ${names.join(', ')}. ${NUL_TEXT_WARNING} Nothing in this row was written. Remove the character from the source and try again.` : undefined;
}

