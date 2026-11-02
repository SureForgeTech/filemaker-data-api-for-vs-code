import { describe, expect, it, vi } from 'vitest';
import {
  FIELD_LAYOUT,
  applyStandardField,
  checkboxValue,
  choiceDisplayType,
  createStandardControl,
  orderFields,
  preserveTextLineEndings,
  standardControlFor,
  standardFieldSize,
  standardFieldsCss
} from '../src/field-standards';
import type { StandardFieldMetadata } from '../src/field-standards';

describe('standard field presentation rules', () => {
  it.each([
    [{ name: 'Text', type: 'text' }, { kind: 'input', width: 240, height: 34, readOnly: false }],
    [{ name: 'Number', result: 'number' }, { kind: 'input', width: 120, height: 34, readOnly: false }],
    [{ name: 'Date', type: 'date' }, { kind: 'input', width: 160, height: 34, readOnly: false }],
    [{ name: 'Notes', maxLength: 0 }, { kind: 'textarea', width: 240, height: 96, readOnly: false }],
    [{ name: 'Notes', displayType: 'editText', height: 2 }, { kind: 'textarea', width: 240, height: 96, readOnly: false }],
    [{ name: 'Choice', displayType: 'popup menu' }, { kind: 'select', width: 240, height: 34, readOnly: false }],
    [{ name: 'Flags', displayType: 'checkbox set', optionCount: 3 }, { kind: 'checkbox', width: 240, height: 72, readOnly: false }],
    [{ name: 'Choice', displayType: 'radio', options: ['A'] }, { kind: 'radio', width: 240, height: 34, readOnly: false }],
    [{ name: 'Photo', type: 'container' }, { kind: 'container', width: 240, height: 160, readOnly: true }],
    [{ name: 'Total', kind: 'summary', result: 'number' }, { kind: 'input', width: 120, height: 34, readOnly: true }],
    [{ name: 'Find', type: 'container', freeText: true }, { kind: 'input', width: 240, height: 34, readOnly: true }]
  ] satisfies Array<[Partial<StandardFieldMetadata>, ReturnType<typeof standardControlFor>]>)('chooses control geometry from metadata without changing names: %j', (metadata, expected) => {
    expect(standardControlFor(metadata)).toEqual(expected);
  });

  it('keeps unresolved choices editable and preserves stored separators', () => {
    expect(choiceDisplayType('check Box', [])).toBe('editBox');
    expect(choiceDisplayType('radioButtons', ['A'])).toBe('radioButtons');
    expect(choiceDisplayType('editBox', [])).toBe('editBox');
    expect(preserveTextLineEndings('one\rtwo', 'one\ntwo\nthree')).toBe('one\rtwo\rthree');
    expect(preserveTextLineEndings('one\rtwo', 'one\rtwo')).toBe('one\rtwo');
    expect(checkboxValue(' B \r\nA\nUnlisted\r', ['A', ' B ', 'C', 'Unlisted'])).toBe(' B \r\nA\nUnlisted\rC\r');
    expect(checkboxValue('A\rB', ['B', 'A'])).toBe('A\rB');
    expect(checkboxValue('A', [])).toBe('');
  });

  it('orders only returned fields, numerically grouping repetitions and retaining exact names', () => {
    const values = { extra: '', 'Name(10)': '', ' Z ': '', 'Name(2)': '', Name: '', 'Name(1)': '' };
    expect(orderFields({ fieldMetaData: [{ name: ' Z ' }, { name: 'Name' }, { name: 'Hidden' }] }, values))
      .toEqual([' Z ', 'Name', 'Name(1)', 'Name(2)', 'Name(10)', 'extra']);
    expect(orderFields({ fields: [{ name: 'Name(2)' }] }, values)).toEqual(['Name', 'Name(1)', 'Name(2)', 'Name(10)', 'extra', ' Z ']);
    expect(orderFields(undefined, values)).toEqual(Object.keys(values));
  });
});

describe('DOM field controls', () => {
  it('emits exact text edits and honors read-only metadata', () => {
    const onChange = vi.fn();
    const input = createStandardControl(document, { name: ' Number ', type: 'number' }, ' 1 ', onChange) as HTMLInputElement;
    expect(input.inputMode).toBe('decimal');
    input.value = ' 2 ';
    input.dispatchEvent(new Event('input'));
    expect(onChange).toHaveBeenCalledWith(' 2 ');

    const readOnlyChange = vi.fn();
    const readOnly = createStandardControl(document, { name: 'Total', kind: 'calculation' }, '3', readOnlyChange) as HTMLInputElement;
    expect(readOnly.readOnly).toBe(true);
    readOnly.value = '4';
    readOnly.dispatchEvent(new Event('input'));
    expect(readOnlyChange).not.toHaveBeenCalled();
  });

  it('retains unmatched select values and raw textarea line endings', () => {
    const select = createStandardControl(document, { name: 'Status', displayType: 'dropdown', options: ['A'] }, ' Unlisted ', () => undefined) as HTMLSelectElement;
    expect(select.value).toBe(' Unlisted ');
    expect(select.querySelector('option[value=" Unlisted "]')?.textContent).toBe(' Unlisted  (current value)');

    const onChange = vi.fn();
    const textarea = createStandardControl(document, { name: 'Notes' }, 'one\rtwo', onChange) as HTMLTextAreaElement;
    textarea.value = 'one\ntwo\nthree';
    textarea.dispatchEvent(new Event('input'));
    expect(onChange).toHaveBeenCalledWith('one\rtwo\rthree');
  });

  it('keeps choice groups independent and returns stored checkbox values unchanged when reselected', () => {
    const firstChange = vi.fn();
    const first = createStandardControl(document, { name: 'Choice', displayType: 'radio', options: ['A', 'B'] }, 'A', firstChange);
    const second = createStandardControl(document, { name: 'Choice', displayType: 'radio', options: ['A', 'B'] }, 'A', () => undefined);
    document.body.append(first, second);
    try {
      expect(first.querySelector('input')?.name).not.toBe(second.querySelector('input')?.name);
      first.querySelectorAll<HTMLInputElement>('input')[1]?.click();
      expect(firstChange).toHaveBeenCalledWith('B');
      expect(second.querySelector<HTMLInputElement>('input')?.checked).toBe(true);
    } finally {
      first.remove();
      second.remove();
    }

    const checkboxChange = vi.fn();
    const checkbox = createStandardControl(document, { name: 'Flags', displayType: 'checkbox', options: ['A', 'B'] }, 'A\rB', checkboxChange);
    document.body.append(checkbox);
    try {
      const first = checkbox.querySelector<HTMLInputElement>('input')!;
      first.click();
      expect(checkboxChange).toHaveBeenCalledWith('B');
      first.click();
      expect(checkboxChange).toHaveBeenLastCalledWith('A\rB');
    } finally {
      checkbox.remove();
    }
  });

  it('renders only HTTP container links and leaves failed image addresses visible', () => {
    const unsafe = createStandardControl(document, { name: 'Photo', type: 'container' }, 'javascript:alert(1)', () => undefined);
    expect(unsafe.querySelector('a, img')).toBeNull();
    expect(unsafe.textContent).toBe('javascript:alert(1)');

    const image = createStandardControl(document, { name: 'Photo', type: 'container' }, 'https://example.test/photo.png', () => undefined);
    const link = image.querySelector('a')!;
    expect(link.rel).toBe('noopener noreferrer');
    image.querySelector('img')?.dispatchEvent(new Event('error'));
    expect(link.textContent).toBe('https://example.test/photo.png');
  });

  it('provides shared geometry attributes and CSP-compatible CSS', () => {
    const element = document.createElement('div');
    applyStandardField(element, { name: 'Notes', multiline: true });
    expect(element.getAttribute('data-fm-width')).toBe('240');
    expect(element.getAttribute('data-fm-height')).toBe('96');
    expect(element.getAttribute('data-fm-label-position')).toBe(FIELD_LAYOUT.labelPosition);
    expect(standardFieldSize({ type: 'number' })).toEqual({ width: 120, height: 34 });
    expect(standardFieldsCss()).toContain('[data-fm-width="240"]');
    expect(standardFieldsCss()).not.toContain('--vscode-input-background');
    expect(standardFieldsCss(true)).toContain('--vscode-input-background');
  });
});
