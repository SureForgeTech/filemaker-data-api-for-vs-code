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
  limit?: string;
  offset?: string;
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

  it('stores and restores a page-size-only edit immediately', () => {
    const view = open();
    const states: Snapshot[] = [];
    const first = loadPage(view.html, view.source, 'https://panel.invalid/', {
      onSetState: (value) => states.push(value as Snapshot)
    });
    first.send({ type: 'init', payload: { profiles: [devProfile], activeProfileId: 'p1' } });
    first.send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Contacts'] } });
    typeText(first.window, 'limitInput', '007');

    expect(states.at(-1)?.limit).toBe('007');

    const reloaded = loadPage(view.html, view.source, 'https://panel.invalid/', { state: states.at(-1) });
    reloaded.send({ type: 'init', payload: { profiles: [devProfile], activeProfileId: 'p1' } });
    reloaded.send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Contacts'] } });
    expect(element(reloaded.window, 'limitInput').value).toBe('007');
  });

  it('restores both paging strings for the same profile and layout', () => {
    const view = open();
    const snapshot: Snapshot = {
      v: 1, profileId: 'p1', layout: 'Contacts', editorMode: 'form',
      model: { requests: [], sort: [] }, findJson: '', sortJson: '',
      limit: '007', offset: '0009', resultView: 'table'
    };
    const page = loadPage(view.html, view.source, 'https://panel.invalid/', { state: snapshot });
    page.send({ type: 'init', payload: { profiles: [devProfile], activeProfileId: 'p1' } });
    page.send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Contacts'] } });
    expect(element(page.window, 'limitInput').value).toBe('007');
    expect(element(page.window, 'offsetInput').value).toBe('0009');
  });

  it('lets host saved-query paging values win over the stored values', () => {
    const view = open();
    const snapshot: Snapshot = {
      v: 1, profileId: 'p1', layout: 'Contacts', editorMode: 'form',
      model: { requests: [], sort: [] }, findJson: '', sortJson: '',
      limit: '007', offset: '0009', resultView: 'table'
    };
    const page = loadPage(view.html, view.source, 'https://panel.invalid/', { state: snapshot });
    page.send({
      type: 'init', payload: {
        profiles: [devProfile], activeProfileId: 'p1',
        defaults: { profileId: 'p1', layout: 'Contacts', savedQuery: { id: 'q1', name: 'Host', layout: 'Contacts', limit: 25, offset: 4 } }
      }
    });
    page.send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Contacts'] } });
    expect(element(page.window, 'limitInput').value).toBe('25');
    expect(element(page.window, 'offsetInput').value).toBe('4');
  });

  it('does not restore paging from a different layout', () => {
    const view = open();
    const snapshot: Snapshot = {
      v: 1, profileId: 'p1', layout: 'Orders', editorMode: 'form',
      model: { requests: [], sort: [] }, findJson: '', sortJson: '',
      limit: '007', offset: '0009', resultView: 'table'
    };
    const page = loadPage(view.html, view.source, 'https://panel.invalid/', { state: snapshot });
    page.send({
      type: 'init', payload: { profiles: [devProfile], activeProfileId: 'p1', defaults: { profileId: 'p1', layout: 'Contacts' } }
    });
    page.send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Orders', 'Contacts'] } });
    expect(element(page.window, 'layoutSelect').value).toBe('Contacts');
    expect(element(page.window, 'limitInput').value).toBe('');
    expect(element(page.window, 'offsetInput').value).toBe('');
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

  it('does not restore the stored criteria when the host opens a different profile or layout', () => {
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

    // A stored profile that is gone falls back to the active one, and the criteria are not restored either.
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

  it('clears the restored criteria when the snapshot layout is gone from the profile', () => {
    const view = open();
    const states: Snapshot[] = [];
    const snapshot: Snapshot = {
      v: 1, profileId: 'p1', layout: 'Invoices', editorMode: 'json',
      model: {
        requests: [{ omit: false, criteria: [{ field: 'Customer', operator: 'equals', value: 'Acme', value2: '' }] }],
        sort: [{ fieldName: 'Total', sortOrder: 'descend' }]
      },
      findJson: '[{"Customer":"Acme"}]', sortJson: '', resultView: 'table'
    };
    const page = loadPage(view.html, view.source, 'https://panel.invalid/', {
      state: snapshot, onSetState: (value) => states.push(value as Snapshot)
    });
    page.send({ type: 'init', payload: { profiles: [devProfile, prodProfile], activeProfileId: 'p1' } });
    // The snapshot's layout was renamed in FileMaker and no longer exists.
    page.send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Billing', 'Contacts'] } });

    // The panel lands on the first real layout…
    expect(page.document.getElementById('layoutSelect')!.value).toBe('Billing');
    // …and the criteria and sort rows written for the gone layout are cleared, not shown against it.
    expect(page.document.querySelectorAll('.criterion-field')[0]!.value).toBe('');
    expect(page.document.querySelectorAll('.sort-field')).toHaveLength(0);
    // The stale query text is gone from the JSON editor too.
    expect(page.document.getElementById('findJson')!.value).not.toContain('Acme');
    // The snapshot stored for the next reload now matches the screen: real layout, empty model.
    const stored = states.at(-1)!;
    expect(stored.profileId).toBe('p1');
    expect(stored.layout).toBe('Billing');
    expect(JSON.stringify(stored.model)).not.toContain('Acme');
  });

  it('stores a profile switch only after the new layouts arrive', () => {
    const view = open();
    const states: Snapshot[] = [];
    const snapshot: Snapshot = {
      v: 1, profileId: 'p1', layout: 'Contacts', editorMode: 'form',
      model: {
        requests: [{ omit: false, criteria: [{ field: 'Name', operator: 'equals', value: 'Ada', value2: '' }] }],
        sort: []
      },
      findJson: '', sortJson: '', resultView: 'table'
    };
    const page = loadPage(view.html, view.source, 'https://panel.invalid/', {
      state: snapshot, onSetState: (value) => states.push(value as Snapshot)
    });
    page.send({ type: 'init', payload: { profiles: [devProfile, prodProfile], activeProfileId: 'p1' } });
    page.send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Contacts', 'Orders'] } });
    // The reload landed on the snapshot's own layout: the criteria are anchored and stored as they are.
    expect(states.at(-1)!.layout).toBe('Contacts');

    const written = states.length;
    choose(page.window, 'profileSelect', 'p2');
    // The new profile's layouts have not arrived: nothing is stored, so no snapshot ever
    // pairs the new profile with the old profile's layout.
    expect(states.length).toBe(written);
    expect(states.some((s) => s.profileId === 'p2')).toBe(false);

    page.send({ type: 'layoutsLoaded', payload: { profileId: 'p2', layouts: ['Invoices'] } });
    const after = states.at(-1)!;
    expect(after.profileId).toBe('p2');
    expect(after.layout).toBe('Invoices');
    expect(states.some((s) => s.profileId === 'p2' && s.layout === 'Contacts')).toBe(false);
    // An explicit profile switch keeps today's behavior: the criteria stay on screen.
    expect(page.document.querySelectorAll('.criterion-field')[0]!.value).toBe('Name');

    // Switching back to an already-loaded profile stores one consistent snapshot right away.
    const back = states.length;
    choose(page.window, 'profileSelect', 'p1');
    expect(states.length).toBe(back + 1);
    const home = states.at(-1)!;
    expect(home.profileId).toBe('p1');
    expect(home.layout).toBe('Contacts');
    expect(page.document.querySelectorAll('.criterion-field')[0]!.value).toBe('Name');
  });

  it('keeps a loaded saved query when its layout list arrives after the load', () => {
    const view = open();
    const states: Snapshot[] = [];
    const snapshot: Snapshot = {
      v: 1, profileId: 'p1', layout: 'Contacts', editorMode: 'form',
      model: {
        requests: [{ omit: false, criteria: [{ field: 'Name', operator: 'equals', value: 'Ada', value2: '' }] }],
        sort: []
      },
      findJson: '', sortJson: '', resultView: 'table'
    };
    const page = loadPage(view.html, view.source, 'https://panel.invalid/', {
      state: snapshot, onSetState: (value) => states.push(value as Snapshot)
    });
    page.send({
      type: 'init',
      payload: {
        profiles: [devProfile, prodProfile], activeProfileId: 'p1',
        savedQueries: [{
          id: 'sq1', name: 'Acme', profileId: 'p1', layout: 'Orders',
          // A saved query carries its find as an array of requests, the way the store keeps it.
          findJson: [{ Company: 'Acme' }], sortJson: '', limit: 100, offset: 0
        }]
      }
    });
    // The user loads the saved query before this profile's layouts have arrived.
    choose(page.window, 'savedQueriesSelect', 'sq1');
    page.document.getElementById('loadSavedButton')!.click();
    page.send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Contacts', 'Orders'] } });

    // The loaded query stays on screen: the arriving layouts select its layout, not clear it.
    expect(page.document.getElementById('layoutSelect')!.value).toBe('Orders');
    expect(page.document.getElementById('findJson')!.value).toBe(JSON.stringify([{ Company: 'Acme' }], null, 2));
    expect(page.document.querySelectorAll('.criterion-field')[0]!.value).toBe('Company');
    expect(page.document.querySelectorAll('.criterion-value')[0]!.value).toBe('Acme');
  });

  it('stores nothing typed while a profile switch is still loading its layouts', () => {
    const view = open();
    const states: Snapshot[] = [];
    const page = loadPage(view.html, view.source, 'https://panel.invalid/', {
      onSetState: (value) => states.push(value as Snapshot)
    });
    page.send({ type: 'init', payload: { profiles: [devProfile, prodProfile], activeProfileId: 'p1' } });
    page.send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Contacts', 'Orders'] } });

    const written = states.length;
    choose(page.window, 'profileSelect', 'p2');
    typeText(page.window, 'findJson', '[{"Name":"*"}]');
    // The new profile's layouts are still in flight: the typed text sits on screen, but
    // nothing is stored, so no snapshot ever pairs it with a layout list that is not there.
    expect(states.length).toBe(written);

    page.send({ type: 'layoutsLoaded', payload: { profileId: 'p2', layouts: ['Invoices'] } });
    expect(states.length).toBe(written + 1);
    const settled = states.at(-1)!;
    expect(settled.profileId).toBe('p2');
    expect(settled.layout).toBe('Invoices');
    expect(settled.findJson).toBe('[{"Name":"*"}]');
  });

  it('stores the cleared form when a profile has no layouts at all', () => {
    const view = open();
    const states: Snapshot[] = [];
    const snapshot: Snapshot = {
      v: 1, profileId: 'p1', layout: 'Contacts', editorMode: 'form',
      model: {
        requests: [{ omit: false, criteria: [{ field: 'Name', operator: 'equals', value: 'Ada', value2: '' }] }],
        sort: []
      },
      findJson: '', sortJson: '', resultView: 'table'
    };
    const page = loadPage(view.html, view.source, 'https://panel.invalid/', {
      state: snapshot, onSetState: (value) => states.push(value as Snapshot)
    });
    page.send({ type: 'init', payload: { profiles: [devProfile, prodProfile], activeProfileId: 'p1' } });
    const written = states.length;
    // The profile has no layouts at all: the restored criteria lose their field list and are cleared.
    page.send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: [] } });

    expect(page.document.querySelectorAll('.criterion-field')[0]!.value).toBe('');
    // The cleared form is stored too, so the next reload cannot bring the stale criteria back.
    expect(states.length).toBe(written + 1);
    expect(JSON.stringify(states.at(-1)!.model)).not.toContain('Name');
  });

  it('skips the criteria of a snapshot that has no layout at all', () => {
    const view = open();
    const snapshot: Snapshot = {
      v: 1, profileId: 'p1', layout: '', editorMode: 'form',
      model: {
        requests: [{ omit: false, criteria: [{ field: 'Name', operator: 'equals', value: 'Ada', value2: '' }] }],
        sort: []
      },
      findJson: '', sortJson: '', resultView: 'table'
    };
    const page = loadPage(view.html, view.source, 'https://panel.invalid/', { state: snapshot });
    page.send({ type: 'init', payload: { profiles: [devProfile, prodProfile], activeProfileId: 'p1' } });

    // Without a stored layout the criteria have no field list to verify against: they are
    // left out entirely instead of being shown now and cleared when the layouts arrive.
    expect(page.document.querySelectorAll('.criterion-field')[0]!.value).toBe('');

    page.send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Contacts'] } });
    expect(page.document.querySelectorAll('.criterion-field')[0]!.value).toBe('');
    expect(page.document.querySelectorAll('.sort-field')).toHaveLength(0);
  });

  it('persists an edit typed into a criterion row', () => {
    const view = open();
    const states: Snapshot[] = [];
    const page = loadPage(view.html, view.source, 'https://panel.invalid/', {
      onSetState: (value) => states.push(value as Snapshot)
    });
    page.send({ type: 'init', payload: { profiles: [devProfile, prodProfile], activeProfileId: 'p1' } });
    page.send({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Contacts', 'Orders'] } });

    const written = states.length;
    // A real keystroke bubbles up to the editor's delegated listener, so the typed field
    // name reaches the stored snapshot — the same window.eval pattern the saved-query
    // regression uses, because a bare non-bubbling 'input' event would miss that listener.
    page.window.eval(`
      const field = document.querySelector('.criterion-field');
      field.value = 'Name';
      field.dispatchEvent(new Event('input', { bubbles: true }));
    `);

    expect(states.length).toBe(written + 1);
    expect(JSON.stringify(states.at(-1)!.model)).toContain('Name');
  });
});
