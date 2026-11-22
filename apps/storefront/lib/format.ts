const SYMBOLS: Record<string, string> = { BDT: '৳' };
const GROUPED = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/**
 * Split integer minor units into "3,450" / "3,450.50" using integer math only (no float rounding).
 * Non-integer or non-finite input is rejected (returns null): amounts are always integers on the wire.
 */
function minorToMajorText(minor: number): string | null {
  if (!Number.isSafeInteger(minor)) return null;
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const major = Math.floor(abs / 100);
  const cents = abs % 100;
  return `${sign}${GROUPED.format(major)}${cents === 0 ? '' : `.${String(cents).padStart(2, '0')}`}`;
}

/** BDT from paisa: `345000` → `৳ 3,450`, `345050` → `৳ 3,450.50`. Formatting only, never computes prices. */
export function formatBdt(paisa: number): string {
  const text = minorToMajorText(paisa);
  return text === null ? '' : `৳ ${text}`;
}

/** Money from integer minor units in `currency` (2-decimal currencies). BDT uses formatBdt. */
export function formatMoney(minor: number, currency: string): string {
  const code = currency.toUpperCase();
  const text = minorToMajorText(minor);
  if (text === null) return '';
  const symbol = SYMBOLS[code];
  return symbol ? `${symbol} ${text}` : `${code} ${text}`;
}
