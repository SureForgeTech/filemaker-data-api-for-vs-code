export interface CsvExportOptions {
  excelCompatible?: boolean;
  columns?: string[];
  includeHeader?: boolean;
  lineEnding?: '\n' | '\r\n';
  /** Defuse text that a spreadsheet would run as a formula. On by default. */
  neutralizeFormulas?: boolean;
}

const PLAIN_NUMBER = /^[-+]?(\d+(?:\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
/** Signed numbers and phone numbers such as `-1,234.5` or `+1 (555) 123-4567`. */
const NUMBER_OR_PHONE = /^[-+][\d\s().,/-]*$/;

/**
 * Spreadsheets run a cell that starts with `=`, `+`, `-`, `@`, tab or carriage return as a
 * formula (`=HYPERLINK(...)`, `+cmd|...`). Text from a database can start that way, so it is
 * prefixed with an apostrophe, which spreadsheets treat as "this is text". Plain numbers such
 * as `-5` are left alone. Keep in step with ui/cellText.js in the Query Builder webview (copy
 * as table); test/unit/queryBuilderCellText.test.ts compares the two.
 */
export function neutralizeFormula(text: string): string {
  if (!/^'*[=+\-@\t\r]/.test(text) || PLAIN_NUMBER.test(text) || (NUMBER_OR_PHONE.test(text) && /\d/.test(text))) {
    return text;
  }

  return `'${text}`;
}

export function escapeCsvValue(value: unknown, options?: { neutralizeFormulas?: boolean }): string {
  if (value === undefined || value === null) {
    return '';
  }

  let normalized: string;

  if (typeof value === 'string') {
    normalized = value;
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    normalized = String(value);
  } else {
    try {
      normalized = JSON.stringify(value);
    } catch {
      normalized = String(value);
    }
  }

  if (typeof value === 'string' && options?.neutralizeFormulas !== false) {
    normalized = neutralizeFormula(normalized);
  }

  const escaped = normalized.replace(/"/g, '""');
  if (/[",\n\r]/.test(escaped)) {
    return `"${escaped}"`;
  }

  return escaped;
}

export function recordsToCsv(
  rows: Array<Record<string, unknown> | Map<string, unknown>>,
  options?: CsvExportOptions
): string {
  const lineEnding = options?.lineEnding ?? '\n';
  const includeHeader = options?.includeHeader ?? true;

  const columns =
    options?.columns ??
    Array.from(
      rows.reduce((set, row) => {
        (row instanceof Map ? [...row.keys()] : Object.keys(row)).forEach((key) => set.add(key));
        return set;
      }, new Set<string>())
    );

  const lines: string[] = [];

  if (includeHeader) {
    lines.push(columns.map((column) => escapeCsvValue(column, options)).join(','));
  }

  for (const row of rows) {
    lines.push(columns.map((column) => escapeCsvValue(row instanceof Map ? row.get(column) : (Object.hasOwn(row, column) ? row[column] : undefined), options)).join(','));
  }

  return (options?.excelCompatible ? '\uFEFF' : '') + lines.join(lineEnding);
}

/** Reverses `neutralizeFormula` when reading back a file this extension exported. */
export function restoreFormulaText(text: string): string {
  return /^'+[=+\-@\t\r]/.test(text) ? text.slice(1) : text;
}
