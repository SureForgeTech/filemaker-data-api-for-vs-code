import { describe, expect, it } from 'vitest';

import { selectErrorActions } from '../../../src/utils/errorUx';

describe('selectErrorActions', () => {
  it('returns nothing when no actions provided', () => {
    expect(selectErrorActions({ kind: 'unknown' }, undefined)).toEqual([]);
    expect(selectErrorActions({ kind: 'auth' }, {})).toEqual([]);
  });

  it('offers Retry for transient errors when a retry callback is provided', () => {
    const retry = async () => {};
    expect(selectErrorActions({ kind: 'timeout', isRetryable: true }, { retry })).toContain('Retry');
    expect(selectErrorActions({ kind: 'network', isRetryable: true }, { retry })).toContain('Retry');
    expect(selectErrorActions({ kind: 'server', status: 503 }, { retry })).toContain('Retry');
  });

  it('does not offer Retry for non-transient errors', () => {
    const retry = async () => {};
    expect(selectErrorActions({ kind: 'auth', status: 401 }, { retry })).not.toContain('Retry');
    expect(selectErrorActions({ kind: 'validation' }, { retry })).not.toContain('Retry');
  });

  it('offers Edit Profile on auth errors when profileId is provided', () => {
    expect(
      selectErrorActions({ kind: 'auth', status: 401 }, { profileId: 'p1' })
    ).toContain('Edit Profile');
    expect(
      selectErrorActions({ kind: 'validation', fmCategory: 'credentials' }, { profileId: 'p1' })
    ).toContain('Edit Profile');
  });

  it('does not send a privilege problem to Edit Profile: the administrator fixes it, not the profile', () => {
    for (const error of [
      { kind: 'auth', status: 403 },
      { kind: 'server', status: 403 },
      { kind: 'server', status: 500, fmCategory: 'privilege' }
    ]) {
      expect(selectErrorActions(error, { profileId: 'p1' })).not.toContain('Edit Profile');
    }
  });

  it('offers Retry only where a retry can help, never for certificate problems', () => {
    const retry = () => undefined;
    expect(selectErrorActions({ kind: 'certificate', isRetryable: false, networkCode: 'CERT_HAS_EXPIRED' }, { retry })).toEqual([]);
    expect(selectErrorActions({ kind: 'server', status: 500, isRetryable: false, fmCategory: 'config' }, { retry })).toEqual([]);
    expect(selectErrorActions({ kind: 'network', isRetryable: true }, { retry })).toEqual(['Retry']);
  });

  it('offers to trust a certificate, or to re-trust a changed one, for certificate errors', () => {
    const trustCertificate = () => undefined;
    expect(selectErrorActions({ kind: 'certificate', networkCode: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, { trustCertificate })).toEqual(['Trust this certificate…']);
    expect(selectErrorActions({ kind: 'certificate', networkCode: 'FM_CERT_PIN_MISMATCH' }, { trustCertificate })).toEqual(['Review and re-trust']);
    expect(selectErrorActions({ kind: 'network', networkCode: 'ECONNREFUSED' }, { trustCertificate })).toEqual([]);
  });

  it('does not offer Edit Profile on non-auth errors', () => {
    expect(
      selectErrorActions({ kind: 'timeout' }, { profileId: 'p1' })
    ).not.toContain('Edit Profile');
  });

  it('offers Open Settings on timeout errors when a settingsKey is provided', () => {
    expect(
      selectErrorActions(
        { kind: 'timeout', isRetryable: true },
        { settingsKey: 'filemaker.requestTimeoutMs' }
      )
    ).toContain('Open Settings');
  });

  it('does not offer Open Settings on non-timeout errors', () => {
    expect(
      selectErrorActions({ kind: 'auth' }, { settingsKey: 'filemaker.requestTimeoutMs' })
    ).not.toContain('Open Settings');
  });

  it('combines Retry + Open Settings on a timeout that is also retryable', () => {
    const retry = async () => {};
    const actions = selectErrorActions(
      { kind: 'timeout', isRetryable: true },
      { retry, settingsKey: 'filemaker.requestTimeoutMs' }
    );
    expect(actions).toEqual(['Retry', 'Open Settings']);
  });

  it('combines Retry + Edit Profile on a 401 marked retryable', () => {
    const retry = async () => {};
    const actions = selectErrorActions(
      { kind: 'auth', status: 401, isRetryable: true },
      { retry, profileId: 'p1' }
    );
    expect(actions).toEqual(['Retry', 'Reconnect', 'Edit Profile']);
  });

  it('offers Reconnect on auth errors when profileId is provided', () => {
    expect(
      selectErrorActions({ kind: 'auth', status: 401 }, { profileId: 'p1' })
    ).toContain('Reconnect');
    expect(
      selectErrorActions({ kind: 'validation', fmCategory: 'credentials' }, { profileId: 'p1' })
    ).toContain('Reconnect');
  });

  it('does not offer Reconnect for a privilege problem or without a profile', () => {
    expect(
      selectErrorActions({ kind: 'auth', status: 403 }, { profileId: 'p1' })
    ).not.toContain('Reconnect');
    expect(
      selectErrorActions({ kind: 'auth', status: 401 }, {})
    ).not.toContain('Reconnect');
  });

  it('offers Open Troubleshooting only when the error carries a troubleshooting link', () => {
    const docsUrl = 'https://example.invalid/TROUBLESHOOTING.md#a-section';
    expect(selectErrorActions({ kind: 'unknown', docsUrl }, {})).toContain('Open Troubleshooting');
    expect(selectErrorActions({ kind: 'unknown' }, {})).not.toContain('Open Troubleshooting');
    expect(selectErrorActions({ kind: 'unknown', docsUrl }, undefined)).toEqual([
      'Open Troubleshooting'
    ]);
  });

  it('puts the troubleshooting button last, after the other buttons', () => {
    const actions = selectErrorActions(
      { kind: 'auth', status: 401, docsUrl: 'https://example.invalid/TROUBLESHOOTING.md#a-section' },
      { profileId: 'p1' }
    );
    expect(actions).toEqual(['Reconnect', 'Edit Profile', 'Open Troubleshooting']);
  });
});
