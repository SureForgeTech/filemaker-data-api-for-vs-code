import { serverOrigin } from '@fmweb/shared/dist/field-standards';
import { randomInt } from 'crypto';

import type * as vscode from 'vscode';

interface CspOptions {
  nonce: string;
  allowInlineStyleWithNonce?: boolean;
  connectSources?: string[];
  imageSources?: string[];
}

/** A CSP nonce from the OS CSPRNG; `randomInt` draws without modulo bias. */
export function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';

  for (let index = 0; index < 32; index += 1) {
    value += chars.charAt(randomInt(chars.length));
  }

  return value;
}

export function buildWebviewCsp(webview: vscode.Webview, options: CspOptions): string {
  const styleSources = [webview.cspSource];
  if (options.allowInlineStyleWithNonce) {
    styleSources.push(`'nonce-${options.nonce}'`);
  }
  const connectSources = [webview.cspSource, ...(options.connectSources ?? [])];
  const imageSources = [webview.cspSource, 'data:', ...(options.imageSources ?? [])];

  return [
    "default-src 'none'",
    `img-src ${dedupe(imageSources).join(' ')}`,
    `style-src ${dedupe(styleSources).join(' ')}`,
    `script-src 'nonce-${options.nonce}'`,
    `connect-src ${dedupe(connectSources).join(' ')}`
  ].join('; ');
}

export { serverOrigin };

/**
 * The origins of the configured servers, so a container image can be shown in a webview. Only
 * those exact origins are allowed; every host on the internet is not.
 */
export function profileImageSources(store: { listProfilesSync?: () => unknown } | undefined): string[] {
  const profiles = store?.listProfilesSync?.();
  if (!Array.isArray(profiles)) return [];
  const origins = profiles
    .map((profile) => serverOrigin((profile as { serverUrl?: string } | undefined)?.serverUrl))
    .filter((origin): origin is string => Boolean(origin));
  return Array.from(new Set(origins));
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}
