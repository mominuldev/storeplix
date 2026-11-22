import type { CouponType } from '@storeplix/types';

// Client mirror of P5-12 (integer, deterministic) used by the coupon live preview. The API is the source of truth.

export interface CouponRule {
  type: CouponType;
  percent_bps: number | null;
  amount: number | null;
  max_discount_amount: number | null;
  min_subtotal_amount: number | null;
}

/** Discount on the eligible subtotal `E` (paisa). Percentage: floor(E × bps / 10 000) → cap → E. Fixed: min(amount, E). */
export function couponDiscount(rule: CouponRule, eligible: number): number {
  if (eligible <= 0) return 0;
  if (rule.type === 'percentage') {
    let d = Math.floor((eligible * (rule.percent_bps ?? 0)) / 10_000);
    if (rule.max_discount_amount !== null) d = Math.min(d, rule.max_discount_amount);
    return Math.min(d, eligible);
  }
  if (rule.type === 'fixed') return Math.min(rule.amount ?? 0, eligible);
  return 0;
}

/**
 * Largest-remainder allocation of `discount` over eligible line subtotals (ties → lower index), so the per-line
 * amounts sum exactly to `discount`.
 */
export function allocateDiscount(discount: number, lines: number[]): number[] {
  const total = lines.reduce((s, x) => s + x, 0);
  if (discount <= 0 || total <= 0) return lines.map(() => 0);
  const exact = lines.map((x) => (discount * x) / total);
  const base = exact.map(Math.floor);
  let rest = discount - base.reduce((s, x) => s + x, 0);
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    base[i]! += 1;
    rest -= 1;
  }
  return base;
}

export interface PreviewLine {
  name: string;
  detail: string;
  amount: number;
}

export interface CheckoutPreview {
  subtotal: number;
  discount: number;
  allocation: number[];
  shipping: number;
  shippingDiscount: number;
  total: number;
  applied: boolean;
  reason: string | null;
}

/** "At checkout" example (68:19255): applies the rule to sample lines and a delivery charge. */
export function previewCheckout(rule: CouponRule, lines: PreviewLine[], shipping: number): CheckoutPreview {
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  if (rule.min_subtotal_amount !== null && subtotal < rule.min_subtotal_amount) {
    return { subtotal, discount: 0, allocation: lines.map(() => 0), shipping, shippingDiscount: 0, total: subtotal + shipping, applied: false, reason: 'below_minimum' };
  }
  const discount = couponDiscount(rule, subtotal);
  const shippingDiscount = rule.type === 'free_shipping' ? shipping : 0;
  return {
    subtotal,
    discount,
    allocation: allocateDiscount(discount, lines.map((l) => l.amount)),
    shipping: shipping - shippingDiscount,
    shippingDiscount,
    total: subtotal - discount + shipping - shippingDiscount,
    applied: true,
    reason: null,
  };
}

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789';

/** Client "Generate" (§9): 8 chars from A–Z and 2–9. */
export function generateCode(random: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 8; i += 1) s += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  return s;
}

export const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
