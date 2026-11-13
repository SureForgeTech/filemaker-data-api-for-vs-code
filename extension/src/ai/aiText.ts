import { filterName } from '../services/aiContextRenderer';

/** Text that replaces a value the policy removed or could not show. */
export const HIDDEN_MARKER = '[hidden]';
export const REDACTION_MARKER = '***';
export const OMITTED_NAME = '[name omitted]';
export const SERVER_MARKER = '[server]';
export const URL_OMITTED_MARKER = '[container or server URL omitted]';
export const CONTAINER_MARKER = '[container field omitted]';
/** Text the tools put in place of something they hid; a write may not contain any of it. */
export const PLACEHOLDER_MARKERS: readonly string[] = [
  '***',
  HIDDEN_MARKER,
  SERVER_MARKER,
  URL_OMITTED_MARKER,
  CONTAINER_MARKER
];

/**
 * Makes untrusted text safe to put on one line of a dialog or log: capped to `max`
 * characters, JSON-escaped (quotes, backslashes, newlines and other control characters), and
 * with the characters JSON leaves alone but that can reorder or split text (U+2028/9, bidi and
 * other format characters) and markdown control characters written as \uXXXX. A cut is
 * marked outside the quotes.
 */
export function displayText(value: unknown, max = 80): string {
  const text = typeof value === 'string' ? value : String(value);
  const characters = Array.from(text);
  const kept = characters.slice(0, max).join('');
  // Also written as \uXXXX: the characters that make markdown links, images, HTML, code and
  // emphasis. The VS Code docs do not say whether a modal's `detail` renders markdown, so none
  // of these may reach a dialog as itself.
  const escaped = JSON.stringify(kept).replace(
    /[\p{C}\p{Default_Ignorable_Code_Point}\u2028\u2029[\]<>`*~|]/gu,
    (character) => character.split('').map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
  );
  const cut = characters.length - Math.min(characters.length, max);
  return cut > 0 ? `${escaped}…(+${cut} more characters)` : escaped;
}

/** A name that is safe to show the model and send back unchanged (layouts and scripts: the Phase 1 allowlist). */
export function safeNameOrUndefined(name: unknown): string | undefined {
  const result = filterName(name);
  return result.replaced ? undefined : result.text;
}

const FIELD_NAME_MAX = 128;

/**
 * A field name the model must be able to send back exactly (ADR-0004 rule 6): kept as it is
 * unless it is long or contains control, format or separator characters, which hide or split text.
 */
export function exactFieldNameOrUndefined(name: unknown): string | undefined {
  if (typeof name !== 'string' || name.trim().length === 0 || Array.from(name).length > FIELD_NAME_MAX) {
    return undefined;
  }
  return /[\p{C}\u2028\u2029]/u.test(name) ? undefined : name;
}

/**
 * Normalizes a field name for comparison: trimmed, NFC, lower case, and without a trailing
 * repetition number. The Data API addresses one repetition of a repeating field as
 * `Name(2)` (the form used in `fieldData` keys; I could not confirm this on the Claris
 * Data API Guide pages reachable here, so both the plain and the numbered form are hidden).
 */
function normalizeFieldName(name: string): string {
  return name
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/\s*\(\d+\)$/, '');
}

/** The field name without its repetition number, as the base of a container check. */
export function baseFieldName(name: string): string {
  return name.replace(/\s*\(\d+\)$/, '');
}

/** The two forms a field name is compared by: with its `Table::` prefix, and without it. */
function nameForms(name: string): string[] {
  const full = normalizeFieldName(name);
  const index = full.lastIndexOf('::');
  return index >= 0 ? [full, full.slice(index + 2).trim()] : [full];
}

/**
 * Best-effort hidden-field filter (ADR-0004 rule 8). The Data API gives no base table for a
 * field, so an entry hides every field with the same normalized name, with or without a
 * `Table::` prefix, on every layout. It does not stop disclosure through a calculation,
 * summary field or script on another layout; a restricted FileMaker account does.
 */
export class HiddenFields {
  private readonly forms: Set<string>;

  public constructor(entries: readonly string[]) {
    this.forms = new Set(entries.flatMap((entry) => nameForms(entry)).filter((form) => form.length > 0));
  }

  public isHidden(fieldName: string): boolean {
    return nameForms(fieldName).some((form) => this.forms.has(form));
  }

  /** A copy without the hidden keys (also used for portal rows). */
  public stripKeys<T>(record: Record<string, T>): Record<string, T> {
    return Object.fromEntries(Object.entries(record).filter(([key]) => !this.isHidden(key)));
  }
}

/**
 * Generic scrub for text that goes to the model: IP addresses, absolute file paths and host
 * names (a TLS error names the certificate's DNS names). Applied to error text and audit notes.
 */
export function scrubGenericText(text: string): string {
  return text
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, '[address]')
    .replace(/(?<![\w:])[0-9a-f:]{3,}(?![\w:])/gi, (token) =>
      token.split(':').length > 2 && /[0-9a-f]/i.test(token) ? '[address]' : token
    )
    .replace(/[A-Za-z]:\\[^\s'"<>|]+/g, '[path]')
    .replace(/(?<![\w.:@-])\/(?:[\w.~@%+-]+\/)+[\w.~@%+-]*/g, '[path]')
    .replace(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/gi, '[host]');
}
