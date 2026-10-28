import { isAbsolute, join } from 'path';

import * as vscode from 'vscode';

import type { AiMcpController } from '../ai/mcp/aiMcpController';
import { buildMcpConfig, discoveryDirectory, installShim } from '../ai/mcp/mcpConfig';
import { toUserErrorMessage } from '../utils/errorUx';

export const TOGGLE_SERVER_COMMAND = 'filemakerDataApiTools.toggleAiServer';
export const COPY_MCP_CONFIG_COMMAND = 'filemakerDataApiTools.copyAiMcpConfig';

interface Deps {
  controller: AiMcpController;
  extensionPath: string;
  globalStoragePath: string | undefined;
  isEnabled: () => boolean;
  refresh: () => void;
}

const START_DETAIL =
  'This starts a local server in THIS window only. Programs running as you (such as Claude Code or Cursor, once you give them the config) can connect to it with a secret token. Everything the AI tools can do is limited by your AI settings, layout approvals and write dialogs, and what they read goes to the model provider behind that program.\n\nThis workspace will start the server automatically each time you open it, as long as filemaker.ai.externalServer.enabled stays on in your user settings, until you run this command again to stop it. Other windows are not affected; run the command there to use it there.';
const SETTING_DETAIL =
  '\n\nThe setting filemaker.ai.externalServer.enabled in your user settings is only a permission. It is turned on now. Turning it off later stops the server in every window and ends the automatic start for every workspace.';

export function registerAiMcpCommands(deps: Deps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(TOGGLE_SERVER_COMMAND, async () => {
      try {
        if (deps.controller.isRunning()) {
          await deps.controller.stopHere();
          void vscode.window.showInformationMessage(
            'The AI server for external tools is stopped in this window and will not start again here until you start it.'
          );
        } else {
          // Any caller can run this command (an agent, another extension). Starting, and
          // remembering to start again, therefore always needs this dialog.
          const needsSetting = !deps.isEnabled();
          const label = needsSetting ? 'Turn On and Start' : 'Start Here';
          const choice = await vscode.window.showWarningMessage(
            'Start the AI server for external tools (Claude Code, Cursor) in this window?',
            { modal: true, detail: needsSetting ? START_DETAIL + SETTING_DETAIL : START_DETAIL },
            label
          );
          if (choice !== label) {
            return;
          }
          if (needsSetting) {
            await vscode.workspace
              .getConfiguration('filemaker')
              .update('ai.externalServer.enabled', true, vscode.ConfigurationTarget.Global);
          }
          await deps.controller.startHere();
          void vscode.window.showInformationMessage(
            'The AI server for external tools is running in this window. It starts again when you reopen this workspace until you stop it here. Use "FileMaker: Copy MCP Config for Claude Code / Cursor" to connect a client.'
          );
        }
      } catch (error) {
        void vscode.window.showErrorMessage(toUserErrorMessage(error));
      }
      deps.refresh();
    }),

    vscode.commands.registerCommand(COPY_MCP_CONFIG_COMMAND, async () => {
      const storage = deps.globalStoragePath;
      if (!storage || !isAbsolute(storage)) {
        void vscode.window.showErrorMessage('The extension\'s storage folder is not available, so there is no config to copy.');
        return;
      }
      // The extension folder's name changes with every version; a copy in storage does not.
      // path-join disposition: every segment is a compile-time constant under the extension folder, so no input can change the path.
      const shim = await installShim(join(deps.extensionPath, 'dist', 'aiMcpShim.js'), storage);
      const config = buildMcpConfig({
        shimPath: shim.path,
        discoveryDir: discoveryDirectory(storage),
        workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      });
      await vscode.env.clipboard.writeText(JSON.stringify(config, null, 2));
      void vscode.window.showInformationMessage(
        `MCP config copied. Paste it into your Claude Code .mcp.json (or run "claude mcp add-json filemaker" with the filemaker entry) or Cursor mcp.json. It needs Node.js 18 or newer on your PATH. The server must be running in this window, and what the tools read goes to your AI model provider.${
          shim.stable ? ' The shim path is kept up to date when the extension updates.' : ' The shim path points into the extension folder; copy the config again after the extension updates.'
        }`
      );
    })
  ];
}

/**
 * When the permission setting is turned off, the server in this window stops and the "started
 * here" flag is cleared. The setting is only a permission; it never starts anything.
 */
export function watchExternalServerSetting(deps: {
  onDidChangeConfiguration: (listener: (event: { affectsConfiguration(section: string): boolean }) => unknown) => vscode.Disposable;
  controller: Pick<AiMcpController, 'handleSettingChange'>;
  log?: (message: string) => void;
}): vscode.Disposable {
  return deps.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('filemaker.ai.externalServer')) {
      deps.controller.handleSettingChange().catch((error: Error) => deps.log?.(`AI server settings change failed: ${error.message}`));
    }
  });
}
