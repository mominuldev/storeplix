import type { BadgeTone } from '@storeplix/ui';
import type { GatewayProvider, IntegrationMode, IntegrationStatus, Order, OrderPaymentMethod, Payment, PaymentGatewayAccount, PaymentLink, PaymentLinkAmountKind, PaymentPurpose } from '@storeplix/types';

// Phase 5b-2 payment gateway copy and pure helpers (PHASE-5B §1.B, §4.1, §10; Figma 14:980, 32:3770, 52:564).

export interface CredentialField {
  key: string;
  label: string;
  max: number;
  secret: boolean;
  placeholder?: string;
  hint?: string;
}

export const GATEWAYS: GatewayProvider[] = ['bkash', 'sslcommerz'];

export const gatewayMeta: Record<
  GatewayProvider,
  {
    name: string;
    short: string;
    /** Integrations card capability line (14:980). */
    capability: string;
    /** Onboarding 07 card hint (52:564). */
    onboardingHint: string;
    /** How the storefront names it (P5B-12). */
    checkoutLabel: string;
    checkoutHint: string;
    portalHint: string;
    applyNote: string;
    moneyTo: string;
    fields: CredentialField[];
  }
> = {
  bkash: {
    name: 'bKash Payment Gateway',
    short: 'bKash',
    capability: 'Tokenized checkout, refunds',
    onboardingHint: 'Customers pay from their bKash app · settles to your bKash merchant account',
    checkoutLabel: 'bKash',
    checkoutHint: 'Pay now from your bKash app',
    portalHint: 'Find these in the bKash merchant portal → Tokenized Checkout → Credentials.',
    applyNote: 'Apply at bKash with your trade licence and DBID. We’ll guide you.',
    moneyTo: 'your bKash merchant wallet',
    fields: [
      { key: 'app_key', label: 'App key', max: 64, secret: false },
      { key: 'app_secret', label: 'App secret', max: 128, secret: true },
      { key: 'username', label: 'Username', max: 64, secret: false },
      { key: 'password', label: 'Password', max: 128, secret: true, placeholder: 'e.g. bKash API password', hint: 'Shown once in the portal' },
    ],
  },
  sslcommerz: {
    name: 'SSLCommerz',
    short: 'SSLCommerz',
    capability: 'Cards, mobile banking, net banking',
    onboardingHint: 'Cards, Nagad, Rocket & net banking · settles to your bank',
    checkoutLabel: 'Card or mobile banking',
    checkoutHint: 'Visa, Mastercard, Nagad, Rocket',
    portalHint: 'Find these in the email SSLCommerz sent when your store was approved, or in the merchant panel.',
    applyNote: 'Apply at SSLCommerz with your trade licence and bank details. We’ll guide you.',
    moneyTo: 'your bank account',
    fields: [
      { key: 'store_id', label: 'Store ID', max: 64, secret: false },
      { key: 'store_passwd', label: 'Store password', max: 128, secret: true },
    ],
  },
};

export const modeLabel: Record<IntegrationMode, string> = { sandbox: 'Sandbox', live: 'Live mode' };

export function integrationStatusMeta(status: IntegrationStatus): { label: string; tone: BadgeTone } {
  if (status === 'connected') return { label: 'Connected', tone: 'success' };
  if (status === 'error') return { label: 'Needs attention', tone: 'danger' };
  return { label: 'Not connected', tone: 'neutral' };
}

export const isConnected = (a: Pick<PaymentGatewayAccount, 'status'> | undefined) => a?.status === 'connected';
export const isUsable = (a: Pick<PaymentGatewayAccount, 'status' | 'enabled'> | undefined) => isConnected(a) && !!a?.enabled;

/** Always one entry per provider, in display order (absent ones come back `not_connected` from the API). */
export function byProvider(list: PaymentGatewayAccount[] | undefined): Record<GatewayProvider, PaymentGatewayAccount | undefined> {
  return { bkash: list?.find((a) => a.provider === 'bkash'), sslcommerz: list?.find((a) => a.provider === 'sslcommerz') };
}

/** Gateways a payment link can use: connected and enabled, default first. */
export function linkGateways(list: PaymentGatewayAccount[] | undefined): PaymentGatewayAccount[] {
  return (list ?? []).filter(isUsable).sort((a, b) => Number(b.is_default) - Number(a.is_default));
}

/** Phase 8.8d: a till sale's method is `pos` (the payments card says how it was paid). */
export function paymentMethodLabel(m: OrderPaymentMethod): string {
  if (m === 'pos') return 'POS';
  return m === 'cod' ? 'Cash on delivery' : gatewayMeta[m].checkoutLabel;
}

export const isGateway = (p: string): p is GatewayProvider => p === 'bkash' || p === 'sslcommerz';

export const purposeLabel: Record<PaymentPurpose, string> = {
  order: 'Paid online',
  advance: 'Advance',
  link: 'Payment link',
  exchange: 'Exchange difference',
  test: 'Test payment',
};

export function chargeStateLabel(p: Pick<Payment, 'status'>): { label: string; tone: BadgeTone } {
  switch (p.status) {
    case 'succeeded':
      return { label: 'Paid', tone: 'success' };
    case 'pending':
      return { label: 'Waiting', tone: 'warning' };
    case 'failed':
      return { label: 'Failed', tone: 'danger' };
    default:
      return { label: 'Cancelled', tone: 'neutral' };
  }
}

/** Online money still refundable on an order (succeeded gateway charges minus what was refunded on each). */
export function onlineRefundable(payments: Payment[]): { amount: number; provider: GatewayProvider | null } {
  const charges = payments.filter((p) => p.type === 'charge' && p.status === 'succeeded' && isGateway(p.provider) && p.purpose !== 'test');
  const amount = charges.reduce((sum, p) => sum + Math.max(0, p.amount - (p.refunded_amount ?? 0)), 0);
  const provider = (charges.find((p) => p.amount - (p.refunded_amount ?? 0) > 0)?.provider ?? null) as GatewayProvider | null;
  return { amount, provider };
}

// ---------- Ask for an advance (144:46081, P5B-22) ----------

/** Statuses that can take a payment link (P5B-22). */
export const LINK_STATUSES: Order['status'][] = ['pending', 'confirmed', 'ready_to_ship'];

export function activeLink(order: Pick<Order, 'payment_links'>): PaymentLink | undefined {
  return (order.payment_links ?? []).find((l) => l.status === 'active');
}

export const LINK_EXPIRY = [
  { minutes: 120, label: '2 hours' },
  { minutes: 360, label: '6 hours' },
  { minutes: 1440, label: '24 hours' },
  { minutes: 2880, label: '48 hours' },
] as const;
export type LinkExpiry = (typeof LINK_EXPIRY)[number]['minutes'];

export const DEFAULT_PERCENT_BPS = 2500;

/**
 * Amount the link asks for (paisa), or null when the choice isn't valid yet. Mirrors P5B-22: delivery charge =
 * `shipping_amount`, percent of the due amount (rounded to the paisa; the API is authoritative), full = due, custom
 * as typed. The API re-computes and returns the final `amount`.
 */
export function advanceAmount(kind: PaymentLinkAmountKind, order: { due_amount: number; shipping_amount: number }, percentBps: number | null, custom: number | null): number | null {
  switch (kind) {
    case 'delivery_charge':
      return order.shipping_amount > 0 ? Math.min(order.shipping_amount, order.due_amount) : null;
    case 'percent':
      return percentBps && percentBps > 0 && percentBps < 10_000 ? Math.floor((order.due_amount * percentBps) / 10_000) /* same as the API: floor to the paisa */ : null;
    case 'full':
      return order.due_amount;
    case 'custom':
      return custom;
  }
}

/** Validation for the editable parts: % between 1 and 99, custom between ৳ 1 and the due amount. */
export function advanceError(kind: PaymentLinkAmountKind, order: { due_amount: number; shipping_amount: number }, percentBps: number | null, custom: number | null, fmt: (paisa: number) => string): string | null {
  if (kind === 'delivery_charge' && order.shipping_amount <= 0) return 'This order has no delivery charge.';
  if (kind === 'percent' && (percentBps === null || percentBps < 100 || percentBps > 9_900)) return 'Use a percentage between 1 and 99.';
  if (kind === 'custom') {
    if (custom === null || !Number.isFinite(custom)) return 'Enter an amount.';
    if (custom < 100) return `Ask for at least ${fmt(100)}.`;
    if (custom > order.due_amount) return `Up to ${fmt(order.due_amount)} — what’s still due.`;
  }
  return null;
}

/** P5B-28 shopper SMS (fixed template), with the real URL once the link exists. Amount as plain taka. */
export function paymentLinkSms(lang: 'bn' | 'en', shop: string, number: string, amount: number, url: string): string {
  const tk = (amount / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  return lang === 'bn' ? `${shop}: অর্ডার ${number} নিশ্চিত করতে ${tk} টাকা পরিশোধ করুন: ${url}` : `${shop}: Pay Tk ${tk} to confirm order ${number}: ${url}`;
}

/** "1 h 40 min left" for an active link or a payment hold. */
export function timeLeft(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const ms = Date.parse(iso) - now;
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'expired';
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${min} min left`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min left` : `${h} h left`;
}
