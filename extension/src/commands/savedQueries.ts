import { safeFileName } from '../utils/safeText';
import * as vscode from 'vscode';

import type { FMClient } from '../services/fmClient';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import { executeSavedQueryAgainstClient } from '../services/savedQueryRunner';
import type { SavedQueriesStore } from '../services/savedQueriesStore';
import type { SavedQuery } from '../types/fm';
import { parseFindJson, parseSortJson } from '../utils/jsonValidate';
import { openJsonDocument, parseSavedQueryArg, showCommandError } from './common';
import { QueryBuilderPanel } from '../webviews/queryBuilder';

interface RegisterSavedQueriesCommandDeps {
  context: vscode.ExtensionContext;
  profileStore: ProfileStore;
  savedQueriesStore: SavedQueriesStore;
  fmClient: FMClient;
  logger: Logger;
  refreshExplorer: () => void;
}

export function registerSavedQueriesCommands(
  deps: RegisterSavedQueriesCommandDeps
): vscode.Disposable[] {
  const { context, profileStore, savedQueriesStore, fmClient, logger, refreshExplorer } = deps;

  return [
    vscode.commands.registerCommand('filemakerDataApiTools.saveCurrentQuery', async () => {
      const posted = QueryBuilderPanel.requestSaveCurrentQuery();
      if (!posted) {
        vscode.window.showInformationMessage('Open Query Builder first to save the current query.');
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.runSavedQuery', async (arg: unknown) => {
      try {
        const selected = await resolveSavedQuery(arg, savedQueriesStore);
        if (!selected) {
          return;
        }

        await runSavedQuery(selected, profileStore, savedQueriesStore, fmClient);
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to run saved query.',
          logger,
          logMessage: 'Failed to run saved query.'
        });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.openSavedQuery', async (arg: unknown) => {
      try {
        const selected = await resolveSavedQuery(arg, savedQueriesStore);
        if (!selected) {
          return;
        }

        QueryBuilderPanel.createOrShow(context, profileStore, savedQueriesStore, fmClient, logger, {
          profileId: selected.profileId,
          layout: selected.layout,
          savedQuery: selected
        });
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to open saved query.',
          logger,
          logMessage: 'Failed to open saved query.'
        });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.deleteSavedQuery', async (arg: unknown) => {
      try {
        const selected = await resolveSavedQuery(arg, savedQueriesStore);
        if (!selected) {
          return;
        }

        await deleteSavedQuery(selected, savedQueriesStore, refreshExplorer);
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to delete saved query.',
          logger,
          logMessage: 'Failed to delete saved query.'
        });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.manageSavedQueries', async () => {
      try {
        const selected = await resolveSavedQuery(undefined, savedQueriesStore);
        if (!selected) {
          return;
        }

        const action = await vscode.window.showQuickPick(
          [
            { label: 'Run', value: 'run' },
            { label: 'Open in Query Builder', value: 'open' },
            { label: 'Edit', value: 'edit' },
            { label: 'Delete', value: 'delete' },
            { label: 'Export This Query', value: 'export' }
          ],
          {
            title: `Manage Saved Query: ${selected.name}`
          }
        );

        if (!action) {
          return;
        }

        switch (action.value) {
          case 'run':
            await runSavedQuery(selected, profileStore, savedQueriesStore, fmClient);
            break;
          case 'open':
            QueryBuilderPanel.createOrShow(context, profileStore, savedQueriesStore, fmClient, logger, {
              profileId: selected.profileId,
              layout: selected.layout,
              savedQuery: selected
            });
            break;
          case 'edit':
            await editSavedQuery(selected, savedQueriesStore);
            refreshExplorer();
            break;
          case 'delete':
            await deleteSavedQuery(selected, savedQueriesStore, refreshExplorer);
            break;
          case 'export':
            await exportSingleQuery(selected);
            break;
          default:
            break;
        }
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to manage saved queries.',
          logger,
          logMessage: 'Failed to manage saved queries.'
        });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.exportSavedQueries', async () => {
      try {
        const payload = await savedQueriesStore.exportSavedQueries();
        const uri = await vscode.window.showSaveDialog({
          title: 'Export Saved Queries',
          filters: {
            JSON: ['json']
          },
          saveLabel: 'Export Saved Queries',
          defaultUri: vscode.Uri.file('saved-queries.json')
        });

        if (!uri) {
          return;
        }

        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(payload, null, 2), 'utf8'));
        vscode.window.showInformationMessage(`Exported ${payload.queries.length} saved queries.`);
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to export saved queries.',
          logger,
          logMessage: 'Failed to export saved queries.'
        });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.importSavedQueries', async () => {
      try {
        const picks = await vscode.window.showOpenDialog({
          title: 'Import Saved Queries',
          canSelectFiles: true,
          canSelectMany: false,
          filters: {
            JSON: ['json']
          }
        });

        const file = picks?.[0];
        if (!file) {
          return;
        }

        const rawBuffer = await vscode.workspace.fs.readFile(file);
        const result = await savedQueriesStore.importSavedQueries(Buffer.from(rawBuffer).toString('utf8'));

        refreshExplorer();
        vscode.window.showInformationMessage(
          `Imported saved queries: ${result.imported} added, ${result.updated} updated, ${result.skipped} skipped.`
        );
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to import saved queries.',
          logger,
          logMessage: 'Failed to import saved queries.'
        });
      }
    })
  ];
}

async function deleteSavedQuery(
  selected: SavedQuery,
  savedQueriesStore: SavedQueriesStore,
  refreshExplorer: () => void
): Promise<void> {
  const confirmation = await vscode.window.showWarningMessage(
    `Delete saved query "${selected.name}"?`,
    { modal: true },
    'Delete'
  );

  if (confirmation !== 'Delete') {
    return;
  }

  await savedQueriesStore.removeSavedQuery(selected.id);
  refreshExplorer();
  vscode.window.showInformationMessage(`Deleted saved query "${selected.name}".`);
}

export async function runSavedQuery(
  query: SavedQuery,
  profileStore: ProfileStore,
  savedQueriesStore: SavedQueriesStore,
  fmClient: FMClient
): Promise<void> {
  const profile = await profileStore.getProfile(query.profileId);

  if (!profile) {
    vscode.window.showErrorMessage('The saved query profile no longer exists.');
    return;
  }

  try {
    const { request, result } = await executeSavedQueryAgainstClient(query, profile, fmClient);
    await savedQueriesStore.touchLastRun(query.id);

    await openJsonDocument({
      savedQuery: {
        id: query.id,
        name: query.name
      },
      profile: profile.name,
      layout: query.layout,
      request,
      result
    });
  } catch (error) {
    await showCommandError(error, {
      fallbackMessage: 'Failed to run saved query.'
    });
  }
}


async function resolveSavedQuery(
  arg: unknown,
  savedQueriesStore: SavedQueriesStore
): Promise<SavedQuery | undefined> {
  const parsedArg = parseSavedQueryArg(arg);

  if (parsedArg.queryId) {
    const match = await savedQueriesStore.getSavedQuery(parsedArg.queryId);
    if (!match) {
      vscode.window.showErrorMessage(`Saved query ${parsedArg.queryId} not found.`);
    }

    return match;
  }

  const all = await savedQueriesStore.listSavedQueries({
    profileId: parsedArg.profileId
  });

  if (all.length === 0) {
    vscode.window.showInformationMessage('No saved queries found.');
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(
    all.map((query) => ({
      label: query.name,
      detail: `${query.layout} • ${query.profileId}`,
      description: query.lastRunAt ? `Last run ${query.lastRunAt}` : 'Never run',
      query
    })),
    {
      title: 'Select Saved Query'
    }
  );

  return selected?.query;
}

async function editSavedQuery(query: SavedQuery, savedQueriesStore: SavedQueriesStore): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: 'Edit Saved Query',
    prompt: 'Query name',
    value: query.name,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim().length === 0 ? 'Query name is required.' : undefined)
  });

  if (!name) {
    return;
  }

  const findJsonInput = await vscode.window.showInputBox({
    title: 'Edit Saved Query',
    prompt: 'Find JSON array',
    value: JSON.stringify(query.findJson, null, 2),
    ignoreFocusOut: true
  });

  if (!findJsonInput) {
    return;
  }

  const sortJsonInput = await vscode.window.showInputBox({
    title: 'Edit Saved Query',
    prompt: 'Sort JSON array (optional)',
    value: query.sortJson ? JSON.stringify(query.sortJson, null, 2) : '',
    ignoreFocusOut: true
  });

  const findValidation = parseFindJson(findJsonInput);
  if (!findValidation.ok || !findValidation.value) {
    vscode.window.showErrorMessage(findValidation.error ?? 'Find JSON is invalid.');
    return;
  }

  let sortJson: Array<Record<string, unknown>> | undefined;

  if (sortJsonInput && sortJsonInput.trim().length > 0) {
    const sortValidation = parseSortJson(sortJsonInput);
    if (!sortValidation.ok || !sortValidation.value) {
      vscode.window.showErrorMessage(sortValidation.error ?? 'Sort JSON is invalid.');
      return;
    }

    sortJson = sortValidation.value;
  }

  await savedQueriesStore.saveSavedQuery({
    ...query,
    name: name.trim(),
    findJson: findValidation.value,
    sortJson
  });

  vscode.window.showInformationMessage(`Updated saved query "${name.trim()}".`);
}

async function exportSingleQuery(query: SavedQuery): Promise<void> {
  const uri = await vscode.window.showSaveDialog({
    title: 'Export Saved Query',
    filters: {
      JSON: ['json']
    },
    defaultUri: vscode.Uri.file(`${safeFileName(query.name)}.json`)
  });

  if (!uri) {
    return;
  }

  await vscode.workspace.fs.writeFile(
    uri,
    Buffer.from(
      JSON.stringify(
        {
          schemaVersion: 1,
          queries: [query]
        },
        null,
        2
      ),
      'utf8'
    )
  );

  vscode.window.showInformationMessage(`Exported saved query "${query.name}".`);
}
