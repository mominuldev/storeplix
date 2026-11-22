import type { Coupon, CouponAppliesTo, CouponStatus, CouponType, CreateCouponInput, MediaRef } from '@storeplix/types';
import { CODE_PATTERN } from './math';

// Coupon form state and its mapping to the API (P5-11). Dates are entered in store time (Asia/Dhaka, UTC+6).

export type ProductRef = { id: string; name: string; image: MediaRef | null; price_min_amount: number };

export interface FormState {
  code: string;
  type: CouponType;
  percent_bps: number | null;
  amount: number | null;
  max_discount_amount: number | null;
  applies_to: CouponAppliesTo;
  category_ids: string[];
  products: ProductRef[];
  min_subtotal_amount: number | null;
  usage_limit: string;
  usage_per_customer: string;
  first_order_only: boolean;
  starts_at: string; // datetime-local in Dhaka time
  ends_at: string;
  no_end: boolean;
}

const DHAKA_OFFSET_MS = 6 * 3600_000;

/** ISO → "YYYY-MM-DDTHH:mm" in Asia/Dhaka (UTC+6, no DST). */
export function toDhakaLocal(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : new Date(t + DHAKA_OFFSET_MS).toISOString().slice(0, 16);
}

/** "YYYY-MM-DDTHH:mm" in Dhaka time → ISO with +06:00. */
export function fromDhakaLocal(local: string): string | null {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local) ? `${local}:00+06:00` : null;
}

export function fromCoupon(c: Coupon | null): FormState {
  const now = new Date(Date.now() - (Date.now() % 60_000)).toISOString();
  return {
    code: c?.code ?? '',
    type: c?.type ?? 'percentage',
    percent_bps: c?.percent_bps ?? null,
    amount: c?.amount ?? null,
    max_discount_amount: c?.max_discount_amount ?? null,
    applies_to: c?.applies_to ?? 'all',
    category_ids: c?.categories.map((x) => x.id) ?? [],
    products: c?.products ?? [],
    min_subtotal_amount: c?.min_subtotal_amount ?? null,
    usage_limit: c?.usage_limit ? String(c.usage_limit) : '',
    usage_per_customer: c ? (c.usage_per_customer ? String(c.usage_per_customer) : '') : '1',
    first_order_only: c?.first_order_only ?? false,
    starts_at: toDhakaLocal(c?.starts_at ?? now),
    ends_at: toDhakaLocal(c?.ends_at),
    no_end: c ? c.ends_at === null : true,
  };
}

/** Client rules mirroring the API (P5-11). Returns field → message. */
export function validateCoupon(f: FormState): Record<string, string> {
  const e: Record<string, string> = {};
  if (!CODE_PATTERN.test(f.code)) e.code = 'Use 3–32 letters, numbers, - or _, starting with a letter or number.';
  if (f.type === 'percentage' && (f.percent_bps === null || !Number.isFinite(f.percent_bps))) e.percent_bps = 'Enter a percentage from 1 to 100.';
  if (f.type === 'percentage' && f.max_discount_amount !== null && (!Number.isFinite(f.max_discount_amount) || f.max_discount_amount < 1)) e.max_discount_amount = 'Enter an amount like 300.';
  if (f.type === 'fixed' && (f.amount === null || !Number.isFinite(f.amount) || f.amount < 1)) e.amount = 'Enter an amount like 150.';
  if (f.applies_to === 'categories' && f.category_ids.length === 0) e.category_ids = 'Pick at least one category.';
  if (f.applies_to === 'products' && f.products.length === 0) e.product_ids = 'Pick at least one product.';
  if (f.min_subtotal_amount !== null && !Number.isFinite(f.min_subtotal_amount)) e.min_subtotal_amount = 'Enter an amount like 1200.';
  if (f.usage_limit && !/^[1-9]\d{0,6}$/.test(f.usage_limit)) e.usage_limit = 'Use a whole number.';
  if (f.usage_per_customer && !/^[1-9]\d{0,5}$/.test(f.usage_per_customer)) e.usage_per_customer = 'Use a whole number.';
  if (!fromDhakaLocal(f.starts_at)) e.starts_at = 'Choose a start date.';
  if (!f.no_end) {
    if (!fromDhakaLocal(f.ends_at)) e.ends_at = 'Choose an end date, or tick “No end date”.';
    else if (f.ends_at <= f.starts_at) e.ends_at = 'The end must be after the start.';
  }
  return e;
}

export function toInput(f: FormState, status: CouponStatus): CreateCouponInput {
  return {
    code: f.code,
    type: f.type,
    percent_bps: f.type === 'percentage' ? f.percent_bps : null,
    amount: f.type === 'fixed' ? f.amount : null,
    max_discount_amount: f.type === 'percentage' ? f.max_discount_amount : null,
    applies_to: f.type === 'free_shipping' ? 'all' : f.applies_to,
    category_ids: f.type !== 'free_shipping' && f.applies_to === 'categories' ? f.category_ids : [],
    product_ids: f.type !== 'free_shipping' && f.applies_to === 'products' ? f.products.map((p) => p.id) : [],
    min_subtotal_amount: f.min_subtotal_amount,
    usage_limit: f.usage_limit ? Number(f.usage_limit) : null,
    usage_per_customer: f.usage_per_customer ? Number(f.usage_per_customer) : null,
    first_order_only: f.first_order_only,
    starts_at: fromDhakaLocal(f.starts_at) ?? undefined,
    ends_at: f.no_end ? null : fromDhakaLocal(f.ends_at),
    status,
  };
}
