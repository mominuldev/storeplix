// PHASE-8-9C P89C-5: link and anchor rules shared by HelpArticleBody and its hosts.

// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000- \u007f\\]/;

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** `/path` within the app: not protocol-relative, no backslashes, whitespace or control characters (raw + decoded). */
export function isInternalHelpHref(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 2048) return false;
  return [value, decoded(value)].every((v) => v.startsWith('/') && !v.startsWith('//') && !UNSAFE_CHARS.test(v));
}

/** Absolute `http:` / `https:` URL with a host and no credentials (raw + decoded). */
export function isExternalHelpHref(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 2048) return false;
  return [value, decoded(value)].every((v) => {
    if (UNSAFE_CHARS.test(v) || !/^https?:\/\//i.test(v)) return false;
    try {
      const url = new URL(v);
      return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname && !url.username && !url.password;
    } catch {
      return false;
    }
  });
}

export const isHttpUrl = (v: unknown): v is string => typeof v === 'string' && isExternalHelpHref(v);

/** `{index}-{kebab text}` fallback when no server TOC is given (1-based heading index). */
export function helpHeadingAnchor(index: number, text: string): string {
  const kebab = text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return `${index}-${kebab}`;
}

