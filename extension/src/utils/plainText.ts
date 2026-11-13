/** Longest part of a server-controlled body that is looked at at all. */
const MAX_INPUT_CHARS = 4096;

/**
 * Plain text from the start of a server-controlled body (a gateway's HTML error page, say): at most
 * `maxChars` characters, tags removed, whitespace collapsed.
 *
 * The body is cut to a few kilobytes BEFORE any work is done, and tags are removed in one pass
 * with no backtracking, so a hostile megabyte of `<` costs the same as any other megabyte: nothing.
 * (A regular expression such as /<[^>]*>/g is quadratic on a body full of `<` with no `>`.)
 */
export function plainTextPreview(body: string, maxChars: number): string {
  const text = body.length > MAX_INPUT_CHARS ? body.slice(0, MAX_INPUT_CHARS) : body;
  let out = '';
  let index = 0;
  while (index < text.length && out.length <= maxChars * 2) {
    const open = text.indexOf('<', index);
    if (open === -1) {
      out += text.slice(index);
      break;
    }
    out += text.slice(index, open);
    const close = text.indexOf('>', open + 1);
    if (close === -1) {
      break; // an unterminated tag: drop the rest
    }
    const name = text.slice(open + 1, Math.min(close, open + 12)).trim().toLowerCase();
    index = close + 1;
    if (name.startsWith('script') || name.startsWith('style')) {
      const end = text.indexOf(name.startsWith('script') ? '</script' : '</style', index);
      if (end === -1) {
        break;
      }
      const endClose = text.indexOf('>', end);
      index = endClose === -1 ? text.length : endClose + 1;
    }
    out += ' ';
  }
  const collapsed = out.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars)}…` : collapsed;
}

/** A bounded, single-line error message; names used in requests are never passed here. */
export function errorMessageText(value: string): string {
  const text = value.slice(0, 4096).replace(/[\s\p{C}]+/gu, ' ');
  return text.length > 1024 || value.length > 4096 ? `${text.slice(0, 1024)}…` : text;
}
