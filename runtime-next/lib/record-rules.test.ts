import { describe, expect, it } from 'vitest';
import { readOnlyFieldKind, computeRecordPatch, numericText, validateRecordDraft, validateLayoutDefinition, createBlankLayout, type LayoutDefinition } from '@fmweb/shared';

describe('shared Editor rules', () => {
  it('validates required hints and JSON values while leaving server date and number validation to FileMaker', () => {
    expect(validateRecordDraft({ Date: '31/12/2026', Number: 'invalid number', Text: '  ' }).valid).toBe(true);
    expect(validateRecordDraft({ Name: '' }, [{ name: 'Name', required: true }]).valid).toBe(false);
    expect(validateRecordDraft({ Name: 'a' }, [{ name: 'Computed', type: 'calculation', required: true }]).valid).toBe(true);
    for (const value of [undefined, BigInt(1), () => 1, Symbol('a'), [undefined], { nested: undefined }]) {
      expect(validateRecordDraft({ ' Exact ': value }).errors[0]?.field).toBe(' Exact ');
    }
  });
  it('checks a required field against the key the record holds its value under', () => {
    // A repeated field keeps its value under `Notes(1)`, so the required check finds it there.
    expect(validateRecordDraft({ 'Notes(1)': 'x' }, [{ name: 'Notes', required: true }]).valid).toBe(true);
    expect(validateRecordDraft({ 'Notes(1)': 'x' }, [{ name: 'Notes', notEmpty: true }]).valid).toBe(true);
    expect(validateRecordDraft({ 'Notes(2)': 'x' }, [{ name: 'Notes', required: true }]).valid).toBe(true);
    // A required field with no value anywhere still fails.
    expect(validateRecordDraft({}, [{ name: 'Notes', required: true }]).valid).toBe(false);
    expect(validateRecordDraft({ Other: 'x' }, [{ name: 'Notes', required: true }]).valid).toBe(false);
    expect(validateRecordDraft({ 'Notes(1)': '' }, [{ name: 'Notes', required: true }]).valid).toBe(false);
    // A field that does not repeat keeps its own key.
    expect(validateRecordDraft({ Name: '' }, [{ name: 'Name', required: true }]).valid).toBe(false);
    expect(validateRecordDraft({ Name: 'a' }, [{ name: 'Name', required: true }]).valid).toBe(true);
  });
  it('compares nested values without key-order noise and preserves hostile identifiers in patches', () => {
    const values = JSON.parse('{"__proto__":"kept"," Field ":" ","nested":{"b":2,"a":1}}');
    const patch = computeRecordPatch({ nested: { a: 1, b: 2 } }, values);
    expect(Object.keys(patch)).toEqual(['__proto__', ' Field ']);
    expect(patch.__proto__).toBe('kept');
    expect(numericText('9007199254740993')).toBe('9007199254740993');
    expect(numericText('0012')).toBe(12);
    expect(numericText(' 12 ')).toBe(' 12 ');
  });
  it('keeps access and multiline flags through schema validation and accepts older field objects', () => {
    const layout = createBlankLayout(' Exact ');
    layout.objects = [{ id: '11111111-1111-4111-8111-111111111111', type: 'field', name: ' Field ', fmFieldName: ' Field ',
      x: 0, y: 0, width: 240, height: 96, kind: 'global', multiline: true } as LayoutDefinition['objects'][number]];
    expect(validateLayoutDefinition(layout).objects[0]).toMatchObject({ fmFieldName: ' Field ', kind: 'global', multiline: true });
    delete (layout.objects[0] as { kind?: string }).kind;
    expect(validateLayoutDefinition(layout).objects[0]).toMatchObject({ kind: 'normal' });
  });
});


it.each(['calculation', 'summary'])('recognizes %s from metadata type or result without a kind', (kind) => {
  expect(readOnlyFieldKind({ name: ' Exact ', result: kind })).toBe(kind);
  expect(readOnlyFieldKind({ name: ' Exact ', type: kind, result: 'number' })).toBe(kind);
});

it('accepts unknown kinds without losing a layout or metadata', () => {
  const layout = createBlankLayout(' Exact ');
  layout.objects = [{ id: '11111111-1111-4111-8111-111111111111', type: 'field', name: ' Field ', fmFieldName: ' Field ',
    x: 0, y: 0, width: 240, height: 34, kind: 'future-kind', metadata: { type: 'calculation', result: 'number' } } as unknown as LayoutDefinition['objects'][number]];
  expect(validateLayoutDefinition(layout).objects[0]).toMatchObject({ kind: 'normal', metadata: { type: 'calculation', result: 'number' } });
});
