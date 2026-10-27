import { X509Certificate } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { connect, isIP } from 'node:net';
import * as tls from 'node:tls';

import type { ConnectionProfile } from '../types/fm';
import { describeNetworkFailure } from '../utils/networkErrors';
import { redactString } from '../utils/redact';
import { formatFingerprint } from './certificateInspect';
import type { FMClient } from './fmClient';
import { createHttpsAgentForProfile, environmentProxyFor, normalizeSha256 } from './tlsAgent';

export type Verdict = 'PASS' | 'WARN' | 'FAIL';
export interface DiagnosticStep { name: string; verdict: Verdict; ms: number; text: string }
export interface CertificateFacts {
  subject: string; issuer: string; serial: string; validFrom: string; validTo: string;
  fingerprint: string; altNames: string; commonName?: string; chainBeyondLeaf: boolean;
  selfSigned: boolean; protocol: string; cipher: string;
  expired: boolean; notYetValid: boolean; nameMatch: boolean; noNames: boolean;
}
export interface DiagnosticReport {
  address: string; steps: DiagnosticStep[]; certificate?: CertificateFacts;
  verified?: boolean; pin?: 'match' | 'mismatch' | 'none' | 'invalid';
  hostReplaced?: boolean; environmentProxy?: boolean; http?: number; fmCode?: string;
  allowSelfSigned?: boolean; dataApiFailureCode?: string; dataApiCertificateFailure?: boolean;
  caFileConfigured?: boolean; verificationFailureCode?: string;
  proxyUnreachable?: boolean;
  cancelled?: boolean;
}
export interface NetworkSettings { proxySupport: string; proxyConfigured: boolean; systemCertificates: boolean; proxyVariables: string[]; hostReplaced: boolean }
export interface DiagnosticProbes {
  dns(host: string, signal: AbortSignal): Promise<string>;
  tcp(host: string, port: number, signal: AbortSignal): Promise<void>;
  certificate(host: string, port: number, signal: AbortSignal): Promise<CertificateFacts>;
  verify(host: string, port: number, profile: ConnectionProfile, signal: AbortSignal): Promise<void>;
  product(profile: ConnectionProfile, signal: AbortSignal): Promise<{ status: number; code?: string; name?: string; version?: string }>;
}

export function validateDiagnosticAddress(address: string): URL | undefined {
  try {
    const url = new URL(address);
    if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || Number(url.port) > 65535 || url.port === '0') return undefined;
    return url;
  } catch { return undefined; }
}

export function certificateExpiry(validFrom: string, validTo: string, now = Date.now()): { expired: boolean; notYetValid: boolean } {
  return { expired: Date.parse(validTo) < now, notYetValid: Date.parse(validFrom) > now };
}

/** Split Node's SAN display without treating commas inside a quoted DNS name as IP entries. */
function alternativeNames(value: string): string[] {
  const names: string[] = [];
  let quoted = false;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (escaped) { escaped = false; continue; }
    if (quoted && char === '\\') { escaped = true; continue; }
    if (char === '"') quoted = !quoted;
    if (char === ',' && !quoted) { names.push(value.slice(start, index).trim()); start = index + 1; }
  }
  if (quoted) return [];
  names.push(value.slice(start).trim());
  return names;
}

/** Use Node's DNS verifier and canonical IP SAN matching, respecting quoted SAN entries. */
export function matchCertificateName(host: string, altNames: string, commonName?: string): { nameMatch: boolean; noNames: boolean } {
  const noNames = !/DNS:|IP Address:/.test(altNames) && (!commonName || !/^[\w.*-]+(?:\.[\w*-]+)*$/.test(commonName));
  const bareHost = host.replace(/^\[|\]$/g, '');
  let nameMatch = false;
  if (isIP(bareHost)) {
    // Node 22's domain-to-ASCII handling can lose a bare IPv6 address. Compare only IP SANs,
    // canonically, without ever accepting an IP written in a DNS SAN or Common Name.
    const canonical = (ip: string): string => {
      try { return new URL(`https://${isIP(ip) === 6 ? `[${ip}]` : ip}`).hostname; } catch { return ''; }
    };
    nameMatch = alternativeNames(altNames).some((entry) => {
      const ip = /^IP Address:([0-9a-f:.]+)$/i.exec(entry)?.[1];
      return ip !== undefined && isIP(ip) !== 0 && canonical(ip) === canonical(bareHost);
    });
  } else if (!noNames) {
    try {
      nameMatch = tls.checkServerIdentity(bareHost, {
        subjectaltname: altNames, subject: commonName ? { CN: commonName } : {}
      } as tls.PeerCertificate) === undefined;
    } catch { nameMatch = false; }
  }
  return { nameMatch, noNames };
}

function failureCode(error: unknown): string {
  const code = (error as { networkCode?: unknown; code?: unknown })?.networkCode ?? (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'CONNECTION_FAILED';
}

export function rankDiagnosticCauses(report: DiagnosticReport): string[] {
  const causes: string[] = [];
  const failed = (name: string) => report.steps.some((step) => step.name === name && step.verdict === 'FAIL');
  if (report.cancelled) return ['Check cancelled. Run Diagnose Connection again when you are ready.'];
  if (failed('Address')) return ['Fix the Server URL: enter https:// followed by the server host name and, if needed, a port. A path prefix is allowed; do not include sign-in details or a query.'];
  if (failed('DNS')) causes.push('The server name could not be found. Check the spelling, your network and VPN, then try again.');
  if (failed('TCP')) causes.push('The address resolves but the port cannot be reached. Check the firewall and server port, and that the Data API is enabled in Admin Console.');
  if (report.proxyUnreachable) causes.push('The proxy could not be reached. Check HTTPS_PROXY / HTTP_PROXY / ALL_PROXY, NO_PROXY, VS Code http.proxy and http.proxySupport, or ask your network administrator to check the proxy.');
  const cert = report.certificate;
  if (report.pin === 'mismatch' || report.pin === 'invalid') causes.push('The trusted fingerprint does not match. Ask the administrator whether the certificate changed; only then run Connect and choose Review and re-trust.');
  if (cert?.expired || report.verificationFailureCode === 'CERT_HAS_EXPIRED') causes.push(`The server certificate has expired on ${cert?.validTo ?? 'the date reported by the server'}. Ask the administrator to renew it in Admin Console.`);
  if (cert?.notYetValid || report.verificationFailureCode === 'CERT_NOT_YET_VALID') causes.push(`The server certificate is not valid until ${cert?.validFrom ?? 'the date reported by the server'}. Check this computer’s clock and ask the administrator to correct the certificate dates.`);
  const dateFailure = ['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID'].includes(report.verificationFailureCode ?? '');
  const legacy = report.allowSelfSigned && (report.pin === 'none' || report.pin === undefined);
  if (report.dataApiFailureCode === 'PIN_THROUGH_PROXY' || (report.pin === 'match' && report.environmentProxy)) causes.push('A proxy prevents checking the trusted fingerprint (PIN_THROUGH_PROXY). For an environment proxy, add the server host to NO_PROXY; for a VS Code or system proxy, exclude the server there or remove the proxy, then run Connect.');
  if (cert && report.pin !== 'match' && !legacy && (!cert.nameMatch || (!report.verified && !dateFailure))) {
    if (cert.noNames) causes.push(`No host names listed, so verification by name cannot pass: trust it by fingerprint. Ask the administrator to confirm it, then run Connect and choose Trust; SHA-256: ${formatFingerprint(cert.fingerprint)}.`);
    else if (!cert.nameMatch) causes.push('The certificate is for a different server name. Use a name listed on the certificate, or ask the administrator to replace it.');
    else if (!cert.chainBeyondLeaf && !cert.selfSigned && report.verified === false && report.caFileConfigured && ['UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(report.verificationFailureCode ?? '')) causes.push('The server did not send its intermediate certificate. Ask the administrator to install the full chain on the server, including the intermediate certificate; a root CA file on this computer does not repair the server chain.');
    else if (!cert.selfSigned) causes.push("This computer does not trust the authority that issued this certificate. If your organization runs its own certificate authority, set its CA file (Certificate authority file) in the profile. If the certificate comes from a public authority (for example Let's Encrypt), the server may not be sending its intermediate certificate: install the full certificate chain on the server.");
    else causes.push(`This computer does not trust the certificate (it is self-signed). Ask the administrator for the CA file or a public certificate, or confirm the fingerprint and run Connect and choose Trust; SHA-256: ${formatFingerprint(cert.fingerprint)}.`);
  }
  // hostReplaced describes an affected route, not merely the presence of VS Code's patch.
  if (report.hostReplaced && (report.pin === 'match' || legacy)) causes.push('This profile’s certificate settings could not use the extension’s direct connection path. If the certificate check fails on the proxy route, try setting http.proxySupport to fallback, then run Connect. Direct trusted-fingerprint and older Allow self-signed profiles work with the default setting; custom CA profiles keep their existing proxy routing.');
  if (failed('TLS') && !cert) causes.push('The server could not complete a secure connection. Check that this is the HTTPS port and ask the administrator to enable a supported TLS version.');
  if (failed('Data API') && report.dataApiCertificateFailure) causes.push('The Data API request failed its certificate check. Follow the certificate advice above before running Connect.');
  else if (failed('Data API') && !report.proxyUnreachable) causes.push(`The Data API did not answer successfully${report.http ? ` (HTTP ${report.http})` : ''}${report.fmCode ? ` (FileMaker ${report.fmCode})` : ''}. Check the Data API in Admin Console and the server address; a proxy or web sign-in page may be answering instead.`);
  if (legacy) causes.push('This profile accepts any certificate (the older Allow self-signed setting); switch to trusting the fingerprint instead. Confirm the full fingerprint with the administrator before changing trust.');
  if (report.steps.some((step) => step.name === 'Address' && step.verdict === 'WARN')) causes.push('This address uses HTTP without encryption. Change it to https:// and the server’s HTTPS port.');
  if (!causes.length && report.pin === 'match' && report.verified === false) causes.push('The server presents the fingerprint you trusted. Run Connect; this profile accepts that exact fingerprint even though normal certificate verification fails.');
  if (!causes.length) causes.push('These checks passed without signing in. Run Connect next; if sign-in fails, check the account, password, database name and fmrest privilege with the administrator.');
  return causes.slice(0, 3);
}

/** Escape server-controlled Markdown while leaving ordinary report lines readable. */
function plainLine(value: string): string {
  // eslint-disable-next-line no-control-regex -- Server text must not inject control characters into the report.
  return redactString(value).replace(/[\r\n\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\<>&`[\]*!#{}|~]/g, (char) => `\\${char}`)
    .replace(/^(\s*)([-+]|\d+[.)])(?=\s)/, '$1\\$2');
}

export function buildDiagnosticReport(report: DiagnosticReport, hideAddress = false): string {
  let host = '';
  let port = '';
  try { const url = new URL(report.address); host = url.hostname; port = url.port || (url.protocol === 'https:' ? '443' : '80'); } catch { /* Invalid addresses are never printed. */ }
  const display = (value: string): string => {
    let safe = value;
    if (hideAddress) {
      safe = safe.split(report.address).join('(hidden)');
      // regexp disposition: host is the configured server hostname from report.address (the profile's own server URL) and is regex-escaped before the RegExp constructor, so no server- or template-supplied text can inject pattern syntax.
      if (host) safe = safe.replace(new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '(hidden)');
      // regexp disposition: port is URL.port or the literal '443'/'80'; URL.port only ever yields digits, so the pattern cannot carry regex metacharacters.
      if (port) safe = safe.replace(new RegExp(`\\b${port}\\b`, 'g'), '(hidden)');
    }
    return plainLine(safe);
  };
  const lines = ['# FileMaker connection diagnosis', '', `Server: ${display(hideAddress ? '(hidden)' : report.address)}`, '',
    'No sign-in was attempted. No passwords, tokens, API keys, headers or cookies are included.',
    'DNS, TCP and TLS checks go directly to the server; the Data API check uses the extension’s real transport.', ''];
  for (const step of report.steps) {
    const text = hideAddress && step.name === 'TLS' ? 'Certificate details hidden with the server address.' : step.text;
    lines.push(`## ${step.verdict} — ${step.name} (${step.ms} ms)`, '', text.split('\n').map(display).join('\n\n'), '');
  }
  lines.push('## Most likely cause', '', ...rankDiagnosticCauses(report).map((cause, index) => `${index + 1}. ${display(cause)}`), '',
    'To copy this report, run FileMaker: Copy Connection Diagnosis for Bug Report. You can hide the server address.');
  return redactString(lines.join('\n'));
}

/** An absolute deadline, including DNS; abort closes any socket and prevents later steps. */
async function bounded<T>(task: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => { controller.abort(); reject(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' })); };
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { reject(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' })); controller.abort(); }, ms);
  });
  try {
    if (signal.aborted) abort();
    return await Promise.race([stopped, signal.aborted ? stopped : task(controller.signal)]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

export async function runConnectionDiagnostics(profile: ConnectionProfile, settings: NetworkSettings, probes: DiagnosticProbes, signal: AbortSignal, timeoutMs = 8000): Promise<DiagnosticReport> {
  const url = validateDiagnosticAddress(profile.serverUrl);
  const report: DiagnosticReport = { address: url?.origin ?? '(invalid address)', steps: [], allowSelfSigned: profile.allowSelfSigned, caFileConfigured: Boolean(profile.caBundlePath) };
  const step = async <T>(name: string, task: (signal: AbortSignal) => Promise<T>, describe: (value: T) => string): Promise<T | undefined> => {
    const start = Date.now();
    try {
      const value = await bounded(task, signal, timeoutMs);
      report.steps.push({ name, verdict: 'PASS', ms: Date.now() - start, text: describe(value) });
      return value;
    } catch (error) {
      if (signal.aborted) report.cancelled = true;
      report.steps.push({ name, verdict: 'FAIL', ms: Date.now() - start, text: `${name} ${signal.aborted ? 'cancelled' : 'could not finish'} (${failureCode(error)}).${name === 'Data API' ? ` HTTP ${report.http ?? '(no response)'}; FileMaker code ${report.fmCode ?? '(not returned)'}.` : ''}` });
      return undefined;
    }
  };
  report.steps.push({ name: 'Address', verdict: !url ? 'FAIL' : url.protocol === 'http:' ? 'WARN' : 'PASS', ms: 0,
    text: !url ? 'Enter an HTTPS server address with a valid host and port, without sign-in details or a query. A path prefix is allowed.' : url.protocol === 'http:' ? 'HTTP sends information without encryption.' : `HTTPS address and port ${url.port || '443'} are valid.` });
  if (!url) return report;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (isIP(host)) report.steps.push({ name: 'DNS', verdict: 'PASS', ms: 0, text: 'It is an IP address; no DNS lookup is needed.' });
  else await step('DNS', (s) => probes.dns(host, s), () => 'The server name resolves to an address.');
  if (signal.aborted) { report.cancelled = true; return report; }
  await step('TCP', (s) => probes.tcp(host, port, s), () => `The server accepts a connection on port ${port}.`);
  if (signal.aborted) { report.cancelled = true; return report; }
  if (url.protocol === 'https:') {
    report.certificate = await step('TLS', (s) => probes.certificate(host, port, s), (cert) => [
      `Protocol: ${cert.protocol}; cipher: ${cert.cipher}`, `Subject: ${cert.subject.replace(/[\r\n]+/g, ', ')}`, `Issuer: ${cert.issuer.replace(/[\r\n]+/g, ', ')}`, `Serial: ${cert.serial}`,
      `Valid from: ${cert.validFrom}; valid to: ${cert.validTo}`, `SHA-256: ${formatFingerprint(cert.fingerprint)}`, `Subject alternative names: ${cert.altNames || '(none)'}`,
      `Chain beyond the leaf: ${cert.chainBeyondLeaf ? 'yes' : 'no'}`, `Self-signed: ${cert.selfSigned ? 'yes' : 'no'}`,
      'Certificate version: unavailable from Node X509Certificate; skipped.', `Expired: ${cert.expired}; not yet valid: ${cert.notYetValid}`,
      cert.noNames ? 'No host names listed, so verification by name cannot pass: trust it by fingerprint.' : `Host name or IP matches: ${cert.nameMatch}`
    ].join('\n'));
    if (signal.aborted) { report.cancelled = true; return report; }
    const verification = await step('Certificate verification', async (s) => {
      try { await probes.verify(host, port, profile, s); return true; }
      catch (error) { report.verificationFailureCode = failureCode(error); throw error; }
    }, () => 'Node accepts this certificate with the extension’s CA and system-root settings and strict verification.');
    report.verified = verification === true;
    const pin = normalizeSha256(profile.pinnedCertSha256);
    report.pin = profile.pinnedCertSha256 && !pin ? 'invalid' : !pin ? 'none' : report.certificate ? pin === report.certificate.fingerprint ? 'match' : 'mismatch' : undefined;
    report.steps.push({ name: 'Trusted fingerprint', verdict: report.pin === 'mismatch' || report.pin === 'invalid' ? 'FAIL' : report.pin === undefined ? 'WARN' : 'PASS', ms: 0,
      text: report.pin === 'none' ? 'No fingerprint is saved for this profile.' : `Saved fingerprint: ${report.pin ?? 'could not compare'}.` });
    if (report.certificate && (report.certificate.expired || report.certificate.notYetValid || !report.certificate.nameMatch || !report.verified)) {
      const tlsStep = report.steps.find((entry) => entry.name === 'TLS');
      if (tlsStep) tlsStep.verdict = 'WARN';
    }
  } else report.steps.push({ name: 'TLS', verdict: 'WARN', ms: 0, text: 'Skipped: HTTP has no secure handshake or certificate.' });
  if (signal.aborted) { report.cancelled = true; return report; }
  report.environmentProxy = Boolean(environmentProxyFor(url.href));
  const pinned = normalizeSha256(profile.pinnedCertSha256) !== undefined;
  const customTls = pinned || profile.allowSelfSigned === true;
  // PR 434 preserves the agent for direct pin/legacy requests. Only legacy requests
  // through an environment proxy stay on the route VS Code can replace.
  report.hostReplaced = settings.hostReplaced && customTls && !pinned && report.environmentProxy;
  const proxyHint = report.environmentProxy || settings.proxyConfigured || report.hostReplaced;
  report.steps.push({ name: 'VS Code network settings', verdict: proxyHint ? 'WARN' : 'PASS', ms: 0,
    text: `${proxyHint ? `http.proxySupport: ${settings.proxySupport}; ` : ''}http.proxy: ${settings.proxyConfigured ? 'set (value hidden)' : 'not set'}; http.systemCertificates: ${settings.systemCertificates}. Proxy environment variables set (values hidden): ${settings.proxyVariables.join(', ') || 'none'}. ${report.hostReplaced ? 'The older Allow self-signed profile uses the environment-proxy route; VS Code can replace its certificate settings there. If the certificate check fails, try http.proxySupport set to fallback.' : 'Trusted-fingerprint and older Allow self-signed profiles go directly only when no proxy applies. Older Allow self-signed profiles still use an applicable environment proxy with any proxy-support setting. VS Code does not replace their direct connection path; no setting change is needed there. Custom CA profiles keep their existing VS Code and system proxy routing.'} Pinned profiles that need a proxy are refused with PIN_THROUGH_PROXY. Direct probes do not test an HTTP proxy.` });
  await step('Data API', async (s) => {
    try {
      const result = await probes.product({ ...profile, serverUrl: `${url.origin}${url.pathname.replace(/\/$/, '')}`, apiBasePath: '/fmi/data', apiVersionPath: 'vLatest' }, s);
      report.http = result.status; report.fmCode = result.code;
      return result;
    } catch (error) {
      const failure = error as { status?: number; code?: string; kind?: string };
      report.proxyUnreachable = failure.code === 'PROXY_UNREACHABLE';
      report.dataApiFailureCode = failureCode(error);
      report.dataApiCertificateFailure = failure.kind === 'certificate' || describeNetworkFailure(report.dataApiFailureCode)?.kind === 'certificate';
      report.http = failure.status;
      report.fmCode = /^\d+$/.test(failure.code ?? '') ? failure.code : undefined;
      throw error;
    }
  }, (result) => `GET /fmi/data/vLatest/productInfo: HTTP ${result.status}; FileMaker code ${result.code ?? '(not returned)'}. Product: ${result.name ?? '(not returned)'}; version: ${result.version ?? '(not returned)'}. No credentials sent.`);
  return report;
}

function socketProbe<T>(host: string, port: number, signal: AbortSignal, options: tls.ConnectionOptions | undefined, read: (socket: tls.TLSSocket) => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = options ? tls.connect({ ...options, host, port, servername: isIP(host) ? undefined : host }) : connect({ host, port });
    const abort = () => { socket.destroy(); reject(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' })); };
    const cleanup = () => { signal.removeEventListener('abort', abort); socket.destroy(); };
    signal.addEventListener('abort', abort, { once: true });
    socket.once('error', (error) => { cleanup(); reject(error); });
    socket.once(options ? 'secureConnect' : 'connect', () => {
      try { resolve(read(socket as tls.TLSSocket)); } catch (error) { reject(error); } finally { cleanup(); }
    });
    if (signal.aborted) { abort(); cleanup(); }
    socket.once('close', () => signal.removeEventListener('abort', abort));
  });
}

export function createDiagnosticProbes(client: Pick<FMClient, 'getProductInfoDiagnostics'>): DiagnosticProbes {
  return {
    dns: async (host) => { const result = await lookup(host); return result.address; },
    tcp: (host, port, signal) => socketProbe(host, port, signal, undefined, () => undefined),
    certificate: (host, port, signal) => socketProbe(host, port, signal, { rejectUnauthorized: false, ca: [] }, (socket) => {
      // Empty discovery roots keep the peer chain from being extended from the local trust store.
      const peer = socket.getPeerCertificate(true);
      const x509 = new X509Certificate(peer.raw);
      const commonName = Array.isArray(peer.subject?.CN) ? peer.subject.CN[0] : peer.subject?.CN;
      return {
        subject: x509.subject, issuer: x509.issuer, serial: x509.serialNumber,
        validFrom: x509.validFrom, validTo: x509.validTo, fingerprint: normalizeSha256(x509.fingerprint256)!,
        altNames: x509.subjectAltName ?? '', commonName,
        chainBeyondLeaf: Boolean(peer.issuerCertificate?.raw && !peer.raw.equals(peer.issuerCertificate.raw)),
        selfSigned: x509.checkIssued(x509) && x509.verify(x509.publicKey),
        protocol: socket.getProtocol() ?? '(unknown)', cipher: socket.getCipher()?.name ?? '(unknown)',
        ...certificateExpiry(x509.validFrom, x509.validTo), ...matchCertificateName(host, x509.subjectAltName ?? '', commonName)
      };
    }),
    verify: (host, port, profile, signal) => {
      // Reuse the real CA/root policy, but require strict verification even for a pinned/legacy profile.
      const agent = createHttpsAgentForProfile({ caBundlePath: profile.caBundlePath });
      return socketProbe(host, port, signal, { ...agent.options, rejectUnauthorized: true }, () => undefined);
    },
    product: (profile, signal) => client.getProductInfoDiagnostics(profile, { signal })
  };
}
