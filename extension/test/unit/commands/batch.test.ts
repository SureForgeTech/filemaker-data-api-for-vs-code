import { join } from 'path';
import { lstat } from 'fs/promises';
import type * as FsPromises from 'fs/promises';

vi.mock('fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof FsPromises>(), lstat: vi.fn()
}));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { displayText } from '../../../src/ai/aiText';
import { registerBatchCommands } from '../../../src/commands/batch';
import { command, expectSafeError, layout, logger, profile, profileStore, resetCommandMocks, serviceError } from '../../helpers/commandHarness';

const arg = { profileId: profile.id, layout };
const entries = [{ recordId: '42', fieldData: { ' Field ': ' value ' } }];

function setup() {
  const profiles = profileStore();
  const client = { listLayouts: vi.fn().mockResolvedValue([layout]) };
  const batchService = {
    batchExportFind: vi.fn().mockResolvedValue({ exportedRecords: 2, truncated: false }),
    getDefaultBatchUpdateOptions: vi.fn().mockResolvedValue({ dryRun: true }),
    batchUpdate: vi.fn().mockResolvedValue({ attempted: 1, successCount: 1, failureCount: 0 })
  };
  const tasks: Array<(context: never) => Promise<unknown>> = [];
  const jobRunner = { startJob: vi.fn((_name: string, task: (context: never) => Promise<unknown>) => {
    tasks.push(task);
    return { id: '12345678-abcd' };
  }) };
  const roleGuard = { assertFeature: vi.fn().mockResolvedValue(true), resolvePerformanceMode: vi.fn().mockReturnValue('balanced') };
  const settings = { isRecordEditEnabled: vi.fn().mockReturnValue(true), isBatchEnabled: vi.fn().mockReturnValue(true), getBatchMaxRecords: vi.fn().mockReturnValue(250), getBatchConcurrency: vi.fn().mockReturnValue(3) };
  const log = logger();
  registerBatchCommands({ profileStore: profiles as never, fmClient: client as never, batchService: batchService as never,
    jobRunner: jobRunner as never, roleGuard: roleGuard as never, settingsService: settings as never, logger: log as never });
  return { profiles, client, batchService, jobRunner, roleGuard, settings, log, tasks };
}

function exportInputs(path = join('/tmp', 'results.csv'), find = '[{" Field ":"==value"}]', sort = '[{"fieldName":" Field ","sortOrder":"ascend"}]') {
  vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(find).mockResolvedValueOnce(sort);
  vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(vscode.Uri.file(path));
}

function updateInputs(dryRun = true, path = join('/tmp', 'input.json')) {
  vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([vscode.Uri.file(path)]);
  vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from(path.endsWith('.CSV') ? 'recordId, Field \n42, value ' : JSON.stringify(entries)));
  vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ value: dryRun } as never);
}

describe('batch commands', () => {
  beforeEach(() => {
    resetCommandMocks();
    vi.mocked(lstat).mockReset().mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  });

  it.each(['batchExportFind', 'batchUpdateFromFile'])('%s opens only one set of dialogs during rapid repeated commands', async (name) => {
    setup();
    let finish!: (value: undefined) => void;
    vi.mocked(vscode.window.showInputBox).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    vi.mocked(vscode.window.showOpenDialog).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const run = command(name);
    const pending = Array.from({ length: 15 }, () => run(arg));
    await new Promise((resolve) => setImmediate(resolve));
    expect(vi.mocked(name === 'batchExportFind' ? vscode.window.showInputBox : vscode.window.showOpenDialog)).toHaveBeenCalledTimes(1);
    finish(undefined); await Promise.all(pending);
  });

  it.each(['batchExportFind', 'batchUpdateFromFile'])('%s refuses an untrusted workspace before touching services', async (name) => {
    const { jobRunner, profiles, roleGuard } = setup();
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = false;
    await command(name)(arg);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Batch operations are disabled in settings or untrusted workspace mode.', 'Learn More');
    expect(profiles.getProfile).not.toHaveBeenCalled();
    expect(roleGuard.assertFeature).not.toHaveBeenCalled();
    expect(jobRunner.startJob).not.toHaveBeenCalled();
  });

  it('refuses a disabled feature and opens trust help only on request', async () => {
    const { settings, jobRunner } = setup();
    settings.isBatchEnabled.mockReturnValue(false);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue('Learn More' as never);
    await command('batchExportFind')(arg);
    expect(vscode.env.openExternal).toHaveBeenCalledWith(expect.objectContaining({ fsPath: 'https://code.visualstudio.com/docs/editor/workspace-trust' }));
    expect(jobRunner.startJob).not.toHaveBeenCalled();
  });

  it('enforces the batch update role guard before executing updates', async () => {
    const { roleGuard, jobRunner } = setup();
    roleGuard.assertFeature.mockResolvedValue(false);
    updateInputs(false);
    await command('batchUpdateFromFile')(arg);
    expect(roleGuard.assertFeature).toHaveBeenCalledWith('batchUpdate', 'Batch update from CSV/JSON');
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(jobRunner.startJob).not.toHaveBeenCalled();
  });

  it('refuses batch updates when record editing is switched off', async () => {
    const { settings, jobRunner } = setup();
    settings.isRecordEditEnabled.mockReturnValue(false);
    updateInputs(false);
    await command('batchUpdateFromFile')(arg);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('Record editing is disabled'));
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(jobRunner.startJob).not.toHaveBeenCalled();
  });

  it.each(['recordEdit', 'writeOperations'])('enforces %s before executing updates', async (feature) => {
    const { roleGuard, jobRunner } = setup();
    roleGuard.assertFeature.mockImplementation(async (requested: string) => requested !== feature);
    updateInputs(false);
    await command('batchUpdateFromFile')(arg);
    expect(roleGuard.assertFeature).toHaveBeenCalledWith(feature, 'Batch update from CSV/JSON');
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(jobRunner.startJob).not.toHaveBeenCalled();
  });

  it.each(['batchUpdate', 'recordEdit', 'writeOperations', 'editSwitch'])('allows a dry-run preview under %s restrictions', async (restriction) => {
    const { settings, roleGuard, tasks, batchService } = setup();
    settings.isRecordEditEnabled.mockReturnValue(restriction !== 'editSwitch');
    roleGuard.assertFeature.mockImplementation(async (feature: string) => feature !== restriction);
    updateInputs(true);
    await command('batchUpdateFromFile')(arg);
    expect(tasks).toHaveLength(1);
    const context = { log: vi.fn() };
    await tasks[0]!(context as never);
    expect(batchService.batchUpdate).toHaveBeenCalledWith(profile, layout, entries, { dryRun: true, concurrency: 3 }, context);
    expect(roleGuard.assertFeature).not.toHaveBeenCalled();
  });

  it.each(['batchExportFind', 'batchUpdateFromFile'])('%s stops on missing profile or cancelled layout selection', async (name) => {
    const { profiles, jobRunner } = setup();
    profiles.getProfile.mockResolvedValueOnce(undefined);
    await command(name)(arg);
    await command(name)({ profileId: profile.id });
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(`Connection profile ${profile.id} not found.`);
    expect(vscode.window.showQuickPick).toHaveBeenCalled();
    expect(jobRunner.startJob).not.toHaveBeenCalled();
    expect(vscode.window.showOpenDialog).not.toHaveBeenCalled();
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
  });

  it('exports the exact selected layout and field names with the configured record limit', async () => {
    const { tasks, jobRunner, batchService } = setup();
    exportInputs();
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(layout as never);
    await command('batchExportFind')({ profileId: profile.id });
    expect(jobRunner.startJob).toHaveBeenCalledWith(`Batch Export ${layout}`, expect.any(Function));
    const context = { log: vi.fn() };
    await expect(tasks[0]!(context as never)).resolves.toEqual({ exportedRecords: 2, truncated: false });
    expect(batchService.batchExportFind).toHaveBeenCalledWith(profile, layout,
      { query: [{ ' Field ': '==value' }], sort: [{ fieldName: ' Field ', sortOrder: 'ascend' }] },
      { outputPath: join('/tmp', 'results.csv'), format: 'csv', excelCompatible: false, maxRecords: 250 }, context);
    expect(context.log).toHaveBeenCalledWith('info', 'Finished export. Records=2, truncated=false');
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Started job 12345678 for batch export.');
  });

  it.each([
    ['../ Layout/Name\\x\0', 'Layout-Name-x'], ['..', 'export'], ['CON', '_CON'], ['LPT1', '_LPT1']
  ])('uses a safe default export filename for %j while keeping the exact layout', async (name, safe) => {
    const { tasks, batchService } = setup();
    exportInputs();
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue('Standard CSV' as never);
    await command('batchExportFind')({ ...arg, layout: name });
    expect(vscode.window.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({
      defaultUri: expect.objectContaining({ fsPath: `${safe}.jsonl` })
    }));
    await tasks[0]!({ log: vi.fn() } as never);
    expect(batchService.batchExportFind).toHaveBeenCalledWith(profile, name, expect.anything(), expect.anything(), expect.anything());
  });

  it('offers standard CSV first and forwards the optional Excel format', async () => {
    const { tasks, batchService } = setup();
    exportInputs();
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue('Excel-compatible CSV (UTF-8 BOM)' as never);
    await command('batchExportFind')(arg);
    expect(vscode.window.showQuickPick).toHaveBeenCalledWith(['Standard CSV', 'Excel-compatible CSV (UTF-8 BOM)'], { title: 'CSV format' });
    await tasks[0]!({ log: vi.fn() } as never);
    expect(batchService.batchExportFind).toHaveBeenCalledWith(profile, layout, expect.anything(), expect.objectContaining({ excelCompatible: true }), expect.anything());
  });

  it('shows the omitted value count when the export finishes', async () => {
    const { tasks, batchService } = setup();
    batchService.batchExportFind.mockResolvedValue({ exportedRecords: 3, truncated: false, unknownColumnValues: 3 } as never);
    exportInputs();
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue('Standard CSV' as never);
    await command('batchExportFind')(arg);
    await tasks[0]!({ log: vi.fn() } as never);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('3 values were not exported because their columns were unknown. See the export job for column names.');
  });

  it('does not log a finished export after cancellation', async () => {
    const { tasks, batchService } = setup();
    batchService.batchExportFind.mockResolvedValue({ exportedRecords: 0, truncated: false, cancelled: true } as never);
    exportInputs();
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue('Standard CSV' as never);
    await command('batchExportFind')(arg);
    const log = vi.fn();
    await expect(tasks[0]!({ log } as never)).resolves.toMatchObject({ cancelled: true, exportedRecords: 0 });
    expect(log).not.toHaveBeenCalledWith('info', expect.stringContaining('Finished export'));
  });

  it.each([join('/tmp', 'results.csv'), join('/tmp', 'results.jsonl')])('forces streaming JSONL in high-scale mode (%s)', async (path) => {
    const { roleGuard, tasks, batchService } = setup();
    roleGuard.resolvePerformanceMode.mockReturnValue('high-scale');
    exportInputs(path, '[{"Name":"*"}]', '');
    await command('batchExportFind')(arg);
    await tasks[0]!({ log: vi.fn() } as never);
    expect(batchService.batchExportFind).toHaveBeenCalledWith(profile, layout, { query: [{ Name: '*' }], sort: undefined },
      { outputPath: join('/tmp', 'results.jsonl'), format: 'jsonl', excelCompatible: false, maxRecords: 250 }, expect.anything());
  });

  it.each([undefined, 'Overwrite'])('requires explicit consent for an existing rewritten JSONL destination (%s)', async (answer) => {
    const { roleGuard, jobRunner } = setup();
    roleGuard.resolvePerformanceMode.mockReturnValue('high-scale');
    exportInputs();
    vi.mocked(lstat).mockResolvedValue({} as never);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(answer as never);
    await command('batchExportFind')(arg);
    expect(lstat).toHaveBeenCalledWith(join('/tmp', 'results.jsonl'));
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('This file already exists. Replace it?'), { modal: true }, 'Overwrite');
    expect(jobRunner.startJob).toHaveBeenCalledTimes(answer === 'Overwrite' ? 1 : 0);
  });

  it('aborts if the rewritten export destination cannot be checked', async () => {
    const { roleGuard, jobRunner } = setup();
    roleGuard.resolvePerformanceMode.mockReturnValue('high-scale');
    exportInputs();
    vi.mocked(lstat).mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await command('batchExportFind')(arg);
    expect(jobRunner.startJob).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Export cancelled'));
  });

  it('does not schedule an export when find input is cancelled', async () => {
    const { jobRunner } = setup();
    await command('batchExportFind')(arg);
    expect(vscode.window.showSaveDialog).not.toHaveBeenCalled();
    expect(jobRunner.startJob).not.toHaveBeenCalled();
  });

  it('does not schedule an export when the output dialog is cancelled', async () => {
    const { jobRunner } = setup();
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('[{"Name":"*"}]');
    await command('batchExportFind')(arg);
    expect(jobRunner.startJob).not.toHaveBeenCalled();
  });

  it.each([['broken', ''], ['[{"Name":"*"}]', 'broken']])('rejects invalid find/sort (%s, %s) without scheduling', async (find, sort) => {
    const { jobRunner } = setup();
    exportInputs(join('/tmp', 'results.jsonl'), find, sort);
    await command('batchExportFind')(arg);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledOnce();
    expect(jobRunner.startJob).not.toHaveBeenCalled();
  });

  it.each([join('/tmp', 'input.json'), join('/tmp', 'input.CSV')])('schedules a dry-run with exact field names and opens a preview (%s)', async (path) => {
    const { tasks, batchService, jobRunner } = setup();
    updateInputs(true, path);
    await command('batchUpdateFromFile')(arg);
    expect(jobRunner.startJob).toHaveBeenCalledWith(`Batch Update ${layout}`, expect.any(Function));
    const context = { log: vi.fn() };
    await tasks[0]!(context as never);
    expect(batchService.batchUpdate).toHaveBeenCalledWith(profile, layout, entries, { dryRun: true, concurrency: 3 }, context);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    const doc = vi.mocked(vscode.workspace.openTextDocument).mock.calls[0]![0] as { content: string };
    expect(JSON.parse(doc.content)).toEqual({ dryRun: true, totalEntries: 1, layout, sample: entries, flaggedRows: [], rowsWithModId: 0, rowsChecked: 0, skippedColumns: [], warnings: [] });
    expect(context.log).toHaveBeenCalledWith('info', 'Batch update completed. Attempted=1, success=1, failures=0');
  });

  it.each(['json', 'csv'])('lists all flagged data rows and exact field names in the %s dry-run document', async (format) => {
    const { tasks } = setup();
    updateInputs(true, join('/tmp', `input.${format}`));
    // Include repeated record ids and a flagged row beyond the five-row sample.
    const rows = Array.from({ length: 7 }, (_, index) => ({
      recordId: '42', fieldData: { ' Name ': index === 1 || index === 6 ? 'A\0B\0C' : 'safe', Other: index === 6 ? '\0\0' : 'safe' }
    }));
    const source = format === 'json' ? JSON.stringify(rows) : 'recordId, Name ,Other\n' + rows.map((row) => `42,${row.fieldData[' Name ']},${row.fieldData.Other}`).join('\n');
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from(source));
    await command('batchUpdateFromFile')(arg);
    await tasks[0]!({ log: vi.fn() } as never);
    const doc = vi.mocked(vscode.workspace.openTextDocument).mock.calls[0]![0] as { content: string };
    expect(JSON.parse(doc.content)).toEqual({
      rowsWithModId: 0, rowsChecked: 0, skippedColumns: [], warnings: [],
      dryRun: true, totalEntries: 7, layout, sample: rows.slice(0, 5),
      flaggedRows: [{ row: 2, recordId: '42', fields: [' Name '] }, { row: 7, recordId: '42', fields: [' Name ', 'Other'] }]
    });
  });

  it('shows and flags only editable dry-run values without taking focus', async () => {
    const { tasks, batchService } = setup();
    updateInputs();
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from(JSON.stringify([{ recordId: '42', fieldData: { ' Field ': 'safe', 'Calc(1)': 'secret\0value' } }])));
    batchService.batchUpdate.mockResolvedValue({ attempted: 0, successCount: 0, failureCount: 0, skippedColumns: ['Calc(1)'] } as never);
    await command('batchUpdateFromFile')(arg);
    await tasks[0]!({ log: vi.fn() } as never);
    const doc = vi.mocked(vscode.workspace.openTextDocument).mock.calls[0]![0] as { content: string };
    expect(JSON.parse(doc.content)).toMatchObject({ sample: [{ recordId: '42', fieldData: { ' Field ': 'safe' } }], flaggedRows: [] });
    expect(doc.content).not.toContain('secret');
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ preserveFocus: true }));
  });

  it('keeps the computed dry-run result when opening the preview fails', async () => {
    const { tasks } = setup();
    updateInputs();
    vi.mocked(vscode.workspace.openTextDocument).mockRejectedValueOnce(new Error('cannot open preview'));
    await command('batchUpdateFromFile')(arg);
    const context = { log: vi.fn() };
    await expect(tasks[0]!(context as never)).resolves.toMatchObject({ successCount: 1, failureCount: 0 });
    expect(context.log).toHaveBeenCalledWith('warn', expect.stringMatching(/preview.*could not be opened/i));
  });

  it('executes a confirmed batch with an unparsable profile URL', async () => {
    const { profiles, tasks, batchService } = setup();
    const target = { ...profile, serverUrl: 'bare-hostname' };
    profiles.getProfile.mockResolvedValue(target);
    updateInputs(false);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Execute' as never).mockResolvedValueOnce('Continue' as never);
    await command('batchUpdateFromFile')(arg);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining(`server ${displayText(target.serverUrl)}.`), { modal: true }, 'Execute');
    expect(tasks).toHaveLength(1);
    await tasks[0]!({ log: vi.fn() } as never);
    expect(batchService.batchUpdate).toHaveBeenCalledWith(target, layout, entries, { dryRun: false, concurrency: 3 }, expect.anything());
  });

  it.each([undefined, 'Cancel', 'Execute'])('requires a destructive modal before executing updates (%s)', async (choice) => {
    const { tasks, jobRunner, batchService } = setup();
    updateInputs(false);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(choice as never).mockResolvedValueOnce('Continue' as never);
    await command('batchUpdateFromFile')(arg);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining(`Execute batch update for 1 records on ${displayText(layout)}?`), { modal: true }, 'Execute');
    if (choice === 'Execute') {
      const context = { log: vi.fn() };
      await tasks[0]!(context as never);
      expect(batchService.batchUpdate).toHaveBeenCalledWith(profile, layout, entries, { dryRun: false, concurrency: 3 }, context);
      expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    } else {
      expect(jobRunner.startJob).not.toHaveBeenCalled();
      expect(batchService.batchUpdate).not.toHaveBeenCalled();
    }
  });

  it.each([undefined, 'Check for newer changes (recommended)', 'Overwrite even if changed'])('requires an explicit version choice for exported files (%s)', async (choice) => {
    const { tasks, jobRunner, batchService } = setup();
    updateInputs(false);
    const versioned = [{ ...entries[0], modId: '7' }];
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from(JSON.stringify(versioned)));
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Execute' as never).mockResolvedValueOnce(choice as never);
    await command('batchUpdateFromFile')(arg);
    expect(vscode.window.showWarningMessage).toHaveBeenLastCalledWith(expect.stringContaining('newer changes'), { modal: true }, 'Check for newer changes (recommended)', 'Overwrite even if changed');
    if (!choice) expect(jobRunner.startJob).not.toHaveBeenCalled();
    else {
      await tasks[0]!({ log: vi.fn() } as never);
      expect(batchService.batchUpdate).toHaveBeenCalledWith(profile, layout, versioned, { dryRun: false, concurrency: 3, overwriteChanged: choice === 'Overwrite even if changed' }, expect.anything());
    }
  });

  it.each([undefined, 'Continue'])('warns before running a handmade file without versions (%s)', async (choice) => {
    const { tasks, jobRunner, batchService } = setup();
    updateInputs(false);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Execute' as never).mockResolvedValueOnce(choice as never);
    await command('batchUpdateFromFile')(arg);
    expect(vscode.window.showWarningMessage).toHaveBeenLastCalledWith('This file has no modId column, so updates cannot detect newer changes. Continue without the check?', { modal: true }, 'Continue');
    if (choice !== 'Continue') expect(jobRunner.startJob).not.toHaveBeenCalled();
    else {
      await tasks[0]!({ log: vi.fn() } as never);
      expect(batchService.batchUpdate).toHaveBeenCalledWith(profile, layout, entries, { dryRun: false, concurrency: 3 }, expect.anything());
    }
  });

  it('includes changed-row counts in the final job summary', async () => {
    const { tasks, batchService } = setup();
    updateInputs();
    batchService.batchUpdate.mockResolvedValue({ attempted: 2, successCount: 1, failureCount: 1, skippedChanged: 1 } as never);
    await command('batchUpdateFromFile')(arg);
    const log = vi.fn();
    await tasks[0]!({ log } as never);
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('1 rows were skipped because the records changed after the export'));
  });

  it('includes early-stop guidance in the job log', async () => {
    const { batchService, tasks } = setup();
    batchService.batchUpdate.mockResolvedValue({ attempted: 1, successCount: 0, failureCount: 1, stoppedReason: 'cancelled', notAttempted: 4 });
    updateInputs();
    await command('batchUpdateFromFile')(arg);
    const context = { log: vi.fn() };
    await tasks[0]!(context as never);
    expect(context.log).toHaveBeenCalledWith('info', 'Batch update completed. Attempted=1, success=0, failures=1. Stopped early (4 not attempted): cancelled');
  });

  it('does not read or schedule when the source dialog is cancelled', async () => {
    const { jobRunner } = setup();
    await command('batchUpdateFromFile')(arg);
    expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
    expect(jobRunner.startJob).not.toHaveBeenCalled();
  });

  it('does not schedule when the update mode is cancelled', async () => {
    const { jobRunner } = setup();
    updateInputs();
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);
    await command('batchUpdateFromFile')(arg);
    expect(jobRunner.startJob).not.toHaveBeenCalled();
  });

  it('does not prompt for a mode or schedule an empty update file', async () => {
    const { jobRunner } = setup();
    updateInputs();
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from('[]'));
    await command('batchUpdateFromFile')(arg);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('No valid update rows found.');
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(jobRunner.startJob).not.toHaveBeenCalled();
  });

  it('B4 escapes hostile confirmation names on one line and identifies the target without changing it', async () => {
    const { profiles, tasks, batchService } = setup();
    const target = { ...profile, name: 'Profile\n![x](https://host/beacon)', serverUrl: 'https://user:password@example.invalid:8443' };
    profiles.getProfile.mockResolvedValue(target);
    const targetLayout = ' Layout\nExecute anyway?\u202e ';
    updateInputs(false);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Execute' as never).mockResolvedValueOnce('Continue' as never);
    await command('batchUpdateFromFile')({ ...arg, layout: targetLayout });
    const message = vi.mocked(vscode.window.showWarningMessage).mock.calls[0]![0];
    expect(message.split('\n')[0]).toBe(`Execute batch update for 1 records on ${displayText(targetLayout)}? Profile ${displayText(target.name)}, server "example.invalid:8443".`);
    expect(message).not.toContain('password');
    await tasks[0]!({ log: vi.fn() } as never);
    expect(batchService.batchUpdate).toHaveBeenCalledWith(target, targetLayout, entries, expect.anything(), expect.anything());
  });

  it('B4 refuses files above the row cap before confirmation or scheduling', async () => {
    const { settings, jobRunner, batchService } = setup();
    settings.getBatchMaxRecords.mockReturnValue(1);
    updateInputs(false);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(Buffer.from(JSON.stringify([...entries, ...entries])));
    await command('batchUpdateFromFile')(arg);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringMatching(/2 rows exceed filemaker.batch.maxRecords \(1\)/));
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(jobRunner.startJob).not.toHaveBeenCalled();
    expect(batchService.batchUpdate).not.toHaveBeenCalled();
  });

  it.each(['read', 'defaults', 'schedule'])('reports a %s failure safely without crashing', async (failure) => {
    const { batchService, jobRunner, log } = setup();
    updateInputs();
    if (failure === 'read') vi.mocked(vscode.workspace.fs.readFile).mockRejectedValue(serviceError());
    if (failure === 'defaults') batchService.getDefaultBatchUpdateOptions.mockRejectedValue(serviceError());
    if (failure === 'schedule') jobRunner.startJob.mockImplementation(() => { throw serviceError(); });
    await expect(command('batchUpdateFromFile')(arg)).resolves.toBeUndefined();
    expectSafeError();
    expect(log.error).toHaveBeenCalledWith('Batch update failed to start.', expect.anything());
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    expect(batchService.batchUpdate).not.toHaveBeenCalled();
  });
});
