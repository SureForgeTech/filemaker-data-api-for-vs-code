import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { rootCertificates } from 'tls';
import { describe, expect, it } from 'vitest';

import { FMClientError } from '../../src/services/errors';
import { checkPinnedCertificate, createHttpsAgentForProfile } from '../../src/services/tlsAgent';
import { DAY, makeCertificate, newKeyPair } from '../helpers/x509';

const realPem = (cn: string): string =>
  makeCertificate({ subjectCn: cn, notBefore: new Date(Date.now() - DAY), notAfter: new Date(Date.now() + DAY), subjectKey: newKeyPair() }).pem;

describe('createHttpsAgentForProfile', () => {
  it('disables certificate verification when allowSelfSigned is true', () => {
    const agent = createHttpsAgentForProfile({ allowSelfSigned: true });

    expect(agent.options.rejectUnauthorized).toBe(false);
  });

  it('loads a PEM CA bundle when caBundlePath is set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-ca-'));
    const caPath = join(root, 'ca.pem');
    const pem = realPem('test');
    await writeFile(caPath, pem, 'utf8');

    const agent = createHttpsAgentForProfile({ caBundlePath: caPath });

    expect(agent.options.rejectUnauthorized).toBe(true);
    // The file's certificates are added to the default public roots, not substituted for them.
    const ca = agent.options.ca as string[];
    expect(ca[ca.length - 1]).toBe(pem);
    expect(ca.length).toBeGreaterThan(50);
    expect(ca).toEqual(expect.arrayContaining([...rootCertificates.slice(0, 3)]));
  });

  it('notices an edited CA file instead of reusing the agent cached for its path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-ca-'));
    const caPath = join(root, 'ca.pem');
    await writeFile(caPath, realPem('one'), 'utf8');
    const first = createHttpsAgentForProfile({ caBundlePath: caPath });
    expect(createHttpsAgentForProfile({ caBundlePath: caPath })).toBe(first);

    const longer = `${realPem('two-is-longer')}${realPem('and-another')}`;
    await writeFile(caPath, longer, 'utf8');
    const second = createHttpsAgentForProfile({ caBundlePath: caPath });
    expect(second).not.toBe(first);
    expect((second.options.ca as string[]).at(-1)).toBe(longer);
  });

  it('loads a CA bundle while disabling verification when both TLS overrides are set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-ca-'));
    const caPath = join(root, 'combined-ca.pem');
    const pem = realPem('combined');
    await writeFile(caPath, pem, 'utf8');

    const agent = createHttpsAgentForProfile({ allowSelfSigned: true, caBundlePath: caPath });

    expect(agent.options.rejectUnauthorized).toBe(false);
    expect((agent.options.ca as string[]).at(-1)).toBe(pem);
  });

  it.each(['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'ENCRYPTED PRIVATE KEY'])('refuses a CA bundle containing a %s at read time', async (block) => {
    const root = await mkdtemp(join(tmpdir(), 'fm-ca-'));
    try {
      const caPath = join(root, 'ca.pem');
      await writeFile(caPath, realPem('before-edit'));
      const first = createHttpsAgentForProfile({ caBundlePath: caPath });
      await writeFile(caPath, `${realPem('after-edit')}-----BEGIN ${block}-----\nfixture\n-----END ${block}-----\n`);

      expect(() => createHttpsAgentForProfile({ caBundlePath: caPath })).toThrow(/contains a private key/);
      expect(first.options.rejectUnauthorized).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a CA bundle larger than 1 MB at read time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-ca-'));
    try {
      const caPath = join(root, 'large.pem');
      await writeFile(caPath, realPem('large') + ' '.repeat(1024 * 1024));
      expect(() => createHttpsAgentForProfile({ caBundlePath: caPath })).toThrow(/larger than 1 MB/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts a CA bundle exactly 1 MB in size', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-ca-'));
    try {
      const caPath = join(root, 'limit.pem');
      const pem = realPem('limit');
      await writeFile(caPath, pem + ' '.repeat(1024 * 1024 - Buffer.byteLength(pem)));
      expect(createHttpsAgentForProfile({ caBundlePath: caPath }).options.rejectUnauthorized).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the PEM file is missing', () => {
    let caught: FMClientError | undefined;

    try {
      createHttpsAgentForProfile({ caBundlePath: '/definitely/missing/ca.pem' });
    } catch (error) {
      caught = error as FMClientError;
    }

    expect(caught).toBeInstanceOf(FMClientError);
    expect(caught?.code).toBe('TLS_CA_BUNDLE_READ_FAILED');
  });

  it('uses secure verification by default', () => {
    const agent = createHttpsAgentForProfile({});

    expect(agent.options.rejectUnauthorized).toBe(true);
    expect(agent.options.ca).toBeUndefined();
  });

  it('says a CA file without a certificate is not a certificate file (instead of a misleading verify error)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fm-ca-'));
    const notPem = join(root, 'notes.pem');
    await writeFile(notPem, 'this is not a certificate', 'utf8');
    const broken = join(root, 'broken.pem');
    await writeFile(broken, '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n', 'utf8');

    for (const file of [notPem, broken]) {
      let caught: FMClientError | undefined;
      try {
        createHttpsAgentForProfile({ caBundlePath: file });
      } catch (error) {
        caught = error as FMClientError;
      }
      expect(caught?.code).toBe('TLS_CA_BUNDLE_INVALID');
      expect(caught?.message).toMatch(/does not contain a certificate/);
    }
  });

  it('adds the operating system\'s certificates to the defaults only when the policy says so and Node can read them', async () => {
    const { setSystemCertificatePolicy } = await import('../../src/services/tlsAgent');
    const canRead = typeof (await import('tls')).getCACertificates === 'function';
    try {
      setSystemCertificatePolicy(() => false);
      expect(createHttpsAgentForProfile({}).options.ca).toBeUndefined();

      setSystemCertificatePolicy(() => true);
      const agent = createHttpsAgentForProfile({});
      if (canRead) {
        expect((agent.options.ca as string[]).length).toBeGreaterThanOrEqual(rootCertificates.length);
        expect(agent.options.rejectUnauthorized).toBe(true);
      } else {
        expect(agent.options.ca).toBeUndefined(); // older Node: defaults unchanged
      }
    } finally {
      setSystemCertificatePolicy(() => false);
    }
  });
});

describe('checkPinnedCertificate validity dates', () => {
  const sha256 = 'ab'.repeat(32);
  const now = Date.parse('2026-11-13T12:00:00Z');
  const valid = { fingerprint256: sha256, valid_from: '2026-11-12T12:00:00Z', valid_to: '2026-11-14T12:00:00Z' };

  it.each([
    { valid_from: undefined }, { valid_from: '' }, { valid_from: 'invalid' },
    { valid_to: undefined }, { valid_to: '' }, { valid_to: 'invalid' }
  ])('fails closed for missing or unparseable validity dates: %j', (dates) => {
    const presented = { ...valid, ...dates };
    expect(checkPinnedCertificate(presented, { sha256, allowExpired: false }, now)).toMatchObject({ code: 'FM_CERT_PIN_EXPIRED' });
    expect(checkPinnedCertificate(presented, { sha256, allowExpired: true }, now)).toBeUndefined();
  });

  it('keeps valid dates, expiry, future validity and fingerprint checks', () => {
    expect(checkPinnedCertificate(valid, { sha256, allowExpired: false }, now)).toBeUndefined();
    expect(checkPinnedCertificate(valid, { sha256, allowExpired: false }, now + 2 * DAY)).toMatchObject({ code: 'FM_CERT_PIN_EXPIRED' });
    expect(checkPinnedCertificate(valid, { sha256, allowExpired: false }, now - 2 * DAY)).toMatchObject({ code: 'CERT_NOT_YET_VALID' });
    expect(checkPinnedCertificate({ ...valid, fingerprint256: 'cd'.repeat(32) }, { sha256, allowExpired: true }, now)).toMatchObject({ code: 'FM_CERT_PIN_MISMATCH' });
  });
});
