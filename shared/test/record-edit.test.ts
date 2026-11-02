import { describe, expect, it } from 'vitest';
import {
  NUL_TEXT_WARNING,
  computeRecordPatch,
  containsNulText,
  fieldKindNote,
  fieldType,
  layoutFieldKind,
  nulTextError,
  nulTextFields,
  numericText,
  readOnlyFieldKind,
  recordFieldKey,
  recordFieldRequired,
  removeNulText,
  runtimeFieldKind,
  stableRecordStringify,
  validateRecordDraft
} from '../src';

describe('record field access rules', () => {
  it('normalizes metadata hints for access only, never field names', () => {
    expect(fieldType(' Number ')).toBe('number');
    expect(fieldType(42)).toBe('');
    expect(readOnlyFieldKind({ name: ' Total ', type: 'number', result: ' Summary ' })).toBe('summary');
    expect(readOnlyFieldKind({ name: ' Photo ', result: 'container' })).toBe('container');
    expect(readOnlyFieldKind({ name: ' Plain ', type: 'text' })).toBeUndefined();
    expect(layoutFieldKind({ name: ' Global ', global: true })).toBe('global');
    expect(layoutFieldKind({ name: ' Global ', global: ' TRUE ' })).toBe('global');
    expect(layoutFieldKind({ name: ' Global ', type: 'global' })).toBe('global');
    expect(layoutFieldKind({ name: ' Calc ', type: 'calculation', global: true })).toBe('calculation');
    expect(layoutFieldKind({ name: ' Exact ', global: 'false' })).toBe('normal');
  });

  it('resolves legacy runtime metadata and explains each special field kind', () => {
    expect(runtimeFieldKind({ fmFieldName: ' Total ', metadata: { result: 'summary' } })).toBe('summary');
    expect(runtimeFieldKind({ fmFieldName: ' Total ', kind: 'global' })).toBe('global');
    expect(runtimeFieldKind({ fmFieldName: ' Legacy ', kind: 'future-kind', result: 'calculation' })).toBe('calculation');
    expect(runtimeFieldKind({ fmFieldName: ' Plain ', kind: 'future-kind' })).toBe('normal');
    expect(fieldKindNote('calculation')).toContain('cannot be edited');
    expect(fieldKindNote('summary')).toContain('cannot be edited');
    expect(fieldKindNote('container')).toBe('Use Upload to container');
    expect(fieldKindNote('global')).toContain('Session-wide');
    expect(fieldKindNote('normal')).toBeUndefined();
    expect(fieldKindNote()).toBeUndefined();
  });

  it('writes back under the exact key that supplied a repeated field value', () => {
    expect(recordFieldKey({ Name: 'bare', 'Name(1)': 'first' }, 'Name')).toBe('Name');
    expect(recordFieldKey({ 'Name(1)': 'first', 'Name(2)': 'second' }, 'Name')).toBe('Name(1)');
    expect(recordFieldKey({ 'Name(10)': 'ten', 'Name(2)': 'two', 'Name(x)': 'bad', 'Name(1x)': 'bad' }, 'Name')).toBe('Name(2)');
    expect(recordFieldKey({ ' Name (2)': 'exact' }, ' Name ')).toBe(' Name (2)');
    expect(recordFieldKey({ Other: 'value' }, 'Missing')).toBe('Missing');
  });
});

describe('record draft patches and validation', () => {
  it('omits deep-equal values and preserves hostile or space-padded identifiers', () => {
    const draft = JSON.parse('{"__proto__":"kept"," Field ":" changed ","nested":{"b":2,"a":1},"Gone":null}');
    const patch = computeRecordPatch(
      { nested: { a: 1, b: 2 }, Gone: 'before', Same: [1, { a: 2, b: 3 }] },
      { ...draft, Same: [1, { b: 3, a: 2 }] }
    );

    expect(new Set(Object.keys(patch))).toEqual(new Set(['__proto__', ' Field ', 'Gone']));
    expect(patch.__proto__).toBe('kept');
    expect(patch[' Field ']).toBe(' changed ');
    expect(patch.Gone).toBeNull();
    expect(Object.getPrototypeOf(patch)).toBeNull();
    expect(computeRecordPatch({ Gone: 'before' }, {})).toHaveProperty('Gone', undefined);
    expect(stableRecordStringify({ b: [2, 1], a: true })).toBe('{"a":true,"b":[2,1]}');
  });

  it('checks required hints where repetitions store values and skips read-only fields', () => {
    expect(validateRecordDraft({ 'Notes(2)': 'value' }, [{ name: 'Notes', required: true }])).toEqual({ valid: true, errors: [] });
    expect(validateRecordDraft({ 'Notes(1)': '' }, [{ name: 'Notes', notEmpty: true }]).errors).toEqual([
      { field: 'Notes', message: 'Field is required by metadata hints.' }
    ]);
    expect(validateRecordDraft({}, [{ name: 'Calculated', type: 'calculation', required: true }]).valid).toBe(true);
    expect(validateRecordDraft({ Date: '31/12/2026', Number: 'not a number', Text: '  ' }).valid).toBe(true);
  });

  it.each([
    ['undefined', undefined, 'Undefined values are not valid JSON values.'],
    ['bigint', BigInt(1), 'BigInt values are not supported by JSON serialization.'],
    ['function', () => 1, 'Function values are not valid JSON values.'],
    ['symbol', Symbol('value'), 'Symbol values are not valid JSON values.'],
    ['nested array', [undefined], 'Undefined values are not valid JSON values.'],
    ['nested object', { nested: { value: BigInt(1) } }, 'BigInt values are not supported by JSON serialization.']
  ])('rejects JSON-unsafe %s values with their exact field name', (_label, value, message) => {
    expect(validateRecordDraft({ ' Exact ': value }).errors).toContainEqual({ field: ' Exact ', message });
  });

  it('honors required/notEmpty precedence in metadata', () => {
    expect(recordFieldRequired({ name: 'A', required: false, notEmpty: true })).toBe(false);
    expect(recordFieldRequired({ name: 'A', notEmpty: true })).toBe(true);
    expect(recordFieldRequired({ name: 'A', validation: { required: true, notEmpty: false } })).toBe(true);
    expect(recordFieldRequired({ name: 'A', validation: { notEmpty: true } })).toBe(true);
    expect(recordFieldRequired({ name: 'A', validation: 'required' })).toBe(false);
  });
});

describe('record scalar safety', () => {
  it.each([
    ['0012', 12],
    ['+12.5', 12.5],
    ['.5', 0.5],
    ['1e3', 1000],
    ['9007199254740991', Number.MAX_SAFE_INTEGER],
    ['9007199254740992', '9007199254740992'],
    ['9999999999999999', '9999999999999999'],
    ['1e309', '1e309'],
    ['1e-324', '1e-324'],
    [' 12 ', ' 12 '],
    ['12x', '12x']
  ])('converts only exactly safe numeric text: %s', (text, expected) => {
    expect(numericText(text)).toEqual(expected);
  });

  it('detects and removes only NUL characters while preserving all names and following text', () => {
    const fields = {
      ' Name ': 'before\0after',
      Nested: ['A\0B', { ' Exact key ': 'C\0D' }],
      Untouched: 'C\u200bD\ufeffE',
      Count: 0
    };

    expect(containsNulText(fields.Nested)).toBe(true);
    expect(containsNulText(fields.Count)).toBe(false);
    expect(nulTextFields(fields)).toEqual([' Name ', 'Nested']);
    expect(removeNulText(fields)).toEqual({
      ' Name ': 'beforeafter',
      Nested: ['AB', { ' Exact key ': 'CD' }],
      Untouched: 'C\u200bD\ufeffE',
      Count: 0
    });
    expect(nulTextError(fields)).toBe(`NUL character (U+0000) in field(s):  Name , Nested. ${NUL_TEXT_WARNING} Nothing in this row was written. Remove the character from the source and try again.`);
    expect(nulTextError({ Safe: 'text' })).toBeUndefined();
  });
});
