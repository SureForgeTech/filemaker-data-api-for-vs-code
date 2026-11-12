import * as vscode from 'vscode';

import type { FMClient } from '../services/fmClient';
import type { FmBridgeServer } from '../services/fmBridgeServer';
import type { FmWebProjectService } from '../services/fmWebProjectService';
import type { FmWebRuntimeGenerator } from '../services/fmWebRuntimeGenerator';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import type { SchemaService } from '../services/schemaService';
import type { RoleGuard } from '../enterprise/roleGuard';
import { LayoutModePanel } from '../webviews/layoutMode';
import { resolveProfileFromArg, showCommandError } from './common';

interface RegisterFmWebProjectCommandDeps {
  context: vscode.ExtensionContext;
  profileStore: ProfileStore;
  fmClient: FMClient;
  schemaService: SchemaService;
  fmWebProjectService: FmWebProjectService;
  fmWebRuntimeGenerator: FmWebRuntimeGenerator;
  fmBridgeServer: FmBridgeServer;
  roleGuard: RoleGuard;
  logger: Logger;
  refreshExplorer: () => void;
}

export function registerFmWebProjectCommands(
  deps: RegisterFmWebProjectCommandDeps
): vscode.Disposable[] {
  const {
    context,
    profileStore,
    fmClient,
    schemaService,
    fmWebProjectService,
    fmWebRuntimeGenerator,
    fmBridgeServer,
    roleGuard,
    logger,
    refreshExplorer
  } = deps;

  return [
    vscode.commands.registerCommand('filemakerDataApiTools.initializeFmWebProject', async () => {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage(
          'Workspace trust is required to initialize an FM Web project.'
        );
        return;
      }

      try {
        const project = await fmWebProjectService.initializeProject();
        vscode.window.showInformationMessage(
          `Initialized FM Web project at .fmweb (${project.name}).`
        );
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to initialize FM Web project.',
          logger,
          logMessage: 'Initialize FM Web project command failed.'
        });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.selectActiveProfile', async (arg: unknown) => {
      const profile = await resolveProfileFromArg(arg, profileStore);
      if (!profile) {
        return;
      }

      try {
        await fmWebProjectService.setActiveProfile(profile.id);
        refreshExplorer();
        vscode.window.showInformationMessage(`Selected active profile: ${profile.name}.`);
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to set active profile for FM Web project.',
          logger,
          logMessage: 'Select active profile command failed.'
        });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.syncFmWebMetadata', async (arg: unknown) => {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage(
          'Workspace trust is required to sync FM Web metadata.'
        );
        return;
      }

      const profile = await resolveProfileFromArg(arg, profileStore, true);
      if (!profile) {
        return;
      }

      try {
        await fmWebProjectService.setActiveProfile(profile.id);
        const summary = await fmWebProjectService.syncMetadata(profile);
        schemaService.invalidateProfile(profile.id);
        fmClient.invalidateProfileCache(profile.id);
        refreshExplorer();

        vscode.window.showInformationMessage(
          `Metadata synced: ${summary.layoutCount} layouts, ${summary.scriptCount} scripts, ${summary.fieldCount} fields.`
        );
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to sync FM Web metadata.',
          logger,
          logMessage: 'Sync FM Web metadata command failed.'
        });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.openLayoutMode', async (arg: unknown) => {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage(
          'Workspace trust is required for Layout Mode because layout files are written to .fmweb.'
        );
        return;
      }

      try {
        await fmWebProjectService.ensureProjectInitialized();

        const record =
          arg && typeof arg === 'object' && !Array.isArray(arg)
            ? (arg as Record<string, unknown>)
            : undefined;
        const layoutId = typeof record?.layoutId === 'string' ? record.layoutId : undefined;

        LayoutModePanel.createOrShow(context, fmWebProjectService, profileStore, fmClient, logger, {
          layoutId,
          assertScriptRunAllowed: () => roleGuard.assertFeature('scriptRunner', 'Run script from Layout Mode')
        });
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to open Layout Mode.',
          logger,
          logMessage: 'Open Layout Mode command failed.'
        });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.generateFmWebNextApp', async () => {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage(
          'Workspace trust is required to generate the FM Web runtime template.'
        );
        return;
      }

      try {
        const summary = await fmWebRuntimeGenerator.generateRuntimeAppTemplate();
        vscode.window.showInformationMessage(
          `Generated Next.js runtime template in .fmweb/generated/runtime-next (${summary.created.length} created, ${summary.updated.length} updated, ${summary.skipped.length} skipped).`
        );
        warnAboutEditedManagedFiles(summary.needsManualUpdate);
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to generate FM Web Next.js runtime template.',
          logger,
          logMessage: 'Generate FM Web Next.js runtime template command failed.'
        });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.generateFmWebLayoutPage', async (arg: unknown) => {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage(
          'Workspace trust is required to generate FM Web layout runtime artifacts.'
        );
        return;
      }

      try {
        const layouts = await fmWebRuntimeGenerator.listLayoutDefinitions();
        if (layouts.length === 0) {
          vscode.window.showWarningMessage('No layout definitions were found. Save a layout first.');
          return;
        }

        const selectedId =
          extractLayoutIdArg(arg) ??
          (await vscode.window.showQuickPick(
            layouts.map((layout) => ({
              label: layout.name,
              description: layout.id,
              id: layout.id
            })),
            {
              title: 'Generate Runtime Layout Artifact',
              placeHolder: 'Choose a layout to generate'
            }
          ))?.id;

        if (!selectedId) {
          return;
        }

        const generated = await fmWebRuntimeGenerator.generateLayoutPage(selectedId);
        vscode.window.showInformationMessage(
          `Generated layout artifact for "${generated.name}" at .fmweb/generated/layouts/${generated.id}.layout.json.`
        );
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to generate FM Web layout runtime artifact.',
          logger,
          logMessage: 'Generate FM Web layout runtime artifact command failed.'
        });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.startFmWebPreviewServer', async () => {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage(
          'Workspace trust is required to start FM Web preview services.'
        );
        return;
      }

      try {
        // Also refreshes the bridge client in an app generated by an older version, so the token
        // written below is actually sent.
        const template = await fmWebRuntimeGenerator.generateRuntimeAppTemplate();
        warnAboutEditedManagedFiles(template?.needsManualUpdate);
        const layouts = await fmWebRuntimeGenerator.listLayoutDefinitions();
        const firstLayout = layouts[0];
        if (firstLayout) {
          await fmWebRuntimeGenerator.generateLayoutPage(firstLayout.id);
        }

        const runtimeRoot = fmWebRuntimeGenerator.getGeneratedRuntimeRoot();
        // The folder can arrive with the repository, including its own package.json, and npm
        // runs whatever scripts that file defines. Say so and ask before running anything.
        const answer = await vscode.window.showWarningMessage(
          `Start the FM Web preview?\n\nThis runs "npm install" and "npm run dev" in:\n${runtimeRoot}\n\nnpm runs the install and dev scripts defined in that folder's package.json, and that file can come from this repository. Only continue if you trust it.`,
          { modal: true },
          'Run'
        );
        if (answer !== 'Run') {
          await fmBridgeServer.stop();
          await fmWebRuntimeGenerator.clearBridgeEnv();
          return;
        }

        const bridge = await fmBridgeServer.ensureStarted();
        await fmWebRuntimeGenerator.writeBridgeEnv(bridge.baseUrl, fmBridgeServer.getSessionToken());

        const terminal = vscode.window.createTerminal({
          name: 'FM Web Preview',
          cwd: runtimeRoot
        });
        terminal.show(true);
        terminal.sendText('npm install --no-audit --no-fund');
        terminal.sendText('npm run dev -- --hostname 127.0.0.1 --port 3000');

        vscode.window.showInformationMessage(
          `FM bridge ready at ${bridge.baseUrl}. Preview app starting from .fmweb/generated/runtime-next.`
        );
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to start FM Web preview server.',
          logger,
          logMessage: 'Start FM Web preview server command failed.'
        });
      }
    })
  ];
}

/** Files the extension keeps current were edited, so they were left alone and the preview may fail. */
function warnAboutEditedManagedFiles(files: string[] | undefined): void {
  if (!files || files.length === 0) {
    return;
  }
  void vscode.window.showWarningMessage(
    `These generated preview files were edited (or are symbolic links), so they were not updated: ${files.join(', ')}. The preview cannot reach the FileMaker bridge until they match the current template; delete them and run the command again to get fresh copies.`
  );
}

function extractLayoutIdArg(arg: unknown): string | undefined {
  if (!arg || typeof arg !== 'object' || Array.isArray(arg)) {
    return undefined;
  }

  const raw = (arg as Record<string, unknown>).layoutId;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}
