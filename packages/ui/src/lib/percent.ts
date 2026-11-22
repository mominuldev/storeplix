import { normalizeDigits } from './money';

// Coupon "Discount (%)" (68:19255): 1–100 with up to 2 decimals → basis points (15 % = 1 500). `onChange` gets bps,
// `null` (empty) or `NaN` (not a valid percentage).
export function parsePercent(text: string): number | null {
  const t = normalizeDigits(text).replace(/%/g, '').trim();
  if (!t) return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return Number.NaN;
  const bps = Math.round(Number(t) * 100);
  return bps >= 1 && bps <= 10000 ? bps : Number.NaN;
}

export function bpsToInput(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return '';
  return String(Number((bps / 100).toFixed(2)));
}
