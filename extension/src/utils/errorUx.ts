import * as vscode from 'vscode';

import type { NormalizedError, RequestChainEntry } from '../types/errors';
import { isTrustableCertificateCode } from './networkErrors';
import { normalizeError } from './normalizeError';
import { redactString, redactValue } from './redact';

export interface ShowErrorOptions {
  fallbackMessage?: string;
  logger?: {
    error: (message: string, meta?: unknown) => void;
  };
  logMessage?: string;
  /**
   * Optional action affordances on the error toast. When provided, the toast
   * shows the matching button for the error kind:
   * - `retry`: shown for transient errors (network/timeout/5xx). Invokes the
   *   callback when clicked.
   * - `profileId`: shown for auth errors (HTTP 401/403). Opens the connection
   *   wizard for that profile, and offers `Reconnect`, which signs in again
   *   with that profile in one click after a session expiry or a rejected
   *   sign-in.
   * - `settingsKey`: shown for timeout/configuration errors. Opens VS Code
   *   settings filtered to that key.
   *
   * `Open Troubleshooting` is offered whenever the error carries a link to the
   * troubleshooting page (`docsUrl`), with or without the other affordances.
   */
  actions?: {
    retry?: () => void | Promise<void>;
    profileId?: string;
    settingsKey?: string;
    /**
     * For certificate problems: review the server's certificate and, if the user agrees, trust it.
     * Offered for the failures a person may sensibly decide on (self-signed, unknown issuer, wrong
     * name, expired); `Review and re-trust` when the certificate differs from the one trusted.
     */
    trustCertificate?: () => void | Promise<void>;
  };
}

const DETAILS_ACTION = 'Details…';
const COPY_REPORT_ACTION = 'Copy as Bug Report';
const RETRY_ACTION = 'Retry';
const RECONNECT_ACTION = 'Reconnect';
const EDIT_PROFILE_ACTION = 'Edit Profile';
const OPEN_SETTINGS_ACTION = 'Open Settings';
const DOCS_ACTION = 'Open Troubleshooting';
const TRUST_CERTIFICATE_ACTION = 'Trust this certificate…';
const RETRUST_CERTIFICATE_ACTION = 'Review and re-trust';

/**
 * Decide which action buttons to surface on an error toast based on the
 * normalized error kind. Exported for unit testing.
 *
 * `Reconnect` signs in again with the profile of an auth error, `Open
 * Troubleshooting` opens the troubleshooting page section the error points at.
 */
export function selectErrorActions(
  normalized: {
    kind: string;
    status?: number;
    isRetryable?: boolean;
    networkCode?: string;
    fmCategory?: string;
    docsUrl?: string;
  },
  actions: ShowErrorOptions['actions']
): string[] {
  const out: string[] = [];
  if (!actions) {
    // The troubleshooting link stands on its own: it needs no other affordance.
    return normalized.docsUrl ? [DOCS_ACTION] : out;
  }

  const status = normalized.status;
  const isCertificate = normalized.kind === 'certificate';
  // Fixing the profile helps for rejected credentials and a wrong database name. It does not help
  // when the account is fine but lacks a privilege (HTTP 403, FileMaker privilege errors): that is
  // for the FileMaker administrator.
  const isPrivilege = status === 403 || normalized.fmCategory === 'privilege';
  const isAuth =
    !isPrivilege &&
    !isCertificate &&
    (normalized.kind === 'auth' ||
      status === 401 ||
      normalized.fmCategory === 'credentials' ||
      normalized.fmCategory === 'config');
  // `isRetryable` is decided where the error is built; the old guess from the kind or the status
  // only remains for callers that pass nothing else.
  const isTransient =
    !isCertificate &&
    (normalized.isRetryable !== undefined
      ? normalized.isRetryable === true
      : normalized.kind === 'timeout' ||
        normalized.kind === 'network' ||
        (typeof status === 'number' && status >= 500 && status < 600));
  const isTimeout = normalized.kind === 'timeout';

  if (actions.retry && isTransient) {
    out.push(RETRY_ACTION);
  }
  // Only where trusting makes sense: not for, say, a revoked certificate.
  if (actions.trustCertificate && isCertificate && isTrustableCertificateCode(normalized.networkCode)) {
    out.push(
      normalized.networkCode === 'FM_CERT_PIN_MISMATCH' || normalized.networkCode === 'FM_CERT_PIN_EXPIRED'
        ? RETRUST_CERTIFICATE_ACTION
        : TRUST_CERTIFICATE_ACTION
    );
  }
  if (actions.profileId && isAuth) {
    out.push(RECONNECT_ACTION);
    out.push(EDIT_PROFILE_ACTION);
  }
  if (actions.settingsKey && isTimeout) {
    out.push(OPEN_SETTINGS_ACTION);
  }
  if (normalized.docsUrl) {
    out.push(DOCS_ACTION);
  }
  return out;
}

export async function showErrorWithDetails(
  error: unknown,
  options?: ShowErrorOptions
): Promise<void> {
  const normalized = normalizeError(error, {
    fallbackMessage: options?.fallbackMessage
  });

  options?.logger?.error(options?.logMessage ?? 'Command failed.', {
    error: normalized
  });

  // Any surface that can name the profile gets the certificate review for free.
  const actions = options?.actions
    ? {
        ...options.actions,
        trustCertificate:
          options.actions.trustCertificate ??
          (options.actions.profileId
            ? async () => {
                await vscode.commands.executeCommand('filemakerDataApiTools.trustServerCertificate', {
                  profileId: options.actions?.profileId,
                  networkCode: normalized.networkCode
                });
              }
            : undefined)
      }
    : undefined;
  const actionButtons = selectErrorActions(normalized, actions);
  const allButtons = [...actionButtons, DETAILS_ACTION, COPY_REPORT_ACTION];

  const selection = await vscode.window.showErrorMessage(
    normalized.message,
    ...allButtons
  );

  if (selection === RETRY_ACTION && actions?.retry) {
    try {
      await actions.retry();
    } catch (retryError) {
      options?.logger?.error('Retry action failed.', { error: retryError });
    }
    return;
  }
  if (
    (selection === TRUST_CERTIFICATE_ACTION || selection === RETRUST_CERTIFICATE_ACTION) &&
    actions?.trustCertificate
  ) {
    try {
      await actions.trustCertificate();
    } catch (trustError) {
      options?.logger?.error('Trust certificate action failed.', { error: trustError });
    }
    return;
  }
  if (selection === EDIT_PROFILE_ACTION && options?.actions?.profileId) {
    await vscode.commands.executeCommand('filemakerDataApiTools.editConnectionProfile', {
      profileId: options.actions.profileId
    });
    return;
  }
  if (selection === OPEN_SETTINGS_ACTION && options?.actions?.settingsKey) {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings',
      `@id:${options.actions.settingsKey}`
    );
    return;
  }
  if (selection === RECONNECT_ACTION && options?.actions?.profileId) {
    await vscode.commands.executeCommand('filemakerDataApiTools.connect', {
      profileId: options.actions.profileId
    });
    return;
  }
  if (selection === DOCS_ACTION && normalized.docsUrl) {
    await vscode.env.openExternal(vscode.Uri.parse(normalized.docsUrl));
    return;
  }

  if (selection !== COPY_REPORT_ACTION && selection !== DETAILS_ACTION) {
    // Toast dismissed — skip the (potentially expensive) report rendering entirely.
    return;
  }

  // Defer rendering until an action is selected. Building the report eagerly
  // adds extension-host overhead for every error and can throw on non-serializable
  // detail values, suppressing the original toast.
  let report: string;
  try {
    report = renderErrorReport(normalized, error);
  } catch (renderError) {
    options?.logger?.error('Failed to render error report.', { renderError });
    void vscode.window.showErrorMessage('Failed to generate FileMaker error report.');
    return;
  }

  if (selection === COPY_REPORT_ACTION) {
    await vscode.env.clipboard.writeText(report);
    void vscode.window.showInformationMessage('FileMaker error report copied to clipboard.');
    return;
  }

  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: report
  });

  await vscode.window.showTextDocument(document, { preview: false });
}

export const showCommandError = showErrorWithDetails;

export function toUserErrorMessage(error: unknown, fallbackMessage = 'Unexpected error.'): string {
  return normalizeError(error, { fallbackMessage }).message;
}

interface RenderErrorReportOptions {
  /** Override the generated-at timestamp. Useful for deterministic tests. */
  generatedAt?: Date;
}

/**
 * Renders a NormalizedError + raw error into a redacted, human-readable
 * markdown report suitable for both the Details document and the
 * "Copy as Bug Report" clipboard action.
 *
 * All free-form string fields (message, endpoint, requestId, docsUrl,
 * request-chain URLs/notes) are passed through `redactString` so secrets
 * embedded in messages or query params are masked before they reach the
 * clipboard.
 *
 * Exported for testing.
 */
export function renderErrorReport(
  normalized: NormalizedError,
  raw?: unknown,
  options: RenderErrorReportOptions = {}
): string {
  const lines: string[] = [];
  lines.push('# FileMaker Data API — Error Report');
  lines.push('');
  lines.push(`- **Message:** ${redactString(normalized.message)}`);
  lines.push(`- **Kind:** ${normalized.kind}`);
  if (normalized.status !== undefined) {
    lines.push(`- **HTTP status:** ${normalized.status}`);
  }
  if (normalized.code) {
    lines.push(`- **Code:** ${normalized.code}`);
  }
  if (normalized.networkCode) {
    lines.push(`- **Network code:** ${normalized.networkCode}`);
  }
  if (normalized.endpoint) {
    lines.push(`- **Endpoint:** ${redactString(normalized.endpoint)}`);
  }
  if (normalized.requestId) {
    lines.push(`- **Request id:** ${redactString(normalized.requestId)}`);
  }
  if (normalized.docsUrl) {
    lines.push(`- **Troubleshooting:** ${redactString(normalized.docsUrl)}`);
  }
  lines.push(`- **Retryable:** ${normalized.isRetryable}`);
  if (typeof normalized.retryCount === 'number') {
    lines.push(`- **Retry count:** ${normalized.retryCount}`);
  }
  if (typeof normalized.finalAttemptIndex === 'number') {
    lines.push(`- **Final attempt index:** ${normalized.finalAttemptIndex}`);
  }
  lines.push('');

  if (normalized.requestChain && normalized.requestChain.length > 0) {
    lines.push('## Request chain');
    lines.push('');
    lines.push('| # | Method | URL | Status | Elapsed | When | Note |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const entry of normalized.requestChain) {
      lines.push(formatChainRow(entry));
    }
    lines.push('');
  }

  if (normalized.safeHeaders && Object.keys(normalized.safeHeaders).length > 0) {
    lines.push('## Response headers (redacted)');
    lines.push('');
    lines.push('```');
    for (const [key, value] of Object.entries(normalized.safeHeaders)) {
      lines.push(`${key}: ${value}`);
    }
    lines.push('```');
    lines.push('');
  }

  if (normalized.details !== undefined) {
    lines.push('## Details (redacted)');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(redactValue(normalized.details), null, 2));
    lines.push('```');
    lines.push('');
  }

  const stack = normalized.stackTrace ?? extractStack(raw);
  if (stack) {
    lines.push('## Stack trace (redacted)');
    lines.push('');
    lines.push('```');
    lines.push(redactString(stack));
    lines.push('```');
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  const generatedAt = options.generatedAt ?? new Date();
  lines.push(`_Generated at ${generatedAt.toISOString()}_`);
  return lines.join('\n');
}

function escapeMarkdownTableCell(value: string): string {
  // Escape backslashes first so \\ stays \\ and stand-alone | becomes \|.
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function redactAndEscapeCell(value: string | undefined): string {
  if (!value) return '';
  // Redact first (so the redacted form passes through escape), then escape table-breaking chars.
  return escapeMarkdownTableCell(redactString(value));
}

function formatChainRow(entry: RequestChainEntry): string {
  const cells = [
    String(entry.attempt),
    redactAndEscapeCell(entry.method),
    redactAndEscapeCell(entry.url),
    entry.status !== undefined ? String(entry.status) : '',
    entry.elapsedMs !== undefined ? `${entry.elapsedMs}ms` : '',
    redactAndEscapeCell(entry.at),
    redactAndEscapeCell(entry.note)
  ];
  return `| ${cells.join(' | ')} |`;
}

function extractStack(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = (raw as { stack?: unknown }).stack;
  if (typeof candidate === 'string' && candidate.length > 0) {
    return candidate;
  }
  return undefined;
}
