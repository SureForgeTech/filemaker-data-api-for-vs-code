import { safeFileName } from '../utils/safeText';
import { displayText } from '../ai/aiText';
import * as vscode from 'vscode';
import { singleFlight } from '../utils/singleFlight';

import type { RoleGuard } from '../enterprise/roleGuard';
import type { BatchService } from '../services/batchService';
import type { JobRunner } from '../services/jobRunner';
import type { FMClient } from '../services/fmClient';
import type { Logger } from '../services/logger';
import type { ProfileStore } from '../services/profileStore';
import type { SettingsService } from '../services/settingsService';
import { nulTextFields } from '../utils/nulText';
import { parseFindJson, parseSortJson } from '../utils/jsonValidate';
import {
  parseLayoutArg,
  promptForLayout,
  resolveProfileFromArg,
  showCommandError
} from './common';

interface RegisterBatchCommandsDeps {
  profileStore: ProfileStore;
  fmClient: FMClient;
  batchService: BatchService;
  jobRunner: JobRunner;
  roleGuard: RoleGuard;
  settingsService: SettingsService;
  logger: Logger;
}

export function registerBatchCommands(deps: RegisterBatchCommandsDeps): vscode.Disposable[] {
  const { profileStore, fmClient, batchService, jobRunner, roleGuard, settingsService, logger } = deps;

  return [
    vscode.commands.registerCommand('filemakerDataApiTools.batchExportFind', singleFlight(async (arg: unknown) => {
      if (!(await ensureBatchEnabled(settingsService))) {
        return;
      }

      const contextArg = parseLayoutArg(arg);
      const profile = await resolveProfileFromArg(contextArg, profileStore, true);
      if (!profile) {
        return;
      }

      const layout = contextArg.layout ?? (await promptForLayout(profile, fmClient));
      if (!layout) {
        return;
      }

      const findJsonInput = await vscode.window.showInputBox({
        title: 'Batch Export (Find)',
        prompt: 'Find query JSON array',
        value: '[{}]',
        ignoreFocusOut: true
      });
      if (!findJsonInput) {
        return;
      }

      const sortJsonInput = await vscode.window.showInputBox({
        title: 'Batch Export (Find)',
        prompt: 'Sort JSON array (optional)',
        ignoreFocusOut: true
      });

      const outputUri = await vscode.window.showSaveDialog({
        title: 'Export batch find results',
        defaultUri: vscode.Uri.file(`${safeFileName(layout)}.jsonl`),
        filters: {
          JSONL: ['jsonl'],
          CSV: ['csv']
        }
      });
      if (!outputUri) {
        return;
      }

      const findValidation = parseFindJson(findJsonInput);
      if (!findValidation.ok || !findValidation.value) {
        vscode.window.showErrorMessage(findValidation.error ?? 'Invalid find JSON.');
        return;
      }
      const findQuery = findValidation.value;

      let sort: Array<Record<string, unknown>> | undefined;
      if (sortJsonInput && sortJsonInput.trim().length > 0) {
        const sortValidation = parseSortJson(sortJsonInput);
        if (!sortValidation.ok || !sortValidation.value) {
          vscode.window.showErrorMessage(sortValidation.error ?? 'Invalid sort JSON.');
          return;
        }

        sort = sortValidation.value;
      }

      const maxRecords = settingsService.getBatchMaxRecords();

      const performanceMode = roleGuard.resolvePerformanceMode();
      const { inferExportFormat } = await import('../services/batchService');
      const selectedFormat = inferExportFormat(outputUri.fsPath);
      const format = performanceMode === 'high-scale' ? 'jsonl' : selectedFormat;
      const outputPath =
        performanceMode === 'high-scale' && selectedFormat !== 'jsonl'
          ? replaceExtension(outputUri.fsPath, '.jsonl')
          : outputUri.fsPath;

      const csvChoice = format === 'csv'
        ? await vscode.window.showQuickPick(['Standard CSV', 'Excel-compatible CSV (UTF-8 BOM)'], { title: 'CSV format' })
        : 'Standard CSV';
      if (!csvChoice) return;

      const job = jobRunner.startJob(`Batch Export ${layout}`, async (jobContext) => {
        jobContext.log('info', `Starting export to ${outputPath}`);

        const result = await batchService.batchExportFind(
          profile,
          layout,
          {
            query: findQuery,
            sort
          },
          {
            outputPath,
            excelCompatible: csvChoice.startsWith('Excel'),
            format,
            maxRecords
          },
          jobContext
        );

        if (result.cancelled) return result;
        if (result.unknownColumnValues) {
          void vscode.window.showWarningMessage(`${result.unknownColumnValues} values were not exported because their columns were unknown. See the export job for column names.`);
        }
        jobContext.log(
          'info',
          `Finished export. Records=${result.exportedRecords}, truncated=${result.truncated}`
        );
        return result;
      });

      vscode.window.showInformationMessage(`Started job ${job.id.slice(0, 8)} for batch export.`);
    })),

    vscode.commands.registerCommand(
      'filemakerDataApiTools.batchUpdateFromFile',
      singleFlight(async (arg: unknown) => {
        if (!(await ensureBatchEnabled(settingsService))) {
          return;
        }

        const canUpdate = await roleGuard.assertFeature('batchUpdate', 'Batch update from CSV/JSON');
        if (!canUpdate) {
          return;
        }

        const contextArg = parseLayoutArg(arg);
        const profile = await resolveProfileFromArg(contextArg, profileStore, true);
        if (!profile) {
          return;
        }

        const layout = contextArg.layout ?? (await promptForLayout(profile, fmClient));
        if (!layout) {
          return;
        }

        const filePick = await vscode.window.showOpenDialog({
          title: 'Batch update source file',
          canSelectMany: false,
          filters: {
            JSON: ['json'],
            CSV: ['csv']
          }
        });

        const sourceUri = filePick?.[0];
        if (!sourceUri) {
          return;
        }

        try {
          const sourceBytes = await vscode.workspace.fs.readFile(sourceUri);
          const sourceText = Buffer.from(sourceBytes).toString('utf8');
          const format = sourceUri.fsPath.toLowerCase().endsWith('.csv') ? 'csv' : 'json';
          const { parseBatchUpdateInput } = await import('../services/batchService');
          const entries = parseBatchUpdateInput(sourceText, format);
          if (entries.length === 0) {
            vscode.window.showWarningMessage('No valid update rows found.');
            return;
          }

          const maxRecords = settingsService.getBatchMaxRecords();
          if (entries.length > maxRecords) {
            vscode.window.showWarningMessage(`Batch update refused: ${entries.length} rows exceed filemaker.batch.maxRecords (${maxRecords}). Split the file or raise the setting before retrying.`);
            return;
          }

          const defaults = await batchService.getDefaultBatchUpdateOptions();
          const dryRunSelection = await vscode.window.showQuickPick(
            [
              { label: 'Dry-run only (recommended)', value: true },
              { label: 'Execute updates now', value: false }
            ],
            {
              title: 'Batch Update Mode',
              placeHolder: `Default: ${defaults.dryRun ? 'dry-run' : 'execute'}`
            }
          );

          if (!dryRunSelection) {
            return;
          }

          let overwriteChanged: boolean | undefined;
          const rowsWithModId = entries.filter((entry) => entry.modId !== undefined).length;
          if (!dryRunSelection.value) {
            let server = profile.serverUrl;
            try { server = new URL(server).host; } catch { /* Keep the supplied address when it is not a URL. */ }
            const confirmation = await vscode.window.showWarningMessage(
              `Execute batch update for ${entries.length} records on ${displayText(layout)}? Profile ${displayText(profile.name)}, server ${displayText(server)}.\nRollback guidance: keep a pre-update export and rerun updates with previous values to revert.`,
              { modal: true },
              'Execute'
            );

            if (confirmation !== 'Execute') return;
            if (rowsWithModId === 0) {
              const choice = await vscode.window.showWarningMessage(
                'This file has no modId column, so updates cannot detect newer changes. Continue without the check?',
                { modal: true }, 'Continue'
              );
              if (choice !== 'Continue') return;
            } else {
              const choice = await vscode.window.showWarningMessage(
                `Check for newer changes before updating? ${rowsWithModId} rows have modId; ${entries.length - rowsWithModId} rows have no modId and cannot be checked.`,
                { modal: true }, 'Check for newer changes (recommended)', 'Overwrite even if changed'
              );
              if (choice !== 'Check for newer changes (recommended)' && choice !== 'Overwrite even if changed') return;
              overwriteChanged = choice === 'Overwrite even if changed';
            }
          }

          const concurrency = settingsService.getBatchConcurrency();

          const job = jobRunner.startJob(`Batch Update ${layout}`, async (jobContext) => {
            jobContext.log(
              'info',
              `Starting batch update from ${sourceUri.fsPath} (dryRun=${dryRunSelection.value})`
            );

            const result = await batchService.batchUpdate(
              profile,
              layout,
              entries,
              {
                dryRun: dryRunSelection.value,
                concurrency,
                ...(overwriteChanged !== undefined ? { overwriteChanged } : {})
              },
              jobContext
            );

            jobContext.log(
              'info',
              `Batch update completed. Attempted=${result.attempted}, success=${result.successCount}, failures=${result.failureCount}${result.skippedReadOnlyRows ? `. ${result.skippedReadOnlyRows} rows had no editable values and were skipped` : ''}${result.skippedChanged ? `. ${result.skippedChanged} rows were skipped because the records changed after the export` : ''}${result.stoppedReason ? `. Stopped early (${result.notAttempted ?? 0} not attempted): ${result.stoppedReason}` : ''}`
            );

            if (dryRunSelection.value) {
              const previewEntries = entries.map((entry) => ({ ...entry, fieldData: Object.fromEntries(
                Object.entries(entry.fieldData).filter(([name]) => !result.skippedColumns?.includes(name))
              ) }));
              const preview = {
                dryRun: true,
                totalEntries: entries.length,
                layout,
                rowsWithModId: result.rowsWithModId ?? rowsWithModId,
                rowsChecked: result.rowsChecked ?? rowsWithModId,
                skippedColumns: result.skippedColumns ?? [],
                warnings: result.warnings ?? [],
                sample: previewEntries.slice(0, 5),
                // Rows are numbered from 1 in the parsed data, excluding a CSV header.
                flaggedRows: previewEntries.flatMap((entry, index) => {
                  const fields = nulTextFields(entry.fieldData);
                  return fields.length ? [{ row: index + 1, recordId: entry.recordId, fields }] : [];
                })
              };
              try {
                const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(preview, null, 2) });
                await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
              } catch {
                jobContext.log('warn', 'The dry-run preview could not be opened. The result and warnings are still available in Jobs.');
              }
            }

            return result;
          });

          vscode.window.showInformationMessage(`Started job ${job.id.slice(0, 8)} for batch update.`);

        } catch (error) {
          await showCommandError(error, {
            fallbackMessage: 'Batch update failed to start.',
            logger,
            logMessage: 'Batch update failed to start.'
          });
        }
      })
    )
  ];
}

async function ensureBatchEnabled(settingsService: SettingsService): Promise<boolean> {
  const enabled = settingsService.isBatchEnabled();
  if (!enabled || !vscode.workspace.isTrusted) {
    void vscode.window
      .showInformationMessage(
        'Batch operations are disabled in settings or untrusted workspace mode.',
        'Learn More'
      )
      .then((selection) => {
        if (selection === 'Learn More') {
          void vscode.env.openExternal(
            vscode.Uri.parse('https://code.visualstudio.com/docs/editor/workspace-trust')
          );
        }
      });
    return false;
  }

  return true;
}

function replaceExtension(path: string, extension: string): string {
  if (path.toLowerCase().endsWith(extension.toLowerCase())) {
    return path;
  }

  const withoutExt = path.replace(/\.[A-Za-z0-9]+$/, '');
  return `${withoutExt}${extension}`;
}
