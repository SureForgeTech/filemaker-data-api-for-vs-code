import type { IncomingMessage, RunQueryPayload, SaveQueryPayload, OpenRecordPayload, CopySnippetPayload, UploadContainerPayload } from './types';
import { getOptionalNumberField, getStringField, toRecord } from '../common/messageValidation';
import { parseSnippetDelivery } from '../../snippets/deliver';
import type { SnippetFormat } from '../../snippets/model';

/** Upper bound for text the webview may put on the clipboard in one call. */
const MAX_CLIPBOARD_TEXT_LENGTH = 5_000_000;

export function parseIncomingMessage(rawMessage: unknown): IncomingMessage | undefined {
  const value = toRecord(rawMessage);
  if (!value) {
    return undefined;
  }

  const type = getStringField(value, 'type');
  if (!type) {
    return undefined;
  }

  switch (type) {
    case 'ready':
      return { type };
    case 'loadLayouts': {
      const profileId = getStringField(value, 'profileId');
      if (!profileId) {
        return undefined;
      }

      return {
        type,
        profileId
      };
    }
    case 'loadFieldNames': {
      const profileId = getStringField(value, 'profileId');
      const layout = getStringField(value, 'layout');
      if (!profileId || !layout) {
        return undefined;
      }
      return { type, profileId, layout };
    }
    case 'runQuery': {
      const payload = parseRunQueryPayload(value.payload);
      if (!payload) {
        return undefined;
      }

      return {
        type,
        payload
      };
    }
    case 'saveQuery': {
      const payload = parseSaveQueryPayload(value.payload);
      if (!payload) {
        return undefined;
      }

      return {
        type,
        payload
      };
    }
    case 'cancelRun': {
      // The run id names the request to abort; without it there is nothing to cancel.
      const runId = getOptionalNumberField(value, 'runId', { min: 0 });
      if (runId === undefined || !Number.isInteger(runId)) {
        return undefined;
      }

      return { type, runId };
    }
    case 'exportResultsToEditor':
    case 'exportResultsJsonFile':
    case 'exportResultsCsvFile':
    case 'refreshHistory':
      return { type };
    case 'copyFetchSnippet':
    case 'copyCurlSnippet':
    case 'copyRequest': {
      // The two older message types name their format; `copyRequest` carries it in the payload.
      const fallback: SnippetFormat | undefined =
        type === 'copyFetchSnippet' ? 'fetch' : type === 'copyCurlSnippet' ? 'curl' : undefined;
      const payload = parseCopySnippetPayload(value.payload, fallback);
      if (!payload) {
        return undefined;
      }

      return {
        type,
        payload
      };
    }
    case 'uploadContainer': {
      const payload = parseUploadContainerPayload(value.payload);
      if (!payload) {
        return undefined;
      }

      return {
        type,
        payload
      };
    }
    case 'openRecord': {
      const payload = parseOpenRecordPayload(value.payload);
      return payload ? { type, payload } : undefined;
    }
    case 'copyText': {
      const text = typeof value.text === 'string' ? value.text : undefined;
      const label = getStringField(value, 'label') ?? 'text';
      if (text === undefined || text.length === 0 || text.length > MAX_CLIPBOARD_TEXT_LENGTH) {
        return undefined;
      }
      return { type, text, label: label.slice(0, 80) };
    }
    default:
      return undefined;
  }
}

function parseRunQueryPayload(rawPayload: unknown): RunQueryPayload | undefined {
  const payload = toRecord(rawPayload);
  if (!payload) {
    return undefined;
  }

  const profileId = getStringField(payload, 'profileId');
  const layout = getStringField(payload, 'layout');
  if (!profileId || !layout) {
    return undefined;
  }

  const findJson = getStringField(payload, 'findJson');
  if (!findJson) {
    return undefined;
  }

  return {
    profileId,
    layout,
    findJson,
    ...(payload.listRecords === true ? { listRecords: true } : {}),
    sortJson: getStringField(payload, 'sortJson'),
    limit: getOptionalNumberField(payload, 'limit'),
    offset: getOptionalNumberField(payload, 'offset'),
    queryId: getStringField(payload, 'queryId'),
    runId: getOptionalNumberField(payload, 'runId')
  };
}

function parseSaveQueryPayload(rawPayload: unknown): SaveQueryPayload | undefined {
  const payload = parseRunQueryPayload(rawPayload);
  if (!payload) {
    return undefined;
  }

  const raw = toRecord(rawPayload);
  const name = raw ? getStringField(raw, 'name') : undefined;

  return {
    ...payload,
    name: (name ?? '').trim()
  };
}

function parseOpenRecordPayload(rawPayload: unknown): OpenRecordPayload | undefined {
  const payload = toRecord(rawPayload);
  if (!payload) {
    return undefined;
  }

  const profileId = getStringField(payload, 'profileId');
  const layout = getStringField(payload, 'layout');
  const recordId = getStringField(payload, 'recordId');
  if (!profileId || !layout || !recordId || !/^\d+$/.test(recordId)) {
    return undefined;
  }

  return {
    profileId,
    layout,
    recordId,
    mode: getStringField(payload, 'mode') === 'edit' ? 'edit' : 'view'
  };
}

function parseCopySnippetPayload(rawPayload: unknown, fallbackFormat?: SnippetFormat): CopySnippetPayload | undefined {
  const payload = parseRunQueryPayload(rawPayload);
  const raw = toRecord(rawPayload);
  const delivery = raw ? parseSnippetDelivery(raw, fallbackFormat) : undefined;
  if (!payload || !delivery) {
    return undefined;
  }

  return { ...payload, delivery };
}

function parseUploadContainerPayload(rawPayload: unknown): UploadContainerPayload | undefined {
  const payload = toRecord(rawPayload);
  if (!payload) {
    return undefined;
  }

  const profileId = getStringField(payload, 'profileId');
  const layout = getStringField(payload, 'layout');
  if (!profileId || !layout) {
    return undefined;
  }

  return {
    profileId,
    layout
  };
}
