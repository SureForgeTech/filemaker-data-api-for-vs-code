import { describe, expect, it } from 'vitest';

import { HiddenFields, displayText, exactFieldNameOrUndefined, safeNameOrUndefined } from '../../../src/ai/aiText';

describe('displayText', () => {
  it('JSON-escapes quotes, newlines and backslashes so a value stays on one line', () => {
    expect(displayText('a"b\nc\\d')).toBe('"a\\"b\\nc\\\\d"');
  });

  it('escapes separators and bidi/format characters that JSON leaves alone', () => {
    const text = displayText('a\u2028b\u2029c\u202ed\u200be');
    expect(text).toBe('"a\\u2028b\\u2029c\\u202ed\\u200be"');
    expect(text).not.toMatch(/[\u2028\u2029\u202e\u200b]/);
  });

  it('escapes supplementary hidden characters as UTF-16 pairs without losing the exact text', () => {
    const input = ' 🦊中é e\u0301 \ud800\udfff ';
    const text = displayText(input);
    expect(text).toBe('" 🦊中é e\u0301 \\ud800\\udfff "');
    expect(JSON.parse(text)).toBe(input);
  });

  it('visibly escapes default-ignorable characters, including supplementary variation selectors', () => {
    const input = ' A\u034f\u3164\ufe0f\u{e0100} ';
    const text = displayText(input);
    expect(text).toBe('" A\\u034f\\u3164\\ufe0f\\udb40\\udd00 "');
    expect(JSON.parse(text)).toBe(input);
  });

  it('cuts to the limit and marks the cut outside the quotes', () => {
    expect(displayText('x'.repeat(500), 10)).toBe(`"${'x'.repeat(10)}"…(+490 more characters)`);
  });

  it('cannot be made to look like extra lines or a fake header', () => {
    const text = displayText('Layout: "Safe"\nConnection: "Other"');
    expect(text.split('\n')).toHaveLength(1);
  });
});

describe('names', () => {
  it('layout and script names follow the Phase 1 allowlist', () => {
    expect(safeNameOrUndefined('Contacts 2')).toBe('Contacts 2');
    expect(safeNameOrUndefined('a`b')).toBeUndefined();
    expect(safeNameOrUndefined('a/b')).toBeUndefined();
  });

  it('field names are kept exactly unless they hide or split text', () => {
    expect(exactFieldNameOrUndefined("Owner's Name/Id")).toBe("Owner's Name/Id");
    expect(exactFieldNameOrUndefined('Orders::Total')).toBe('Orders::Total');
    expect(exactFieldNameOrUndefined('a\nb')).toBeUndefined();
    expect(exactFieldNameOrUndefined('a\u202eb')).toBeUndefined();
    expect(exactFieldNameOrUndefined('x'.repeat(129))).toBeUndefined();
    expect(exactFieldNameOrUndefined('   ')).toBeUndefined();
  });
});

describe('HiddenFields', () => {
  it('matches case-insensitively, trimmed, with and without a table prefix', () => {
    const hidden = new HiddenFields([' Salary ', 'Emp::SSN']);
    for (const name of ['Salary', 'salary', 'SALARY ', 'Emp::Salary', 'Other::SALARY', 'SSN', 'Emp::ssn', 'X::SSN']) {
      expect(hidden.isHidden(name), name).toBe(true);
    }
    for (const name of ['Salaries', 'Pay', 'Emp::Name']) {
      expect(hidden.isHidden(name), name).toBe(false);
    }
  });

  it('matches composed and decomposed forms of the same accented name', () => {
    expect(new HiddenFields(['Café']).isHidden('Café')).toBe(true);
  });

  it('strips hidden keys', () => {
    expect(new HiddenFields(['b']).stripKeys({ a: 1, B: 2, 'T::b': 3 })).toEqual({ a: 1 });
  });
});
