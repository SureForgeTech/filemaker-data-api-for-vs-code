import { withRequestLimits } from '../requestLimits';
import { type AxiosError, type AxiosRequestConfig } from 'axios';
import type { ConnectionProfile } from '../../types/fm';
import type { DataApiEnvelope } from '../../types/dataApi';
import { toFMClientError } from '../errors';
import { normalizeError } from '../../utils/normalizeError';
import { redactString } from '../../utils/redact';
import { httpsTransportFor } from '../tlsAgent';
import { parseDataApiEnvelope } from '../responseGuard';
import type { RequestOptions, RequestTrace } from './types';
import type { ClientContext } from './context';
import { normalizeHeaders } from './response';

export async function requestWithAuth<TResponse extends Record<string, unknown>>(
  client: ClientContext,
  profile: ConnectionProfile,
  request: RequestOptions,
  retryOn401 = true,
  trace?: RequestTrace,
  authOptions?: { skipProactiveRefresh?: boolean }
): Promise<DataApiEnvelope<TResponse>> {
  if (trace) {
    trace.endpoint = redactString(`${request.method} ${request.path}`);
  }

  const token = await client.ensureSessionToken(profile, { signal: request.signal }, authOptions);

  try {
    const config: AxiosRequestConfig = {
      method: request.method,
      url: buildEndpoint(profile, request.path),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(request.headers ?? {})
      },
      data: request.data,
      params: request.params,
      ...(request.strictQuery ? { paramsSerializer: { serialize: strictQuerySerializer } } : {}),
      // The Data API never redirects. Following one could send a login to another server or drop
      // the request body; a redirect is reported as an error that says where it pointed.
      maxRedirects: 0,
      ...httpsTransportFor(profile, buildEndpoint(profile, request.path))
    };

    const response = await withRequestLimits(client.timeoutMs, request.signal,
      (limits) => client.httpClient.request<unknown>({ ...config, ...limits }), request.maxResponseBytes, request.transfer, config.transport);
    return parseDataApiEnvelope<TResponse>(response);
  } catch (error) {
    const axiosError = error as AxiosError;
    if (axiosError.response?.status === 401 && retryOn401) {
      if (trace) {
        trace.reauthCount += 1;
      }
      client.logger.info('Session token rejected; refreshing token and retrying once.', {
        profileId: profile.id,
        requestId: trace?.requestId
      });
      await client.renewRejectedSession(profile, token, { signal: request.signal });

      return requestWithAuth(client, profile, request, false, trace);
    }

    throw client.explainPinnedFailure(
      profile,
      toFMClientError(
        normalizeError(error, {
          operation: trace?.operation,
          requestData: request.data,
          requestParams: request.params,
          fallbackMessage: `FileMaker request failed (${redactString(`${request.method} ${request.path}`)}).`,
          requestId: trace?.requestId,
          endpoint: redactString(`${request.method} ${request.path}`)
        })
      )
    );
  }
}

export async function requestWithAuthRaw<TResponse extends Record<string, unknown>>(
  client: ClientContext,
  profile: ConnectionProfile,
  request: RequestOptions,
  retryOn401 = true,
  trace?: RequestTrace
): Promise<{
  status: number;
  headers: Record<string, string | undefined>;
  envelope?: DataApiEnvelope<TResponse>;
}> {
  if (trace) {
    trace.endpoint = redactString(`${request.method} ${request.path}`);
  }

  const token = await client.ensureSessionToken(profile, { signal: request.signal });

  try {
    const config: AxiosRequestConfig = {
      method: request.method,
      url: buildEndpoint(profile, request.path),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(request.headers ?? {})
      },
      data: request.data,
      params: request.params,
      ...(request.strictQuery ? { paramsSerializer: { serialize: strictQuerySerializer } } : {}),
      maxRedirects: 0,
      ...httpsTransportFor(profile, buildEndpoint(profile, request.path)),
      validateStatus: (status) => (status >= 200 && status < 300) || status === 304
    };

    const response = await withRequestLimits(client.timeoutMs, request.signal,
      (limits) => client.httpClient.request<unknown>({ ...config, ...limits }), request.maxResponseBytes, request.transfer, config.transport);
    const headers = normalizeHeaders(response.headers as Record<string, unknown>);
    if (response.status === 304) {
      return {
        status: response.status,
        headers
      };
    }

    return {
      status: response.status,
      headers,
      envelope: parseDataApiEnvelope<TResponse>(response)
    };
  } catch (error) {
    const axiosError = error as AxiosError;
    if (axiosError.response?.status === 401 && retryOn401) {
      if (trace) {
        trace.reauthCount += 1;
      }
      client.logger.info('Session token rejected; refreshing token and retrying once.', {
        profileId: profile.id,
        requestId: trace?.requestId
      });
      await client.renewRejectedSession(profile, token, { signal: request.signal });

      return requestWithAuthRaw(client, profile, request, false, trace);
    }

    throw client.explainPinnedFailure(
      profile,
      toFMClientError(
        normalizeError(error, {
          operation: trace?.operation,
          requestData: request.data,
          requestParams: request.params,
          fallbackMessage: `FileMaker request failed (${redactString(`${request.method} ${request.path}`)}).`,
          requestId: trace?.requestId,
          endpoint: redactString(`${request.method} ${request.path}`)
        })
      )
    );
  }
}

export async function requestNoAuth<TResponse extends Record<string, unknown>>(
  client: ClientContext,
  profile: ConnectionProfile,
  request: RequestOptions
): Promise<DataApiEnvelope<TResponse>> {
  const config: AxiosRequestConfig = {
    method: request.method,
    url: buildEndpoint(profile, request.path),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(request.headers ?? {})
    },
    data: request.data,
    params: request.params,
    maxRedirects: 0,
    ...httpsTransportFor(profile, buildEndpoint(profile, request.path))
  };

  const response = await withRequestLimits(client.timeoutMs, request.signal,
    (limits) => client.httpClient.request<unknown>({ ...config, ...limits }), request.maxResponseBytes);
  return parseDataApiEnvelope<TResponse>(response);
}

export function buildEndpoint(profile: ConnectionProfile, path: string): string {
  const server = new URL(profile.serverUrl);
  server.username = '';
  server.password = '';
  const normalizedServer = server.toString().replace(/\/+$/, '');
  const normalizedBasePath = normalizePath(profile.apiBasePath ?? '/fmi/data');
  const version = (profile.apiVersionPath ?? 'vLatest').replace(/^\/+|\/+$/g, '');
  const database = encodeURIComponent(profile.database);

  return `${normalizedServer}${normalizedBasePath}/${version}/databases/${database}${path}`;
}

export function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith('/')) {
    return `/${trimmed.replace(/\/+$/, '')}`;
  }

  return trimmed.replace(/\/+$/, '');
}

/** `a=b&c=d` with every key and value percent-encoded (a space is `%20`, a `+` is `%2B`, a `|` is `%7C`). */
export function strictQuerySerializer(params: Record<string, unknown>): string {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}
