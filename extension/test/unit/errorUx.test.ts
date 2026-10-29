import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';

import { FMClientError } from '../../src/services/errors';
import { normalizeError } from '../../src/utils/normalizeError';
import { showErrorWithDetails, toUserErrorMessage } from '../../src/utils/errorUx';

describe('showErrorWithDetails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows error message with the normalized error message', async () => {
    await showErrorWithDetails(new Error('Something broke'));

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Something broke',
      'Details…',
      'Copy as Bug Report'
    );
  });

  it.each([
    { label: 'plain error with Bearer and Basic tokens',
      error: new Error('Request failed: Bearer bearer-secret and Basic YmFzaWMtc2VjcmV0'),
      expected: 'Request failed: Bearer *** and Basic ***', secrets: ['bearer-secret', 'YmFzaWMtc2VjcmV0'] },
    { label: 'URL credentials and query tokens',
      error: new Error('Request failed: https://toast-user:toast-password@example.invalid/data?access_token=query-secret&api_key=key-secret'),
      expected: 'Request failed: https://***@example.invalid/data?access_token=***&api_key=***',
      secrets: ['toast-user', 'toast-password', 'query-secret', 'key-secret'] },
    { label: 'FileMaker session token path',
      error: new Error('DELETE https://example.invalid/fmi/data/vLatest/databases/Contacts/sessions/session-secret failed'),
      expected: 'DELETE https://example.invalid/fmi/data/vLatest/databases/Contacts/sessions/*** failed', secrets: ['session-secret'] },
    { label: 'axios error with an Authorization header',
      error: Object.assign(new Error('Request failed: Authorization: Bearer header-secret'), {
        isAxiosError: true, config: { headers: { Authorization: 'Bearer header-secret' } }
      }), expected: 'Request failed: Authorization: Bearer ***', secrets: ['header-secret'] },
    { label: 'already normalized error',
      error: { kind: 'unknown', message: 'Request failed: Bearer normalized-secret', isRetryable: false },
      expected: 'Request failed: Bearer ***', secrets: ['normalized-secret'] },
    { label: 'client error', error: new FMClientError('Request failed: Basic Y2xpZW50LXNlY3JldA=='),
      expected: 'Request failed: Basic ***', secrets: ['Y2xpZW50LXNlY3JldA=='] },
    { label: 'plain FileMaker message', error: new FMClientError('FileMaker API error [101]: Record is missing'),
      expected: 'FileMaker API error [101]: Record is missing', secrets: [] },
    { label: 'FileMaker response', error: {
      isAxiosError: true, message: 'Request failed', response: {
        status: 500, data: { messages: [{ code: '9999', message: 'A plain FileMaker message.' }] }
      }
    }, expected: 'FileMaker API error (HTTP 500) [9999]: A plain FileMaker message.', secrets: [] }
  ])('redacts $label on all normalized message surfaces', async ({ error, expected, secrets }) => {
    vi.mocked(vscode.window.showErrorMessage).mockResolvedValue(undefined);
    await showErrorWithDetails(error);
    const toast = vi.mocked(vscode.window.showErrorMessage).mock.calls[0]![0];
    expect(toast).toBe(expected);
    expect(normalizeError(error).message).toBe(expected);
    expect(toUserErrorMessage(error, '')).toBe(expected);
    for (const secret of secrets) expect(toast).not.toContain(secret);
  });

  it('uses fallback message when error is not an Error', async () => {
    await showErrorWithDetails('string error', {
      fallbackMessage: 'Fallback msg'
    });

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.any(String),
      'Details…',
      'Copy as Bug Report'
    );
  });

  it('calls logger when provided', async () => {
    const logger = { error: vi.fn() };

    await showErrorWithDetails(new Error('fail'), {
      logger,
      logMessage: 'Custom log'
    });

    expect(logger.error).toHaveBeenCalledWith('Custom log', expect.any(Object));
  });

  it('opens markdown document when Details action is selected', async () => {
    vi.mocked(vscode.window.showErrorMessage).mockResolvedValue('Details…' as never);

    await showErrorWithDetails(new Error('fail'));

    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        language: 'markdown',
        content: expect.any(String)
      })
    );
    expect(vscode.window.showTextDocument).toHaveBeenCalled();
  });

  it('does not open document when Details is not selected', async () => {
    vi.mocked(vscode.window.showErrorMessage).mockResolvedValue(undefined as never);

    await showErrorWithDetails(new Error('fail'));

    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('copies report to clipboard when Copy as Bug Report is selected', async () => {
    vi.mocked(vscode.window.showErrorMessage).mockResolvedValue('Copy as Bug Report' as never);

    await showErrorWithDetails(new Error('boom'));

    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('# FileMaker Data API — Error Report')
    );
    // No document is opened on the copy path.
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('does not render the report when toast is dismissed (deferred rendering)', async () => {
    vi.mocked(vscode.window.showErrorMessage).mockResolvedValue(undefined as never);

    // Pass a non-serializable value via a getter that throws — would crash if rendered eagerly.
    const evil = new Error('toxic');
    Object.defineProperty(evil, 'stack', {
      get() {
        throw new Error('do not access');
      }
    });

    await expect(showErrorWithDetails(evil)).resolves.toBeUndefined();
    // Clipboard and document remain untouched because we only render on action.
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('signs in again when Reconnect is selected', async () => {
    vi.mocked(vscode.window.showErrorMessage).mockResolvedValue('Reconnect' as never);

    await showErrorWithDetails(
      { kind: 'auth', message: 'Unauthorized', status: 401, isRetryable: false },
      { actions: { profileId: 'p1' } }
    );

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'filemakerDataApiTools.connect',
      { profileId: 'p1' }
    );
  });

  it('opens the troubleshooting page when Open Troubleshooting is selected', async () => {
    vi.mocked(vscode.window.showErrorMessage).mockResolvedValue('Open Troubleshooting' as never);

    const docsUrl =
      'https://github.com/SureForgeTech/filemaker-data-api-for-vs-code/blob/main/extension/docs/TROUBLESHOOTING.md#http-403-the-request-was-refused';
    await showErrorWithDetails({
      kind: 'auth',
      message: 'The server refused the request.',
      status: 403,
      isRetryable: false,
      docsUrl
    });

    expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(vscode.env.openExternal).mock.calls[0]![0])).toBe(docsUrl);
    // The link opens the page; it does not render a report.
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });
});

describe('toUserErrorMessage', () => {
  it('extracts message from Error', () => {
    expect(toUserErrorMessage(new Error('oops'))).toBe('oops');
  });

  it('uses fallback for non-Error', () => {
    expect(toUserErrorMessage(null, 'fallback')).toBe('fallback');
  });

  it('uses default fallback', () => {
    expect(toUserErrorMessage(undefined)).toBe('Unexpected error.');
  });
});
