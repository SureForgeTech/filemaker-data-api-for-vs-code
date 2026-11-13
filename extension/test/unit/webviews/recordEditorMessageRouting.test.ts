import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RecordEditorPanel } from '../../../src/webviews/recordEditor';
import type { EditRecordResult } from '../../../src/types/fm';

/**
 * Which message of the Record Editor reaches which service, what the panel answers, and what it
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
  fieldData: { Status: 'Open', Email: 'a@example.com' }
};

const draftPayload = {
  profileId: 'p1',
  layout: 'Contacts',
  recordId: '7',
  originalFieldData: { Status: 'Open' },
  draftFieldData: { Status: 'Closed' }
};

interface Overrides {
  listProfiles?: () => Promise<unknown[]>;
  getProfile?: (id: string) => Promise<unknown>;
  listLayouts?: () => Promise<string[]>;
  getRecord?: () => Promise<unknown>;
  getFields?: () => Promise<unknown>;
}

/** Lets every pending promise of the panel settle before the expectations run. */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  // A write first reads the enterprise policy from disk, which takes longer than a timer tick on a
  // busy or slow machine (CI), so give that read a real moment to finish.
  await new Promise((resolve) => setTimeout(resolve, 30));
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
    editRecord: vi.fn(
      async (): Promise<EditRecordResult> => ({ recordId: '7', modId: '4', response: {}, messages: [] })
    ),
    createRecord: vi.fn(
      async (): Promise<EditRecordResult> => ({ recordId: '501', modId: '0', response: {}, messages: [] })
    )
  };
  const schemaService = {
    getFields: vi.fn(
      overrides.getFields ??
        (async () => ({
          supported: true,
          fields: [{ name: 'Status', type: 'normal', result: 'text' }],
          fromCache: false
        }))
    )
  };
  const profileStore = {
    listProfiles: vi.fn(overrides.listProfiles ?? (async () => [profile])),
    getProfile: vi.fn(overrides.getProfile ?? (async (id: string) => (id === profile.id ? profile : undefined))),
    getActiveProfileId: vi.fn(() => profile.id)
  };
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

  (RecordEditorPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  RecordEditorPanel.createOrShow(
    { extensionUri: { fsPath: '/ext' } } as never,
    profileStore as never,
    fmClient as never,
    schemaService as never,
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
    schemaService,
    profileStore,
    logger,
    close: () => onDispose?.()
  };
}

describe('Record Editor: message routing', () => {
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
    (RecordEditorPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  });

  describe('every message reaches its handler', () => {
    it('answers "ready" with the profiles it knows', async () => {
      await panel.send({ type: 'ready' });

      expect(panel.posted).toContainEqual({
        type: 'init',
        payload: {
          profiles: [{ id: 'p1', name: 'Production', serverOrigin: 'https://fm.example.com', database: 'Sales' }],
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

    it('answers "loadRecord" with the record and the fields of its layout', async () => {
      await panel.send({ type: 'loadRecord', payload: { profileId: 'p1', layout: 'Contacts', recordId: '7' } });

      expect(panel.fmClient.getRecord).toHaveBeenCalledWith(profile, 'Contacts', '7');
      expect(panel.schemaService.getFields).toHaveBeenCalledWith(profile, 'Contacts');
      expect(panel.posted).toContainEqual(
        expect.objectContaining({
          type: 'recordLoaded',
          payload: expect.objectContaining({
            profileId: 'p1',
            layout: 'Contacts',
            record: loadedRecord,
            fields: [expect.objectContaining({ name: 'Status' })],
            metadataSupported: true
          })
        })
      );
    });

    it('answers "validateDraft" with the validation of the draft', async () => {
      await panel.send({ type: 'validateDraft', payload: draftPayload });

      expect(panel.posted).toContainEqual({ type: 'draftValidated', payload: { valid: true, errors: [] } });
    });

    it('answers "previewPatch" with the fields that changed', async () => {
      await panel.send({ type: 'previewPatch', payload: draftPayload });

      expect(panel.posted).toContainEqual(
        expect.objectContaining({ type: 'patchPreview', payload: expect.objectContaining({ changedFields: ['Status'] }) })
      );
    });

    it('answers "loadLayoutFields" with the fields of the layout, without a record', async () => {
      await panel.send({ type: 'loadLayoutFields', payload: { profileId: 'p1', layout: 'Contacts' } });

      expect(panel.schemaService.getFields).toHaveBeenCalledWith(profile, 'Contacts');
      expect(panel.posted).toContainEqual(
        expect.objectContaining({
          type: 'layoutFields',
          payload: expect.objectContaining({
            profileId: 'p1',
            layout: 'Contacts',
            fields: [expect.objectContaining({ name: 'Status' })],
            metadataSupported: true
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

  describe('the writes reach FileMaker only after the user agrees', () => {
    it('answers "saveRecord" with the saved record and the refreshed one', async () => {
      await panel.send({ type: 'loadRecord', payload: { profileId: 'p1', layout: 'Contacts', recordId: '7' } });
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Save' as never);

      await panel.send({ type: 'saveRecord', payload: draftPayload });

      expect(panel.fmClient.editRecord).toHaveBeenCalledWith(
        profile,
        'Contacts',
        '7',
        expect.objectContaining({ Status: 'Closed' }),
        undefined,
        { modId: '3' }
      );
      expect(panel.posted).toContainEqual(
        expect.objectContaining({ type: 'recordSaved', payload: expect.objectContaining({ record: loadedRecord }) })
      );
    });

    it('answers "createRecord" with the id of the new record', async () => {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Create' as never);

      await panel.send({
        type: 'createRecord',
        payload: { profileId: 'p1', layout: 'Contacts', fieldData: { Status: 'Closed' } }
      });

      expect(panel.fmClient.createRecord).toHaveBeenCalledWith(profile, 'Contacts', { Status: 'Closed' });
      expect(panel.posted).toContainEqual({
        type: 'recordCreated',
        payload: { recordId: '501', modId: '0', layout: 'Contacts' }
      });
    });
  });

  describe('a message the panel cannot use is ignored', () => {
    it('ignores a message of an unknown type: nothing is posted and no service is called', async () => {
      await panel.send({ type: 'somethingElse', payload: { profileId: 'p1' } });

      expect(panel.posted).toEqual([]);
      expect(panel.profileStore.listProfiles).not.toHaveBeenCalled();
      expect(panel.profileStore.getProfile).not.toHaveBeenCalled();
      expect(panel.fmClient.getRecord).not.toHaveBeenCalled();
      expect(panel.logger.error).not.toHaveBeenCalled();
      expect(panel.logger.warn).not.toHaveBeenCalled();
    });

    it('ignores a message that is not an object', async () => {
      for (const message of [null, 'ready', 42]) {
        await panel.send(message);
      }

      expect(panel.posted).toEqual([]);
      expect(panel.profileStore.listProfiles).not.toHaveBeenCalled();
    });

    it('ignores a message without a type', async () => {
      await panel.send({ payload: { profileId: 'p1' } });

      expect(panel.posted).toEqual([]);
      expect(panel.profileStore.getProfile).not.toHaveBeenCalled();
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
        { type: 'saveRecord', payload: { profileId: 'p1', layout: 'Contacts', recordId: '7', originalFieldData: 'x', draftFieldData: {} } },
        { type: 'copyRecordRequest', payload: { profileId: 'p1', layout: 'Contacts', recordId: '7' } }
      ];

      for (const message of refused) {
        await panel.send(message);
      }

      expect(panel.posted).toEqual([]);
      expect(panel.fmClient.getRecord).not.toHaveBeenCalled();
      expect(panel.fmClient.editRecord).not.toHaveBeenCalled();
      expect(vi.mocked(vscode.env.clipboard.writeText)).not.toHaveBeenCalled();
    });
  });

  describe('a failure is posted to the webview as an error', () => {
    it('reports a profile that no longer exists when the layouts are asked for', async () => {
      await panel.send({ type: 'loadLayouts', profileId: 'gone' });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'Selected profile was not found.' });
      expect(panel.fmClient.listLayouts).not.toHaveBeenCalled();
    });

    it('reports layouts that cannot be listed', async () => {
      panel.fmClient.listLayouts.mockRejectedValueOnce(new Error('Layouts are unavailable.'));

      await panel.send({ type: 'loadLayouts', profileId: 'p1' });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'Layouts are unavailable.' });
    });

    it('reports a profile that no longer exists when the record is asked for', async () => {
      await panel.send({ type: 'loadRecord', payload: { profileId: 'gone', layout: 'Contacts', recordId: '7' } });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'Selected profile was not found.' });
      expect(panel.fmClient.getRecord).not.toHaveBeenCalled();
    });

    it('reports a record that cannot be read, and logs it', async () => {
      panel.fmClient.getRecord.mockRejectedValueOnce(new Error('Record is unavailable.'));

      await panel.send({ type: 'loadRecord', payload: { profileId: 'p1', layout: 'Contacts', recordId: '7' } });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'Record is unavailable.' });
      expect(panel.logger.error).toHaveBeenCalledWith('Failed to load record for editor.', {
        error: expect.any(Error),
        profileId: 'p1',
        layout: 'Contacts',
        recordId: '7'
      });
    });

    it('reports a profile that no longer exists when the layout fields are asked for', async () => {
      await panel.send({ type: 'loadLayoutFields', payload: { profileId: 'gone', layout: 'Contacts' } });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'Selected profile was not found.' });
      expect(panel.schemaService.getFields).not.toHaveBeenCalled();
    });

    it('reports a profile that no longer exists when a record is created', async () => {
      await panel.send({
        type: 'createRecord',
        payload: { profileId: 'gone', layout: 'Contacts', fieldData: { Status: 'Closed' } }
      });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'Selected profile was not found.' });
      expect(panel.fmClient.createRecord).not.toHaveBeenCalled();
    });

    it('reports a record that cannot be created', async () => {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Create' as never);
      panel.fmClient.createRecord.mockRejectedValueOnce(new Error('The record could not be created.'));

      await panel.send({
        type: 'createRecord',
        payload: { profileId: 'p1', layout: 'Contacts', fieldData: { Status: 'Closed' } }
      });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'The record could not be created.' });
    });

    it('reports that there is no record to export', async () => {
      await panel.send({ type: 'exportRecord' });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'No record has been loaded.' });
      expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    });

    it('reports a profile that no longer exists when a request is copied', async () => {
      await panel.send({
        type: 'copyRecordRequest',
        payload: { profileId: 'gone', layout: 'Contacts', recordId: '7', operation: 'get', format: 'curl' }
      });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'Selected profile was not found.' });
      expect(vi.mocked(vscode.env.clipboard.writeText)).not.toHaveBeenCalled();
    });

    it('reports a request that cannot be delivered', async () => {
      vi.mocked(vscode.env.clipboard.writeText).mockRejectedValueOnce(new Error('The clipboard is unavailable.'));

      await panel.send({
        type: 'copyRecordRequest',
        payload: { profileId: 'p1', layout: 'Contacts', recordId: '7', operation: 'get', format: 'curl' }
      });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'The clipboard is unavailable.' });
    });

    it('reports a save that is refused because offline mode is on', async () => {
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: (key: string, defaultValue?: unknown) => (key === 'offline.mode' ? true : defaultValue)
      } as never);
      await panel.send({ type: 'loadRecord', payload: { profileId: 'p1', layout: 'Contacts', recordId: '7' } });

      await panel.send({ type: 'saveRecord', payload: draftPayload });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'Offline mode is enabled; record writes are disabled.' });
      expect(panel.fmClient.editRecord).not.toHaveBeenCalled();
    });

    it('reports a profile that no longer exists when the record is saved', async () => {
      await panel.send({ type: 'loadRecord', payload: { profileId: 'p1', layout: 'Contacts', recordId: '7' } });

      await panel.send({ type: 'saveRecord', payload: { ...draftPayload, profileId: 'gone' } });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'Selected profile was not found.' });
      expect(panel.fmClient.editRecord).not.toHaveBeenCalled();
    });

    it('reports a draft in which nothing changed', async () => {
      await panel.send({ type: 'loadRecord', payload: { profileId: 'p1', layout: 'Contacts', recordId: '7' } });

      await panel.send({
        type: 'saveRecord',
        payload: { ...draftPayload, originalFieldData: { Status: 'Open' }, draftFieldData: { Status: 'Open' } }
      });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'No field changes detected.' });
      expect(panel.fmClient.editRecord).not.toHaveBeenCalled();
    });

    it('reports a save the user did not agree to, and writes nothing', async () => {
      await panel.send({ type: 'loadRecord', payload: { profileId: 'p1', layout: 'Contacts', recordId: '7' } });
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);

      await panel.send({ type: 'saveRecord', payload: draftPayload });

      expect(panel.posted).toContainEqual({ type: 'saveCancelled' });
      expect(panel.fmClient.editRecord).not.toHaveBeenCalled();
    });

    it('reports a script error that ran with the save, next to the success', async () => {
      await panel.send({ type: 'loadRecord', payload: { profileId: 'p1', layout: 'Contacts', recordId: '7' } });
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Save' as never);
      panel.fmClient.editRecord.mockResolvedValueOnce({
        recordId: '7',
        modId: '4',
        response: {},
        messages: [],
        scriptErrors: [{ phase: 'script', code: '100' }]
      });

      await panel.send({ type: 'saveRecord', payload: draftPayload });

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Record saved, but the script reported error 100')
      );
      expect(panel.posted).toContainEqual(expect.objectContaining({ type: 'recordSaved' }));
    });

    it('reports a failure inside the request in the panel error shape', async () => {
      panel.close();
      panel = open({ listProfiles: async () => { throw new Error('Profiles are unavailable.'); } });

      await panel.send({ type: 'ready' });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'Profiles are unavailable.' });
      expect(panel.logger.error).toHaveBeenCalledWith('Record editor request failed.', { type: 'ready', error: expect.any(Error) });
    });

    it('reports a failure that is not an Error with a plain reason', async () => {
      panel.close();
      panel = open({ listProfiles: async () => { throw 'the socket closed'; } });

      await panel.send({ type: 'ready' });

      expect(panel.posted).toContainEqual({ type: 'error', message: 'Unexpected error.' });
    });

    it('writes the failure to the log when the page cannot be told about it', async () => {
      const postMessage = vi.mocked(vscode.window.createWebviewPanel).mock.results.at(-1)?.value.webview.postMessage as
        ReturnType<typeof vi.fn>;
      postMessage.mockRejectedValue(new Error('The webview is gone.'));

      await panel.send({ type: 'ready' });

      expect(panel.logger.error).toHaveBeenCalledWith('Record editor request failed.', expect.anything());
      expect(panel.logger.error).toHaveBeenCalledWith('Could not post the Record editor request failure to the page.', expect.anything());
    });
  });

  describe('the panel is opened once and reused', () => {
    it('reveals the open panel and sends the new state instead of opening a second one', async () => {
      await panel.send({ type: 'ready' });
      const before = panel.posted.length;

      RecordEditorPanel.createOrShow(
        { extensionUri: { fsPath: '/ext' } } as never,
        panel.profileStore as never,
        panel.fmClient as never,
        panel.schemaService as never,
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
