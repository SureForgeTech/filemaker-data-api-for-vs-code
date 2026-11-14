import * as vscode from 'vscode';
import type { ConnectionProfile } from '../../types/fm';
import { isUnencryptedRemoteUrl } from '../../utils/jsonValidate';
import { PROFILE_TEMPLATE_RELATIVE_PATH } from '../../services/profileTemplate';
import type { WizardContext } from './context';
import type { WizardFormData } from './types';

export function originOf(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** The path prefix can select a different application behind the same gateway. */
function credentialAddress(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

/**
 * True when the saved credentials of the profile being edited would now go to a different
 * server or user than the ones they were saved for.
 */
export function credentialBindingChanged(
  ctx: WizardContext,
  data: WizardFormData
): boolean {
  const editing = ctx.editingProfile;
  if (!editing) {
    return false;
  }

  const before = {
    authMode: editing.authMode,
    origin: credentialAddress(editing.authMode === 'proxy' ? editing.proxyEndpoint : editing.serverUrl),
    backend: credentialAddress(editing.serverUrl),
    username: editing.authMode === 'direct' ? (editing.username ?? '').trim() : '',
    database: editing.database.trim(),
    apiBasePath: editing.apiBasePath?.trim() ?? '/fmi/data',
    apiVersionPath: editing.apiVersionPath?.trim() ?? 'vLatest'
  };
  const after = {
    authMode: data.authMode,
    origin: credentialAddress(data.authMode === 'proxy' ? data.proxyEndpoint : data.serverUrl),
    backend: credentialAddress(data.serverUrl),
    username: data.authMode === 'direct' ? (data.username ?? '').trim() : '',
    database: data.database.trim(),
    apiBasePath: data.apiBasePath.trim(),
    apiVersionPath: data.apiVersionPath.trim()
  };
  return (
    before.authMode !== after.authMode ||
    before.origin !== after.origin ||
    before.backend !== after.backend ||
    before.username !== after.username ||
    before.database !== after.database ||
    before.apiBasePath !== after.apiBasePath ||
    before.apiVersionPath !== after.apiVersionPath
  );
}

/** The database or API path (not only the address and user) decides what AI tools could reach. */
export function dataTargetChanged(before: ConnectionProfile, after: ConnectionProfile): boolean {
  const norm = (value: string | undefined, fallback: string): string => (value ?? '').trim() || fallback;
  return (
    before.database.trim() !== after.database.trim() ||
    norm(before.apiBasePath, '/fmi/data') !== norm(after.apiBasePath, '/fmi/data') ||
    norm(before.apiVersionPath, 'vLatest') !== norm(after.apiVersionPath, 'vLatest')
  );
}

async function isKnownOrigin(ctx: WizardContext, origin: string): Promise<boolean> {
  const profiles = await ctx.profileStore.listProfiles();
  return profiles.some(
    (profile) => originOf(profile.serverUrl) === origin || originOf(profile.proxyEndpoint) === origin
  );
}

/**
 * Credentials are about to be stored for, or sent to, this address. Ask first when the
 * address came from the workspace rather than from the user, or when it is a remote
 * http:// address that would carry them unencrypted.
 */
export async function confirmCredentialTargets(ctx: WizardContext, targets: Array<string | undefined>): Promise<boolean> {
  for (const target of new Set(targets)) {
    if (!(await confirmCredentialTarget(ctx, target))) {
      return false;
    }
  }
  return true;
}

async function confirmCredentialTarget(ctx: WizardContext, target: string | undefined): Promise<boolean> {
  const origin = originOf(target);
  if (!target || !origin) {
    return true;
  }

  if (ctx.templateOrigins.has(origin) && !(await isKnownOrigin(ctx, origin))) {
    const answer = await vscode.window.showWarningMessage(
      `Your credentials would go to ${origin}.\n\nThis address came from the workspace file ${PROFILE_TEMPLATE_RELATIVE_PATH}, not from you. Only continue if you trust this server.`,
      { modal: true },
      'Continue'
    );
    if (answer !== 'Continue') {
      return false;
    }
  }

  if (isUnencryptedRemoteUrl(target)) {
    const answer = await vscode.window.showWarningMessage(
      `${origin} uses unencrypted http://.\n\nYour password or API key would be sent in clear text and could be read on the network.`,
      { modal: true },
      'Continue anyway'
    );
    if (answer !== 'Continue anyway') {
      return false;
    }
  }

  return true;
}
