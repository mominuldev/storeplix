import type { Metadata } from 'next';
import { requireCurrentStore } from '@/lib/store';
import { fetchCart, getGeo } from '@/lib/commerce-api';
import { getCommerceContext } from '@/lib/commerce-context';
import { NOINDEX_ROBOTS } from '@/lib/seo';
import { CheckoutForm } from '@/themes/modern-commerce/commerce/checkout-form';
import { PageTitle } from '@/themes/modern-commerce/commerce/ui';
import { ButtonLink } from '@/themes/modern-commerce/components/button';
import { ProductImage } from '@/themes/modern-commerce/components/product-image';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Checkout', robots: NOINDEX_ROBOTS };

const STEPS = ['Bag', 'Delivery', 'Payment', 'Confirm'];

/** `/checkout` — Figma desktop 1:11591, mobile 1:11690 / 32:5087. COD only (PHASE-5-CONTRACT §5). */
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
      <div className="flex flex-col items-start gap-6 px-4 pt-10 pb-20 lg:px-20 lg:pt-14 lg:pb-28">
        <PageTitle title="Checkout" />
        <div className="flex w-full flex-col items-start gap-4 rounded-sf-sm bg-sunken p-8" data-sp-checkout-blocked>
          <h2 className="type-h2 text-ink">{empty ? 'Your bag is empty' : 'Some items in your bag need attention'}</h2>
          <ButtonLink href={empty ? '/' : '/cart'}>{empty ? 'Continue shopping' : 'Back to your bag'}</ButtonLink>
        </div>
      </div>
    );
  }
  const cart = r.data.cart;
  const geo = await getGeo(store.host);
  const notLive = store.config.store.status !== 'active' ? "Your shop isn't live yet. Orders open after you go live." : null;

  return (
    <div className="flex flex-col gap-8 px-4 pt-8 pb-20 lg:px-20 lg:pt-12 lg:pb-28">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <PageTitle title="Checkout" />
        {/* Decorative progress (Figma stepper); one page in 5a. */}
        <ol aria-hidden className="type-label-s flex flex-wrap items-center gap-2 text-ink-muted">
          {STEPS.map((s, i) => (
            <li key={s} className="flex items-center gap-2">
              {i > 0 ? <span className="h-px w-6 bg-line" /> : null}
              <span className={`flex size-6 items-center justify-center rounded-full ${i <= 1 ? 'bg-brand text-on-brand' : 'border border-line'}`}>{i + 1}</span>
              <span className={i === 1 ? 'text-ink' : ''}>{s}</span>
            </li>
          ))}
        </ol>
      </div>
      <CheckoutForm
        geo={geo}
        idempotencyKey={crypto.randomUUID()}
        notLiveMessage={notLive}
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
