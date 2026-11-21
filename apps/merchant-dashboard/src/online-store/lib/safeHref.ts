// Client mirror of the server's SafeHref rules (contract §8). The API is authoritative; these give instant
// feedback and keep anything unsafe out of drafts. Every check runs on the raw and the percent-decoded value.

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const WHITESPACE = /\s/;

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function bothForms(value: string, test: (v: string) => boolean): boolean {
  return test(value) && test(decoded(value));
}

function isRelative(v: string): boolean {
  return v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') && !CONTROL.test(v) && !WHITESPACE.test(v);
}

function isAbsolute(v: string, schemes: string[]): boolean {
  if (CONTROL.test(v) || WHITESPACE.test(v) || v.includes('\\')) return false;
  if (!schemes.some((s) => v.toLowerCase().startsWith(`${s}://`))) return false;
  try {
    const url = new URL(v);
    return schemes.includes(url.protocol.slice(0, -1)) && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Theme `href` (§4.3): relative `/…` (not `//`, no `\`) or `https://` with a host and no credentials. */
export function isSafeThemeHref(value: string): boolean {
  if (!value || value.length > 2048) return false;
  return bothForms(value, (v) => isRelative(v) || isAbsolute(v, ['https']));
}

/** Navigation `url` links (§3.3): http or https only, with a host, no credentials, no whitespace. */
export function isSafeNavUrl(value: string): boolean {
  if (!value || value.length > 2048) return false;
  return bothForms(value, (v) => isAbsolute(v, ['http', 'https']));
}

const MAILTO = /^mailto:[^\s@?/\\:]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const TEL = /^tel:\+?[0-9]{7,15}$/;

/** Rich-text link marks (§4.4): relative, https, http, strict mailto (no `?`), tel. */
export function isSafeRichTextHref(value: string): boolean {
  if (!value || value.length > 2048) return false;
  return bothForms(value, (v) => isRelative(v) || isAbsolute(v, ['http', 'https']) || MAILTO.test(v) || TEL.test(v));
}

/** Page `button` block (§4.5): theme rule, `https://wa.me/<digits>` (already https) or `tel:`. */
export function isSafeButtonHref(value: string): boolean {
  if (!value || value.length > 2048) return false;
  return bothForms(value, (v) => isRelative(v) || isAbsolute(v, ['https']) || TEL.test(v));
}

/** Collection handle / page slug (§3.2/§3.3). */
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** ASCII slug from a title (Bangla-only titles → empty; the API then generates `page-xxxxxx`). */
export function slugify(input: string, max = 80): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

export const RESERVED_SLUGS = new Set([
  'new', 'edit', 'index', 'home', 'api', 'admin', 'search', 'cart', 'checkout', 'account', 'accounts', 'login', 'logout',
  'register', 'collections', 'products', 'orders', 'track', 'track-order', 'sitemap', 'robots', 'preview', 'pages', 'static',
  'assets', 'themes', '_next',
]);
