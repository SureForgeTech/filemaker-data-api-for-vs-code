// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankLayout, LayoutContainer, type FieldLayoutObject } from '@fmweb/shared';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function field(overrides: Partial<FieldLayoutObject> = {}): FieldLayoutObject {
  return { id: '11111111-1111-4111-8111-111111111111', type: 'field', name: ' Field ', fmFieldName: ' Field ',
    x: 24, y: 24, width: 240, height: 34, zIndex: 0, anchors: { left: true, top: true, right: false, bottom: false },
    displayType: 'editBox', format: 'text', required: false, labelPosition: 'top', ...overrides };
}
const onFieldChange = vi.fn();
function render(object: FieldLayoutObject, value?: unknown, editing = false, mode: 'runtime' | 'designer' = 'runtime'): void {
  const layout = createBlankLayout('Fields'); layout.objects = [object];
  act(() => root.render(React.createElement(LayoutContainer, { layout, mode, runtimeData: {
    fieldValues: { [object.fmFieldName]: value }, editing, onFieldChange
  } })));
}

describe('runtime field values', () => {
  it('keeps empty and whitespace values exact; sample text belongs only to the designer', () => {
    for (const value of [undefined, null, '']) {
      render(field(), value); expect(host.querySelector('input')?.value).toBe('');
    }
    render(field(), '  exact  '); expect(host.querySelector('input')?.value).toBe('  exact  ');
    render(field(), undefined, false, 'designer'); expect(host.querySelector('input')?.value).toBe(' Field ');
  });
  it('uses a text control for the server date string and explains its format', () => {
    render(field({ format: 'date' }), '31/12/2026', true);
    expect(host.querySelector('input')?.type).toBe('text');
    expect(host.querySelector('input')?.value).toBe('31/12/2026');
    expect(host.textContent).toContain('server');
    expect(host.querySelector('input')?.readOnly).toBe(false);
  });
  it.each(['calculation', 'summary', 'container'] as const)('%s stays read-only in edit mode with the Editor note', (kind) => {
    render(field({ kind }), kind === 'container' ? 'https://example.com/file.pdf' : '12', true);
    expect(host.querySelector('input:not([readonly]):not(:disabled),textarea:not([readonly]):not(:disabled),select:not(:disabled)')).toBeNull();
    expect(host.textContent).toContain(kind === 'calculation' ? 'Calculated by FileMaker; cannot be edited' : kind === 'summary' ? 'Summary field; cannot be edited' : 'Use Upload to container');
  });
  it('allows global and multiline fields to be edited and explains global scope', () => {
    render(field({ kind: 'global', multiline: true, height: 96 }), 'a\nb', true);
    expect(host.querySelector('textarea')?.readOnly).toBe(false);
    expect(host.querySelector('textarea')?.value).toBe('a\nb');
    expect(host.textContent).toContain('Session-wide: changes apply throughout this session.');
  });
  it('shows image container URLs as images, other safe URLs as links, and empty containers empty', () => {
    render(field({ kind: 'container' }), 'https://example.com/photo.jpg?token=a');
    expect(host.querySelector('img')?.getAttribute('src')).toBe('https://example.com/photo.jpg?token=a');
    render(field({ kind: 'container' }), 'https://example.com/file.pdf');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.com/file.pdf');
    render(field({ kind: 'container' }), 'javascript:alert(1)'); expect(host.querySelector('a,img')).toBeNull();
    render(field({ kind: 'container' }), ''); expect(host.querySelector('a,img,input')).toBeNull();
  });
  it('shows the address of a container whose image cannot be shown', () => {
    render(field({ kind: 'container' }), 'https://example.com/photo.jpg');
    const image = host.querySelector('img')!;
    expect(image).not.toBeNull();
    act(() => { image.dispatchEvent(new Event('error')); });
    // The image is gone and its address says where the file lives.
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('https://example.com/photo.jpg');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.com/photo.jpg');
  });
  it('dropdown, checkbox, radio and multiline controls report edits under the exact field name', () => {
    render(field({ displayType: 'dropdown', options: ['a', 'b'] }), 'a', true);
    act(() => {
      const select = host.querySelector('select')!; select.value = 'b'; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onFieldChange).toHaveBeenLastCalledWith(' Field ', 'b');
    render(field({ displayType: 'checkbox', options: ['a', 'b'] }), 'a', true);
    act(() => host.querySelectorAll<HTMLInputElement>('input')[1].click());
    expect(onFieldChange).toHaveBeenLastCalledWith(' Field ', 'a\rb');
    render(field({ displayType: 'radio', options: ['a', 'b'] }), 'a', true);
    act(() => host.querySelectorAll<HTMLInputElement>('input')[1].click());
    expect(onFieldChange).toHaveBeenLastCalledWith(' Field ', 'b');
    render(field({ multiline: true }), 'old', true);
    act(() => {
      const input = host.querySelector('textarea')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'new\ntext');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onFieldChange).toHaveBeenLastCalledWith(' Field ', 'new\ntext');
  });

  it('keeps the stored checkbox order and appends new selections, whatever order the boxes were ticked', () => {
    const checkbox = field({ displayType: 'checkbox', options: ['a', 'b', 'c'] });
    render(checkbox, 'c', true);
    act(() => host.querySelectorAll<HTMLInputElement>('input')[0].click());
    // The stored value comes first; the new selection is appended with the stored separator.
    expect(onFieldChange).toHaveBeenLastCalledWith(' Field ', 'c\ra');
    // The host stores the value and sends it back; the next tick builds on the stored value.
    render(checkbox, 'c\ra', true);
    act(() => host.querySelectorAll<HTMLInputElement>('input')[1].click());
    expect(onFieldChange).toHaveBeenLastCalledWith(' Field ', 'c\ra\rb');
    render(checkbox, 'c\ra\rb', true);
    act(() => host.querySelectorAll<HTMLInputElement>('input')[0].click());
    expect(onFieldChange).toHaveBeenLastCalledWith(' Field ', 'c\rb');
  });

  it('renders only placed returned fields in metadata order, with repetitions grouped and extras in response order', () => {
    const layout = createBlankLayout('Order'); layout.fieldOrder = [' Z ', 'A', 'Hidden'];
    layout.objects = ['Extra', 'A(10)', 'First extra', 'A(2)', ' Z ', 'A(1)', 'Hidden']
      .map((name, index) => field({ id: String(index), fmFieldName: name, zIndex: index }));
    act(() => root.render(React.createElement(LayoutContainer, { layout, mode: 'runtime', runtimeData: {
      fieldValues: { 'First extra': '', Extra: '', 'A(10)': '', 'A(2)': '', ' Z ': '', 'A(1)': '', Unplaced: '' }
    } })));
    expect(Array.from(host.querySelectorAll('input')).map((input) => input.getAttribute('aria-label')))
      .toEqual([' Z ', 'A(1)', 'A(2)', 'A(10)', 'First extra', 'Extra']);
  });

  it('shows every field of the layout for a new record, because a new record has no values yet', () => {
    const layout = createBlankLayout('New'); layout.fieldOrder = ['B', 'A'];
    layout.objects = ['A', 'B'].map((name, index) => field({ id: String(index), fmFieldName: name, zIndex: index }));
    act(() => root.render(React.createElement(LayoutContainer, { layout, mode: 'runtime', runtimeData: {
      fieldValues: {}, creating: true, editing: true
    } })));
    expect(Array.from(host.querySelectorAll('input')).map((input) => input.getAttribute('aria-label'))).toEqual(['B', 'A']);
  });

  it('shows a repeated field when the record only holds its repeated value', () => {
    const layout = createBlankLayout('Repetition');
    layout.objects = [field({ id: '0', fmFieldName: 'Photo' }), field({ id: '1', fmFieldName: 'Absent' })];
    act(() => root.render(React.createElement(LayoutContainer, { layout, mode: 'runtime', runtimeData: {
      fieldValues: { 'Photo(1)': 'https://example.test/photo.png' }
    } })));
    // The repetition belongs to the field, and a field the record does not have stays hidden.
    expect(Array.from(host.querySelectorAll('input')).map((input) => input.getAttribute('aria-label'))).toEqual(['Photo']);
  });

  it('shows the value of a repeated field and reports its edit under the key the record holds it under', () => {
    const layout = createBlankLayout('Repetition');
    layout.objects = [field({ id: '0', fmFieldName: 'Notes' })];
    act(() => root.render(React.createElement(LayoutContainer, { layout, mode: 'runtime', runtimeData: {
      fieldValues: { 'Notes(1)': 'first repetition' }, editing: true, onFieldChange
    } })));
    // The value of a repeated field lives under `Notes(1)`, not under the name of the layout.
    expect(host.querySelector('input')?.value).toBe('first repetition');
    const input = host.querySelector('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'edited repetition');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // The edit is reported under the same key, so the other repetitions stay untouched.
    expect(onFieldChange).toHaveBeenLastCalledWith('Notes(1)', 'edited repetition');
  });

  it('shows and edits the lowest available repetition when the first is absent', () => {
    const layout = createBlankLayout('Repetition');
    layout.objects = [field({ id: '0', fmFieldName: 'Notes' })];
    act(() => root.render(React.createElement(LayoutContainer, { layout, mode: 'runtime', runtimeData: {
      fieldValues: { 'Notes(10)': 'ten', 'Notes(2)': 'second' }, editing: true, onFieldChange
    } })));
    expect(host.querySelector('input')?.value).toBe('second');
    const input = host.querySelector('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'edited');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onFieldChange).toHaveBeenLastCalledWith('Notes(2)', 'edited');
  });

  it('does not invent related rows or values in runtime portals', () => {
    const layout = createBlankLayout('Portal'); layout.objects = [{ ...field(), type: 'portal', relatedContext: 'Related',
      rowCount: 2, columns: [{ id: 'col', fmFieldName: 'Name', label: 'Name', width: 120 }], scroll: true, selectableRows: false }];
    act(() => root.render(React.createElement(LayoutContainer, { layout, mode: 'runtime' })));
    expect(host.querySelectorAll('[data-fm-portal-row]')).toHaveLength(0);
    act(() => root.render(React.createElement(LayoutContainer, { layout, mode: 'runtime', runtimeData: {
      portalRowsByObjectId: { [layout.objects[0].id]: [{ Name: '' }] }
    } })));
    expect(host.querySelector('[data-fm-portal-cell]')?.textContent).toBe('');
  });

  it('shows a repeating portal column under its repetition key', () => {
    const layout = createBlankLayout('Portal'); layout.objects = [{ ...field(), type: 'portal', relatedContext: 'Related',
      rowCount: 2, columns: [{ id: 'col', fmFieldName: 'Notes', label: 'Notes', width: 120 }], scroll: true, selectableRows: false }];
    act(() => root.render(React.createElement(LayoutContainer, { layout, mode: 'runtime', runtimeData: {
      portalRowsByObjectId: { [layout.objects[0].id]: [{ 'Notes(1)': 'repeated value' }] }
    } })));
    // The related record holds the repeated value under `Notes(1)`, so the column shows it.
    expect(host.querySelector('[data-fm-portal-cell]')?.textContent).toBe('repeated value');
  });
});
