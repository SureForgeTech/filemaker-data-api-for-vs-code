import { describe, expect, it } from 'vitest';

import { redactHeaders, redactString, redactValue } from '../../src/utils/redact';

describe('redact', () => {
  it('redacts bearer/basic tokens in strings', () => {
    const value = redactString('Authorization: Bearer abc123 Basic qwerty');
    expect(value).toContain('Bearer ***');
    expect(value).toContain('Basic ***');
    expect(value).not.toContain('abc123');
  });

  it('redacts known secret keys in objects', () => {
    const value = redactValue({
      password: 'p@ss',
      nested: {
        token: 'abc',
        ok: 'value'
      }
    }) as Record<string, unknown>;

    expect(value.password).toBe('***');
    const nested = value.nested as Record<string, unknown>;
    expect(nested.token).toBe('***');
    expect(nested.ok).toBe('value');
  });

  it('redacts authorization headers', () => {
    const headers = redactHeaders({
      Authorization: 'Bearer abc',
      'X-Test': 'ok'
    });

    expect(headers?.Authorization).toBe('***');
    expect(headers?.['X-Test']).toBe('ok');
  });
});

describe('redact: places a secret used to slip through', () => {
  it('redacts the session token in a DELETE /sessions/<token> path', () => {
    expect(redactString('DELETE /sessions/abcDEF123-token')).toBe('DELETE /sessions/***');
    expect(redactString('DELETE /sessions/{token}')).toBe('DELETE /sessions/{token}');
    expect(redactString('POST /sessions')).toBe('POST /sessions');
  });

  it('redacts access tokens and similar query parameters', () => {
    const text = redactString('GET /x?access_token=abc&page=2&sessionToken=def&api_key=ghi&signature=jkl');
    expect(text).toBe('GET /x?access_token=***&page=2&sessionToken=***&api_key=***&signature=***');
  });

  it('redacts secret JSON keys whatever their prefix or suffix', () => {
    const json = JSON.stringify({ sessionToken: 'tok1', access_token: 'tok2', proxyApiKey: 'k', clientSecret: 's', name: 'ok' });
    const text = redactString(json);
    expect(text).not.toMatch(/tok1|tok2|"k"|"s"/);
    expect(text).toContain('"name":"ok"');
  });

  it('does not over-redact ordinary names', () => {
    expect(redactString('GET /x?design=1&author=2&assignee=3')).toBe('GET /x?design=1&author=2&assignee=3');
    expect(redactString('GET /layouts/sessions/records/1')).toBe('GET /layouts/sessions/records/1');
    expect(redactString('http://[::1]:8080?email=a@b.com')).toBe('http://[::1]:8080?email=a@b.com');
  });

  it('redacts a form body that starts with the secret, number values and cookies', () => {
    expect(redactString('password=S&user=bob')).toBe('password=***&user=bob');
    expect(redactString('{"password": 123456, "n": 1}')).toBe('{"password": "***", "n": 1}');
    expect(redactHeaders({ Cookie: 'a=b', 'X-Ok': '1' })).toEqual({ Cookie: '***', 'X-Ok': '1' });
  });

  it('redacts a token or a password containing @ in a URL', () => {
    expect(redactString('https://ghp_abc123@github.com/x')).toBe('https://***@github.com/x');
    expect(redactString('https://user:p@ss@host/x')).toBe('https://***@host/x');
  });

  it('stays fast on long hostile input', () => {
    for (const piece of ['&token', '?sig', '"token', '/sessions/', 'a=', 'a.', 'a-', 'a:', 'a://', 'a@']) {
      const input = piece.repeat(60_000);
      const start = Date.now();
      redactString(input);
      expect(Date.now() - start).toBeLessThan(500);
    }
  });

  it('redacts credentials embedded in a URL', () => {
    expect(redactString('failed https://user:p%40ss@fm.example.com/fmi/data')).toBe(
      'failed https://***@fm.example.com/fmi/data'
    );
    expect(redactString('https://fm.example.com/fmi')).toBe('https://fm.example.com/fmi');
  });

  it('redacts single-quoted keys as a printed object or dict shows them', () => {
    expect(redactString("{'sessionToken': 'abc', 'name': 'ok', 'password': 123456}")).toBe("{'sessionToken': '***', 'name': 'ok', 'password': '***'}");
    expect(redactString("{'api_key': 'it\\'s secret'}")).not.toMatch(/secret/);
  });

  it('redacts a Cookie, Set-Cookie or Authorization line printed as plain text', () => {
    expect(redactString('Cookie: a=b; session=xyz\nHost: fm.example.com')).toBe('Cookie: ***\nHost: fm.example.com');
    expect(redactString('Set-Cookie: sid=abc; Path=/; HttpOnly')).toBe('Set-Cookie: ***');
    expect(redactString('request headers\r\nAuthorization: Digest username=bob\r\nAccept: */*')).toBe('request headers\r\nAuthorization: ***\r\nAccept: */*');
    expect(redactString('Proxy-Authorization: Negotiate abcdef')).toBe('Proxy-Authorization: ***');
    // Already redacted text is left as it is, and ordinary prose is not touched.
    expect(redactString('Authorization: Bearer abc')).toBe('Authorization: Bearer ***');
    expect(redactString('the cookie jar is full')).toBe('the cookie jar is full');
  });

  it('single-quote and header-line patterns stay fast on long hostile input', () => {
    for (const piece of ["'token", "'a':", 'cookie', 'Cookie:', 'authorization :']) {
      const input = piece.repeat(60_000);
      const start = Date.now();
      redactString(input);
      expect(Date.now() - start).toBeLessThan(500);
    }
  });
});

it.each(['request failed: api_key=private-value', 'api_key=private-value&other=ok', 'X-FM-Data-Access-Token: private-value', 'response headers: x-fm-data-access-token: private-value'])('masks free text secrets in %s', (text) => {
  expect(redactString(text)).not.toContain('private-value');
  expect(redactString(text)).toContain('***');
  expect(redactString(redactString(text))).toBe(redactString(text));
});

it.each([
  ['https://example.test/#access_token=private-value&state=ok', 'https://example.test/#access_token=***&state=ok'],
  ['token: private-value\nname: visible', 'token: ***\nname: visible'],
  ['{token: "private-value", name: "visible"}', '{token: ***, name: "visible"}'],
  ["{ token: 'private-value' }", '{ token: *** }'],
  ['Authorization=Bearer%20private-value', 'Authorization=Bearer ***'],
  ['DELETE /sessions%2Fprivate-value', 'DELETE /sessions%2F***'],
  ['sessions%2fprivate-value', 'sessions%2f***'],
  ...['jwt', 'auth', 'key', 'fmsid'].map((key) => [`/x?${key}=private-value&page=2`, `/x?${key}=***&page=2`])
])('redacts additional secret form %s', (input, expected) => {
  expect(redactString(input!)).toBe(expected);
  expect(redactString(redactString(input!))).toBe(expected);
});

it.each(['token count: 2', '{ name: "visible" }', 'GET /x?author=A&monkey=B&jwtVersion=1', 'a key to the city', 'name: Ada\ncount: 2'])('preserves non-secret text %s', (input) => {
  expect(redactString(input)).toBe(input);
});


it('handles an empty encoded or whitespace authorization value without slow backtracking', () => {
  for (const separator of [' ', '%20']) {
    const input = `Authorization=Bearer${separator.repeat(100_000)}`;
    const start = Date.now();
    expect(redactString(input)).toBe(input);
    expect(Date.now() - start).toBeLessThan(500);
  }
});
