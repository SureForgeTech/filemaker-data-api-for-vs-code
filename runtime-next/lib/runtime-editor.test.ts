// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankLayout, type FieldLayoutObject } from '@fmweb/shared';
import { RuntimeLayoutClient } from '../app/layouts/[id]/runtime-layout-client';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
let host: HTMLDivElement;
let root: Root;
let calls: Array<{ route: string; body: Record<string, unknown> }>;
let fail: string | undefined;
let failReload: boolean;
let resolveFind: (() => void) | undefined;
let fields: Record<string, unknown>;
let modId: string;
let records: unknown[];
let observer: ResizeObserverCallback;
const layout = createBlankLayout(' Exact layout ', ' Source ');
layout.objects = [
  [' Text ', 'text', 'normal'], ['Number', 'number', 'normal'], ['Date', 'date', 'normal'],
  ['Calc', 'number', 'calculation'], ['Summary', 'number', 'summary'], ['Photo', 'text', 'container'], ['Global', 'text', 'global']
].map(([name, format, kind], i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name, fmFieldName: name, type: 'field',
  format, kind, displayType: 'editBox', required: false, labelPosition: 'top', width: 240, height: 34, x: 24, y: i * 80,
  zIndex: i, anchors: { left: true, top: true, right: false, bottom: false }
} as FieldLayoutObject));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sessionStorage.clear(); calls = []; fail = undefined; failReload = false; resolveFind = undefined; modId = '7';
  fields = { ' Text ': 'Original', Number: 12, Date: '31/12/2026', Calc: 3, Summary: 9, Photo: '', Global: '' };
  records = [{ recordId: '19', modId, fieldData: fields }];
  vi.stubEnv('NEXT_PUBLIC_FMWEB_BRIDGE_URL', 'http://bridge.test/fm');
  vi.stubEnv('NEXT_PUBLIC_FMWEB_BRIDGE_TOKEN', 'token');
  vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { observer = callback; } observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const route = url.split('/').pop()!; const body = JSON.parse(String(init.body)); calls.push({ route, body });
    if (route === 'find' && resolveFind) await new Promise<void>((resolve) => { resolveFind = resolve; });
    if (fail) return new Response(JSON.stringify({ error: fail, code: fail.includes('306') ? '306' : undefined }), { status: 500 });
    if (route === 'find') return Response.json({ data: records });
    if (route === 'getRecord' && failReload) return new Response(JSON.stringify({ error: 'Reload unavailable' }), { status: 500 });
    if (route === 'getRecord') return Response.json({ recordId: '19', modId, fieldData: fields });
    if (route === 'editRecord') { fields = { ...fields, ...(body.fieldData as object) }; modId = '8'; }
    if (route === 'createRecord') fields = body.fieldData;
    return Response.json({ recordId: '19', modId, response: {} });
  }));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function mount(debug = false): Promise<void> {
  await act(async () => root.render(React.createElement(RuntimeLayoutClient, { layout, debug })));
}
async function click(text: string): Promise<void> {
  const button = Array.from(host.querySelectorAll('button')).find((node) => node.textContent === text);
  expect(button, `button ${text}`).toBeDefined();
  await act(async () => button!.click());
}
function change(name: string, value: string): void {
  const input = host.querySelector(`[aria-label="${name}"]`) as HTMLInputElement;
  expect(input).not.toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('FM Web record editor', () => {
  it('loads records, keeps viewing read-only, saves only changed fields with the loaded modId, and cancels drafts', async () => {
    await mount();
    expect(calls[0].route).toBe('find');
    expect(host.querySelector<HTMLInputElement>('[aria-label=" Text "]')?.readOnly).toBe(true);
    expect(host.textContent).not.toContain('Save Stamp');
    await click('Edit'); change(' Text ', '  changed  '); change('Global', 'session value');
    await click('Save');
    expect(calls.find((call) => call.route === 'editRecord')?.body).toEqual({
      layout: ' Source ', recordId: '19', modId: '7', fieldData: { ' Text ': '  changed  ', Global: 'session value' }
    });
    await click('Edit'); change(' Text ', 'discard me'); await click('Cancel');
    expect(host.querySelector<HTMLInputElement>('[aria-label=" Text "]')?.value).toBe('  changed  ');
    expect(calls.filter((call) => call.route === 'editRecord')).toHaveLength(1);
  });
  it('preserves date strings and safely converts edited decimal numbers without changing large numbers', async () => {
    await mount(); await click('Edit'); change('Number', '9007199254740993'); await click('Save');
    expect(calls.find((call) => call.route === 'editRecord')?.body.fieldData).toEqual({ Number: '9007199254740993' });
    await click('Edit'); change('Number', '12.5'); change('Date', '01/01/2027'); await click('Save');
    expect(calls.filter((call) => call.route === 'editRecord')[1].body.fieldData).toEqual({ Number: 12.5, Date: '01/01/2027' });
  });
  it.each(['Number', 'Date', ' Text '])('keeps %s as entered when FileMaker refuses its field rules', async (name) => {
    await mount(); await click('Edit'); change(name, 'invalid value');
    fail = 'The value does not match the field rules.';
    await click('Save');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(fail);
    expect(host.querySelector<HTMLInputElement>(`[aria-label="${name}"]`)?.value).toBe('invalid value');
    expect(calls.find((call) => call.route === 'editRecord')?.body.fieldData).toEqual({ [name]: 'invalid value' });
  });
  it('keeps the draft and explains error 306 without retrying with a newer modId', async () => {
    await mount(); await click('Edit'); change(' Text ', 'my draft'); fail = 'Record modification ID does not match (306).';
    await click('Save');
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/306.*changed|changed.*306/i);
    expect(host.querySelector<HTMLInputElement>('[aria-label=" Text "]')?.value).toBe('my draft');
    expect(calls.filter((call) => call.route === 'editRecord')).toHaveLength(1);
    expect(calls.filter((call) => call.route === 'getRecord')).toHaveLength(0);
  });
  it('creates from entered values, filters read-only fields, and confirms deletion', async () => {
    await mount(); await click('Create'); change(' Text ', 'new record'); change('Number', '2.5');
    await click('Save');
    expect(calls.find((call) => call.route === 'createRecord')?.body).toEqual({ layout: ' Source ', fieldData: { ' Text ': 'new record', Number: 2.5 } });
    vi.mocked(window.confirm).mockReturnValueOnce(false); await click('Delete');
    expect(calls.some((call) => call.route === 'deleteRecord')).toBe(false);
    vi.mocked(window.confirm).mockReturnValueOnce(true); await click('Delete');
    expect(calls.filter((call) => call.route === 'deleteRecord')).toHaveLength(1);
  });
  it('warns before removing NUL, can cancel, and removes only that character after confirmation', async () => {
    await mount(); await click('Edit'); change(' Text ', 'A\0B\u200bC');
    vi.mocked(window.confirm).mockReturnValueOnce(false); await click('Save');
    expect(calls.some((call) => call.route === 'editRecord')).toBe(false);
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining('dropped the rest'));
    vi.mocked(window.confirm).mockReturnValueOnce(true); await click('Save');
    expect(calls.find((call) => call.route === 'editRecord')?.body.fieldData).toEqual({ ' Text ': 'AB\u200bC' });
  });
  it('warns when removing NUL empties a field and skips saves with no changes', async () => {
    await mount(); await click('Edit'); await click('Save');
    expect(calls.some((call) => call.route === 'editRecord')).toBe(false);
    await click('Edit'); change(' Text ', '\0'); await click('Save');
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('sent as empty'));
    expect(calls.find((call) => call.route === 'editRecord')?.body.fieldData).toEqual({ ' Text ': '' });
  });
  it('asks to reload a record with no version instead of offering an unchecked edit', async () => {
    records = [{ recordId: '19', fieldData: fields }];
    await mount();
    expect(Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Edit')?.disabled).toBe(true);
    expect(host.textContent).toContain('record version is missing');
  });
  it('validates required fields and retains invalid drafts until corrected or cancelled', async () => {
    layout.objects[0] = { ...(layout.objects[0] as FieldLayoutObject), required: true };
    try {
      await mount(); await click('Edit'); change(' Text ', ''); await click('Save');
      expect(host.textContent).toContain('required');
      expect(calls.some((call) => call.route === 'editRecord')).toBe(false);
      await click('Cancel'); await click('Create'); await click('Save');
      expect(calls.some((call) => call.route === 'createRecord')).toBe(false);
    } finally { layout.objects[0] = { ...(layout.objects[0] as FieldLayoutObject), required: false }; }
  });
  it.each(['Edit', 'Create'])('does not repeat an accepted %s when only the reload fails', async (action) => {
    await mount(); await click(action); change(' Text ', 'saved'); failReload = true;
    await click('Save');
    expect(host.textContent).toContain(action === 'Edit' ? 'was saved, but could not be reloaded' : 'was created, but could not be reloaded');
    expect(Array.from(host.querySelectorAll('button')).some((button) => button.textContent === 'Save')).toBe(false);
    expect(calls.filter((call) => call.route === (action === 'Edit' ? 'editRecord' : 'createRecord'))).toHaveLength(1);
  });

  it('shows loading, empty, and error messages and hides bridge diagnostics unless debug is set', async () => {
    records = []; resolveFind = () => undefined; await mount();
    expect(host.textContent).toContain('Loading records');
    await act(async () => resolveFind!()); resolveFind = undefined;
    expect(host.textContent).toContain('No records');
    expect(host.textContent).not.toContain('Bridge:');
    fail = 'Access denied'; await click('Find');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Access denied');
    expect(host.textContent).not.toContain('Runtime data is idle.');
    await mount(true); expect(host.textContent).toContain('Bridge:');
  });
  it('measures the content frame, ignores duplicate resize notifications, and never grows the frame from canvas height', async () => {
    await mount();
    await act(async () => observer([{ contentRect: { width: 346, height: 494 } } as ResizeObserverEntry], {} as ResizeObserver));
    const canvas = host.querySelector<HTMLElement>('[data-mode="runtime"]')!;
    expect(canvas.style.width).toBe('346px');
    const height = canvas.style.height;
    await act(async () => observer([{ contentRect: { width: 346, height: 2000 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(canvas.style.height).toBe(height);
  });
});


it('clears the saved message on next and previous', async () => {
  records = [{ recordId: '19', modId, fieldData: fields }, { recordId: '20', modId, fieldData: fields }];
  await mount();
  await click('Edit');
  change(' Text ', 'saved'); await click('Save');
  expect(host.textContent).toContain('Saved record 19.');
  await click('Next');
  expect(host.textContent).not.toContain('Saved record 19.');
  await click('Edit'); change(' Text ', 'second'); await click('Save');
  expect(host.textContent).toContain('Saved record 20.');
  await click('Prev');
  expect(host.textContent).not.toContain('Saved record 20.');
});


it.each(['type', 'result'])('uses metadata %s for read-only fields when kind is missing', async (key) => {
  const previous = layout.objects;
  layout.objects = previous.map((object) => object.type === 'field' && ['Calc', 'Summary'].includes(object.fmFieldName)
    ? { ...object, kind: undefined, metadata: { [key]: object.fmFieldName === 'Calc' ? 'calculation' : 'summary' } } as typeof object : object);
  try {
    await mount(); await click('Edit');
    for (const name of ['Calc', 'Summary']) expect(host.querySelector<HTMLInputElement>(`[aria-label="${name}"]`)?.readOnly).toBe(true);
    change(' Text ', 'keep editable'); await click('Save');
    expect(calls.find((call) => call.route === 'editRecord')?.body.fieldData).toEqual({ ' Text ': 'keep editable' });
  } finally { layout.objects = previous; }
});

it('keeps fields with no metadata editable and reports a refusal without losing the draft', async () => {
  const previous = layout.objects;
  layout.objects = previous.map((object) => ({ ...object, kind: undefined }));
  try {
    await mount(); await click('Edit'); change('Calc', '123');
    fail = 'FileMaker cannot edit this calculated field.';
    await click('Save');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(fail);
    expect(host.querySelector<HTMLInputElement>('[aria-label="Calc"]')?.value).toBe('123');
    expect(calls.find((call) => call.route === 'editRecord')?.body.fieldData).toEqual({ Calc: 123 });
  } finally { layout.objects = previous; }
});

it('shows date guidance only while editing', async () => {
  await mount();
  expect(host.textContent).not.toContain("Use the server's date format");
  await click('Edit');
  expect(host.textContent).toContain("Use the server's date format");
  await click('Cancel');
  expect(host.textContent).not.toContain("Use the server's date format");
});

it('saves a repeated field under the key the record holds it under, and leaves the other repetitions alone', async () => {
  const previous = layout.objects;
  fields = { 'Notes(1)': 'first', 'Notes(2)': 'other' };
  records = [{ recordId: '19', modId, fieldData: fields }];
  layout.objects = [{ id: '00000000-0000-4000-8000-000000000099', name: 'Notes', fmFieldName: 'Notes', type: 'field',
    format: 'text', kind: 'normal', displayType: 'editBox', required: false, labelPosition: 'top', width: 240, height: 34,
    x: 24, y: 0, zIndex: 0, anchors: { left: true, top: true, right: false, bottom: false } } as FieldLayoutObject];
  try {
    await mount();
    // The value of the first repetition is shown.
    expect(host.querySelector<HTMLInputElement>('[aria-label="Notes"]')?.value).toBe('first');
    await click('Edit');
    change('Notes', 'edited');
    await click('Save');
    // The patch names the repetition key, so the other repetition of the field keeps its value.
    expect(calls.find((call) => call.route === 'editRecord')?.body.fieldData).toEqual({ 'Notes(1)': 'edited' });
    expect(fields['Notes(2)']).toBe('other');
  } finally { layout.objects = previous; }
});


it('saves a required repeating field whose value is under its repetition key', async () => {
  const previous = layout.objects;
  fields = { 'Notes(1)': 'first' };
  records = [{ recordId: '19', modId, fieldData: fields }];
  layout.objects = [{ id: '00000000-0000-4000-8000-000000000099', name: 'Notes', fmFieldName: 'Notes', type: 'field',
    format: 'text', kind: 'normal', displayType: 'editBox', required: true, labelPosition: 'top', width: 240, height: 34,
    x: 24, y: 0, zIndex: 0, anchors: { left: true, top: true, right: false, bottom: false } } as FieldLayoutObject];
  try {
    await mount();
    await click('Edit');
    change('Notes', 'edited');
    await click('Save');
    // The required check finds the value under the repetition key, so the save is not refused.
    expect(host.textContent).not.toContain('Field is required by metadata hints.');
    expect(calls.find((call) => call.route === 'editRecord')?.body.fieldData).toEqual({ 'Notes(1)': 'edited' });
  } finally { layout.objects = previous; }
});

it('displays, validates, and saves a field whose only available key is Notes(2)', async () => {
  const previous = layout.objects;
  fields = { 'Notes(2)': 'second' };
  records = [{ recordId: '19', modId, fieldData: fields }];
  layout.objects = [{ id: '00000000-0000-4000-8000-000000000099', name: 'Notes', fmFieldName: 'Notes', type: 'field',
    format: 'text', kind: 'normal', displayType: 'editBox', required: true, labelPosition: 'top', width: 240, height: 34,
    x: 24, y: 0, zIndex: 0, anchors: { left: true, top: true, right: false, bottom: false } } as FieldLayoutObject];
  try {
    await mount();
    expect(host.querySelector<HTMLInputElement>('[aria-label="Notes"]')?.value).toBe('second');
    await click('Edit');
    change('Notes', 'edited');
    await click('Save');
    expect(host.textContent).not.toContain('Field is required by metadata hints.');
    expect(calls.find((call) => call.route === 'editRecord')?.body.fieldData).toEqual({ 'Notes(2)': 'edited' });
  } finally { layout.objects = previous; }
});
