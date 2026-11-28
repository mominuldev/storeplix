import type { GatewayProvider, PaymentMethod, StorefrontOrder, StorefrontPaymentState } from '@storeplix/types';
import { formatMoney } from './format';

/**
 * Online payment helpers (PHASE-5B-CONTRACT §11, P5B-12/13/17). Pure and client-safe: no tokens,
 * no server-only imports. Used by the checkout form, the payment-result and pay pages.
 */

export const GATEWAYS: readonly GatewayProvider[] = ['bkash', 'nagad', 'sslcommerz'];
/** PHASE-8-9D §9.6: Nagad sits next to bKash; offered only when the API lists it (connected and enabled). */
const METHOD_ORDER: readonly PaymentMethod[] = ['cod', 'bkash', 'nagad', 'sslcommerz'];

/** Shopper-facing names (P5B-12): SSLCommerz is shown as "Card or mobile banking". */
export const METHOD_LABEL: Record<PaymentMethod, string> = {
  cod: 'Cash on delivery',
  bkash: 'bKash',
  sslcommerz: 'Card or mobile banking',
  // PHASE-8-9D §9.6: offered when `config.commerce.payment_methods` includes it.
  nagad: 'Nagad',
};

export const METHOD_HINT: Record<PaymentMethod, string> = {
  cod: 'Pay in cash when the parcel arrives',
  bkash: 'Pay now from your bKash app',
  sslcommerz: 'Visa, Mastercard, Nagad, Rocket and more',
  nagad: 'Pay now from your Nagad app',
};

/** "with bKash" / "by card or mobile banking" for result lines. */
export function paidWith(provider: GatewayProvider): string {
  return provider === 'sslcommerz' ? 'by card or mobile banking' : `with ${METHOD_LABEL[provider]}`;
}

/** "bKash" / "Nagad" / "card or mobile banking" inside sentences ("Pay ৳ 1,200 with …", "Try again with …"). */
export function gatewayPhrase(provider: GatewayProvider): string {
  return provider === 'sslcommerz' ? 'card or mobile banking' : METHOD_LABEL[provider];
}

/** "Taking you to bKash…" / "…to Nagad…" / "…to the payment page…". */
export function redirectTarget(provider: GatewayProvider): string {
  return provider === 'sslcommerz' ? 'the payment page' : METHOD_LABEL[provider];
}

/** What happens after the shopper places an online order with this gateway (checkout note). */
export function gatewayNote(provider: GatewayProvider): string {
  if (provider === 'bkash') return "You'll approve the payment in bKash, then come back here.";
  if (provider === 'nagad') return "You'll approve the payment on Nagad's secure page, then come back here.";
  return "You'll pay on the secure SSLCommerz page, then come back here.";
}

export const isGateway = (m: unknown): m is GatewayProvider => m === 'bkash' || m === 'sslcommerz' || m === 'nagad';
export const isPaymentMethod = (m: unknown): m is PaymentMethod => m === 'cod' || isGateway(m);

/** Methods the storefront offers or advertises (cart "Pay with", footer badges). */
export const isOfferedMethod = (m: PaymentMethod): boolean => (METHOD_ORDER as readonly string[]).includes(m);

/** Methods to offer at checkout, in a fixed order; an old/empty config falls back to COD only. */
export function checkoutMethods(fromConfig: readonly PaymentMethod[] | null | undefined): PaymentMethod[] {
  const set = new Set(fromConfig ?? []);
  const list = METHOD_ORDER.filter((m) => set.has(m));
  return list.length > 0 ? list : ['cod'];
}

/** P5B-13: a COD order with a delivery charge pays that charge online first when the shop asks for it. */
export function advanceRequired(codAdvance: 'none' | 'delivery_charge', method: PaymentMethod, shippingAmount: number | null): boolean {
  return codAdvance === 'delivery_charge' && method === 'cod' && (shippingAmount ?? 0) > 0;
}

/** What the order screens say about money (thank-you and payment result). */
export type OrderPaymentLine =
  | { kind: 'cod'; text: string }
  | { kind: 'paid'; text: string; dueText: string | null }
  | { kind: 'awaiting'; text: string }
  | { kind: 'failed'; text: string };

export function orderPaymentLine(order: Pick<StorefrontOrder, 'status' | 'due_amount' | 'paid_amount' | 'currency' | 'payment'>): OrderPaymentLine {
  const c = order.currency;
  const p = order.payment;
  if (p && p.status === 'succeeded') {
    return {
      kind: 'paid',
      text: `Paid ${formatMoney(p.amount, c)} ${paidWith(p.provider)}`,
      dueText: order.due_amount > 0 ? `Pay ${formatMoney(order.due_amount, c)} in cash when it arrives` : null,
    };
  }
  if (order.status === 'pending_payment' && p) {
    if (p.status === 'pending') return { kind: 'awaiting', text: `Waiting for your ${formatMoney(p.amount, c)} payment ${paidWith(p.provider)}` };
    return { kind: 'failed', text: "Payment didn't go through" };
  }
  if (order.paid_amount > 0) {
    return {
      kind: 'paid',
      text: `Paid ${formatMoney(order.paid_amount, c)}`,
      dueText: order.due_amount > 0 ? `Pay ${formatMoney(order.due_amount, c)} in cash when it arrives` : null,
    };
  }
  return { kind: 'cod', text: `Pay ${formatMoney(order.due_amount, c)} in cash when it arrives` };
}

/** Retry / switch-to-COD choices for an unpaid `pending_payment` order (P5B-17). */
export function retryOptions(order: Pick<StorefrontOrder, 'status'> & { payment: StorefrontPaymentState | null }): { retry: GatewayProvider | null; cod: boolean } {
  const p = order.payment;
  if (order.status !== 'pending_payment' || !p || p.status === 'succeeded') return { retry: null, cod: false };
  return { retry: p.can_retry ? p.provider : null, cod: p.can_switch_to_cod };
}

/** Minutes left on the order hold (null when there is none or it has passed). */
export function holdMinutesLeft(expiresAt: string | null, now = Date.now()): number | null {
  if (!expiresAt) return null;
  const ms = Date.parse(expiresAt) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 60_000) : null;
}

// ---------- pending payment polling (§11: every 2 s, stop at 30 s) ----------
export type PolledStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled';
export const POLL_INTERVAL_MS = 2000;
export const POLL_MAX_MS = 30_000;

export interface PollerDeps {
  /** One status read; null = transient error (keep polling). */
  fetchStatus: (signal: AbortSignal) => Promise<PolledStatus | null>;
  onSettled: (status: Exclude<PolledStatus, 'pending'>) => void;
  onTimeout: () => void;
  intervalMs?: number;
  maxMs?: number;
}

/**
 * Polls until the payment settles or `maxMs` passes (then `onTimeout`, no more requests). Returns
 * a stop function for unmount. One request at a time: the next one is scheduled after the previous
 * answer, so a slow API never stacks requests.
 */
export function startPaymentPoller({ fetchStatus, onSettled, onTimeout, intervalMs = POLL_INTERVAL_MS, maxMs = POLL_MAX_MS }: PollerDeps): () => void {
  const ctrl = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = setTimeout(() => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    ctrl.abort();
    onTimeout();
  }, maxMs);

  const tick = async () => {
    if (stopped) return;
    const status = await fetchStatus(ctrl.signal).catch(() => null);
    if (stopped) return;
    if (status && status !== 'pending') {
      stopped = true;
      clearTimeout(deadline);
      onSettled(status);
      return;
    }
    timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);

  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(deadline);
    ctrl.abort();
  };
}
