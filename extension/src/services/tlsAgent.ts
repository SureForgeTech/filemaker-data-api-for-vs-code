import { X509Certificate } from 'crypto';
import { statSync } from 'fs';
import http, { type ClientRequest, type IncomingMessage, type RequestOptions } from 'http';
import https, { Agent, type AgentOptions } from 'https';
import * as tls from 'tls';

import shouldBypassProxy from 'axios/unsafe/helpers/shouldBypassProxy.js';

import type { ConnectionProfile } from '../types/fm';
import { CERT_PIN_EXPIRED_CODE, CERT_PIN_MISMATCH_CODE, PIN_THROUGH_PROXY_MESSAGE, isTrustableCertificateCode } from '../utils/networkErrors';
import { FMClientError } from './errors';
import { readCaBundleFile } from '../utils/tlsProfile';

type TlsProfileOptions = Pick<
  ConnectionProfile,
  'allowSelfSigned' | 'caBundlePath' | 'pinnedCertSha256' | 'pinnedCertAllowExpired'
>;

const agentCache = new Map<string, Agent>();

/** More agents than this are not expected (one per distinct certificate setting in use); the least recently used are retired beyond it. */
const MAX_CACHED_AGENTS = 32;
/** The shortest time a replaced agent is left to finish requests that are already running before its sockets are closed. */
export const RETIRED_AGENT_GRACE_MS = 30_000;
/** A running request can last as long as the request timeout, so the grace is at least that plus this margin. */
const GRACE_MARGIN_MS = 10_000;
let retiredAgentGraceMs = RETIRED_AGENT_GRACE_MS;

/** Tells the agent cache how long a request may run, so a replaced agent outlives it. Only ever raises the grace. */
export function noteRequestTimeout(timeoutMs: number): void {
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    retiredAgentGraceMs = Math.max(retiredAgentGraceMs, RETIRED_AGENT_GRACE_MS, timeoutMs + GRACE_MARGIN_MS);
  }
}

/** The current grace period (for tests). */
export function retiredAgentGrace(): number {
  return retiredAgentGraceMs;
}

const retiring = new Map<NodeJS.Timeout, Agent>();

/**
 * Closes the sockets of an agent that is no longer handed out (its CA file changed, or it was the
 * least recently used of too many). It waits a grace period first, at least as long as a request may
 * take, so a request that is already running on it is not cut off; the timer does not keep the
 * process alive.
 */
function retireAgent(agent: Agent): void {
  const timer = setTimeout(() => {
    retiring.delete(timer);
    agent.destroy();
  }, retiredAgentGraceMs);
  timer.unref?.();
  retiring.set(timer, agent);
}

function cacheAgent(key: string, agent: Agent): void {
  agentCache.set(key, agent);
  while (agentCache.size > MAX_CACHED_AGENTS) {
    const oldest = agentCache.keys().next().value as string | undefined;
    if (oldest === undefined || oldest === key) {
      break;
    }
    const evicted = agentCache.get(oldest);
    agentCache.delete(oldest);
    if (evicted) {
      retireAgent(evicted);
    }
  }
}

/** A cache hit makes the entry the most recently used (a Map iterates in insertion order). */
function touchAgent(key: string, agent: Agent): Agent {
  agentCache.delete(key);
  agentCache.set(key, agent);
  return agent;
}

/** Closes every cached and retiring agent's sockets now (extension shutdown), cancels the timers, and forgets them. */
export function disposeTlsAgents(): void {
  for (const [timer, agent] of retiring) {
    clearTimeout(timer);
    agent.destroy();
  }
  retiring.clear();
  for (const agent of agentCache.values()) {
    agent.destroy();
  }
  agentCache.clear();
}

/**
 * Whether to add the operating system's trusted certificates to Node's built-in public roots (what
 * VS Code itself does unless `http.systemCertificates` is off). Off until the extension turns it
 * on, so unit tests and tools see Node's defaults.
 */
let trustSystemCertificates: () => boolean = () => false;

export function setSystemCertificatePolicy(policy: () => boolean): void {
  trustSystemCertificates = policy;
}

/** What Node trusts by default (including NODE_EXTRA_CA_CERTS where Node can say); its bundled list on older Node. */
function defaultTrustedRoots(): string[] {
  const reader = (tls as { getCACertificates?: (type: string) => string[] }).getCACertificates;
  try {
    return typeof reader === 'function' ? reader.call(tls, 'default') : [...tls.rootCertificates];
  } catch {
    return [...tls.rootCertificates];
  }
}

let cachedSystemRoots: { roots: string[]; at: number } | undefined;
/** How long the operating system's store is remembered: a CA installed later is picked up after this, or on reload. */
const SYSTEM_ROOTS_TTL_MS = 10 * 60 * 1000;

function readTrustedRoots(): string[] {
  const reader = (tls as { getCACertificates?: (type: string) => string[] }).getCACertificates;
  if (typeof reader !== 'function') {
    return [];
  }
  try {
    // 'default' is what Node trusts out of the box: its bundled list plus NODE_EXTRA_CA_CERTS (and
    // the system store when Node was started with --use-system-ca). Adding 'system' covers the
    // operating system's store. Replacing 'default' by the bundled list alone would drop the
    // certificates the user added through NODE_EXTRA_CA_CERTS.
    return [...new Set([...reader.call(tls, 'default'), ...reader.call(tls, 'system')])];
  } catch {
    return [];
  }
}

/**
 * Reads the operating system's store ahead of the first request. It takes a few hundred
 * milliseconds on some systems, so the extension starts it in the background after activation;
 * a request that arrives first reads it itself.
 */
export function warmSystemCertificates(): void {
  if (!trustSystemCertificates()) {
    return;
  }
  setImmediate(() => {
    cachedSystemRoots = { roots: readTrustedRoots(), at: Date.now() };
  });
}

/**
 * Node's trusted certificates (including NODE_EXTRA_CA_CERTS) plus, where this Node can read them
 * (`tls.getCACertificates`, Node 22.15+), the operating system's store. Returns undefined when no
 * addition is possible, meaning "use Node's defaults unchanged".
 */
function systemTrustedRoots(): string[] | undefined {
  if (!trustSystemCertificates()) {
    return undefined;
  }
  if (typeof (tls as { getCACertificates?: unknown }).getCACertificates !== 'function') {
    return undefined;
  }
  if (!cachedSystemRoots || Date.now() - cachedSystemRoots.at > SYSTEM_ROOTS_TTL_MS) {
    cachedSystemRoots = { roots: readTrustedRoots(), at: Date.now() };
  }
  return cachedSystemRoots.roots.length > 0 ? cachedSystemRoots.roots : undefined;
}

/** Normalises a fingerprint to 64 lower-case hex digits, or undefined if it is not one. */
export function normalizeSha256(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const hex = value.replace(/[:\s]/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : undefined;
}

/** The client's view of a connection to a pinned server, for tests and the trust dialog. */
export function checkPinnedCertificate(
  presented: { fingerprint256?: string; valid_from?: string; valid_to?: string } | undefined,
  pin: { sha256: string; allowExpired: boolean },
  now = Date.now()
): { code: string; message: string } | undefined {
  const fingerprint = normalizeSha256(presented?.fingerprint256);
  if (!fingerprint || fingerprint !== pin.sha256) {
    return { code: CERT_PIN_MISMATCH_CODE, message: 'The server presented a different certificate than the one you trusted.' };
  }
  if (!pin.allowExpired) {
    const from = Date.parse(presented?.valid_from ?? '');
    const to = Date.parse(presented?.valid_to ?? '');
    if (Number.isNaN(from) || Number.isNaN(to) || now > to) {
      return { code: CERT_PIN_EXPIRED_CODE, message: 'The certificate you trusted has expired.' };
    }
    if (now < from) {
      return { code: 'CERT_NOT_YET_VALID', message: 'The certificate you trusted is not valid yet.' };
    }
  }
  return undefined;
}

/**
 * An agent that accepts exactly one server certificate, identified by its SHA-256 fingerprint
 * (trust on first use, confirmed by the user). Chain and host-name checks are skipped for that one
 * certificate only. Any other certificate, or the same one after it expired (unless the user
 * accepted that), ends the connection before any request bytes are written.
 *
 * The check runs when the handshake finishes. Writes are corked until then so that nothing, not
 * even the Basic-auth header, can be sent to a server whose certificate is not the pinned one.
 */
export class PinnedCertificateAgent extends Agent {
  public constructor(
    options: AgentOptions,
    private readonly pin: { sha256: string; allowExpired: boolean }
  ) {
    // No TLS session cache. A resumed session has no peer certificate to read, so the second and
    // later connections through a caching agent would find nothing to compare with the pin (and be
    // refused as "certificate changed"). Every connection of this agent therefore does a full
    // handshake, and every socket it hands out has passed the check below: a kept-alive socket
    // that is reused was checked when it was created.
    super({ ...options, maxCachedSessions: 0 });
    // `rejectUnauthorized: false` is forced per connection in createConnection and is deliberately
    // NOT kept in `this.options`. When an HTTP proxy applies, axios replaces this agent with a
    // tunnelling one and copies `options` into it; if `rejectUnauthorized: false` were copied too,
    // the tunnelled connection would skip every check and ignore the pin (it would fail open).
    // Without it the copy verifies normally and fails closed. `httpsTransportFor` refuses the
    // combination before a request is made, with a message that says why.
    delete (this.options as { rejectUnauthorized?: boolean }).rejectUnauthorized;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public createConnection(...args: any[]): any {
    // Work on copies. Node files a kept-alive socket under a name built from the request options
    // (which include rejectUnauthorized and checkServerIdentity), so changing the caller's options
    // object here made the name used when the socket was freed differ from the one a later request
    // looks up: the socket was never found again and sat idle instead of being reused or closed.
    // The check below runs on every socket when it is created, so a reused socket has passed it.
    const forced = { rejectUnauthorized: false, checkServerIdentity: () => undefined };
    args = args.map((arg) => (arg && typeof arg === 'object' ? { ...arg, ...forced } : arg));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const socket = (super.createConnection as (...a: any[]) => tls.TLSSocket)(...args);
    // Defence in depth: hold writes until the check has run, so that not even the request line or
    // the Authorization header can reach a server whose certificate is not the pinned one. The check
    // below already ends the connection first (TLS buffers writes until the handshake completes), so
    // this is not known to change the outcome and no test can tell the two apart.
    socket.cork();
    socket.once('secureConnect', () => {
      // A resumed session shows no certificate, so it could not be checked: never accept it.
      const failure = socket.isSessionReused()
        ? { code: CERT_PIN_MISMATCH_CODE, message: 'The connection resumed an earlier session, so the certificate could not be checked.' }
        : checkPinnedCertificate(socket.getPeerCertificate(false), this.pin);
      if (failure) {
        socket.destroy(Object.assign(new Error(failure.message), { code: failure.code }));
        return;
      }
      socket.uncork();
    });
    return socket;
  }
}

/** Policy for the fallback explanation; production checks the actual networking patch. */
let agentIsReplacedByHost: () => boolean = () => false;
let agentPolicyInstalled = false;

export function setAgentReplacedPolicy(policy: () => boolean): void {
  agentIsReplacedByHost = policy;
  agentPolicyInstalled = true;
}

/** Installs the policy unless one was installed already (by the extension's start-up or by a test). */
export function ensureAgentReplacedPolicy(policy: () => boolean): void {
  if (!agentPolicyInstalled) {
    setAgentReplacedPolicy(policy);
  }
}

/**
 * Whether the host request patch could interfere at `url`; only localhost and 127.0.0.1
 * are exempt from that patch replacing the supplied agent.
 */
export function hostReplacesAgentFor(url: string | undefined): boolean {
  return agentIsReplacedByHost() && !isLoopbackUrl(url);
}

function isLoopbackUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
}

/** A fallback for an untrusted pin/legacy request left on axios's environment-proxy route. */
export function pinBypassedByHost(
  profile: TlsProfileOptions & Partial<Pick<ConnectionProfile, 'authMode' | 'serverUrl' | 'proxyEndpoint'>>,
  failure?: FMClientError
): FMClientError | undefined {
  const url = profile.authMode === 'proxy' ? profile.proxyEndpoint : profile.serverUrl;
  // Only localhost and 127.0.0.1 retain the supplied agent in the host request patch.
  if (
    !needsCustomTlsTransport(profile) ||
    !url || !/^https:/i.test(url) || !environmentProxyFor(url) ||
    !failure ||
    !hostReplacesAgentFor(url)
  ) {
    return undefined;
  }
  if (failure) {
    const code = failure.networkCode;
    if (
      failure.kind !== 'certificate' ||
      !isTrustableCertificateCode(code) ||
      !['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_UNTRUSTED'].includes(code ?? '') ||
      code === CERT_PIN_MISMATCH_CODE ||
      code === CERT_PIN_EXPIRED_CODE
    ) {
      return undefined;
    }
  }
  return new FMClientError(
    `This server's certificate failed VS Code's own certificate check${failure?.networkCode ? ` (${failure.networkCode})` : ''}, and this connection's certificate settings could not be applied on the environment-proxy route. VS Code's networking patch is active; try setting "http.proxySupport" to "fallback" in VS Code settings (search for "proxy support"), then test again. Or install a certificate from a public authority on the server and choose Forget trusted certificate. For a pinned connection a custom CA file does not help here, because a trusted certificate does not use the CA file.`,
    {
      code: 'PIN_BYPASSED_BY_PROXY_SUPPORT',
      networkCode: failure.networkCode,
      kind: 'certificate',
      isRetryable: false,
      status: failure?.status,
      details: failure?.details,
      requestId: failure?.requestId,
      endpoint: failure?.endpoint
    }
  );
}

/** Environment variable as `proxy-from-env` reads it: lower case first, then upper case. */
function readEnv(key: string): string {
  return process.env[key.toLowerCase()] || process.env[key.toUpperCase()] || '';
}

const DEFAULT_PORTS: Record<string, number> = { ftp: 21, gopher: 70, http: 80, https: 443, ws: 80, wss: 443 };

/** `proxy-from-env`'s `shouldProxy` (its own NO_PROXY rules: exact host unless the entry starts with `.` or `*`). */
function proxyFromEnvShouldProxy(hostname: string, port: number): boolean {
  const noProxy = readEnv('no_proxy').toLowerCase();
  if (!noProxy) {
    return true;
  }
  if (noProxy === '*') {
    return false;
  }
  return noProxy.split(/[,\s]/).every((entry) => {
    if (!entry) {
      return true;
    }
    const parsed = entry.match(/^(.+):(\d+)$/);
    let entryHost = parsed ? (parsed[1] as string) : entry;
    const entryPort = parsed ? parseInt(parsed[2] as string, 10) : 0;
    if (entryPort && entryPort !== port) {
      return true;
    }
    if (!/^[.*]/.test(entryHost)) {
      return hostname !== entryHost;
    }
    if (entryHost.charAt(0) === '*') {
      entryHost = entryHost.slice(1);
    }
    return !hostname.endsWith(entryHost);
  });
}

/**
 * The proxy axios would use for `url`, or undefined. This is axios's own rule, not an approximation:
 * the `proxy-from-env` lookup (`<scheme>_proxy`, else `all_proxy`; its `NO_PROXY` matching), reproduced
 * here, and then axios's own `shouldBypassProxy` (a second, different `NO_PROXY` matching that it applies
 * after the first), imported from axios itself. A proxy is in use only when both leave it in place.
 * `npm_config_*` variables are NOT read (axios does not). Used to decide whether a pinned certificate can
 * be checked; a test compares this with the real `proxy-from-env` on a corpus.
 */
export function environmentProxyFor(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const scheme = parsed.protocol.split(':', 1)[0] as string;
  const hostname = parsed.host.replace(/:\d*$/, '');
  const port = parseInt(parsed.port, 10) || DEFAULT_PORTS[scheme] || 0;
  if (!hostname || !proxyFromEnvShouldProxy(hostname, port)) {
    return undefined;
  }
  let proxy = readEnv(`${scheme}_proxy`) || readEnv('all_proxy');
  if (!proxy) {
    return undefined;
  }
  if (!proxy.includes('://')) {
    proxy = `${scheme}://${proxy}`;
  }
  return shouldBypassProxy(url) ? undefined : proxy;
}

type PatchedHttps = typeof https & { __vscodeOriginal?: typeof https };
type PatchedHttp = typeof http & { __vscodeOriginal?: typeof http };
const initialRequest = https.request;
const initialClientRequest = http.ClientRequest;

/** VS Code saves the original module before patching, including when it patches before we load. */
export function hostNetworkingPatched(): boolean {
  const original = (https as PatchedHttps).__vscodeOriginal;
  const originalHttp = (http as PatchedHttp).__vscodeOriginal;
  return https.request !== (original?.request ?? initialRequest) ||
    http.ClientRequest !== (originalHttp?.ClientRequest ?? initialClientRequest);
}

function needsCustomTlsTransport(profile: TlsProfileOptions): boolean {
  return normalizeSha256(profile.pinnedCertSha256) !== undefined ||
    profile.allowSelfSigned === true;
}

function pinThroughProxy(): FMClientError {
  return new FMClientError(
    PIN_THROUGH_PROXY_MESSAGE,
    { code: 'PIN_THROUGH_PROXY', kind: 'certificate', isRetryable: false }
  );
}

/**
 * Ask the installed VS Code route for its proxy decision without opening a socket. Its public
 * PacProxyAgent.resolver carries the setting, NO_PROXY and system/PAC lookup that VS Code injected.
 * A credential-free, unended request exposes that agent. agent-base schedules connect in a
 * microtask: replace it synchronously, then destroy the probe. Neither path can dial a server.
 * An unknown future patched agent fails closed rather than silently bypassing a required proxy.
 */
async function hostProxyRequired(url: string): Promise<boolean> {
  if (!hostNetworkingPatched()) return false;
  const parsed = new URL(url);
  // A no-op agent prevents even a synchronous connect if the patch honours the supplied agent.
  const sentinel = new Agent() as DispatchAgent;
  sentinel.addRequest = (req) => { process.nextTick(() => rejectPendingRequest(req, new Error('Proxy decision only: no connection'))); };
  const options: RequestOptions = {
    protocol: 'https:', hostname: parsed.hostname, port: parsed.port || 443,
    path: `${parsed.pathname}${parsed.search}`, method: 'HEAD', agent: sentinel
  };
  const probe = https.request(options);
  probe.on('error', () => undefined);
  const agent = (probe as RequestWithAgent).agent as Agent & {
    connect?: (...args: unknown[]) => Promise<unknown>;
    resolver?: (req: ClientRequest, opts: RequestOptions, url: string) => Promise<string | undefined>;
  };
  try {
    if (agent === options.agent) return false; // off/on: the patch honoured our explicit agent
    if (!agent || typeof agent.connect !== 'function' || typeof agent.resolver !== 'function') {
      throw pinThroughProxy();
    }
    agent.connect = async () => { throw new Error('Proxy decision only: no connection'); };
    probe.destroy();
    const result = await agent.resolver(probe, options, url);
    // The first recognised PAC entry is the route the installed agent would use.
    for (const entry of (result ?? '').split(';')) {
      const kind = entry.trim().split(/\s+/, 1)[0];
      if (kind === 'DIRECT') return false;
      if (['PROXY', 'HTTP', 'HTTPS', 'SOCKS', 'SOCKS4', 'SOCKS5'].includes(kind ?? '')) return true;
    }
    return false;
  } catch {
    throw pinThroughProxy();
  } finally {
    probe.destroy();
    if (agent !== options.agent) agent?.destroy?.();
    (options.agent as Agent).destroy();
  }
}

/** Node agents report connection failures through onSocket, including before a socket exists. */
function rejectPendingRequest(req: ClientRequest, error?: Error): void {
  (req as ClientRequest & { onSocket(socket: null, error?: Error): void }).onSocket(null, error);
}

type RequestWithAgent = ClientRequest & { agent: Agent };
type DispatchAgent = Agent & { addRequest(req: ClientRequest, options: RequestOptions): void };

interface HttpsTransport {
  httpsAgent: Agent;
  proxy?: false;
  transport?: { request(options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest };
}

/** Preserve pin/legacy agents under VS Code's request patch; CA-only profiles keep axios's proxy route. */
export function httpsTransportFor(profile: TlsProfileOptions, url: string): HttpsTransport {
  const httpsAgent = createHttpsAgentForProfile(profile);
  if (!/^https:/i.test(url) || !needsCustomTlsTransport(profile)) return { httpsAgent };
  const pinned = normalizeSha256(profile.pinnedCertSha256) !== undefined;
  if (pinned && environmentProxyFor(url)) throw pinThroughProxy();
  // A legacy self-signed profile behind an environment proxy keeps axios's own CONNECT
  // tunnel (and its https-proxy-agent), which a hand-built ClientRequest cannot drive: the proxy route
  // is unchanged from before, and VS Code's networking owns it.
  if (!pinned && environmentProxyFor(url)) return { httpsAgent };
  return {
    httpsAgent,
    ...(pinned ? { proxy: false as const } : {}),
    transport: {
      request: (options, callback) => {
        // Pinned requests have proxy:false and must always use the pin agent itself.
        let pendingRoute = false;
        let agent = pinned ? httpsAgent : (options.agent ?? httpsAgent);
        if (pinned && (https as PatchedHttps).__vscodeOriginal && hostNetworkingPatched()) {
          // Defer the real agent until the host proxy lookup finishes. Axios owns the native
          // request throughout, so its connect timeout and cancellation cover this wait too.
          pendingRoute = true;
          const gate = new Agent() as DispatchAgent;
          gate.addRequest = (req, opts) => {
            void hostProxyRequired(url).then((required) => {
              if (req.destroyed) return;
              pendingRoute = false;
              if (required) { rejectPendingRequest(req, pinThroughProxy()); return; }
              (req as RequestWithAgent).agent = httpsAgent;
              (httpsAgent as DispatchAgent).addRequest(req, opts);
            }).catch((error: Error) => { pendingRoute = false; rejectPendingRequest(req, error); });
          };
          agent = gate;
        }
        const req = new http.ClientRequest({ ...options, agent, protocol: 'https:' }, callback);
        // Axios recognises only the built-in http/https objects as native transports. Keep its
        // native connect-phase deadline for this transport too (setTimeout alone waits for a socket).
        const setTimeout = req.setTimeout.bind(req);
        let deadline: NodeJS.Timeout | undefined;
        const clearDeadline = (): void => { clearTimeout(deadline); deadline = undefined; };
        req.setTimeout = (ms, listener) => {
          clearDeadline();
          if (ms > 0) deadline = globalThis.setTimeout(() => req.emit('timeout'), ms);
          return setTimeout(ms, listener);
        };
        const destroy = req.destroy.bind(req);
        req.destroy = (error) => {
          clearDeadline();
          const result = destroy(error);
          if (pendingRoute) {
            pendingRoute = false;
            rejectPendingRequest(req, error);
          }
          return result;
        };
        req.once('response', clearDeadline);
        req.once('close', clearDeadline);
        req.once('error', clearDeadline);
        return req;
      }
    }
  };
}

export function createHttpsAgentForProfile(profile: TlsProfileOptions): Agent {
  const pinned = normalizeSha256(profile.pinnedCertSha256);
  const allowExpired = pinned !== undefined && profile.pinnedCertAllowExpired === true;
  // Only the older setting turns verification off wholesale. A pin is a narrower choice and wins.
  const allowSelfSigned = pinned === undefined && profile.allowSelfSigned === true;
  const caBundlePath = pinned === undefined ? profile.caBundlePath?.trim() : undefined;
  const systemRoots = pinned === undefined ? systemTrustedRoots() : undefined;

  // Keyed by the file's size and modification time as well as its path, so a renewed or edited
  // CA file is picked up without restarting VS Code.
  let fileStamp = 'none';
  if (caBundlePath) {
    try {
      const info = statSync(caBundlePath);
      fileStamp = `${info.size}:${info.mtimeMs}`;
    } catch (error) {
      throw buildCaBundleError(caBundlePath, error);
    }
  }
  const mode = pinned ? `pinned-${pinned}-${allowExpired ? 'expired-ok' : 'strict'}` : allowSelfSigned ? 'self-signed' : 'verified';
  const prefix = `${mode}:${caBundlePath ?? 'none'}:${systemRoots ? 'system' : 'default'}:`;
  const cacheKey = `${prefix}${fileStamp}`;
  const cachedAgent = agentCache.get(cacheKey);
  if (cachedAgent) {
    return touchAgent(cacheKey, cachedAgent);
  }

  if (pinned) {
    const agent = new PinnedCertificateAgent({}, { sha256: pinned, allowExpired });
    cacheAgent(cacheKey, agent);
    return agent;
  }

  const options: AgentOptions = {
    rejectUnauthorized: !allowSelfSigned
  };

  if (caBundlePath) {
    let pem: string;
    try {
      pem = readCaBundleFile(caBundlePath);
    } catch (error) {
      if (error instanceof FMClientError) {
        throw error;
      }
      throw buildCaBundleError(caBundlePath, error);
    }
    assertContainsCertificate(pem, caBundlePath);
    // Node's `ca` option replaces the built-in public roots, which would make every server with
    // a public certificate fail once a custom CA is set. Keep the default roots (and the
    // operating system's, where Node can read them) and add the file's certificates.
    options.ca = [...(systemRoots ?? defaultTrustedRoots()), pem];
  } else if (systemRoots) {
    options.ca = systemRoots;
  }

  // Drop agents made for an earlier version of the same file.
  for (const [key, stale] of [...agentCache.entries()]) {
    if (key.startsWith(prefix)) {
      agentCache.delete(key);
      retireAgent(stale);
    }
  }

  const agent = new Agent(options);
  cacheAgent(cacheKey, agent);
  return agent;
}

function assertContainsCertificate(pem: string, caBundlePath: string): void {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  const valid = blocks.filter((block) => {
    try {
      new X509Certificate(block);
      return true;
    } catch {
      return false;
    }
  });
  if (valid.length === 0) {
    throw new FMClientError(
      `The CA file ${caBundlePath} does not contain a certificate. Use a PEM file with "-----BEGIN CERTIFICATE-----" blocks (the CA's public certificate, not a private key).`,
      { code: 'TLS_CA_BUNDLE_INVALID', kind: 'validation', isRetryable: false }
    );
  }
}

function buildCaBundleError(caBundlePath: string, error: unknown): FMClientError {
  return new FMClientError(`Unable to read TLS CA bundle at ${caBundlePath}.`, {
    code: 'TLS_CA_BUNDLE_READ_FAILED',
    details: {
      caBundlePath,
      error
    }
  });
}
