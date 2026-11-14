import { describe, expect, it } from 'vitest';

import {
  isLoopbackUrl,
  isUnencryptedRemoteUrl,
  parseFindJson,
  parseOptionalPositiveInteger,
  parseSortJson,
  validateDatabaseName,
  validateObjectArray,
  validateServerUrl
} from '../../src/utils/jsonValidate';

describe('jsonValidate', () => {
  it('parses valid find/sort arrays', () => {
    const find = parseFindJson('[{"Name":"Ada"}]');
    const sort = parseSortJson('[{"fieldName":"Name","sortOrder":"ascend"}]');

    expect(find.ok).toBe(true);
    expect(sort.ok).toBe(true);
    expect(find.value).toEqual([{ Name: 'Ada' }]);
  });

  it('rejects invalid JSON and non-array payloads', () => {
    const invalidJson = parseFindJson('{');
    const invalidType = validateObjectArray({ Name: 'Ada' }, 'Find JSON');
    const invalidItems = validateObjectArray([1, 2], 'Find JSON');

    expect(invalidJson.ok).toBe(false);
    expect(invalidType.ok).toBe(false);
    expect(invalidItems.ok).toBe(false);
  });

  it('parses optional positive integers', () => {
    expect(parseOptionalPositiveInteger(undefined, 'Limit')).toBeUndefined();
    expect(parseOptionalPositiveInteger('', 'Limit')).toBeUndefined();
    expect(parseOptionalPositiveInteger('10', 'Limit')).toBe(10);
    expect(() => parseOptionalPositiveInteger('-1', 'Limit')).toThrow();
  });
});

describe('validateDatabaseName', () => {
  it.each(['', ' ', '   ', '\t \r\n'])('rejects a blank database name %j', (name) => {
    expect(validateDatabaseName(name)).toEqual({ ok: false, error: 'Database name is required.' });
  });

  it('trims surrounding whitespace and preserves spaces within a database name', () => {
    expect(validateDatabaseName(' Sales Archive ')).toEqual({ ok: true, value: 'Sales Archive' });
  });

  it.each(['\u0000', '\u0001', '\t', '\n', '\r', '\u001f'])('rejects an embedded control character %j', (control) => {
    expect(validateDatabaseName(`Sales${control}Archive`)).toEqual({
      ok: false,
      error: 'Database name contains invalid control characters.'
    });
  });
});

describe('validateServerUrl', () => {
  it('accepts http and https addresses and trims trailing slashes', () => {
    expect(validateServerUrl('https://fm.example.com/')).toEqual({ ok: true, value: 'https://fm.example.com' });
    expect(validateServerUrl('http://127.0.0.1:18080').ok).toBe(true);
  });

  it('rejects a username or password in the address', () => {
    const result = validateServerUrl('https://admin:Hunter2@fm.example.com');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/must not contain a username or password/);
    expect(validateServerUrl('https://admin@fm.example.com').ok).toBe(false);
  });

  it.each(['?tenant=other', '#other', '?tenant=other#other'])('rejects query strings and fragments: %s', (suffix) => {
    for (const label of ['Server URL', 'Proxy endpoint']) {
      expect(validateServerUrl(`https://fm.example.com/tenant${suffix}`, label)).toEqual({
        ok: false,
        error: `${label} must not contain a query string or fragment.`
      });
    }
  });

  it('uses the given label in messages', () => {
    expect(validateServerUrl('', 'Proxy endpoint').error).toBe('Proxy endpoint is required.');
    expect(validateServerUrl('ftp://x', 'Proxy endpoint').error).toMatch(/^Proxy endpoint must start with/);
  });

  it('tells loopback from remote cleartext addresses', () => {
    expect(isLoopbackUrl('http://localhost:8080')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:9')).toBe(true);
    expect(isLoopbackUrl('http://localhost.evil.com')).toBe(false);
    expect(isUnencryptedRemoteUrl('http://fm.example.com')).toBe(true);
    expect(isUnencryptedRemoteUrl('https://fm.example.com')).toBe(false);
    expect(isUnencryptedRemoteUrl('http://127.0.0.1:18080')).toBe(false);
  });
});

it.each(['Limit', 'Offset'])('rejects zero %s before calling FileMaker', (label) => {
  expect(() => parseOptionalPositiveInteger('0', label)).toThrow(`${label} must be an integer and must be at least 1.`);
  expect(parseOptionalPositiveInteger('1', label)).toBe(1);
});
