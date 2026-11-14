import type { ConnectionProfile } from '../../types/fm';
import { validateServerUrl } from '../../utils/jsonValidate';
import { validateCaBundleFile } from '../../utils/tlsProfile';
import { reviewAndTrustCertificate } from '../../services/certificateTrust';
import { originOf, confirmCredentialTargets } from './credentials';
import type { WizardFormData } from './types';
import type { WizardContext } from './context';

/**
 * The certificate settings a saved or tested profile gets: the CA file typed in the form (checked
 * to be a real certificate file) and the trust decisions kept in `certState`. Those decisions come
 * only from the trust dialog, never from the form, a workspace template or a file.
 */
export async function resolveTlsSettings(
  ctx: WizardContext,
  data: WizardFormData
): Promise<
  | { ok: true; profileFields: Partial<ConnectionProfile> }
  | { ok: false; message: string }
> {
  const profileFields: Partial<ConnectionProfile> = {};
  if (data.caBundlePath && data.caBundlePath.trim().length > 0) {
    const validation = await validateCaBundleFile(data.caBundlePath);
    if (!validation.ok) {
      return { ok: false, message: validation.error ?? 'Invalid CA certificate file.' };
    }
    profileFields.caBundlePath = validation.value;
  }
  if (ctx.certState.pin) {
    profileFields.pinnedCertSha256 = ctx.certState.pin.sha256;
    if (ctx.certState.pin.allowExpired) {
      profileFields.pinnedCertAllowExpired = true;
    }
  }
  if (ctx.certState.legacy) {
    profileFields.allowSelfSigned = true;
  }
  return { ok: true, profileFields };
}

export function certificateAddress(data: Pick<WizardFormData, 'authMode' | 'serverUrl' | 'proxyEndpoint'>): string | undefined {
  const server = originOf(data.serverUrl);
  return data.authMode === 'proxy' ? `${server}|${originOf(data.proxyEndpoint)}` : server;
}

export async function clearCertificateForChangedAddress(ctx: WizardContext, data: WizardFormData): Promise<void> {
  const target = certificateAddress(data);
  // Before the page's ready message, the saved profile is the only record of the original address.
  const trustedTarget = ctx.certificateTarget ?? (ctx.editingProfile ? certificateAddress(ctx.editingProfile) : undefined);
  if ((ctx.certState.pin || ctx.certState.legacy || ctx.editingProfile?.caBundlePath) && target !== trustedTarget) {
    const cleared = ctx.certState.legacy
      ? 'The older setting that skips all certificate checks was cleared.'
      : ctx.certState.pin ? 'The trusted certificate was cleared.' : 'The custom CA certificate file was cleared.';
    ctx.certState = { legacy: false };
    // Nothing is trusted for the new address yet, so later checks compare against it and a CA file
    // the user chooses afterwards is kept.
    ctx.certificateTarget = target;
    // Clear the submitted field too: Save/Test may arrive without an addressChanged message,
    // or with the old CA path still in the form. The saved profile's address stays unchanged.
    if (data.caBundlePath || ctx.editingProfile?.caBundlePath) {
      data.caBundlePath = undefined;
      await ctx.panel.webview.postMessage({ type: 'caBundlePicked', path: '' });
    }
    await sendCertificateState(ctx);
    await ctx.panel.webview.postMessage({ type: 'certificateNotice', message: `The server address changed. ${cleared} Review the certificate for this address before trusting it.` });
  }
}

export async function sendCertificateState(ctx: WizardContext): Promise<void> {
  await ctx.panel.webview.postMessage({
    type: 'certificateState',
    payload: {
      pin: ctx.certState.pin,
      legacy: ctx.certState.legacy
    }
  });
}

/**
 * "Review server certificate…" (and "Convert to a pinned certificate…"): read what the server
 * presents, show it, and on acceptance pin it for this connection.
 */
export async function handleReviewCertificate(ctx: WizardContext, data: WizardFormData): Promise<void> {
  await clearCertificateForChangedAddress(ctx, data);
  const serverValidation = validateServerUrl(data.serverUrl);
  const proxyValidation = data.authMode === 'proxy' ? validateServerUrl(data.proxyEndpoint ?? '', 'Proxy endpoint') : undefined;
  const target = data.authMode === 'proxy' ? proxyValidation : serverValidation;
  if (!target?.ok || !target.value) {
    await ctx.panel.webview.postMessage({ type: 'saveError', message: target?.error ?? 'Enter a valid server address first.' });
    return;
  }
  if (!/^https:/i.test(target.value)) {
    await ctx.panel.webview.postMessage({
      type: 'saveError',
      message: 'Certificates only apply to https:// addresses.'
    });
    return;
  }
  // Same rule as for saving or testing: an address that came from the workspace's profile template
  // is confirmed first (the review connects to it).
  if (!(await confirmCredentialTargets(ctx, [target.value, serverValidation.value]))) {
    await ctx.panel.webview.postMessage({
      type: 'saveError',
      message: 'Not reviewed: you did not confirm the server address.'
    });
    return;
  }
  const decision = await reviewAndTrustCertificate(
    {
      name: data.name || 'this connection',
      authMode: data.authMode,
      serverUrl: serverValidation.value ?? target.value,
      proxyEndpoint: proxyValidation?.value
    },
    { previousSha256: ctx.certState.pin?.sha256 }
  );
  if (decision) {
    ctx.certificateTarget = certificateAddress(data);
    ctx.certState = { pin: { sha256: decision.sha256, allowExpired: decision.allowExpired }, legacy: false };
    await sendCertificateState(ctx);
  }
}
