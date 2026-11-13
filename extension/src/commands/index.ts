import * as vscode from 'vscode';

import { registerConnectionDiagnosticCommands } from './diagnoseConnection';

import { reviewAndTrustCertificate, withPinnedCertificate } from '../services/certificateTrust';
import { FMClientError } from '../services/errors';

import type { RoleGuard } from '../enterprise/roleGuard';
import type { FMClient } from '../services/fmClient';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import type { SavedQueriesStore } from '../services/savedQueriesStore';
import type { SecretStore } from '../services/secretStore';
import type { FindRecordsRequest } from '../types/fm';
import {
  parseFindJson,
  parseOptionalPositiveInteger,
  parseSortJson,
  validateRecordId,
  isUnencryptedRemoteUrl
} from '../utils/jsonValidate';
import {
  openJsonDocument,
  parseLayoutArg,
  parseRecordIdArg,
  promptForLayout,
  resolveProfileFromArg,
  resolveLayoutContext,
  showCommandError
} from './common';
import { describeScriptErrors } from '../services/responseGuard';
import { ConnectionWizardPanel } from '../webviews/connectionWizard';
import { QueryBuilderPanel } from '../webviews/queryBuilder';
import { RecordViewerPanel } from '../webviews/recordViewer';
import type { BackoffPolicy } from '../utils/backoff';
import { showConnectionQuickPick } from '../views/connectionStatusBar';

interface RegisterCoreCommandDeps {
  context: vscode.ExtensionContext;
  profileStore: ProfileStore;
  secretStore: SecretStore;
  savedQueriesStore: SavedQueriesStore;
  fmClient: FMClient;
  logger: Logger;
  roleGuard: RoleGuard;
  refreshExplorer: () => void;
  /**
   * Optional callback to re-render the persistent connection status-bar
   * item after any command that changes the active profile (connect /
   * disconnect / remove). Wired in extension.ts; left optional so unit
   * tests don't have to construct a status-bar shim.
   */
  refreshConnectionStatus?: () => void;
  onProfileDisconnected?: (profileId: string) => void;
  onLayoutSelected?: (profileId: string, layout: string) => void;
  /** Resolved at call time so settings updates are picked up live. */
  getConnectBackoffPolicy?: () => BackoffPolicy;
  getConnectionWizardTestPolicy?: () => 'off' | 'warn' | 'block';
}

/**
 * Whether a failed Connect is worth trying again. The decision is made once, where the error is
 * built (`normalizeError`): transport trouble, timeouts, a gateway answer, a locked record or a
 * full session pool can clear; a certificate problem, rejected credentials, a missing privilege
 * or any other FileMaker answer cannot. (The old check read FileMaker's code as if it were a Node
 * code, never retried a refused connection, and retried HTTP 500 with FileMaker error 802.)
 */
export function isRetryableConnectError(error: unknown): boolean {
  return error instanceof FMClientError && error.isRetryable === true;
}

export function registerCoreCommands(deps: RegisterCoreCommandDeps): vscode.Disposable[] {
  const {
    context,
    profileStore,
    secretStore,
    savedQueriesStore,
    fmClient,
    logger,
    roleGuard,
    refreshExplorer,
    refreshConnectionStatus,
    onProfileDisconnected,
    onLayoutSelected
  } = deps;

  const httpWarnings = new Set<string>();

  return [
    ...registerConnectionDiagnosticCommands(deps),
    vscode.commands.registerCommand('filemakerDataApiTools.addConnectionProfile', async () => {
      if (!(await roleGuard.assertFeature('writeOperations', 'Add Connection Profile'))) {
        return;
      }

      ConnectionWizardPanel.createOrShow(context, profileStore, secretStore, fmClient, logger, undefined, {
        getTestPolicy: deps.getConnectionWizardTestPolicy
      });
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.editConnectionProfile', async (arg: unknown) => {
      const profile = await resolveProfileFromArg(arg, profileStore);
      if (!profile) {
        return;
      }
      if (roleGuard.isProfileLocked(profile.id)) {
        vscode.window.showWarningMessage('This profile is locked by enterprise configuration.');
        return;
      }
      if (!(await roleGuard.assertFeature('writeOperations', 'Edit Connection Profile'))) {
        return;
      }

      ConnectionWizardPanel.createOrShow(context, profileStore, secretStore, fmClient, logger, profile, {
        getTestPolicy: deps.getConnectionWizardTestPolicy
      });
    }),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.removeConnectionProfile',
      async (arg: unknown) => {
        const profile = await resolveProfileFromArg(arg, profileStore);
        if (!profile) {
          return;
        }
        if (roleGuard.isProfileLocked(profile.id)) {
          vscode.window.showWarningMessage('This profile is locked by enterprise configuration.');
          return;
        }
        if (!(await roleGuard.assertFeature('writeOperations', 'Remove Connection Profile'))) {
          return;
        }

        const confirmation = await vscode.window.showWarningMessage(
          `Remove profile "${profile.name}" and all associated secrets?`,
          { modal: true },
          'Remove'
        );

        if (confirmation !== 'Remove') {
          return;
        }

        await fmClient.deleteSession(profile);
        await profileStore.removeProfile(profile.id);
        await savedQueriesStore.removeQueriesForProfile(profile.id);
        await secretStore.clearProfileSecrets(profile.id);

        fmClient.invalidateProfileCache(profile.id);
        onProfileDisconnected?.(profile.id);

        refreshExplorer();
        refreshConnectionStatus?.();
        vscode.window.showInformationMessage(`Removed profile "${profile.name}".`);
      }
    ),

    vscode.commands.registerCommand('filemakerDataApiTools.connect', async (arg: unknown) => {
      const profile = await resolveProfileFromArg(arg, profileStore);
      if (!profile) {
        return;
      }

      const target = profile.authMode === 'proxy' ? profile.proxyEndpoint ?? profile.serverUrl : profile.serverUrl;
      if (isUnencryptedRemoteUrl(target) && !httpWarnings.has(profile.id)) {
        httpWarnings.add(profile.id);
        void vscode.window.showWarningMessage(
          'This connection uses remote http://. Your password, API key and session data travel unencrypted and could be read on the network. Use https:// when possible.'
        );
      }

      const policy: BackoffPolicy = deps.getConnectBackoffPolicy?.() ?? {
        maxRetries: 3,
        initialMs: 1_000,
        maxMs: 30_000,
        multiplier: 2
      };

      const runConnect = async (): Promise<void> => {
        const statusBar = vscode.window.createStatusBarItem(
          vscode.StatusBarAlignment.Left,
          110
        );
        try {
          statusBar.text = `$(sync~spin) FileMaker: Connecting to ${profile.name}…`;
          statusBar.show();

          const { retryWithBackoff } = await import('../utils/backoff');
          await retryWithBackoff(
            () => fmClient.createSession(profile, { userInitiated: true }),
            policy,
            {
              shouldRetry: (err) => isRetryableConnectError(err),
              onRetry: ({ attempt, delayMs, error }) => {
                const seconds = Math.max(1, Math.round(delayMs / 1000));
                statusBar.text = `$(sync~spin) FileMaker: Connecting to ${profile.name} — retry ${attempt + 1}/${policy.maxRetries} in ${seconds}s`;
                logger.warn('Connect attempt failed; retrying with backoff.', {
                  profileId: profile.id,
                  attempt,
                  delayMs,
                  error
                });
              }
            }
          );

          await profileStore.setActiveProfileId(profile.id);
          refreshExplorer();
          refreshConnectionStatus?.();
          vscode.window.showInformationMessage(`Connected to "${profile.name}".`);

          if (onLayoutSelected) {
            try {
              const layout = await promptForLayout(profile, fmClient);
              if (layout) {
                onLayoutSelected(profile.id, layout);
                await vscode.commands.executeCommand('filemakerLayoutInspector.focus');
              }
            } catch (error) {
              logger.warn('Failed to select a layout for the inspector after connect.', {
                profileId: profile.id,
                error
              });
            }
          }
        } catch (error) {
          await showCommandError(error, {
            fallbackMessage: 'Failed to connect to FileMaker profile.',
            logger,
            logMessage: 'Connect command failed.',
            actions: {
              retry: runConnect,
              profileId: profile.id,
              settingsKey: 'filemaker.requestTimeoutMs'
            }
          });
        } finally {
          statusBar.dispose();
        }
      };

      await runConnect();
    }),

    // Behind the "Trust this certificate…" / "Review and re-trust" button on error toasts: shows the
    // certificate the server presents now and, if the user agrees, pins it for this profile.
    vscode.commands.registerCommand('filemakerDataApiTools.trustServerCertificate', async (arg: unknown) => {
      const profile = await resolveProfileFromArg(arg, profileStore, true);
      if (!profile) {
        return;
      }
      const networkCode = (arg as { networkCode?: string } | undefined)?.networkCode;
      const decision = await reviewAndTrustCertificate(profile, {
        networkCode,
        previousSha256: profile.pinnedCertSha256
      });
      if (!decision) {
        return;
      }
      await profileStore.upsertProfile(withPinnedCertificate(profile, decision));
      fmClient.clearAuthPause(profile.id);
      refreshExplorer();
      const connect = await vscode.window.showInformationMessage(
        `Certificate trusted for "${profile.name}". Connect now?`,
        'Connect'
      );
      if (connect === 'Connect') {
        await vscode.commands.executeCommand('filemakerDataApiTools.connect', { profileId: profile.id });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.openConnectionMenu', async () => {
      // Backing command for the persistent connection status-bar item. Pops a
      // quick-pick of contextual actions (Disconnect / Switch / Open Explorer /
      // Add Profile) and dispatches to the appropriate existing command.
      await showConnectionQuickPick(profileStore);
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.disconnect', async (arg: unknown) => {
      const profile = await resolveProfileFromArg(arg, profileStore, true);
      if (!profile) {
        return;
      }

      try {
        await fmClient.deleteSession(profile);

        if (profileStore.getActiveProfileId() === profile.id) {
          await profileStore.setActiveProfileId(undefined);
        }

        onProfileDisconnected?.(profile.id);
        refreshExplorer();
        refreshConnectionStatus?.();
        vscode.window.showInformationMessage(`Disconnected from "${profile.name}".`);
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to disconnect from FileMaker profile.',
          logger,
          logMessage: 'Disconnect command failed.'
        });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.listLayouts', async (arg: unknown) => {
      const profile = await resolveProfileFromArg(arg, profileStore, true);
      if (!profile) {
        return;
      }

      try {
        const layouts = await fmClient.listLayouts(profile);
        await openJsonDocument({
          profile: profile.name,
          database: profile.database,
          layouts
        });
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to list layouts.',
          logger,
          logMessage: 'List layouts command failed.'
        });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.runFindJson', async (arg: unknown) => {
      const selection = await resolveLayoutContext(arg, profileStore, fmClient);
      if (!selection) {
        return;
      }
      const { profile, layout } = selection;

      const findJsonInput = await vscode.window.showInputBox({
        title: 'Run Find',
        prompt: 'Enter find query JSON array',
        value: '[{}]',
        ignoreFocusOut: true,
        validateInput: (value) => parseFindJson(value).error
      });
      if (!findJsonInput) {
        return;
      }

      const sortJsonInput = await vscode.window.showInputBox({
        title: 'Run Find',
        prompt: 'Enter sort JSON array (optional)',
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() ? parseSortJson(value).error : undefined
      });
      if (sortJsonInput === undefined) {
        return;
      }

      const limitInput = await vscode.window.showInputBox({
        title: 'Run Find',
        prompt: 'Enter limit (optional)',
        ignoreFocusOut: true,
        validateInput: (value) => validateOptionalInteger(value, 'Limit')
      });
      if (limitInput === undefined) {
        return;
      }

      const offsetInput = await vscode.window.showInputBox({
        title: 'Run Find',
        prompt: 'Enter offset (optional)',
        ignoreFocusOut: true,
        validateInput: (value) => validateOptionalInteger(value, 'Offset')
      });
      if (offsetInput === undefined) {
        return;
      }

      try {
        const findValidation = parseFindJson(findJsonInput);
        if (!findValidation.ok || !findValidation.value) {
          throw new Error(findValidation.error ?? 'Find JSON is invalid.');
        }

        let sortValidationValue: Array<Record<string, unknown>> | undefined;

        if (sortJsonInput && sortJsonInput.trim().length > 0) {
          const sortValidation = parseSortJson(sortJsonInput);
          if (!sortValidation.ok || !sortValidation.value) {
            throw new Error(sortValidation.error ?? 'Sort JSON is invalid.');
          }

          sortValidationValue = sortValidation.value;
        }

        const request: FindRecordsRequest = {
          query: findValidation.value,
          sort: sortValidationValue,
          limit: parseOptionalPositiveInteger(limitInput, 'Limit'),
          offset: parseOptionalPositiveInteger(offsetInput, 'Offset')
        };

        const result = await fmClient.findRecords(profile, layout, request);
        if (result.scriptErrors && result.scriptErrors.length > 0) {
          void vscode.window.showWarningMessage(`The find worked, but ${describeScriptErrors(result.scriptErrors)}.`);
        }
        await openJsonDocument({
          profile: profile.name,
          layout,
          request,
          result
        });
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to run find query.',
          logger,
          logMessage: 'Run find command failed.'
        });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.getRecordById', async (arg: unknown) => {
      const selection = await resolveLayoutContext(arg, profileStore, fmClient);
      if (!selection) {
        return;
      }
      const { profile, layout } = selection;

      const recordId = await vscode.window.showInputBox({
        title: 'Get Record by ID',
        prompt: 'Enter FileMaker record ID',
        ignoreFocusOut: true,
        validateInput: (value) => validateRecordId(value).error
      });

      if (!recordId) {
        return;
      }

      try {
        const record = await fmClient.getRecord(profile, layout, recordId);
        await openJsonDocument({
          profile: profile.name,
          layout,
          record
        });
      } catch (error) {
        await showCommandError(error, {
          fallbackMessage: 'Failed to get record by ID.',
          logger,
          logMessage: 'Get record command failed.'
        });
      }
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.openRecordViewer', async (arg: unknown) => {
      const selection = await resolveLayoutContext(arg, profileStore, fmClient);
      if (!selection) {
        return;
      }
      const { profile, layout } = selection;
      const profileId = profile.id;
      const knownRecordId = parseRecordIdArg(arg);
      if (knownRecordId) {
        RecordViewerPanel.createOrShow(context, profileStore, fmClient, logger, {
          profileId,
          layout,
          recordId: knownRecordId
        });
        return;
      }
      const enteredRecordId = await vscode.window.showInputBox({
        title: 'Open Record Viewer',
        prompt: 'Record ID (optional; leave blank to browse)',
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() ? validateRecordId(value).error : undefined
      });
      if (enteredRecordId === undefined) {
        return;
      }
      const recordId = enteredRecordId.trim() || undefined;

      RecordViewerPanel.createOrShow(context, profileStore, fmClient, logger, {
        profileId,
        layout,
        recordId
      });
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.openQueryBuilder', async (arg: unknown) => {
      const contextArg = parseLayoutArg(arg);
      QueryBuilderPanel.createOrShow(context, profileStore, savedQueriesStore, fmClient, logger, {
        profileId: contextArg.profileId,
        layout: contextArg.layout
      });
    }),

    vscode.commands.registerCommand('filemakerDataApiTools.refreshExplorer', () => {
      refreshExplorer();
    })
  ];
}

function validateOptionalInteger(value: string, label: string): string | undefined {
  try {
    parseOptionalPositiveInteger(value, label);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : `${label} must be a positive integer.`;
  }
}
