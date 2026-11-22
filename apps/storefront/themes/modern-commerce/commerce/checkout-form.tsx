'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from 'react';
import type { BdGeo, ShippingQuote } from '@storeplix/types';
import { placeOrder, type CheckoutState } from '@/app/actions/commerce';
import { districtsOf, thanasOf, validateCheckoutForm, type CheckoutField, type FieldErrors } from '@/lib/checkout-form';
import { formatMoney } from '@/lib/format';
import { Icon } from '../components/icon';
import { deliveryDays, Notice } from './ui';

export interface CheckoutSummary {
  currency: string;
  itemsCount: number;
  subtotal: number;
  discount: number;
  estimatedTotal: number;
  coupon: { code: string; freeShipping: boolean } | null;
  lines: Array<{ id: string; name: string; variant: string; quantity: number; amount: number; image: ReactNode }>;
}

interface Props {
  geo: BdGeo | null;
  summary: CheckoutSummary;
  idempotencyKey: string;
  notLiveMessage: string | null;
}

type Values = Record<'name' | 'phone' | 'email' | 'division_code' | 'district_code' | 'thana_code' | 'area' | 'address_line' | 'landmark' | 'label' | 'customer_note', string>;

const EMPTY: Values = { name: '', phone: '', email: '', division_code: '', district_code: '', thana_code: '', area: '', address_line: '', landmark: '', label: 'home', customer_note: '' };

const inputCls =
  'type-body-m h-[52px] w-full min-w-0 rounded-sf-xs border bg-surface px-4 text-ink outline-none focus:border-2 focus:border-brand aria-[invalid=true]:border-sale';

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <label htmlFor={id} className="type-label-s text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="type-body-s text-sale">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="type-body-s text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`step-${n}`} className="flex flex-col gap-5 rounded-sf-sm border border-line-subtle bg-surface p-5 lg:p-7">
      <h2 id={`step-${n}`} className="type-h3 flex items-center gap-3 text-ink">
        <span aria-hidden className="type-label-s flex size-7 items-center justify-center rounded-full bg-brand text-on-brand">
          {n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * Checkout (Figma 1:11591 desktop, 1:11690 / 32:5087 mobile): contact, BD address cascade from
 * `/geo/bd`, the one resolved delivery zone, COD. The Idempotency-Key is created on the server and
 * reused for retries of the same attempt (P5-14); the total sent is what the shopper sees (P5-15).
 */
export function CheckoutForm({ geo, summary, idempotencyKey, notLiveMessage }: Props) {
  const [values, setValues] = useState<Values>(EMPTY);
  const [clientErrors, setClientErrors] = useState<FieldErrors>({});
  const [quote, setQuote] = useState<{ status: 'idle' | 'loading' | 'error'; data: ShippingQuote | null; message?: string }>({ status: 'idle', data: null });
  const [state, setState] = useState<CheckoutState>({ status: 'idle', message: null, fieldErrors: {}, idempotencyKey });
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  // Guards double submits between the click and React's pending state.
  const inFlight = useRef(false);
  const errors: FieldErrors = { ...state.fieldErrors, ...clientErrors };
  const c = summary.currency;

  const districts = useMemo(() => (geo && values.division_code ? districtsOf(geo, values.division_code) : []), [geo, values.division_code]);
  const thanas = useMemo(() => (geo && values.district_code ? thanasOf(geo, values.district_code) : []), [geo, values.district_code]);
  const divisions = useMemo(() => (geo ? [...geo.divisions].sort((a, b) => a.name.localeCompare(b.name)) : []), [geo]);

  // Zone + charge for the chosen thana; refreshed when the address or the bag total changes.
  useEffect(() => {
    if (!values.district_code || !values.thana_code) {
      setQuote({ status: 'idle', data: null });
      return;
    }
    const ctrl = new AbortController();
    setQuote((q) => ({ status: 'loading', data: q.data }));
    const qs = new URLSearchParams({ district_code: values.district_code, thana_code: values.thana_code });
    fetch(`/api/shipping-quote?${qs.toString()}`, { cache: 'no-store', signal: ctrl.signal })
      .then(async (r) => {
        const b = (await r.json().catch(() => null)) as { data?: ShippingQuote; error?: { message?: string } } | null;
        if (r.ok && b?.data) setQuote({ status: 'idle', data: b.data });
        else setQuote({ status: 'error', data: null, message: b?.error?.message ?? 'We couldn’t work out delivery for this area.' });
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setQuote({ status: 'error', data: null, message: 'We couldn’t work out delivery for this area.' });
      });
    return () => ctrl.abort();
  }, [values.district_code, values.thana_code, summary.estimatedTotal]);

  const shipping = quote.data ? (summary.coupon?.freeShipping ? 0 : quote.data.amount) : null;
  const total = shipping === null ? null : summary.estimatedTotal + shipping;

  const set = (field: keyof Values) => (e: { target: { value: string } }) => {
    const v = e.target.value;
    setValues((prev) => {
      const next = { ...prev, [field]: v };
      if (field === 'division_code') Object.assign(next, { district_code: '', thana_code: '' });
      if (field === 'district_code') next.thana_code = '';
      return next;
    });
    if (field in clientErrors) setClientErrors(({ [field as CheckoutField]: _drop, ...rest }) => rest);
  };

  const describedBy = (id: CheckoutField) => (errors[id] ? `${id}-error` : undefined);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = validateCheckoutForm(values);
    if (!v.ok) {
      setClientErrors(v.errors);
      const first = Object.keys(v.errors)[0];
      if (first) document.getElementById(first)?.focus();
      return;
    }
    setClientErrors({});
    if (total === null) return;
    const fd = new FormData();
    for (const [k, val] of Object.entries(values)) fd.set(k, val);
    fd.set('idempotency_key', state.idempotencyKey);
    fd.set('expected_total_amount', String(total));
    if (inFlight.current) return;
    inFlight.current = true;
    startTransition(async () => {
      try {
        // Called directly (not via useActionState): the action clears sp_cart, so Next re-renders this
        // page without the form; navigation must not depend on this component staying mounted.
        const next = await placeOrder(state, fd);
        if (next.status === 'redirect' && next.redirect) {
          router.replace(next.redirect);
          return;
        }
        setState(next);
      } catch {
        setState((s) => ({ ...s, status: 'error', message: 'We couldn’t reach the shop. Check your connection and try again.' }));
      } finally {
        inFlight.current = false;
      }
    });
  };

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-8 lg:flex-row lg:items-start lg:gap-10">
      <input type="hidden" name="idempotency_key" value={state.idempotencyKey} readOnly />
      <div className="flex min-w-0 flex-1 flex-col gap-5">
        {notLiveMessage ? <Notice tone="error">{notLiveMessage}</Notice> : null}
        {state.message && state.status !== 'invalid' ? <Notice tone="error">{state.message}</Notice> : null}

        <Step n={1} title="Contact">
          <div className="grid gap-5 md:grid-cols-2">
            <Field id="name" label="Full name" error={errors.name}>
              <input id="name" name="name" autoComplete="name" value={values.name} onChange={set('name')} aria-invalid={Boolean(errors.name)} aria-describedby={describedBy('name')} className={`${inputCls} border-line`} />
            </Field>
            <Field id="phone" label="Mobile number" hint="Order updates by SMS" error={errors.phone}>
              <input
                id="phone"
                name="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                placeholder="01XXXXXXXXX"
                value={values.phone}
                onChange={set('phone')}
                aria-invalid={Boolean(errors.phone)}
                aria-describedby={describedBy('phone') ?? 'phone-hint'}
                className={`${inputCls} border-line`}
              />
            </Field>
          </div>
          <Field id="email" label="Email (optional)" error={errors.email}>
            <input id="email" name="email" type="email" autoComplete="email" placeholder="For your receipt" value={values.email} onChange={set('email')} aria-invalid={Boolean(errors.email)} aria-describedby={describedBy('email')} className={`${inputCls} border-line`} />
          </Field>
        </Step>

        <Step n={2} title="Delivery address">
          {!geo ? <Notice tone="error">We couldn’t load delivery areas. Refresh the page to try again.</Notice> : null}
          <div className="grid gap-5 md:grid-cols-2">
            <Field id="division_code" label="Division">
              <select id="division_code" value={values.division_code} onChange={set('division_code')} className={`${inputCls} border-line`}>
                <option value="">Choose division</option>
                {divisions.map((d) => (
                  <option key={d.code} value={d.code}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="district_code" label="District" error={errors.district_code}>
              <select id="district_code" value={values.district_code} onChange={set('district_code')} disabled={!values.division_code} aria-invalid={Boolean(errors.district_code)} aria-describedby={describedBy('district_code')} className={`${inputCls} border-line disabled:opacity-60`}>
                <option value="">Choose district</option>
                {districts.map((d) => (
                  <option key={d.code} value={d.code}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="thana_code" label="Upazila / Thana" error={errors.thana_code}>
              <select id="thana_code" value={values.thana_code} onChange={set('thana_code')} disabled={!values.district_code} aria-invalid={Boolean(errors.thana_code)} aria-describedby={describedBy('thana_code')} className={`${inputCls} border-line disabled:opacity-60`}>
                <option value="">Choose upazila / thana</option>
                {thanas.map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="area" label="Area (optional)" error={errors.area}>
              <input id="area" value={values.area} onChange={set('area')} maxLength={120} placeholder="e.g. Road 7A area" aria-invalid={Boolean(errors.area)} className={`${inputCls} border-line`} />
            </Field>
          </div>
          <Field id="address_line" label="House, road, flat" error={errors.address_line}>
            <input id="address_line" autoComplete="street-address" value={values.address_line} onChange={set('address_line')} maxLength={255} aria-invalid={Boolean(errors.address_line)} aria-describedby={describedBy('address_line')} className={`${inputCls} border-line`} />
          </Field>
          <Field id="landmark" label="Landmark (optional)" hint="A landmark helps the rider find you first time" error={errors.landmark}>
            <input id="landmark" value={values.landmark} onChange={set('landmark')} maxLength={160} aria-invalid={Boolean(errors.landmark)} className={`${inputCls} border-line`} />
          </Field>
          <div role="radiogroup" aria-label="Address type" className="flex gap-2">
            {(['home', 'office'] as const).map((l) => (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={values.label === l}
                onClick={() => setValues((v) => ({ ...v, label: l }))}
                className={`type-label-s h-9 rounded-full border px-4 capitalize ${values.label === l ? 'border-inverse bg-inverse text-paper' : 'border-line bg-surface text-ink'}`}
              >
                {l}
              </button>
            ))}
          </div>
        </Step>

        <Step n={3} title="Delivery">
          {quote.data ? (
            <div className="flex items-center gap-4 rounded-sf-xs border-2 border-brand bg-brand-soft px-4 py-4" data-sp-zone>
              <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-brand">
                <span className="size-2.5 rounded-full bg-brand" />
              </span>
              <Icon name="truck-sm" className="text-brand" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="type-label-m text-ink">{quote.data.zone_name}</span>
                <span className="type-body-s text-ink-secondary">{deliveryDays(quote.data.min_days, quote.data.max_days)}</span>
              </span>
              <span className="type-label-m text-ink">{shipping === 0 ? 'Free' : formatMoney(shipping ?? 0, c)}</span>
            </div>
          ) : quote.status === 'error' ? (
            <Notice tone="error">{quote.message}</Notice>
          ) : (
            <p className="type-body-s text-ink-muted">{quote.status === 'loading' ? 'Working out delivery…' : 'Choose your district and thana to see the delivery charge.'}</p>
          )}
          <p className="type-body-s flex items-center gap-2 text-ink-muted">
            <Icon name="info" />
            Delivery charge is set by your area.
          </p>
        </Step>

        <Step n={4} title="Payment">
          <div className="flex items-center gap-4 rounded-sf-xs border-2 border-brand bg-brand-soft px-4 py-4">
            <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-brand">
              <span className="size-2.5 rounded-full bg-brand" />
            </span>
            <Icon name="wallet" className="text-ink" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="type-label-m text-ink">Cash on delivery</span>
              <span className="type-body-s text-ink-secondary">Pay in cash when the parcel arrives</span>
            </span>
            <span className="type-label-s text-ink">No fee</span>
          </div>
          <p className="type-body-s flex items-center gap-2 rounded-sf-xs bg-sky-soft px-4 py-3 text-ink">
            <Icon name="phone" className="text-brand" />
            For some cash orders our team calls to confirm before dispatch — it only takes a minute.
          </p>
        </Step>

        <div className="flex flex-col gap-2">
          <label htmlFor="customer_note" className="type-label-s text-ink">
            Order note (optional)
          </label>
          <textarea id="customer_note" rows={3} maxLength={500} value={values.customer_note} onChange={set('customer_note')} aria-invalid={Boolean(errors.customer_note)} className="type-body-m w-full rounded-sf-xs border border-line bg-surface p-4 text-ink outline-none focus:border-2 focus:border-brand" />
          {errors.customer_note ? <p className="type-body-s text-sale">{errors.customer_note}</p> : null}
        </div>
      </div>

      <aside aria-labelledby="your-order" className="flex flex-col gap-5 rounded-sf-sm border border-line-subtle bg-surface p-5 lg:sticky lg:top-6 lg:w-[440px] lg:shrink-0 lg:p-7">
        <h2 id="your-order" className="type-h3 text-ink">
          Your order
        </h2>
        <ul className="flex flex-col gap-4">
          {summary.lines.map((l) => (
            <li key={l.id} className="flex items-center gap-3">
              <span className="relative size-14 shrink-0 overflow-hidden rounded-sf-xs bg-sunken">{l.image}</span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="type-label-s truncate text-ink">{l.name}</span>
                <span className="type-body-s text-ink-muted">
                  {l.variant ? `${l.variant} · ` : ''}Qty {l.quantity}
                </span>
              </span>
              <span className="type-label-s text-ink">{formatMoney(l.amount, c)}</span>
            </li>
          ))}
        </ul>
        <dl className="type-body-m flex flex-col gap-3 border-t border-line-subtle pt-5 text-ink-secondary">
          <div className="flex justify-between gap-4">
            <dt>Items ({summary.itemsCount})</dt>
            <dd className="text-ink">{formatMoney(summary.subtotal, c)}</dd>
          </div>
          {summary.coupon && summary.discount > 0 ? (
            <div className="flex justify-between gap-4">
              <dt>Coupon {summary.coupon.code}</dt>
              <dd className="text-sale">− {formatMoney(summary.discount, c)}</dd>
            </div>
          ) : null}
          <div className="flex justify-between gap-4">
            <dt>Delivery{quote.data ? ` · ${quote.data.zone_name}` : ''}</dt>
            <dd className={shipping === 0 ? 'text-brand' : 'text-ink'}>{shipping === null ? 'Choose your area' : shipping === 0 ? 'Free' : formatMoney(shipping, c)}</dd>
          </div>
        </dl>
        <div className="flex items-end justify-between gap-4 border-t border-line-subtle pt-5">
          <p className="type-label-m text-ink">Total to pay on delivery</p>
          <p className="type-price-l text-ink" data-sp-total>
            {total === null ? '—' : formatMoney(total, c)}
          </p>
        </div>
        <button
          type="submit"
          disabled={pending || state.status === 'redirect' || total === null || Boolean(notLiveMessage) || !geo}
          className="type-label-m flex h-[52px] items-center justify-center gap-2 rounded-control bg-brand px-5 text-on-brand hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending || state.status === 'redirect' ? 'Placing your order…' : total === null ? 'Place order' : `Place order — ${formatMoney(total, c)}`}
          <Icon name="lock" />
        </button>
        <p className="type-body-s text-ink-muted">Prices and delivery are confirmed by our server when you place the order.</p>
      </aside>
    </form>
  );
}
