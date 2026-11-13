import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { registerSavedQueriesCommands } from '../../../src/commands/savedQueries';
import { SavedQueriesStore } from '../../../src/services/savedQueriesStore';
import type { SavedQuery } from '../../../src/types/fm';
import { QueryBuilderPanel } from '../../../src/webviews/queryBuilder';
import { InMemoryMemento } from '../mocks';
import { command, expectSafeError, layout, logger, profile, profileStore, resetCommandMocks, serviceError } from '../../helpers/commandHarness';

vi.mock('../../../src/webviews/queryBuilder', () => ({
  QueryBuilderPanel: { requestSaveCurrentQuery: vi.fn(), createOrShow: vi.fn() }
}));

const query: SavedQuery = {
  id: 'q1', name: ' Query with spaces ', profileId: profile.id, layout,
  findJson: [{ ' Field ': '==value' }], sortJson: [{ fieldName: ' Field ', sortOrder: 'ascend' }],
  limit: 25, offset: 3, createdAt: '2026-10-01', updatedAt: '2026-10-02'
};

function setup() {
  const store = {
    getSavedQuery: vi.fn().mockResolvedValue(query),
    listSavedQueries: vi.fn().mockResolvedValue([query]),
    touchLastRun: vi.fn(), removeSavedQuery: vi.fn(), saveSavedQuery: vi.fn(),
    exportSavedQueries: vi.fn().mockResolvedValue({ schemaVersion: 1, queries: [query] }),
    importSavedQueries: vi.fn().mockResolvedValue({ imported: 1, updated: 2, skipped: 3 })
  };
  const profiles = profileStore();
  const client = { findRecords: vi.fn().mockResolvedValue({ data: [{ recordId: '7' }] }) };
  const refreshExplorer = vi.fn();
  const context = {} as vscode.ExtensionContext;
  const log = logger();
  registerSavedQueriesCommands({ context, profileStore: profiles as never, savedQueriesStore: store as never,
    fmClient: client as never, logger: log as never, refreshExplorer });
  return { store, profiles, client, refreshExplorer, context, log };
}

async function manage(action: string): Promise<void> {
  vi.mocked(vscode.window.showQuickPick)
    .mockResolvedValueOnce({ query } as never)
    .mockResolvedValueOnce({ value: action } as never);
  await command('manageSavedQueries')();
}

describe('saved query commands', () => {
  beforeEach(resetCommandMocks);

  it.each([true, false])('requests saving from Query Builder (panel open=%s)', async (posted) => {
    setup();
    vi.mocked(QueryBuilderPanel.requestSaveCurrentQuery).mockReturnValue(posted);
    await command('saveCurrentQuery')();
    expect(QueryBuilderPanel.requestSaveCurrentQuery).toHaveBeenCalledOnce();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(posted ? 0 : 1);
  });

  it('runs the saved request with exact layout, field and query names and marks it run', async () => {
    const { client, store } = setup();
    await command('runSavedQuery')({ savedQueryId: query.id });
    expect(store.getSavedQuery).toHaveBeenCalledWith(query.id);
    expect(client.findRecords).toHaveBeenCalledWith(profile, layout, {
      query: query.findJson, sort: query.sortJson, limit: 25, offset: 3
    });
    expect(store.touchLastRun).toHaveBeenCalledWith(query.id);
    expect(client.findRecords.mock.invocationCallOrder[0]!).toBeLessThan(store.touchLastRun.mock.invocationCallOrder[0]!);
    const document = vi.mocked(vscode.workspace.openTextDocument).mock.calls[0]![0] as { content: string };
    expect(JSON.parse(document.content)).toEqual({
      savedQuery: { id: query.id, name: query.name }, profile: profile.name, layout,
      request: { query: query.findJson, sort: query.sortJson, limit: 25, offset: 3 }, result: { data: [{ recordId: '7' }] }
    });
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith({}, { preview: false });
  });

  it('does not run when the profile was deleted', async () => {
    const { profiles, client, store } = setup();
    profiles.getProfile.mockResolvedValue(undefined);
    await command('runSavedQuery')({ queryId: query.id });
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('The saved query profile no longer exists.');
    expect(client.findRecords).not.toHaveBeenCalled();
    expect(store.touchLastRun).not.toHaveBeenCalled();
  });

  it('reports a failed find safely without marking the query run or opening results', async () => {
    const { client, store } = setup();
    client.findRecords.mockRejectedValue(serviceError());
    await expect(command('runSavedQuery')({ queryId: query.id })).resolves.toBeUndefined();
    expectSafeError();
    expect(store.touchLastRun).not.toHaveBeenCalled();
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('reports a failure to persist the last-run time safely', async () => {
    const { store } = setup();
    store.touchLastRun.mockRejectedValue(serviceError());
    await command('runSavedQuery')({ queryId: query.id });
    expectSafeError();
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('opens the exact query in Query Builder', async () => {
    const { profiles, store, client, context, log } = setup();
    await command('openSavedQuery')({ queryId: query.id });
    expect(QueryBuilderPanel.createOrShow).toHaveBeenCalledWith(context, profiles, store, client, log,
      { profileId: profile.id, layout, savedQuery: query });
  });

  it.each(['runSavedQuery', 'openSavedQuery', 'deleteSavedQuery', 'manageSavedQueries'])(
    '%s stops when the query picker is cancelled', async (name) => {
      const { client, store, refreshExplorer } = setup();
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);
      await command(name)({ profileId: profile.id });
      expect(store.listSavedQueries).toHaveBeenCalledWith({ profileId: name === 'manageSavedQueries' ? undefined : profile.id });
      expect(client.findRecords).not.toHaveBeenCalled();
      expect(QueryBuilderPanel.createOrShow).not.toHaveBeenCalled();
      expect(store.removeSavedQuery).not.toHaveBeenCalled();
      expect(refreshExplorer).not.toHaveBeenCalled();
    }
  );

  it('reports missing queries and empty query lists', async () => {
    const { store } = setup();
    store.getSavedQuery.mockResolvedValue(undefined);
    await command('openSavedQuery')({ queryId: 'missing' });
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Saved query missing not found.');
    store.listSavedQueries.mockResolvedValue([]);
    await command('runSavedQuery')();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('No saved queries found.');
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it('shows exact names and last-run status in the query picker', async () => {
    const { store } = setup();
    store.listSavedQueries.mockResolvedValue([query, { ...query, id: 'q2', lastRunAt: '2026-10-20' }]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({ query } as never);
    await command('openSavedQuery')();
    expect(vscode.window.showQuickPick).toHaveBeenCalledWith([
      { label: query.name, detail: `${layout} • ${profile.id}`, description: 'Never run', query },
      { label: query.name, detail: `${layout} • ${profile.id}`, description: 'Last run 2026-10-20', query: { ...query, id: 'q2', lastRunAt: '2026-10-20' } }
    ], { title: 'Select Saved Query' });
  });

  it.each([undefined, 'Cancel', 'Delete'])('requires explicit modal Delete confirmation (%s)', async (choice) => {
    const { store, refreshExplorer } = setup();
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(choice as never);
    await command('deleteSavedQuery')({ queryId: query.id });
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(`Delete saved query "${query.name}"?`, { modal: true }, 'Delete');
    if (choice === 'Delete') {
      expect(store.removeSavedQuery).toHaveBeenCalledWith(query.id);
      expect(refreshExplorer).toHaveBeenCalledOnce();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(`Deleted saved query "${query.name}".`);
    } else {
      expect(store.removeSavedQuery).not.toHaveBeenCalled();
      expect(refreshExplorer).not.toHaveBeenCalled();
    }
  });

  it('does nothing if the management action is cancelled', async () => {
    const { store, refreshExplorer } = setup();
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({ query } as never).mockResolvedValueOnce(undefined);
    await command('manageSavedQueries')();
    expect(store.removeSavedQuery).not.toHaveBeenCalled();
    expect(store.saveSavedQuery).not.toHaveBeenCalled();
    expect(refreshExplorer).not.toHaveBeenCalled();
  });

  it.each(['run', 'open'])('dispatches the management %s action', async (action) => {
    const { client } = setup();
    await manage(action);
    if (action === 'run') expect(client.findRecords).toHaveBeenCalledWith(profile, layout, expect.any(Object));
    else expect(QueryBuilderPanel.createOrShow).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), { profileId: profile.id, layout, savedQuery: query });
  });

  it('edits the find and sort while preserving exact field and layout names', async () => {
    const { store, refreshExplorer } = setup();
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('Renamed query')
      .mockResolvedValueOnce('[{" Field ":"==new"}]')
      .mockResolvedValueOnce('[{"fieldName":" Field ","sortOrder":"descend"}]');
    await manage('edit');
    expect(store.saveSavedQuery).toHaveBeenCalledWith({ ...query, name: 'Renamed query',
      findJson: [{ ' Field ': '==new' }], sortJson: [{ fieldName: ' Field ', sortOrder: 'descend' }] });
    expect(refreshExplorer).toHaveBeenCalledOnce();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Updated saved query "Renamed query".');
  });

  it.each([{ inputs: [] }, { inputs: ['Name'] }])('does not save when an edit input is cancelled (%j)', async ({ inputs }) => {
    const { store } = setup();
    for (const input of inputs) vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(input);
    await manage('edit');
    expect(store.saveSavedQuery).not.toHaveBeenCalled();
  });

  it.each([['not-json', ''], ['{}', ''], ['[{"Name":"*"}]', 'not-json']])('rejects invalid edited find/sort JSON (%s, %s)', async (find, sort) => {
    const { store } = setup();
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('Name').mockResolvedValueOnce(find).mockResolvedValueOnce(sort);
    await manage('edit');
    expect(store.saveSavedQuery).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledOnce();
  });

  it('exports one query with its exact stored name and request', async () => {
    setup();
    const uri = vscode.Uri.file(join('/tmp', 'query.json'));
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(uri);
    await manage('export');
    const [writtenUri, bytes] = vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0]!;
    expect(writtenUri).toBe(uri);
    expect(JSON.parse(Buffer.from(bytes).toString())).toEqual({ schemaVersion: 1, queries: [query] });
    expect(vscode.window.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultUri: expect.objectContaining({ fsPath: 'query-with-spaces.json' }) }));
  });

  it.each([['CON', '_con'], ['..', 'export']])('uses a safe export name for saved query %j', async (name, safe) => {
    setup();
    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({ query: { ...query, name } } as never)
      .mockResolvedValueOnce({ value: 'export' } as never);
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(vscode.Uri.file(join('/tmp', 'query.json')));
    await command('manageSavedQueries')();
    expect(vscode.window.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({
      defaultUri: expect.objectContaining({ fsPath: `${safe}.json` })
    }));
    const bytes = vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0]![1];
    expect(JSON.parse(Buffer.from(bytes).toString()).queries[0].name).toBe(name);
  });

  it.each(['exportSavedQueries', 'single'])('writes nothing when %s save dialog is cancelled', async (name) => {
    setup();
    if (name === 'single') await manage('export');
    else await command(name)();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('exports all saved queries as JSON', async () => {
    const { store } = setup();
    const uri = vscode.Uri.file(join('/tmp', 'all.json'));
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(uri);
    await command('exportSavedQueries')();
    expect(store.exportSavedQueries).toHaveBeenCalledOnce();
    const [destination, bytes] = vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0]!;
    expect(destination).toBe(uri);
    expect(JSON.parse(Buffer.from(bytes).toString())).toEqual({ schemaVersion: 1, queries: [query] });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Exported 1 saved queries.');
  });

  it('imports the selected bytes and reports every count', async () => {
    const { store, refreshExplorer } = setup();
    const uri = vscode.Uri.file(join('/tmp', 'import.json'));
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([uri]);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from(' exact file text '));
    await command('importSavedQueries')();
    expect(vscode.workspace.fs.readFile).toHaveBeenCalledWith(uri);
    expect(store.importSavedQueries).toHaveBeenCalledWith(' exact file text ');
    expect(refreshExplorer).toHaveBeenCalledOnce();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Imported saved queries: 1 added, 2 updated, 3 skipped.');
  });

  it('does not read or import when the open dialog is cancelled', async () => {
    const { store, refreshExplorer } = setup();
    await command('importSavedQueries')();
    expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
    expect(store.importSavedQueries).not.toHaveBeenCalled();
    expect(refreshExplorer).not.toHaveBeenCalled();
  });

  it('trims saved-query labels on create, save and edit through the store', async () => {
    const { store } = setup();
    const persistedStore = new SavedQueriesStore(new InMemoryMemento() as never, new InMemoryMemento() as never);
    expect(persistedStore.createSavedQuery(query).name).toBe(query.name.trim());
    expect((await persistedStore.saveSavedQuery(query)).name).toBe(query.name.trim());
    store.saveSavedQuery.mockImplementation((edited: SavedQuery) => persistedStore.saveSavedQuery(edited));
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(query.name).mockResolvedValueOnce('[{"Name":"*"}]').mockResolvedValueOnce('');
    await manage('edit');
    expect(store.saveSavedQuery).toHaveBeenCalledOnce();
    expect(await persistedStore.getSavedQuery(query.id)).toEqual(expect.objectContaining({
      name: query.name.trim(), layout, findJson: [{ Name: '*' }]
    }));
  });

  it.each([undefined, 'Cancel', 'Delete'])('Manage Delete requires modal confirmation (%s)', async (choice) => {
    const { store, refreshExplorer } = setup();
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(choice as never);
    await manage('delete');
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(`Delete saved query "${query.name}"?`, { modal: true }, 'Delete');
    if (choice === 'Delete') {
      expect(store.removeSavedQuery).toHaveBeenCalledWith(query.id);
      expect(refreshExplorer).toHaveBeenCalledOnce();
    } else {
      expect(store.removeSavedQuery).not.toHaveBeenCalled();
      expect(refreshExplorer).not.toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    }
  });

  it('redacts credentials in a plain service Error before showing the toast', async () => {
    const { client } = setup();
    client.findRecords.mockRejectedValue(new Error('Operation failed: Authorization: Bearer command-secret'));
    await command('runSavedQuery')({ queryId: query.id });
    expectSafeError();
  });

  it.each(['runSavedQuery', 'openSavedQuery', 'deleteSavedQuery', 'manageSavedQueries'])(
    '%s handles a query list failure without rejecting', async (name) => {
      const { store, refreshExplorer } = setup();
      store.listSavedQueries.mockRejectedValue(new Error('Lookup failed: Bearer command-secret'));
      await expect(command(name)()).resolves.toBeUndefined();
      expectSafeError();
      expect(refreshExplorer).not.toHaveBeenCalled();
    }
  );

  it('handles a saved query profile lookup failure without rejecting', async () => {
    const { profiles, client } = setup();
    profiles.getProfile.mockRejectedValue(new Error('Lookup failed: Bearer command-secret'));
    await expect(command('runSavedQuery')({ queryId: query.id })).resolves.toBeUndefined();
    expectSafeError();
    expect(client.findRecords).not.toHaveBeenCalled();
  });

  it.each(['read', 'write', 'single export', 'manage delete', 'edit'])(
    'handles a saved-query %s failure without reporting success', async (action) => {
      const { store, refreshExplorer } = setup();
      const error = new Error('Operation failed: Bearer command-secret');
      if (action === 'read') {
        vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([vscode.Uri.file('/tmp/input.json')]);
        vi.mocked(vscode.workspace.fs.readFile).mockRejectedValue(error);
        await expect(command('importSavedQueries')()).resolves.toBeUndefined();
        expect(store.importSavedQueries).not.toHaveBeenCalled();
      } else if (action === 'write' || action === 'single export') {
        vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(vscode.Uri.file('/tmp/output.json'));
        vi.mocked(vscode.workspace.fs.writeFile).mockRejectedValue(error);
        if (action === 'write') await expect(command('exportSavedQueries')()).resolves.toBeUndefined();
        else await expect(manage('export')).resolves.toBeUndefined();
      } else if (action === 'manage delete') {
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Delete' as never);
        store.removeSavedQuery.mockRejectedValue(error);
        await expect(manage('delete')).resolves.toBeUndefined();
      } else {
        vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('Name').mockResolvedValueOnce('[{"Name":"*"}]').mockResolvedValueOnce('');
        store.saveSavedQuery.mockRejectedValue(error);
        await expect(manage('edit')).resolves.toBeUndefined();
      }
      expectSafeError();
      expect(refreshExplorer).not.toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    }
  );

  it.each(['import', 'export', 'delete', 'resolve'])('handles a saved-query %s service failure without rejecting', async (action) => {
    const { store } = setup();
    let result: unknown;
    if (action === 'import') {
      vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([vscode.Uri.file('/tmp/input.json')]);
      vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from('{}'));
      store.importSavedQueries.mockRejectedValue(serviceError());
      result = command('importSavedQueries')();
    } else if (action === 'export') {
      store.exportSavedQueries.mockRejectedValue(serviceError());
      result = command('exportSavedQueries')();
    } else if (action === 'delete') {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Delete' as never);
      store.removeSavedQuery.mockRejectedValue(serviceError());
      result = command('deleteSavedQuery')({ queryId: query.id });
    } else {
      store.getSavedQuery.mockRejectedValue(serviceError());
      result = command('openSavedQuery')({ queryId: query.id });
    }
    await expect(result).resolves.toBeUndefined();
    expectSafeError();
  });

});

it.each(['{not json', '{}'])('shows an import error for %s, without a success notice or changes', async (text) => {
  const { store, refreshExplorer } = setup();
  const realStore = new SavedQueriesStore(new InMemoryMemento() as never, new InMemoryMemento() as never);
  store.importSavedQueries.mockImplementation((raw) => realStore.importSavedQueries(raw));
  vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([vscode.Uri.file('/tmp/queries.json')]);
  vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from(text));
  await command('importSavedQueries')();
  expect(vi.mocked(vscode.window.showErrorMessage).mock.calls[0]?.[0]).toContain(text === '{}' ? 'That JSON file does not contain saved queries' : 'That file is not valid JSON');
  expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  expect(refreshExplorer).not.toHaveBeenCalled();
  expect(await realStore.listSavedQueries()).toEqual([]);
});
