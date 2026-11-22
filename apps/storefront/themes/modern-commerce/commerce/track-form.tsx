'use client';

import { useActionState } from 'react';
import { trackOrder, type TrackState } from '@/app/actions/commerce';
import { formatMoney } from '@/lib/format';
import { formatDhakaTime, trackingSteps, TRACK_HEADLINES } from '@/lib/tracking';
import { Icon } from '../components/icon';
import { OrderTimeline } from './order-timeline';
import { Notice } from './ui';

const inputCls = 'type-body-m h-[52px] w-full rounded-sf-xs border border-line bg-surface px-4 text-ink outline-none focus:border-2 focus:border-brand aria-[invalid=true]:border-sale';

/** Track form + result (Figma 1:11959). Street address and email are never part of the response. */
export function TrackForm({ initialNumber, whatsapp }: { initialNumber: string; whatsapp: string | null }) {
  const [state, action, pending] = useActionState<TrackState, FormData>(trackOrder, { status: 'idle' });
  const fieldErrors = state.status === 'invalid' ? state.fieldErrors : {};
  const t = state.status === 'found' ? state.tracking : null;
  const typed = state.status === 'idle' ? { number: initialNumber, phone: '' } : state.values;

  return (
    <div className="flex flex-col gap-10 lg:flex-row lg:items-start lg:gap-12">
      <div className="flex flex-col gap-6 lg:w-[460px] lg:shrink-0">
        <div className="flex flex-col gap-4">
          <p className="type-eyebrow text-accent-ink">Track your order</p>
          <h1 className="type-display-m text-ink">Where&apos;s my parcel?</h1>
          <p className="type-body-m text-ink-secondary">Enter your order number and the phone number you ordered with. Both are needed so nobody else can see your order.</p>
        </div>
        <form action={action} className="flex flex-col gap-5 rounded-sf-sm border border-line-subtle bg-surface p-5 lg:p-6" noValidate>
          <div className="flex flex-col gap-2">
            <label htmlFor="track-number" className="type-label-s text-ink">
              Order number
            </label>
            <input
              id="track-number"
              name="number"
              defaultValue={typed.number}
              autoCapitalize="characters"
              maxLength={24}
              aria-invalid={Boolean(fieldErrors.number)}
              aria-describedby="track-number-msg"
              className={`${inputCls} uppercase`}
            />
            <p id="track-number-msg" className={`type-body-s ${fieldErrors.number ? 'text-sale' : 'text-ink-muted'}`}>
              {fieldErrors.number ?? 'On your confirmation message'}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="track-phone" className="type-label-s text-ink">
              Phone number
            </label>
            <input id="track-phone" name="phone" defaultValue={typed.phone} type="tel" inputMode="tel" autoComplete="tel-national" placeholder="01XXXXXXXXX" aria-invalid={Boolean(fieldErrors.phone)} aria-describedby="track-phone-msg" className={inputCls} />
            <p id="track-phone-msg" className={`type-body-s ${fieldErrors.phone ? 'text-sale' : 'text-ink-muted'}`}>
              {fieldErrors.phone ?? 'The number used at checkout'}
            </p>
          </div>
          <button type="submit" disabled={pending} className="type-label-m flex h-[52px] items-center justify-center gap-2 rounded-control bg-brand text-on-brand hover:brightness-110 disabled:opacity-60">
            {pending ? 'Looking…' : 'Track order'}
            <Icon name="truck-sm" />
          </button>
          {state.status === 'not_found' || state.status === 'error' ? <Notice tone="error">{state.message}</Notice> : null}
        </form>
      </div>

      {t ? (
        <section aria-labelledby="track-result" className="flex min-w-0 flex-1 flex-col gap-6 rounded-sf-sm border border-line-subtle bg-surface p-5 lg:p-8" data-sp-tracking>
          <div className="flex flex-col gap-1">
            <p className="type-body-s text-ink-muted">Order {t.number}</p>
            <h2 id="track-result" className="type-h2 text-ink">
              {TRACK_HEADLINES[t.status]}
            </h2>
          </div>
          <dl className="type-body-s grid gap-4 rounded-sf-xs bg-sunken p-4 sm:grid-cols-3">
            <div>
              <dt className="text-ink-muted">Delivering to</dt>
              <dd className="type-label-s text-ink">{[t.shipping.thana, t.shipping.district].filter(Boolean).join(', ') || '—'}</dd>
            </div>
            {t.shipment?.carrier_name || t.shipment?.tracking_code ? (
              <div>
                <dt className="text-ink-muted">Courier</dt>
                <dd className="type-label-s break-words text-ink">{[t.shipment.carrier_name, t.shipment.tracking_code].filter(Boolean).join(' · ')}</dd>
              </div>
            ) : null}
            <div>
              <dt className="text-ink-muted">Pay on delivery</dt>
              <dd className="type-label-s text-ink">{t.due_amount > 0 ? `${formatMoney(t.due_amount, t.currency)} cash` : 'Nothing to pay'}</dd>
            </div>
          </dl>
          <OrderTimeline steps={trackingSteps(t).map((s) => ({ key: s.key, title: s.title, detail: formatDhakaTime(s.at), state: s.state }))} />
          {t.shipment?.tracking_url ? (
            <a href={t.shipment.tracking_url} target="_blank" rel="noopener noreferrer nofollow" className="type-label-s flex items-center gap-2 self-start text-brand hover:underline">
              Open the courier&apos;s tracking page
              <Icon name="arrow-up-right" />
            </a>
          ) : null}
          <ul className="flex flex-col gap-2 border-t border-line-subtle pt-5">
            {t.lines.map((l, i) => (
              <li key={`${l.product_name}-${i}`} className="type-body-s flex justify-between gap-4 text-ink-secondary">
                <span className="min-w-0">
                  {l.product_name}
                  {l.variant_title ? ` · ${l.variant_title}` : ''} × {l.quantity}
                </span>
                <span className="text-ink">{formatMoney(l.total_amount, t.currency)}</span>
              </li>
            ))}
            <li className="flex justify-between gap-4 pt-2">
              <span className="type-label-m text-ink">Total</span>
              <span className="type-price-m text-ink">{formatMoney(t.total_amount, t.currency)}</span>
            </li>
          </ul>
          {whatsapp ? (
            <a href={`${whatsapp}?text=${encodeURIComponent(`Hi! A question about order ${t.number}`)}`} target="_blank" rel="noopener noreferrer" className="type-label-m flex h-12 items-center justify-center gap-2 self-start rounded-control border-[1.5px] border-ink px-7 text-ink hover:bg-ink/5">
              Message us on WhatsApp
              <Icon name="whatsapp" />
            </a>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
