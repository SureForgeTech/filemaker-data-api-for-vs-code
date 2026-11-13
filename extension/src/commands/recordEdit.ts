import * as vscode from 'vscode';
import { singleFlight } from '../utils/singleFlight';

import type { RoleGuard } from '../enterprise/roleGuard';
import type { FMClient } from '../services/fmClient';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import type { SchemaService } from '../services/schemaService';
import type { SettingsService } from '../services/settingsService';
import { describeScriptErrors } from '../services/responseGuard';
import { validateRecordId } from '../utils/jsonValidate';
import { readContainerUploadFile } from '../utils/containerUpload';
import { parseLayoutArg, parseRecordIdArg, resolveLayoutContext, showCommandError } from './common';
import { RecordEditorPanel } from '../webviews/recordEditor';

interface RegisterRecordEditCommandsDeps {
  context: vscode.ExtensionContext;
  profileStore: ProfileStore;
  fmClient: FMClient;
  schemaService: SchemaService;
  settingsService: SettingsService;
  roleGuard: RoleGuard;
  logger: Logger;
}

interface ContainerUploadCommandArg {
  profileId?: string;
  layout?: string;
  layoutName?: string;
  recordId?: string;
  fieldName?: string;
  fieldRepetition?: number;
  modId?: string;
}

export function registerRecordEditCommands(deps: RegisterRecordEditCommandsDeps): vscode.Disposable[] {
  const { context, profileStore, fmClient, schemaService, settingsService, roleGuard, logger } = deps;

  return [
    vscode.commands.registerCommand('filemakerDataApiTools.openRecordEditor', async (arg: unknown) => {
      if (!settingsService.isRecordEditEnabled()) {
        vscode.window.showInformationMessage('Record editing is disabled by settings.');
        return;
      }
      if (
        !(await roleGuard.assertFeature('writeOperations', 'Open Record Editor')) ||
        !(await roleGuard.assertFeature('recordEdit', 'Open Record Editor'))
      ) {
        return;
      }

      const selection = await resolveLayoutContext(arg, profileStore, fmClient);
      if (!selection) {
        return;
      }
      const { profile, layout } = selection;
      const profileId = profile.id;
      const knownRecordId = parseRecordIdArg(arg);
      if (knownRecordId) {
        RecordEditorPanel.createOrShow(context, profileStore, fmClient, schemaService, logger, {
          profileId,
          layout,
          recordId: knownRecordId
        });
        return;
      }

      const enteredRecordId = await vscode.window.showInputBox({
        title: 'Open Record Editor',
        prompt: 'Record ID (optional; leave blank to browse)',
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? validateRecordId(value).error : undefined)
      });
      if (enteredRecordId === undefined) {
        return;
      }
      const recordId = enteredRecordId.trim() || undefined;

      RecordEditorPanel.createOrShow(context, profileStore, fmClient, schemaService, logger, {
        profileId,
        layout,
        recordId
      });
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.editRecordById', async (arg: unknown) => {
      if (!settingsService.isRecordEditEnabled()) {
        vscode.window.showInformationMessage('Record editing is disabled by settings.');
        return;
      }
      if (
        !(await roleGuard.assertFeature('writeOperations', 'Edit Record by ID')) ||
        !(await roleGuard.assertFeature('recordEdit', 'Edit Record by ID'))
      ) {
        return;
      }

      const selection = await resolveLayoutContext(arg, profileStore, fmClient);
      if (!selection) {
        return;
      }
      const { profile, layout } = selection;
      const profileId = profile.id;

      const recordId = await vscode.window.showInputBox({
        title: 'Edit Record by ID',
        prompt: 'Record ID',
        ignoreFocusOut: true,
        validateInput: (value) => validateRecordId(value).error
      });

      if (!recordId) {
        return;
      }

      RecordEditorPanel.createOrShow(context, profileStore, fmClient, schemaService, logger, {
        profileId,
        layout,
        recordId: recordId.trim()
      });
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.createRecord', async (arg: unknown) => {
      if (!settingsService.isRecordEditEnabled()) {
        vscode.window.showInformationMessage('Record editing is disabled by settings.');
        return;
      }
      if (
        !(await roleGuard.assertFeature('writeOperations', 'Create Record')) ||
        !(await roleGuard.assertFeature('recordEdit', 'Create Record'))
      ) {
        return;
      }

      const selection = await resolveLayoutContext(arg, profileStore, fmClient);
      if (!selection) {
        return;
      }
      const { profile, layout } = selection;
      const profileId = profile.id;

      RecordEditorPanel.createOrShow(context, profileStore, fmClient, schemaService, logger, {
        profileId,
        layout,
        mode: 'create'
      });
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.deleteRecord', singleFlight(async (arg: unknown) => {
      // Deleting is a record edit as much as saving is: it needs the same switch and policy.
      if (!settingsService.isRecordEditEnabled()) {
        vscode.window.showInformationMessage('Record editing is disabled by settings.');
        return;
      }
      if (
        !(await roleGuard.assertFeature('writeOperations', 'Delete Record')) ||
        !(await roleGuard.assertFeature('recordEdit', 'Delete Record'))
      ) {
        return;
      }
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage('Delete Record is disabled in untrusted workspaces.');
        return;
      }

      const selection = await resolveLayoutContext(arg, profileStore, fmClient);
      if (!selection) {
        return;
      }
      const { profile, layout } = selection;

      const recordId = await vscode.window.showInputBox({
        title: 'Delete Record',
        prompt: 'Enter the record ID to delete',
        ignoreFocusOut: true,
        validateInput: (value) => validateRecordId(value).error
      });

      if (!recordId) {
        return;
      }

      const confirmation = await vscode.window.showWarningMessage(
        `Delete record ${recordId.trim()} from layout "${layout}"? This cannot be undone.`,
        { modal: true },
        'Delete'
      );

      if (confirmation !== 'Delete') {
        return;
      }

      try {
        const result = await fmClient.deleteRecord(profile, layout, recordId.trim());
        vscode.window.showInformationMessage(
          `Record ${result.recordId} deleted from "${layout}".`
        );
        if (result.scriptErrors && result.scriptErrors.length > 0) {
          vscode.window.showWarningMessage(
            `Record deleted, but ${describeScriptErrors(result.scriptErrors)}.`
          );
        }
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to delete record.',
          logger,
          logMessage: 'Delete record command failed.'
        });
      }
    })),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.uploadContainer',
      async (arg: unknown) => {
        if (!settingsService.isRecordEditEnabled()) {
          vscode.window.showInformationMessage('Record editing is disabled by settings.');
          return false;
        }
        if (
          !(await roleGuard.assertFeature('writeOperations', 'Upload to Container')) ||
          !(await roleGuard.assertFeature('recordEdit', 'Upload to Container'))
        ) {
          return false;
        }
        if (!vscode.workspace.isTrusted) {
          vscode.window.showWarningMessage(
            'Upload to Container is disabled in untrusted workspaces.'
          );
          return false;
        }

        const contextArg = parseContainerUploadArg(arg);
        const selection = await resolveLayoutContext(contextArg, profileStore, fmClient);
        if (!selection) {
          return false;
        }
        const { profile, layout } = selection;

        const recordId = contextArg.recordId ?? (await promptForRecordId());
        if (!recordId) {
          return false;
        }

        const fieldName = contextArg.fieldName ?? (await promptForContainerFieldName());
        if (!fieldName) {
          return false;
        }

        const files = await vscode.window.showOpenDialog({
          title: 'Select File to Upload',
          openLabel: 'Upload',
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false
        });

        const uri = files?.[0];
        if (!uri) {
          return false;
        }

        try {
          const maxBytes = settingsService.getContainerUploadMaxBytes();
          const file = await readContainerUploadFile(uri, maxBytes);
          const result = await fmClient.uploadContainer(
            profile,
            layout,
            recordId.trim(),
            fieldName, // exactly as given: a leading or trailing space can be part of a field name
            file,
            {
              fieldRepetition: contextArg.fieldRepetition,
              modId: contextArg.modId,
              maxBytes
            }
          );

          vscode.window.showInformationMessage(
            `Uploaded "${file.fileName}" to ${fieldName} on record ${result.recordId}.`
          );
          if (result.scriptErrors && result.scriptErrors.length > 0) {
            vscode.window.showWarningMessage(`The upload worked, but ${describeScriptErrors(result.scriptErrors)}.`);
          }
          return true;
        } catch (error) {
          await showCommandError(error, {
            fallbackMessage: 'Failed to upload file to container field.',
            logger,
            logMessage: 'Upload container command failed.',
            actions: {
              settingsKey: 'filemaker.containerUploadMaxBytes'
            }
          });
          return false;
        }
      }
    )
  ];
}

function parseContainerUploadArg(arg: unknown): ContainerUploadCommandArg {
  const layoutArg = parseLayoutArg(arg);
  if (!arg || typeof arg !== 'object') {
    return layoutArg;
  }

  const value = arg as ContainerUploadCommandArg;
  return {
    ...layoutArg,
    recordId: typeof value.recordId === 'string' ? value.recordId : undefined,
    fieldName: typeof value.fieldName === 'string' ? value.fieldName : undefined,
    fieldRepetition: typeof value.fieldRepetition === 'number' ? value.fieldRepetition : undefined,
    modId: typeof value.modId === 'string' ? value.modId : undefined
  };
}

async function promptForRecordId(): Promise<string | undefined> {
  const recordId = await vscode.window.showInputBox({
    title: 'Upload to Container',
    prompt: 'Enter the FileMaker record ID',
    ignoreFocusOut: true,
    validateInput: (value) => validateRecordId(value).error
  });

  return recordId?.trim() || undefined;
}

async function promptForContainerFieldName(): Promise<string | undefined> {
  const fieldName = await vscode.window.showInputBox({
    title: 'Upload to Container',
    prompt: 'Enter the container field name',
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length === 0 ? 'Container field name is required.' : undefined
  });

  // Exactly as typed (a space can be part of the name); only a blank answer counts as none.
  return fieldName && fieldName.trim().length > 0 ? fieldName : undefined;
}
