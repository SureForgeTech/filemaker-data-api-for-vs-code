import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FMClientError } from '../../../src/services/errors';
import { generateSnippet } from '../../../src/snippets';
import { ScriptRunnerPanel } from '../../../src/webviews/scriptRunner';
import { InMemoryMemento } from '../mocks';
import { directProfile } from '../snippets/fixtures';

/**
 * Which message of the Script Runner reaches which handler, what the panel answers, and what it
 * refuses. The panel is not changed here: every expectation reads what the code does today.
 */

type Handler = (message: unknown) => void;

const profile = { ...directProfile, id: 'p1' };
const script = { profileId: 'p1', layout: 'Contacts', scriptName: 'Send Welcome' };

function open() {
  let handler: Handler | undefined;
  let onDispose: (() => void) | undefined;
  const posted: Array<Record<string, unknown>> = [];

  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
    webview: {
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: vi.fn(async (message: Record<string, unknown>) => {
        posted.push(message);
        return true;
      }),
      onDidReceiveMessage: (callback: Handler) => {
        handler = callback;
        return { dispose: vi.fn() };
      }
    },
    reveal: vi.fn(),
    onDidDispose: (callback: () => void) => {
      onDispose = callback;
      return { dispose: vi.fn() };
    }
  } as never);

  const fmClient = {
    listLayouts: vi.fn(async () => ['Contacts']),
    runScript: vi.fn(async () => ({ response: { scriptResult: 'done' }, messages: [{ code: '0', message: 'OK' }] }))
  };
  const profileStore = {
    listProfiles: vi.fn(async () => [profile]),
    getProfile: vi.fn(async (id: string) => (id === profile.id ? profile : undefined)),
    getActiveProfileId: vi.fn(() => profile.id)
  };
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

  (ScriptRunnerPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  ScriptRunnerPanel.createOrShow(
    { extensionUri: { fsPath: '/ext' }, workspaceState: new InMemoryMemento() } as never,
    profileStore as never,
    fmClient as never,
    logger as never
  );

  const send = async (message: unknown): Promise<void> => {
    handler?.(message);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const runner = (ScriptRunnerPanel as unknown as { currentPanel: { requestInFlight: boolean } }).currentPanel;
    await vi.waitFor(() => expect(runner.requestInFlight).toBe(false));
  };

  const copied = (): string => String(vi.mocked(vscode.env.clipboard.writeText).mock.calls.at(-1)?.[0]);

  return { send, posted, fmClient, profileStore, logger, copied, close: () => onDispose?.() };
}

describe('Script Runner: message routing', () => {
  let panel: ReturnType<typeof open>;

  beforeEach(() => {
    vi.clearAllMocks();
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
    panel = open();
  });

  afterEach(() => {
    panel.close();
  });

  it('logs only the script name, exact layout and error code on failure', async () => {
    panel.fmClient.runScript.mockRejectedValue(new FMClientError('private server detail', {
      code: '102', details: { response: 'private response' }
    }));
    await panel.send({ type: 'runScript', payload: { ...script, scriptParam: 'private parameter' } });
    expect(panel.logger.warn).toHaveBeenCalledWith('Script runner failed.', {
      scriptName: script.scriptName, layout: script.layout, code: '102'
    });
    expect(JSON.stringify(panel.logger.warn.mock.calls)).not.toContain('private');
  });

  describe('every message reaches its handler', () => {
    it('answers "ready" with the init message', async () => {
      await panel.send({ type: 'ready' });
      expect(panel.posted).toContainEqual(
        expect.objectContaining({
          type: 'init',
          payload: expect.objectContaining({
            profiles: [expect.objectContaining({ id: 'p1', name: 'Production', database: 'Sales DB', authMode: 'direct' })],
            activeProfileId: 'p1',
            scriptRunnerEnabled: true,
            includeAuthByDefault: false,
            parameterBuilderEnabled: true
          })
        })
      );
      expect(panel.fmClient.runScript).not.toHaveBeenCalled();
    });

    it('answers "loadLayouts" with the layouts of that profile', async () => {
      await panel.send({ type: 'loadLayouts', profileId: 'p1' });
      expect(panel.fmClient.listLayouts).toHaveBeenCalledWith(profile);
      expect(panel.posted).toContainEqual({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Contacts'] } });
    });

    it('answers "runScript" with the result of the script', async () => {
      await panel.send({ type: 'runScript', payload: script });
      expect(panel.fmClient.runScript).toHaveBeenCalledWith(profile, expect.objectContaining({ layout: 'Contacts', scriptName: 'Send Welcome' }));
      expect(panel.posted).toContainEqual(
        expect.objectContaining({ type: 'scriptResult', payload: expect.objectContaining({ profileId: 'p1' }) })
      );
    });

    it('answers "copyCurl" with a curl command on the clipboard, and runs no script', async () => {
      await panel.send({ type: 'copyCurl', payload: script });
      expect(vi.mocked(vscode.env.clipboard.writeText)).toHaveBeenCalledTimes(1);
      expect(panel.copied()).toContain('curl -X GET ');
      expect(panel.fmClient.runScript).not.toHaveBeenCalled();
    });

    it('answers "copyFetch" with a fetch snippet on the clipboard, and runs no script', async () => {
      await panel.send({ type: 'copyFetch', payload: script });
      expect(vi.mocked(vscode.env.clipboard.writeText)).toHaveBeenCalledTimes(1);
      expect(panel.copied()).toContain('await fetch(');
      expect(panel.fmClient.runScript).not.toHaveBeenCalled();
    });

    it('answers "copyRequest" with the format the message asks for, and runs no script', async () => {
      await panel.send({ type: 'copyRequest', payload: { ...script, format: 'http' } });
      expect(vi.mocked(vscode.env.clipboard.writeText)).toHaveBeenCalledWith(
        generateSnippet(profile, { kind: 'runScript', layout: 'Contacts', scriptName: 'Send Welcome' }, 'http')
      );
      expect(panel.fmClient.runScript).not.toHaveBeenCalled();
    });
  });

  describe('a message the panel cannot use is ignored', () => {
    it('ignores a message of an unknown type', async () => {
      await panel.send({ type: 'somethingElse', payload: script });
      expect(panel.posted).toEqual([]);
      expect(panel.fmClient.listLayouts).not.toHaveBeenCalled();
      expect(panel.fmClient.runScript).not.toHaveBeenCalled();
      expect(vi.mocked(vscode.env.clipboard.writeText)).not.toHaveBeenCalled();
    });

    it('ignores a message that is not an object', async () => {
      for (const message of [null, 'ready', 42]) {
        await panel.send(message);
      }
      expect(panel.posted).toEqual([]);
      expect(panel.fmClient.runScript).not.toHaveBeenCalled();
    });

    it('ignores "loadLayouts" without a profile id', async () => {
      await panel.send({ type: 'loadLayouts' });
      await panel.send({ type: 'loadLayouts', profileId: 42 });
      expect(panel.posted).toEqual([]);
      expect(panel.fmClient.listLayouts).not.toHaveBeenCalled();
    });

    it('ignores "runScript" without a script name', async () => {
      await panel.send({ type: 'runScript', payload: { profileId: 'p1', layout: 'Contacts' } });
      expect(panel.posted).toEqual([]);
      expect(panel.fmClient.runScript).not.toHaveBeenCalled();
    });

    it('ignores "copyRequest" without a format it knows', async () => {
      await panel.send({ type: 'copyRequest', payload: script });
      await panel.send({ type: 'copyRequest', payload: { ...script, format: 'cobol' } });
      expect(panel.posted).toEqual([]);
      expect(vi.mocked(vscode.env.clipboard.writeText)).not.toHaveBeenCalled();
    });
  });

  describe('a failure is posted to the webview as an error', () => {
    it('reports a profile that no longer exists', async () => {
      await panel.send({ type: 'loadLayouts', profileId: 'gone' });
      expect(panel.posted).toContainEqual({ type: 'error', message: 'Connection profile not found.' });
      expect(panel.fmClient.listLayouts).not.toHaveBeenCalled();
    });

    it('reports layouts that cannot be listed', async () => {
      panel.fmClient.listLayouts.mockImplementationOnce(async () => {
        throw new Error('Layouts are unavailable.');
      });
      await panel.send({ type: 'loadLayouts', profileId: 'p1' });
      expect(panel.posted).toContainEqual({ type: 'error', message: 'Layouts are unavailable.' });
    });

    it('reports a script that cannot be run, and logs it', async () => {
      panel.fmClient.runScript.mockImplementationOnce(async () => {
        throw new Error('The script could not be run.');
      });
      await panel.send({ type: 'runScript', payload: script });
      expect(panel.posted).toContainEqual({ type: 'error', message: 'The script could not be run.' });
      expect(panel.logger.warn).toHaveBeenCalledWith('Script runner failed.', expect.anything());
    });

    it('reports a request that cannot be built, and copies nothing', async () => {
      // The format is required for "copyRequest"; without it the message is ignored before the handler runs.
      await panel.send({ type: 'copyRequest', payload: { ...script, scriptName: '.', format: 'http' } });
      expect(vi.mocked(vscode.env.clipboard.writeText)).not.toHaveBeenCalled();
      expect(panel.posted).toContainEqual(
        expect.objectContaining({ type: 'error', message: expect.stringContaining('cannot be used in a request') })
      );
    });
  });
});
