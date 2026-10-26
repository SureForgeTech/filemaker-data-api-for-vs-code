import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createBlankLayout, layoutDefinitionSchema, type LayoutDefinition, type LayoutObject } from '@fmweb/shared';
import { layoutDefinitionSchema as extensionSchema } from '../../extension/src/fmweb/layoutSchema';
import { arrangeStandardForm, createStandardField, createStarterTemplate, rectanglesIntersect, standardizeFields } from './canvas-engine';
import { App } from './main';

const fields = [{ name: ' Z', type: 'number' }, { name: 'A', type: 'container' }, { name: 'B', type: 'date' }, { name: 'C' }, { name: 'D' }];
const ids = Array.from({ length: 9 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
function fixture(): LayoutDefinition {
  const layout = createBlankLayout(' Exact layout ', ' Source ');
  layout.objects = fields.map((field, index) => ({ ...createStandardField(field, ids[index], { x: 11, y: 19 }, index), width: 180, labelPosition: 'left' }));
  layout.objects.push({ ...layout.objects[0], id: ids[5], type: 'text', text: 'Keep me', name: 'Untouched' } as LayoutObject);
  layout.objects.push({
    id: ids[6], name: 'Related', type: 'portal', relatedContext: ' Related ', x: 777, y: 19, width: 420, height: 220,
    zIndex: 8, anchors: { top: true, right: false, bottom: false, left: true }, rowCount: 5, columns: [], scroll: true,
    selectableRows: true, behavior: { type: 'runScript', scriptName: ' Exact script ', parameter: 'keep' }
  });
  return layout;
}
afterEach(cleanup);

describe('standard form engine', () => {
  it('is deterministic, respects metadata order rather than object or alphabetical order, and leaves other objects unchanged', () => {
    const before = fixture();
    before.objects.reverse();
    const after = arrangeStandardForm(before, fields);
    expect(arrangeStandardForm(before, fields)).toEqual(after);
    expect(before.objects.find((object) => object.id === ids[0])?.width).toBe(180);
    const arranged = fields.map((_, index) => after.objects.find((object) => object.id === ids[index])!);
    expect(arranged.map((object) => object.x)).toEqual([24, 24, 24, 24, 24]);
    expect(arranged.map((object) => object.y)).toEqual([24, 104, 304, 384, 464]);
    for (const left of arranged) for (const right of arranged) {
      if (left.id !== right.id) expect(rectanglesIntersect({ ...left, height: left.height + 24 }, right)).toBe(false);
    }
    const portal = after.objects.find((object) => object.type === 'portal')!;
    expect(portal).toMatchObject({ x: 24, y: 544, width: 1232, behavior: { scriptName: ' Exact script ', parameter: 'keep' }, relatedContext: ' Related ' });
    expect(after.objects.find((object) => object.type === 'text')).toEqual(before.objects.find((object) => object.type === 'text'));
    expect(after.objects.map((object) => [object.id, object.zIndex])).toEqual(before.objects.map((object) => [object.id, object.zIndex]));
  });
  it('splits two columns down the left then right and puts portals below both', () => {
    const after = arrangeStandardForm(fixture(), fields, 2);
    expect(after.objects.slice(0, 5).map((object) => [object.x, object.y])).toEqual([[24, 24], [24, 104], [24, 304], [288, 24], [288, 104]]);
    expect(after.objects[6].y).toBe(384);
    const narrow = fixture(); narrow.canvas.width = 400;
    expect(arrangeStandardForm(narrow, fields, 2).objects.slice(0, 5).every((object) => object.x === 24)).toBe(true);
  });
  it('only arranges requested objects, preserving bindings and z-order', () => {
    const before = fixture();
    const after = arrangeStandardForm(before, fields, 1, [ids[2]]);
    expect(after.objects[2]).toMatchObject({ x: 8, y: 216, width: 160, height: 34 });
    before.objects.forEach((object, index) => { if (index !== 2) expect(after.objects[index]).toEqual(object); });
    expect(arrangeStandardForm(before, fields, 1, []).objects).toEqual(before.objects);
  });
  it('keeps standard fields and their labels inside the canvas, including tiny canvases', () => {
    const before = fixture();
    Object.assign(before.objects[1], { x: 1200, y: 780, width: 60, height: 20 });
    const after = standardizeFields(before, fields, [ids[1]]);
    expect(after.objects[1]).toMatchObject({ x: 1040, y: 616, width: 240, height: 160 });
    expect(after.canvas).toEqual(before.canvas);
    before.canvas = { width: 40, height: 20, gridSize: 8 };
    const tiny = standardizeFields(before, fields, [ids[1]]);
    expect(tiny.objects[1]).toMatchObject({ x: 0, y: 0 });
    expect(tiny.canvas).toMatchObject({ width: 240, height: 184 });
  });
  it('starts a selection at its snapped origin and moves below colliding unselected objects', () => {
    const before = fixture();
    before.objects = before.objects.slice(0, 3);
    Object.assign(before.objects[0], { x: 403, y: 163 });
    Object.assign(before.objects[1], { x: 700, y: 160 });
    Object.assign(before.objects[2], { x: 400, y: 160, width: 240, height: 96 });
    const after = arrangeStandardForm(before, fields, 1, [ids[0]]);
    expect(after.objects[0]).toMatchObject({ x: 400, y: 296 });
    expect(after.objects.slice(1)).toEqual(before.objects.slice(1));
    before.objects.pop();
    expect(arrangeStandardForm(before, fields, 1, [ids[0]]).objects[0]).toMatchObject({ x: 400, y: 160 });
  });
  it('standardizes idempotently without changing identity, binding, behavior, labels or order', () => {
    const before = fixture();
    before.objects[0].behavior = { type: 'runScript', scriptName: ' keep ' };
    const after = standardizeFields(before, fields, [ids[0]]);
    expect(after.objects[0]).toEqual({ ...before.objects[0], x: 8, y: 16, width: 120, height: 34, labelPosition: 'top' });
    expect(after.objects.slice(1)).toEqual(before.objects.slice(1));
    expect(standardizeFields(after, fields, [ids[0]])).toEqual(after);
    expect(standardizeFields(standardizeFields(before, fields), fields)).toEqual(standardizeFields(before, fields));
  });
  it.each(['blank', 'form', 'twoColumn', 'formPortal'] as const)('makes a schema-valid %s template with exact identifiers', (template) => {
    const before = createBlankLayout(' Exact layout ', ' Source ');
    const portal = { name: ' Portal ', fields: [' Child::Value '] };
    const after = createStarterTemplate(before, fields, template, ids, portal);
    expect(layoutDefinitionSchema.safeParse(after).success).toBe(true);
    expect(extensionSchema.safeParse(after).success).toBe(true);
    expect(after.name).toBe(' Exact layout ');
    expect(after.fmLayoutName).toBe(' Source ');
    expect(after.objects.length).toBe(template === 'blank' ? 0 : template === 'formPortal' ? 6 : 5);
    if (template !== 'blank') expect(after.objects[0]).toMatchObject({ fmFieldName: ' Z', width: 120 });
    if (template === 'formPortal') expect(after.objects[5]).toMatchObject({ relatedContext: ' Portal ', columns: [{ fmFieldName: ' Child::Value ' }] });
    expect(createStarterTemplate(before, fields, template, ids, portal)).toEqual(after);
  });
  it('falls back to text sizing when field type metadata is unavailable', () => {
    const layout = fixture();
    expect(standardizeFields(layout, []).objects[0]).toMatchObject({ width: 240, height: 34, format: 'number' });
  });
  it('retains multiline and option sizing when new fields are standardized', () => {
    const metadata = [{ name: 'Notes', displayType: 'textarea' }, { name: 'Options', displayType: 'checkbox set', optionCount: 4 }];
    const layout = createStarterTemplate(createBlankLayout('Displays'), metadata, 'form', ids);
    expect(layout.objects.map((object) => object.height)).toEqual([96, 96]);
    expect(standardizeFields(layout, metadata)).toEqual(layout);
  });
  it('handles an absent portal without inventing a related context and expands tall forms', () => {
    const before = createBlankLayout('Tall'); before.canvas.height = 100;
    const after = createStarterTemplate(before, fields, 'formPortal', ids);
    expect(after.objects).toHaveLength(5);
    expect(after.canvas.height).toBeGreaterThan(after.objects[4].y + after.objects[4].height);
  });
});

function init(layout: LayoutDefinition, extra = {}): void {
  fireEvent(window, new MessageEvent('message', { origin: window.location.origin, data: { type: 'init', payload: {
    layout, availableFields: fields.map((field) => field.name), availableFieldMetadata: fields, scripts: [], projectName: 'Test', ...extra
  } } }));
}
function geometry(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.object-hitbox')).map((element) => element.style.cssText);
}
describe('standard form toolbar', () => {
  it.each(['Arrange standard form', 'Standardize all'])('%s is one undo step with redo', (action) => {
    const { container } = render(<App />);
    init(fixture());
    const before = geometry(container);
    fireEvent.click(screen.getByRole('button', { name: action }));
    const after = geometry(container);
    expect(after).not.toEqual(before);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(geometry(container)).toEqual(before);
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(geometry(container)).toEqual(after);
  });
  it('adds metadata-sized fields from the field list on the standard grid even with a custom canvas grid', () => {
    const { container } = render(<App />);
    const layout = createBlankLayout('New'); layout.canvas.gridSize = 10;
    init(layout);
    const chip = Array.from(container.querySelectorAll('.field-chip')).find((element) => element.textContent === ' Z')!;
    fireEvent.click(chip);
    const hitbox = container.querySelector<HTMLElement>('.object-hitbox')!;
    expect(hitbox.style.width).toBe('120px');
    expect(hitbox.style.height).toBe('34px');
    expect(Number.parseInt(hitbox.style.left) % 8).toBe(0);
  });
  it('snaps field-list drops to the standard grid without changing the custom canvas grid', () => {
    const { container } = render(<App />);
    const layout = createBlankLayout('Drop'); layout.canvas.gridSize = 10;
    init(layout);
    const drop = new MouseEvent('drop', { bubbles: true, clientX: 13, clientY: 21 });
    Object.defineProperty(drop, 'dataTransfer', { value: { getData: () => JSON.stringify({ type: 'field', fieldName: ' Z' }) } });
    fireEvent(container.querySelector('.canvas-scroll')!, drop);
    const hitbox = container.querySelector<HTMLElement>('.object-hitbox')!;
    expect(hitbox.style.left).toBe('16px');
    expect(hitbox.style.top).toBe('24px');
    expect(hitbox.style.width).toBe('120px');
    expect(container.querySelector<HTMLElement>('.design-surface')!.style.backgroundSize).toBe('10px 10px');
  });
  it('limits the toolbar action to the current selection', () => {
    const { container } = render(<App />);
    init(fixture());
    const before = geometry(container);
    fireEvent.click(container.querySelectorAll('.object-list button')[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Standardize selected' }));
    const after = geometry(container);
    expect(after[0]).not.toBe(before[0]);
    expect(after.slice(1)).toEqual(before.slice(1));
  });
  it('undo and redo restore the template source choice along with its field palette', () => {
    const { container } = render(<App />);
    init(createBlankLayout('New'), { isNewLayout: true, templateLayouts: [
      { layoutName: ' First ', fields, portals: [] },
      { layoutName: ' Second ', fields: [{ name: 'Second only', type: 'number' }], portals: [] }
    ] });
    fireEvent.change(screen.getByLabelText('Starter template'), { target: { value: 'form' } });
    fireEvent.change(screen.getByLabelText('Template FileMaker layout'), { target: { value: ' Second ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply starter template' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect((screen.getByLabelText('Template FileMaker layout') as HTMLSelectElement).value).toBe(' First ');
    expect(container.querySelector('.field-list')?.textContent).toContain(' Z');
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(container.querySelector('.field-list')?.textContent).toBe('Second only');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect((screen.getByLabelText('Template FileMaker layout') as HTMLSelectElement).value).toBe(' First ');
  });
  it('offers templates only for a new layout and creates one in a single undo step', () => {
    const { container } = render(<App />);
    init(createBlankLayout('New'), { isNewLayout: true, templateLayouts: [{ layoutName: ' Source ', fields: [{ name: 'Template only', type: 'number' }], portals: [] }] });
    fireEvent.change(screen.getByLabelText('Starter template'), { target: { value: 'twoColumn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply starter template' }));
    expect(container.querySelectorAll('.object-hitbox')).toHaveLength(1);
    expect(container.querySelector('.field-list')?.textContent).toContain('Template only');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(container.querySelectorAll('.object-hitbox')).toHaveLength(0);
    expect(container.querySelector('.field-list')?.textContent).not.toContain('Template only');
    expect(container.querySelector('.field-list')?.textContent).toContain(' Z');
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(container.querySelector('.field-list')?.textContent).toContain('Template only');
    init(fixture());
    expect(screen.queryByLabelText('Starter template')).toBeNull();
  });
});

it('adds picker and toolbox fields below all existing objects without overlap, grows the canvas, and undoes each addition', () => {
  const { container } = render(<App />);
  const layout = createBlankLayout('New'); layout.canvas.height = 100;
  layout.objects = [{ ...createStandardField({ name: 'Container', type: 'container' }, ids[0], { x: 24, y: 24 }, 0) }];
  init(layout);
  const chip = Array.from(container.querySelectorAll('.field-chip')).find((element) => element.textContent === ' Z')!;
  fireEvent.click(chip); fireEvent.click(chip);
  fireEvent.click(screen.getByRole('button', { name: 'field' }));
  const boxes = Array.from(container.querySelectorAll<HTMLElement>('.object-hitbox'));
  expect(boxes).toHaveLength(4);
  expect(boxes.map((box) => Number.parseInt(box.style.top))).toEqual([24, 224, 304, 384]);
  expect(boxes.every((box) => box.style.left === '24px')).toBe(true);
  expect(Number.parseInt(container.querySelector<HTMLElement>('.design-surface')!.style.height)).toBeGreaterThanOrEqual(442);
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(container.querySelectorAll('.object-hitbox')).toHaveLength(3);
});

it('adds picker fields below objects in another column and moves overlapping field drops to a free slot', () => {
  const { container } = render(<App />);
  const layout = createBlankLayout('Columns');
  layout.objects = [createStandardField({ name: 'Existing' }, ids[0], { x: 800, y: 400 }, 0)];
  init(layout);
  const chip = Array.from(container.querySelectorAll('.field-chip')).find((element) => element.textContent === ' Z')!;
  fireEvent.click(chip);
  let boxes = container.querySelectorAll<HTMLElement>('.object-hitbox');
  expect(boxes[1].style.top).toBe('480px');
  expect(boxes[1].style.left).toBe('24px');
  const drop = new MouseEvent('drop', { bubbles: true, clientX: 800, clientY: 400 });
  Object.defineProperty(drop, 'dataTransfer', { value: { getData: () => JSON.stringify({ type: 'field', fieldName: ' Z' }) } });
  fireEvent(container.querySelector('.canvas-scroll')!, drop);
  boxes = container.querySelectorAll<HTMLElement>('.object-hitbox');
  expect(boxes[2].style.top).toBe('480px');
  expect(boxes[2].style.left).toBe('800px');
});

it('grows a 120px canvas to contain fields added by picker and toolbox, and undoes that growth', () => {
  const { container } = render(<App />);
  const layout = createBlankLayout('Narrow'); layout.canvas.width = 120;
  init(layout);
  const surface = () => Number.parseInt(container.querySelector<HTMLElement>('.design-surface')!.style.width);
  const chip = Array.from(container.querySelectorAll('.field-chip')).find((element) => element.textContent === 'A')!;
  fireEvent.click(chip);
  fireEvent.click(screen.getByRole('button', { name: 'field' }));
  for (const box of container.querySelectorAll<HTMLElement>('.object-hitbox')) {
    expect(Number.parseInt(box.style.left) + Number.parseInt(box.style.width)).toBeLessThanOrEqual(surface());
  }
  expect(surface()).toBeGreaterThan(120);
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(surface()).toBe(120);
});
