import type { Metadata } from 'next';
import Link from 'next/link';
import { requireCurrentStore } from '@/lib/store';
import { fetchCart } from '@/lib/commerce-api';
import { getCommerceContext } from '@/lib/commerce-context';
import { errorMessage } from '@/lib/commerce-messages';
import { NOINDEX_ROBOTS } from '@/lib/seo';
import { isOfferedMethod } from '@/lib/payments';
import { whatsappHref } from '@/lib/contact';
import { formatMoney } from '@/lib/format';
import { CartLineControls, CouponForm } from '@/themes/modern-commerce/commerce/cart-client';
import { EmptyState, FreeDeliveryBar, Notice, PageTitle, PAYMENT_METHOD_LABELS, PriceLine } from '@/themes/modern-commerce/commerce/ui';
import { ButtonLink } from '@/themes/modern-commerce/components/button';
import { Icon } from '@/themes/modern-commerce/components/icon';
import { ProductImage } from '@/themes/modern-commerce/components/product-image';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Your bag', robots: NOINDEX_ROBOTS };

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** `/cart` — Figma desktop 1:11378, mobile 1:11506 / 31:6473 (PHASE-5-CONTRACT §5). */
export default async function CartPage({ searchParams }: Props) {
  const store = await requireCurrentStore();
  if (store.mode === 'coming_soon') return null;
  const ctx = await getCommerceContext();
  const r = ctx ? await fetchCart(ctx.call) : null;
  const sp = await searchParams;
  const cart = r?.ok ? r.data.cart : null;
  const notices = r?.ok ? (r.data.meta.notices ?? []) : [];
  const loadError = r && !r.ok && r.code !== 'cart_not_found' ? errorMessage(r) : null;
  const { config } = store;
  const wa = whatsappHref(config.contact.whatsapp);
  const methods = (config.commerce?.payment_methods ?? []).filter(isOfferedMethod);

  if (!cart || cart.lines.length === 0) {
    return (
      <div className="flex flex-col items-start gap-6 px-4 pt-8 pb-20 lg:px-20 lg:pt-12 lg:pb-28">
        <PageTitle title="Your bag" />
        {loadError ? <Notice tone="error">{loadError}</Notice> : null}
        <div className="w-full" data-sp-empty-bag>
          <EmptyState
            icon="bag"
            title="Your bag is empty"
            action={
              <ButtonLink href="/">
                Continue shopping
                <Icon name="arrow-right" />
              </ButtonLink>
            }
          >
            Find something you love and it will wait for you here.
          </EmptyState>
        </div>
      </div>
    );
  }

  const issues = cart.lines.some((l) => l.issue !== null);
  const c = cart.currency;

  return (
    <div className="flex flex-col gap-6 px-4 pt-6 pb-20 lg:px-20 lg:pt-12 lg:pb-28">
      <PageTitle title="Your bag" count={`${cart.items_count} ${cart.items_count === 1 ? 'item' : 'items'}`} />
      <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:gap-12">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {sp.changed === 'stock' ? <Notice tone="error">Some items changed while you were checking out. Check your bag, then continue.</Notice> : null}
          {notices.map((n) => (
            <Notice key={n}>{n}</Notice>
          ))}
          {cart.free_delivery ? <FreeDeliveryBar threshold={cart.free_delivery.threshold_amount} remaining={cart.free_delivery.remaining_amount} currency={c} /> : null}

          <ul className="flex flex-col" aria-label="Items in your bag">
            {cart.lines.map((line) => (
              <li key={line.id} className="flex gap-3 border-b border-line-subtle py-5 lg:gap-5" data-sp-cart-line>
                <Link href={line.product_slug ? `/products/${line.product_slug}` : '/'} className="relative h-[120px] w-24 shrink-0 overflow-hidden rounded-sf-xs bg-sunken lg:h-36 lg:w-[120px]">
                  <ProductImage image={line.image} sizes="120px" />
                </Link>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <h2 className="type-label-m text-ink">
                        {line.product_slug ? (
                          <Link href={`/products/${line.product_slug}`} className="hover:underline">
                            {line.product_name}
                          </Link>
                        ) : (
                          line.product_name
                        )}
                      </h2>
                      {line.variant_title ? <p className="type-body-s text-ink-muted">{line.variant_title}</p> : null}
                    </div>
                    <p className="type-price-m hidden shrink-0 text-ink lg:block">{formatMoney(line.line_amount, c)}</p>
                  </div>
                  {line.issue === 'unavailable' ? (
                    <p className="type-label-s text-sale">No longer available. Remove it to check out.</p>
                  ) : line.issue === 'insufficient_stock' ? (
                    <p className="type-label-s flex items-center gap-1.5 text-sale">
                      <Icon name="lightning-sm" />
                      {line.max_quantity ? `Only ${line.max_quantity} left. Lower the quantity to check out.` : 'Sold out. Remove it to check out.'}
                    </p>
                  ) : line.low_stock !== null ? (
                    <p className="type-label-s flex items-center gap-1.5 text-sale">
                      <Icon name="lightning-sm" />
                      Only {line.low_stock} left{line.variant_title ? ' in this size' : ''}
                    </p>
                  ) : null}
                  <PriceLine price={line.unit_price_amount} compareAt={line.compare_at_amount} currency={c} />
                  <CartLineControls
                    itemId={line.id}
                    quantity={line.quantity}
                    max={line.issue === 'insufficient_stock' ? Math.max(line.quantity, line.max_quantity ?? 1) : (line.low_stock ?? 99)}
                    name={line.product_name}
                    disabled={line.issue === 'unavailable'}
                  />
                </div>
              </li>
            ))}
          </ul>
          <Link href="/" className="type-label-s mt-3 hidden items-center gap-2 self-start text-brand hover:underline lg:flex">
            <Icon name="arrow-right-sm" className="rotate-180" />
            Continue shopping
          </Link>
        </div>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-6 lg:w-[420px] lg:shrink-0" aria-labelledby="summary-title">
          <div className="flex flex-col gap-4 rounded-sf-md border border-line bg-surface p-5 lg:p-7">
            <h2 id="summary-title" className="type-h3 text-ink">
              Order summary
            </h2>
            <dl className="type-body-m flex flex-col gap-4 text-ink-secondary">
              <div className="flex justify-between gap-4">
                <dt>Items ({cart.items_count})</dt>
                <dd className="text-ink">{formatMoney(cart.subtotal_amount, c)}</dd>
              </div>
              {cart.coupon ? (
                <div className="flex justify-between gap-4">
                  <dt>Coupon {cart.coupon.code}</dt>
                  <dd className="text-sale">{cart.coupon.free_shipping ? 'Free delivery' : `− ${formatMoney(cart.discount_amount, c)}`}</dd>
                </div>
              ) : null}
              <div className="flex justify-between gap-4">
                <dt>Delivery</dt>
                <dd className="text-ink-muted">Calculated at next step</dd>
              </div>
            </dl>
            <CouponForm applied={cart.coupon?.code ?? null} />
            <hr className="border-line" />
            <div className="flex items-baseline justify-between gap-4">
              <div className="flex flex-col gap-0.5">
                <p className="type-label-m text-ink">Estimated total</p>
                {cart.savings_amount > 0 ? <p className="type-body-s text-sale">You save {formatMoney(cart.savings_amount, c)}</p> : null}
              </div>
              <p className="type-price-l text-ink">{formatMoney(cart.estimated_total_amount, c)}</p>
            </div>
            {cart.can_checkout && !issues ? (
              <Link href="/checkout" className="type-label-m flex h-[52px] items-center justify-center gap-2 rounded-control bg-brand text-on-brand hover:brightness-110">
                Checkout
                <Icon name="lock" />
              </Link>
            ) : (
              <button type="button" disabled className="type-label-m flex h-[52px] cursor-not-allowed items-center justify-center gap-2 rounded-control bg-brand text-on-brand opacity-50">
                Checkout
                <Icon name="lock" />
              </button>
            )}
            {issues ? <p className="type-body-s text-sale">Fix the highlighted items to check out.</p> : null}
            <div className="flex flex-col gap-2.5 pt-1">
            <ul className="type-body-s flex flex-col gap-2.5 text-ink-secondary">
              {methods.includes('cod') ? (
                <li className="flex items-center gap-2">
                  <Icon name="wallet" size={16} className="text-brand" />
                  Cash on delivery available
                </li>
              ) : null}
              <li className="flex items-center gap-2">
                <Icon name="shield" size={16} className="text-brand" />
                Secure checkout — totals confirmed by our server
              </li>
            </ul>
            {methods.length ? (
              <ul className="flex flex-wrap gap-1.5" aria-label="Pay with">
                {methods.map((m) => (
                  <li key={m} className="type-label-s rounded-sf-xs bg-sunken px-2 py-1 text-ink">
                    {PAYMENT_METHOD_LABELS[m]}
                  </li>
                ))}
              </ul>
            ) : null}
            </div>
          </div>
          {wa ? (
            <a href={wa} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2.5 rounded-sf-md bg-sunken p-4 hover:brightness-95">
              <Icon name="whatsapp" size={20} className="text-brand" />
              <span className="flex flex-col gap-0.5">
                <span className="type-label-s text-ink">Need help with your order?</span>
                <span className="type-body-s text-ink-muted">Chat with us on WhatsApp{config.contact.support_hours ? `, ${config.contact.support_hours}` : ''}</span>
              </span>
            </a>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
