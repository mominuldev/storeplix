'use server';

import { cookies } from 'next/headers';
import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import type { StorefrontTracking } from '@/lib/tracking';
import {
  addCartItem,
  deleteCoupon,
  postOrderPay,
  postPaymentLinkPay,
  getProduct,
  listProducts,
  postCheckout,
  postTrack,
  putCartContact,
  putCoupon,
  removeCartItem,
  updateCartItem,
  type ApiResult,
  type CartCall,
} from '@/lib/commerce-api';
import { clearCartCookie, getCommerceContext, getOrderToken, setCartCookie, setOrderCookie } from '@/lib/commerce-context';
import { COUPON_CODE_RE, FLASH_COOKIE, PENDING_COUPON_COOKIE, commerceCookieOptions } from '@/lib/commerce-request';
import { PAY_LINK_TOKEN_RE, type CartEnvelope } from '@/lib/commerce-schemas';
import { isGateway, isPaymentMethod } from '@/lib/payments';
import { errorMessage } from '@/lib/commerce-messages';
import { IDEMPOTENCY_KEY_RE, mapDetailsToFields, normalizeBdPhone, toCheckoutInput, validateCheckoutForm, type FieldErrors } from '@/lib/checkout-form';
import { catalogApiQuery, parseCatalogState } from '@/lib/catalog-query';
import { toCardView, type ProductCardView } from '@/lib/products';
import { isLocalDevHost } from '@/lib/seo';

/**
 * Storefront mutations (PHASE-5-CONTRACT §5, P5-29): Server Actions only, so Next's origin check
 * protects them (S12). Every input is validated with Zod before the API call; results are typed
 * and never contain tokens.
 */

const NOT_OPEN = "This shop isn't taking orders yet.";
const ItemId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const Quantity = z.number().int().min(1).max(99);

/**
 * `redirect` is followed by the client (router.push). A `redirect()` thrown from these actions
 * rendered the target as the platform "Store not found" page in local testing (the tenant host
 * was not resolved for the redirected render), so actions return the target instead.
 */
export type CartActionResult = { ok: true; linesCount: number; notices: string[]; redirect?: string } | { ok: false; message: string; redirect?: string };

const fail = (r: Extract<ApiResult<unknown>, { ok: false }>): CartActionResult => ({ ok: false, message: errorMessage(r) });

async function afterCartWrite(call: CartCall, r: ApiResult<CartEnvelope>): Promise<CartActionResult> {
  if (!r.ok) {
    if (r.code === 'cart_not_found') await clearCartCookie();
    return fail(r);
  }
  const notices = [...(r.data.meta.notices ?? [])];
  let lines = r.data.cart.lines_count;
  if (r.data.meta.cart_token) {
    await setCartCookie(call.host, r.data.meta.cart_token);
    // A /discount/{CODE} link opened before the cart existed: attach the code now.
    const jar = await cookies();
    const pending = jar.get(PENDING_COUPON_COOKIE)?.value;
    if (pending) {
      jar.delete(PENDING_COUPON_COOKIE);
      if (COUPON_CODE_RE.test(pending)) {
        const c = await putCoupon({ ...call, cartToken: r.data.meta.cart_token }, pending);
        notices.push(c.ok ? `Code ${pending} will apply at checkout.` : `Code ${pending}: ${errorMessage(c)}`);
        if (c.ok) lines = c.data.cart.lines_count;
      }
    }
  }
  return { ok: true, linesCount: lines, notices };
}

const AddInput = z.object({ variantId: ItemId, quantity: Quantity });

export async function addToCart(input: { variantId: string; quantity: number }): Promise<CartActionResult> {
  const parsed = AddInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Choose an option and a quantity from 1 to 99.' };
  const ctx = await getCommerceContext();
  if (!ctx) return { ok: false, message: NOT_OPEN };
  return afterCartWrite(ctx.call, await addCartItem(ctx.call, parsed.data.variantId, parsed.data.quantity));
}

/** "Buy now — cash on delivery": add, then straight to checkout. */
export async function buyNow(input: { variantId: string; quantity: number }): Promise<CartActionResult> {
  const result = await addToCart(input);
  return result.ok ? { ...result, redirect: '/checkout' } : result;
}

/**
 * Card "Add to cart": the card payload has no variants, so the product is read server-side. A
 * single-variant product adds its variant; a product with options goes to its PDP to choose.
 */
export async function quickAdd(slug: string): Promise<CartActionResult> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 200) return { ok: false, message: 'This item isn’t available.' };
  const ctx = await getCommerceContext();
  if (!ctx) return { ok: false, message: NOT_OPEN };
  const product = await getProduct(ctx.store.host, slug, ctx.call.previewToken);
  if (!product) return { ok: false, message: 'This item isn’t available.' };
  if (product.variants.length > 1) return { ok: false, message: '', redirect: `/products/${product.slug}` };
  const [cheapest] = [...product.variants].sort((a, b) => a.price_amount - b.price_amount);
  return afterCartWrite(ctx.call, await addCartItem(ctx.call, cheapest!.id, 1));
}

export async function updateLine(input: { itemId: string; quantity: number }): Promise<CartActionResult> {
  const parsed = z.object({ itemId: ItemId, quantity: Quantity }).safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Choose a quantity from 1 to 99.' };
  const ctx = await getCommerceContext();
  if (!ctx?.call.cartToken) return { ok: false, message: errorMessage({ code: 'cart_not_found', message: '', details: {} }) };
  const result = await afterCartWrite(ctx.call, await updateCartItem(ctx.call, parsed.data.itemId, parsed.data.quantity));
  refresh();
  return result;
}

export async function removeLine(input: { itemId: string }): Promise<CartActionResult> {
  const parsed = z.object({ itemId: ItemId }).safeParse(input);
  if (!parsed.success) return { ok: false, message: 'This line no longer exists.' };
  const ctx = await getCommerceContext();
  if (!ctx?.call.cartToken) return { ok: false, message: errorMessage({ code: 'cart_not_found', message: '', details: {} }) };
  const result = await afterCartWrite(ctx.call, await removeCartItem(ctx.call, parsed.data.itemId));
  refresh();
  return result;
}

export type CouponState = { status: 'idle' } | { status: 'error'; message: string } | { status: 'ok'; message: string };

const normalizeCode = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : '');

export async function applyCoupon(_prev: CouponState, formData: FormData): Promise<CouponState> {
  const code = normalizeCode(formData.get('code'));
  if (!COUPON_CODE_RE.test(code)) return { status: 'error', message: "This code doesn't exist." };
  const ctx = await getCommerceContext();
  if (!ctx?.call.cartToken) return { status: 'error', message: 'Add something to your bag first.' };
  const r = await putCoupon(ctx.call, code);
  if (!r.ok) {
    if (r.code === 'cart_not_found') await clearCartCookie();
    return { status: 'error', message: errorMessage(r) };
  }
  refresh();
  return { status: 'ok', message: `Code ${code} applied.` };
}

export async function removeCoupon(): Promise<CartActionResult> {
  const ctx = await getCommerceContext();
  if (!ctx?.call.cartToken) return { ok: false, message: errorMessage({ code: 'cart_not_found', message: '', details: {} }) };
  const result = await afterCartWrite(ctx.call, await deleteCoupon(ctx.call));
  refresh();
  return result;
}

// ---------- /discount/{CODE} (Q38) ----------
async function setFlash(host: string, tone: 'ok' | 'error', message: string) {
  const secure = process.env.NODE_ENV === 'production' && !isLocalDevHost(host);
  (await cookies()).set(FLASH_COOKIE, JSON.stringify({ tone, message: message.slice(0, 300) }), commerceCookieOptions(60, secure));
}

/** Attaches the code to the cart (or keeps it until the cart exists); the page then goes to `/` only (S14). */
export async function applyDiscountLink(rawCode: string): Promise<void> {
  const code = normalizeCode(rawCode);
  const ctx = await getCommerceContext();
  if (ctx) {
    const host = ctx.store.host;
    if (!COUPON_CODE_RE.test(code)) {
      await setFlash(host, 'error', "This code doesn't exist.");
    } else if (ctx.call.cartToken) {
      const r = await putCoupon(ctx.call, code);
      if (r.ok) await setFlash(host, 'ok', `Code ${code} will apply at checkout.`);
      else if (r.code === 'cart_not_found') await keepPending(host, code);
      else await setFlash(host, 'error', `Code ${code}: ${errorMessage(r)}`);
    } else {
      await keepPending(host, code);
    }
  }
}

async function keepPending(host: string, code: string) {
  const secure = process.env.NODE_ENV === 'production' && !isLocalDevHost(host);
  (await cookies()).set(PENDING_COUPON_COOKIE, code, commerceCookieOptions(7 * 86400, secure));
  await setFlash(host, 'ok', `Code ${code} will apply at checkout.`);
}

export async function dismissFlash(): Promise<void> {
  const jar = await cookies();
  if (jar.has(FLASH_COOKIE)) jar.delete(FLASH_COOKIE);
}

// ---------- checkout ----------
export type CheckoutState = {
  status: 'idle' | 'invalid' | 'changed' | 'error' | 'redirect';
  /** Where the client navigates next (`status: 'redirect'`): thank-you or back to the bag. */
  redirect?: '/checkout/thank-you' | '/cart' | '/cart?changed=stock';
  message: string | null;
  fieldErrors: FieldErrors;
  /** Idempotency key for the next attempt: kept for retries, rotated once a request was decided. */
  idempotencyKey: string;
};

/** Codes after which the same key must not be reused (the API decided; the body will change). */
const ROTATE_KEY = new Set(['checkout_changed', 'idempotency_key_mismatch', 'validation_failed', 'coupon_invalid', 'payment_method_unavailable', 'advance_required', 'store_not_live', 'idempotency_key_required']);

export async function placeOrder(prev: CheckoutState, formData: FormData): Promise<CheckoutState> {
  const sentKey = String(formData.get('idempotency_key') ?? '');
  const key = IDEMPOTENCY_KEY_RE.test(sentKey) ? sentKey : IDEMPOTENCY_KEY_RE.test(prev.idempotencyKey) ? prev.idempotencyKey : crypto.randomUUID();
  const expected = z.coerce.number().int().min(0).max(100_000_000_000).safeParse(formData.get('expected_total_amount'));
  const form = validateCheckoutForm(Object.fromEntries(formData.entries()));
  if (!form.ok) return { status: 'invalid', message: 'Check the highlighted fields.', fieldErrors: form.errors, idempotencyKey: key };
  if (!expected.success) return { status: 'changed', message: 'Your total is out of date. Check your order and place it again.', fieldErrors: {}, idempotencyKey: key };

  const ctx = await getCommerceContext();
  if (!ctx) return { status: 'error', message: NOT_OPEN, fieldErrors: {}, idempotencyKey: key };
  if (!ctx.call.cartToken) return { status: 'redirect', redirect: '/cart', message: null, fieldErrors: {}, idempotencyKey: key };

  const rawMethod = formData.get('payment_method');
  const rawAdvance = formData.get('advance_gateway');
  const method = rawMethod === null || rawMethod === '' ? 'cod' : rawMethod;
  if (!isPaymentMethod(method) || (rawAdvance !== null && rawAdvance !== '' && !isGateway(rawAdvance))) {
    return { status: 'error', message: 'Choose how you want to pay.', fieldErrors: {}, idempotencyKey: key };
  }
  const advanceGateway = isGateway(rawAdvance) ? rawAdvance : null;

  const r = await postCheckout(ctx.call, key, toCheckoutInput(form.data, expected.data, { method, advanceGateway }));
  if (r.ok) {
    await setOrderCookie(ctx.store.host, r.data.confirmation_token);
    await clearCartCookie();
    // Online payment or advance (P5B-15, §5.3): straight to the gateway. The URL was validated at
    // the boundary (absolute https). `initiation_failed` lands on the thank-you page with Retry.
    const payment = r.data.payment;
    if (payment?.status === 'redirect' && payment.redirect_url) redirect(payment.redirect_url);
    return { status: 'redirect', redirect: '/checkout/thank-you', message: null, fieldErrors: {}, idempotencyKey: crypto.randomUUID() };
  }

  const nextKey = ROTATE_KEY.has(r.code) ? crypto.randomUUID() : key;
  switch (r.code) {
    case 'cart_not_found':
      await clearCartCookie();
      return { status: 'redirect', redirect: '/cart', message: null, fieldErrors: {}, idempotencyKey: nextKey };
    case 'out_of_stock':
    case 'cart_empty':
      return { status: 'redirect', redirect: '/cart?changed=stock', message: null, fieldErrors: {}, idempotencyKey: nextKey };
    case 'checkout_changed':
      refresh();
      return {
        status: 'changed',
        message: r.details.expected_total_amount?.[0] ?? (r.message || 'The total changed. Check your order and place it again.'),
        fieldErrors: {},
        idempotencyKey: nextKey,
      };
    case 'coupon_invalid':
    case 'payment_method_unavailable':
      refresh();
      return { status: 'changed', message: errorMessage(r), fieldErrors: {}, idempotencyKey: nextKey };
    case 'validation_failed': {
      const mapped = mapDetailsToFields(r.details);
      return { status: 'invalid', message: mapped.other[0] ?? 'Check the highlighted fields.', fieldErrors: mapped.fields, idempotencyKey: nextKey };
    }
    case 'idempotency_key_in_use':
      return { status: 'error', message: "We're still placing your order. Wait a moment, then try again.", fieldErrors: {}, idempotencyKey: key };
    default:
      return { status: 'error', message: errorMessage(r), fieldErrors: {}, idempotencyKey: nextKey };
  }
}

// ---------- checkout contact (PHASE-8-6 P86-12, §10.6) ----------
const ContactInput = z.object({
  phone: z.string().max(20),
  name: z.string().max(200).optional(),
  email: z.string().max(254).optional(),
});

/**
 * Saves the phone (and name/email once given) on the shopper's cart for checkout recovery. Fire-and-forget: it never
 * throws and returns nothing the form waits on; an invalid phone, a missing cart, a preview or any API error is a no-op.
 */
export async function saveCheckoutContact(input: { phone: string; name?: string; email?: string }): Promise<void> {
  try {
    const parsed = ContactInput.safeParse(input);
    if (!parsed.success) return;
    const phone = normalizeBdPhone(parsed.data.phone);
    if (!phone) return;
    const name = parsed.data.name?.trim().slice(0, 80);
    const email = parsed.data.email?.trim().toLowerCase();
    const ctx = await getCommerceContext();
    if (!ctx || ctx.store.mode === 'preview' || !ctx.call.cartToken) return;
    await putCartContact(ctx.call, {
      phone,
      ...(name ? { name } : {}),
      ...(email && z.email().safeParse(email).success ? { email } : {}),
    });
  } catch {
    // Never surface: checkout must not be blocked or slowed by the contact capture.
  }
}

// ---------- online payments: retry / switch to COD / payment links (5b-2, P5B-17, P5B-23) ----------
export type PayActionResult =
  | { ok: true; redirect: '/checkout/thank-you' }
  | { ok: false; message: string; idempotencyKey: string; invalid?: boolean };

const PayOrderInput = z.object({
  method: z.enum(['cod', 'bkash', 'sslcommerz']),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_RE),
});

/** Codes after which the same Idempotency-Key must not be sent again. */
const PAY_KEEP_KEY = new Set(['network_error', 'idempotency_key_in_use', 'rate_limited', 'http_429']);
const payKey = (code: string, key: string) => (PAY_KEEP_KEY.has(code) ? key : crypto.randomUUID());
const initiationFailed = (provider: string) => `${provider === 'bkash' ? 'bKash' : 'The payment service'} isn't responding right now. Try again in a minute.`;

/**
 * "Try again" / "Pay on delivery instead" for the shopper's own order (`sp_order`). An online
 * method redirects to the gateway; COD returns the thank-you target.
 */
export async function payOrder(input: { method: string; idempotencyKey: string }): Promise<PayActionResult> {
  const parsed = PayOrderInput.safeParse(input);
  const fallbackKey = crypto.randomUUID();
  if (!parsed.success) return { ok: false, message: 'Choose how you want to pay.', idempotencyKey: fallbackKey };
  const { method, idempotencyKey: key } = parsed.data;
  const ctx = await getCommerceContext();
  if (!ctx) return { ok: false, message: NOT_OPEN, idempotencyKey: key };
  const orderToken = await getOrderToken();
  if (!orderToken) return { ok: false, message: "We can't find your order on this device. Use Track order to check it.", idempotencyKey: key };

  const r = await postOrderPay(ctx.call, orderToken, key, method);
  if (r.ok) {
    const payment = r.data.payment;
    if (payment === null) return { ok: true, redirect: '/checkout/thank-you' };
    if (payment.status === 'redirect' && payment.redirect_url) redirect(payment.redirect_url);
    return { ok: false, message: initiationFailed(payment.provider), idempotencyKey: crypto.randomUUID() };
  }
  if (r.code === 'payment_not_pending' || r.code === 'payment_method_unavailable') refresh();
  return { ok: false, message: errorMessage(r), idempotencyKey: payKey(r.code, key) };
}

const PayLinkInput = z.object({
  token: z.string().regex(PAY_LINK_TOKEN_RE),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_RE),
});

/** Pay page button: start the gateway payment for a merchant payment link and redirect to it. */
export async function payLink(input: { token: string; idempotencyKey: string }): Promise<PayActionResult> {
  const parsed = PayLinkInput.safeParse(input);
  if (!parsed.success) return { ok: false, invalid: true, message: "This payment link isn't valid any more.", idempotencyKey: crypto.randomUUID() };
  const { token, idempotencyKey: key } = parsed.data;
  const ctx = await getCommerceContext();
  if (!ctx) return { ok: false, message: NOT_OPEN, idempotencyKey: key };

  const r = await postPaymentLinkPay(ctx.call, token, key);
  if (r.ok) {
    if (r.data.status === 'redirect' && r.data.redirect_url) redirect(r.data.redirect_url);
    return { ok: false, message: initiationFailed(r.data.provider), idempotencyKey: crypto.randomUUID() };
  }
  if (r.status === 404) return { ok: false, invalid: true, message: "This payment link isn't valid any more.", idempotencyKey: crypto.randomUUID() };
  return { ok: false, message: errorMessage(r), idempotencyKey: payKey(r.code, key) };
}

// ---------- order tracking ----------
/** `values` echo what was typed so the form keeps it after React's post-action reset. */
type TrackValues = { values: { number: string; phone: string } };
export type TrackState =
  | { status: 'idle' }
  | ({ status: 'invalid'; fieldErrors: { number?: string; phone?: string } } & TrackValues)
  | ({ status: 'not_found' | 'error'; message: string } & TrackValues)
  | ({ status: 'found'; tracking: StorefrontTracking } & TrackValues);

export async function trackOrder(_prev: TrackState, formData: FormData): Promise<TrackState> {
  const number = String(formData.get('number') ?? '').trim().toUpperCase();
  const rawPhone = String(formData.get('phone') ?? '').slice(0, 20);
  const phone = normalizeBdPhone(rawPhone);
  const values = { number: number.slice(0, 24), phone: rawPhone };
  const fieldErrors: { number?: string; phone?: string } = {};
  if (!/^[A-Z0-9-]{1,24}$/.test(number)) fieldErrors.number = 'Enter the order number from your confirmation.';
  if (!phone) fieldErrors.phone = 'Enter a Bangladeshi mobile number (01XXXXXXXXX).';
  if (fieldErrors.number || fieldErrors.phone) return { status: 'invalid', fieldErrors, values };
  const ctx = await getCommerceContext();
  if (!ctx) return { status: 'error', message: NOT_OPEN, values };
  const r = await postTrack(ctx.store.host, number, phone!, ctx.call.previewToken, ctx.call.clientIp);
  if (r.ok) return { status: 'found', tracking: r.data, values };
  if (r.status === 404) return { status: 'not_found', message: "We couldn't find an order with that number and phone. Check both and try again.", values };
  return { status: 'error', message: errorMessage(r), values };
}

// ---------- PLP "Load 24 more" (read-only) ----------
const LoadMoreInput = z.object({
  scope: z.union([z.object({ category: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(200) }), z.object({ q: z.string().min(1).max(100) })]),
  params: z.record(z.string(), z.string().max(120)),
});

export async function loadMoreProducts(input: z.input<typeof LoadMoreInput>): Promise<{ products: ProductCardView[]; page: number; lastPage: number }> {
  const parsed = LoadMoreInput.safeParse(input);
  const ctx = await getCommerceContext();
  if (!parsed.success || !ctx) return { products: [], page: 1, lastPage: 1 };
  const state = parseCatalogState(parsed.data.params);
  const page = await listProducts(ctx.store.host, catalogApiQuery(state, parsed.data.scope), ctx.call.previewToken);
  return { products: page.products.map(toCardView), page: page.page, lastPage: page.last_page };
}
