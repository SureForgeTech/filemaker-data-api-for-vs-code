import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { QueryBuilderPanel } from '../../../src/webviews/queryBuilder';
import { JSDOM, loadPage, type JsdomWindow } from '../../helpers/jsdomPage';
import { InMemoryMemento } from '../mocks';

const devProfile = { id: 'p1', name: 'Dev', database: 'Sales', authMode: 'direct', serverUrl: 'https://fm.example.com' };
const prodProfile = { id: 'p2', name: 'Prod', database: 'Sales', authMode: 'direct', serverUrl: 'https://fm2.example.com' };

interface Snapshot {
  v: number;
  profileId: string;
  layout: string;
  editorMode: string;
  model: { requests: unknown[]; sort: unknown[] };
  findJson: string;
  sortJson: string;
  resultView: string;
}

/** The panel's own HTML and page script, as VS Code hands them to the webview. */
function open() {
  const panel = {
    webview: {
      html: '', cspSource: 'x', asWebviewUri: (uri: unknown) => uri, postMessage: vi.fn(async () => true),
      onDidReceiveMessage: () => ({ dispose: vi.fn() })
    },
    onDidDispose: vi.fn(), reveal: vi.fn()
  };
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(panel as never);
  const context = { extensionUri: { fsPath: '/ext' }, workspaceState: new InMemoryMemento() } as never;
  const store = { listProfiles: async () => [devProfile], getProfile: async () => devProfile, getActiveProfileId: () => 'p1' } as never;
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never;
  const saved = { listSavedQueries: async () => [] } as never;
  (QueryBuilderPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  QueryBuilderPanel.createOrShow(context, store, saved, {} as never, logger);
  const source = [
    readFileSync(path.resolve(__dirname, '../../../src/webviews/queryBuilder/ui/cellText.js'), 'utf8'),
    readFileSync(path.resolve(__dirname, '../../../src/webviews/queryBuilder/ui/findForm.js'), 'utf8'),
    readFileSync(path.resolve(__dirname, '../../../src/webviews/queryBuilder/ui/index.js'), 'utf8')
  ].join('\n');
  return { html: panel.webview.html, source };
}

function element(window: JsdomWindow, id: string) {
  const found = window.document.getElementById(id) as unknown as {
    value: string;
    dispatchEvent(event: unknown): void;
  } | null;
  if (!found) {
    throw new Error(`The page has no #${id}.`);
  }
  return found;
}

/** Picks another option in a select, the way a user does. */
function choose(window: JsdomWindow, id: string, value: string): void {
  const select = element(window, id);
  select.value = value;
  select.dispatchEvent(new window.Event('change'));
}

/** Types into a text box, the way a user does. */
function typeText(window: JsdomWindow, id: string, value: string): void {
  const input = element(window, id);
  input.value = value;
  input.dispatchEvent(new window.Event('input'));
}

beforeEach(() => {
  vi.clearAllMocks();
  (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
});

describe.skipIf(!JSDOM)('Query Builder panel state', () => {
  it('stores the chosen profile, layout and editor tab', () => {
    const view = open();
    const states: Snapshot[] = [];
    const page = loadPage(view.html, view.source, 'https://panel.invalid/', {
      onSetState: (value) => states.push(value as Snapshot)
    });
    page.send({ type: 'init', payload: { profiles: [devProfile, prodProfile], activeProfileId: 'p1' } });
    page.send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Contacts', 'Orders'] } });

    choose(page.window, 'profileSelect', 'p2');
    page.send({ type: 'layoutsLoaded', payload: { profileId: 'p2', layouts: ['Invoices'] } });
    choose(page.window, 'layoutSelect', 'Invoices');
    page.document.getElementById('jsonTab')!.click();
    typeText(page.window, 'findJson', '[{"Name":"*"}]');

    const snapshot = states.at(-1)!;
    expect(snapshot.v).toBe(1);
    expect(snapshot.profileId).toBe('p2');
    expect(snapshot.layout).toBe('Invoices');
    expect(snapshot.editorMode).toBe('json');
    expect(snapshot.findJson).toBe('[{"Name":"*"}]');
  });

  it('brings the profile, layout, editor tab and find request back after a reload', () => {
    const view = open();
    const states: Snapshot[] = [];
    const first = loadPage(view.html, view.source, 'https://panel.invalid/', {
      onSetState: (value) => states.push(value as Snapshot)
    });
    first.send({ type: 'init', payload: { profiles: [devProfile, prodProfile], activeProfileId: 'p1' } });
    first.send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Contacts', 'Orders'] } });
    choose(first.window, 'profileSelect', 'p2');
    first.send({ type: 'layoutsLoaded', payload: { profileId: 'p2', layouts: ['Invoices'] } });
    first.document.getElementById('jsonTab')!.click();
    typeText(first.window, 'findJson', '[{"Name":"*"}]');
    const snapshot = states.at(-1)!;

    const reloaded = loadPage(view.html, view.source, 'https://panel.invalid/', { state: snapshot });
    reloaded.send({ type: 'init', payload: { profiles: [devProfile, prodProfile], activeProfileId: 'p1' } });
    reloaded.send({ type: 'layoutsLoaded', payload: { profileId: 'p2', layouts: ['Contacts', 'Invoices'] } });

    expect(reloaded.document.getElementById('profileSelect')!.value).toBe('p2');
    expect(reloaded.document.getElementById('layoutSelect')!.value).toBe('Invoices');
    expect(reloaded.document.getElementById('jsonTab')!.getAttribute('aria-selected')).toBe('true');
    expect(reloaded.document.getElementById('formTab')!.getAttribute('aria-selected')).toBe('false');
    expect(reloaded.document.getElementById('findJson')!.value).toBe('[{"Name":"*"}]');
  });

  it('lets the profile and layout the host asks for win over the stored ones', () => {
    const view = open();
    const snapshot: Snapshot = {
      v: 1, profileId: 'p2', layout: 'Invoices', editorMode: 'json',
      model: { requests: [], sort: [] }, findJson: '[{"Name":"*"}]', sortJson: '', resultView: 'table'
    };
    const page = loadPage(view.html, view.source, 'https://panel.invalid/', { state: snapshot });
    page.send({
      type: 'init',
      payload: { profiles: [devProfile, prodProfile], activeProfileId: 'p1', defaults: { profileId: 'p1', layout: 'Contacts' } }
    });
    page.send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Contacts', 'Orders'] } });

    expect(page.document.getElementById('profileSelect')!.value).toBe('p1');
    expect(page.document.getElementById('layoutSelect')!.value).toBe('Contacts');
  });

  it('falls back to the active profile when the stored one is gone', () => {
    const view = open();
    const snapshot: Snapshot = {
      v: 1, profileId: 'gone', layout: 'Ghost', editorMode: 'form',
      model: { requests: [], sort: [] }, findJson: '', sortJson: '', resultView: 'table'
    };
    const page = loadPage(view.html, view.source, 'https://panel.invalid/', { state: snapshot });
    page.send({ type: 'init', payload: { profiles: [devProfile, prodProfile], activeProfileId: 'p2' } });
    page.send({ type: 'layoutsLoaded', payload: { profileId: 'p2', layouts: ['Invoices'] } });

    expect(page.document.getElementById('profileSelect')!.value).toBe('p2');
    expect(page.document.getElementById('layoutSelect')!.value).toBe('Invoices');
  });

  it('restores form criteria and sort rows from a snapshot', () => {
    const view = open();
    const snapshot: Snapshot = {
      v: 1, profileId: 'p1', layout: 'Contacts', editorMode: 'form',
      model: {
        requests: [{ omit: false, criteria: [{ field: 'Name', operator: 'equals', value: 'Ada', value2: '' }] }],
        sort: [{ fieldName: 'Total', sortOrder: 'descend' }]
      },
      findJson: '', sortJson: '', resultView: 'table'
    };
    const page = loadPage(view.html, view.source, 'https://panel.invalid/', { state: snapshot });
    page.send({ type: 'init', payload: { profiles: [devProfile, prodProfile], activeProfileId: 'p1' } });
    page.send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Contacts', 'Orders'] } });

    // The criteria come back as rows the user can edit, not only as text behind the form.
    const fields = page.document.querySelectorAll('.criterion-field');
    expect(fields).toHaveLength(1);
    expect(fields[0]!.value).toBe('Name');
    expect(page.document.querySelectorAll('.criterion-operator')[0]!.value).toBe('equals');
    expect(page.document.querySelectorAll('.criterion-value')[0]!.value).toBe('Ada');

    // The sort row comes back too.
    const sortFields = page.document.querySelectorAll('.sort-field');
    expect(sortFields).toHaveLength(1);
    expect(sortFields[0]!.value).toBe('Total');
    expect(page.document.querySelectorAll('#sortList select')[0]!.value).toBe('descend');

    // And the panel is in the editor the user left it in.
    expect(page.document.getElementById('formTab')!.getAttribute('aria-selected')).toBe('true');
  });

  it('ignores a snapshot with the wrong version or a malformed model', () => {
    const view = open();

    // A snapshot from another version of the panel is not read at all.
    const outdated = loadPage(view.html, view.source, 'https://panel.invalid/', {
      state: {
        v: 2, profileId: 'p2', layout: 'Invoices', editorMode: 'json',
        model: { requests: [], sort: [] }, findJson: '[{"Name":"*"}]', sortJson: '', resultView: 'table'
      }
    });
    outdated.send({ type: 'init', payload: { profiles: [devProfile, prodProfile], activeProfileId: 'p1' } });
    outdated.send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Contacts', 'Orders'] } });

    expect(outdated.document.getElementById('profileSelect')!.value).toBe('p1');
    expect(outdated.document.getElementById('findJson')!.value).toBe('[{}]');
    expect(outdated.document.querySelectorAll('.criterion-field')[0]!.value).toBe('');

    // A snapshot whose model is damaged leaves the empty form, and the panel still works.
    const damaged = loadPage(view.html, view.source, 'https://panel.invalid/', {
      state: {
        v: 1, profileId: 'p1', layout: 'Contacts', editorMode: 'form',
        model: 'nope', findJson: '', sortJson: '', resultView: 'table'
      }
    });
    damaged.send({ type: 'init', payload: { profiles: [devProfile, prodProfile], activeProfileId: 'p1' } });
    damaged.send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Contacts', 'Orders'] } });

    expect(damaged.document.getElementById('profileSelect')!.value).toBe('p1');
    expect(damaged.document.querySelectorAll('.criterion-field')[0]!.value).toBe('');
    expect(damaged.document.querySelectorAll('.sort-field')).toHaveLength(0);
    expect(damaged.document.getElementById('status')!.textContent ?? '').toContain('Ready');
  });

  it('drops the stored criteria when the host opens a different profile or layout', () => {
    const view = open();
    const snapshot: Snapshot = {
      v: 1, profileId: 'p2', layout: 'Invoices', editorMode: 'json',
      model: {
        requests: [{ omit: false, criteria: [{ field: 'Name', operator: 'match', value: 'Ada', value2: '' }] }],
        sort: [{ fieldName: 'Total', sortOrder: 'descend' }]
      },
      findJson: '[{"Name":"*"}]', sortJson: '', resultView: 'table'
    };

    // The host opens another profile and layout: the stored criteria belong to another field list.
    const other = loadPage(view.html, view.source, 'https://panel.invalid/', { state: snapshot });
    other.send({
      type: 'init',
      payload: { profiles: [devProfile, prodProfile], activeProfileId: 'p1', defaults: { profileId: 'p1', layout: 'Contacts' } }
    });
    other.send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Contacts', 'Orders'] } });

    expect(other.document.getElementById('profileSelect')!.value).toBe('p1');
    expect(other.document.getElementById('layoutSelect')!.value).toBe('Contacts');
    // The stored criteria are not applied: the find text and the form stay as they were.
    expect(other.document.getElementById('findJson')!.value).toBe('[{}]');
    expect(other.document.querySelectorAll('.criterion-field')[0]!.value).toBe('');
    expect(other.document.querySelectorAll('.sort-field')).toHaveLength(0);

    // A stored profile that is gone falls back to the active one, and drops the criteria too.
    const missing = loadPage(view.html, view.source, 'https://panel.invalid/', {
      state: { ...snapshot, profileId: 'gone', layout: 'Ghost' }
    });
    missing.send({ type: 'init', payload: { profiles: [devProfile, prodProfile], activeProfileId: 'p2' } });
    missing.send({ type: 'layoutsLoaded', payload: { profileId: 'p2', layouts: ['Invoices'] } });

    expect(missing.document.getElementById('profileSelect')!.value).toBe('p2');
    expect(missing.document.getElementById('layoutSelect')!.value).toBe('Invoices');
    expect(missing.document.getElementById('findJson')!.value).toBe('[{}]');
    expect(missing.document.querySelectorAll('.criterion-field')[0]!.value).toBe('');
    expect(missing.document.querySelectorAll('.sort-field')).toHaveLength(0);
  });
});
