import * as vscode from 'vscode';
import type { ConnectionProfile } from '../../types/fm';
import { validateDatabaseName, validateServerUrl } from '../../utils/jsonValidate';
import { toUserErrorMessage } from '../../utils/errorUx';
import { FMClientError } from '../../services/errors';
import { reviewAndTrustCertificate } from '../../services/certificateTrust';
import { describeNetworkFailure } from '../../utils/networkErrors';
import { docsUrlForCode } from '../../utils/fileMakerCodes';
import type { WizardFormData } from './types';
import type { WizardContext } from './context';
import { confirmCredentialTargets, credentialBindingChanged } from './credentials';
import { clearCertificateForChangedAddress, resolveTlsSettings, certificateAddress, sendCertificateState } from './certificates';

async function postTestProgress(ctx: WizardContext, phase: string): Promise<void> {
  await ctx.panel.webview.postMessage({ type: 'testProgress', phase });
}

export async function handleTestConnection(ctx: WizardContext, data: WizardFormData, offeredTrust = false): Promise<void> {
  const timeoutMs = vscode.workspace
    .getConfiguration('filemaker')
    .get<number>('requestTimeoutMs', 15_000);
  await ctx.panel.webview.postMessage({ type: 'testStarted', timeoutMs });

  // The test runs under a throwaway id with throwaway secrets, so it can never
  // read, overwrite or clear what is saved for a real profile.
  const testId = `test-connection-${crypto.randomUUID()}`;

  try {
    const serverValidation = validateServerUrl(data.serverUrl);
    if (!serverValidation.ok) {
      throw new Error(serverValidation.error ?? 'Invalid server URL.');
    }
    const dbValidation = validateDatabaseName(data.database);
    if (!dbValidation.ok) {
      throw new Error(dbValidation.error ?? 'Invalid database name.');
    }

    let proxyEndpoint: string | undefined;
    if (data.authMode === 'proxy') {
      const proxyValidation = validateServerUrl(data.proxyEndpoint ?? '', 'Proxy endpoint');
      if (!proxyValidation.ok) {
        throw new Error(proxyValidation.error ?? 'Invalid proxy endpoint.');
      }
      proxyEndpoint = proxyValidation.value;
    }

    const target = data.authMode === 'proxy' ? proxyEndpoint : serverValidation.value;
    if (!(await confirmCredentialTargets(ctx, [target, serverValidation.value]))) {
      throw new Error('Test cancelled: you did not confirm the server address.');
    }

    await clearCertificateForChangedAddress(ctx, data);
    const tls = await resolveTlsSettings(ctx, data);
    if (!tls.ok) {
      throw new Error(tls.message);
    }

    const tempProfile: ConnectionProfile = {
      id: testId,
      name: data.name.trim(),
      authMode: data.authMode,
      serverUrl: serverValidation.value!,
      database: dbValidation.value!,
      apiBasePath: data.apiBasePath.trim(),
      apiVersionPath: data.apiVersionPath.trim()
    };
    Object.assign(tempProfile, tls.profileFields);

    await postTestProgress(ctx, 'Preparing credentials…');
    const typedSecret = data.authMode === 'direct' ? data.password : data.proxyApiKey;
    const bindingChanged = credentialBindingChanged(ctx,
      data.authMode,
      target,
      data.username,
      serverValidation.value
    );
    let secret = typedSecret && typedSecret.length > 0 ? typedSecret : undefined;
    if (!secret && ctx.editingProfile && !bindingChanged) {
      // Unchanged server and user: the saved secret may be used for the test.
      secret =
        data.authMode === 'direct'
          ? await ctx.secretStore.getPassword(ctx.editingProfile.id)
          : await ctx.secretStore.getProxyApiKey(ctx.editingProfile.id);
    }
    if (!secret) {
      throw new Error(
        bindingChanged
          ? 'The server address or user changed. Enter the password (or API key) again to test it.'
          : data.authMode === 'direct'
            ? 'Enter a password to test the connection.'
            : 'Enter the proxy API key to test the connection.'
      );
    }

    if (data.authMode === 'direct') {
      tempProfile.username = data.username?.trim();
      await ctx.secretStore.setPassword(testId, secret);
    } else {
      tempProfile.proxyEndpoint = proxyEndpoint;
      await ctx.secretStore.setProxyApiKey(testId, secret);
    }

    // Test Connection is a ladder, so the message says which rung failed: reach the Data API
    // (TLS, name, port, a web page in the way), list the hosted databases, then sign in.
    let rung = 'sign-in';
    let hosted: string[] | undefined;
    let product = '';
    try {
      if (data.authMode === 'direct') {
        rung = 'server';
        await postTestProgress(ctx, 'Step 1 of 3: reaching the Data API (TLS and product info)…');
        const info = await ctx.fmClient.getProductInfo(tempProfile);
        product = [info.name, info.version].filter(Boolean).join(' ');

        rung = 'databases';
        await postTestProgress(ctx, 'Step 2 of 3: listing the hosted databases…');
        hosted = await ctx.fmClient.listHostedDatabases(tempProfile);
      }

      rung = 'sign-in';
      await postTestProgress(ctx, data.authMode === 'direct' ? 'Step 3 of 3: signing in…' : 'Opening session…');
      // A test is the user asking for a sign-in, so it goes ahead even if automatic ones are paused.
      await ctx.fmClient.createSession(tempProfile, { userInitiated: true });
    } catch (error) {
      throw explainTestFailure(error, rung, hosted);
    }

    await postTestProgress(ctx, 'Cleaning up…');
    await ctx.fmClient.deleteSession(tempProfile);

    const notes: string[] = [];
    if (hosted && !hosted.some((name) => name.toLowerCase() === tempProfile.database.toLowerCase())) {
      notes.push(`The server does not list a database called "${tempProfile.database}" (it lists: ${hosted.join(', ') || 'none'}), although sign-in worked.`);
    }
    await ctx.panel.webview.postMessage({
      type: 'testSuccess',
      message: ['Connection successful. Session opened and closed cleanly.', product ? `Server: ${product}.` : '', ...notes]
        .filter(Boolean)
        .join(' ')
    });
  } catch (error) {
    // A certificate problem is the one failure the user can sensibly decide on here: offer to
    // review the certificate and, if they accept it, run the test again with it trusted.
    const networkCode = error instanceof FMClientError ? error.networkCode : undefined;
    if (!offeredTrust && networkCode && describeNetworkFailure(networkCode)?.trustable) {
      const decision = await reviewAndTrustCertificate(
        { name: data.name || 'this connection', authMode: data.authMode, serverUrl: data.serverUrl, proxyEndpoint: data.proxyEndpoint },
        { networkCode, previousSha256: ctx.certState.pin?.sha256 }
      );
      if (decision) {
        ctx.certificateTarget = certificateAddress(data);
    ctx.certState = { pin: { sha256: decision.sha256, allowExpired: decision.allowExpired }, legacy: false };
        await sendCertificateState(ctx);
        await handleTestConnection(ctx, data, true);
        return;
      }
    }
    await ctx.panel.webview.postMessage({
      type: 'testError',
      message: toUserErrorMessage(error, 'Connection test failed.'),
      // Shown as a button with the error, so a declined or dismissed dialog can be reopened.
      trust:
        networkCode && describeNetworkFailure(networkCode)?.trustable
          ? networkCode === 'FM_CERT_PIN_MISMATCH' || networkCode === 'FM_CERT_PIN_EXPIRED'
            ? 'retrust'
            : 'trust'
          : undefined
    });
  } finally {
    try {
      await ctx.secretStore.deletePassword(testId);
      await ctx.secretStore.deleteProxyApiKey(testId);
      await ctx.secretStore.deleteSessionToken(testId);
      // The throwaway test profile must not linger in the client's pause and health tables.
      ctx.fmClient.forgetProfile?.(testId);
    } catch (error) {
      ctx.logger.warn('Could not remove temporary test credentials.', { error });
    }
  }
}

/** Says which rung of the Test Connection ladder failed, and lists the hosted databases when the name looks wrong. */
function explainTestFailure(error: unknown, rung: string, hosted: string[] | undefined): unknown {
  if (!(error instanceof FMClientError)) {
    return error;
  }
  const where =
    rung === 'server'
      ? 'Could not reach the Data API'
      : rung === 'databases'
        ? 'Could not list the hosted databases'
        : 'Reached the server, but sign-in failed';
  const listing =
    rung === 'sign-in' && error.fmCategory === 'config' && hosted && hosted.length > 0
      ? ` The server lists these databases: ${hosted.join(', ')}.`
      : '';
  return new FMClientError(`${where}: ${error.message}${listing}`, {
    status: error.status,
    code: error.code,
    networkCode: error.networkCode,
    fmCategory: error.fmCategory,
    // The troubleshooting section for the FileMaker code, so the report links to what explains it.
    docsUrl: docsUrlForCode(error.code ?? ''),
    kind: error.kind,
    isRetryable: error.isRetryable,
    details: error.details
  });
}
