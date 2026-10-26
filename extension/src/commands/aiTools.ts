import { join } from 'path';

import * as vscode from 'vscode';

import type { AuditLog } from '../ai/aiAudit';
import type { AiToolsController } from '../ai/aiRegistration';
import {
  KILL_SWITCH_COMMAND,
  NEW_SESSION_COMMAND,
  SET_ACCESS_COMMAND,
  SHOW_ACTIVITY_COMMAND,
  computeAiStatus
} from '../ai/aiRegistration';
import { readAiSettings, type HiddenFieldsProblemReporter } from '../ai/aiSettings';
import type { AiToolService } from '../ai/aiToolService';
import type { RoleGuard } from '../enterprise/roleGuard';
import type { ProfileStore } from '../services/profileStore';
import type { AiAccess, ConnectionProfile } from '../types/fm';
import { pickProfile } from './common';

interface Deps {
  service: AiToolService;
  controller: AiToolsController;
  audit: AuditLog;
  profileStore: ProfileStore;
  roleGuard: RoleGuard;
}

/** Status-bar item with the AI state; a click is the kill switch. */
export class AiStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  public constructor(
    private readonly deps: Pick<Deps, 'service' | 'controller' | 'profileStore'> & { reportHiddenFieldsProblem: HiddenFieldsProblemReporter },
    private readonly mcp?: { isRunning(): boolean; connectionCount(): number }
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.command = KILL_SWITCH_COMMAND;
    this.item.show();
    void this.refresh();
  }

  public async refresh(): Promise<void> {
    const settings = readAiSettings(vscode.workspace.getConfiguration('filemaker'), this.deps.reportHiddenFieldsProblem);
    const profile = settings.connection ? await this.deps.profileStore.getProfile(settings.connection) : undefined;
    const model = computeAiStatus(
      this.deps.service.listTools(),
      settings,
      this.deps.service.status(),
      profile?.username,
      profile?.aiAccess
    );
    const server = this.mcp?.isRunning() ? this.mcp.connectionCount() : undefined;
    this.item.text = server === undefined ? model.text : `${model.text} \u00b7 MCP`;
    this.item.tooltip =
      server === undefined ? model.tooltip : `${model.tooltip}\nExternal tools (MCP) server: running, ${server} connection${server === 1 ? '' : 's'}.`;
  }

  public dispose(): void {
    this.item.dispose();
  }
}

export function registerAiToolCommands(deps: Deps & { statusBar: AiStatusBar }): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(KILL_SWITCH_COMMAND, async () => {
      // Any caller can run this command (another extension, a keybinding), so switching OFF is
      // immediate and switching back ON asks in a modal dialog.
      if (deps.service.isKilled()) {
        const choice = await vscode.window.showWarningMessage(
          'Switch AI tools back on?',
          { modal: true, detail: 'AI tools will be available again with the same session limits and layout approvals as before.' },
          'Switch On'
        );
        if (choice !== 'Switch On') {
          return;
        }
        deps.service.setKilled(false);
      } else {
        // Nothing to switch off when AI is not on: setting the switch here would leave the
        // tools off later, after the user enables AI, until another click and a modal.
        const reason = deps.service.unavailableReason();
        if (reason || deps.service.listTools().length === 0) {
          // Name the true cause: turned off in settings, switched off by a policy switch,
          // enterprise policy, an untrusted workspace, offline mode, or no connection enabled.
          const settingsCause = reason?.includes('filemaker.ai.enabled') === true;
          const detail =
            reason ??
            'No connection is enabled for AI. Choose one with "FileMaker: Set AI Access for Connection".';
          const choice = await vscode.window.showInformationMessage(
            `AI tools are not available, so there is nothing to switch off. ${detail}`,
            ...(settingsCause ? ['Open AI Settings'] : [])
          );
          if (choice === 'Open AI Settings') {
            // AI settings are user-only (application scope): open the User tab, not the last-used one.
            await vscode.commands.executeCommand('workbench.action.openGlobalSettings', { query: 'filemaker.ai' });
          }
          return;
        }
        deps.service.setKilled(true);
      }
      deps.controller.refresh();
      await deps.statusBar.refresh();
      void vscode.window.showInformationMessage(
        deps.service.isKilled() ? 'AI tools are switched off.' : 'AI tools are switched back on.'
      );
    }),

    vscode.commands.registerCommand(NEW_SESSION_COMMAND, async () => {
      const choice = await vscode.window.showWarningMessage(
        'Start a new AI session?',
        {
          modal: true,
          detail:
            'This resets the record quota, the write counters and every layout approval. AI tools will ask again before reading a layout.'
        },
        'Start New Session'
      );
      if (choice !== 'Start New Session') {
        return;
      }
      deps.service.resetSession();
      await deps.statusBar.refresh();
      void vscode.window.showInformationMessage('Started a new AI session.');
    }),

    vscode.commands.registerCommand(SHOW_ACTIVITY_COMMAND, async () => {
      const text = await deps.audit.read();
      const document = await vscode.workspace.openTextDocument({
        content: text.length > 0 ? text : '(no AI tool activity recorded yet)\n',
        language: 'jsonc'
      });
      await vscode.window.showTextDocument(document, { preview: true });
    }),

    vscode.commands.registerCommand(SET_ACCESS_COMMAND, async () => {
      const profile = await pickProfile(deps.profileStore, false);
      if (!profile) {
        return;
      }
      if (deps.roleGuard.isProfileLocked(profile.id)) {
        void vscode.window.showWarningMessage('This connection is locked by enterprise policy and cannot be changed.');
        return;
      }

      const choice = await vscode.window.showQuickPick<{ label: string; description: string; detail: string; access: AiAccess }>(
        [
          { label: 'None', description: 'AI tools cannot use this connection', detail: 'The default.', access: 'none' },
          {
            label: 'Read',
            description: 'AI tools may read layouts, fields and records',
            detail: 'Each layout still needs your approval once per session.',
            access: 'read'
          },
          {
            label: 'Write',
            description: 'AI tools may also ask to change data',
            detail: 'Needs filemaker.ai.allowWrites. Every change asks you first.',
            access: 'write'
          }
        ],
        {
          title: `AI access for "${profile.name}"`,
          placeHolder: `Account: ${profile.username ?? 'not set'}. Use a dedicated FileMaker account with a read-only privilege set.`,
          ignoreFocusOut: true
        }
      );
      if (!choice) {
        return;
      }

      const updated: ConnectionProfile = { ...profile, aiAccess: choice.access === 'none' ? undefined : choice.access };
      await deps.profileStore.upsertProfile(updated);

      if (choice.access !== 'none') {
        const use = await vscode.window.showInformationMessage(
          `AI access for "${profile.name}" is ${choice.access}. FileMaker privilege sets are the only control that does not depend on the AI model or on you: connect with a dedicated account (now: ${profile.username ?? 'not set'}) that has a read-only privilege set. Use this connection for AI tools?`,
          'Use for AI Tools',
          'Not Now'
        );
        if (use === 'Use for AI Tools') {
          await vscode.workspace
            .getConfiguration('filemaker')
            .update('ai.connection', profile.id, vscode.ConfigurationTarget.Global);
        }
      }

      deps.controller.refresh();
      await deps.statusBar.refresh();
    })
  ];
}

export function auditLogPath(globalStoragePath: string): string {
  // path-join disposition: the file name is a fixed constant under the extension storage folder, so no input can change the path.
  return join(globalStoragePath, 'ai-audit.log');
}
