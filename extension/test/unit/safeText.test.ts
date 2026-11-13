import { describe, expect, it } from 'vitest';

import { commentText, distinctFileName, isPlainJsonFileName, safeFileName, singleQuotedText, snippetPlaceholderText } from '../../src/utils/safeText';

describe('safeText', () => {
  it.each(['Invoices.jsonl', 'Sales.JSON', 'Mixed_Case-Report.csv'])('preserves the case and extension of %s', (name) => {
    expect(safeFileName(name)).toBe(name);
  });

  it('keeps the extension when shortening a long suggested filename', () => {
    const name = safeFileName('Invoices'.repeat(20) + '.jsonl');
    expect(name).toHaveLength(60);
    expect(name).toMatch(/^Invoices.*\.jsonl$/);
  });

  it.each(['../Invoices.jsonl', 'a/../b\\Report.csv', 'x\0\n.jsonl', '..', 'CON.jsonl', 'LPT1'])('confines suggested filename %j', (name) => {
    const safe = safeFileName(name);
    expect(safe).not.toMatch(/[\\/\p{C}]/u);
    expect(safe).not.toContain('..');
    expect(safe).not.toMatch(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i);
    expect(safe).not.toBe('');
  });

  it('keeps text inside a comment: no line breaks and no early block-comment end', () => {
    const text = commentText('A */ evil(); /*\nB\r\nC\u2028D\u2029E');
    expect(text).not.toMatch(/[\n\r\u2028\u2029]/);
    expect(text).not.toContain('*/');
  });

  it('escapes quotes, backslashes and line breaks for a single-quoted string', () => {
    expect(singleQuotedText("it's a \\ \n")).toBe("it\\'s a \\\\ \\n");
  });

  it('escapes snippet placeholder syntax', () => {
    const text = snippetPlaceholderText("a}$b'");
    // After VS Code reads the snippet, `\\` becomes `\`, so the code gets a\'.
    expect(text).toBe("a\\}\\$b\\\\'");
  });

  it('keeps layouts whose names differ only by punctuation as different files', () => {
    const names = ['A/B', 'A:B', 'A?B'].map((name) => distinctFileName(name, name.replace(/[^A-Za-z0-9_.-]+/g, '_')));
    expect(new Set(names).size).toBe(3);
  });

  it('keeps spacing variants, underscores and cut-short names apart', () => {
    const clean = (name: string) => name.replace(/\s+/g, '_').slice(0, 120);
    const names = ['My Layout', 'My  Layout', 'My_Layout', 'x'.repeat(130) + 'a', 'x'.repeat(130) + 'b'].map((name) =>
      distinctFileName(name, clean(name))
    );
    expect(new Set(names).size).toBe(5);
  });

  it('accepts only plain json file names from an index', () => {
    expect(isPlainJsonFileName('p__L__2020__id.json')).toBe(true);
    for (const bad of ['../x.json', 'a/b.json', 'a\\b.json', '..json', 'x.txt', 5, undefined]) {
      expect(isPlainJsonFileName(bad)).toBe(false);
    }
  });

  it('accepts dots inside a layout-derived name such as Q1..Q2, so those entries are kept and pruned', () => {
    for (const good of [
      'p1__Q1..Q2__2020-01-01T00-00-00-000Z.json',
      'p1__a...b__x.json',
      'p1__v1.2..v1.3__x.json',
      '.hidden-but-plain.json',
      'x..json.json'
    ]) {
      expect(isPlainJsonFileName(good), good).toBe(true);
    }
  });

  it('still refuses path traversal and anything that is not a bare file name', () => {
    const traversal = [
      '..',
      '.',
      '.json',
      '..json',
      '...json',
      '../x.json',
      '..\\x.json',
      'a/../x.json',
      'a\\..\\x.json',
      '/etc/passwd.json',
      '\\\\server\\share\\x.json',
      'C:x.json',
      'C:\\x.json',
      'c:/x.json',
      'x.json/',
      'x.json\0',
      'x.json ',
      'a b.json',
      '..%2fx.json',
      'x.JSON.txt',
      ''
    ];
    for (const bad of traversal) {
      expect(isPlainJsonFileName(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('leaves plain names alone and avoids Windows device names and dot-only names', () => {
    expect(distinctFileName('Contacts', 'Contacts')).toBe('Contacts');
    expect(distinctFileName('CON', 'CON')).toBe('_CON');
    expect(distinctFileName('nul.txt', 'nul.txt')).toBe('_nul.txt');
    expect(distinctFileName('..', '..')).not.toMatch(/^\.+$/);
    expect(distinctFileName('', '')).toBe('layout');
  });
});
