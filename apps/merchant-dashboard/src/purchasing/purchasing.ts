import { isApiError } from '@storeplix/api-client';
import {
  PURCHASE_LINE_QUANTITY_MAX,
  PURCHASE_ORDER_NOTES_MAX,
  PURCHASE_UNIT_COST_MAX,
  PURCHASING_MIN_DATE,
  SUPPLIER_ACCOUNT_MAX,
  SUPPLIER_CITY_MAX,
  SUPPLIER_LEAD_TIME_DAYS_MAX,
  SUPPLIER_NAME_MAX,
  SUPPLIER_NOTES_MAX,
  SUPPLIER_PAYMENT_AMOUNT_MAX,
  SUPPLIER_PAYMENT_METHODS,
  SUPPLIER_PAYMENT_METHOD_LABELS,
  SUPPLIER_PAYMENT_NOTE_MAX,
  SUPPLIER_SUPPLIES_MAX,
  SUPPLIER_TERMS_DAYS_MAX,
  type FeatureAccess,
  type PurchaseOrder,
  type PurchaseOrderDetail,
  type PurchaseOrderEvent,
  type PurchaseOrderLine,
  type PurchaseOrderStatus,
  type PurchasePaymentStatus,
  type ReorderSuggestionGroup,
  type ReorderSuggestionItem,
  type StockMovement,
  type Supplier,
  type SupplierInput,
  type SupplierPaymentMethod,
} from '@storeplix/types';
import { formatBdt, type BadgeTone } from '@storeplix/ui';
import { z } from 'zod';
import { formatCount, plural } from '../catalog/format';
import { errorMessage } from '../catalog/states';
import { handlePlanLimit } from '../plan/Banners';
import { normalizeBdPhone } from '../lib/phone';

// PHASE-8-8B §5–§7, §10 pure helpers for the purchasing screens (Figma 35:5619, 35:6210, 36:6607, 153:35999).

// ---------- Labels and tones ----------

/** Status pill (35:5619 table + 36:6607 header): Draft neutral, Ordered info, Partly received warning, Received success. */
export const poStatusMeta: Record<PurchaseOrderStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  ordered: { label: 'Ordered', tone: 'info' },
  partially_received: { label: 'Partly received', tone: 'warning' },
  received: { label: 'Received', tone: 'success' },
  closed: { label: 'Closed', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

/** Status chips on the PO list ("All · 14", "Draft · 1", …). */
export const PO_STATUS_CHIPS: ('all' | PurchaseOrderStatus)[] = ['all', 'draft', 'ordered', 'partially_received', 'received', 'closed', 'cancelled'];

export const paymentStatusMeta: Record<PurchasePaymentStatus, { label: string; tone: BadgeTone }> = {
  unpaid: { label: 'Unpaid', tone: 'danger' },
  partially_paid: { label: 'Part paid', tone: 'warning' },
  paid: { label: 'Paid', tone: 'success' },
  overpaid: { label: 'Overpaid', tone: 'info' },
};

export const methodLabel = (m: SupplierPaymentMethod | null | undefined) => (m ? SUPPLIER_PAYMENT_METHOD_LABELS[m] : '—');

export const isOpen = (s: PurchaseOrderStatus) => s === 'ordered' || s === 'partially_received';

/** Supplier panel "Recent purchase orders" pill (153:35999): open → On the way, else the payment status. */
export function recentPoPill(po: Pick<PurchaseOrder, 'status' | 'payment_status'>): { label: string; tone: BadgeTone } {
  if (isOpen(po.status)) return { label: 'On the way', tone: 'info' };
  if (po.status === 'draft' || po.status === 'cancelled') return poStatusMeta[po.status];
  return po.payment_status ? paymentStatusMeta[po.payment_status] : poStatusMeta[po.status];
}

// ---------- Dates ----------

const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-11-17` (or an ISO timestamp) → "17 Nov". */
export function dayMonth(d: string | null | undefined): string {
  if (!d || !/^\d{4}-\d{2}-\d{2}/.test(d)) return '—';
  return `${Number(d.slice(8, 10))} ${SHORT[Number(d.slice(5, 7)) - 1] ?? ''}`;
}

/** `2026-11-24` → "24 Nov 2026". */
export const longDay = (d: string | null | undefined) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${dayMonth(d)} ${d.slice(0, 4)}` : '—');

/** ISO timestamp → local `YYYY-MM-DD` in the store timezone. */
export function localDate(iso: string | null | undefined, timezone?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch {
    return iso.slice(0, 10);
  }
}

/** "10 Nov · 11:02" (history rows). */
export function dayTime(iso: string, timezone?: string | null): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  let time: string;
  try {
    time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: timezone || undefined });
  } catch {
    time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  return `${dayMonth(localDate(iso, timezone))} · ${time}`;
}

/** "Ordered" cell: the order date (draft → creation), "Today" when it is today. */
export function orderedCell(po: Pick<PurchaseOrder, 'ordered_at' | 'created_at'>, today: string, timezone?: string | null): string {
  const d = localDate(po.ordered_at ?? po.created_at, timezone);
  return d === today ? 'Today' : dayMonth(d);
}

/** "Expected" cell: "17 Nov · late" when late (35:5619). */
export function expectedCell(po: Pick<PurchaseOrder, 'expected_on' | 'is_late'>): { text: string; late: boolean } {
  if (!po.expected_on) return { text: '—', late: false };
  return po.is_late ? { text: `${dayMonth(po.expected_on)} · late`, late: true } : { text: dayMonth(po.expected_on), late: false };
}

/** `YYYY-MM-DD` + n days. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- Receiving ----------

/** Receiving bar (35:5619): "60 / 100 units", fill share, tone (success when complete, brand otherwise). Draft → null. */
export function receivingBar(po: Pick<PurchaseOrder, 'status' | 'units_ordered' | 'units_received' | 'units_damaged'>) {
  if (po.status === 'draft') return null;
  const handled = po.units_received + po.units_damaged;
  const share = po.units_ordered > 0 ? Math.min(1, po.units_received / po.units_ordered) : 0;
  const complete = po.status === 'received' || (po.units_ordered > 0 && handled >= po.units_ordered);
  return { text: `${formatCount(po.units_received)} / ${formatCount(po.units_ordered)} units`, share, complete };
}

/** "Jamdani, Silk Saree · 6 lines" (supplier · items cell). */
export function itemsLine(po: Pick<PurchaseOrder, 'preview_items' | 'lines_count'>): string {
  const names = Array.from(new Set(po.preview_items.map((p) => p.product_name))).slice(0, 2);
  return [names.join(', '), plural(po.lines_count, 'line')].filter(Boolean).join(' · ');
}

export type ReceiveDraft = Record<string, { received: number; damaged: number }>;

/** Per-line check: received + damaged ≤ left (422 `over_receive` mirror). */
export function receiveLineError(line: Pick<PurchaseOrderLine, 'quantity_left'>, v: { received: number; damaged: number } | undefined): string | null {
  if (!v) return null;
  if (!Number.isInteger(v.received) || !Number.isInteger(v.damaged) || v.received < 0 || v.damaged < 0) return 'Enter whole numbers.';
  if (v.received + v.damaged > line.quantity_left) return `Only ${formatCount(line.quantity_left)} left on this line.`;
  return null;
}

/** "Receive all remaining": every open line's left goes into "receiving now", damaged 0. */
export function receiveAll(lines: Pick<PurchaseOrderLine, 'id' | 'quantity_left'>[]): ReceiveDraft {
  return Object.fromEntries(lines.filter((l) => l.quantity_left > 0).map((l) => [l.id, { received: l.quantity_left, damaged: 0 }]));
}

/** Footer totals: units added to stock, damaged, stock value at landed cost (null when costs are hidden). */
export function receiveTotals(lines: Pick<PurchaseOrderLine, 'id' | 'landed_unit_cost_amount'>[], draft: ReceiveDraft) {
  let units = 0;
  let damaged = 0;
  let value: number | null = 0;
  for (const l of lines) {
    const v = draft[l.id];
    if (!v) continue;
    units += Math.max(0, v.received || 0);
    damaged += Math.max(0, v.damaged || 0);
    if (v.received > 0) value = l.landed_unit_cost_amount === null || value === null ? null : value + l.landed_unit_cost_amount * v.received;
  }
  return { units, damaged, value };
}

/** Footer copy (36:6607). PHASE-8-8C §10.3: "Adding n units to {location}" (36:7118) when the store has > 1 location. */
export function receiveFooter(t: { units: number; damaged: number; value: number | null }, locationName?: string | null): { title: string; detail: string } {
  const title = `Adding ${plural(t.units, 'unit')} to ${locationName || 'stock'}`;
  const parts = [
    t.value !== null && t.units > 0 ? `Stock value + ${formatBdt(t.value)} · cost prices updated` : null,
    t.damaged > 0 ? `${formatCount(t.damaged)} damaged, not added to stock` : null,
  ].filter(Boolean);
  return { title, detail: parts.join(' · ') };
}

/** Progress card (36:6607): received / receiving now / damaged segments as shares of ordered. */
export function progressOf(po: Pick<PurchaseOrderDetail, 'units_ordered' | 'units_received' | 'units_damaged' | 'units_left'>, now: { units: number; damaged: number }) {
  const total = Math.max(1, po.units_ordered);
  const damaged = po.units_damaged + now.damaged;
  return {
    title: `${formatCount(po.units_received)} of ${formatCount(po.units_ordered)} units received`,
    coming: po.units_left > 0 ? `${formatCount(po.units_left)} still coming` : null,
    received: po.units_received / total,
    now: now.units / total,
    damaged: damaged / total,
    damagedUnits: damaged,
  };
}

// ---------- New PO maths ----------

export interface FormLine {
  variant_id: string;
  unit_cost_amount: number | null;
  quantity: number | null;
}

const lineValue = (l: FormLine) => (Number.isFinite(l.unit_cost_amount) && Number.isFinite(l.quantity) ? (l.unit_cost_amount ?? 0) * (l.quantity ?? 0) : 0);

/** Summary (35:6210): items (units), subtotal, total = subtotal + transport − discount (never below 0). */
export function poTotals(lines: FormLine[], shipping: number | null, discount: number | null) {
  const units = lines.reduce((n, l) => n + (Number.isFinite(l.quantity) ? (l.quantity ?? 0) : 0), 0);
  const subtotal = lines.reduce((n, l) => n + lineValue(l), 0);
  const s = Number.isFinite(shipping) ? (shipping ?? 0) : 0;
  const d = Number.isFinite(discount) ? (discount ?? 0) : 0;
  return { units, subtotal, shipping: s, discount: d, total: Math.max(0, subtotal + s - d), lineTotal: lineValue };
}

/** Advance suggestion from the supplier's `advance_percent` (round half up), the rest on delivery. */
export function advanceSplit(total: number, advancePercent: number | null | undefined): { percent: number; advance: number; onDelivery: number } | null {
  if (!advancePercent || advancePercent <= 0 || total <= 0) return null;
  const advance = Math.floor((total * advancePercent + 50) / 100);
  return { percent: advancePercent, advance, onDelivery: total - advance };
}

/** Payment terms copy: "50% advance, rest on delivery", "15 days after delivery", "On delivery". */
export function termsLabel(s: { payment_terms_days: number | null; advance_percent?: number | null }): string {
  const rest = s.payment_terms_days ? `${s.payment_terms_days} days after delivery` : 'on delivery';
  if (s.advance_percent && s.advance_percent > 0) return `${s.advance_percent}% advance, rest ${rest}`;
  return s.payment_terms_days ? rest : 'On delivery';
}

/** Payment terms options for the New PO select (the supplier's own terms first). */
export const TERMS_OPTIONS: { key: string; terms: number | null; advance: number | null }[] = [
  { key: 'delivery', terms: null, advance: null },
  { key: 'd7', terms: 7, advance: null },
  { key: 'd15', terms: 15, advance: null },
  { key: 'd30', terms: 30, advance: null },
  { key: 'a50', terms: null, advance: 50 },
  { key: 'a100', terms: null, advance: 100 },
];
export const termsKey = (s: { payment_terms_days: number | null; advance_percent?: number | null }) => `t${s.payment_terms_days ?? 0}-a${s.advance_percent ?? 0}`;

/** "Delivers in ~5 days" (Q212). */
export const leadLabel = (days: number | null | undefined) => (days === null || days === undefined ? null : `Delivers in ~${days} ${days === 1 ? 'day' : 'days'}`);

/** Lead time row in the supplier panel. */
export const leadTimeText = (days: number | null | undefined) => (days === null || days === undefined ? '—' : `${days} ${days === 1 ? 'day' : 'days'}`);

/** Payment terms row in the supplier panel. */
export const paymentTermsText = (days: number | null | undefined) => (days === null || days === undefined ? '—' : days === 0 ? 'On delivery' : `${days} days after delivery`);

// ---------- Sharing (P88B-14) ----------

export interface WhatsAppPo {
  number: string;
  storeName: string;
  supplierName: string;
  expected_on: string | null;
  lines: { name: string; variant: string | null; quantity: number; unit_cost_amount: number | null }[];
  shipping_amount: number | null;
  discount_amount: number | null;
  total_amount: number | null;
  notes?: string | null;
}

/** Message text for the supplier: PO number, one line per item, transport/discount, total, expected date, note. */
export function whatsappText(po: WhatsAppPo): string {
  const lines = po.lines.map((l) => {
    const name = l.variant && l.variant !== 'Default' ? `${l.name} (${l.variant})` : l.name;
    return `• ${name} × ${formatCount(l.quantity)}${l.unit_cost_amount !== null ? ` @ ${formatBdt(l.unit_cost_amount)}` : ''}`;
  });
  return [
    `Purchase order ${po.number} from ${po.storeName}`,
    `Hi ${po.supplierName}, please send:`,
    ...lines,
    po.shipping_amount ? `Transport: ${formatBdt(po.shipping_amount)}` : null,
    po.discount_amount ? `Discount: − ${formatBdt(po.discount_amount)}` : null,
    po.total_amount !== null ? `Total: ${formatBdt(po.total_amount)}` : null,
    po.expected_on ? `Needed by ${longDay(po.expected_on)}` : null,
    po.notes ? `Note: ${po.notes}` : null,
  ]
    .filter((x): x is string => x !== null)
    .join('\n');
}

/** `https://wa.me/8801711889900?text=…` (no attachment, no API). Null without a phone. */
export function whatsappLink(phone: string | null | undefined, text?: string): string | null {
  const n = phone ? normalizeBdPhone(phone) : null;
  if (!n) return null;
  return `https://wa.me/${n}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

export const telLink = (phone: string | null | undefined) => {
  const n = phone ? normalizeBdPhone(phone) : null;
  return n ? `tel:+${n}` : null;
};

export function whatsappPoOf(po: PurchaseOrderDetail, storeName: string): WhatsAppPo {
  return {
    number: po.number,
    storeName,
    supplierName: po.supplier.contact_name || po.supplier.name,
    expected_on: po.expected_on,
    lines: po.lines.map((l) => ({ name: l.product.name, variant: l.variant_title, quantity: l.quantity_ordered, unit_cost_amount: l.unit_cost_amount })),
    shipping_amount: po.shipping_amount,
    discount_amount: po.discount_amount,
    total_amount: po.total_amount,
    notes: po.notes,
  };
}

// ---------- History ----------

export function eventText(e: PurchaseOrderEvent): string {
  const who = e.actor?.name ? e.actor.name.split(' ')[0] : null;
  const by = who ? ` by ${who}` : '';
  switch (e.type) {
    case 'created':
      return `Created${by}`;
    case 'updated':
      return `Edited${by}`;
    case 'sent':
      return e.sent_via === 'whatsapp' ? 'Sent to supplier on WhatsApp' : e.sent_via === 'pdf' ? 'Sent to supplier as PDF' : 'Sent to supplier';
    case 'marked_ordered':
      return `Marked as ordered${by}`;
    case 'received':
    case 'quick_received': {
      const units = `${e.type === 'quick_received' ? 'Bought and received' : 'Received'} ${plural(e.units ?? 0, 'unit')}`;
      return [units, e.damaged ? `${formatCount(e.damaged)} damaged` : null, who].filter(Boolean).join(' · ');
    }
    case 'payment_recorded':
      return e.amount === null ? 'Payment recorded' : `Payment ${formatBdt(e.amount)} recorded`;
    case 'payment_deleted':
      return e.amount === null ? 'Payment removed' : `Payment ${formatBdt(e.amount)} removed`;
    case 'closed':
      return `Closed${by} · rest no longer expected`;
    case 'cancelled':
      return `Cancelled${by}`;
  }
}

// ---------- Inventory ----------

/** A `purchase_order` movement → `{ id, number, supplier }` from its note "PO-0012 · Tangail Weavers". */
export function movementPoRef(m: Pick<StockMovement, 'reference' | 'note'>): { id: string; number: string; supplier: string | null } | null {
  if (m.reference?.type !== 'purchase_order') return null;
  const [number, ...rest] = (m.note ?? '').split(' · ');
  return { id: m.reference.id, number: number || 'purchase order', supplier: rest.join(' · ') || null };
}

/** Reorder item copy (35:5619): "8 left · Sells out in 5 days" / "0 left · Out of stock". */
export function sellsOutText(i: Pick<ReorderSuggestionItem, 'available' | 'days_left'>): string {
  const left = `${formatCount(Math.max(0, i.available))} left`;
  return i.available <= 0 || i.days_left <= 0 ? `${left} · Out of stock` : `${left} · Sells out in ${i.days_left} ${i.days_left === 1 ? 'day' : 'days'}`;
}

export function purchasingLocked(features: FeatureAccess | undefined): boolean {
  return !!features && features.features.purchasing === false;
}

/** Supplier "You owe" tone: red when overdue, warning when owed, muted when nothing/credit. */
export function owedTone(s: Pick<Supplier, 'owed_amount' | 'overdue_amount'>): 'danger' | 'primary' | 'muted' {
  if (s.overdue_amount > 0) return 'danger';
  return s.owed_amount > 0 ? 'primary' : 'muted';
}

// ---------- Forms (§8.3) ----------

const intOrNull = (max: number, label: string) =>
  z
    .number()
    .nullable()
    .refine((v) => v === null || (Number.isInteger(v) && v >= 0 && v <= max), `${label} must be a whole number from 0 to ${max}.`);

export const supplierSchema = z.object({
  name: z.string().trim().min(1, 'Enter the supplier’s name.').max(SUPPLIER_NAME_MAX, `Keep the name under ${SUPPLIER_NAME_MAX} characters.`),
  contact_name: z.string().trim().max(SUPPLIER_NAME_MAX, `Keep the name under ${SUPPLIER_NAME_MAX} characters.`),
  phone: z
    .string()
    .trim()
    .refine((v) => v === '' || normalizeBdPhone(v) !== null, 'Enter a Bangladeshi mobile number like 01711-889900.'),
  city: z.string().trim().max(SUPPLIER_CITY_MAX, `Keep it under ${SUPPLIER_CITY_MAX} characters.`),
  supplies: z.string().trim().max(SUPPLIER_SUPPLIES_MAX, `Keep it under ${SUPPLIER_SUPPLIES_MAX} characters.`),
  payment_terms_days: intOrNull(SUPPLIER_TERMS_DAYS_MAX, 'Payment terms'),
  advance_percent: intOrNull(100, 'Advance'),
  lead_time_days: intOrNull(SUPPLIER_LEAD_TIME_DAYS_MAX, 'Lead time'),
  pays_by_method: z.enum(['', ...SUPPLIER_PAYMENT_METHODS] as [string, ...string[]]),
  pays_by_account: z.string().trim().max(SUPPLIER_ACCOUNT_MAX, `Keep it under ${SUPPLIER_ACCOUNT_MAX} characters.`),
  notes: z.string().trim().max(SUPPLIER_NOTES_MAX, `Keep the notes under ${SUPPLIER_NOTES_MAX} characters.`),
});
export type SupplierValues = z.input<typeof supplierSchema>;

export const emptySupplier = (): SupplierValues => ({
  name: '',
  contact_name: '',
  phone: '',
  city: '',
  supplies: '',
  payment_terms_days: null,
  advance_percent: null,
  lead_time_days: null,
  pays_by_method: '',
  pays_by_account: '',
  notes: '',
});

export const supplierValuesOf = (s: Supplier): SupplierValues => ({
  name: s.name,
  contact_name: s.contact_name ?? '',
  phone: s.phone ? `0${s.phone.slice(3)}` : '',
  city: s.city ?? '',
  supplies: s.supplies ?? '',
  payment_terms_days: s.payment_terms_days,
  advance_percent: s.advance_percent,
  lead_time_days: s.lead_time_days,
  pays_by_method: s.pays_by_method ?? '',
  pays_by_account: s.pays_by_account ?? '',
  notes: s.notes ?? '',
});

const nul = (s: string) => s.trim() || null;

export function supplierInputOf(v: SupplierValues): SupplierInput {
  return {
    name: v.name.trim(),
    contact_name: nul(v.contact_name),
    phone: v.phone.trim() ? normalizeBdPhone(v.phone) : null,
    city: nul(v.city),
    supplies: nul(v.supplies),
    payment_terms_days: v.payment_terms_days,
    advance_percent: v.advance_percent,
    lead_time_days: v.lead_time_days,
    pays_by_method: (v.pays_by_method || null) as SupplierPaymentMethod | null,
    pays_by_account: nul(v.pays_by_account),
    notes: nul(v.notes),
  };
}

const money = (required: string, max: number, maxText: string) =>
  z
    .number({ error: () => 'Enter an amount like 1100 or 1100.50.' })
    .nullable()
    .refine((v) => v === null || Number.isFinite(v), 'Enter an amount like 1100 or 1100.50.')
    .refine((v) => v !== null, required)
    .refine((v) => v === null || !Number.isFinite(v) || v <= max, maxText);

export function paymentSchema(today: string) {
  return z.object({
    amount: money('Enter the amount.', SUPPLIER_PAYMENT_AMOUNT_MAX, 'That amount is too large.').refine((v) => v === null || !Number.isFinite(v) || v >= 1, 'The amount must be more than ৳ 0.'),
    method: z.enum(SUPPLIER_PAYMENT_METHODS as unknown as [SupplierPaymentMethod, ...SupplierPaymentMethod[]]),
    paid_on: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date.')
      .refine((d) => d >= PURCHASING_MIN_DATE, 'Pick a date from 2020 onwards.')
      .refine((d) => d <= today, 'The date can’t be in the future.'),
    purchase_order_id: z.string(),
    note: z.string().trim().max(SUPPLIER_PAYMENT_NOTE_MAX, `Keep the note under ${SUPPLIER_PAYMENT_NOTE_MAX} characters.`),
  });
}
export type PaymentValues = z.input<ReturnType<typeof paymentSchema>>;

export function poFormSchema(today: string) {
  return z
    .object({
      supplier_id: z.string().min(1, 'Choose a supplier.'),
      expected_on: z
        .string()
        .refine((d) => d === '' || /^\d{4}-\d{2}-\d{2}$/.test(d), 'Pick a date.')
        .refine((d) => d === '' || d >= today, 'Pick today or a later date.')
        .refine((d) => d === '' || d <= addDays(today, 365), 'Pick a date within a year.'),
      shipping_amount: money('Enter 0 if there is no transport cost.', PURCHASE_UNIT_COST_MAX, 'That amount is too large.'),
      discount_amount: money('Enter 0 if there is no discount.', PURCHASE_UNIT_COST_MAX, 'That amount is too large.'),
      notes: z.string().max(PURCHASE_ORDER_NOTES_MAX, `Keep the note under ${PURCHASE_ORDER_NOTES_MAX} characters.`),
      lines: z
        .array(
          z.object({
            variant_id: z.string(),
            unit_cost_amount: money('Enter the unit cost.', PURCHASE_UNIT_COST_MAX, 'That cost is too large.'),
            quantity: z
              .number({ error: () => 'Enter a quantity.' })
              .nullable()
              .refine((v) => v !== null && Number.isInteger(v) && v >= 1, 'At least 1.')
              .refine((v) => v === null || v <= PURCHASE_LINE_QUANTITY_MAX, `At most ${formatCount(PURCHASE_LINE_QUANTITY_MAX)}.`),
          }),
        )
        .min(1, 'Add at least one product.'),
    })
    .superRefine((v, ctx) => {
      const t = poTotals(v.lines, v.shipping_amount, v.discount_amount);
      if (t.discount > t.subtotal + t.shipping) ctx.addIssue({ code: 'custom', path: ['discount_amount'], message: 'The discount can’t be more than the items plus transport.' });
    });
}
export type PoFormValues = z.input<ReturnType<typeof poFormSchema>>;

/** Whole-number text → number (Bangla digits allowed); empty → null; anything else → NaN. */
export function parseQty(text: string): number | null {
  const t = text.replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d))).trim();
  if (t === '') return null;
  return /^\d{1,6}$/.test(t) ? Number(t) : Number.NaN;
}

// ---------- Errors and reorder ----------

/**
 * Maps purchasing write errors to copy (§8.4). A 402 opens the plan dialog and returns null. 409 `revision_mismatch` /
 * `invalid_state_transition` ask for a reload.
 */
export function purchasingError(e: unknown, fallback: string): string | null {
  if (handlePlanLimit(e)) return null;
  if (isApiError(e)) {
    if (e.code === 'revision_mismatch' || e.code === 'revision_conflict') return 'This purchase order was changed by someone else. Reload the page and try again.';
    if (e.code === 'invalid_state_transition') return 'This purchase order has moved on. Reload the page to see its current status.';
    if (e.code === 'over_receive') return 'You’re receiving more than is left on a line. Check the quantities.';
    if (e.code === 'variant_not_tracked') return 'One of the products doesn’t track stock. Turn on stock tracking for it first.';
    if (e.code === 'supplier_in_use') return 'This supplier has purchase orders or payments. Archive it instead.';
    if (e.status === 422) return e.message || fallback;
  }
  return errorMessage(e, fallback);
}


/** Items that can go on a draft: groups with a supplier. */
export function orderableCount(groups: ReorderSuggestionGroup[]): number {
  return groups.filter((g) => g.supplier).reduce((n, g) => n + g.items.length, 0);
}

