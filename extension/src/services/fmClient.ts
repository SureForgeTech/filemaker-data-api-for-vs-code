import { CertificateAdvice } from './fmClient/certificates';
import { randomUUID } from 'crypto';
import axios, { type AxiosInstance } from 'axios';
import type {
  ConnectionProfile, ContainerUploadFile, EditRecordResult, FileMakerRecord, FindRecordsRequest,
  FindRecordsResult, RequestHistoryRecorder, RequestMetricsRecorder, RunScriptRequest, RunScriptResult
} from '../types/fm';
import type { DataApiEnvelope, DataApiSessionResponse } from '../types/dataApi';
import { isProxyProfile } from '../types/fm';
import type { Logger } from './logger';
import type { SecretStore } from './secretStore';
import { ProxyClient } from './proxyClient';
import { FMClientError, toFMClientError } from './errors';
import { normalizeError } from '../utils/normalizeError';
import { cacheKeyMatchesProfile } from '../utils/profileCacheKey';
import { docsUrlForCode, isCredentialRejection } from '../utils/fileMakerCodes';
import { SessionTokenTracker } from './session/sessionTokenTracker';
import { httpsTransportFor, noteRequestTimeout, pinBypassedByHost } from './tlsAgent';
import type {
  LayoutCacheEntry, RequestOptions, HistoryContext, RequestTrace, ClientRequestControl,
  FMClientContainerUploadOptions, AuthPause, SessionHealth, FMClientSessionOptions, EditRecordOptions
} from './fmClient/types';
import { listLayouts, listScripts, getLayoutMetadata } from './fmClient/metadata';
import { getRecord, listRecords, findRecords } from './fmClient/records';
import { editRecord, createRecord, deleteRecord } from './fmClient/recordWrites';
import { uploadContainer } from './fmClient/containers';
import { runScript } from './fmClient/scripts';
import { getProductInfo, getProductInfoDiagnostics, listHostedDatabases } from './fmClient/server';
import { requestWithAuth, requestNoAuth, buildEndpoint, requestWithAuthRaw } from './fmClient/transport';
import { getErrorStatus, getErrorMessage } from './fmClient/response';
import { credentialStamp, waitForSession } from './fmClient/session';
import type { ClientContext } from './fmClient/context';
export type { ClientRequestControl, FMClientContainerUploadOptions, SessionHealth, FMClientSessionOptions, EditRecordOptions } from './fmClient/types';
export { MAX_SCRIPT_URL_LENGTH } from './fmClient/types';

/** Longest wait between automatic sign-in attempts after FileMaker reports no free sessions (956). */
const MAX_SESSION_LIMIT_BACKOFF_MS = 5 * 60 * 1000;
const FIRST_SESSION_LIMIT_BACKOFF_MS = 30 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SESSION_MAX_AGE_MS = 14 * 60 * 1000; // 14 minutes; FM Data API tokens expire at 15
const DEFAULT_SESSION_REFRESH_LEAD_MS = 30 * 1000; // refresh 30s before nominal expiry

export class FMClient {
  private readonly httpClient: AxiosInstance;
  private readonly proxyClient: ProxyClient;
  private readonly layoutCache = new Map<string, LayoutCacheEntry>();
  private readonly layoutMetadataCache = new Map<string, Record<string, unknown>>();
  private readonly layoutMetadataEtags = new Map<string, string>();
  private readonly sessionTracker: SessionTokenTracker;
  private readonly inFlightRefresh = new Map<string, Promise<string>>();
  private readonly health = new Map<string, SessionHealth>();
  private readonly invalidationListeners = new Set<(profileId: string) => void>();
  private readonly healthListeners = new Set<(profileId: string, health: SessionHealth | undefined) => void>();
  /**
   * Profiles whose stored credentials FileMaker rejected (210, 211, 212, 213, 214). Automatic
   * sign-ins stop for them: trying again with the same password cannot work and repeated failures
   * can lock the account. The pause ends when the account, password or server changes, or when the
   * user runs Connect / Test Connection.
   */
  private readonly authPauses = new Map<string, AuthPause>();
  /**
   * Profiles whose last renewal ahead of expiry failed: no more of those are tried (each would be
   * another failed login) until a sign-in succeeds. The current token is used until the server
   * rejects it, and that rejection starts a real renewal, which can set a pause.
   */
  private readonly proactiveSuspended = new Set<string>();
  /** Profiles told "no free sessions" (956): automatic sign-ins wait, with growing delays. */
  private readonly sessionLimitBackoff = new Map<string, { until: number; attempts: number }>();
  private readonly timeoutMs: number;
  private readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  private readonly getSessionMaxAgeMs: () => number;
  private readonly getSessionRefreshLeadMs: () => number;
  private readonly now: () => number;

  private readonly certificateAdvice: CertificateAdvice;

  public constructor(
    private readonly secretStore: SecretStore,
    logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>,
    timeoutMs?: number,
    httpClient?: AxiosInstance,
    proxyClient?: ProxyClient,
    private readonly historyRecorder?: RequestHistoryRecorder,
    private readonly metricsRecorder?: RequestMetricsRecorder,
    sessionOptions?: FMClientSessionOptions | (() => FMClientSessionOptions)
  ) {
    this.logger = logger;
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // A TLS agent that is replaced must outlive the longest request that may be running on it.
    noteRequestTimeout(this.timeoutMs);
    this.httpClient = httpClient ?? axios.create({ timeout: this.timeoutMs });
    this.proxyClient =
      proxyClient ?? new ProxyClient(this.secretStore, this.logger, this.timeoutMs, this.httpClient);

    const resolveOptions = (): FMClientSessionOptions => {
      if (typeof sessionOptions === 'function') {
        return sessionOptions() ?? {};
      }
      return sessionOptions ?? {};
    };

    this.getSessionMaxAgeMs = () => resolveOptions().maxAgeMs ?? DEFAULT_SESSION_MAX_AGE_MS;
    this.getSessionRefreshLeadMs = () =>
      resolveOptions().refreshLeadMs ?? DEFAULT_SESSION_REFRESH_LEAD_MS;
    this.now = () => resolveOptions().now?.() ?? Date.now();
    this.sessionTracker = new SessionTokenTracker({
      defaultMaxAgeMs: DEFAULT_SESSION_MAX_AGE_MS,
      defaultRefreshLeadMs: DEFAULT_SESSION_REFRESH_LEAD_MS
    });
    this.certificateAdvice = new CertificateAdvice(this.now);
  }

  /**
   * A typed view for the extracted operations. Each member is checked against its actual private
   * declaration below; only visibility changes. The receiver stays this client, so prototype
   * callers and overrides keep working without copied state or bound callbacks.
   */
  private get context(): ClientContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Local type queries verify private members in the view.
    const client = this;
    return client as unknown as {
      httpClient: typeof client.httpClient;
      proxyClient: typeof client.proxyClient;
      logger: typeof client.logger;
      timeoutMs: typeof client.timeoutMs;
      layoutCache: typeof client.layoutCache;
      layoutMetadataCache: typeof client.layoutMetadataCache;
      layoutMetadataEtags: typeof client.layoutMetadataEtags;
      withHistory: typeof client.withHistory;
      requestWithAuth: typeof client.requestWithAuth;
      requestWithAuthRaw: typeof client.requestWithAuthRaw;
      ensureSessionToken: typeof client.ensureSessionToken;
      renewRejectedSession: typeof client.renewRejectedSession;
      explainPinnedFailure: typeof client.explainPinnedFailure;
      refineCertificateError: typeof client.refineCertificateError;
      getLayoutMetadata: typeof client.getLayoutMetadata;
      listRecords: typeof client.listRecords;
    };
  }

  /**
   * Visible for testing. Returns true if the in-memory issuance window indicates the token needs refresh.
   *
   * Behavior:
   * - If `refreshLeadMs` is 0, proactive timed refresh is disabled (rely on 401-retry only).
   * - If `issuedAt` is unknown (e.g., extension restart), reuse the persisted token instead of forcing
   *   refresh — the 401-retry path handles real expiry.
   * - Clock skew (negative ageMs) is treated as 0 to prevent extending lifetime via clock jumps.
   * - If `refreshLeadMs >= maxAgeMs`, lifetime is clamped to maxAgeMs to avoid infinite refresh loops.
   */
  public shouldRefreshSession(profileId: string, now = this.now()): boolean {
    return this.sessionTracker.shouldRefresh(profileId, {
      now,
      maxAgeMs: this.getSessionMaxAgeMs(),
      refreshLeadMs: this.getSessionRefreshLeadMs()
    });
  }

  public async createSession(profile: ConnectionProfile, control?: ClientRequestControl): Promise<string> {
    return this.withHistory(
      {
        profileId: profile.id,
        operation: 'createSession',
        endpoint: 'POST /sessions'
      },
      async (trace) => {
        if (this.health.get(profile.id)?.state !== 'connected') {
          this.setHealth(profile.id, { state: 'connecting', at: this.now() });
        }
        if (isProxyProfile(profile)) {
          const token = await this.proxyClient.createSession(profile, control?.signal);
          const normalizedToken = token ?? 'proxy-session';
          await this.secretStore.setSessionToken(profile.id, normalizedToken);
          this.sessionTracker.markIssued(profile.id, this.now());
          this.invalidateProfileCache(profile.id);
          return normalizedToken;
        }

        const username = profile.username?.trim();
        if (!username) {
          throw new FMClientError('Direct auth mode requires a username in the connection profile.');
        }

        const password = await this.secretStore.getPassword(profile.id);
        if (!password) {
          throw new FMClientError(
            'No password found for profile. Edit the connection profile to set a password.'
          );
        }

        const stamp = credentialStamp(profile, username, password);
        if (control?.userInitiated !== true) {
          this.assertAutomaticSignInAllowed(profile, stamp);
        }

        const basic = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');

        try {
          const envelope = await this.requestNoAuth<DataApiSessionResponse>(profile, {
            method: 'POST',
            path: '/sessions',
            headers: {
              Authorization: `Basic ${basic}`
            },
            data: {},
            signal: control?.signal
          });
          trace.endpoint = 'POST /sessions';

          const token = envelope.response.token;
          if (!token) {
            throw new FMClientError(
              'FileMaker create session response did not include a session token.',
              {
                details: envelope
              }
            );
          }

          await this.secretStore.setSessionToken(profile.id, token);
          this.sessionTracker.markIssued(profile.id, this.now());
          this.invalidateProfileCache(profile.id);
          this.authPauses.delete(profile.id);
          this.sessionLimitBackoff.delete(profile.id);
          this.proactiveSuspended.delete(profile.id);

          return token;
        } catch (error) {
          const failure = toFMClientError(
            normalizeError(error, {
              fallbackMessage: 'Failed to create FileMaker session.',
              operation: trace.operation,
              requestId: trace.requestId,
              endpoint: 'POST /sessions'
            })
          );
          if (control?.proactive !== true) {
            this.recordSignInFailure(profile, stamp, failure);
          }
          throw await this.refineCertificateError(profile, failure);
        }
      }
    );
  }

  public async deleteSession(profile: ConnectionProfile, control?: ClientRequestControl): Promise<void> {
    await this.withHistory(
      {
        profileId: profile.id,
        operation: 'deleteSession',
        endpoint: 'DELETE /sessions/{token}'
      },
      async (trace) => {
        const token = await this.secretStore.getSessionToken(profile.id);

        if (!token) {
          return;
        }

        try {
          if (isProxyProfile(profile)) {
            await this.proxyClient.deleteSession(profile, control?.signal);
          } else {
            // Use the existing token directly. Without skipProactiveRefresh, an in-flight
            // refresh window during disconnect could create a new session, then this DELETE
            // would target the old token while authenticating with the new one — orphaning
            // the new server-side session.
            await this.requestWithAuth<Record<string, unknown>>(
              profile,
              {
                method: 'DELETE',
                path: `/sessions/${encodeURIComponent(token)}`,
                signal: control?.signal
              },
              false,
              trace,
              { skipProactiveRefresh: true }
            );
          }
        } catch (error) {
          this.logger.warn('Failed to delete session cleanly during disconnect.', {
            profileId: profile.id,
            error
          });
        } finally {
          await this.secretStore.deleteSessionToken(profile.id);
          this.sessionTracker.clear(profile.id);
          this.invalidateProfileCache(profile.id);
        }
      }
    );
  }

  public async listLayouts(profile: ConnectionProfile, control?: ClientRequestControl): Promise<string[]> {
    return listLayouts(this.context, profile, control);
  }

  public async listScripts(profile: ConnectionProfile, control?: ClientRequestControl): Promise<string[]> {
    return listScripts(this.context, profile, control);
  }

  public async getRecord(
    profile: ConnectionProfile,
    layout: string,
    recordId: string,
    control?: ClientRequestControl
  ): Promise<FileMakerRecord> {
    return getRecord(this.context, profile, layout, recordId, control);
  }

  public async listRecords(
    profile: ConnectionProfile,
    layout: string,
    options: { limit?: number; offset?: number; sort?: FindRecordsRequest['sort'] } = {},
    control?: ClientRequestControl
  ): Promise<FindRecordsResult> {
    return listRecords(this.context, profile, layout, options, control);
  }

  public async findRecords(
    profile: ConnectionProfile,
    layout: string,
    body: FindRecordsRequest,
    control?: ClientRequestControl
  ): Promise<FindRecordsResult> {
    return findRecords(this.context, profile, layout, body, control);
  }

  public async getLayoutMetadata(
    profile: ConnectionProfile,
    layout: string,
    control?: ClientRequestControl & {
      /** Ancillary presentation lookups omit user history; metrics still record them. */
      recordHistory?: boolean;
    }
  ): Promise<Record<string, unknown>> {
    return getLayoutMetadata(this.context, profile, layout, control);
  }

  public async editRecord(
    profile: ConnectionProfile,
    layout: string,
    recordId: string,
    fieldDataPartial: Record<string, unknown>,
    control?: ClientRequestControl,
    options?: EditRecordOptions
  ): Promise<EditRecordResult> {
    return editRecord(this.context, profile, layout, recordId, fieldDataPartial, control, options);
  }

  public async createRecord(
    profile: ConnectionProfile,
    layout: string,
    fieldData: Record<string, unknown>,
    control?: ClientRequestControl
  ): Promise<EditRecordResult> {
    return createRecord(this.context, profile, layout, fieldData, control);
  }

  public async deleteRecord(
    profile: ConnectionProfile,
    layout: string,
    recordId: string,
    control?: ClientRequestControl
  ): Promise<EditRecordResult> {
    return deleteRecord(this.context, profile, layout, recordId, control);
  }

  public async uploadContainer(
    profile: ConnectionProfile,
    layout: string,
    recordId: string,
    fieldName: string,
    file: ContainerUploadFile,
    options?: FMClientContainerUploadOptions
  ): Promise<EditRecordResult> {
    return uploadContainer(this.context, profile, layout, recordId, fieldName, file, options);
  }

  /**
   * Runs a FileMaker script the way the Claris Data API Guide documents it ("Run a script",
   * https://help.claris.com/en/data-api-guide/content/run-a-script.html):
   *
   *   GET /fmi/data/<version>/databases/<db>/layouts/<layout>/script/<script>?script.param=<text>
   *
   * The response carries `scriptError` (and `scriptResult` when the script exits with a result).
   * Nothing else is requested: no record is read or changed.
   *
   * When a record is needed, or the script endpoint is unsupported, attach the script to a GET
   * of the selected record or a GET records limited to one. Without a record ID, long parameters
   * use a wildcard find on a normal stored text field, limited to one record. An empty find is invalid,
   * and a find with no matches does not run the attached script (verified 2026-10-21).
   */
  public async runScript(
    profile: ConnectionProfile,
    request: RunScriptRequest,
    control?: ClientRequestControl
  ): Promise<RunScriptResult> {
    return runScript(this.context, profile, request, control);
  }

  /**
   * Step one of Test Connection: `GET /fmi/data/<version>/productInfo` needs no account and no
   * database, so it separates "cannot reach the Data API" (TLS, DNS, port, a web page, Data API
   * off) from everything about the account. Returns the product name and version.
   */
  public async getProductInfo(
    profile: ConnectionProfile,
    control?: ClientRequestControl
  ): Promise<{ name?: string; version?: string }> {
    return getProductInfo(this.context, profile, control);
  }

  /** Unauthenticated connection diagnosis through the same transport as Test Connection. */
  public async getProductInfoDiagnostics(
    profile: ConnectionProfile,
    control?: ClientRequestControl
  ): Promise<{ status: number; code?: string; name?: string; version?: string }> {
    return getProductInfoDiagnostics(this.context, profile, control);
  }

  /**
   * Step two: `GET /fmi/data/<version>/databases`. Without credentials FileMaker lists the hosted
   * databases unless "Filter Databases in Client Applications" is on, in which case it answers
   * 401 and the list is unavailable until sign-in (returned as `undefined`).
   */
  public async listHostedDatabases(
    profile: ConnectionProfile,
    control?: ClientRequestControl
  ): Promise<string[] | undefined> {
    return listHostedDatabases(this.context, profile, control);
  }

  /**
   * Calls `listener` whenever the cached data of a profile is dropped: a new sign-in (the account may
   * have changed, and with it the layouts and fields it can see), a sign-out, or a profile edit.
   * Other caches built on this client (the schema cache) use it to drop theirs too.
   */
  public onProfileInvalidated(listener: (profileId: string) => void): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  public invalidateProfileCache(profileId: string): void {
    for (const listener of this.invalidationListeners) {
      try {
        listener(profileId);
      } catch (error) {
        this.logger.warn('A cache invalidation listener failed.', { error });
      }
    }
    for (const key of this.layoutCache.keys()) {
      if (cacheKeyMatchesProfile(key, profileId)) {
        this.layoutCache.delete(key);
      }
    }

    for (const key of this.layoutMetadataCache.keys()) {
      if (cacheKeyMatchesProfile(key, profileId)) {
        this.layoutMetadataCache.delete(key);
      }
    }

    for (const key of this.layoutMetadataEtags.keys()) {
      if (cacheKeyMatchesProfile(key, profileId)) {
        this.layoutMetadataEtags.delete(key);
      }
    }
  }

  /** A pinned profile's certificate failure, explained when the host replaced the agent that would have applied the pin. */
  private explainPinnedFailure(profile: ConnectionProfile, failure: FMClientError): FMClientError {
    return pinBypassedByHost(profile, failure) ?? failure;
  }

  private async refineCertificateError(profile: ConnectionProfile, failure: FMClientError): Promise<FMClientError> {
    return this.certificateAdvice.refine(profile, failure);
  }

  /** The last known health of a profile's connection, or undefined before any request this session. */
  public getHealth(profileId: string): SessionHealth | undefined {
    return this.health.get(profileId);
  }

  /** Calls `listener` whenever a profile's health changes. Returns a function that stops it. */
  public onHealthChange(listener: (profileId: string, health: SessionHealth | undefined) => void): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  private setHealth(profileId: string, next: SessionHealth | undefined): void {
    const before = this.health.get(profileId);
    if (next) {
      this.health.set(profileId, next);
    } else {
      this.health.delete(profileId);
    }
    if (before?.state !== next?.state || before?.message !== next?.message) {
      for (const listener of this.healthListeners) {
        try {
          listener(profileId, next);
        } catch (error) {
          this.logger.warn('A health listener failed.', { error });
        }
      }
    }
  }

  /**
   * What a failed request says about the connection, or undefined when it says nothing and the last
   * known state should stand. Only a FileMaker answer (an error code) proves the connection works;
   * a gateway error or a cancelled request proves nothing.
   */
  private healthAfterFailure(error: unknown): SessionHealth | undefined {
    const at = this.now();
    if (!(error instanceof FMClientError)) {
      return undefined;
    }
    if (error.kind === 'cancellation') {
      return undefined;
    }
    if (error.kind === 'certificate') {
      return { state: 'certificate', message: error.message, at };
    }
    if (error.fmCategory === 'credentials' || (error.kind === 'auth' && error.fmCategory !== 'privilege')) {
      return { state: 'auth-failed', message: error.message, at };
    }
    if (error.networkCode || error.kind === 'network' || error.kind === 'timeout') {
      return { state: 'unreachable', message: error.message, at };
    }
    if (error.code === 'NOT_DATA_API_RESPONSE') {
      return { state: 'unreachable', message: error.message, at };
    }
    if (error.code === undefined) {
      // No FileMaker answer: a gateway or proxy error (502, 503, 504 ...) or a bare 404 means the
      // Data API did not answer. Other statuses without a code say nothing certain.
      if (typeof error.status === 'number' && (error.status >= 500 || error.status === 404)) {
        return { state: 'unreachable', message: error.message, at };
      }
      return undefined;
    }
    // An answer from FileMaker (a missing layout, a refused write) proves the connection works.
    return { state: 'connected', at };
  }

  /** Ends a pause on automatic sign-ins now (the credentials were just edited). */
  public clearAuthPause(profileId: string): void {
    this.authPauses.delete(profileId);
    this.sessionLimitBackoff.delete(profileId);
    this.proactiveSuspended.delete(profileId);
  }

  /**
   * Forgets everything held for a profile id that is no longer used (the throwaway profile behind a
   * Test Connection): pause, backoff, health and token timing.
   */
  public forgetProfile(profileId: string): void {
    this.authPauses.delete(profileId);
    this.sessionLimitBackoff.delete(profileId);
    this.proactiveSuspended.delete(profileId);
    this.sessionTracker.clear(profileId);
    this.inFlightRefresh.delete(profileId);
    this.setHealth(profileId, undefined);
  }

  /** True while automatic sign-ins are paused for this profile because FileMaker rejected its credentials. */
  public isSignInPaused(profileId: string): boolean {
    return this.authPauses.has(profileId);
  }

  private assertAutomaticSignInAllowed(profile: ConnectionProfile, stamp: string): void {
    const pause = this.authPauses.get(profile.id);
    if (pause) {
      if (pause.stamp !== stamp) {
        this.authPauses.delete(profile.id);
      } else {
        throw new FMClientError(
          `Sign-in is paused: FileMaker rejected the saved credentials (error ${pause.code}) and the extension will not try again on its own, so repeated attempts cannot lock the account.${pause.code === '214' ? ' Error 214 can be a temporary lockout: wait a while before trying again.' : ''} Edit the connection to fix the account or password, or run "FileMaker: Connect".`,
          {
            code: pause.code,
            kind: 'auth',
            fmCategory: 'credentials',
            docsUrl: docsUrlForCode(pause.code),
            isRetryable: false,
            details: { signInPaused: true }
          }
        );
      }
    }

    const wait = this.sessionLimitBackoff.get(profile.id);
    if (wait && wait.until > this.now()) {
      const seconds = Math.ceil((wait.until - this.now()) / 1000);
      throw new FMClientError(
        `FileMaker has reached its maximum number of database or Admin API sessions. Waiting ${seconds} s before signing in again (run "FileMaker: Connect" to try now), or ask the administrator to disconnect idle clients.`,
        { code: '956', kind: 'server', fmCategory: 'transient', isRetryable: true, retryAfterMs: wait.until - this.now() }
      );
    }
  }

  private recordSignInFailure(profile: ConnectionProfile, stamp: string, failure: FMClientError): void {
    if (isCredentialRejection(failure.code)) {
      this.authPauses.set(profile.id, { code: failure.code as string, stamp });
      this.logger.warn('FileMaker rejected the stored credentials; automatic sign-ins are paused for this profile.', {
        profileId: profile.id,
        code: failure.code
      });
    } else if (failure.code === '956') {
      const attempts = (this.sessionLimitBackoff.get(profile.id)?.attempts ?? 0) + 1;
      const delay = Math.min(FIRST_SESSION_LIMIT_BACKOFF_MS * 2 ** (attempts - 1), MAX_SESSION_LIMIT_BACKOFF_MS);
      this.sessionLimitBackoff.set(profile.id, { until: this.now() + delay, attempts });
    }
  }

  private async ensureSessionToken(
    profile: ConnectionProfile,
    control?: ClientRequestControl,
    options?: { skipProactiveRefresh?: boolean }
  ): Promise<string> {
    const existing = await this.secretStore.getSessionToken(profile.id);

    // Allow callers (e.g., deleteSession) to opt out of proactive refresh so they can use
    // the existing token rather than creating a new session that gets orphaned on the server.
    const skipProactive = options?.skipProactiveRefresh === true;

    if (existing && (skipProactive || this.proactiveSuspended.has(profile.id) || !this.shouldRefreshSession(profile.id))) {
      return existing;
    }

    if (!existing && skipProactive) {
      // Fall through to createSession — there's no token to delete.
    }

    // Per-profile mutex to coalesce concurrent refreshes. Without this, parallel requests
    // each call createSession, creating multiple FM sessions where only the last persisted
    // token is reused — orphaning the rest until server timeout.
    const inFlight = this.inFlightRefresh.get(profile.id);
    if (inFlight) {
      return waitForSession(inFlight, control?.signal);
    }

    if (existing) {
      this.logger.debug('Proactively refreshing session token before request.', {
        profileId: profile.id
      });
    }

    // A renewal ahead of expiry that fails (the password changed meanwhile, the server is busy) must
    // not stop work that the current token can still do: keep using it, and pause nothing. If the
    // token has really expired, the 401 on the next request starts a real renewal, which can pause.
    const refreshPromise = this.createSession(profile, { proactive: Boolean(existing), userInitiated: control?.userInitiated })
      .then((token) => {
        if (existing && existing !== token) void this.retireSession(profile, existing);
        return token;
      })
      .catch((error) => {
        if (!existing) {
          throw error;
        }
        this.proactiveSuspended.add(profile.id);
        this.logger.warn('Proactive session renewal failed; continuing with the current token.', {
          profileId: profile.id,
          error
        });
        return existing;
      })
      .finally(() => {
        this.inFlightRefresh.delete(profile.id);
      });

    this.inFlightRefresh.set(profile.id, refreshPromise);

    return waitForSession(refreshPromise, control?.signal);
  }

  private async retireSession(profile: ConnectionProfile, token: string): Promise<void> {
    // Proxy sessions are managed by the proxy; its logout would delete the replacement session.
    if (isProxyProfile(profile)) return;
    const timeout = Math.min(this.timeoutMs, 3000);
    try {
      const url = buildEndpoint(profile, `/sessions/${encodeURIComponent(token)}`);
      await this.httpClient.request({ method: 'DELETE', url,
        headers: { Authorization: `Bearer ${token}` }, timeout, signal: AbortSignal.timeout(timeout),
        maxRedirects: 0, ...httpsTransportFor(profile, url) });
    } catch {
      // Never log an exception here: it can contain the token in the URL or headers.
      this.logger.warn('Could not close the previous FileMaker session; it will expire on the server.');
    }
  }

  /**
   * Replaces a session token the server rejected. Parallel requests that all hit the
   * expired token share one renewal: a request that finds a newer token already stored
   * just retries with it, and one that finds a renewal under way waits for it. Without
   * this, N parallel requests would open N sessions and leave N-1 orphaned on the server.
   */
  private async renewRejectedSession(
    profile: ConnectionProfile,
    rejectedToken: string,
    control?: ClientRequestControl
  ): Promise<void> {
    const current = await this.secretStore.getSessionToken(profile.id);
    if (current && current !== rejectedToken) {
      return;
    }

    const inFlight = this.inFlightRefresh.get(profile.id);
    if (inFlight) {
      await waitForSession(inFlight, control?.signal);
      return;
    }

    // Registered synchronously (no await between the check above and the set below),
    // so concurrent callers resuming after their own awaits see it.
    const issuedAt = this.sessionTracker.getIssuedAt(profile.id);
    const presumedLive = issuedAt !== undefined && Math.max(0, this.now() - issuedAt) < this.getSessionMaxAgeMs();
    const renewal = (async () => {
      await this.secretStore.deleteSessionToken(profile.id);
      this.sessionTracker.clear(profile.id);
      const token = await this.createSession(profile);
      if (presumedLive && token !== rejectedToken) void this.retireSession(profile, rejectedToken);
      return token;
    })().finally(() => {
      this.inFlightRefresh.delete(profile.id);
    });
    this.inFlightRefresh.set(profile.id, renewal);
    await waitForSession(renewal, control?.signal);
  }

  private async requestWithAuth<TResponse extends Record<string, unknown>>(
    profile: ConnectionProfile,
    request: RequestOptions,
    retryOn401 = true,
    trace?: RequestTrace,
    authOptions?: { skipProactiveRefresh?: boolean }
  ): Promise<DataApiEnvelope<TResponse>> {
    return requestWithAuth(this.context, profile, request, retryOn401, trace, authOptions);
  }

  private async requestWithAuthRaw<TResponse extends Record<string, unknown>>(
    profile: ConnectionProfile,
    request: RequestOptions,
    retryOn401 = true,
    trace?: RequestTrace
  ): Promise<{
    status: number;
    headers: Record<string, string | undefined>;
    envelope?: DataApiEnvelope<TResponse>;
  }> {
    return requestWithAuthRaw<TResponse>(this.context, profile, request, retryOn401, trace);
  }

  private async requestNoAuth<TResponse extends Record<string, unknown>>(
    profile: ConnectionProfile,
    request: RequestOptions
  ): Promise<DataApiEnvelope<TResponse>> {
    return requestNoAuth(this.context, profile, request);
  }

  private async withHistory<T>(
    context: HistoryContext,
    execute: (trace: RequestTrace) => Promise<T>
  ): Promise<T> {
    const trace: RequestTrace = {
      operation: context.operation,
      requestId: randomUUID(),
      reauthCount: 0,
      cacheHit: false,
      endpoint: context.endpoint
    };

    const start = Date.now();
    this.logger.debug('FileMaker request started.', {
      requestId: trace.requestId,
      operation: context.operation,
      endpoint: trace.endpoint,
      profileId: context.profileId
    });

    try {
      const result = await execute(trace);
      if (context.operation === 'deleteSession') {
        this.setHealth(context.profileId, undefined);
      } else {
        this.setHealth(context.profileId, { state: 'connected', at: this.now() });
      }
      this.logger.debug('FileMaker request completed.', {
        requestId: trace.requestId,
        operation: context.operation,
        endpoint: trace.endpoint,
        durationMs: Date.now() - start,
        reauthCount: trace.reauthCount,
        cacheHit: trace.cacheHit
      });
      if (context.recordHistory !== false) await this.recordHistory({
        requestId: trace.requestId,
        profileId: context.profileId,
        layout: context.layout,
        operation: context.operation,
        durationMs: Date.now() - start,
        success: true
      });
      await this.recordMetrics({
        requestId: trace.requestId,
        profileId: context.profileId,
        operation: context.operation,
        endpoint: trace.endpoint,
        durationMs: Date.now() - start,
        success: true,
        reauthCount: trace.reauthCount,
        cacheHit: trace.cacheHit
      });
      return result;
    } catch (error) {
      if (context.operation !== 'deleteSession') {
        const health = this.healthAfterFailure(error);
        if (health) {
          this.setHealth(context.profileId, health);
        }
      }
      this.logger.warn('FileMaker request failed.', {
        requestId: trace.requestId,
        operation: context.operation,
        endpoint: trace.endpoint,
        durationMs: Date.now() - start,
        reauthCount: trace.reauthCount,
        cacheHit: trace.cacheHit,
        error
      });
      if (context.recordHistory !== false) await this.recordHistory({
        requestId: trace.requestId,
        profileId: context.profileId,
        layout: context.layout,
        operation: context.operation,
        durationMs: Date.now() - start,
        success: false,
        httpStatus: getErrorStatus(error),
        message: getErrorMessage(error)
      });
      await this.recordMetrics({
        requestId: trace.requestId,
        profileId: context.profileId,
        operation: context.operation,
        endpoint: trace.endpoint,
        durationMs: Date.now() - start,
        success: false,
        httpStatus: getErrorStatus(error),
        reauthCount: trace.reauthCount,
        cacheHit: trace.cacheHit
      });

      throw error;
    }
  }

  private async recordHistory(entry: {
    requestId?: string;
    profileId: string;
    layout?: string;
    operation: string;
    durationMs: number;
    success: boolean;
    httpStatus?: number;
    message?: string;
  }): Promise<void> {
    if (!this.historyRecorder) {
      return;
    }

    try {
      await this.historyRecorder.record(entry);
    } catch (error) {
      this.logger.warn('Failed to persist request history entry.', { error });
    }
  }

  private async recordMetrics(entry: {
    requestId: string;
    profileId: string;
    operation: string;
    endpoint: string;
    durationMs: number;
    success: boolean;
    httpStatus?: number;
    reauthCount: number;
    cacheHit: boolean;
  }): Promise<void> {
    if (!this.metricsRecorder) {
      return;
    }

    try {
      await this.metricsRecorder.record(entry);
    } catch (error) {
      this.logger.warn('Failed to persist request metrics entry.', { error });
    }
  }
}
