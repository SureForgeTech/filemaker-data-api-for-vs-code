import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LayoutContainer,
  applyAnchoredRuntimeRect,
  computePortalVisibleRange,
  createBlankLayout,
  type FieldLayoutObject,
  type LayoutDefinition,
  type LayoutObject,
  type PortalLayoutObject
} from '../src';

const ids = Array.from({ length: 12 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);

function base(id: string, name: string, y = 24) {
  return {
    id,
    name,
    x: 24,
    y,
    width: 240,
    height: 34,
    zIndex: 0,
    anchors: { top: true, right: false, bottom: false, left: true }
  };
}

function field(name: string, id: string, overrides: Partial<FieldLayoutObject> = {}): FieldLayoutObject {
  return {
    ...base(id, `${name} object`),
    type: 'field',
    fmFieldName: name,
    displayType: 'editBox',
    format: 'text',
    labelPosition: 'top',
    required: false,
    ...overrides
  };
}

function layoutWith(objects: LayoutObject[]): LayoutDefinition {
  const layout = createBlankLayout(' Render ', ' Source::Layout ');
  layout.objects = objects;
  return layout;
}

afterEach(cleanup);

describe('LayoutContainer object rendering', () => {
  it('renders every saved object variant as text or controls and returns the original button on action', () => {
    const onAction = vi.fn();
    const button: Extract<LayoutObject, { type: 'button' }> = {
      ...base(ids[1], 'Action', 80),
      type: 'button',
      label: ' Run exact ',
      behavior: { type: 'runScript', scriptName: ' Exact script ' }
    };
    const unsafeText = '<img src=x onerror=alert(1)> & text';
    const layout = layoutWith([
      field(' Customer::Name ', ids[0], { label: ' Exact label ', required: true }),
      button,
      { ...base(ids[2], 'Text', 140), type: 'text', text: unsafeText },
      { ...base(ids[3], 'Image', 200), type: 'image', src: 'javascript:alert(1)' },
      { ...base(ids[4], 'Tabs', 260), type: 'tabPanel', tabs: [] },
      { ...base(ids[5], 'Shape', 320), type: 'rectangle', cornerRadius: 8 }
    ]);

    const { container } = render(<LayoutContainer layout={layout} mode="designer" onObjectAction={onAction} />);

    expect(container.querySelector('label span')?.textContent).toBe(' Exact label ');
    expect(container.querySelector('[data-required-indicator="true"]')).not.toBeNull();
    expect(screen.getByText(unsafeText)).toBeTruthy();
    expect(container.querySelector('img, script')).toBeNull();
    expect(screen.getByText('Image')).toBeTruthy();
    expect(screen.getByText('Tab Panel')).toBeTruthy();
    const action = container.querySelector('button')!;
    expect(action.textContent).toBe(' Run exact ');
    fireEvent.click(action);
    expect(onAction).toHaveBeenCalledWith(button);
    expect(layout.objects[1]).toBe(button);
  });

  it('edits the exact key that supplied each value, including the lowest repetition', () => {
    const onFieldChange = vi.fn();
    const layout = layoutWith([
      field(' Name ', ids[0]),
      field('Notes', ids[1], { y: 100 }),
      field('Total', ids[2], { y: 176, kind: 'calculation' }),
      field('Date', ids[3], { y: 252, format: 'date' })
    ]);
    const { container } = render(<LayoutContainer layout={layout} mode="runtime" runtimeData={{
      editing: true,
      fieldValues: { ' Name ': 'before', 'Notes(10)': 'ten', 'Notes(2)': 'two', Total: '42', Date: '31/12/2026' },
      onFieldChange
    }} />);

    const name = container.querySelector<HTMLInputElement>('[aria-label=" Name "]')!;
    fireEvent.change(name, { target: { value: ' after ' } });
    const notes = container.querySelector<HTMLTextAreaElement>('[aria-label="Notes"]')!;
    fireEvent.change(notes, { target: { value: 'edited' } });
    expect(onFieldChange.mock.calls).toEqual([[' Name ', ' after '], ['Notes(2)', 'edited']]);

    const total = container.querySelector<HTMLInputElement>('[aria-label="Total"]')!;
    expect(total.readOnly).toBe(true);
    expect(screen.getByText('Calculated by FileMaker; cannot be edited')).toBeTruthy();
    const date = container.querySelector<HTMLInputElement>('[aria-label="Date"]')!;
    expect(date.type).toBe('text');
    expect(date.value).toBe('31/12/2026');
    expect(date.getAttribute('aria-describedby')).toContain('note');
    expect(screen.getByText(/Use the server's date format/)).toBeTruthy();
  });

  it('retains unmatched choices and treats container text as data, never as an executable URL', () => {
    const onFieldChange = vi.fn();
    const layout = layoutWith([
      field('Status', ids[0], { displayType: 'dropdown', options: ['A', ' B '] }),
      field('Unsafe', ids[1], { y: 100, kind: 'container' }),
      field('Photo', ids[2], { y: 276, kind: 'container', height: 160 })
    ]);
    const { container } = render(<LayoutContainer layout={layout} mode="runtime" runtimeData={{
      editing: true,
      fieldValues: { Status: ' Unlisted ', Unsafe: 'javascript:alert(1)', Photo: 'https://example.test/photo.png' },
      onFieldChange
    }} />);

    const select = container.querySelector<HTMLSelectElement>('[aria-label="Status"]')!;
    expect(select.querySelector('option[value=" Unlisted "]')?.textContent).toBe(' Unlisted  (current value)');
    fireEvent.change(select, { target: { value: ' B ' } });
    expect(onFieldChange).toHaveBeenCalledWith('Status', ' B ');

    expect(screen.getByText('javascript:alert(1)').tagName).toBe('DIV');
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    const image = screen.getByAltText('Photo');
    fireEvent.error(image);
    const fallback = screen.getByRole('link', { name: 'https://example.test/photo.png' });
    expect(fallback.getAttribute('href')).toBe('https://example.test/photo.png');
    expect(fallback.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

describe('LayoutContainer runtime layout behavior', () => {
  it('hides fields absent from a record, shows them when creating, and follows FileMaker field order', () => {
    const layout = layoutWith([
      field('First', ids[0], { zIndex: 0 }),
      field('Second', ids[1], { y: 100, zIndex: 1 }),
      field('Hidden', ids[2], { y: 176, zIndex: 2 })
    ]);
    layout.fieldOrder = ['Second', 'First', 'Hidden'];
    const { container, rerender } = render(<LayoutContainer layout={layout} mode="runtime" runtimeData={{
      fieldValues: { First: 'one', Second: 'two' }
    }} />);

    expect([...container.querySelectorAll('[data-fm-field-id]')].map((element) => element.getAttribute('data-fm-field-id')))
      .toEqual([ids[1], ids[0]]);
    expect(container.querySelector(`[data-fm-field-id="${ids[2]}"]`)).toBeNull();

    rerender(<LayoutContainer layout={layout} mode="runtime" runtimeData={{
      creating: true,
      fieldValues: { First: 'one', Second: 'two' }
    }} />);
    expect(container.querySelector(`[data-fm-field-id="${ids[2]}"]`)).not.toBeNull();
  });

  it('grows multiline values and shifts later rows without mutating the saved layout', () => {
    const layout = layoutWith([
      field('Notes', ids[0]),
      field('Next', ids[1], { y: 104 })
    ]);
    const { container } = render(<LayoutContainer layout={layout} mode="runtime" runtimeData={{
      fieldValues: { Notes: 'first\nsecond', Next: 'after' }
    }} />);

    const notes = container.querySelector<HTMLElement>(`[data-fm-field-id="${ids[0]}"]`)!;
    const next = container.querySelector<HTMLElement>(`[data-fm-field-id="${ids[1]}"]`)!;
    expect(notes.querySelector('textarea')).not.toBeNull();
    expect(notes.getAttribute('data-fm-height')).toBe('96');
    expect(Number.parseFloat(next.style.top)).toBeGreaterThanOrEqual(Number.parseFloat(notes.style.top) + Number.parseFloat(notes.style.height) + 16);
    expect(layout.objects.map((object) => [object.y, object.height])).toEqual([[24, 34], [104, 34]]);
  });

  it('stacks controls for narrow screens while leaving decorative geometry unchanged', () => {
    const layout = layoutWith([
      field('Later', ids[0], { x: 200, y: 200, width: 300 }),
      field('Earlier', ids[1], { x: 24, y: 40 }),
      { ...base(ids[2], 'Decoration', 10), type: 'text', text: 'Decoration', x: 80, width: 300 }
    ]);
    const { container } = render(<LayoutContainer layout={layout} mode="runtime" runtimeData={{
      viewport: { width: 220, height: 100 },
      fieldValues: { Earlier: 'first', Later: 'later' }
    }} />);

    const earlier = container.querySelector<HTMLElement>(`[data-fm-field-id="${ids[1]}"]`)!;
    const later = container.querySelector<HTMLElement>(`[data-fm-field-id="${ids[0]}"]`)!;
    expect([earlier.style.left, earlier.style.top]).toEqual(['24px', '24px']);
    expect([later.style.left, later.style.top, later.style.width]).toEqual(['24px', '98px', '172px']);
    expect([screen.getByText('Decoration').style.left, screen.getByText('Decoration').style.top]).toEqual(['80px', '10px']);
  });
});

describe('portal and responsive rendering helpers', () => {
  it('renders portal mock data and virtualizes large runtime row sets on scroll', () => {
    const portal: PortalLayoutObject = {
      ...base(ids[0], 'Portal'),
      type: 'portal',
      height: 160,
      relatedContext: ' Child ',
      rowCount: 2,
      scroll: true,
      selectableRows: false,
      columns: [
        { id: ids[1], fmFieldName: 'Child::Date', label: ' Date ', width: 120 },
        { id: ids[2], fmFieldName: 'Child::Amount', label: ' Amount ', width: 120 },
        { id: ids[3], fmFieldName: ' Plain ', label: ' Plain ', width: 120 }
      ]
    };
    const layout = layoutWith([portal]);
    const { container, rerender } = render(<LayoutContainer layout={layout} mode="designer" />);

    expect(container.querySelectorAll('[data-fm-portal-row]')).toHaveLength(2);
    expect(screen.getByText('2026-03-01')).toBeTruthy();
    expect(screen.getByText('1250.75')).toBeTruthy();
    expect(container.querySelector('[data-fm-portal-cell=" Plain :0"]')?.textContent).toBe(' Plain  1');

    const rows = Array.from({ length: 50 }, (_, index) => ({
      'Child::Date': `date-${index}`,
      'Child::Amount(1)': `amount-${index}`,
      ' Plain ': `plain-${index}`
    }));
    rerender(<LayoutContainer layout={layout} mode="runtime" runtimeData={{ portalRowsByObjectId: { [portal.id]: rows } }} />);
    expect(container.querySelectorAll('[data-fm-portal-row]')).toHaveLength(10);
    const portalElement = container.querySelector<HTMLElement>('[data-fm-portal-id]')!;
    const scroller = portalElement.querySelectorAll<HTMLElement>(':scope > div')[1]!;
    fireEvent.scroll(scroller, { target: { scrollTop: 640 } });
    expect(container.querySelector('[data-fm-portal-row]')?.getAttribute('data-fm-portal-row')).toBe('17');
    expect(screen.getByText('amount-17')).toBeTruthy();
    expect(screen.queryByText('amount-0')).toBeNull();
    expect(computePortalVisibleRange(100, 256, 32, 640)).toEqual({ start: 17, end: 31 });
    expect(computePortalVisibleRange(0, 256, 32, 0)).toEqual({ start: 0, end: 0 });
  });

  it('shows empty portal guidance in both design and runtime modes', () => {
    const portal: PortalLayoutObject = {
      ...base(ids[0], 'Empty portal'),
      type: 'portal',
      relatedContext: '',
      rowCount: 1,
      columns: [],
      scroll: true,
      selectableRows: false
    };
    const layout = layoutWith([portal]);
    const { rerender } = render(<LayoutContainer layout={layout} mode="designer" />);
    expect(screen.getByText('Drop fields to create columns')).toBeTruthy();
    expect(screen.getByText('No columns configured')).toBeTruthy();
    rerender(<LayoutContainer layout={layout} mode="runtime" />);
    expect(screen.getByText('Drop fields to create columns')).toBeTruthy();
    expect(screen.queryByText('No columns configured')).toBeNull();
  });

  it('applies all anchor modes with rounded geometry and minimum dimensions', () => {
    const layout = createBlankLayout('Anchors');
    const rectangle: Extract<LayoutObject, { type: 'rectangle' }> = {
      ...base(ids[0], 'Stretch'),
      type: 'rectangle',
      width: 200,
      height: 60,
      cornerRadius: 0,
      anchors: { top: true, right: true, bottom: true, left: true }
    };
    const viewport = { width: layout.canvas.width + 201, height: layout.canvas.height + 121 };

    expect(applyAnchoredRuntimeRect(rectangle, layout, undefined)).toBe(rectangle);
    expect(applyAnchoredRuntimeRect(rectangle, layout, layout.canvas)).toBe(rectangle);
    expect(applyAnchoredRuntimeRect(rectangle, layout, viewport)).toMatchObject({ x: 24, y: 24, width: 401, height: 181 });
    expect(applyAnchoredRuntimeRect({ ...rectangle, anchors: { top: false, right: true, bottom: true, left: false } }, layout, viewport))
      .toMatchObject({ x: 225, y: 145, width: 200, height: 60 });
    expect(applyAnchoredRuntimeRect({ ...rectangle, anchors: { top: false, right: false, bottom: false, left: false } }, layout, viewport))
      .toMatchObject({ x: 125, y: 85, width: 200, height: 60 });
    expect(applyAnchoredRuntimeRect(rectangle, layout, { width: 1, height: 1 })).toMatchObject({ width: 1, height: 1 });
  });
});
