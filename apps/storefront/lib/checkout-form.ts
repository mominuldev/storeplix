import { z } from 'zod';
import type { BdDistrict, BdGeo, BdThana, CheckoutInput, GatewayProvider, PaymentMethod } from '@storeplix/types';

/**
 * Checkout form rules (PHASE-5-CONTRACT §3.4, §2.1), shared by the client form (instant feedback)
 * and the `placeOrder` Server Action (authoritative before the API call). Pure.
 */

export const PHONE_MESSAGE = 'Enter a Bangladeshi mobile number (01XXXXXXXXX).';

/** `01712-345678`, `+8801712345678`, `8801712345678` → `8801712345678`; anything else → null. */
export function normalizeBdPhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/[\s().-]/g, '');
  const m = /^(?:\+?880|0)?(1[3-9]\d{8})$/.exec(digits);
  return m ? `880${m[1]}` : null;
}

/** `8801712345678` → `01712-345678` for display. */
export function formatBdPhone(msisdn: string): string {
  const m = /^880(1\d{3})(\d{6})$/.exec(msisdn);
  return m ? `0${m[1]}-${m[2]}` : msisdn;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (v: unknown) => (typeof v === 'string' ? v.replace(CONTROL, '').trim() : '');
const optional = (max: number, message: string) =>
  z
    .unknown()
    .optional()
    .transform(clean)
    .pipe(z.string().max(max, message))
    .transform((v) => (v === '' ? null : v));

export const CheckoutFormSchema = z.object({
  name: z.unknown().optional().transform(clean).pipe(z.string().min(2, 'Enter your full name.').max(120, 'Keep your name under 120 characters.')),
  phone: z
    .unknown()
    .optional()
    .transform((v) => normalizeBdPhone(v) ?? '')
    .pipe(z.string().min(1, PHONE_MESSAGE)),
  email: z
    .unknown()
    .optional()
    .transform((v) => clean(v).toLowerCase())
    .pipe(z.union([z.literal(''), z.email('Enter a valid email address.').max(254)]))
    .transform((v) => (v === '' ? null : v)),
  district_code: z.unknown().optional().transform(clean).pipe(z.string().min(1, 'Choose your district.').max(48)),
  thana_code: z.unknown().optional().transform(clean).pipe(z.string().min(1, 'Choose your upazila or thana.').max(48)),
  area: optional(120, 'Keep the area under 120 characters.'),
  address_line: z
    .unknown()
    .optional()
    .transform(clean)
    .pipe(z.string().min(5, 'Enter your house, road and flat.').max(255, 'Keep the address under 255 characters.')),
  landmark: optional(160, 'Keep the landmark under 160 characters.'),
  label: z
    .unknown()
    .optional()
    .transform((v) => (v === 'home' || v === 'office' ? v : null)),
  customer_note: optional(500, 'Keep the note under 500 characters.'),
});

export type CheckoutForm = z.output<typeof CheckoutFormSchema>;
export type CheckoutField = keyof CheckoutForm;
export type FieldErrors = Partial<Record<CheckoutField, string>>;

export function validateCheckoutForm(input: Record<string, unknown>): { ok: true; data: CheckoutForm } | { ok: false; errors: FieldErrors } {
  const r = CheckoutFormSchema.safeParse(input);
  if (r.success) return { ok: true, data: r.data };
  const errors: FieldErrors = {};
  for (const issue of r.error.issues) {
    const key = issue.path[0] as CheckoutField | undefined;
    if (key && !errors[key]) errors[key] = issue.message;
  }
  return { ok: false, errors };
}

export interface CheckoutPayment {
  method: PaymentMethod;
  /** COD with the delivery charge paid in advance (P5B-13); ignored for online methods. */
  advanceGateway?: GatewayProvider | null;
}

export function toCheckoutInput(form: CheckoutForm, expectedTotal: number, payment: CheckoutPayment = { method: 'cod' }): CheckoutInput {
  const input: CheckoutInput = {
    contact: { name: form.name, phone: form.phone, email: form.email },
    shipping_address: {
      district_code: form.district_code,
      thana_code: form.thana_code,
      area: form.area,
      address_line: form.address_line,
      landmark: form.landmark,
      label: form.label,
    },
    payment_method: payment.method,
    customer_note: form.customer_note,
    expected_total_amount: expectedTotal,
  };
  if (payment.method === 'cod' && payment.advanceGateway) input.advance_gateway = payment.advanceGateway;
  return input;
}

/** API `details` keys (`contact.phone`, `shipping_address.thana_code`, …) → form fields. */
const DETAIL_FIELDS: Record<string, CheckoutField> = {
  'contact.name': 'name',
  'contact.phone': 'phone',
  'contact.email': 'email',
  'shipping_address.district_code': 'district_code',
  'shipping_address.thana_code': 'thana_code',
  'shipping_address.area': 'area',
  'shipping_address.address_line': 'address_line',
  'shipping_address.landmark': 'landmark',
  'shipping_address.label': 'label',
  customer_note: 'customer_note',
};

export function mapDetailsToFields(details: Record<string, string[]>): { fields: FieldErrors; other: string[] } {
  const fields: FieldErrors = {};
  const other: string[] = [];
  for (const [key, msgs] of Object.entries(details)) {
    const field = DETAIL_FIELDS[key];
    if (field && !fields[field]) fields[field] = msgs[0];
    else if (!field) other.push(...msgs);
  }
  return { fields, other };
}

// ---------- geo cascade ----------
export function districtsOf(geo: BdGeo, divisionCode: string): BdDistrict[] {
  return geo.districts.filter((d) => d.division_code === divisionCode).sort((a, b) => a.name.localeCompare(b.name));
}

/** City (metropolitan) thanas first, then upazilas, each alphabetical. */
export function thanasOf(geo: BdGeo, districtCode: string): BdThana[] {
  return geo.thanas
    .filter((t) => t.district_code === districtCode)
    .sort((a, b) => Number(b.is_city) - Number(a.is_city) || a.name.localeCompare(b.name));
}

export function divisionOfDistrict(geo: BdGeo, districtCode: string): string {
  return geo.districts.find((d) => d.code === districtCode)?.division_code ?? '';
}

/** Idempotency-Key format accepted by the API (UUID/ULID, ≤ 64). */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9-]{16,64}$/;
