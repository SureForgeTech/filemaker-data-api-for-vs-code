import { createHash } from 'crypto';

/**
 * Text that comes from a FileMaker database (layout, field and script names) or a profile is
 * written into generated source files and file names. Whoever can name things in the database
 * controls it, so it is escaped for the place it lands.
 */

/**
 * Makes `value` safe to put inside a line or block comment: control characters and line
 * breaks (including U+2028 and U+2029) become visible escapes, so the text cannot end the
 * comment or start a new line of code, and the end-of-comment marker cannot close a block comment early.
 */
export function commentText(value: string): string {
  return JSON.stringify(value)
    .slice(1, -1)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/\*\//g, '*\\/');
}

/** Escapes `value` for the inside of a single-quoted JavaScript or TypeScript string literal. */
export function singleQuotedText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Escapes `value` for the default text of a VS Code snippet placeholder (`${1:value}`). */
export function snippetPlaceholderText(value: string): string {
  return singleQuotedText(value).replace(/[\\$}]/g, (character) => `\\${character}`);
}

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Turns a file-safe base name (already reduced to letters, digits and `_.-`) into one that
 * cannot collide with a different original name or mean something special:
 *  - when the sanitized name differs from the original in any way (characters dropped or
 *    replaced, spaces folded, text cut short), a short hash of the original is appended, so
 *    `A/B`, `A:B`, `My Layout` and `My_Layout` stay separate files;
 *  - Windows device names (`CON`, `NUL`, `COM1`, ...) get a leading underscore;
 *  - a name made only of dots, or empty, becomes `layout`.
 */
export function distinctFileName(original: string, sanitized: string, fallback = 'layout'): string {
  let name = sanitized;
  if (name.length === 0 || /^\.+$/.test(name)) {
    name = fallback;
  }

  if (sanitized !== original || name === fallback) {
    const hash = createHash('sha1').update(original).digest('hex').slice(0, 8);
    name = name === fallback && original.trim().length === 0 ? name : `${name}-${hash}`;
  }

  return WINDOWS_RESERVED_NAMES.test(name) ? `_${name}` : name;
}

/**
 * A snapshot or cache file name taken from an index file in the workspace: a plain `.json`
 * name, no path. Dots may appear inside the name (a layout called `Q1..Q2` is stored as
 * `...__Q1..Q2__....json`), because without a separator a run of dots cannot leave the
 * folder. What is refused is anything that could: a path separator, a drive letter or
 * other character outside `A-Za-z0-9_.-`, a segment that is `.` or `..`, and a name with
 * nothing but dots before `.json`.
 */
export function isPlainJsonFileName(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\.json$/.test(value)) {
    return false;
  }

  const stem = value.slice(0, -'.json'.length);
  return !/^\.*$/.test(stem) && value.split(/[\\/]/).every((segment) => segment !== '.' && segment !== '..');
}

/** A suggested export basename only; the original database name is kept in requests and data. */
export function safeFileName(name: string): string {
  const safe = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
  return WINDOWS_RESERVED_NAMES.test(safe) ? `_${safe}` : safe || 'export';
}
