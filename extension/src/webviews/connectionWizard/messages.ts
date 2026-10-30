import * as vscode from 'vscode';
import { toRecord } from '../common/messageValidation';
import type { WizardFormData } from './types';
import type { WizardContext } from './context';
import { sendInit, sendLoadProfile } from './profiles';
import { handleSave } from './save';
import { handleReviewCertificate, clearCertificateForChangedAddress, sendCertificateState } from './certificates';
import { handleTestConnection } from './testConnection';

const MAX_FORM_FIELD_LENGTH = 4096;

/** Checks the shape of a form sent by the page; the host never trusts it. */
function parseFormData(payload: unknown): WizardFormData | undefined {
  const value = toRecord(payload);
  if (!value) {
    return undefined;
  }

  const text = (field: string, required: boolean): string | undefined | null => {
    const raw = value[field];
    if (raw === undefined || raw === null) {
      return required ? null : undefined;
    }
    return typeof raw === 'string' && raw.length <= MAX_FORM_FIELD_LENGTH ? raw : null;
  };

  const name = text('name', true);
  const serverUrl = text('serverUrl', true);
  const database = text('database', true);
  const apiBasePath = text('apiBasePath', true);
  const apiVersionPath = text('apiVersionPath', true);
  const username = text('username', false);
  const password = text('password', false);
  const proxyEndpoint = text('proxyEndpoint', false);
  const proxyApiKey = text('proxyApiKey', false);
  const caBundlePath = text('caBundlePath', false);
  const authMode = value.authMode;

  if (
    name === null ||
    serverUrl === null ||
    database === null ||
    apiBasePath === null ||
    apiVersionPath === null ||
    username === null ||
    password === null ||
    proxyEndpoint === null ||
    proxyApiKey === null ||
    caBundlePath === null ||
    (authMode !== 'direct' && authMode !== 'proxy') ||
    name === undefined ||
    serverUrl === undefined ||
    database === undefined ||
    apiBasePath === undefined ||
    apiVersionPath === undefined
  ) {
    return undefined;
  }

  return {
    name,
    authMode,
    serverUrl,
    database,
    apiBasePath,
    apiVersionPath,
    username,
    password,
    proxyEndpoint,
    proxyApiKey,
    caBundlePath
  };
}

export async function handleMessage(ctx: WizardContext, raw: unknown): Promise<void> {
  const record = toRecord(raw);
  if (!record) {
    return;
  }

  switch (record.type) {
    case 'ready':
      await sendInit(ctx);
      await sendLoadProfile(ctx);
      break;
    case 'manageWorkspaceTrust':
      await vscode.commands.executeCommand('workbench.trust.manage');
      break;
    case 'save': {
      const data = parseFormData(record.payload);
      if (!data) {
        await ctx.panel.webview.postMessage({ type: 'saveError', message: 'The form data was not valid.' });
        return;
      }
      await handleSave(ctx, data);
      break;
    }
    case 'reviewCertificate':
    case 'convertLegacyCertificate': {
      const data = parseFormData(record.payload);
      if (!data) {
        await ctx.panel.webview.postMessage({ type: 'saveError', message: 'The form data was not valid.' });
        return;
      }
      await handleReviewCertificate(ctx, data);
      break;
    }
    case 'addressChanged': {
      const data = toRecord(record.payload);
      if (data && typeof data.serverUrl === 'string') {
        await clearCertificateForChangedAddress(ctx, data as unknown as WizardFormData);
      }
      break;
    }
    case 'forgetCertificate':
      ctx.certState = { legacy: ctx.certState.legacy };
      await sendCertificateState(ctx);
      break;
    case 'stopSkippingCertificateChecks':
      ctx.certState = { pin: ctx.certState.pin, legacy: false };
      await sendCertificateState(ctx);
      break;
    case 'pickCaBundle': {
      // The page asks the host to pick a CA certificate file. The request carries no data of
      // its own — the message shape is checked the way the neighbours check it (handleMessage
      // only accepts an object, and no field of this message is read) — so the path that goes
      // back is the one VS Code's own file dialog returned, never one the page asked for.
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectMany: false,
        filters: { Certificates: ['pem', 'crt', 'cer'] },
        title: 'Select the CA certificate file'
      });
      if (picked?.[0]) {
        await ctx.panel.webview.postMessage({ type: 'caBundlePicked', path: picked[0].fsPath });
      }
      break;
    }
    case 'testConnection': {
      const data = parseFormData(record.payload);
      if (!data) {
        await ctx.panel.webview.postMessage({ type: 'testError', message: 'The form data was not valid.' });
        return;
      }
      await handleTestConnection(ctx, data);
      break;
    }
    default:
      break;
  }
}
