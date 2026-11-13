import type { ConnectionProfile, PortalPaging, FileMakerRecord, FindRecordsRequest, FindRecordsResult } from '../../types/fm';
import type { DataApiEnvelope, DataApiListRecordsResponse } from '../../types/dataApi';
import { isProxyProfile } from '../../types/fm';
import { FMClientError } from '../errors';
import { assertFindCriteria } from '../../utils/findCriteria';
import { assertUsableUrlName } from '../../utils/urlSegment';
import { extractScriptErrors } from '../responseGuard';
import type { ClientRequestControl } from './types';
import type { ClientContext } from './context';
import { scriptErrorsOf } from './response';

export async function getRecord(
  client: ClientContext,
  profile: ConnectionProfile,
  layout: string,
  recordId: string,
  control?: ClientRequestControl
): Promise<FileMakerRecord> {
  return client.withHistory(
    {
      profileId: profile.id,
      operation: 'getRecord',
      layout,
      endpoint: `GET /layouts/${layout}/records/${recordId}`
    },
    async (trace) => {
      assertUsableUrlName(layout, 'layout');
      if (isProxyProfile(profile)) {
        if (control?.portal) throw new FMClientError('Loading more portal rows is unavailable through this proxy. Use a direct connection.');
        return client.proxyClient.getRecord(profile, layout, recordId, control?.signal);
      }

      const envelope = await client.requestWithAuth<DataApiListRecordsResponse>(
        profile,
        {
          method: 'GET',
          transfer: true,
          path: `/layouts/${encodeURIComponent(layout)}/records/${encodeURIComponent(recordId)}`,
          ...(control?.portal ? { params: portalPagingParams(control.portal, '_'), strictQuery: true } : {}),
          signal: control?.signal,
          maxResponseBytes: control?.maxResponseBytes
        },
        true,
        trace
      );

      const getScriptErrors = extractScriptErrors(envelope.response);
      if (getScriptErrors.length > 0) {
        client.logger.warn('A script reported an error while reading a record.', {
          layout,
          scriptErrors: getScriptErrors
        });
      }

      const record = envelope.response.data?.[0];
      if (!record) {
        throw new FMClientError('Record not found in FileMaker response payload.', {
          details: envelope
        });
      }

      return withPortalInfo(record, envelope.response.dataInfo, envelope.response.portalDataInfo);
    }
  );
}

export async function listRecords(
  client: ClientContext,
  profile: ConnectionProfile,
  layout: string,
  options: { limit?: number; offset?: number; sort?: FindRecordsRequest['sort'] } = {},
  control?: ClientRequestControl
): Promise<FindRecordsResult> {
  return client.withHistory({ profileId: profile.id, operation: 'listRecords', layout, endpoint: `GET /layouts/${layout}/records` }, async (trace) => {
    assertUsableUrlName(layout, 'layout');
    if (isProxyProfile(profile)) {
      throw new FMClientError('Get records is not supported by this proxy. Use a search with at least one field value.');
    }
    const params: Record<string, string | number> = {};
    if (options.limit !== undefined) params._limit = options.limit;
    if (options.offset !== undefined) params._offset = options.offset;
    if (options.sort?.length) params._sort = JSON.stringify(options.sort);
    try {
      const envelope = await client.requestWithAuth<DataApiListRecordsResponse>(profile, {
        method: 'GET', path: `/layouts/${encodeURIComponent(layout)}/records`, params,
        transfer: true,
        signal: control?.signal, maxResponseBytes: control?.maxResponseBytes
      }, true, trace);
      return { data: envelope.response.data ?? [], dataInfo: envelope.response.dataInfo, ...scriptErrorsOf(envelope.response) };
    } catch (error) {
      if (isNoRecordsFound(error)) return { data: [], dataInfo: { foundCount: 0, returnedCount: 0 } };
      throw error;
    }
  });
}

export async function findRecords(
  client: ClientContext,
  profile: ConnectionProfile,
  layout: string,
  body: FindRecordsRequest,
  control?: ClientRequestControl
): Promise<FindRecordsResult> {
  return client.withHistory(
    {
      profileId: profile.id,
      operation: 'findRecords',
      layout,
      endpoint: `POST /layouts/${layout}/_find`
    },
    async (trace) => {
      assertUsableUrlName(layout, 'layout');
      assertFindCriteria(body.query);
      if (isProxyProfile(profile)) {
        try {
          return await client.proxyClient.findRecords(profile, layout, body, control?.signal);
        } catch (error) {
          // The proxy passes FileMaker's code on, so "no records match" is an empty result here too.
          if (isNoRecordsFound(error)) {
            return emptyFindResult(error);
          }
          throw error;
        }
      }

      const payload: Record<string, unknown> = {
        query: body.query,
        ...portalPagingParams(body.portal, '')
      };

      if (body.sort && body.sort.length > 0) {
        payload.sort = body.sort;
      }

      if (typeof body.limit === 'number') {
        payload.limit = body.limit;
      }

      if (typeof body.offset === 'number') {
        payload.offset = body.offset;
      }

      for (const key of ['script', 'script.param', 'script.prerequest', 'script.prerequest.param', 'script.presort', 'script.presort.param'] as const) {
        if (body[key] !== undefined) payload[key] = body[key];
      }

      let envelope: DataApiEnvelope<DataApiListRecordsResponse>;
      try {
        envelope = await client.requestWithAuth<DataApiListRecordsResponse>(
          profile,
          {
            method: 'POST',
            transfer: true,
            path: `/layouts/${encodeURIComponent(layout)}/_find`,
            data: payload,
            signal: control?.signal,
            maxResponseBytes: control?.maxResponseBytes
          },
          true,
          trace
        );
      } catch (error) {
        // FileMaker answers a find with no matches (or an offset past the last match) with code 401.
        // A real server returns HTTP 200 with empty data; older/other versions may use another status:
        // match the code alone. That is a result, not a failure.
        if (isNoRecordsFound(error)) {
          return emptyFindResult(error);
        }
        throw error;
      }

      return {
        data: (envelope.response.data ?? []).map((record) => withPortalInfo(record, (envelope.response.data?.length === 1) ? envelope.response.dataInfo : undefined,
          (envelope.response.data?.length === 1) ? envelope.response.portalDataInfo : undefined)),
        dataInfo: envelope.response.dataInfo,
        ...scriptErrorsOf(envelope.response)
      };
    }
  );
}

/**
 * FileMaker reports "no records match the request" as error code 401. It is matched on that code,
 * whatever the HTTP status. Verified on a real FileMaker Data API Engine (2026-10-21):
 * HTTP 200, code 401, empty data. Older/other versions may use a different HTTP status.
 */
export function isNoRecordsFound(error: unknown): boolean {
  return error instanceof FMClientError && error.code === '401';
}

/** Preserve the match count when an offset is beyond the last record. */
function emptyFindResult(error: unknown): FindRecordsResult {
  const details = error instanceof FMClientError ? error.details as { response?: { dataInfo?: FindRecordsResult['dataInfo'] }; dataInfo?: FindRecordsResult['dataInfo'] } | undefined : undefined;
  const dataInfo = details?.response?.dataInfo ?? details?.dataInfo;
  return { data: [], dataInfo: { ...dataInfo, foundCount: dataInfo?.foundCount ?? 0, returnedCount: 0 } };
}

function withPortalInfo(record: FileMakerRecord, dataInfo?: Record<string, unknown>, responsePortalInfo?: unknown): FileMakerRecord {
  const info = record.portalDataInfo ?? dataInfo?.portalDataInfo ?? responsePortalInfo;
  return Array.isArray(info) ? { ...record, portalDataInfo: info } : record;
}

function portalPagingParams(portals: PortalPaging | undefined, prefix: string): Record<string, number> {
  const params: Record<string, number> = {};
  for (const [name, page] of Object.entries(portals ?? {})) {
    params[`${prefix}limit.${name}`] = page.limit;
    if (page.offset !== undefined) params[`${prefix}offset.${name}`] = page.offset;
  }
  return params;
}
