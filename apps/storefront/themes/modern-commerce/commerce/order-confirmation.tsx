import Link from 'next/link';
import type { StorefrontOrder } from '@storeplix/types';
import { formatMoney } from '@/lib/format';
import { formatBdPhone } from '@/lib/checkout-form';
import { holdMinutesLeft, orderPaymentLine, retryOptions } from '@/lib/payments';
import { Icon } from '../components/icon';
import { ProductImage } from '../components/product-image';
import { ThemeImage } from '../components/theme-image';
import { OrderTimeline } from './order-timeline';
import { deliveryDays } from './ui';
import { PaymentPoller, RetryPayment } from './payment-client';
import { OrderMessages } from '@/components/inbox/order-messages';
import type { ShopperOrderMessagesView } from '@/lib/tracking';

/**
 * Order confirmation body (Figma 1:11788, mobile 33:5751), shared by `/checkout/thank-you` and
 * `/checkout/payment-result` (PHASE-5B-CONTRACT §11). The hero reflects the payment:
 * - `placed`: COD or paid ("Paid ৳ N with bKash", plus cash due when partly paid);
 * - `pending`: the gateway result is still being verified (polls `/api/payment-status`);
 * - `unpaid`: `pending_payment` with a failed/cancelled/unfinished attempt → Retry / Pay on delivery.
 */
export type ConfirmationHero = { kind: 'auto' } | { kind: 'pending'; paymentId: string };

interface Props {
  order: StorefrontOrder;
  whatsappHref: string | null;
  hero: ConfirmationHero;
  /** Idempotency-Key for the first retry / COD switch (created per render on the server). */
  retryKey: string;
  now?: number;
  /** 8.8e §10 (Q304): order Messages card on the thank-you page; null when the channel is off. No token here. */
  messages?: ShopperOrderMessagesView | null;
}

export function OrderConfirmation({ order, whatsappHref: wa, hero, retryKey, now = Date.now(), messages = null }: Props) {
  const c = order.currency;
  const firstName = order.customer_name.split(/\s+/)[0] ?? order.customer_name;
  const phone = formatBdPhone(order.customer_phone);
  const a = order.shipping_address;
  const days = deliveryDays(order.delivery.min_days, order.delivery.max_days);
  const line = orderPaymentLine(order);
  const options = retryOptions(order);
  const unpaid = hero.kind === 'auto' && order.status === 'pending_payment' && line.kind !== 'paid';
  const minutes = unpaid ? holdMinutesLeft(order.payment?.expires_at ?? null, now) : null;
  const failed = unpaid && line.kind === 'failed';

  const eyebrow = hero.kind === 'pending' ? 'Checking payment' : unpaid ? 'Payment needed' : 'Order placed';
  const title = hero.kind === 'pending' ? 'Almost there…' : failed ? "Payment didn't go through" : unpaid ? 'Finish your payment' : `Thank you, ${firstName}!`;
  const placedText =
    line.kind === 'paid'
      ? `Order ${order.number} is in. ${line.text}.${line.dueText ? ` ${line.dueText}.` : ''} We'll send updates to ${phone} by SMS.`
      : `Order ${order.number} is in. ${line.text}. We'll send updates to ${phone} by SMS.`;
  const unpaidText = `Order ${order.number} is saved${minutes ? ` for ${minutes} more minute${minutes === 1 ? '' : 's'}` : ''}. ${
    options.retry && options.cod ? 'Try again, or pay in cash when it arrives.' : options.retry ? 'Try again to confirm it.' : options.cod ? 'You can pay in cash when it arrives.' : 'Contact the shop to finish your order.'
  }`;
  const paidOnline = order.paid_amount > 0;

  return (
    <div className="flex flex-col pb-20 lg:pb-28" data-sp-confirmation={hero.kind === 'pending' ? 'pending' : unpaid ? 'unpaid' : 'placed'}>
      <section className="bg-brand text-on-brand">
        <div className="flex flex-col gap-8 px-4 py-10 lg:min-h-[388px] lg:flex-row lg:items-center lg:justify-between lg:gap-16 lg:px-20 lg:py-16">
          <div className="flex min-w-0 flex-col items-start gap-4">
            <p className="type-eyebrow flex items-center gap-2 rounded-full bg-accent py-[7px] pr-3.5 pl-2 text-on-accent">
              <Icon name={hero.kind === 'pending' || unpaid ? 'clock' : 'check'} size={18} />
              {eyebrow}
            </p>
            <h1 className="type-display-m break-words lg:text-[64px] lg:leading-[1.04] lg:tracking-[-2.5px]">{title}</h1>
            {hero.kind === 'pending' ? (
              <>
                <p className="type-body-l max-w-[760px] opacity-90">Order {order.number} is in. We&apos;re confirming your payment with the gateway.</p>
                <PaymentPoller paymentId={hero.paymentId} />
              </>
            ) : unpaid ? (
              <>
                <p className="type-body-l max-w-[760px] opacity-90" data-sp-payment-line>
                  {unpaidText}
                </p>
                <RetryPayment retry={options.retry} cod={options.cod} idempotencyKey={retryKey} tone="brand" />
              </>
            ) : (
              <>
                <p className="type-body-l max-w-[760px] opacity-90" data-sp-payment-line>
                  {placedText}
                </p>
                <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
                  <Link href={`/track?number=${encodeURIComponent(order.number)}`} className="type-label-m flex h-[52px] items-center justify-center gap-2 tone-dark rounded-control bg-surface px-7 hover:bg-sunken">
                    Track this order
                    <Icon name="truck-sm" />
                  </Link>
                  <Link href="/" className="type-label-m flex h-[52px] items-center justify-center rounded-control bg-accent px-7 text-on-accent hover:brightness-105">
                    Continue shopping
                  </Link>
                </div>
              </>
            )}
          </div>
          <div className="relative hidden h-[260px] w-[380px] shrink-0 overflow-hidden rounded-sf-xs bg-surface shadow-[10px_10px_0_0_var(--color-sun)] lg:block">
            <div className="absolute inset-2.5 overflow-hidden rounded-[2px]">
              <ThemeImage src="/themes/modern-commerce/images/gift-set.png" alt="" sizes="360px" />
            </div>
          </div>
        </div>
      </section>

      <div className="flex flex-col gap-5 px-4 pt-8 lg:flex-row lg:items-start lg:gap-8 lg:px-20 lg:pt-14">
        <section aria-labelledby="next-title" className="flex min-w-0 flex-1 flex-col gap-5 rounded-sf-md border border-line bg-surface p-5 lg:p-7">
          <h2 id="next-title" className="type-h3 text-ink">
            What happens next
          </h2>
          <OrderTimeline
            steps={[
              { key: 'placed', title: 'Order placed', detail: new Date(order.placed_at).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }), state: 'done' },
              ...(order.payment
                ? [{ key: 'payment', title: line.kind === 'paid' ? line.text : 'Payment', detail: line.kind === 'paid' ? undefined : hero.kind === 'pending' ? 'Checking your payment' : line.text, state: line.kind === 'paid' ? ('done' as const) : ('current' as const) }]
                : []),
              { key: 'confirming', title: 'Confirming your order', detail: line.kind === 'paid' ? undefined : `We may call ${phone} to confirm`, state: unpaid || hero.kind === 'pending' ? ('todo' as const) : ('current' as const) },
              { key: 'packed', title: 'Packed', state: 'todo' },
              { key: 'courier', title: 'With the courier', state: 'todo' },
              {
                key: 'delivered',
                title: order.due_amount > 0 ? `Delivered · pay ${formatMoney(order.due_amount, c)} in cash` : 'Delivered',
                detail: days ? `Usually ${days} (${order.delivery.zone_name})` : undefined,
                state: 'todo',
              },
            ]}
          />
        </section>

        <div className="flex min-w-0 flex-col gap-4 lg:w-[595px] lg:shrink-0">
          <section aria-labelledby="to-title" className="flex flex-col gap-3 rounded-sf-md border border-line bg-surface p-5 lg:p-6">
            <h2 id="to-title" className="type-label-m text-ink">
              Delivering to
            </h2>
            <p className="type-body-s break-words text-ink-secondary">
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
          <section aria-labelledby="order-title" className="flex flex-col gap-3 rounded-sf-md border border-line bg-surface p-5 lg:p-6">
            <h2 id="order-title" className="type-label-m text-ink">
              Order {order.number}
            </h2>
            <ul className="flex flex-col gap-3">
              {order.lines.map((l, i) => (
                <li key={`${l.product_name}-${i}`} className="flex items-center gap-3">
                  <span className="relative h-[52px] w-11 shrink-0 overflow-hidden rounded-sf-xs bg-sunken">
                    <ProductImage image={l.image} sizes="44px" />
                  </span>
                  <span className="type-body-s min-w-0 flex-1 text-ink">
                    {l.product_name}
                    {l.variant_title ? ` · ${l.variant_title}` : ''} × {l.quantity}
                  </span>
                  <span className="type-label-s text-ink">{formatMoney(l.total_amount, c)}</span>
                </li>
              ))}
            </ul>
            <dl className="type-body-s flex flex-col gap-3 border-t border-line pt-3 text-ink-secondary">
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
              {paidOnline ? (
                <div className="flex justify-between">
                  <dt>Paid online</dt>
                  <dd className="text-brand">− {formatMoney(order.paid_amount, c)}</dd>
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-4">
                <dt className="type-label-m text-ink">{order.payment_method === 'cod' || paidOnline ? 'Cash to pay on delivery' : 'Total'}</dt>
                <dd className="type-price-m text-ink">{formatMoney(order.payment_method === 'cod' || paidOnline ? order.due_amount : order.total_amount, c)}</dd>
              </div>
            </dl>
          </section>
          {messages ? <OrderMessages number={order.number} replyTime={messages.reply_time} via="confirmation" /> : null}
          {wa ? (
            <a href={wa} target="_blank" rel="noopener noreferrer" className="type-body-s flex items-center gap-2.5 rounded-sf-md bg-sunken p-4 text-ink-secondary hover:brightness-95">
              <Icon name="whatsapp" size={20} className="text-brand" />
              Need to change something? Message us on WhatsApp before it ships.
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}
