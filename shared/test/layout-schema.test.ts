import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CURRENT_LAYOUT_SCHEMA_VERSION,
  createBlankLayout,
  layoutDefinitionSchema,
  migrateLayoutDefinition,
  validateLayoutDefinition,
  type FieldLayoutObject
} from '../src';

const objectId = '11111111-1111-4111-8111-111111111111';

function field(overrides: Partial<FieldLayoutObject> = {}): FieldLayoutObject {
  return {
    id: objectId,
    name: ' Field object ',
    type: 'field',
    fmFieldName: ' Customer::Name ',
    x: 8,
    y: 16,
    width: 240,
    height: 34,
    zIndex: 0,
    anchors: { top: true, right: false, bottom: false, left: true },
    displayType: 'editBox',
    format: 'text',
    labelPosition: 'top',
    required: false,
    ...overrides
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('canonical layout schema', () => {
  it('accepts current layouts, applies documented defaults, and preserves exact FileMaker names', () => {
    const layout = createBlankLayout(' Exact layout ', ' Source::Layout ');
    layout.fieldOrder = [' Customer::Name ', 'Customer::Name'];
    layout.objects = [field({ kind: 'global', multiline: true, metadata: { type: 'text', result: 'text' } })];

    const validated = validateLayoutDefinition(layout);

    expect(validated).toMatchObject({
      schemaVersion: CURRENT_LAYOUT_SCHEMA_VERSION,
      name: ' Exact layout ',
      fmLayoutName: ' Source::Layout ',
      fieldOrder: [' Customer::Name ', 'Customer::Name'],
      canvas: { width: 1280, height: 800, gridSize: 8 }
    });
    expect(validated.objects[0]).toMatchObject({
      fmFieldName: ' Customer::Name ',
      kind: 'global',
      multiline: true,
      metadata: { type: 'text', result: 'text' }
    });

    delete (layout.objects[0] as FieldLayoutObject).kind;
    delete (layout.objects[0] as FieldLayoutObject).multiline;
    expect(validateLayoutDefinition(layout).objects[0]).toMatchObject({ kind: 'normal', multiline: false });
    expect(validateLayoutDefinition(layout).id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('accepts each supported object variant and catches unknown field kinds without discarding metadata', () => {
    const layout = createBlankLayout('Variants');
    const base = field();
    layout.objects = [
      field({ kind: 'future-kind', metadata: { type: 'calculation', result: 'number' } } as unknown as Partial<FieldLayoutObject>),
      { ...base, id: '22222222-2222-4222-8222-222222222222', type: 'text', text: ' Hello ' },
      { ...base, id: '33333333-3333-4333-8333-333333333333', type: 'button', label: ' Run ' },
      { ...base, id: '44444444-4444-4444-8444-444444444444', type: 'portal', relatedContext: ' Child ', rowCount: 5, columns: [], scroll: true, selectableRows: false },
      { ...base, id: '55555555-5555-4555-8555-555555555555', type: 'rectangle', cornerRadius: 4 },
      { ...base, id: '66666666-6666-4666-8666-666666666666', type: 'image', src: 'https://example.test/image.png', alt: ' Image ' },
      { ...base, id: '77777777-7777-4777-8777-777777777777', type: 'tabPanel', tabs: [] }
    ];

    const validated = validateLayoutDefinition(layout);
    expect(validated.objects.map((object) => object.type)).toEqual(['field', 'text', 'button', 'portal', 'rectangle', 'image', 'tabPanel']);
    expect(validated.objects[0]).toMatchObject({ kind: 'normal', metadata: { type: 'calculation', result: 'number' } });
  });

  it('rejects malformed current layouts and unsupported object data', () => {
    const valid = createBlankLayout('Valid');
    const invalidInputs: unknown[] = [
      null,
      [],
      { ...valid, id: 'not-a-uuid' },
      { ...valid, name: '' },
      { ...valid, schemaVersion: 0 },
      { ...valid, canvas: { width: 1280, height: 800, gridSize: 129 } },
      { ...valid, objects: [field({ width: 0 })] },
      { ...valid, objects: [field({ fmFieldName: '' })] },
      { ...valid, objects: [{ ...field(), type: 'unknown' }] }
    ];

    for (const input of invalidInputs) {
      expect(layoutDefinitionSchema.safeParse(input).success).toBe(false);
    }
  });
});

describe('layout migrations', () => {
  it('migrates legacy objects, normalizes geometry, and retains exact field and source names', () => {
    const legacy = {
      schemaVersion: 0,
      id: '99999999-9999-4999-8999-999999999999',
      name: ' Legacy layout ',
      fmLayoutName: ' Legacy::Source ',
      objects: [
        { id: objectId, type: 'field', name: ' Field ', fmFieldName: ' Customer::Name ', x: 1.6, y: 2.4, width: 0, height: -5, zIndex: -1 },
        { id: '22222222-2222-4222-8222-222222222222', type: 'text', text: ' Text ', x: 0, y: 40, width: 120, height: 32 },
        { id: '33333333-3333-4333-8333-333333333333', type: 'button', label: ' Go ', x: 0, y: 80, width: 120, height: 32 },
        { id: '44444444-4444-4444-8444-444444444444', type: 'portal', relatedContext: ' Child ', rowCount: 0, x: 0, y: 120, width: 120, height: 32 },
        { id: '55555555-5555-4555-8555-555555555555', type: 'image', x: 0, y: 160, width: 120, height: 32 },
        { id: '66666666-6666-4666-8666-666666666666', type: 'tabPanel', x: 0, y: 200, width: 120, height: 32 },
        { id: '77777777-7777-4777-8777-777777777777', type: 'future-object', x: 0, y: 240, width: 120, height: 32 },
        { type: 'rectangle', x: Number.NaN, y: 280, width: Number.POSITIVE_INFINITY, height: 32 },
        null,
        []
      ]
    };

    const migrated = migrateLayoutDefinition(legacy);

    expect(migrated.schemaVersion).toBe(CURRENT_LAYOUT_SCHEMA_VERSION);
    expect(migrated.name).toBe('Legacy layout');
    expect(migrated.fmLayoutName).toBe(' Legacy::Source ');
    expect(migrated.id).not.toBe(legacy.id);
    expect(migrated.objects.map((object) => object.type)).toEqual(['field', 'text', 'button', 'portal', 'image', 'tabPanel', 'rectangle', 'rectangle']);
    expect(migrated.objects[0]).toMatchObject({ fmFieldName: ' Customer::Name ', x: 2, y: 2, width: 1, height: 1, zIndex: 0 });
    expect(migrated.objects[3]).toMatchObject({ relatedContext: ' Child ', rowCount: 1 });
    expect(migrated.objects[6]).toMatchObject({ type: 'rectangle', cornerRadius: 0 });
    expect(migrated.objects[7]).toMatchObject({ x: 0, width: 120, height: 32 });
    expect(migrated.objects[7]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => validateLayoutDefinition(migrated)).not.toThrow();
  });

  it('validates current input and supplies a blank layout for legacy non-object input', () => {
    const current = createBlankLayout('Current');
    expect(migrateLayoutDefinition(current)).toEqual(current);

    for (const input of [undefined, null, 'legacy', []]) {
      expect(migrateLayoutDefinition(input)).toMatchObject({ name: 'Untitled Layout', objects: [] });
    }
  });

  it('refuses layouts from a newer schema instead of silently rewriting them', () => {
    expect(() => migrateLayoutDefinition({
      ...createBlankLayout('Future'),
      schemaVersion: CURRENT_LAYOUT_SCHEMA_VERSION + 1
    })).toThrow(`Layout schema version ${CURRENT_LAYOUT_SCHEMA_VERSION + 1} is newer than supported version ${CURRENT_LAYOUT_SCHEMA_VERSION}.`);
  });

  it('creates schema-valid UUIDs when native randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    vi.spyOn(Math, 'random').mockReturnValue(0);

    expect(createBlankLayout('Fallback').id).toBe('00000000-0000-4000-8000-000000000000');
  });
});
