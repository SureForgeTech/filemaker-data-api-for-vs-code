import { basename, join } from 'path';

import * as vscode from 'vscode';

import { RoleGuard } from '../enterprise/roleGuard';
import { isFeatureEnabled, isOfflineModeOn } from '../utils/policySetting';
import { HiddenFields } from '../ai/aiText';
import { readAiSettings, type HiddenFieldsProblemReporter } from '../ai/aiSettings';
import {
  AI_CONTEXT_END_MARKER,
  AI_CONTEXT_MAX_LAYOUTS,
  AI_CONTEXT_START_MARKER,
  renderAiContext,
  wrapInMarkers,
  type AiContextLayout
} from '../services/aiContextRenderer';
import {
  addToGitignore,
  applyMarkerSection,
  isTrackedByGit,
  MarkersMissingError,
  readExistingFile,
  writeFileIfUnchanged,
  type SectionWriteMode
} from '../services/aiContextWriter';
import type { FMClient } from '../services/fmClient';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import type { SchemaService } from '../services/schemaService';
import type { ConnectionProfile } from '../types/fm';
import { PathConfinementError, resolveConfinedFile, type ConfinedPath } from '../utils/pathConfinement';
import { readUserScopeString } from '../utils/userScopeSetting';
import { distinctFileName } from '../utils/safeText';
import { pickProfile, showCommandError } from './common';

export const WRITE_AI_CONTEXT_COMMAND = 'filemakerDataApiTools.writeAiContext';
const CONTEXT_PATH_SETTING = 'ai.contextPath';
const WORKSPACE_COPY_PATH = '.filemaker/ai-context.md';

interface RegisterAiContextCommandsDeps {
  context: vscode.ExtensionContext;
  profileStore: ProfileStore;
  fmClient: FMClient;
  schemaService: SchemaService;
  logger: Logger;
  reportHiddenFieldsProblem: HiddenFieldsProblemReporter;
  /** Overridable for tests. */
  now?: () => Date;
  isTracked?: (directory: string, absolutePath: string) => Promise<boolean>;
}

interface LayoutPickItem extends vscode.QuickPickItem {
  layout: string;
}

export function registerAiContextCommands(deps: RegisterAiContextCommandsDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(WRITE_AI_CONTEXT_COMMAND, async () => {
      try {
        await writeAiContext(deps);
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to write the AI context file.',
          logger: deps.logger,
          logMessage: 'Failed to write the AI context file.'
        });
      }
    })
  ];
}

async function writeAiContext(deps: RegisterAiContextCommandsDeps): Promise<void> {
  const { context, profileStore, fmClient, logger } = deps;

  const configuration = vscode.workspace.getConfiguration('filemaker');
  const policy = new RoleGuard(logger);
  await policy.refresh();
  const guard = policy.getFeatureGuard('ai');
  const reason = !isFeatureEnabled(configuration, 'features.ai.enabled')
    ? 'AI is disabled by filemaker.features.ai.enabled.'
    : !guard.allowed
      ? guard.reason ?? 'AI is disabled by enterprise policy.'
      : isOfflineModeOn(configuration)
        ? 'Offline mode is enabled; writing AI context is unavailable.'
        : undefined;
  if (reason) {
    const choice = await vscode.window.showInformationMessage(reason, 'Open Settings');
    if (choice === 'Open Settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'filemaker.ai');
    }
    return;
  }

  const profile = await pickProfile(profileStore, false);
  if (!profile) {
    return;
  }

  const layoutNames = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `FileMaker: Loading layouts for ${profile.name}` },
    () => fmClient.listLayouts(profile)
  );
  if (layoutNames.length === 0) {
    vscode.window.showWarningMessage(`No layouts available for "${profile.name}" (${profile.database}).`);
    return;
  }

  const picked = await vscode.window.showQuickPick<LayoutPickItem>(
    layoutNames.map((layout) => ({ label: layout, layout, picked: false })),
    {
      title: `Write AI Context: select layouts from ${profile.name}`,
      placeHolder: `Choose up to ${AI_CONTEXT_MAX_LAYOUTS} layouts to describe (none are selected by default)`,
      canPickMany: true,
      ignoreFocusOut: true
    }
  );
  if (!picked) {
    return;
  }

  let selected = picked.map((item) => item.layout);
  if (selected.length > AI_CONTEXT_MAX_LAYOUTS) {
    vscode.window.showWarningMessage(
      `You selected ${selected.length} layouts; only the first ${AI_CONTEXT_MAX_LAYOUTS} are included.`
    );
    selected = selected.slice(0, AI_CONTEXT_MAX_LAYOUTS);
  }

  const gathered = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'FileMaker: Reading schema for AI context',
      cancellable: true
    },
    async (_progress, token) => gatherSchema(profile, selected, deps, token)
  );
  if (!gathered) {
    return;
  }

  const rendered = renderAiContext({
    connectionName: profile.name,
    database: profile.database,
    generatedAt: (deps.now ?? (() => new Date()))(),
    layouts: gathered.layouts,
    scripts: gathered.scripts,
    unavailableLayouts: gathered.unavailable,
    hiddenFieldsOmitted: gathered.hiddenOmitted
  });
  const wrapped = wrapInMarkers(rendered.content);
  // Names cannot contain these (the allowlist has no `<`), but a section that could end
  // itself early would let database text edit the host file, so check rather than assume.
  if (
    rendered.content.includes(AI_CONTEXT_START_MARKER) ||
    rendered.content.includes(AI_CONTEXT_END_MARKER)
  ) {
    throw new Error('Refusing to write: the generated text contains a section marker.');
  }

  const globalStorage = context.globalStorageUri.fsPath;
  const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  const target = await resolveTarget(profile, globalStorage, workspaceRoots);
  // Do not replace a good section with nothing: if every picked layout failed (or nothing at
  // all was readable), deliver() asks first when a section already exists.
  const poorResult = rendered.includedLayouts === 0 && (selected.length > 0 || rendered.includedScripts === 0);
  const outcome = await deliver(wrapped, target, workspaceRoots, deps, poorResult);
  if (!outcome) {
    return;
  }

  logger.info(
    `Wrote AI context for "${profile.name}": ${rendered.includedLayouts} layouts, ${rendered.includedScripts} scripts, ${rendered.replacedNames} names replaced.`
  );

  const summary =
    `AI context written (${rendered.includedLayouts} layouts, ${rendered.includedScripts} scripts` +
    `${rendered.omittedLayouts > 0 ? `, ${rendered.omittedLayouts} layouts left out for size` : ''}` +
    `${rendered.replacedNames > 0 ? `, ${rendered.replacedNames} names replaced` : ''}` +
    `${gathered.hiddenOmitted > 0 ? `, ${gathered.hiddenOmitted} field${gathered.hiddenOmitted === 1 ? '' : 's'} left out by filemaker.ai.hiddenFields` : ''}): ${outcome.path}`;
  const actions = ['Open File'];
  if (!outcome.insideWorkspace && workspaceRoots.length > 0) {
    actions.push('Copy into Workspace');
  }
  const action = await vscode.window.showInformationMessage(summary, ...actions);
  if (action === 'Open File') {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(outcome.path));
    await vscode.window.showTextDocument(document);
  } else if (action === 'Copy into Workspace') {
    await copyIntoWorkspace(wrapped, workspaceRoots, deps);
  }
}

async function gatherSchema(
  profile: ConnectionProfile,
  layouts: string[],
  deps: RegisterAiContextCommandsDeps,
  token?: vscode.CancellationToken
): Promise<{ layouts: AiContextLayout[]; scripts: string[] | undefined; unavailable: number; hiddenOmitted: number } | undefined> {
  const result: AiContextLayout[] = [];
  let unavailable = 0;
  let hiddenOmitted = 0;
  // The same setting and the same name matching the AI tools use: a hidden field is not listed here either.
  const hidden = new HiddenFields(readAiSettings(vscode.workspace.getConfiguration('filemaker'), deps.reportHiddenFieldsProblem).hiddenFields);

  for (const layout of layouts) {
    if (token?.isCancellationRequested) {
      return undefined;
    }
    try {
      const schema = await deps.schemaService.getLayoutSchema(profile, layout);
      if (schema.supported) {
        result.push({
          name: layout,
          fields: schema.fields
            .filter((field) => {
              if (hidden.isHidden(field.name)) {
                hiddenOmitted += 1;
                return false;
              }
              return true;
            })
            .map((field) => ({ name: field.name, type: field.result ?? field.type }))
        });
      } else {
        unavailable += 1;
      }
    } catch (error) {
      deps.logger.warn(`AI context: could not read layout metadata (${error instanceof Error ? error.name : 'error'}).`);
      unavailable += 1;
    }
  }

  let scripts: string[] | undefined;
  if (!token?.isCancellationRequested) {
    try {
      scripts = await deps.fmClient.listScripts(profile);
    } catch (error) {
      deps.logger.warn(`AI context: could not read script names (${error instanceof Error ? error.name : 'error'}).`);
    }
  }
  if (token?.isCancellationRequested) {
    return undefined;
  }

  return { layouts: result, scripts, unavailable, hiddenOmitted };
}

async function resolveTarget(
  profile: ConnectionProfile,
  globalStorage: string,
  workspaceRoots: string[]
): Promise<ConfinedPath> {
  const configured = readUserScopeString(vscode.workspace.getConfiguration('filemaker'), CONTEXT_PATH_SETTING);
  const roots = [...workspaceRoots, globalStorage];

  try {
    if (configured !== undefined) {
      if (/^(readme|changelog|license)(\.[^/]*)?$/i.test(basename(configured))) {
        throw new PathConfinementError('Choose a dedicated AI context file, such as .filemaker/ai-context.md, rather than README.md or another project document.');
      }
      return await resolveConfinedFile(configured, workspaceRoots[0] ?? globalStorage, roots);
    }
    // Capped so a long profile name cannot make an over-long file name; names that differ
    // after sanitizing or cutting get a hash from distinctFileName. Names that differ only in
    // letter case can still share a file on a case-insensitive file system.
    const sanitized = profile.name
      .replace(/[^A-Za-z0-9_.-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60);
    const fileName = `${distinctFileName(profile.name, sanitized, 'connection')}.md`;
    return await resolveConfinedFile(join('ai-context', fileName), globalStorage, [globalStorage]);
  } catch (error) {
    if (error instanceof PathConfinementError) {
      throw new Error(
        configured !== undefined
          ? `The setting filemaker.ai.contextPath ("${configured.slice(0, 100)}") was not used: ${error.message} Choose a path inside the workspace or leave it empty.`
          : error.message,
        { cause: error }
      );
    }
    throw error;
  }
}

interface Delivered {
  path: string;
  insideWorkspace: boolean;
}

/** Writes the section, then handles the .gitignore offer for files inside the workspace. */
async function deliver(
  wrapped: string,
  target: ConfinedPath,
  workspaceRoots: string[],
  deps: RegisterAiContextCommandsDeps,
  poorResult = false
): Promise<Delivered | undefined> {
  const insideWorkspace = workspaceRoots.includes(target.root);
  if (insideWorkspace && !vscode.workspace.isTrusted) {
    vscode.window.showErrorMessage(
      'Trust this workspace to write the AI context file into it. Nothing was written.'
    );
    return undefined;
  }

  const existing = await readExistingFile(target.path);
  let applied: { text: string; mode: SectionWriteMode };
  try {
    applied = applyMarkerSection(existing, wrapped, false);
  } catch (error) {
    if (!(error instanceof MarkersMissingError)) {
      throw error;
    }
    const choice = await vscode.window.showWarningMessage(
      `${target.relativePath} already exists and has no FileMaker AI context section. Choose Add to the file to keep the current text and append the generated section, Skip existing to leave the file alone, or Cancel to stop.`,
      { modal: true },
      'Add to the file', 'Skip existing'
    );
    if (choice !== 'Add to the file') {
      return undefined;
    }
    applied = applyMarkerSection(existing, wrapped, true);
  }

  if (poorResult && applied.mode === 'replaced') {
    const choice = await vscode.window.showWarningMessage(
      `No layout schema could be read, so the new AI context section would be empty. ${target.relativePath} already has a section. Replace it anyway?`,
      { modal: true },
      'Replace Anyway'
    );
    if (choice !== 'Replace Anyway') {
      return undefined;
    }
  }

  await writeFileIfUnchanged(target.path, applied.text, existing);

  if (insideWorkspace) {
    const isTracked = deps.isTracked ?? isTrackedByGit;
    const trackedSection =
      applied.mode !== 'created' && (await isTracked(target.root, target.path));
    if (trackedSection) {
      vscode.window.showInformationMessage(
        `${target.relativePath} is tracked by git. The generated section holds database structure (layout, field and script names); review it before you commit.`
      );
    } else {
      const choice = await vscode.window.showInformationMessage(
        `${target.relativePath} holds database structure (layout, field and script names). Add it to .gitignore so it is not committed by accident?`,
        'Add to .gitignore',
        'Not Now'
      );
      if (choice === 'Add to .gitignore') {
        const added = await addToGitignore(target.root, target.relativePath);
        vscode.window.showInformationMessage(
          added ? 'Added to .gitignore.' : 'It is already listed in .gitignore.'
        );
      }
    }
  }

  return { path: target.path, insideWorkspace };
}

async function copyIntoWorkspace(
  wrapped: string,
  workspaceRoots: string[],
  deps: RegisterAiContextCommandsDeps
): Promise<void> {
  const root = workspaceRoots[0];
  if (!root) {
    return;
  }
  const target = await resolveConfinedFile(WORKSPACE_COPY_PATH, root, [root]);
  const delivered = await deliver(wrapped, target, workspaceRoots, deps);
  if (delivered) {
    vscode.window.showInformationMessage(`Copied into the workspace: ${target.relativePath}`);
  }
}
