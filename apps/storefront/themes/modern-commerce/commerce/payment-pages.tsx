import Link from 'next/link';
import type { ReactNode } from 'react';
import type { PaymentLinkView, StorefrontPaymentResult } from '@storeplix/types';
import { formatMoney } from '@/lib/format';
import { METHOD_LABEL } from '@/lib/payments';
import { Icon } from '../components/icon';
import { PayLinkButton, PaymentPoller } from './payment-client';

/**
 * Minimal payment screens (PHASE-5B-CONTRACT §11). No Figma frame exists for the pay page; these
 * are composed from the thank-you (1:11788) and checkout (1:11591) pieces: brand hero band, white
 * rounded cards, pill buttons, theme tokens only.
 */

function Shell({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div className="flex justify-center px-4 pt-8 pb-20 lg:px-20 lg:pt-14 lg:pb-28" data-sp-payment-page={testId}>
      <div className="flex w-full max-w-[560px] min-w-0 flex-col gap-5">{children}</div>
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <section className="flex min-w-0 flex-col gap-5 rounded-sf-sm border border-line-subtle bg-surface p-5 lg:p-7">{children}</section>;
}

function Badge({ tone, icon, children }: { tone: 'ok' | 'wait' | 'fail'; icon: 'check' | 'clock' | 'x' | 'lock'; children: ReactNode }) {
  const cls = tone === 'ok' ? 'bg-brand-soft text-brand' : tone === 'fail' ? 'bg-accent-soft text-sale' : 'bg-sky-soft text-ink';
  return (
    <p className={`type-eyebrow flex items-center gap-2 self-start rounded-full px-3 py-1.5 ${cls}`}>
      <Icon name={icon} size={14} />
      {children}
    </p>
  );
}

/** "This payment link isn't valid any more" — one identical page for unknown, expired, paid and cancelled (P5B-23). */
export function InvalidPayLink() {
  return (
    <Shell testId="invalid">
      <Card>
        <Badge tone="fail" icon="x">
          Link not valid
        </Badge>
        <h1 className="type-h2 text-ink">This payment link isn&apos;t valid any more</h1>
        <p className="type-body-m text-ink-secondary">It may have expired or already been used. Ask the shop to send you a new link.</p>
        <Link href="/" className="type-label-m flex h-[52px] items-center justify-center rounded-control border-[1.5px] border-ink px-7 text-ink hover:bg-ink/5 sm:self-start">
          Go to the shop
        </Link>
      </Card>
    </Shell>
  );
}

/** `/pay/[token]`: "Pay ৳ 130 to confirm order GS-1041", expiry, gateway button. */
export function PayLinkPage({ link, token, idempotencyKey, now = Date.now() }: { link: PaymentLinkView; token: string; idempotencyKey: string; now?: number }) {
  const amountText = formatMoney(link.amount, link.currency);
  const expires = new Date(link.expires_at);
  const minutes = Math.max(0, Math.ceil((expires.getTime() - now) / 60_000));
  const expiryText =
    minutes <= 120
      ? `This link expires in ${minutes} minute${minutes === 1 ? '' : 's'}.`
      : `This link expires on ${expires.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}.`;
  return (
    <Shell testId="pay">
      <Card>
        <Badge tone="wait" icon="lock">
          Secure payment
        </Badge>
        <div className="flex flex-col gap-2">
          {link.shop_name ? <p className="type-label-s text-ink-muted">{link.shop_name}</p> : null}
          <h1 className="type-h2 break-words text-ink">
            Pay {amountText} to confirm order {link.order_number}
          </h1>
        </div>
        <dl className="type-body-m flex flex-col gap-3 border-t border-line-subtle pt-5 text-ink-secondary">
          <div className="flex justify-between gap-4">
            <dt>Order</dt>
            <dd className="text-ink">{link.order_number}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>Pay with</dt>
            <dd className="text-ink">{METHOD_LABEL[link.provider]}</dd>
          </div>
          <div className="flex items-end justify-between gap-4 border-t border-line-subtle pt-3">
            <dt className="type-label-m text-ink">Amount</dt>
            <dd className="type-price-l text-ink" data-sp-pay-amount>
              {amountText}
            </dd>
          </div>
        </dl>
        <PayLinkButton token={token} provider={link.provider} amountText={amountText} idempotencyKey={idempotencyKey} />
        <p className="type-body-s flex items-center gap-2 text-ink-muted">
          <Icon name="clock" />
          {expiryText}
        </p>
      </Card>
    </Shell>
  );
}

/** Result card without the shopper's order cookie (or for a payment link): status only, no PII. */
export function PaymentResultCard({ result, paymentId, variant }: { result: StorefrontPaymentResult; paymentId: string; variant: 'checkout' | 'link' }) {
  const amountText = formatMoney(result.amount, result.currency);
  const s = result.status;
  return (
    <Shell testId={`result-${s}`}>
      <Card>
        {s === 'succeeded' ? (
          <Badge tone="ok" icon="check">
            Payment received
          </Badge>
        ) : s === 'pending' ? (
          <Badge tone="wait" icon="clock">
            Checking payment
          </Badge>
        ) : (
          <Badge tone="fail" icon="x">
            Not paid
          </Badge>
        )}
        <h1 className="type-h2 break-words text-ink">{s === 'succeeded' ? `Paid ${amountText}` : s === 'pending' ? 'Almost there…' : "Payment didn't go through"}</h1>
        <p className="type-body-m text-ink-secondary">
          Order {result.order_number}
          {result.shop_name ? ` · ${result.shop_name}` : ''}
        </p>
        {s === 'succeeded' ? (
          <p className="type-body-m text-ink-secondary">Thank you! The shop has your payment and will confirm your order by SMS.</p>
        ) : s === 'pending' ? (
          <div className="text-ink">
            <PaymentPoller paymentId={paymentId} />
          </div>
        ) : (
          <p className="type-body-m text-ink-secondary">
            {variant === 'link' ? 'No money was taken. Open the payment link again to try once more.' : 'No money was taken. Open this page on the device you ordered from to try again, or track your order.'}
          </p>
        )}
        <div className="flex flex-col gap-3 sm:flex-row">
          <Link href={`/track?number=${encodeURIComponent(result.order_number)}`} className="type-label-m flex h-[52px] items-center justify-center gap-2 rounded-control bg-brand px-7 text-on-brand hover:brightness-110">
            Track this order
            <Icon name="truck-sm" />
          </Link>
          <Link href="/" className="type-label-m flex h-[52px] items-center justify-center rounded-control border-[1.5px] border-ink px-7 text-ink hover:bg-ink/5">
            Continue shopping
          </Link>
        </div>
      </Card>
    </Shell>
  );
}

/** Unknown payment id, or the API couldn't answer. */
export function PaymentResultMissing({ unavailable }: { unavailable: boolean }) {
  return (
    <Shell testId={unavailable ? 'unavailable' : 'missing'}>
      <Card>
        <h1 className="type-h2 text-ink">{unavailable ? "We couldn't check your payment just now" : "We couldn't find this payment"}</h1>
        <p className="type-body-m text-ink-secondary">
          {unavailable ? "Refresh in a minute. If money was taken, it's safe: the shop confirms every payment with the gateway." : 'Check the link, or track your order with its number and your phone.'}
        </p>
        <Link href="/track" className="type-label-m flex h-[52px] items-center justify-center rounded-control bg-brand px-7 text-on-brand hover:brightness-110 sm:self-start">
          Track your order
        </Link>
      </Card>
    </Shell>
  );
}
