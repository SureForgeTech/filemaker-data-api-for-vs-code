import * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FMClientError } from '../../src/services/errors';
import { RecordEditorPanel } from '../../src/webviews/recordEditor';

type Handler = (message: unknown) => void;

// The editor keeps one panel at a time; dispose it between tests so each gets its own mocks.
let disposeEditor: (() => void) | undefined;

const profile = {
  id: 'p1',
  name: 'Production',
  authMode: 'direct',
  serverUrl: 'https://fm.example.com',
  database: 'Sales'
};

const loadedRecord = {
  recordId: '7',
  modId: '3',
  fieldData: { Status: 'Open', Email: 'a@example.com', Region: 'West' }
};

function openEditor(editRecord: ReturnType<typeof vi.fn>, currentRecord = loadedRecord) {
  let handler: Handler | undefined;
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
      disposeEditor = callback;
      return { dispose: vi.fn() };
    }
  } as never);

  const getRecord = vi.fn().mockResolvedValueOnce(loadedRecord).mockResolvedValue(currentRecord);
  const fmClient = { getRecord, editRecord };
  const profileStore = {
    listProfiles: vi.fn(async () => [profile]),
    getProfile: vi.fn(async () => profile),
    getActiveProfileId: vi.fn(() => profile.id)
  };
  const getFields = vi.fn<() => Promise<{ supported: boolean; fields: Array<{ name: string; type?: string; result?: string }> }>>(async () => ({ supported: false, fields: [] }));
  const schemaService = { getFields };
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

  RecordEditorPanel.createOrShow(
    { extensionUri: { fsPath: '/ext' } } as never,
    profileStore as never,
    fmClient as never,
    schemaService as never,
    logger as never
  );

  const send = async (message: unknown, pendingSave = false): Promise<void> => {
    const before = posted.length;
    handler?.(message);
    if (pendingSave) {
      await vi.waitFor(() => expect(editRecord).toHaveBeenCalledTimes(1));
    } else {
      // saveReceived is only an acknowledgement; policy reads and the save still have to finish.
      await vi.waitFor(() => expect(posted.slice(before).some((reply) => reply.type !== 'saveReceived')).toBe(true));
    }
  };

  return { send, posted, fmClient, getFields };
}

const target = { profileId: 'p1', layout: 'Contacts', recordId: '7' };
const draft = {
  ...target,
  originalFieldData: loadedRecord.fieldData,
  draftFieldData: { ...loadedRecord.fieldData, Status: 'Closed' }
};

describe('Record Editor save conflicts', () => {
  beforeEach(() => {
    disposeEditor?.();
    vi.clearAllMocks();
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Save' as never);
  });

  it.each(['A\0B\u200bC\ufeffD', 'A\0B\0C\u200bD\ufeffE'].flatMap((value) =>
    [undefined, 'Cancel', 'Remove the character and continue'].map((choice) => ({ value, choice }))
  ))('handles NUL before saving: $value / $choice', async ({ value, choice }) => {
    const editRecord = vi.fn().mockResolvedValue({ recordId: '7', modId: '4' });
    const editor = openEditor(editRecord);
    await editor.send({ type: 'loadRecord', payload: target });
    vi.mocked(vscode.window.showWarningMessage).mockReset().mockResolvedValueOnce(choice as never).mockResolvedValueOnce('Save' as never);
    await editor.send({ type: 'saveRecord', payload: { ...draft, draftFieldData: { ...draft.draftFieldData, Status: value } } });
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Status'), { modal: true }, 'Remove the character and continue'
    );
    expect(vi.mocked(vscode.window.showWarningMessage).mock.calls[0]?.[0]).toContain('On the FileMaker server we tested, FileMaker kept only the text before this character and dropped the rest.');
    if (choice === 'Remove the character and continue') {
      expect(editRecord).toHaveBeenCalledWith(profile, 'Contacts', '7', { Status: value === 'A\0B\u200bC\ufeffD' ? 'AB\u200bC\ufeffD' : 'ABC\u200bD\ufeffE' }, undefined, { modId: '3' });
    } else {
      expect(editRecord).not.toHaveBeenCalled();
      expect(editor.posted.map((message) => message.type)).toContain('saveCancelled');
    }
  });

  it('skips the save modal and explains when NUL removal restores the original values', async () => {
    const editRecord = vi.fn();
    const editor = openEditor(editRecord);
    await editor.send({ type: 'loadRecord', payload: target });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Remove the character and continue' as never);
    await editor.send({ type: 'saveRecord', payload: { ...draft, draftFieldData: { ...loadedRecord.fieldData, Status: 'O\0p\0en' } } });
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('After removing the NUL characters, the values match the original record. Nothing needs to be saved.');
    expect(editRecord).not.toHaveBeenCalled();
    expect(editor.posted.map((message) => message.type)).toContain('saveCancelled');
    expect(editor.posted.map((message) => message.type)).not.toContain('error');
  });

  it('confirms and saves only the fields still changed after NUL removal', async () => {
    const editRecord = vi.fn().mockResolvedValue({ recordId: '7', modId: '4' });
    const editor = openEditor(editRecord);
    await editor.send({ type: 'loadRecord', payload: target });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Remove the character and continue' as never);
    await editor.send({ type: 'saveRecord', payload: { ...draft, draftFieldData: { ...loadedRecord.fieldData, Status: 'O\0p\0en', Region: 'East' } } });
    expect(vscode.window.showWarningMessage).toHaveBeenLastCalledWith(expect.stringContaining('Save 1 field changes to record 7? (Region)'), { modal: true }, 'Save');
    expect(editRecord).toHaveBeenCalledWith(profile, 'Contacts', '7', { Region: 'East' }, undefined, { modId: '3' });
  });

  it('filters read-only fields in the host save handler, including repetition keys', async () => {
    const editRecord = vi.fn().mockResolvedValue({ recordId: '7', modId: '4' });
    const editor = openEditor(editRecord);
    editor.getFields.mockResolvedValue({ supported: true, fields: [
      { name: 'Calc', type: ' Calculation ', result: 'number' },
      { name: 'Summary', type: ' SUMMARY ' },
      { name: 'Photo', result: ' Container ' }
    ] });
    await editor.send({ type: 'loadRecord', payload: target });
    await editor.send({ type: 'saveRecord', payload: { ...draft,
      originalFieldData: { ...draft.originalFieldData, 'Calc(1)': 1, 'Photo(2)': 'old' },
      draftFieldData: { ...draft.draftFieldData, 'Calc(1)': 9, 'Summary(2)': 8, 'Photo(2)': 'new' }
    } });
    expect(editRecord).toHaveBeenCalledWith(profile, 'Contacts', '7', { Status: 'Closed' }, undefined, { modId: '3' });
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('(Status)'), { modal: true }, 'Save');
  });

  it('compares only editable server fields when describing a conflict', async () => {
    const editRecord = vi.fn().mockRejectedValue(new FMClientError('stale', { code: '306' }));
    const editor = openEditor(editRecord, { ...loadedRecord, fieldData: { ...loadedRecord.fieldData, Status: 'Pending', 'Calc(1)': 9, Summary: 10, Photo: 'url' } } as typeof loadedRecord);
    editor.getFields.mockResolvedValue({ supported: true, fields: [
      { name: 'Calc', type: 'calculation' }, { name: 'Summary', type: 'summary' }, { name: 'Photo', result: 'container' }
    ] });
    await editor.send({ type: 'loadRecord', payload: target });
    await editor.send({ type: 'saveRecord', payload: draft });
    expect(editor.posted.find((message) => message.type === 'saveConflict')).toMatchObject({ payload: {
      changedByOthers: ['Status'], yourFields: ['Status'], overlap: ['Status']
    } });
  });

  it('drops stale host field metadata when a later load has no field list', async () => {
    const editRecord = vi.fn().mockResolvedValue({ recordId: '7', modId: '4' });
    const editor = openEditor(editRecord);
    editor.getFields.mockResolvedValueOnce({ supported: true, fields: [{ name: 'Status', type: 'calculation' }] });
    await editor.send({ type: 'loadRecord', payload: target });
    await editor.send({ type: 'loadRecord', payload: target });
    await editor.send({ type: 'saveRecord', payload: draft });
    expect(editRecord).toHaveBeenCalledWith(profile, 'Contacts', '7', { Status: 'Closed' }, undefined, { modId: '3' });
  });

  it('sends the modId the record was loaded with', async () => {
    const editRecord = vi.fn().mockResolvedValue({ recordId: '7', modId: '4' });
    const editor = openEditor(editRecord);

    await editor.send({ type: 'loadRecord', payload: target });
    await editor.send({ type: 'saveRecord', payload: draft });

    expect(editRecord).toHaveBeenCalledWith(profile, 'Contacts', '7', { Status: 'Closed' }, undefined, {
      modId: '3'
    });
    expect(editor.posted.map((message) => message.type)).toContain('recordSaved');
  });

  it('reports a conflict with the fields others changed, and writes nothing more', async () => {
    const editRecord = vi
      .fn()
      .mockRejectedValue(new FMClientError('Record modification ID does not match', { status: 500, code: '306' }));
    const current = {
      recordId: '7',
      modId: '4',
      fieldData: { Status: 'Pending', Email: 'new@example.com', Region: 'West' }
    };
    const editor = openEditor(editRecord, current);

    await editor.send({ type: 'loadRecord', payload: target });
    await editor.send({ type: 'saveRecord', payload: draft });

    const conflict = editor.posted.find((message) => message.type === 'saveConflict') as {
      payload: { recordId: string; changedByOthers: string[]; yourFields: string[]; overlap: string[] };
    };
    expect(conflict.payload).toEqual({
      recordId: '7',
      changedByOthers: ['Email', 'Status'],
      yourFields: ['Status'],
      overlap: ['Status']
    });
    expect(editor.posted.map((message) => message.type)).not.toContain('recordSaved');
    expect(editor.posted.map((message) => message.type)).not.toContain('error');
    expect(editRecord).toHaveBeenCalledTimes(1);
  });

  it('keeps the original modId on a retry, so a second save is still refused', async () => {
    const editRecord = vi
      .fn()
      .mockRejectedValue(new FMClientError('Record modification ID does not match', { status: 500, code: '306' }));
    const editor = openEditor(editRecord, { ...loadedRecord, modId: '4' });

    await editor.send({ type: 'loadRecord', payload: target });
    await editor.send({ type: 'saveRecord', payload: draft });
    await editor.send({ type: 'saveRecord', payload: draft });

    expect(editRecord.mock.calls.map((call) => (call[5] as { modId: string }).modId)).toEqual(['3', '3']);
  });

  it('still reports a conflict when the current record cannot be read', async () => {
    const editRecord = vi
      .fn()
      .mockRejectedValue(new FMClientError('Record modification ID does not match', { status: 500, code: '306' }));
    const editor = openEditor(editRecord);
    (editor.fmClient.getRecord as ReturnType<typeof vi.fn>).mockReset();
    (editor.fmClient.getRecord as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(loadedRecord)
      .mockRejectedValue(new Error('network down'));

    await editor.send({ type: 'loadRecord', payload: target });
    await editor.send({ type: 'saveRecord', payload: draft });

    const conflict = editor.posted.find((message) => message.type === 'saveConflict') as {
      payload: { changedByOthers: string[] };
    };
    expect(conflict.payload.changedByOthers).toEqual([]);
  });

  it('reports other save failures as ordinary errors', async () => {
    const editRecord = vi.fn().mockRejectedValue(new FMClientError('Field is missing', { status: 500, code: '102' }));
    const editor = openEditor(editRecord);

    await editor.send({ type: 'loadRecord', payload: target });
    await editor.send({ type: 'saveRecord', payload: draft });

    expect(editor.posted.map((message) => message.type)).toContain('error');
    expect(editor.posted.map((message) => message.type)).not.toContain('saveConflict');
  });

  it('refuses to save when the form no longer matches the loaded record', async () => {
    const editRecord = vi.fn().mockResolvedValue({ recordId: '8', modId: '1' });
    const editor = openEditor(editRecord);

    await editor.send({ type: 'loadRecord', payload: target });
    await editor.send({ type: 'saveRecord', payload: { ...draft, recordId: '8' } });

    expect(editRecord).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    const error = editor.posted.find((message) => message.type === 'error') as { message: string };
    expect(error.message).toMatch(/not the one that was loaded/);
  });

  it('refuses to save when no record was loaded', async () => {
    const editRecord = vi.fn();
    const editor = openEditor(editRecord);

    await editor.send({ type: 'saveRecord', payload: draft });

    expect(editRecord).not.toHaveBeenCalled();
    expect(editor.posted.map((message) => message.type)).toContain('error');
  });

  it('protects the next edit with the modId returned after a save', async () => {
    const editRecord = vi.fn().mockResolvedValue({ recordId: '7', modId: '4' });
    const afterSave = { recordId: '7', modId: '4', fieldData: { ...loadedRecord.fieldData, Status: 'Closed' } };
    const editor = openEditor(editRecord, afterSave);

    await editor.send({ type: 'loadRecord', payload: target });
    await editor.send({ type: 'saveRecord', payload: draft });
    await editor.send({
      type: 'saveRecord',
      payload: { ...target, originalFieldData: afterSave.fieldData, draftFieldData: { ...afterSave.fieldData, Region: 'East' } }
    });

    expect(editRecord.mock.calls.map((call) => (call[5] as { modId: string }).modId)).toEqual(['3', '4']);
  });

  it('does not report a false conflict when the record cannot be re-read after a successful save', async () => {
    const editRecord = vi.fn().mockResolvedValue({ recordId: '7', modId: '4' });
    const editor = openEditor(editRecord);
    (editor.fmClient.getRecord as ReturnType<typeof vi.fn>).mockReset();
    (editor.fmClient.getRecord as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(loadedRecord)
      .mockRejectedValue(new Error('network down'));

    await editor.send({ type: 'loadRecord', payload: target });
    await editor.send({ type: 'saveRecord', payload: draft });

    const error = editor.posted.find((message) => message.type === 'error') as { message: string };
    expect(error.message).toMatch(/was saved, but the record could not be re-read/);

    // The held modId is stale now, so a second save is refused until the record is loaded again.
    await editor.send({ type: 'saveRecord', payload: draft });
    expect(editRecord).toHaveBeenCalledTimes(1);
    expect(editor.posted.filter((message) => message.type === 'error')).toHaveLength(2);
    expect(editor.posted.map((message) => message.type)).not.toContain('saveConflict');
  });

  it('sends no modId guard for a record that has none', async () => {
    const editRecord = vi.fn().mockResolvedValue({ recordId: '7' });
    const withoutModId = { recordId: '7', fieldData: loadedRecord.fieldData };
    const editor = openEditor(editRecord, withoutModId as never);
    (editor.fmClient.getRecord as ReturnType<typeof vi.fn>).mockReset();
    (editor.fmClient.getRecord as ReturnType<typeof vi.fn>).mockResolvedValue(withoutModId);

    await editor.send({ type: 'loadRecord', payload: target });
    await editor.send({ type: 'saveRecord', payload: draft });

    expect(editRecord).toHaveBeenCalledWith(profile, 'Contacts', '7', { Status: 'Closed' }, undefined, undefined);
  });

  it('refuses to load another record while a save is in progress', async () => {
    let finishSave: (value: unknown) => void = () => undefined;
    const editRecord = vi.fn().mockReturnValue(new Promise((resolve) => (finishSave = resolve)));
    const editor = openEditor(editRecord);

    await editor.send({ type: 'loadRecord', payload: target });
    await editor.send({ type: 'saveRecord', payload: draft }, true);
    await editor.send({ type: 'loadRecord', payload: { ...target, recordId: '9' } });

    const error = editor.posted.filter((message) => message.type === 'error').pop() as { message: string };
    expect(error.message).toMatch(/save is in progress/);

    finishSave({ recordId: '7', modId: '4' });
    await vi.waitFor(() => expect(editor.posted.map((message) => message.type)).toContain('recordSaved'));
  });

  it('keeps checking saves against the previous record when a reload fails after reading it', async () => {
    const editRecord = vi.fn().mockResolvedValue({ recordId: '7', modId: '5' });
    const newer = { recordId: '7', modId: '4', fieldData: { ...loadedRecord.fieldData, Email: 'new@example.com' } };
    const editor = openEditor(editRecord, newer);

    await editor.send({ type: 'loadRecord', payload: target });
    editor.getFields.mockRejectedValueOnce(new Error('metadata unavailable'));
    await editor.send({ type: 'loadRecord', payload: target });
    await editor.send({ type: 'saveRecord', payload: draft });

    // The page still holds the first draft, so the save must carry the first modId ('3'),
    // not the newer one the failed reload had read.
    expect(editRecord).toHaveBeenCalledTimes(1);
    expect((editRecord.mock.calls[0]?.[5] as { modId: string }).modId).toBe('3');
  });

  it('treats a record id with leading zeros as the same record', async () => {
    const editRecord = vi.fn().mockResolvedValue({ recordId: '7', modId: '4' });
    const editor = openEditor(editRecord);

    await editor.send({ type: 'loadRecord', payload: { ...target, recordId: '07' } });
    await editor.send({ type: 'saveRecord', payload: { ...draft, recordId: '07' } });

    expect(editRecord).toHaveBeenCalledTimes(1);
  });
});
