import axios, { type AxiosResponse } from 'axios';
import type * as vscode from 'vscode';

import { withRequestLimits } from './requestLimits';
import { FMClient } from './fmClient';
import { FMClientError } from './errors';
import type { Logger } from './logger';
import { SecretStore } from './secretStore';
import { parseDataApiEnvelope } from './responseGuard';
import { httpsTransportFor } from './tlsAgent';
import type { ConnectionProfile } from '../types/fm';
import type { SelfTestClient, SelfTestObservation } from './serverSelfTest';
import { redactString } from '../utils/redact';

/** A private, memory-only session: testing never logs out the active connection. */
export async function createSelfTestClient(
  profile: ConnectionProfile, stored: SecretStore, logger: Logger, timeout: number
): Promise<SelfTestClient> {
  const memory = new Map<string, string>();
  const secrets = new Set<string>();
  const storage = {
    get: async (key: string) => memory.get(key),
    store: async (key: string, value: string) => { memory.set(key, value); if (value) secrets.add(value); },
    delete: async (key: string) => { memory.delete(key); }
  } as Pick<vscode.SecretStorage, 'get' | 'store' | 'delete'>;
  const temporary = new SecretStore(storage as vscode.SecretStorage);
  const password = await stored.getPassword(profile.id);
  const key = await stored.getProxyApiKey(profile.id);
  if (password !== undefined) await temporary.setPassword(profile.id, password);
  if (key !== undefined) await temporary.setProxyApiKey(profile.id, key);
  const http = axios.create({ timeout, maxRedirects: 0 });
  let observed: SelfTestObservation = {};
  let requestFailed = false;
  const observe = (response: AxiosResponse<unknown> | undefined) => {
    if (!response) return;
    const data = response.data as { messages?: Array<{ code?: unknown; message?: unknown }> } | undefined;
    const first = data?.messages?.[0];
    const request = response.request as { socket?: { getProtocol?: () => string | null } } | undefined;
    observed = {
      status: response.status,
      code: first?.code === undefined ? undefined : String(first.code),
      message: typeof first?.message === 'string' ? first.message : undefined,
      tls: request?.socket?.getProtocol?.() ?? undefined
    };
  };
  http.interceptors.response.use((response) => { observe(response); return response; }, (error: unknown) => {
    requestFailed = true;
    if (axios.isAxiosError(error)) observe(error.response);
    return Promise.reject(error);
  });
  // No request history: in particular no scratch values or script parameter is saved there.
  const client = new FMClient(temporary, {
    debug: (message) => logger.debug(redactString(message)),
    info: (message) => logger.info(redactString(message)),
    warn: (message) => logger.warn(redactString(message)),
    error: (message) => logger.error(redactString(message))
  }, timeout, http);
  const logout = client.deleteSession.bind(client);
  return Object.assign(client, {
    resetObservation: () => { observed = {}; requestFailed = false; },
    deleteSession: async (target: ConnectionProfile) => {
      observed = {};
      requestFailed = false;
      await logout(target);
      // Normal Disconnect intentionally swallows errors. A self-test must report them.
      if (requestFailed || (observed.code !== undefined && observed.code !== '0')) {
        throw new FMClientError('Logout was not confirmed.', { status: observed.status, code: observed.code });
      }
    },
    observation: () => ({ ...observed }),
    scrub: (text: string) => {
      for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
        text = text.split(secret).join('***');
        text = text.split(JSON.stringify(secret).slice(1, -1)).join('***');
      }
      return redactString(text);
    },
    verifyLoggedOut: async (target: ConnectionProfile, token: string, signal?: AbortSignal) => {
      const base = target.serverUrl.replace(/\/+$/, '');
      const path = `/${(target.apiBasePath ?? '/fmi/data').replace(/^\/+|\/+$/g, '')}/${(target.apiVersionPath ?? 'vLatest').replace(/^\/+|\/+$/g, '')}/databases/${encodeURIComponent(target.database)}/layouts`;
      const url = `${base}${path}`;
      // Deliberately bypass automatic re-login. This request tests the old token itself.
      const response = await withRequestLimits(timeout, signal, (limits) => http.get(url, {
        headers: { Authorization: `Bearer ${token}` }, ...limits, ...httpsTransportFor(target, url)
      }));
      parseDataApiEnvelope(response);
    }
  });
}
