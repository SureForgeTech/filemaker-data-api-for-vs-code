import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RecordViewerPanel } from '../../../src/webviews/recordViewer';

/**
 * Which message of the Record Viewer reaches which service, what the panel answers, and what it
 * refuses. The panel is not changed here: every expectation reads what the code does today.
 */

type Handler = (message: unknown) => void;

const profile = {
  id: 'p1',
  name: 'Production',
  authMode: 'direct' as const,
  serverUrl: 'https://fm.example.com',
  database: 'Sales'
};

const loadedRecord = {
  recordId: '7',
  modId: '3',
  fieldData: { Status: 'Open' }
};

interface Overrides {
  listProfiles?: () => Promise<unknown[]>;
  getProfile?: (id: string) => Promise<unknown>;
  listLayouts?: () => Promise<string[]>;
  getRecord?: () => Promise<unknown>;
  getLayoutMetadata?: () => Promise<unknown>;
}

/** Lets every pending promise of the panel settle before the expectations run. */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function open(overrides: Overrides = {}) {
  let handler: Handler | undefined;
  let onDispose: (() => void) | undefined;
  const posted: Array<Record<string, unknown>> = [];
  const reveal = vi.fn();

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
    reveal,
    onDidDispose: (callback: () => void) => {
      onDispose = callback;
      return { dispose: vi.fn() };
    }
  } as never);

  const fmClient = {
    listLayouts: vi.fn(overrides.listLayouts ?? (async () => ['Contacts'])),
    getRecord: vi.fn(overrides.getRecord ?? (async () => loadedRecord)),
    getLayoutMetadata: vi.fn(
      overrides.getLayoutMetadata ?? (async () => ({ fieldMetaData: [{ name: 'Status', result: 'text' }] }))
    )
  };
  const profileStore = {
    listProfiles: vi.fn(overrides.listProfiles ?? (async () => [profile])),
    getProfile: vi.fn(overrides.getProfile ?? (async (id: string) => (id === profile.id ? profile : undefined))),
    getActiveProfileId: vi.fn(() => profile.id)
  };
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

  (RecordViewerPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  RecordViewerPanel.createOrShow(
    { extensionUri: { fsPath: '/ext' } } as never,
    profileStore as never,
    fmClient as never,
    logger as never
  );

  const send = async (message: unknown): Promise<void> => {
    handler?.(message);
    await flush();
  };

  return {
    send,
    posted,
    reveal,
    fmClient,
    profileStore,
    logger,
    close: () => onDispose?.()
  };
}

describe('Record Viewer: message routing', () => {
  let panel: ReturnType<typeof open>;

  beforeEach(() => {
    vi.clearAllMocks();
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (_key: string, defaultValue?: unknown) => defaultValue
    } as never);
    panel = open();
  });

  afterEach(() => {
    panel.close();
    (RecordViewerPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  });

  describe('every message reaches its handler', () => {
    it('answers "ready" with the profiles it knows', async () => {
      await panel.send({ type: 'ready' });

      expect(panel.posted).toContainEqual({
        type: 'init',
        payload: {
          profiles: [{ id: 'p1', name: 'Production', serverOrigin: 'https://fm.example.com', database: 'Sales', authMode: 'direct' }],
          activeProfileId: 'p1'
        }
      });
      expect(panel.fmClient.getRecord).not.toHaveBeenCalled();
    });

    it('answers "loadLayouts" with the layouts of that profile', async () => {
      await panel.send({ type: 'loadLayouts', profileId: 'p1' });

      expect(panel.fmClient.listLayouts).toHaveBeenCalledWith(profile);
      expect(panel.posted).toContainEqual({ type: 'layoutsLoaded', payload: { profileId: 'p1', layouts: ['Contacts'] } });
    });

    it('answers "loadRecord" with the record and its presentation fields', async () => {
      await panel.send({ type: 'loadRecord', payload: { profileId: 'p1', layout: 'Contacts', recordId: '7' } });

      expect(panel.fmClient.getRecord).toHaveBeenCalledWith(profile, 'Contacts', '7');
      expect(panel.posted).toContainEqual(
        expect.objectContaining({
          type: 'recordLoaded',
          payload: expect.objectContaining({
            profileId: 'p1',
            layout: 'Contacts',
            record: loadedRecord
          })
        })
      );
    });

    it('answers "exportRecord" by opening the loaded record as JSON', async () => {
      await panel.send({ type: 'loadRecord', payload: { profileId: 'p1', layout: 'Contacts', recordId: '7' } });
      await panel.send({ type: 'exportRecord' });

      expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({
        language: 'json',
        content: JSON.stringify({ profileId: 'p1', layout: 'Contacts', record: loadedRecord }, null, 2)
      });
      expect(vscode.window.showTextDocument).toHaveBeenCalled();
    });

    it('answers "copyRecordRequest" with the request on the clipboard', async () => {
      await panel.send({
        type: 'copyRecordRequest',
        payload: { profileId: 'p1', layout: 'Contacts', recordId: '7', operation: 'get', format: 'curl' }
      });

      expect(vi.mocked(vscode.env.clipboard.writeText)).toHaveBeenCalledTimes(1);
      expect(String(vi.mocked(vscode.env.clipboard.writeText).mock.calls.at(-1)?.[0])).toContain('curl -X GET ');
    });
  });

  describe('a message the panel cannot use is ignored', () => {
    it('reaches no service when the type is unknown', async () => {
      await panel.send({ type: 'somethingElse', payload: { profileId: 'p1' } });

      expect(panel.posted).toEqual([]);
      expect(panel.profileStore.listProfiles).not.toHaveBeenCalled();
      expect(panel.profileStore.getProfile).not.toHaveBeenCalled();
      expect(panel.fmClient.listLayouts).not.toHaveBeenCalled();
      expect(panel.fmClient.getRecord).not.toHaveBeenCalled();
      expect(vi.mocked(vscode.env.clipboard.writeText)).not.toHaveBeenCalled();
    });

    it('ignores a message that is not an object, or that has no type', async () => {
      for (const message of [null, 'ready', 42, { payload: { profileId: 'p1' } }]) {
        await panel.send(message);
      }

      expect(panel.posted).toEqual([]);
      expect(panel.profileStore.listProfiles).not.toHaveBeenCalled();
    });

    it('ignores "loadLayouts" without a profile id', async () => {
      await panel.send({ type: 'loadLayouts' });
      await panel.send({ type: 'loadLayouts', profileId: 42 });

      expect(panel.posted).toEqual([]);
      expect(panel.fmClient.listLayouts).not.toHaveBeenCalled();
    });

    it('ignores a record request whose payload is not usable', async () => {
      const refused = [
        { type: 'loadRecord', payload: 'not an object' },
        { type: 'loadRecord', payload: { profileId: 'p1', layout: 'Contacts' } },
        { type: 'copyRecordRequest', payload: { profileId: 'p1', layout: 'Contacts', recordId: '7' } }
      ];

      for (const message of refused) {
        await panel.send(message);
      }

      expect(panel.posted).toEqual([]);
      expect(panel.fmClient.getRecord).not.toHaveBeenCalled();
      expect(vi.mocked(vscode.env.clipboard.writeText)).not.toHaveBeenCalled();
    });
  });

  describe('a failure is posted to the webview as an error', () => {
    it('reports a profile that no longer exists when the layouts are asked for', async () => {
      await panel.send({ type: 'loadLayouts', profileId: 'gone' });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'The selected connection profile could not be found.' });
      expect(panel.fmClient.listLayouts).not.toHaveBeenCalled();
    });

    it('reports layouts that cannot be listed, and logs it', async () => {
      panel.fmClient.listLayouts.mockRejectedValueOnce(new Error('Layouts are unavailable.'));

      await panel.send({ type: 'loadLayouts', profileId: 'p1' });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'Layouts are unavailable.' });
      expect(panel.logger.error).toHaveBeenCalledWith('Failed to load layouts for record viewer.', {
        profileId: 'p1',
        error: expect.any(Error)
      });
    });

    it('reports a profile that no longer exists when the record is asked for', async () => {
      await panel.send({ type: 'loadRecord', payload: { profileId: 'gone', layout: 'Contacts', recordId: '7' } });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'The selected profile no longer exists.' });
      expect(panel.fmClient.getRecord).not.toHaveBeenCalled();
    });

    it('reports a profile that no longer exists when a request is copied', async () => {
      await panel.send({
        type: 'copyRecordRequest',
        payload: { profileId: 'gone', layout: 'Contacts', recordId: '7', operation: 'get', format: 'curl' }
      });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'The selected profile no longer exists.' });
      expect(vi.mocked(vscode.env.clipboard.writeText)).not.toHaveBeenCalled();
    });

    it('reports that there is no record to export', async () => {
      await panel.send({ type: 'exportRecord' });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'No record loaded yet.' });
      expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    });

    it('reports a failure inside the request in the panel error shape', async () => {
      panel.close();
      panel = open({ listProfiles: async () => { throw new Error('Profiles are unavailable.'); } });

      await panel.send({ type: 'ready' });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'Profiles are unavailable.' });
      expect(panel.logger.error).toHaveBeenCalledWith('Record viewer request failed.', { type: 'ready', error: expect.any(Error) });
    });

    it('reports a failure that is not an Error with a plain reason', async () => {
      panel.close();
      panel = open({ listProfiles: async () => { throw 'the socket closed'; } });

      await panel.send({ type: 'ready' });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'Unknown error while processing record viewer request.' });
    });
  });

  describe('the panel is opened once and reused', () => {
    it('reveals the open panel and sends the new state instead of opening a second one', async () => {
      await panel.send({ type: 'ready' });
      const before = panel.posted.length;

      RecordViewerPanel.createOrShow(
        { extensionUri: { fsPath: '/ext' } } as never,
        panel.profileStore as never,
        panel.fmClient as never,
        panel.logger as never,
        { profileId: 'p2' }
      );
      await flush();

      expect(vi.mocked(vscode.window.createWebviewPanel)).toHaveBeenCalledTimes(1);
      expect(panel.reveal).toHaveBeenCalledTimes(1);
      expect(panel.posted.length).toBeGreaterThan(before);
      expect(panel.posted.slice(before)).toContainEqual(
        expect.objectContaining({ type: 'init', payload: expect.objectContaining({ defaults: { profileId: 'p2' } }) })
      );
    });
  });
});
