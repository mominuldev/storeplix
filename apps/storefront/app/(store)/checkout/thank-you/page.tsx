import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireCurrentStore } from '@/lib/store';
import { fetchConfirmation, getClientIp } from '@/lib/commerce-api';
import { getOrderToken } from '@/lib/commerce-context';
import { getPreviewToken } from '@/lib/preview';
import { NOINDEX_ROBOTS } from '@/lib/seo';
import { whatsappHref } from '@/lib/contact';
import { formatMoney } from '@/lib/format';
import { formatBdPhone } from '@/lib/checkout-form';
import { deliveryDays } from '@/themes/modern-commerce/commerce/ui';
import { OrderTimeline } from '@/themes/modern-commerce/commerce/order-timeline';
import { Icon } from '@/themes/modern-commerce/components/icon';
import { ProductImage } from '@/themes/modern-commerce/components/product-image';
import { ThemeImage } from '@/themes/modern-commerce/components/theme-image';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Order placed', robots: NOINDEX_ROBOTS };

/** `/checkout/thank-you` — Figma 1:11788, mobile 33:5751. From the httpOnly `sp_order` cookie (P5-23). */
export default async function ThankYouPage() {
  const store = await requireCurrentStore();
  if (store.mode === 'coming_soon') return null;
  const token = await getOrderToken();
  if (!token) redirect('/');
  const preview = store.mode === 'preview' ? await getPreviewToken() : null;
  const r = await fetchConfirmation(store.host, token, preview, await getClientIp());
  if (!r.ok) redirect('/');
  const order = r.data;
  const c = order.currency;
  const firstName = order.customer_name.split(/\s+/)[0] ?? order.customer_name;
  const phone = formatBdPhone(order.customer_phone);
  const a = order.shipping_address;
  const wa = whatsappHref(store.config.contact.whatsapp);
  const days = deliveryDays(order.delivery.min_days, order.delivery.max_days);

  return (
    <div className="flex flex-col pb-20 lg:pb-28">
      <section className="bg-brand text-on-brand">
        <div className="flex flex-col gap-8 px-4 py-10 lg:flex-row lg:items-center lg:justify-between lg:gap-16 lg:px-20 lg:py-16">
          <div className="flex min-w-0 flex-col items-start gap-5">
            <p className="type-eyebrow flex items-center gap-2 rounded-full bg-accent px-3 py-1.5 text-on-accent">
              <Icon name="check" size={14} />
              Order placed
            </p>
            <h1 className="type-display-m break-words lg:type-display-xl">Thank you, {firstName}!</h1>
            <p className="type-body-l max-w-[760px] opacity-90">
              Order {order.number} is in. Pay {formatMoney(order.due_amount, c)} in cash when it arrives. We&apos;ll send updates to {phone} by SMS.
            </p>
            <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
              <Link href={`/track?number=${encodeURIComponent(order.number)}`} className="type-label-m flex h-[52px] items-center justify-center gap-2 rounded-control bg-surface px-7 text-[#0e1a33] hover:bg-sunken">
                Track this order
                <Icon name="truck-sm" />
              </Link>
              <Link href="/" className="type-label-m flex h-[52px] items-center justify-center rounded-control bg-accent px-7 text-on-accent hover:brightness-105">
                Continue shopping
              </Link>
            </div>
          </div>
          <div className="relative hidden h-[270px] w-[390px] shrink-0 pr-2.5 pb-2.5 lg:block">
            <div className="relative size-full overflow-hidden rounded-sf-xs bg-surface p-2.5 shadow-[10px_10px_0_0_var(--color-sun)]">
              <div className="relative size-full overflow-hidden rounded-[2px]">
                <ThemeImage src="/themes/modern-commerce/images/gift-set.png" alt="" sizes="370px" />
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="flex flex-col gap-5 px-4 pt-8 lg:flex-row lg:items-start lg:gap-8 lg:px-20 lg:pt-14">
        <section aria-labelledby="next-title" className="flex min-w-0 flex-1 flex-col gap-6 rounded-sf-sm border border-line-subtle bg-surface p-5 lg:p-7">
          <h2 id="next-title" className="type-h3 text-ink">
            What happens next
          </h2>
          <OrderTimeline
            steps={[
              { key: 'placed', title: 'Order placed', detail: new Date(order.placed_at).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }), state: 'done' },
              { key: 'confirming', title: 'Confirming your order', detail: `We may call ${phone} to confirm`, state: 'current' },
              { key: 'packed', title: 'Packed', state: 'todo' },
              { key: 'courier', title: 'With the courier', state: 'todo' },
              { key: 'delivered', title: `Delivered · pay ${formatMoney(order.due_amount, c)} in cash`, detail: days ? `Usually ${days} (${order.delivery.zone_name})` : undefined, state: 'todo' },
            ]}
          />
        </section>

        <div className="flex flex-col gap-5 lg:w-[595px] lg:shrink-0">
          <section aria-labelledby="to-title" className="flex flex-col gap-3 rounded-sf-sm border border-line-subtle bg-surface p-5 lg:p-6">
            <h2 id="to-title" className="type-label-m text-ink">
              Delivering to
            </h2>
            <p className="type-body-s text-ink-secondary">
              {order.customer_name} · {phone}
              <br />
              {[a.address_line, a.area, a.thana, a.district].filter(Boolean).join(', ')}
              {a.landmark ? (
                <>
                  <br />
                  Landmark: {a.landmark}
                </>
              ) : null}
            </p>
          </section>
          <section aria-labelledby="order-title" className="flex flex-col gap-4 rounded-sf-sm border border-line-subtle bg-surface p-5 lg:p-6">
            <h2 id="order-title" className="type-label-m text-ink">
              Order {order.number}
            </h2>
            <ul className="flex flex-col gap-3">
              {order.lines.map((l, i) => (
                <li key={`${l.product_name}-${i}`} className="flex items-center gap-3">
                  <span className="relative size-12 shrink-0 overflow-hidden rounded-sf-xs bg-sunken">
                    <ProductImage image={l.image} sizes="48px" />
                  </span>
                  <span className="type-body-s min-w-0 flex-1 text-ink">
                    {l.product_name}
                    {l.variant_title ? ` · ${l.variant_title}` : ''} × {l.quantity}
                  </span>
                  <span className="type-label-s text-ink">{formatMoney(l.total_amount, c)}</span>
                </li>
              ))}
            </ul>
            <dl className="type-body-s flex flex-col gap-2 border-t border-line-subtle pt-4 text-ink-secondary">
              {order.discount_amount > 0 ? (
                <div className="flex justify-between">
                  <dt>Coupon {order.coupon_code}</dt>
                  <dd>− {formatMoney(order.discount_amount, c)}</dd>
                </div>
              ) : null}
              <div className="flex justify-between">
                <dt>Delivery{order.delivery.zone_name ? ` · ${order.delivery.zone_name}` : ''}</dt>
                <dd>{order.shipping_amount === 0 ? 'Free' : formatMoney(order.shipping_amount, c)}</dd>
              </div>
              <div className="flex items-end justify-between pt-1">
                <dt className="type-label-m text-ink">Cash to pay on delivery</dt>
                <dd className="type-price-l text-ink">{formatMoney(order.due_amount, c)}</dd>
              </div>
            </dl>
          </section>
          {wa ? (
            <a href={wa} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 rounded-sf-sm bg-sunken px-5 py-4 hover:brightness-95">
              <Icon name="whatsapp" className="text-brand" />
              <span className="flex flex-col">
                <span className="type-label-s text-ink">Questions about your order?</span>
                <span className="type-body-s text-ink-secondary">Message us on WhatsApp with your order number</span>
              </span>
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}
