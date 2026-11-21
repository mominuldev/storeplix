/**
 * Sanitizers for merchant-supplied theme values. Merchant data is rendered as data only:
 * never as raw HTML, CSS text or script. Anything not matching a strict allowlist is dropped.
 */

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// rgb()/rgba() with comma or space syntax, optional alpha. Numbers only - no var(), calc(), url().
const RGB_RE =
  /^rgba?\(\s*(\d{1,3})\s*(?:,\s*|\s+)(\d{1,3})\s*(?:,\s*|\s+)(\d{1,3})\s*(?:(?:,|\/)\s*(\d*\.?\d+%?)\s*)?\)$/i;

/** Returns a canonical, safe CSS color string (hex or rgb/rgba) or null. */
export function sanitizeColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v.length === 0 || v.length > 64) return null;

  if (HEX_RE.test(v)) return v.toLowerCase();

  const m = RGB_RE.exec(v);
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map(Number) as [number, number, number];
  if ([r, g, b].some((c) => c > 255)) return null;
  if (m[4] === undefined) return `rgb(${r}, ${g}, ${b})`;

  const rawAlpha = m[4];
  const alpha = rawAlpha.endsWith('%') ? Number(rawAlpha.slice(0, -1)) / 100 : Number(rawAlpha);
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) return null;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Parse a sanitized color into 0-255 RGB channels (alpha ignored). */
function toRgb(color: string): [number, number, number] | null {
  const c = sanitizeColor(color);
  if (!c) return null;
  if (c.startsWith('#')) {
    let hex = c.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = [...hex.slice(0, 3)].map((ch) => ch + ch).join('');
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  }
  const nums = c.match(/\d+/g)?.map(Number);
  return nums && nums.length >= 3 ? [nums[0]!, nums[1]!, nums[2]!] : null;
}

/** WCAG relative luminance. */
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Choose the light or dark ink with better contrast on the given background color. */
export function readableInk(background: string, light: string, dark: string): string {
  const rgb = toRgb(background);
  if (!rgb) return light;
  const L = luminance(rgb);
  const contrastLight = (luminance(toRgb(light) ?? [255, 255, 255]) + 0.05) / (L + 0.05);
  const contrastDark = (L + 0.05) / (luminance(toRgb(dark) ?? [0, 0, 0]) + 0.05);
  return contrastLight >= contrastDark ? light : dark;
}

/**
 * Safe link target: same-site absolute path ("/collections/new") or an https URL.
 * Rejects javascript:, data:, protocol-relative ("//evil"), backslashes and control chars.
 */
export function sanitizeHref(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  // Control chars, whitespace and backslashes are never valid in our links.
  // eslint-disable-next-line no-control-regex
  if (v.length === 0 || v.length > 2048 || /[\u0000-\u001f\u007f\\\s]/.test(v)) return null;
  if (v.startsWith('/')) return v.startsWith('//') ? null : v;
  try {
    const url = new URL(v);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Safe image source: https URL or a path under our own public theme assets. */
export function sanitizeImageUrl(value: unknown): string | null {
  const href = sanitizeHref(value);
  if (!href) return null;
  if (href.startsWith('/')) return href.startsWith('/themes/') && !href.includes('..') ? href : null;
  return href;
}
