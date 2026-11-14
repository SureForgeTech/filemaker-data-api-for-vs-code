import * as vscode from 'vscode';
import type { ConnectionProfile } from '../../types/fm';
import { validateDatabaseName, validateServerUrl } from '../../utils/jsonValidate';
import { toUserErrorMessage } from '../../utils/errorUx';
import type { WizardFormData } from './types';
import type { WizardContext } from './context';
import { confirmCredentialTargets, credentialBindingChanged, dataTargetChanged } from './credentials';
import { clearCertificateForChangedAddress, resolveTlsSettings } from './certificates';

export async function handleSave(ctx: WizardContext, data: WizardFormData): Promise<void> {
  try {
    const serverValidation = validateServerUrl(data.serverUrl);
    if (!serverValidation.ok) {
      await ctx.panel.webview.postMessage({
        type: 'saveError',
        message: serverValidation.error ?? 'Invalid server URL.'
      });
      return;
    }

    const dbValidation = validateDatabaseName(data.database);
    if (!dbValidation.ok) {
      await ctx.panel.webview.postMessage({
        type: 'saveError',
        message: dbValidation.error ?? 'Invalid database name.'
      });
      return;
    }

    let proxyEndpoint: string | undefined;
    if (data.authMode === 'proxy') {
      const proxyValidation = validateServerUrl(data.proxyEndpoint ?? '', 'Proxy endpoint');
      if (!proxyValidation.ok) {
        await ctx.panel.webview.postMessage({
          type: 'saveError',
          message: proxyValidation.error ?? 'Invalid proxy endpoint.'
        });
        return;
      }
      proxyEndpoint = proxyValidation.value;
    }

    // In proxy mode the key goes to the proxy, which then talks to serverUrl: check both.
    const target = data.authMode === 'proxy' ? proxyEndpoint : serverValidation.value;
    if (!(await confirmCredentialTargets(ctx, [target, serverValidation.value]))) {
      await ctx.panel.webview.postMessage({
        type: 'saveError',
        message: 'Not saved: you did not confirm the server address.'
      });
      return;
    }

    await clearCertificateForChangedAddress(ctx, data);
    const tls = await resolveTlsSettings(ctx, data);
    if (!tls.ok) {
      await ctx.panel.webview.postMessage({ type: 'saveError', message: tls.message });
      return;
    }

    const typedSecret = data.authMode === 'direct' ? data.password : data.proxyApiKey;
    const bindingChanged = credentialBindingChanged(ctx, data);
    if (bindingChanged && !(typedSecret && typedSecret.length > 0)) {
      await ctx.panel.webview.postMessage({
        type: 'saveError',
        message:
          data.authMode === 'direct'
            ? 'The server address, database, API path or user name changed. Enter the password again so the saved one is not sent to a different server.'
            : 'The proxy address, server, database or API path changed. Enter the proxy API key again so the saved one is not sent to a different server.'
      });
      return;
    }

    const profile: ConnectionProfile = {
      id: ctx.editingProfile?.id ?? crypto.randomUUID(),
      name: data.name.trim(),
      authMode: data.authMode,
      serverUrl: serverValidation.value!,
      database: dbValidation.value!,
      apiBasePath: data.apiBasePath.trim(),
      apiVersionPath: data.apiVersionPath.trim()
    };
    Object.assign(profile, tls.profileFields);
    // Editing must not silently drop what AI tools were allowed to do, unless the profile now
    // points at a different server, user, database or API path (then the earlier choice no
    // longer applies and access goes back to none).
    if (
      ctx.editingProfile?.aiAccess &&
      !bindingChanged &&
      !dataTargetChanged(ctx.editingProfile, profile)
    ) {
      profile.aiAccess = ctx.editingProfile.aiAccess;
    }

    if (data.authMode === 'direct') {
      profile.username = data.username?.trim();
    } else {
      profile.proxyEndpoint = proxyEndpoint;
    }

    if (bindingChanged) {
      // A session token belongs to the server it was issued by. Drop it before the profile
      // points somewhere else, so no request can pair the old token with the new address.
      await ctx.secretStore.deleteSessionToken(profile.id);
    }

    await ctx.profileStore.upsertProfile(profile);
    // New credentials deserve a fresh start: end any pause on automatic sign-ins.
    ctx.fmClient.clearAuthPause?.(profile.id);
    // A changed account or server may see different layouts and fields: drop what was cached.
    ctx.fmClient.invalidateProfileCache?.(profile.id);

    if (data.authMode === 'direct') {
      if (data.password && data.password.length > 0) {
        await ctx.secretStore.setPassword(profile.id, data.password);
      }
      await ctx.secretStore.deleteProxyApiKey(profile.id);
    } else {
      if (data.proxyApiKey && data.proxyApiKey.length > 0) {
        await ctx.secretStore.setProxyApiKey(profile.id, data.proxyApiKey);
      }
      await ctx.secretStore.deletePassword(profile.id);
    }

    const isNewProfile = !ctx.editingProfile;
    ctx.editingProfile = profile;

    await ctx.panel.webview.postMessage({
      type: 'saveSuccess',
      message: `Profile "${profile.name}" saved.`
    });

    // Close the gap between "saved" and "connected": the natural next step
    // after creating a profile is to open a session, but until now the user
    // had to discover and run FileMaker: Connect themselves. Offer it inline
    // as a native toast action so first-run onboarding flows straight through.
    void offerConnect(ctx, profile, isNewProfile);
  } catch (error) {
    await ctx.panel.webview.postMessage({
      type: 'saveError',
      message: toUserErrorMessage(error, 'Failed to save profile.')
    });
  }
}

/**
 * Surface a "Connect Now" toast after a save so the user can open a session
 * without hunting for the command. The connect command resolves the profile
 * from the `{ profileId }` arg, so we hand it the freshly-saved id directly.
 * Failures here are non-fatal — the profile is already persisted and the user
 * can connect later from the sidebar or Command Palette.
 */
async function offerConnect(
  ctx: WizardContext,
  profile: ConnectionProfile,
  isNewProfile: boolean
): Promise<void> {
  try {
    const prompt = isNewProfile
      ? `Profile "${profile.name}" saved. Connect now to start a session?`
      : `Profile "${profile.name}" updated. Reconnect now?`;
    const choice = await vscode.window.showInformationMessage(
      prompt,
      'Connect Now'
    );
    if (choice === 'Connect Now') {
      await vscode.commands.executeCommand('filemakerDataApiTools.connect', {
        profileId: profile.id
      });
    }
  } catch (error) {
    ctx.logger.warn('Failed to offer post-save connect.', { error });
  }
}
