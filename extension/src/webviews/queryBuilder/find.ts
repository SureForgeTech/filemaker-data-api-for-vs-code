import * as vscode from 'vscode';
import { FMClientError } from '../../services/errors';
import { describeScriptErrors } from '../../services/responseGuard';
import { parseFindJson, parseSortJson } from '../../utils/jsonValidate';
import type { FindRecordsRequest } from '../../types/fm';
import type { RunQueryPayload } from './types';
import type { QueryBuilderContext } from './context';

export async function handleRunQuery(context: QueryBuilderContext, payload: RunQueryPayload): Promise<void> {
  context.lastResult = undefined;
  const controller = new AbortController();
  const run = { runId: payload.runId ?? 0, controller };
  context.activeRun = run;
  const isCurrent = () => context.activeRun === run && !context.disposed;

  try {
    const profile = await context.profileStore.getProfile(payload.profileId);
    if (controller.signal.aborted || context.disposed) {
      if (!context.disposed) {
        await context.panel.webview.postMessage({ type: 'runCancelled', runId: payload.runId });
      }
      return;
    }
    if (!profile) {
      await context.postError('The selected connection profile no longer exists.', payload.runId);
      return;
    }

    const request = toFindRequest(payload, payload.listRecords === true);
    const { limit, offset, sort } = request;
    const control = { signal: controller.signal };
    const result = payload.listRecords === true
      ? await context.fmClient.listRecords(profile, payload.layout, { limit, offset, sort }, control)
      : await context.fmClient.findRecords(profile, payload.layout, request, control);
    if (!isCurrent() || controller.signal.aborted) return;
    if (result.scriptErrors && result.scriptErrors.length > 0) {
      void vscode.window.showWarningMessage(`The find worked, but ${describeScriptErrors(result.scriptErrors)}.`);
    }

    context.lastResult = {
      profileId: payload.profileId,
      layout: payload.layout,
      query: payload,
      result: {
        data: result.data,
        dataInfo: result.dataInfo
      }
    };

    await context.panel.webview.postMessage({
      type: 'queryResult',
      payload: context.lastResult
    });
  } catch (error) {
    // A cancelled run is not a failure: the user asked for it, so it is reported as cancelled.
    if (controller.signal.aborted) {
      if (!context.disposed) {
        await context.panel.webview.postMessage({ type: 'runCancelled', runId: payload.runId });
      }
      return;
    }

    if (isCurrent()) await context.postError(context.formatError(error), payload.runId);
    return;
  } finally {
    // Only this run's own entry is cleared; a newer run must not be clobbered.
    if (context.activeRun?.controller === controller) {
      context.activeRun = undefined;
    }
  }

  if (context.disposed || controller.signal.aborted || context.activeRun !== undefined) return;
  try {
    await context.sendHistory();
  } catch (error) {
    context.logger.warn('Failed to refresh query builder history.', { error });
  }
}

export function toFindRequest(payload: RunQueryPayload, listRecords = false): FindRecordsRequest {
  const findValidation = listRecords ? { ok: true, value: [], error: undefined } : parseFindJson(payload.findJson || '[{}]');

  if (!findValidation.ok || !findValidation.value) {
    throw new FMClientError(findValidation.error ?? 'Find JSON is invalid.');
  }

  let sortValidationValue: Array<Record<string, unknown>> | undefined;

  if (payload.sortJson && payload.sortJson.trim().length > 0) {
    const sortValidation = parseSortJson(payload.sortJson);
    if (!sortValidation.ok || !sortValidation.value) {
      throw new FMClientError(sortValidation.error ?? 'Sort JSON is invalid.');
    }

    sortValidationValue = sortValidation.value;
  }

  const limit = parseNumber(payload.limit, 'Limit');
  const offset = parseNumber(payload.offset, 'Offset');

  return {
    query: findValidation.value,
    sort: sortValidationValue,
    limit,
    offset
  };
}

function parseNumber(value: number | undefined, label: string): number | undefined {
  if (value === undefined || Number.isNaN(value)) {
    return undefined;
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new FMClientError(`${label} must be an integer and must be at least 1.`);
  }

  return value;
}
