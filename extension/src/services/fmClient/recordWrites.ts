import type { ConnectionProfile, EditRecordResult } from '../../types/fm';
import { isProxyProfile } from '../../types/fm';
import { FMClientError } from '../errors';
import { assertNoNulText } from '../../utils/nulText';
import { assertUsableUrlName } from '../../utils/urlSegment';
import type { ClientRequestControl, CreateRecordOptions, EditRecordOptions } from './types';
import type { ClientContext } from './context';
import { scriptErrorsOf } from './response';
import { sanitizeCreatePortalData } from '../../utils/createPortalRows';

export async function editRecord(
  client: ClientContext,
  profile: ConnectionProfile,
  layout: string,
  recordId: string,
  fieldDataPartial: Record<string, unknown>,
  control?: ClientRequestControl,
  options?: EditRecordOptions
): Promise<EditRecordResult> {
  return client.withHistory(
    {
      profileId: profile.id,
      operation: 'editRecord',
      layout,
      endpoint: `PATCH /layouts/${layout}/records/${recordId}`
    },
    async (trace) => {
      assertUsableUrlName(layout, 'layout');
      assertNoNulText(fieldDataPartial);
      if (isProxyProfile(profile)) {
        return client.proxyClient.editRecord(
          profile,
          layout,
          recordId,
          fieldDataPartial,
          control?.signal,
          options?.modId
        );
      }

      if (Object.keys(fieldDataPartial).length === 0) {
        throw new FMClientError('At least one field change is required to edit a record.');
      }

      const envelope = await client.requestWithAuth<Record<string, unknown>>(
        profile,
        {
          method: 'PATCH',
          path: `/layouts/${encodeURIComponent(layout)}/records/${encodeURIComponent(recordId)}`,
          data: {
            fieldData: fieldDataPartial,
            // When given, FileMaker refuses the edit (error 306) if the record changed since this modId.
            ...(options?.modId !== undefined ? { modId: options.modId } : {})
          },
          signal: control?.signal
        },
        true,
        trace
      );

      const modIdValue = envelope.response.modId;

      return {
        recordId,
        modId:
          typeof modIdValue === 'string'
            ? modIdValue
            : typeof modIdValue === 'number'
              ? String(modIdValue)
              : undefined,
        messages: envelope.messages,
        response: envelope.response,
        ...scriptErrorsOf(envelope.response)
      };
    }
  );
}

export async function createRecord(
  client: ClientContext,
  profile: ConnectionProfile,
  layout: string,
  fieldData: Record<string, unknown>,
  control?: ClientRequestControl,
  options?: CreateRecordOptions
): Promise<EditRecordResult> {
  return client.withHistory(
    {
      profileId: profile.id,
      operation: 'createRecord',
      layout,
      endpoint: `POST /layouts/${layout}/records`
    },
    async (trace) => {
      assertUsableUrlName(layout, 'layout');
      assertNoNulText(fieldData);
      const portalData = sanitizeCreatePortalData(options?.portalData);
      for (const rows of Object.values(portalData ?? {})) {
        for (const row of rows) {
          assertNoNulText(row);
        }
      }
      if (isProxyProfile(profile)) {
        if (portalData) {
          throw new FMClientError(
            'Creating related (portal) rows is not supported through a proxy connection. Create the parent record first, then add the related rows on the FileMaker layout, or use a direct Data API connection.'
          );
        }
        return client.proxyClient.createRecord(profile, layout, fieldData, control?.signal);
      }

      const envelope = await client.requestWithAuth<Record<string, unknown>>(
        profile,
        {
          method: 'POST',
          path: `/layouts/${encodeURIComponent(layout)}/records`,
          data: {
            fieldData,
            // Only when related rows carry values, so the request matches the plain create otherwise.
            ...(portalData ? { portalData } : {})
          },
          signal: control?.signal
        },
        true,
        trace
      );

      const recordIdValue = envelope.response.recordId;
      const recordId =
        typeof recordIdValue === 'string'
          ? recordIdValue
          : typeof recordIdValue === 'number'
            ? String(recordIdValue)
            : undefined;

      if (!recordId) {
        throw new FMClientError('FileMaker createRecord response did not include recordId.', {
          details: envelope.response
        });
      }

      const modIdValue = envelope.response.modId;
      return {
        recordId,
        modId:
          typeof modIdValue === 'string'
            ? modIdValue
            : typeof modIdValue === 'number'
              ? String(modIdValue)
              : undefined,
        messages: envelope.messages,
        response: envelope.response,
        ...scriptErrorsOf(envelope.response)
      };
    }
  );
}

export async function deleteRecord(
  client: ClientContext,
  profile: ConnectionProfile,
  layout: string,
  recordId: string,
  control?: ClientRequestControl
): Promise<EditRecordResult> {
  return client.withHistory(
    {
      profileId: profile.id,
      operation: 'deleteRecord',
      layout,
      endpoint: `DELETE /layouts/${layout}/records/${recordId}`
    },
    async (trace) => {
      assertUsableUrlName(layout, 'layout');
      if (isProxyProfile(profile)) {
        return client.proxyClient.deleteRecord(profile, layout, recordId, control?.signal);
      }

      const envelope = await client.requestWithAuth<Record<string, unknown>>(
        profile,
        {
          method: 'DELETE',
          path: `/layouts/${encodeURIComponent(layout)}/records/${encodeURIComponent(recordId)}`,
          signal: control?.signal
        },
        true,
        trace
      );

      const modIdValue = envelope.response.modId;
      return {
        recordId,
        modId:
          typeof modIdValue === 'string'
            ? modIdValue
            : typeof modIdValue === 'number'
              ? String(modIdValue)
              : undefined,
        messages: envelope.messages,
        response: envelope.response,
        ...scriptErrorsOf(envelope.response)
      };
    }
  );
}
