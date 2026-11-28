import type { Metadata } from 'next';
import { requireCurrentStore } from '@/lib/store';
import { fetchCart, getGeo } from '@/lib/commerce-api';
import { getCommerceContext } from '@/lib/commerce-context';
import { NOINDEX_ROBOTS } from '@/lib/seo';
import { checkoutMethods } from '@/lib/payments';
import { liveTracking } from '@/lib/tracking-config';
import { TrackEvent } from '@/components/tracking/track-event';
import { CheckoutForm } from '@/themes/modern-commerce/commerce/checkout-form';
import { EmptyState, PageTitle } from '@/themes/modern-commerce/commerce/ui';
import { ButtonLink } from '@/themes/modern-commerce/components/button';
import { ProductImage } from '@/themes/modern-commerce/components/product-image';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Checkout', robots: NOINDEX_ROBOTS };

/** `/checkout` — Figma desktop 1:11591, mobile 1:11690 / 32:5087. COD + online methods (PHASE-5B-CONTRACT §11). */
export default async function CheckoutPage() {
  const store = await requireCurrentStore();
  if (store.mode === 'coming_soon') return null;
  const ctx = await getCommerceContext();
  const r = ctx ? await fetchCart(ctx.call) : null;
  // Rendered (not redirected): after "Place order" the action clears sp_cart and Next re-renders this
  // page before the client moves on to the thank-you page.
  if (!r?.ok || r.data.cart.lines.length === 0 || !r.data.cart.can_checkout || r.data.cart.lines.some((l) => l.issue)) {
    const empty = !r?.ok || r.data.cart.lines.length === 0;
    return (
      <div className="flex flex-col items-start gap-6 px-4 pt-8 pb-20 lg:px-20 lg:pt-12 lg:pb-28">
        <PageTitle title="Checkout" />
        <div className="w-full" data-sp-checkout-blocked>
          <EmptyState icon="bag" title={empty ? 'Your bag is empty' : 'Some items in your bag need attention'} action={<ButtonLink href={empty ? '/' : '/cart'}>{empty ? 'Continue shopping' : 'Back to your bag'}</ButtonLink>} />
        </div>
      </div>
    );
  }
  const cart = r.data.cart;
  const geo = await getGeo(store.host);
  const notLive = store.config.store.status !== 'active' ? "Your shop isn't live yet. Orders open after you go live." : null;

  return (
    <div className="bg-sunken px-4 pt-6 pb-20 lg:px-20 lg:pt-10 lg:pb-24">
      {liveTracking(store.mode, store.config.tracking) ? (
        // 8.9d §6.2: begin_checkout once per checkout page view.
        <TrackEvent name="begin_checkout" value_amount={cart.estimated_total_amount} currency={cart.currency} num_items={cart.items_count} />
      ) : null}
      <CheckoutForm
        geo={geo}
        idempotencyKey={crypto.randomUUID()}
        notLiveMessage={notLive}
        paymentMethods={checkoutMethods(store.config.commerce?.payment_methods)}
        codAdvance={store.config.commerce?.cod_advance ?? 'none'}
        summary={{
          currency: cart.currency,
          itemsCount: cart.items_count,
          subtotal: cart.subtotal_amount,
          discount: cart.discount_amount,
          estimatedTotal: cart.estimated_total_amount,
          coupon: cart.coupon ? { code: cart.coupon.code, freeShipping: cart.coupon.free_shipping } : null,
          lines: cart.lines.map((l) => ({
            id: l.id,
            name: l.product_name,
            variant: l.variant_title,
            quantity: l.quantity,
            amount: l.line_amount,
            image: <ProductImage image={l.image} sizes="56px" />,
          })),
        }}
      />
    </div>
  );
}
