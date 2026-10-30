import { assertFindCriteria } from '../utils/findCriteria';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';

import { assertNoNulText } from '../utils/nulText';
import type { FindRecordsRequest } from '../types/fm';
import type { FMClient } from './fmClient';
import { FMClientError } from './errors';
import type { FmWebProjectService } from './fmWebProjectService';
import type { Logger } from './logger';
import type { ProfileStore } from './profileStore';
import {
  BridgeRateLimiter,
  DEFAULT_BRIDGE_RATE_LIMIT,
  type BridgeRateLimitConfig
} from './bridgeRateLimiter';

const MAX_BODY_BYTES = 1_000_000;
const DEFAULT_ROUTE_TIMEOUT_MS = 20_000;

export interface FmBridgeServerOptions {
  /** Resolved at request time so settings updates flow live. */
  getRateLimitConfig?: () => BridgeRateLimitConfig;
  /**
   * Called before a route runs. Returns why the request must be refused (offline mode, a
   * feature switched off, enterprise policy), or undefined to let it through. The preview
   * app is code from the repository, so it gets the same limits as the user's own commands.
   */
  authorizeRoute?: (route: string) => Promise<string | undefined>;
}

export class FmBridgeServer {
  private server: Server | undefined;
  private port: number | undefined;
  private sessionToken: string | undefined;
  private rateLimiter: BridgeRateLimiter | undefined;
  private rateLimitWarningEmitted = false;

  public constructor(
    private readonly profileStore: Pick<ProfileStore, 'getActiveProfileId' | 'getProfile'>,
    private readonly fmClient: Pick<
      FMClient,
      'listRecords' | 'findRecords' | 'getRecord' | 'editRecord' | 'createRecord' | 'deleteRecord' | 'runScript'
    >,
    private readonly fmWebProjectService: Pick<FmWebProjectService, 'isWorkspaceTrusted' | 'readProjectConfig'>,
    private readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>,
    private readonly options: FmBridgeServerOptions = {}
  ) {}

  public async ensureStarted(): Promise<{ port: number; baseUrl: string }> {
    if (this.server && this.port) {
      return {
        port: this.port,
        baseUrl: this.getBaseUrl()
      };
    }

    if (!this.fmWebProjectService.isWorkspaceTrusted()) {
      throw new Error('Workspace trust is required to start the FM bridge server.');
    }

    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Failed to bind FM bridge server to a localhost port.');
    }

    this.server = server;
    this.port = address.port;
    this.sessionToken = randomBytes(32).toString('hex');
    const rateConfig = this.options.getRateLimitConfig?.() ?? DEFAULT_BRIDGE_RATE_LIMIT;
    this.rateLimiter = new BridgeRateLimiter(rateConfig);
    this.rateLimitWarningEmitted = false;
    this.logger.info('FM bridge server started.', {
      port: this.port,
      rateLimit: {
        perSecond: rateConfig.perSecond,
        burst: rateConfig.burst,
        budget: rateConfig.budget
      }
    });

    return {
      port: this.port,
      baseUrl: this.getBaseUrl()
    };
  }

  public async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    this.sessionToken = undefined;
    this.rateLimiter = undefined;
    this.rateLimitWarningEmitted = false;

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  public dispose(): void {
    void this.stop();
  }

  public isRunning(): boolean {
    return Boolean(this.server && this.port);
  }

  public getSessionToken(): string | undefined {
    return this.sessionToken;
  }

  public getBaseUrl(): string {
    if (!this.port) {
      throw new Error('FM bridge server is not running.');
    }

    return `http://127.0.0.1:${this.port}/fm`;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!this.fmWebProjectService.isWorkspaceTrusted()) {
        this.sendJson(response, 403, { error: 'Workspace trust is required.' });
        return;
      }

      if (!isLocalSocket(request.socket.remoteAddress)) {
        this.sendJson(response, 403, { error: 'Bridge server only accepts localhost clients.' });
        return;
      }

      const origin = readHeader(request.headers.origin);
      if (origin && !isAllowedOrigin(origin)) {
        this.sendJson(response, 403, { error: 'Origin is not allowed.' });
        return;
      }

      this.setCorsHeaders(response, origin);

      const bridgeToken = readHeader(request.headers['x-fm-bridge-token']);
      if (request.method !== 'OPTIONS' && !tokenMatches(bridgeToken, this.sessionToken)) {
        this.sendJson(response, 403, { error: 'Invalid or missing bridge session token.' });
        return;
      }

      if (request.method === 'OPTIONS') {
        response.statusCode = 204;
        response.end();
        return;
      }

      // Rate-limit enforcement: a misbehaving local process holding the token
      // can otherwise hammer FileMaker indefinitely. Token-bucket per session.
      const decision = this.rateLimiter?.tryConsume();
      if (decision && !decision.ok) {
        if (decision.retryAfterMs > 0) {
          response.setHeader('Retry-After', Math.ceil(decision.retryAfterMs / 1000).toString());
        }
        // Log once per session when first throttled to avoid log spam; subsequent
        // 429s are visible to the calling client.
        if (!this.rateLimitWarningEmitted) {
          this.rateLimitWarningEmitted = true;
          this.logger.warn('FM bridge throttled a request (further throttling will not log).', {
            reason: decision.reason,
            remaining: decision.remaining
          });
        }
        this.sendJson(response, 429, {
          error:
            decision.reason === 'budget'
              ? 'Bridge request budget exhausted for this session. Restart the bridge to reset.'
              : 'Bridge rate limit exceeded; slow down and retry.',
          retryAfterMs: decision.retryAfterMs,
          reason: decision.reason
        });
        return;
      }

      if (request.method !== 'POST') {
        this.sendJson(response, 405, { error: 'Only POST requests are supported.' });
        return;
      }

      const route = getRoutePath(request.url);
      if (!route) {
        this.sendJson(response, 404, { error: 'Bridge route not found.' });
        return;
      }

      const payload = await readJsonBody(request);
      const result = await this.dispatchRoute(route, payload as Record<string, unknown>);
      this.sendJson(response, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Bridge request failed.';
      const status = error instanceof FMClientError && error.status ? error.status : 500;
      this.logger.warn('FM bridge request failed.', {
        error,
        status
      });
      this.sendJson(response, status, { error: message, ...(error instanceof FMClientError && error.code ? { code: error.code } : {}) });
    }
  }

  private async dispatchRoute(
    route: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const refusal = await this.options.authorizeRoute?.(route);
    if (refusal) {
      throw new FMClientError(refusal, { status: 403 });
    }

    // The preview app is repository code. It may name a profile only if that is the one the
    // bridge would use anyway, so it cannot reach for another saved connection.
    const requestedProfileId = readString(payload.profileId);
    const defaultProfileId = await this.resolveProfileId();
    if (requestedProfileId && requestedProfileId !== defaultProfileId) {
      throw new FMClientError('The bridge only serves the active connection.', { status: 403 });
    }

    const profile = await this.resolveProfile();
    if (!profile) {
      throw new Error('No active FileMaker profile is available for bridge requests.');
    }

    const timeout = Number.isFinite(Number(payload.timeoutMs))
      ? Math.max(1_000, Math.min(120_000, Number(payload.timeoutMs)))
      : DEFAULT_ROUTE_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      if (route === '/find') {
        const layout = payload.layout;
        if (typeof layout !== 'string' || /^\s*$/.test(layout)) throw new Error('layout is required.');
        const query = payload.query;
        if (!Array.isArray(query)) {
          throw new Error('find route requires a query array.');
        }

        const request: FindRecordsRequest = {
          query: query as Array<Record<string, unknown>>,
          sort: Array.isArray(payload.sort) ? (payload.sort as Array<Record<string, unknown>>) : undefined,
          limit: parseOptionalNumber(payload.limit),
          offset: parseOptionalNumber(payload.offset)
        };

        // Runtime Find All uses [] or [{}] at the local bridge, never an empty Data API find.
        if (query.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 0)) {
          return await this.fmClient.listRecords(profile, layout, { limit: request.limit, offset: request.offset, sort: request.sort }, { signal: controller.signal }) as unknown as Record<string, unknown>;
        }
        assertFindCriteria(request.query);
        const result = await this.fmClient.findRecords(profile, layout, request, {
          signal: controller.signal
        });
        return result as unknown as Record<string, unknown>;
      }

      if (route === '/getRecord') {
        const layout = requireString(payload.layout, 'layout');
        const recordId = requireString(payload.recordId, 'recordId');
        const result = await this.fmClient.getRecord(profile, layout, recordId, {
          signal: controller.signal
        });
        return result as unknown as Record<string, unknown>;
      }

      if (route === '/editRecord') {
        const layout = requireString(payload.layout, 'layout');
        const recordId = requireString(payload.recordId, 'recordId');
        const fieldData = asObject(payload.fieldData, 'fieldData');
        assertNoNulText(fieldData);
        const modId = typeof payload.modId === 'string' ? payload.modId : undefined;
        const result = await this.fmClient.editRecord(profile, layout, recordId, fieldData, {
          signal: controller.signal
        }, modId !== undefined ? { modId } : undefined);
        return result as unknown as Record<string, unknown>;
      }

      if (route === '/createRecord') {
        const layout = requireString(payload.layout, 'layout');
        const fieldData = asObject(payload.fieldData ?? {}, 'fieldData');
        assertNoNulText(fieldData);
        const result = await this.fmClient.createRecord(profile, layout, fieldData, {
          signal: controller.signal
        });
        return result as unknown as Record<string, unknown>;
      }

      if (route === '/deleteRecord') {
        const layout = requireString(payload.layout, 'layout');
        const recordId = requireString(payload.recordId, 'recordId');
        const result = await this.fmClient.deleteRecord(profile, layout, recordId, {
          signal: controller.signal
        });
        return result as unknown as Record<string, unknown>;
      }

      if (route === '/runScript') {
        const layout = requireString(payload.layout, 'layout');
        const scriptName = requireString(payload.scriptName, 'scriptName');
        const result = await this.fmClient.runScript(
          profile,
          {
            layout,
            scriptName,
            // A script parameter is data for the script: keep it byte for byte.
            scriptParam: typeof payload.scriptParam === 'string' ? payload.scriptParam : undefined,
            recordId: readString(payload.recordId)
          },
          {
            signal: controller.signal
          }
        );
        return result as unknown as Record<string, unknown>;
      }

      throw new Error(`Unsupported bridge route: ${route}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async resolveProfileId(): Promise<string | undefined> {
    const project = await this.fmWebProjectService.readProjectConfig();
    return project?.activeProfileId ?? this.profileStore.getActiveProfileId();
  }

  private async resolveProfile() {
    const profileId = await this.resolveProfileId();
    if (!profileId) {
      return undefined;
    }

    return this.profileStore.getProfile(profileId);
  }

  private setCorsHeaders(response: ServerResponse, origin: string | undefined): void {
    if (!origin) {
      return;
    }

    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-FM-Bridge-Token');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }

  private sendJson(response: ServerResponse, status: number, payload: unknown): void {
    if (!response.headersSent) {
      response.statusCode = status;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
    }

    response.end(`${JSON.stringify(payload)}\n`);
  }
}

/**
 * Compares the presented token with the session's in constant time (both are hashed first so the
 * buffers have equal length). A missing token on either side never matches.
 */
function tokenMatches(presented: string | undefined, expected: string | undefined): boolean {
  if (!presented || !expected) {
    return false;
  }
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} is required.`);
  }

  return fieldName === 'recordId' ? value.trim() : value;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(0, Math.floor(value));
}

function asObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object.`);
  }

  return value as Record<string, unknown>;
}

function isLocalSocket(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) {
    return false;
  }

  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function getRoutePath(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) {
    return undefined;
  }

  const parsed = new URL(rawUrl, 'http://127.0.0.1');
  if (!parsed.pathname.startsWith('/fm/')) {
    return undefined;
  }

  return parsed.pathname.slice(3);
}

function readHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const asBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += asBuffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error('Bridge request body is too large.');
    }
    chunks.push(asBuffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }

  return JSON.parse(raw) as unknown;
}
