// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Plain merchant text: a string of at most `max` code points (after trim) with no control
 * characters, else undefined. Always rendered as React text, never HTML.
 */
export function cleanText(v: unknown, max: number, min = 0): string | undefined {
  if (typeof v !== 'string' || CONTROL.test(v)) return undefined;
  const t = v.trim();
  const len = [...t].length;
  return len >= min && len <= max ? t : undefined;
}
