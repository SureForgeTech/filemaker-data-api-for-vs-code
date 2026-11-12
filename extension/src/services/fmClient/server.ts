import { withRequestLimits } from '../requestLimits';
import type { ConnectionProfile } from '../../types/fm';
import type { DataApiEnvelope } from '../../types/dataApi';
import { FMClientError, toFMClientError } from '../errors';
import { normalizeError } from '../../utils/normalizeError';
import { httpsTransportFor } from '../tlsAgent';
import { parseDataApiEnvelope } from '../responseGuard';
import type { ClientRequestControl } from './types';
import type { ClientContext } from './context';
import { normalizePath } from './transport';

/**
 * Step one of Test Connection: `GET /fmi/data/<version>/productInfo` needs no account and no
 * database, so it separates "cannot reach the Data API" (TLS, DNS, port, a web page, Data API
 * off) from everything about the account. Returns the product name and version.
 */
export async function getProductInfo(
  client: ClientContext,
  profile: ConnectionProfile,
  control?: ClientRequestControl
): Promise<{ name?: string; version?: string }> {
  const envelope = await requestServerLevel<{ productInfo?: Record<string, unknown> }>(client,
    profile,
    '/productInfo',
    control,
    'Failed to reach the FileMaker Data API.'
  );
  const info = envelope.response.productInfo ?? {};
  return {
    name: typeof info.name === 'string' ? info.name : undefined,
    version: typeof info.version === 'string' ? info.version : undefined
  };
}

/** Unauthenticated connection diagnosis through the same transport as Test Connection. */
export async function getProductInfoDiagnostics(
  client: ClientContext,
  profile: ConnectionProfile,
  control?: ClientRequestControl
): Promise<{ status: number; code?: string; name?: string; version?: string }> {
  let status = 0;
  const envelope = await requestServerLevel<{ productInfo?: Record<string, unknown> }>(client,
    profile, '/productInfo', control, 'Failed to reach the FileMaker Data API.',
    (value) => { status = value; }, true
  );
  const info = envelope.response.productInfo ?? {};
  return {
    status,
    code: envelope.messages[0]?.code,
    name: typeof info.name === 'string' ? info.name : undefined,
    version: typeof info.version === 'string' ? info.version : undefined
  };
}

/**
 * Step two: `GET /fmi/data/<version>/databases`. Without credentials FileMaker lists the hosted
 * databases unless "Filter Databases in Client Applications" is on, in which case it answers
 * 401 and the list is unavailable until sign-in (returned as `undefined`).
 */
export async function listHostedDatabases(
  client: ClientContext,
  profile: ConnectionProfile,
  control?: ClientRequestControl
): Promise<string[] | undefined> {
  try {
    const envelope = await requestServerLevel<{ databases?: Array<{ name?: unknown }> }>(client,
      profile,
      '/databases',
      control,
      'Failed to list the hosted databases.'
    );
    return (envelope.response.databases ?? [])
      .map((entry) => (typeof entry?.name === 'string' ? entry.name : undefined))
      .filter((name): name is string => Boolean(name));
  } catch (error) {
    if (error instanceof FMClientError && (error.status === 401 || error.status === 403)) {
      return undefined;
    }
    throw error;
  }
}

export async function requestServerLevel<TResponse extends Record<string, unknown>>(
  client: ClientContext,
  profile: ConnectionProfile,
  path: string,
  control: ClientRequestControl | undefined,
  fallbackMessage: string,
  onStatus?: (status: number) => void,
  skipCertificateInspection = false
): Promise<DataApiEnvelope<TResponse>> {
  const base = profile.serverUrl.replace(/\/+$/, '');
  const basePath = normalizePath(profile.apiBasePath ?? '/fmi/data');
  const version = (profile.apiVersionPath ?? 'vLatest').replace(/^\/+|\/+$/g, '');
  try {
    const response = await withRequestLimits(client.timeoutMs, control?.signal, (limits) => client.httpClient.request<unknown>({
      method: 'GET',
      url: `${base}${basePath}/${version}${path}`,
      headers: { Accept: 'application/json' },
      ...limits,
      maxRedirects: 0,
      ...httpsTransportFor(profile, `${base}${basePath}/${version}${path}`)
    }), control?.maxResponseBytes);
    onStatus?.(response.status);
    return parseDataApiEnvelope<TResponse>(response);
  } catch (error) {
    const failure = toFMClientError(normalizeError(error, { fallbackMessage, endpoint: `GET ${path}` }));
    // Diagnosis already read the peer certificate with its own cancellable deadline.
    throw (skipCertificateInspection
      ? client.explainPinnedFailure(profile, failure)
      : await client.refineCertificateError(profile, failure));
  }
}
