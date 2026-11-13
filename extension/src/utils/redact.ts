const SECRET_KEY_PATTERN = /(authorization|password|token|secret|api[-_]?key|session|cookie)/i;

const BEARER_OR_BASIC_PATTERN = /\b(Bearer|Basic)(?:\s|%20)+[A-Za-z0-9\-._~+/]+=*/gi;

// The key patterns bound how much text may sit around the keyword, so a long run of word
// characters cannot make the match quadratic (a hostile server can return such text).
const QUERY_PARAM_PATTERN =
  /((?:^|[?&#])(?:[\w.-]{0,40}?(?:token|password|passwd|api[_-]?key|session|secret|signature)[\w.-]{0,40}|jwt|auth|key|fmsid)=)([^&#\s]+)/gi;

/** API keys also appear as assignments in otherwise unstructured error text. */
const API_KEY_ASSIGNMENT_PATTERN = /\b(api[_-]?key[ \t]*=[ \t]*)([^&#\s]+)/gi;

/** A key in JSON text that names a secret: `sessionToken`, `access_token`, `proxyApiKey`, `clientSecret`... */
const JSON_PAIR_PATTERN =
  /("[\w.-]{0,64}?(?:authorization|password|passwd|token|secret|api[_-]?key|session)[\w.-]{0,64}"\s*:\s*)(?:"((?:[^"\\]|\\.)+)"|(\d+))/gi;

/** The same with single quotes, as a log of a JS object or Python dict prints it: `{'token': 'abc'}`. */
const SINGLE_QUOTED_PAIR_PATTERN =
  /('[\w.-]{0,64}?(?:authorization|password|passwd|token|secret|api[_-]?key|session)[\w.-]{0,64}'\s*:\s*)(?:'((?:[^'\\]|\\.)+)'|(\d+))/gi;

/** A header line printed as plain text: `Cookie: a=b`, `Set-Cookie: ...`, `Authorization: ...`. The whole value is secret. */
const HEADER_LINE_PATTERN = /\b((?:set-)?cookie|(?:proxy-)?authorization|x-fm-data-access-token)([ \t]*:[ \t]*)(?![ \t])(?!(?:(?:Bearer|Basic)[ \t]+)?\*\*\*(?:[ \t]+(?:(?:Bearer|Basic)[ \t]+)?\*\*\*)*[ \t]*(?:[\r\n]|$))[^\r\n]+/gi;

/** The FileMaker Data API puts the session token in the path: `DELETE /sessions/<token>`. A layout called "sessions" is left alone. */
const SESSION_PATH_PATTERN = /(?<!\/layouts)(\/sessions\/|\bsessions%2f)(?!\{token\})[^/\s?#"'`]+/gi;

/** `https://user:password@host` or `https://token@host` */
const URL_USERINFO_PATTERN = /(\b[a-z][a-z0-9+.-]{0,15}:\/\/)[^/\s?#]*@/gi;

/** YAML and unquoted inspect keys, with quoted or plain scalar values. */
const UNQUOTED_PAIR_PATTERN =
  /((?:^|[\s{,])[\w.-]{0,64}?(?:password|passwd|token|secret|api[_-]?key|session)[\w.-]{0,64}[ \t]*:[ \t]*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,}\]]+)/gi;

export function redactString(input: string): string {
  return input
    .replace(BEARER_OR_BASIC_PATTERN, '$1 ***')
    .replace(QUERY_PARAM_PATTERN, '$1***')
    .replace(API_KEY_ASSIGNMENT_PATTERN, '$1***')
    .replace(SESSION_PATH_PATTERN, '$1***')
    .replace(URL_USERINFO_PATTERN, '$1***@')
    .replace(JSON_PAIR_PATTERN, (_match, key: string) => `${key}"***"`)
    .replace(SINGLE_QUOTED_PAIR_PATTERN, (_match, key: string) => `${key}'***'`)
    .replace(HEADER_LINE_PATTERN, '$1$2***')
    .replace(UNQUOTED_PAIR_PATTERN, '$1***');
}

export function redactValue(value: unknown): unknown {
  return redactValueInternal(value, 0);
}

function redactValueInternal(value: unknown, depth: number): unknown {
  if (depth > 12) {
    return '[RedactedDepthLimit]';
  }

  if (typeof value === 'string') {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValueInternal(item, depth + 1));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

  for (const [key, item] of Object.entries(record)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      output[key] = '***';
      continue;
    }

    output[key] = redactValueInternal(item, depth + 1);
  }

  return output;
}

export function redactHeaders(headers: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  const next: Record<string, string> = {};

  for (const [name, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined || rawValue === null) {
      continue;
    }

    const value = Array.isArray(rawValue)
      ? rawValue.map((item) => String(item)).join(', ')
      : String(rawValue);

    next[name] = SECRET_KEY_PATTERN.test(name) ? '***' : redactString(value);
  }

  return next;
}
