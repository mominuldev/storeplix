import {
  POS_BDT_COIN_MAX,
  POS_BDT_DENOMINATIONS,
  POS_LINE_QUANTITY_MAX,
  POS_LINES_MAX,
  POS_PAYMENT_METHOD_LABELS,
  POS_PAYMENTS_MAX,
  type FeatureAccess,
  type PosCatalogItem,
  type PosCatalogVariant,
  type PosDenominationCounts,
  type PosPaymentInput,
  type PosPaymentMethod,
  type PosQuote,
  type PosReceipt,
  type PosSession,
  type PosSmsReceiptStatus,
} from '@storeplix/types';
import { formatBdt, formatCount } from '@storeplix/ui';
import { formatBdPhone } from '../lib/phone';

// PHASE-8-8D part A pure helpers (§6, §11, P88D-9, P88D-15, P88D-21). All money is integer minor units (paisa).

// ---------- Plan ----------
/** §2.2: plan feature `pos` missing (Free / Starter). Unknown features → not locked (the API still enforces it). */
export function posLocked(features: FeatureAccess | undefined): boolean {
  return !!features && features.features.pos === false;
}

// ---------- Denominations (P88D-15) ----------
export interface DenominationRow {
  /** Minor units (`100000` = ৳ 1,000) */
  value: number;
  kind: 'Note' | 'Coin';
}

/** BDT list on both open and close; other currencies enter one amount (`null`). */
export function denominationsFor(currency: string | null | undefined): DenominationRow[] | null {
  if (currency && currency !== 'BDT') return null;
  return POS_BDT_DENOMINATIONS.map((value) => ({
    value,
    kind: value <= POS_BDT_COIN_MAX ? 'Coin' : 'Note',
  }));
}

/** Count chip tone (Figma 25:581): large notes green, small notes blue, coins accent. */
export function denominationTone(value: number): 'success' | 'info' | 'accent' {
  if (value <= POS_BDT_COIN_MAX) return 'accent';
  return value >= 10000 ? 'success' : 'info';
}

/** Σ denomination × count. Invalid counts count as 0. */
export function countsTotal(counts: PosDenominationCounts): number {
  return Object.entries(counts).reduce((sum, [denomination, count]) => {
    const d = Number(denomination);
    return Number.isInteger(d) && Number.isInteger(count) && count > 0 ? sum + d * count : sum;
  }, 0);
}

/** Drop zero / empty counts (the API takes only what was counted). */
export function compactCounts(counts: PosDenominationCounts): PosDenominationCounts {
  return Object.fromEntries(Object.entries(counts).filter(([, c]) => Number.isInteger(c) && c > 0));
}

/** Count input text → count (digits only, ≤ 10,000); empty → 0; anything else → null (invalid). */
export function parseCount(text: string): number | null {
  const t = text.trim();
  if (t === '') return 0;
  if (!/^\d{1,5}$/.test(t)) return null;
  const n = Number(t);
  return n <= 10_000 ? n : null;
}

/** Greedy change breakdown over the BDT list: 44000 → "2 × 200, 2 × 20". Empty for 0. */
export function changeBreakdown(change: number): string {
  if (change <= 0) return '';
  let left = change;
  const parts: string[] = [];
  for (const d of POS_BDT_DENOMINATIONS) {
    const n = Math.floor(left / d);
    if (n > 0) {
      parts.push(`${n} × ${formatCount(d / 100)}`);
      left -= n * d;
    }
  }
  return parts.join(', ');
}

/**
 * Quick cash chips after "Exact": the next round amounts strictly above the total (multiples of ৳ 500, then ৳ 1,000,
 * then ৳ 5,000, each above the previous). 456000 → [500000, 600000, 1000000].
 */
export function quickCash(total: number, count = 3): number[] {
  const out: number[] = [];
  let prev = Math.max(0, total);
  for (const unit of [50000, 100000, 500000].slice(0, count)) {
    const next = (Math.floor(prev / unit) + 1) * unit;
    out.push(next);
    prev = next;
  }
  return out;
}

// ---------- Close register (P88D-15, §11.8) ----------
export interface VarianceView {
  variance: number;
  label: string;
  tone: 'success' | 'warning' | 'danger';
  hint: string;
  noteRequired: boolean;
}

/** variance = counted − expected; |variance| > tolerance needs a note (422 `close_note_required`). */
export function varianceView(counted: number, expected: number, tolerance: number): VarianceView {
  const variance = counted - expected;
  const over = Math.abs(variance) > tolerance;
  const tol = formatBdt(tolerance);
  if (variance === 0)
    return {
      variance,
      label: 'Drawer matches',
      tone: 'success',
      hint: 'Counted cash matches the expected amount.',
      noteRequired: false,
    };
  return {
    variance,
    label: `${variance < 0 ? 'Short' : 'Over'} by ${formatBdt(Math.abs(variance))}`,
    tone: over ? 'danger' : 'warning',
    hint: over ? `Over your ${tol} tolerance — add a note to close.` : `Within your ${tol} tolerance. Add a note if you know why.`,
    noteRequired: over,
  };
}

/** banked = counted − left; left must be 0 … counted. */
export function bankedAmount(counted: number, left: number): number | null {
  if (!Number.isInteger(left) || left < 0 || left > counted) return null;
  return counted - left;
}

/** "Matches last closing (৳ 2,000 left on 18 Nov)" or the warning-tone "Last closing left ৳ 2,000". */
export function openingHint(opening: number, lastLeft: number | null | undefined, lastClosedAt: string | null | undefined): { text: string; tone: 'muted' | 'warning' } | null {
  if (lastLeft === null || lastLeft === undefined) return null;
  if (opening === lastLeft)
    return {
      text: `Matches last closing (${formatBdt(lastLeft)} left${lastClosedAt ? ` on ${dayMonth(lastClosedAt)}` : ''})`,
      tone: 'muted',
    };
  return { text: `Last closing left ${formatBdt(lastLeft)}`, tone: 'warning' };
}

export function dayMonth(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function timeOf(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** Close sheet "Today's sales" rows by method (Split is shown by its parts). */
export function methodRows(session: Pick<PosSession, 'totals'>): {
  method: PosPaymentMethod;
  label: string;
  amount: number;
  count: number;
}[] {
  const order: PosPaymentMethod[] = ['cash', 'bkash_personal', 'card'];
  return order.map((method) => {
    const row = session.totals.by_method.find((m) => m.method === method);
    return {
      method,
      label: POS_PAYMENT_METHOD_LABELS[method],
      amount: row?.amount ?? 0,
      count: row?.count ?? 0,
    };
  });
}

// ---------- Catalog and cart ----------
export interface CartLine {
  variantId: string;
  productId: string;
  name: string;
  variantTitle: string;
  imageUrl: string | null;
  /** Catalog price (display only; the quote is the truth) */
  unitPrice: number;
  /** Available at the register location when added; null = untracked */
  available: number | null;
  quantity: number;
}

/** Σ available of a product's variants; null when any variant is untracked (no count shown). */
export function productAvailable(item: PosCatalogItem): number | null {
  if (item.variants.some((v) => v.available === null)) return null;
  return item.variants.reduce((s, v) => s + Math.max(0, v.available ?? 0), 0);
}

export function variantInStock(v: Pick<PosCatalogVariant, 'available'>): boolean {
  return v.available === null || v.available > 0;
}

export function productInStock(item: PosCatalogItem): boolean {
  return item.variants.some(variantInStock);
}

/** Tile stock caption + tone (Figma 22:1737: "8 in stock" muted, "3 in stock" warning, "Out of stock" danger). */
export function stockCaption(item: PosCatalogItem): {
  text: string;
  tone: 'muted' | 'warning' | 'danger';
} {
  if (!productInStock(item)) return { text: 'Out of stock', tone: 'danger' };
  const n = productAvailable(item);
  if (n === null) return { text: 'In stock', tone: 'muted' };
  return {
    text: `${formatCount(n)} in stock`,
    tone: n <= 3 ? 'warning' : 'muted',
  };
}

export function priceRange(item: PosCatalogItem): number {
  return Math.min(...item.variants.map((v) => v.price_amount));
}

/** Highest quantity a line may reach (available at the register when tracked, never above 999). */
export function maxQuantity(available: number | null): number {
  return available === null ? POS_LINE_QUANTITY_MAX : Math.min(POS_LINE_QUANTITY_MAX, Math.max(0, available));
}

export type AddResult = { lines: CartLine[]; error: string | null };

/** Add (or bump) a variant; refuses above the available stock or past 50 lines. */
export function addToCart(lines: CartLine[], item: PosCatalogItem, variant: PosCatalogVariant, quantity = 1): AddResult {
  const max = maxQuantity(variant.available);
  const existing = lines.find((l) => l.variantId === variant.id);
  const want = (existing?.quantity ?? 0) + quantity;
  if (max === 0) return { lines, error: `${item.name} is out of stock here.` };
  if (want > max) return { lines, error: `Only ${formatCount(max)} left of ${item.name}.` };
  if (existing)
    return {
      lines: lines.map((l) => (l.variantId === variant.id ? { ...l, quantity: want, available: variant.available } : l)),
      error: null,
    };
  if (lines.length >= POS_LINES_MAX) return { lines, error: `A sale can have up to ${POS_LINES_MAX} lines.` };
  const line: CartLine = {
    variantId: variant.id,
    productId: item.product_id,
    name: item.name,
    // The variant's own options (a scanned lookup returns the product with that one variant; P88DA-QA-2).
    variantTitle: variant.options.length ? variant.title : '',
    imageUrl: item.image_url,
    unitPrice: variant.price_amount,
    available: variant.available,
    quantity,
  };
  return { lines: [...lines, line], error: null };
}

/** Set a line's quantity (0 removes it); clamped to 1 … max. */
export function setQuantity(lines: CartLine[], variantId: string, quantity: number): CartLine[] {
  if (quantity <= 0) return lines.filter((l) => l.variantId !== variantId);
  return lines.map((l) =>
    l.variantId === variantId
      ? {
          ...l,
          quantity: Math.min(quantity, Math.max(1, maxQuantity(l.available))),
        }
      : l,
  );
}

export const itemsCount = (lines: readonly Pick<CartLine, 'quantity'>[]) => lines.reduce((s, l) => s + l.quantity, 0);

/** Client estimate shown while the quote loads (the quote replaces it). */
export const estimateSubtotal = (lines: readonly Pick<CartLine, 'quantity' | 'unitPrice'>[]) => lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);

/** Stable signature of what a quote / sale was priced for. */
export function cartSignature(lines: readonly Pick<CartLine, 'variantId' | 'quantity'>[], coupon: string | null, phone: string | null): string {
  return JSON.stringify([lines.map((l) => [l.variantId, l.quantity]), coupon ?? '', phone ?? '']);
}

/** Quote line problems shown inline on the cart line (§11.9). */
export function lineProblem(quote: PosQuote | undefined, variantId: string): string | null {
  const line = quote?.lines.find((l) => l.variant_id === variantId);
  if (!line?.problem) return null;
  if (line.problem === 'unavailable') return 'No longer for sale.';
  if (line.problem === 'out_of_stock' || line.available === 0) return 'Out of stock here.';
  return `Only ${formatCount(line.available ?? 0)} left here.`;
}

/** "{options} · ৳ price" (Figma cart line). */
export function lineCaption(line: Pick<CartLine, 'variantTitle' | 'unitPrice'>): string {
  return [line.variantTitle, formatBdt(line.unitPrice)].filter(Boolean).join(' · ');
}

// ---------- Variant picker (§11.3) ----------
export interface OptionGroup {
  name: string;
  values: string[];
}

export function optionGroups(item: PosCatalogItem): OptionGroup[] {
  const groups: OptionGroup[] = [];
  for (const v of item.variants) {
    for (const o of v.options) {
      let g = groups.find((x) => x.name === o.name);
      if (!g) groups.push((g = { name: o.name, values: [] }));
      if (!g.values.includes(o.value)) g.values.push(o.value);
    }
  }
  return groups;
}

export function findVariant(item: PosCatalogItem, selected: Record<string, string>): PosCatalogVariant | null {
  return item.variants.find((v) => v.options.every((o) => selected[o.name] === o.value)) ?? null;
}

/** The variant that `value` in `group` would pick with the other current choices (for "n left" / "Out"). */
export function variantFor(item: PosCatalogItem, selected: Record<string, string>, group: string, value: string): PosCatalogVariant | null {
  return findVariant(item, { ...selected, [group]: value });
}

/** First in-stock variant's options (picker default). */
export function defaultSelection(item: PosCatalogItem): Record<string, string> {
  const v = item.variants.find(variantInStock) ?? item.variants[0];
  return Object.fromEntries((v?.options ?? []).map((o) => [o.name, o.value]));
}

// ---------- Payment (P88D-9, §11.4) ----------
export type TenderMode = 'cash' | 'bkash_personal' | 'card' | 'split';

export const tenderCards: { mode: TenderMode; label: string; hint: string }[] = [
  { mode: 'cash', label: 'Cash', hint: 'Drawer' },
  { mode: 'bkash_personal', label: 'bKash', hint: 'QR or number' },
  { mode: 'card', label: 'Card', hint: 'POS terminal' },
  { mode: 'split', label: 'Split', hint: 'Mix methods' },
];

export interface SplitPart {
  method: PosPaymentMethod;
  /** Minor units; null = not entered */
  amount: number | null;
  reference: string;
}

export interface TenderState {
  mode: TenderMode;
  /** Cash handed over (cash mode) */
  cashReceived: number | null;
  /** bKash TrxID / card approval code (single-method) */
  reference: string;
  parts: SplitPart[];
}

export type TenderResult =
  | {
      ok: true;
      payments: PosPaymentInput[];
      tendered: number | null;
      change: number;
    }
  | { ok: false; error: string };

const ref = (method: PosPaymentMethod, text: string) => (method === 'cash' || !text.trim() ? null : text.trim());

/** Σ of entered split parts and what is left to cover. */
export function splitRemaining(total: number, parts: readonly SplitPart[]): number {
  return total - parts.reduce((s, p) => s + (p.amount ?? 0), 0);
}

/**
 * The payments + tendered cash for `POST /pos/sales`, or the reason the dialog can't complete. Rules mirror the API:
 * Σ = total, each part > 0, 2–4 split parts, one cash part at most, cash received ≥ the cash part.
 */
export function buildTender(total: number, s: TenderState): TenderResult {
  if (s.mode === 'cash') {
    const received = s.cashReceived ?? total;
    if (!Number.isInteger(received)) return { ok: false, error: 'Enter the cash received.' };
    if (received < total)
      return {
        ok: false,
        error: `Cash received is ${formatBdt(total - received)} short.`,
      };
    return {
      ok: true,
      payments: [{ method: 'cash', amount: total }],
      tendered: received,
      change: received - total,
    };
  }
  if (s.mode !== 'split') {
    return {
      ok: true,
      payments: [{ method: s.mode, amount: total, reference: ref(s.mode, s.reference) }],
      tendered: null,
      change: 0,
    };
  }
  const parts = s.parts;
  if (parts.length < 2 || parts.length > POS_PAYMENTS_MAX)
    return {
      ok: false,
      error: `Split between 2 and ${POS_PAYMENTS_MAX} payments.`,
    };
  if (parts.some((p) => p.amount === null || !Number.isInteger(p.amount) || p.amount <= 0)) return { ok: false, error: 'Every part needs an amount above ৳ 0.' };
  if (parts.filter((p) => p.method === 'cash').length > 1) return { ok: false, error: 'Use one cash part only.' };
  const left = splitRemaining(total, parts);
  if (left > 0) return { ok: false, error: `${formatBdt(left)} still to pay.` };
  if (left < 0)
    return {
      ok: false,
      error: `Parts are ${formatBdt(-left)} more than the total.`,
    };
  const cash = parts.find((p) => p.method === 'cash');
  return {
    ok: true,
    payments: parts.map((p) => ({
      method: p.method,
      amount: p.amount!,
      reference: ref(p.method, p.reference),
    })),
    tendered: cash ? cash.amount! : null,
    change: 0,
  };
}

/** "cash" / "bKash" / "card" / "split" for "paid in {method}". */
export function paidInLabel(payments: readonly { method: PosPaymentMethod }[]): string {
  if (payments.length > 1) return 'split';
  const m = payments[0]?.method;
  return m === 'cash' ? 'cash' : m === 'card' ? 'card' : m === 'bkash_personal' ? 'bKash' : '';
}

/** Numpad key → next cash text ("00", digits, backspace). Keeps at most 8 whole digits. */
export function numpadNext(text: string, key: string): string {
  if (key === 'back') return text.slice(0, -1);
  const next = `${text === '0' ? '' : text}${key}`;
  return /^\d{0,8}$/.test(next) ? next.replace(/^0+(?=\d)/, '') : text;
}

// ---------- Receipt (P88D-11) ----------
type ReceiptLabelKey = 'receipt' | 'cashier' | 'register' | 'subtotal' | 'discount' | 'vat' | 'total' | 'change' | 'customer' | 'bin' | 'included';

const receiptLabels: Record<PosReceipt['language'], Record<ReceiptLabelKey, string>> = {
  en: {
    receipt: 'Receipt',
    cashier: 'Cashier',
    register: 'Register',
    subtotal: 'Subtotal',
    discount: 'Discount',
    vat: 'VAT',
    total: 'TOTAL',
    change: 'Change',
    customer: 'Customer',
    bin: 'BIN',
    included: 'included',
  },
  bn: {
    receipt: 'রসিদ',
    cashier: 'ক্যাশিয়ার',
    register: 'রেজিস্টার',
    subtotal: 'সাবটোটাল',
    discount: 'ছাড়',
    vat: 'ভ্যাট',
    total: 'মোট',
    change: 'ফেরত',
    customer: 'গ্রাহক',
    bin: 'বিআইএন',
    included: 'অন্তর্ভুক্ত',
  },
};

export const receiptLabel = (language: PosReceipt['language'], key: ReceiptLabelKey) => receiptLabels[language]?.[key] ?? receiptLabels.en[key];

const methodLabelBn: Record<PosPaymentMethod, string> = {
  cash: 'নগদ',
  bkash_personal: 'বিকাশ',
  card: 'কার্ড',
};
export const receiptMethodLabel = (language: PosReceipt['language'], m: PosPaymentMethod) => (language === 'bn' ? methodLabelBn[m] : POS_PAYMENT_METHOD_LABELS[m]);

/** VAT row per P88D-8: "VAT 5% (included)"; null when hidden. */
export function vatLabel(language: PosReceipt['language'], vat: { rate_bps: number } | null): string | null {
  if (!vat) return null;
  const pct = vat.rate_bps / 100;
  return `${receiptLabel(language, 'vat')} ${Number.isInteger(pct) ? pct : pct.toFixed(2)}% (${receiptLabel(language, 'included')})`;
}

/** Receipt timestamp in Latin digits (Q51): "19 Nov 2026 14:42". */
export function receiptTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

// ---------- Idempotency (P88D-21) ----------
/**
 * One key per attempt: the same payload reuses the key (a retry or double tap replays), a changed payload mints a new
 * one (it is a different attempt), and `reset()` after success forgets it.
 */
export function createAttemptKeys(mint: () => string) {
  let current: { signature: string; key: string } | null = null;
  return {
    keyFor(signature: string): string {
      if (!current || current.signature !== signature) current = { signature, key: mint() };
      return current.key;
    },
    reset() {
      current = null;
    },
  };
}

// ---------- Remembered register (§11: per browser, convenience only) ----------
const registerKey = (storeId: string) => `storeplix.pos.register.${storeId}`;

export function rememberedRegister(storeId: string | null): string | null {
  if (!storeId) return null;
  try {
    return localStorage.getItem(registerKey(storeId));
  } catch {
    return null;
  }
}

export function rememberRegister(storeId: string | null, registerId: string): void {
  if (!storeId) return;
  try {
    localStorage.setItem(registerKey(storeId), registerId);
  } catch {
    /* convenience only */
  }
}

// ---------- Count tables (open / close) ----------
/** Raw count texts → API counts (invalid texts make the whole table invalid → null). */
export function textsToCounts(currency: string, texts: Record<string, string>): PosDenominationCounts | null {
  const counts: PosDenominationCounts = {};
  for (const r of denominationsFor(currency) ?? []) {
    const n = parseCount(texts[String(r.value)] ?? '');
    if (n === null) return null;
    if (n > 0) counts[String(r.value)] = n;
  }
  return counts;
}

export const countsSum = (counts: PosDenominationCounts | null) => (counts ? countsTotal(counts) : 0);

// ---------- Labels ----------
/** POS bar line: "{register} · {location} · Opened {time} by {name}". */
export const sessionLine = (s: Pick<PosSession, 'register' | 'opened_at' | 'opened_by'>) =>
  `${s.register.name} · ${s.register.location.name} · Opened ${timeOf(s.opened_at)} by ${s.opened_by.name}`;

export type SmsView = {
  text: string;
  tone: 'muted' | 'danger' | 'success';
  action: string | null;
};

/** §11.5 SMS row: sending / sent / failed / not sent. */
export function smsView(status: PosSmsReceiptStatus, phone: string | null, sending: boolean): SmsView {
  const to = phone ? formatBdPhone(phone) : '';
  if (sending)
    return {
      text: `Sending SMS receipt to ${to}…`,
      tone: 'muted',
      action: null,
    };
  if (!phone || status === 'no_phone')
    return {
      text: 'No phone — SMS receipt not sent',
      tone: 'muted',
      action: null,
    };
  if (status === 'sent')
    return {
      text: `SMS receipt sent to ${to}`,
      tone: 'success',
      action: 'Resend',
    };
  if (status === 'queued')
    return {
      text: `Sending SMS receipt to ${to}`,
      tone: 'muted',
      action: 'Resend',
    };
  if (status === 'failed')
    return {
      text: `SMS receipt to ${to} failed`,
      tone: 'danger',
      action: 'Resend',
    };
  return { text: 'SMS receipt not sent', tone: 'muted', action: 'Send' };
}
