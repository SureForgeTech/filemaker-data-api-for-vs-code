import { readFile } from 'fs/promises';
import path from 'path';
import { displayText } from '../ai/aiText';
import { FmWebPreviewProcess, PREVIEW_INSTALL_DESCRIPTION, PREVIEW_DEV_DESCRIPTION } from '../services/fmWebPreviewProcess';
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

  let preview: FmWebPreviewProcess | undefined;
  let previewStarting = false;
  context.subscriptions?.push({ dispose: () => preview?.dispose() });

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

      if (previewStarting) return;
      previewStarting = true;
      try {
        preview?.dispose();
        preview = undefined;
        await fmBridgeServer.stop();
        const offending = await fmWebRuntimeGenerator.inspectPreviewFiles();
        if (offending.length) {
          const listing = offending.map((file) => displayText(file, Infinity)).join('\n');
          if (listing.length > 12000) throw new Error('Too many unexpected preview files to show safely. Remove the generated runtime and workspace .npmrc files manually, then regenerate.');
          const choice = await vscode.window.showWarningMessage(
            `The preview cannot run these unexpected or edited files:\n\n${listing}\n\nRegenerate from template deletes exactly the listed files or folders (including their contents). Parent .npmrc files listed above will also be deleted.`,
            { modal: true }, 'Regenerate from template'
          );
          if (choice !== 'Regenerate from template') { await fmWebRuntimeGenerator.clearBridgeEnv(); return; }
          await fmWebRuntimeGenerator.removePreviewFiles(offending);
        }
        await fmWebRuntimeGenerator.generateRuntimeAppTemplate();
        const remaining = await fmWebRuntimeGenerator.inspectPreviewFiles();
        if (remaining.length) throw new Error(`Preview files changed; start again to review: ${remaining.map((file) => displayText(file, Infinity)).join(', ')}`);
        const layouts = new Map<string, Buffer>();
        for (const layout of await fmWebRuntimeGenerator.listLayoutDefinitions()) {
          const generated = await fmWebRuntimeGenerator.generateLayoutPage(layout.id);
          layouts.set(path.basename(generated.outputPath), await readFile(generated.outputPath));
        }
        const runtimeRoot = fmWebRuntimeGenerator.getGeneratedRuntimeRoot();
        const answer = await vscode.window.showWarningMessage(
          `Start the FM Web preview?\n\nA fresh private temporary copy of the shipped template will run these commands:\n${PREVIEW_INSTALL_DESCRIPTION}\n${PREVIEW_DEV_DESCRIPTION}\n\nBoth npm commands use pinned empty --userconfig and --globalconfig files, an explicit --prefix and private cache, and a cleared configuration environment. The dev script in the template package.json runs Next on 127.0.0.1:3000; pre/post scripts are disabled. Dependencies are downloaded from registry.npmjs.org. No install scripts run.\n\nThe runtime checked was:\n${displayText(runtimeRoot, Infinity)}\n\nThe extension opens your browser with a one-time private launch link.`,
          { modal: true }, 'Run'
        );
        if (answer !== 'Run') { await fmWebRuntimeGenerator.clearBridgeEnv(); return; }
        const bridge = await fmBridgeServer.ensureStarted();
        await fmWebRuntimeGenerator.writeBridgeEnv(bridge.baseUrl, fmBridgeServer.getSessionToken());
        const token = fmBridgeServer.getSessionToken();
        if (!token) throw new Error('Bridge session is not ready.');
        preview = new FmWebPreviewProcess();
        await preview.start(await fmWebRuntimeGenerator.previewTemplateFiles(), layouts, bridge.baseUrl, token);
        vscode.window.showInformationMessage('FM Web preview is ready in your browser. Restarting it invalidates the previous launch and session.');
      } catch (error) {
        preview?.dispose();
        preview = undefined;
        await fmBridgeServer.stop();
        await showCommandError(error, {
          fallbackMessage: 'Failed to start FM Web preview server.',
          logger,
          logMessage: 'Start FM Web preview server command failed.'
        });
      } finally {
        previewStarting = false;
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
