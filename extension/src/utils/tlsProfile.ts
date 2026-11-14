import { closeSync, constants, fstatSync, openSync, readSync } from 'fs';
import path from 'path';

import type { ConnectionProfile } from '../types/fm';
import { FMClientError } from '../services/errors';

const MAX_CA_BUNDLE_BYTES = 1024 * 1024;

/** Read a public CA bundle with the same bounds at profile validation and at request time. */
export function readCaBundleFile(filePath: string): string {
  // A special file must not block on open before fstat can reject it.
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    const invalid = (message: string): FMClientError => new FMClientError(message, {
      code: 'TLS_CA_BUNDLE_INVALID', kind: 'validation', isRetryable: false
    });
    if (!info.isFile()) {
      throw invalid('The CA certificate path is not a file.');
    }
    const tooLarge = 'The CA certificate file is larger than 1 MB, so it is probably not a certificate.';
    if (info.size > MAX_CA_BUNDLE_BYTES) {
      throw invalid(tooLarge);
    }
    // Bound the read itself as well, in case the file grows after fstat.
    const bytes = Buffer.alloc(MAX_CA_BUNDLE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) {
        break;
      }
      length += count;
    }
    if (length > MAX_CA_BUNDLE_BYTES) {
      throw invalid(tooLarge);
    }
    const content = bytes.subarray(0, length).toString('utf8');
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content)) {
      throw invalid('That file contains a private key. Choose the CA certificate (public) file instead.');
    }
    return content;
  } finally {
    closeSync(fd);
  }
}

export interface CaBundleValidation {
  ok: boolean;
  /** The trimmed absolute path, when ok. */
  value?: string;
  error?: string;
}

/**
 * Checks a "custom CA certificate file" before it is saved on a profile: an absolute path
 * to a readable PEM file that holds at least one certificate and no private key. (A relative
 * path would depend on the extension host's working directory, and a private key has no
 * business in a trust list.)
 */
export async function validateCaBundleFile(rawPath: string): Promise<CaBundleValidation> {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return { ok: false, error: 'Enter the path to a CA certificate file.' };
  }
  if (trimmed.includes('\0') || !path.isAbsolute(trimmed)) {
    return { ok: false, error: 'The CA certificate file must be given as an absolute path.' };
  }

  try {
    const content = readCaBundleFile(trimmed);
    if (!/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.test(content)) {
      return { ok: false, error: 'The file is not a PEM certificate (no BEGIN CERTIFICATE block found).' };
    }
  } catch (error) {
    return { ok: false, error: error instanceof FMClientError ? error.message : 'The CA certificate file could not be read. Check the path and permissions.' };
  }

  return { ok: true, value: trimmed };
}

/** Short text for profile lists and tooltips when the profile changes how TLS is checked. */
export function describeTlsSettings(
  profile: Pick<ConnectionProfile, 'allowSelfSigned' | 'caBundlePath' | 'pinnedCertSha256' | 'pinnedCertAllowExpired'>
): string | undefined {
  const parts: string[] = [];
  if (profile.pinnedCertSha256) {
    parts.push(
      profile.pinnedCertAllowExpired
        ? 'trusts one pinned certificate (accepted although it is not valid)'
        : 'trusts one pinned certificate'
    );
  } else if (profile.allowSelfSigned === true) {
    parts.push('⚠ skips ALL certificate checks (older setting; convert it to a pinned certificate)');
  }
  if (profile.caBundlePath?.trim()) {
    parts.push('custom CA');
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}
