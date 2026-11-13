import { computeRecordPatch } from '@fmweb/shared/dist/record-edit';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { LayoutContainer, createBlankLayout, type FieldLayoutObject } from '@fmweb/shared';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { QueryBuilderPanel } from '../../../src/webviews/queryBuilder';
import { RecordEditorPanel } from '../../../src/webviews/recordEditor';
import { RecordViewerPanel } from '../../../src/webviews/recordViewer';
import { designerLayoutMetadata } from '../../../src/fmweb/fieldMetadata';
import { JSDOM, loadPage, type DomElement } from '../../helpers/jsdomPage';
import { InMemoryMemento } from '../mocks';

const root = path.resolve(__dirname, '../../../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const profiles = [{ id: 'p', name: 'Profile', database: 'DB' }];
const fields = [
  { name: ' Text ', type: 'text' }, { name: 'Number', type: 'number' },
  { name: 'Date', type: 'date' }, { name: 'Time', type: 'time' }, { name: 'Stamp', type: 'timestamp' },
  { name: 'Notes', type: 'long text' }, { name: 'Photo', type: 'container' }
];
const sizes = [[240, 34], [120, 34], [160, 34], [160, 34], [160, 34], [240, 96], [240, 160]];
const fieldData = Object.fromEntries(fields.map((field) => [field.name, `Value of ${field.name}`]));
const classes = { queryBuilder: QueryBuilderPanel, recordEditor: RecordEditorPanel, recordViewer: RecordViewerPanel };
type Surface = keyof typeof classes;

function html(surface: Surface): string {
  const panel = { webview: { html: '', cspSource: 'webview:', asWebviewUri: (uri: unknown) => uri,
    postMessage: vi.fn(async () => true), onDidReceiveMessage: vi.fn() },
    onDidDispose: vi.fn(), reveal: vi.fn() };
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(panel as never);
  (classes[surface] as unknown as { currentPanel: unknown }).currentPanel = undefined;
  const context = { extensionUri: vscode.Uri.file('/extension'), workspaceState: new InMemoryMemento() } as never;
  const store = { listProfiles: vi.fn(async () => profiles), getActiveProfileId: () => 'p' } as never;
  if (surface === 'queryBuilder') QueryBuilderPanel.createOrShow(context, store, {} as never, {} as never, logger as never);
  if (surface === 'recordEditor') RecordEditorPanel.createOrShow(context, store, {} as never, {} as never, logger as never);
  if (surface === 'recordViewer') RecordViewerPanel.createOrShow(context, store, {} as never, logger as never);
  return panel.webview.html;
}

function assertSize(element: DomElement | null, width: number, height: number): void {
  expect(element).not.toBeNull();
  expect(element?.getAttribute('data-fm-width')).toBe(String(width));
  expect(element?.getAttribute('data-fm-height')).toBe(String(height));
  expect(element?.getAttribute('data-fm-label-position')).toBe('top');
}

beforeEach(() => {
  vi.clearAllMocks();
  (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
});

describe.skipIf(!JSDOM)('standard field presentation in browser webviews', () => {
  it.each(['recordEditor', 'recordViewer'] as const)('%s layout controls preserve layout order, repetitions and hidden fields', (surface) => {
    const page = loadPage(html(surface), read(`extension/src/webviews/${surface}/ui/index.js`));
    const metadata = [{ name: 'Z', type: 'number' }, { name: 'A', type: 'text' }, { name: 'Hidden' }];
    const data = { Extra: 'extra', 'A(10)': 'ten', 'A(2)': 'two', Z: 10235.9, 'A(1)': 'one' };
    const payload = { record: { recordId: '1', fieldData: data }, fields: metadata, presentationFields: metadata };
    page.send({ type: 'recordLoaded', payload });
    const selector = surface === 'recordEditor' ? '#fieldEditor' : '#fieldDataContainer';
    expect(Array.from(page.document.querySelectorAll(`${selector} .fm-field-control[aria-label]`)).map((input) => input.getAttribute('aria-label')))
      .toEqual(['Z', 'A(1)', 'A(2)', 'A(10)', 'Extra']);
    const number = page.document.querySelectorAll(`${selector} input`)[0]!;
    expect(number.value).toBe('10235.9');
    if (surface === 'recordViewer') {
      const row = page.document.querySelectorAll(`${selector} tbody tr`)[0]!;
      const button = row.querySelector('button')!;
      expect(row.querySelector('.fm-field-label')?.contains(button)).toBe(true);
      expect(row.querySelector('.viewer-value')?.contains(button)).toBe(false);
      expect(number.classList.contains('wrap')).toBe(false);
      expect(read('extension/src/webviews/recordViewer/ui/styles.css')).toContain('white-space: nowrap; overflow-wrap: normal;');
      expect(read('extension/src/webviews/recordViewer/ui/styles.css')).not.toContain('padding-right: 58px');
    }
    // Loading another layout with the same keys must refresh both order and controls.
    page.send({ type: 'recordLoaded', payload: { ...payload, fields: [...metadata].reverse(), presentationFields: [...metadata].reverse() } });
    expect(page.document.querySelectorAll(`${selector} .fm-field-control[aria-label]`)[0]?.getAttribute('aria-label')).toBe('A(1)');
  });

  it('Editor layout controls match FM Web and keep unknown current select values without a patch', () => {
    const page = loadPage(html('recordEditor'), read('extension/src/webviews/recordEditor/ui/index.js'));
    page.send({ type: 'init', payload: { profiles, activeProfileId: 'p' } });
    page.send({ type: 'layoutsLoaded', payload: { profileId: 'p', layouts: [' Layout '] } });
    page.document.getElementById('recordIdInput')!.value = '1';
    const metadata = [
      { name: 'Status', type: 'text', displayType: 'popupMenu', options: ['Active'] },
      { name: 'Text', type: 'text' }, { name: 'Qty', type: 'number' },
      { name: 'Date', type: 'date' }, { name: 'Time', type: 'time' }, { name: 'Stamp', type: 'timestamp' },
      { name: 'Notes', type: 'text', maxLength: 500 },
      { name: 'Flags', type: 'text', displayType: 'checkbox', options: ['A', 'B'] },
      { name: 'Choice', type: 'text', displayType: 'radioButtons', options: ['A', 'B'] },
      { name: 'Calc', type: 'number', kind: 'calculation' }, { name: 'Total', type: 'number', kind: 'summary' },
      { name: 'Photo', type: 'container', kind: 'container' }
    ];
    const values = { Status: ' Archived ', Text: '  same  ', Qty: 10235.9, Date: '10/22/2026', Time: '12:30:00', Stamp: '10/22/2026 12:30:00', Notes: 'first\nsecond', Flags: 'A\rB', Choice: 'B', Calc: 1, Total: 2, Photo: 'https://example.test/photo.png' };
    const raw = metadata.map((field) => ({ ...field, type: field.kind === 'calculation' || field.kind === 'summary' ? field.kind : 'normal', result: field.type }));
    page.send({ type: 'recordLoaded', payload: { profileId: 'p', layout: ' Layout ', fields: raw, presentationFields: metadata,
      record: { recordId: '1', modId: '9', fieldData: values } } });
    const selectors = ['select', 'input', 'input', 'input', 'input', 'input', 'textarea', 'input[type="checkbox"]', 'input[type="radio"]', 'input[readonly]', 'input[readonly]', '.fm-container'];
    const layout = createBlankLayout('Parity');
    const objects: FieldLayoutObject[] = metadata.map((field, index) => ({
      id: String(index), name: field.name, type: 'field', fmFieldName: field.name,
      format: field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text',
      result: field.type, kind: field.kind as FieldLayoutObject['kind'], multiline: field.name === 'Notes', options: field.options,
      displayType: field.displayType === 'popupMenu' ? 'dropdown' : field.displayType === 'radioButtons' ? 'radio' : field.displayType === 'checkbox' ? 'checkbox' : 'editBox',
      labelPosition: 'top', required: false, width: 240, height: 34, x: 24, y: index * 220, zIndex: index,
      anchors: { top: true, right: false, bottom: false, left: true }
    }));
    layout.objects = objects;
    const markup = renderToStaticMarkup(createElement(LayoutContainer, { layout, mode: 'runtime', runtimeData: { editing: true, fieldValues: values } }));
    page.window.eval(`const runtime = document.createElement('section'); runtime.id = 'parity'; runtime.innerHTML = ${JSON.stringify(markup)}; document.body.appendChild(runtime);`);
    const rows = page.document.querySelectorAll('#fieldEditor tbody tr');
    selectors.forEach((selector, index) => {
      expect(rows[index]?.querySelector(selector), metadata[index]?.name).not.toBeNull();
      expect(page.document.querySelectorAll('#parity [data-fm-field-id]')[index]?.querySelector(selector), metadata[index]?.name).not.toBeNull();
    });
    expect(page.document.querySelectorAll('#fieldEditor select')[0]?.value).toBe(' Archived ');
    expect(page.document.querySelectorAll('#fieldEditor option[value=" Archived "]')[0]?.textContent).toBe(' Archived  (current value)');
    page.document.getElementById('saveButton')!.click();
    const body = page.posted.at(-1)?.payload as { originalFieldData: Record<string, unknown>; draftFieldData: Record<string, unknown> };
    expect(computeRecordPatch(body.originalFieldData, body.draftFieldData)).toEqual({});
    expect(body.draftFieldData.Status).toBe(' Archived ');
    page.send({ type: 'saveCancelled' });
    page.window.eval(`const select = document.querySelector('#fieldEditor select'); select.value = 'Active'; select.dispatchEvent(new Event('change'));`);
    page.document.getElementById('saveButton')!.click();
    const changed = page.posted.at(-1)?.payload as typeof body;
    expect(computeRecordPatch(changed.originalFieldData, changed.draftFieldData)).toEqual({ Status: 'Active' });
  });

  it.each(['recordEditor', 'recordViewer'] as const)('%s shows the container URL when its image cannot be shown', (surface) => {
    const page = loadPage(html(surface), read(`extension/src/webviews/${surface}/ui/index.js`));
    const url = 'https://example.test/photo.png';
    const metadata = [{ name: 'Photo', type: 'container', result: 'container' }];
    page.send({ type: 'recordLoaded', payload: { record: { recordId: '1', fieldData: { Photo: url } }, fields: metadata, presentationFields: metadata } });
    expect(page.document.querySelectorAll('.fm-container img')[0]?.getAttribute('src')).toBe(url);
    // A blocked or missing image must not hide where the container lives.
    page.window.eval(`document.querySelector('.fm-container img').dispatchEvent(new Event('error'));`);
    expect(page.document.querySelectorAll('.fm-container')[0]?.textContent).toBe(url);
  });

  it('Query Builder layout controls use layout order for field choices and result columns', () => {
    const page = loadPage(html('queryBuilder'), read('extension/src/webviews/queryBuilder/ui/findForm.js') + '\n' + read('extension/src/webviews/queryBuilder/ui/resultModel.js') + '\n' + read('extension/src/webviews/queryBuilder/ui/index.js'));
    page.send({ type: 'init', payload: { profiles, activeProfileId: 'p', savedQueries: [] } });
    page.send({ type: 'layoutsLoaded', payload: { profileId: 'p', layouts: ['Layout'] } });
    const metadata = [{ name: 'Z', type: 'text', displayType: 'dropdown', options: ['Active'] }, { name: 'A', type: 'text', multiline: true }];
    page.send({ type: 'fieldNamesLoaded', payload: { profileId: 'p', layout: 'Layout', fieldNames: ['A', 'Z'], fieldMetadata: metadata } });
    expect(Array.from(page.document.querySelectorAll('#fieldNameOptions option')).map((option) => option.value)).toEqual(['Z', 'A']);
    page.window.eval(`const field = document.querySelector('.criterion-field'); field.value = 'Z'; field.dispatchEvent(new Event('input'));`);
    // A find criterion is plain text, so FileMaker's own operators and wildcards stay typeable.
    expect(page.document.querySelectorAll('input.criterion-value')).toHaveLength(1);
    page.window.eval(`const value = document.querySelector('input.criterion-value'); value.value = 'Active'; value.dispatchEvent(new Event('input'));`);
    page.document.getElementById('runButton')!.click();
    expect(JSON.parse((page.posted.at(-1)?.payload as { findJson: string }).findJson)).toEqual([{ Z: 'Active' }]);
    page.window.eval(`if (JSON.stringify(collectColumns([{ fieldData: { Extra: '', A: '', Z: '' } }])) !== JSON.stringify(['Z', 'A', 'Extra'])) throw new Error('Wrong result column order');`);
    page.window.eval(`const field = document.querySelector('.criterion-field'); field.value = 'A'; field.dispatchEvent(new Event('input'));`);
    expect(page.document.querySelectorAll('input.criterion-value')[0]?.value).toBe('Active');
  });

  it('Find criteria stay plain text for choice fields, and calculated fields stay searchable', () => {
    const page = loadPage(html('queryBuilder'), read('extension/src/webviews/queryBuilder/ui/findForm.js') + '\n' + read('extension/src/webviews/queryBuilder/ui/resultModel.js') + '\n' + read('extension/src/webviews/queryBuilder/ui/index.js'));
    page.send({ type: 'init', payload: { profiles, activeProfileId: 'p', savedQueries: [] } });
    page.send({ type: 'layoutsLoaded', payload: { profileId: 'p', layouts: ['Layout'] } });
    page.send({ type: 'fieldNamesLoaded', payload: { profileId: 'p', layout: 'Layout', fieldNames: ['Choice', 'Calc'], fieldMetadata: [
      { name: 'Choice', type: 'text', displayType: 'radio', options: ['A', 'B'] }, { name: 'Calc', type: 'number', kind: 'calculation' }
    ] } });
    page.window.eval(`const field = document.querySelector('.criterion-field'); field.value = 'Choice'; field.dispatchEvent(new Event('input'));
      const control = document.querySelector('.criterion-value');
      if (control.tagName !== 'INPUT') throw new Error('A find criterion must be a plain text control');
      if (control.parentElement.tagName === 'LABEL') throw new Error('Find controls must not be nested inside another label');
      control.value = 'B'; control.dispatchEvent(new Event('input'));`);
    page.document.getElementById('runButton')!.click();
    expect(JSON.parse((page.posted.at(-1)?.payload as { findJson: string }).findJson)).toEqual([{ Choice: 'B' }]);
    page.window.eval(`const field = document.querySelector('.criterion-field'); field.value = 'Calc'; field.dispatchEvent(new Event('input'));`);
    expect(page.document.querySelectorAll('.criterion-value[readonly], .criterion-value[disabled]')).toHaveLength(0);
  });

  it.each(['recordEditor', 'recordViewer'] as const)('%s uses typed widths with top labels and retains row selectors', (surface) => {
    const pageHtml = html(surface);
    expect(pageHtml).toContain('fieldStandards.css');
    expect(pageHtml).toMatch(/script nonce="[^"]+" src="[^"]*fieldStandards.js/);
    expect(pageHtml).not.toContain("'unsafe-inline'");
    const page = loadPage(pageHtml, read(`extension/src/webviews/${surface}/ui/index.js`));
    page.send({ type: 'recordLoaded', payload: { record: { recordId: '1', fieldData }, fields, presentationFields: fields } });
    const container = surface === 'recordEditor' ? '#fieldEditor' : '#fieldDataContainer';
    const rows = page.document.querySelectorAll(`${container} tbody tr`);
    expect(rows).toHaveLength(fields.length);
    fields.forEach((field, index) => {
      const row = Array.from(rows).find((row) => row.querySelector('.fm-field-control[aria-label]')?.getAttribute('aria-label') === field.name)!;
      assertSize(row, sizes[index]![0]!, sizes[index]![1]!);
      const control = row.querySelector(surface === 'recordEditor' ? '.fm-field-control[aria-label]' : 'td.fm-field-control');
      expect(control).not.toBeNull();
      if (surface === 'recordEditor') {
        expect(control?.getAttribute('aria-label')).toBe(field.name);
        const label = row.querySelector('td')!;
        // Journey J05 uses td:text-is(), which matches immediate text, not nested label text.
        expect(label.querySelectorAll('*')).toHaveLength(0);
        expect(control?.getAttribute('aria-labelledby')).toBe(label.id);
      }
    });
    // Same-key records must refresh sizing too; DOM reuse must not keep another layout's type.
    page.send({ type: 'recordLoaded', payload: { record: { recordId: '2', fieldData }, presentationFields: [] } });
    page.document.querySelectorAll(`${container} tbody tr`).forEach((row) => assertSize(row, 240, 34));
  });

  it('Viewer boxes exact read-only values and places Copy in the label without another field row', async () => {
    const page = loadPage(html('recordViewer'), read('extension/src/webviews/recordViewer/ui/index.js'));
    const exact = '  first line\nsecond line  ';
    const values = { ' Text ': '  unchanged  ', Notes: exact, Photo: 'container-url', Unknown: 'x'.repeat(500) };
    const payload = { record: { recordId: '1', fieldData: values, portalData: { Related: [{ recordId: '2' }] } }, presentationFields: fields };
    page.send({ type: 'recordLoaded', payload });
    page.window.eval(`Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { window.copied = text; } } });`);
    const rows = page.document.querySelectorAll('#fieldDataContainer tbody tr');
    expect(rows).toHaveLength(4);
    for (const [index, [name, value]] of Object.entries(values).entries()) {
      const row = rows[index]!;
      const label = row.querySelector('td')!;
      const control = row.querySelector('.fm-field-control[aria-label]')!;
      expect(control).not.toBeNull();
      if (name !== 'Photo') expect(control.getAttribute('readonly')).not.toBeNull();
      else expect(control.classList.contains('fm-readonly')).toBe(true);
      expect(control.getAttribute('aria-label')).toBe(name);
      expect(control.getAttribute('aria-labelledby')).toBe(label.id);
      expect(name === 'Photo' ? control.textContent : control.value).toBe(value);
      const button = row.querySelector('button')!;
      expect(button.getAttribute('aria-label')).toBe(`Copy ${name}`);
      expect(row.querySelector('.fm-field-label')?.contains(button)).toBe(true);
      expect(row.querySelector('td.fm-field-control')?.contains(button)).toBe(false);
      button.click();
      page.window.eval(`if (window.copied !== ${JSON.stringify(value)}) throw new Error('Copy changed the value');`);
    }
    assertSize(rows[0]!, 240, 34);
    assertSize(rows[1]!, 240, 96);
    assertSize(rows[2]!, 240, 160);
    assertSize(rows[3]!, 240, 96);
    expect(page.document.getElementById('rawJson')?.textContent).toBe(JSON.stringify(payload, null, 2));
    expect(page.document.getElementById('relatedDataContainer')?.textContent).toContain('Related (1)');
    // Same keys can change between short and long text without losing whitespace or Copy behavior.
    page.send({ type: 'recordLoaded', payload: { record: { fieldData: { ...values, Unknown: ' short ' } }, presentationFields: fields } });
    assertSize(page.document.querySelectorAll('#fieldDataContainer tbody tr')[3]!, 240, 34);
    expect(page.document.querySelectorAll('#fieldDataContainer input')[1]!.value).toBe(' short ');
    await Promise.resolve();
    expect(page.document.getElementById('status')?.textContent).toBe('Copied Unknown.');
  });

  it('Viewer and Editor share control borders and padding, with Copy positioned out of field flow', () => {
    for (const surface of ['recordEditor', 'recordViewer'] as const) {
      const page = loadPage(html(surface), read(`extension/src/webviews/${surface}/ui/index.js`));
      page.send({ type: 'recordLoaded', payload: { record: { recordId: '1', fieldData }, fields, presentationFields: fields } });
      page.window.eval(`const sheet = document.createElement('style');
        sheet.textContent = ${JSON.stringify(read(`extension/src/webviews/${surface}/ui/styles.css`))} + window.FieldStandards.standardFieldsCss(true);
        // jsdom does not resolve custom color properties inside border shorthands.
        sheet.textContent = sheet.textContent.replaceAll('var(--border)', '#d0d7de').replaceAll('var(--fm-control-radius)', '4px');
        document.head.appendChild(sheet);
        const control = document.querySelector('${surface === 'recordEditor' ? '#fieldEditor' : '#fieldDataContainer'} textarea');
        const style = getComputedStyle(control);
        if (style.borderTopWidth !== '1px' || style.borderTopStyle !== '${surface === 'recordViewer' ? 'dashed' : 'solid'}' || style.borderRadius !== '4px'
          || style.paddingTop !== '6px' || style.paddingBottom !== '6px' || style.paddingLeft !== '10px'
          || style.boxSizing !== 'border-box') throw new Error('${surface} control box differs from the standard input: ' + JSON.stringify([style.borderTopWidth, style.borderTopStyle, style.borderRadius, style.paddingTop, style.paddingBottom, style.paddingLeft, style.boxSizing]));
        ${surface === 'recordViewer' ? `
        const cell = control.parentElement;
        const copy = cell.parentElement.querySelector('button');
        if (cell.contains(copy) || !cell.parentElement.querySelector('.fm-field-label').contains(copy))
          throw new Error('Copy must be outside the value box');
        if (getComputedStyle(control).paddingRight !== '10px')
          throw new Error('Copy must not take any of the value width');` : ''}
      `);
    }
  });

  it.each(['recordEditor', 'recordViewer', 'queryBuilder'] as const)('%s still renders when the standards script fails to load', (surface) => {
    const pageHtml = html(surface).replace('fieldStandards.js', 'missing.js');
    const source = (surface === 'queryBuilder' ? read('extension/src/webviews/queryBuilder/ui/findForm.js') + '\n' : '')
      + read(`extension/src/webviews/${surface}/ui/index.js`);
    const page = loadPage(pageHtml, source);
    if (surface === 'queryBuilder') {
      page.send({ type: 'init', payload: { profiles, activeProfileId: 'p', savedQueries: [] } });
      page.send({ type: 'layoutsLoaded', payload: { profileId: 'p', layouts: ['Layout'] } });
      page.send({ type: 'fieldNamesLoaded', payload: { profileId: 'p', layout: 'Layout', fieldNames: [' Text '], fieldMetadata: fields } });
      const field = page.document.querySelectorAll('.criterion-field')[0]!;
      field.value = ' Text ';
      page.window.eval("document.querySelector('.criterion-field').dispatchEvent(new Event('input'))");
      expect(page.document.querySelectorAll('.criterion-value')).toHaveLength(1);
      page.document.getElementById('addSortButton')?.click();
      expect(page.document.querySelectorAll('.sort-field')).toHaveLength(1);
    } else {
      page.send({ type: 'recordLoaded', payload: { record: { recordId: '1', fieldData }, fields, presentationFields: fields } });
      // Exercise both building and reusing cells.
      page.send({ type: 'recordLoaded', payload: { record: { recordId: '2', fieldData: { ...fieldData, Number: ' 2 ' } }, fields, presentationFields: fields } });
      const selector = surface === 'recordEditor' ? '#fieldEditor' : '#fieldDataContainer';
      expect(page.document.querySelectorAll(`${selector} tbody tr`)).toHaveLength(fields.length);
      expect(page.document.getElementById('status')?.textContent).toContain('2');
      if (surface === 'recordViewer') {
        expect(page.document.querySelectorAll(`${selector} .table-scroll-wrapper table`)).toHaveLength(1);
        expect(page.document.querySelectorAll(`${selector} .fm-field-table, ${selector} .fm-fields, ${selector} textarea`)).toHaveLength(0);
        const rows = page.document.querySelectorAll(`${selector} tbody tr`);
        rows.forEach((row) => {
          expect(row.querySelectorAll('td')).toHaveLength(3);
          expect(row.querySelectorAll('td:nth-child(2) > span')).toHaveLength(1);
          expect(row.querySelector('td:nth-child(3) > button')?.textContent).toBe('Copy');
        });
        expect(rows[1]?.querySelector('td:nth-child(2) > span')?.textContent).toBe(' 2 ');
      }
    }
  });

  it('Query Builder resizes values when the exact selected field changes, without changing find syntax', () => {
    const pageHtml = html('queryBuilder');
    const page = loadPage(pageHtml, read('extension/src/webviews/queryBuilder/ui/findForm.js') + '\n' + read('extension/src/webviews/queryBuilder/ui/resultModel.js') + '\n' + read('extension/src/webviews/queryBuilder/ui/index.js'));
    page.send({ type: 'init', payload: { profiles, activeProfileId: 'p', savedQueries: [] } });
    page.send({ type: 'layoutsLoaded', payload: { profileId: 'p', layouts: [' Layout '] } });
    page.send({ type: 'fieldNamesLoaded', payload: { profileId: 'p', layout: ' Layout ', fieldNames: fields.map((field) => field.name), fieldMetadata: fields } });
    page.window.eval(`const sheet = document.createElement('style');
      sheet.textContent = ${JSON.stringify(read('extension/src/webviews/queryBuilder/ui/styles.css'))} + window.FieldStandards.standardFieldsCss(true);
      document.head.appendChild(sheet);`);
    page.window.eval(`if (getComputedStyle(document.querySelector('.criterion-value')).flexGrow !== '0') throw new Error('Find controls must not grow vertically inside top-label wrappers');`);
    page.document.getElementById('addSortButton')?.click();
    expect(page.document.querySelectorAll('.sort-editor .fm-fields')).toHaveLength(0);
    expect(page.document.querySelectorAll('.sort-field')).toHaveLength(1);
    const input = page.document.querySelectorAll('.criterion-field')[0]!;
    fields.forEach((field, index) => {
      input.value = field.name;
      page.window.eval("document.querySelector('.criterion-field').dispatchEvent(new Event('input'))");
      const value = page.document.querySelectorAll('.criterion-value')[0]!;
      const wrapper = page.document.querySelectorAll('.criterion-row .fm-field')[2]!;
      // Every find criterion is a single-line text control, so the operator syntax stays typeable.
      assertSize(wrapper, sizes[index]![0]!, 34);
      expect(wrapper.querySelector('.fm-field-label')?.textContent).toBe('Value');
      expect(value.getAttribute('aria-label')).toBe('Value');
    });
  });

  it('Editor and Viewer keep the line breaks of a long text field as FileMaker reports it', () => {
    // The shape FileMaker's layout metadata endpoint returns for a text field.
    const fileMakerTextField = (name: string, maxCharacters: number) => ({
      name, type: 'normal', displayType: 'editText', result: 'text', global: false, autoEnter: false,
      fourDigitYear: false, maxRepeat: 1, maxCharacters, notEmpty: false, numeric: false,
      repetitionStart: 1, repetitionEnd: 1, timeOfDay: false
    });
    const presentation = designerLayoutMetadata(' Layout ', { fieldMetaData: [
      fileMakerTextField('Notes', 0), fileMakerTextField('Empty', 0), fileMakerTextField('Title', 50)
    ] }).fields;
    expect(presentation.map((field) => field.maxLength)).toEqual([0, 0, 50]);
    const value = 'first line\nsecond line';
    for (const surface of ['recordEditor', 'recordViewer'] as const) {
      const page = loadPage(html(surface), read(`extension/src/webviews/${surface}/ui/index.js`));
      page.send({ type: 'recordLoaded', payload: { record: { recordId: '1', fieldData: { Notes: value, Empty: '', Title: 'Short' } },
        fields: presentation, presentationFields: presentation } });
      const container = surface === 'recordEditor' ? '#fieldEditor' : '#fieldDataContainer';
      // Only the long text fields need more than one line, also when they are still empty.
      const areas = page.document.querySelectorAll(`${container} textarea`);
      expect(areas, surface).toHaveLength(2);
      expect(areas[0]?.value, surface).toBe(value);
      expect(areas[1]?.value, surface).toBe('');
      expect(page.document.querySelectorAll(`${container} input`).length, surface).toBe(1);
      expect(page.document.querySelectorAll(`${container} input`)[0]?.value, surface).toBe('Short');
    }
  });

  it('Products mock metadata gives Name a tall text box and Category a menu in Editor and Viewer', () => {
    // Call the real mock engine without opening a socket or a VS Code window.
    const metadata = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { createEngine } from './extension/test/mock-server/lib/engine.mjs';
      const engine = createEngine();
      const base = '/fmi/data/vLatest/databases/Quality';
      const login = await engine.dispatch({ method: 'POST', pathname: base + '/sessions',
        headers: { host: 'localhost', authorization: 'Basic ' + Buffer.from('tester:testpass1').toString('base64') } });
      const result = await engine.dispatch({ method: 'GET', pathname: base + '/layouts/Products',
        headers: { host: 'localhost', authorization: 'Bearer ' + login.json.response.token } });
      if (result.status !== 200) throw new Error('Products metadata unavailable');
      process.stdout.write(JSON.stringify(result.json.response));
    `], { cwd: root, encoding: 'utf8' })) as Record<string, unknown>;
    const presentation = designerLayoutMetadata('Products', metadata).fields;
    expect(presentation.find((field) => field.name === 'Name')?.maxLength).toBe(0);
    const values = { SKU: 'E2E-NEW-1', Name: 'Created from the UI', Category: 'Hardware', Price: '11.5' };
    for (const surface of ['recordEditor', 'recordViewer'] as const) {
      const page = loadPage(html(surface), read(`extension/src/webviews/${surface}/ui/index.js`));
      page.send({ type: 'recordLoaded', payload: { record: { recordId: '1', fieldData: values },
        fields: presentation, presentationFields: presentation } });
      const container = surface === 'recordEditor' ? '#fieldEditor' : '#fieldDataContainer';
      const name = page.document.querySelectorAll(`${container} textarea[aria-label="Name"]`)[0]!;
      expect(name?.value, surface).toBe(values.Name);
      const nameRow = Array.from(page.document.querySelectorAll(`${container} tr`))
        .find((row) => row.querySelector('[aria-label="Name"]'))!;
      assertSize(nameRow, 240, 96);
      const priceRow = Array.from(page.document.querySelectorAll(`${container} tr`))
        .find((row) => row.querySelector('[aria-label="Price"]'))!;
      assertSize(priceRow, 120, 34); // Non-text metadata still gets a single line.
      expect(page.document.querySelectorAll(`${container} select[aria-label="Category"]`)[0]?.value, surface).toBe('Hardware');
      if (surface === 'recordViewer') {
        expect(name.getAttribute('readonly')).not.toBeNull();
        expect(nameRow.querySelector('.fm-field-label')?.contains(nameRow.querySelector('button'))).toBe(true);
      }
    }
  });

  it('Query Builder keeps FileMaker find operators and wildcards exactly as typed', () => {
    for (const [field, value] of [['Text', '=exact'], ['Drop', '>5'], ['Checks', '*empty'], ['Text', '*"a b"'], ['Text', 'a...b']] as const) {
      const page = loadPage(html('queryBuilder'), read('extension/src/webviews/queryBuilder/ui/findForm.js') + '\n' + read('extension/src/webviews/queryBuilder/ui/resultModel.js') + '\n' + read('extension/src/webviews/queryBuilder/ui/index.js'));
      page.send({ type: 'init', payload: { profiles, activeProfileId: 'p', savedQueries: [] } });
      page.send({ type: 'layoutsLoaded', payload: { profileId: 'p', layouts: ['Layout'] } });
      page.send({ type: 'fieldNamesLoaded', payload: { profileId: 'p', layout: 'Layout', fieldNames: ['Text', 'Drop', 'Checks'], fieldMetadata: [
        { name: 'Text', type: 'text' }, { name: 'Drop', type: 'text', displayType: 'dropdown', options: ['Active'] },
        { name: 'Checks', type: 'text', displayType: 'checkbox', options: ['A', 'B'] }
      ] } });
      page.window.eval(`const field = document.querySelector('.criterion-field'); field.value = ${JSON.stringify(field)}; field.dispatchEvent(new Event('input'));`);
      page.window.eval(`const control = document.querySelector('.criterion-value'); control.value = ${JSON.stringify(value)}; control.dispatchEvent(new Event('input'));`);
      expect(page.document.querySelectorAll('.criterion-value')[0]?.tagName, `${field} ${value}`).toBe('INPUT');
      expect(page.document.querySelectorAll('.criterion-value')[0]?.value, `${field} ${value}`).toBe(value);
      page.document.getElementById('runButton')!.click();
      expect(JSON.parse((page.posted.at(-1)?.payload as { findJson: string }).findJson), `${field} ${value}`).toEqual([{ [field]: value }]);
    }
  });

  it('Record Editor keeps the stored checkbox order and appends a new selection', () => {
    const page = loadPage(html('recordEditor'), read('extension/src/webviews/recordEditor/ui/index.js'));
    page.send({ type: 'init', payload: { profiles, activeProfileId: 'p' } });
    page.send({ type: 'layoutsLoaded', payload: { profileId: 'p', layouts: [' Layout '] } });
    page.document.getElementById('recordIdInput')!.value = '1';
    const fields = [{ name: 'Checks', type: 'text', displayType: 'checkbox', options: ['A', 'B', 'C'], kind: 'normal', required: false }];
    page.send({ type: 'recordLoaded', payload: { profileId: 'p', layout: ' Layout ', fields, presentationFields: fields,
      record: { recordId: '1', modId: '9', fieldData: { Checks: 'C\rA' } } } });
    const boxes = page.document.querySelectorAll('#fieldEditor input[type="checkbox"]');
    expect(Array.from(boxes).map((box) => box.value)).toEqual(['A', 'B', 'C']);
    expect(Array.from(boxes).map((box) => box.checked)).toEqual([true, false, true]);
    page.window.eval(`document.querySelectorAll('#fieldEditor input[type="checkbox"]')[1].click();`);
    page.document.getElementById('saveButton')!.click();
    const body = page.posted.at(-1)?.payload as { draftFieldData: Record<string, unknown> };
    // The stored order wins; the new selection is appended with the stored separator.
    expect(body.draftFieldData.Checks).toBe('C\rA\rB');
  });

  it('Record Viewer shows a checkbox set read-only, in the field option order', () => {
    const page = loadPage(html('recordViewer'), read('extension/src/webviews/recordViewer/ui/index.js'));
    const fields = [{ name: 'Checks', type: 'text', displayType: 'checkbox', options: ['A', 'B', 'C'], kind: 'normal', required: false }];
    page.send({ type: 'recordLoaded', payload: { record: { recordId: '1', fieldData: { Checks: 'C\rA' } }, fields, presentationFields: fields } });
    const boxes = page.document.querySelectorAll('#fieldDataContainer input[type="checkbox"]');
    expect(Array.from(boxes).map((box) => box.value)).toEqual(['A', 'B', 'C']);
    expect(Array.from(boxes).map((box) => box.checked)).toEqual([true, false, true]);
    expect(Array.from(boxes).every((box) => box.disabled)).toBe(true);
  });
});

it('the browser build generates bounded CSS from the shared rules, with narrow wrapping and no runtime dependencies', async () => {
  const compiled = buildSync({ entryPoints: [path.join(root, 'shared/src/field-standards.ts')],
    bundle: true, format: 'cjs', platform: 'node', write: false }).outputFiles[0]!.text;
  const exports = { exports: {} as { standardFieldsCss: (webview?: boolean) => string } };
  new Function('module', compiled)(exports);
  const css = exports.exports.standardFieldsCss(true);
  for (const [width, height] of sizes) {
    expect(css).toContain(`[data-fm-width="${width}"] { --fm-field-width: ${width}px; }`);
    expect(css).toContain(`[data-fm-height="${height}"] { --fm-field-height: ${height === 34 ? 'var(--fm-control-height)' : `${height}px`}; }`);
  }
  for (let count = 1; count <= 50; count += 1) {
    const height = Math.max(34, count * 24);
    expect(css).toContain(`[data-fm-height="${height}"] { --fm-field-height: ${height === 34 ? 'var(--fm-control-height)' : `${height}px`}; }`);
  }
  expect(css).toContain('gap: 16px 24px');
  expect(css).toContain('min-height: 24px');
  expect(css).toContain('.fm-field > .fm-field-control { flex: none; }');
  expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*flex-direction: column/);
  expect(css.split('{')).toHaveLength(css.split('}').length);
  expect(css.length).toBeLessThan(18000);
  expect(compiled).not.toMatch(/require\(/);
  const outputDir = mkdtempSync(path.join(tmpdir(), 'filemaker-webviews-'));
  try {
    execFileSync(process.execPath, [path.join(root, 'extension/scripts/copy-webviews.mjs'), outputDir], { cwd: root });
    for (const surface of ['queryBuilder', 'recordEditor', 'recordViewer']) {
      const output = path.join(outputDir, 'webviews', surface, 'ui', 'fieldStandards');
      expect(readFileSync(`${output}.css`, 'utf8')).toBe(css);
      expect(readFileSync(path.join(outputDir, 'webviews', surface, 'ui', 'index.js'), 'utf8')).toBe(read(`extension/src/webviews/${surface}/ui/index.js`));
      const browserBundle = readFileSync(`${output}.js`, 'utf8');
      expect(browserBundle).not.toMatch(/require\(/);
      const api = new Function(`${browserBundle}; return FieldStandards;`)() as { standardFieldSize: (field: { type: string }) => { width: number; height: number } };
      fields.forEach((field, index) => expect(api.standardFieldSize(field)).toEqual({ width: sizes[index]![0], height: sizes[index]![1] }));
    }
    for (const asset of ['index.js', 'index.css']) {
      const designerAsset = path.join(root, 'designer-ui/dist', asset);
      const expected = existsSync(designerAsset) ? designerAsset : path.join(root, 'extension/src/webviews/layoutMode/ui', asset);
      expect(readFileSync(path.join(outputDir, 'webviews/layoutMode/ui', asset), 'utf8')).toBe(readFileSync(expected, 'utf8'));
    }
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
