'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from 'react';
import { CHECKOUT_CONTACT_NOTICE, type BdGeo, type GatewayProvider, type PaymentMethod, type ShippingQuote } from '@storeplix/types';
import { placeOrder, requestCheckoutOtp, saveCheckoutContact, type CheckoutState } from '@/app/actions/commerce';
import { advanceRequired, GATEWAYS, METHOD_HINT, METHOD_LABEL } from '@/lib/payments';
import { districtsOf, formatBdPhone, normalizeBdPhone, thanasOf, validateCheckoutForm, type CheckoutField, type FieldErrors } from '@/lib/checkout-form';
import { GUARD_COPY, OTP_CODE_RE, OTP_LENGTH, cleanOtpInput } from '@/lib/checkout-guard';
import { formatMoney } from '@/lib/format';
import { Icon } from '../components/icon';
import { deliveryDays, Notice, PageTitle } from './ui';
import { isNextRedirect } from './payment-client';

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
  /** 5b-2 (P5B-12): `cod` and/or enabled gateways, in display order; never empty. */
  paymentMethods: PaymentMethod[];
  /** 5b-2 (P5B-13): COD pays the delivery charge online first. */
  codAdvance: 'none' | 'delivery_charge';
}

type Values = Record<'name' | 'phone' | 'email' | 'division_code' | 'district_code' | 'thana_code' | 'area' | 'address_line' | 'landmark' | 'label' | 'customer_note', string>;

const EMPTY: Values = { name: '', phone: '', email: '', division_code: '', district_code: '', thana_code: '', area: '', address_line: '', landmark: '', label: 'home', customer_note: '' };

/**
 * PHASE-8-6 §10.6 notice under the phone field (Caption/12, muted). The storefront has no store-language setting yet, so
 * the English line is shown (the Bangla line is ready for when it does — same fallback as the 8.5 `/u` page).
 */
export const CONTACT_NOTICE = CHECKOUT_CONTACT_NOTICE;

export type ContactPayload = { phone: string; name?: string; email?: string };

/**
 * P86-12: what to save when a contact field loses focus, or null. Nothing until the phone is a valid BD mobile number;
 * after that name/email blurs re-send. An unchanged payload (same as `lastSent`) is not sent again.
 */
export function contactToSave(values: { phone: string; name: string; email: string }, lastSent: string | null): { payload: ContactPayload; key: string } | null {
  const phone = normalizeBdPhone(values.phone);
  if (!phone) return null;
  const name = values.name.trim();
  const email = values.email.trim();
  const payload: ContactPayload = { phone: values.phone.trim(), ...(name ? { name } : {}), ...(email ? { email } : {}) };
  const key = `${phone}|${name}|${email.toLowerCase()}`;
  return key === lastSent ? null : { payload, key };
}

const inputCls =
  'type-body-m h-[52px] w-full min-w-0 rounded-sf-md border bg-surface px-4 text-ink outline-none placeholder:text-ink-muted focus:border-2 focus:border-brand aria-[invalid=true]:border-sale';

/** Figma Select Field (1:9718): native select, custom caret (Icon/CaretDown 18). */
function SelectBox({ children }: { children: ReactNode }) {
  return (
    <div className="relative">
      {children}
      <Icon name="caret-down" size={18} className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-ink" />
    </div>
  );
}

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

const METHOD_ICON: Record<PaymentMethod, 'wallet' | 'phone' | 'lock'> = { cod: 'wallet', bkash: 'phone', sslcommerz: 'lock' };

function RadioCard({ checked, onSelect, icon, title, hint, aside, name, value, disabled = false }: { checked: boolean; onSelect: () => void; icon: 'wallet' | 'phone' | 'lock'; title: string; hint: string; aside?: string; name: string; value: string; disabled?: boolean }) {
  return (
    <label
      className={`flex items-center gap-3.5 rounded-sf-md p-4 ${disabled ? 'cursor-not-allowed border border-line bg-surface opacity-60' : checked ? 'cursor-pointer border-2 border-brand bg-brand-soft' : 'cursor-pointer border border-line bg-surface hover:border-ink'}`}
      data-sp-method={value}
      data-sp-disabled={disabled || undefined}
    >
      <input type="radio" name={name} value={value} checked={checked} onChange={onSelect} disabled={disabled} className="sr-only" />
      <span aria-hidden className={`flex size-[22px] shrink-0 items-center justify-center rounded-full border-2 ${checked ? 'border-brand bg-surface' : 'border-ink'}`}>
        {checked ? <span className="size-3 rounded-full bg-brand" /> : null}
      </span>
      <Icon name={icon} size={24} className={icon === 'wallet' ? 'text-ink' : 'text-brand'} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="type-label-m text-ink">{title}</span>
        <span className="type-body-s text-ink-muted">{hint}</span>
      </span>
      {aside ? <span className="type-label-m shrink-0 text-right text-ink">{aside}</span> : null}
    </label>
  );
}

/** PHASE-8-8 §7: where the phone-code request for the current phone stands. */
export type OtpRequest = { phone: string; status: 'sending' | 'sent' | 'not_needed' | 'error'; resendAt: number; message?: string };

/**
 * P88-13: the code field shows for a COD checkout once the API said a code was sent to this phone, or the checkout
 * answered `otp_required` / `otp_invalid` for it. Online methods never need a code.
 */
export function otpVisible(method: PaymentMethod, phone: string | null, otp: OtpRequest | null, forcedFor: string | null): boolean {
  if (method !== 'cod' || !phone) return false;
  if (forcedFor === phone) return true;
  return otp?.phone === phone && otp.status !== 'not_needed';
}

/** The code is checked locally only when the API said it was sent (or the checkout asked for it). */
export function otpMissing(code: string, otp: OtpRequest | null, phone: string | null, forcedFor: string | null): boolean {
  if (!phone) return false;
  const expected = forcedFor === phone || (otp?.phone === phone && otp.status === 'sent');
  return expected && !OTP_CODE_RE.test(code);
}

/** Checkout OTP step (composed, §10.4): six boxes over one `one-time-code` input, help line, resend with a timer. */
export function OtpField({
  phone,
  value,
  onChange,
  error,
  status,
  statusMessage,
  resendSeconds,
  onResend,
}: {
  phone: string;
  value: string;
  onChange: (code: string) => void;
  error: string | null;
  status: OtpRequest['status'] | null;
  statusMessage?: string;
  resendSeconds: number;
  onResend: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const help = status === 'sending' ? GUARD_COPY.otpSending.en : status === 'error' && statusMessage ? statusMessage : GUARD_COPY.otpHelp(formatBdPhone(phone)).en;
  const describedBy = error ? 'otp_code-error otp_code-hint' : 'otp_code-hint';
  return (
    <div className="flex flex-col gap-2" data-sp-otp>
      <label htmlFor="otp_code" className="type-label-s text-ink">
        {GUARD_COPY.otpLabel.en}
      </label>
      <div className="relative w-fit max-w-full">
        <div aria-hidden className="flex gap-2">
          {Array.from({ length: OTP_LENGTH }, (_, i) => {
            const active = focused && i === Math.min(value.length, OTP_LENGTH - 1);
            return (
              <span
                key={i}
                className={`type-h3 flex h-[52px] w-11 items-center justify-center rounded-sf-md bg-surface text-ink ${error ? 'border border-sale' : active ? 'border-2 border-brand' : 'border border-line'}`}
              >
                {value[i] ?? ''}
              </span>
            );
          })}
        </div>
        <input
          id="otp_code"
          name="otp_code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={OTP_LENGTH}
          value={value}
          onChange={(e) => onChange(cleanOtpInput(e.target.value))}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          className="absolute inset-0 h-full w-full cursor-text opacity-0"
        />
      </div>
      {error ? (
        <p id="otp_code-error" className="type-body-s text-sale" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p id="otp_code-hint" className={`type-body-s ${status === 'error' && statusMessage ? 'text-sale' : 'text-ink-muted'}`} aria-live="polite">
          {help}
        </p>
        <button type="button" onClick={onResend} disabled={status === 'sending' || resendSeconds > 0} className="type-label-s text-brand hover:underline disabled:cursor-not-allowed disabled:text-ink-muted disabled:no-underline" data-sp-otp-resend>
          {resendSeconds > 0 ? GUARD_COPY.resendIn(resendSeconds).en : GUARD_COPY.resend.en}
        </button>
      </div>
    </div>
  );
}

const STEPS = ['Bag', 'Delivery', 'Payment', 'Confirm'];

/**
 * Title + steps at the top of the form column (Figma 1:11591: the summary starts level with the title;
 * Checkout Steps 1:11594 is decorative, one page in 5a). Phones (1:11690) show a single step line.
 */
function CheckoutHeading() {
  return (
    <div className="flex flex-col-reverse gap-6">
      <div className="max-lg:sr-only">
        <PageTitle title="Checkout" count="— takes about a minute" size="m" />
      </div>
      <p aria-hidden className="type-label-s -mx-4 -mt-6 border-b border-line px-4 py-3 text-ink-muted lg:hidden">
        Step 2 of 4 · Delivery &amp; payment
      </p>
      <ol aria-hidden className="type-label-m hidden flex-wrap items-center gap-3 text-ink-muted lg:flex">
        {STEPS.map((step, i) => (
          <li key={step} className="flex items-center gap-3">
            {i > 0 ? <span className="h-px w-6 bg-line" /> : null}
            <span className={`type-label-s flex size-7 items-center justify-center rounded-full ${i <= 1 ? 'bg-brand text-on-brand' : 'border border-line bg-surface'}`}>
              {i === 0 ? <Icon name="check" size={14} /> : i + 1}
            </span>
            <span className={i <= 1 ? 'text-ink' : ''}>{step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`step-${n}`} className="flex flex-col gap-3.5 rounded-sf-md border border-line bg-surface p-4.5 lg:gap-[18px] lg:p-7">
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
 * `/geo/bd`, the one resolved delivery zone, payment (COD, bKash, "Card or mobile banking"; 5b-2). The Idempotency-Key is created on the server and
 * reused for retries of the same attempt (P5-14); the total sent is what the shopper sees (P5-15).
 */
export function CheckoutForm({ geo, summary, idempotencyKey, notLiveMessage, paymentMethods, codAdvance }: Props) {
  const [values, setValues] = useState<Values>(EMPTY);
  const [method, setMethod] = useState<PaymentMethod>(paymentMethods[0] ?? 'cod');
  const gateways = GATEWAYS.filter((g) => paymentMethods.includes(g));
  const [advanceGateway, setAdvanceGateway] = useState<GatewayProvider | null>(gateways[0] ?? null);
  const [leaving, setLeaving] = useState(false);
  const [clientErrors, setClientErrors] = useState<FieldErrors>({});
  const [quote, setQuote] = useState<{ status: 'idle' | 'loading' | 'error'; data: ShippingQuote | null; message?: string }>({ status: 'idle', data: null });
  const [state, setState] = useState<CheckoutState>({ status: 'idle', message: null, fieldErrors: {}, idempotencyKey });
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  // Guards double submits between the click and React's pending state.
  const inFlight = useRef(false);
  const errors: FieldErrors = { ...state.fieldErrors, ...clientErrors };
  // PHASE-8-8 §7: phone code (COD), and the phone COD was refused for (P88-9; neutral, only that phone).
  const phone = useMemo(() => normalizeBdPhone(values.phone), [values.phone]);
  const [otp, setOtp] = useState<OtpRequest | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpForcedFor, setOtpForcedFor] = useState<string | null>(null);
  const [codBlockedFor, setCodBlockedFor] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const otpSeq = useRef(0);
  const otpRef = useRef<OtpRequest | null>(null);
  useEffect(() => {
    otpRef.current = otp;
  }, [otp]);
  const sendOtp = useCallback((to: string) => {
    const seq = ++otpSeq.current;
    setOtp({ phone: to, status: 'sending', resendAt: 0 });
    setNow(Date.now());
    requestCheckoutOtp({ phone: to })
      .then((r) => {
        if (seq !== otpSeq.current) return;
        setNow(Date.now());
        if (r.ok) setOtp({ phone: to, status: r.required ? 'sent' : 'not_needed', resendAt: Date.now() + r.resendAfterSeconds * 1000 });
        else setOtp({ phone: to, status: 'error', resendAt: 0, message: r.message });
      })
      .catch(() => {
        if (seq === otpSeq.current) setOtp({ phone: to, status: 'error', resendAt: 0, message: 'We couldn’t reach the shop. Check your connection and try again.' });
      });
  }, []);
  const codBlocked = Boolean(phone) && codBlockedFor === phone;
  // P88-13: once COD is chosen and the phone is a full BD number, ask (debounced) whether a code is needed.
  useEffect(() => {
    if (method !== 'cod' || !phone || notLiveMessage || codBlockedFor === phone || otp?.phone === phone) return;
    const t = setTimeout(() => {
      setOtpCode('');
      setOtpError(null);
      sendOtp(phone);
    }, 700);
    return () => clearTimeout(t);
  }, [method, phone, notLiveMessage, codBlockedFor, otp?.phone, sendOtp]);
  // Resend timer ("Resend in 0:42").
  const resendSeconds = otp && otp.resendAt > now ? Math.ceil((otp.resendAt - now) / 1000) : 0;
  useEffect(() => {
    if (!otp || otp.resendAt <= Date.now()) return;
    const until = otp.resendAt;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= until) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [otp]);
  const showOtp = otpVisible(method, phone, otp, otpForcedFor);

  // P86-12: last contact sent to the cart (fire-and-forget; never awaited by submit).
  const contactSent = useRef<string | null>(null);
  const captureContact = () => {
    const next = contactToSave(values, contactSent.current);
    if (!next) return;
    contactSent.current = next.key;
    saveCheckoutContact(next.payload).catch(() => undefined);
  };

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
  const online = method !== 'cod';
  // P5B-13: before the address is known the charge is unknown; assume one applies (most zones charge).
  const advance = codAdvance === 'delivery_charge' && method === 'cod' && (shipping === null || advanceRequired(codAdvance, method, shipping));
  const advanceBlocked = advance && gateways.length === 0;
  const payNow = total === null ? null : online ? total : advance && shipping ? shipping : 0;
  const goingTo = online ? method : advance ? advanceGateway : null;

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

  /** PHASE-8-8 §7: react to a guard refusal (code field, COD off for that phone + online preselected). */
  const applyGuard = (next: CheckoutState) => {
    const g = next.guard;
    if (!g) {
      setOtpError(null);
      return;
    }
    if (g.code === 'otp_required' || g.code === 'otp_invalid') {
      setOtpForcedFor(g.phone);
      setOtpError(next.otpError ?? GUARD_COPY.otpRequired.en);
      if (g.code === 'otp_invalid' && g.attemptsLeft === 0) setOtpCode('');
      const current = otpRef.current;
      if (g.code === 'otp_required' && (current?.phone !== g.phone || current.status === 'not_needed')) sendOtp(g.phone);
      requestAnimationFrame(() => document.getElementById('otp_code')?.focus());
    } else if (g.code === 'cod_unavailable') {
      setCodBlockedFor(g.phone);
      setOtpError(null);
      const online = paymentMethods.find((m) => m !== 'cod');
      if (online) setMethod(online);
      requestAnimationFrame(() => document.getElementById('step-4')?.scrollIntoView({ block: 'center' }));
    }
  };

  const resendOtp = () => {
    if (!phone) return;
    setOtpCode('');
    setOtpError(null);
    sendOtp(phone);
  };

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
    if (method === 'cod' && otpMissing(otpCode, otp, phone, otpForcedFor)) {
      setOtpError(GUARD_COPY.otpRequired.en);
      document.getElementById('otp_code')?.focus();
      return;
    }
    const fd = new FormData();
    for (const [k, val] of Object.entries(values)) fd.set(k, val);
    fd.set('idempotency_key', state.idempotencyKey);
    fd.set('expected_total_amount', String(total));
    fd.set('payment_method', method);
    if (advance && advanceGateway) fd.set('advance_gateway', advanceGateway);
    if (method === 'cod' && showOtp && otpCode) fd.set('otp_code', otpCode);
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
        applyGuard(next);
        setState(next);
      } catch (e) {
        // Online payment: the action redirected to the gateway; Next is already navigating away.
        if (isNextRedirect(e)) {
          setLeaving(true);
          return;
        }
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
        <CheckoutHeading />
        {notLiveMessage ? <Notice tone="error">{notLiveMessage}</Notice> : null}
        {state.message && state.status !== 'invalid' && state.guard?.code !== 'cod_unavailable' ? <Notice tone="error">{state.message}</Notice> : null}

        <Step n={1} title="Contact">
          <div className="grid gap-3.5 md:grid-cols-2 md:gap-x-4 lg:gap-y-[18px]">
            <Field id="name" label="Full name" error={errors.name}>
              <input id="name" name="name" autoComplete="name" value={values.name} onChange={set('name')} onBlur={captureContact} aria-invalid={Boolean(errors.name)} aria-describedby={describedBy('name')} className={`${inputCls} border-line`} />
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
                onBlur={captureContact}
                aria-invalid={Boolean(errors.phone)}
                aria-describedby={`${describedBy('phone') ?? 'phone-hint'} phone-recovery-notice`}
                className={`${inputCls} border-line`}
              />
              <p id="phone-recovery-notice" data-sp-contact-notice className="order-last text-xs leading-[1.5] text-ink-muted">
                {CONTACT_NOTICE.en}
              </p>
            </Field>
          </div>
          {showOtp && phone ? (
            <OtpField
              phone={phone}
              value={otpCode}
              onChange={(code) => {
                setOtpCode(code);
                if (otpError) setOtpError(null);
              }}
              error={otpError}
              status={otp?.phone === phone ? otp.status : null}
              statusMessage={otp?.phone === phone ? otp.message : undefined}
              resendSeconds={otp?.phone === phone ? resendSeconds : 0}
              onResend={resendOtp}
            />
          ) : null}
          <Field id="email" label="Email (optional)" error={errors.email}>
            <input id="email" name="email" type="email" autoComplete="email" placeholder="For your receipt" value={values.email} onChange={set('email')} onBlur={captureContact} aria-invalid={Boolean(errors.email)} aria-describedby={describedBy('email')} className={`${inputCls} border-line`} />
          </Field>
        </Step>

        <Step n={2} title="Delivery address">
          {!geo ? <Notice tone="error">We couldn’t load delivery areas. Refresh the page to try again.</Notice> : null}
          <div className="grid gap-3.5 md:grid-cols-2 md:gap-x-4 lg:gap-y-[18px]">
            <Field id="division_code" label="Division">
              <SelectBox>
              <select id="division_code" value={values.division_code} onChange={set('division_code')} className={`${inputCls} appearance-none border-line pr-11`}>
                <option value="">Choose division</option>
                {divisions.map((d) => (
                  <option key={d.code} value={d.code}>
                    {d.name}
                  </option>
                ))}
              </select>
              </SelectBox>
            </Field>
            <Field id="district_code" label="District" error={errors.district_code}>
              <SelectBox>
              <select id="district_code" value={values.district_code} onChange={set('district_code')} disabled={!values.division_code} aria-invalid={Boolean(errors.district_code)} aria-describedby={describedBy('district_code')} className={`${inputCls} appearance-none border-line pr-11 disabled:opacity-60`}>
                <option value="">Choose district</option>
                {districts.map((d) => (
                  <option key={d.code} value={d.code}>
                    {d.name}
                  </option>
                ))}
              </select>
              </SelectBox>
            </Field>
            <Field id="thana_code" label="Upazila / Thana" error={errors.thana_code}>
              <SelectBox>
              <select id="thana_code" value={values.thana_code} onChange={set('thana_code')} disabled={!values.district_code} aria-invalid={Boolean(errors.thana_code)} aria-describedby={describedBy('thana_code')} className={`${inputCls} appearance-none border-line pr-11 disabled:opacity-60`}>
                <option value="">Choose upazila / thana</option>
                {thanas.map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.name}
                  </option>
                ))}
              </select>
              </SelectBox>
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
          <div role="radiogroup" aria-label="Address type" className="flex items-center gap-2">
            {(['home', 'office'] as const).map((l) => (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={values.label === l}
                onClick={() => setValues((v) => ({ ...v, label: l }))}
                className={`type-label-s rounded-full px-4 py-2 capitalize ${values.label === l ? 'bg-inverse text-paper' : 'border border-line bg-surface text-ink'}`}
              >
                {l}
              </button>
            ))}
          </div>
        </Step>

        <Step n={3} title="Delivery">
          {quote.data ? (
            <div className="flex items-center gap-3.5 rounded-sf-md border-2 border-brand bg-brand-soft p-4" data-sp-zone>
              <span aria-hidden className="flex size-[22px] shrink-0 items-center justify-center rounded-full border-2 border-brand bg-surface">
                <span className="size-3 rounded-full bg-brand" />
              </span>
              <Icon name="truck-sm" size={24} className="text-brand" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="type-label-m text-ink">{quote.data.zone_name}</span>
                <span className="type-body-s text-ink-muted">{deliveryDays(quote.data.min_days, quote.data.max_days)}</span>
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
          <div role="radiogroup" aria-label="Payment method" className="flex flex-col gap-[18px]">
            {paymentMethods.map((m) => (
              <RadioCard
                key={m}
                name="payment_method"
                value={m}
                checked={method === m}
                disabled={m === 'cod' && codBlocked}
                onSelect={() => setMethod(m)}
                icon={METHOD_ICON[m]}
                title={METHOD_LABEL[m]}
                hint={
                  m === 'cod' && codAdvance === 'delivery_charge'
                    ? shipping
                      ? `Pay the ${formatMoney(shipping, c)} delivery charge now, the rest on delivery`
                      : 'Pay the delivery charge now, the rest on delivery'
                    : METHOD_HINT[m]
                }
                aside={m === 'cod' && codAdvance !== 'delivery_charge' ? 'No fee' : undefined}
              />
            ))}
          </div>
          {codBlocked ? (
            <Notice tone="error">
              <span data-sp-cod-unavailable>{GUARD_COPY.codUnavailable.en}</span>
            </Notice>
          ) : null}
          {advance && gateways.length > 0 ? (
            <fieldset className="flex flex-col gap-3 rounded-sf-xs bg-sunken p-4" data-sp-advance>
              <legend className="type-label-s float-left mb-3 w-full text-ink">Pay the delivery charge with</legend>
              <div className="flex flex-wrap gap-2">
                {gateways.map((g) => (
                  <label key={g} className={`type-label-s flex h-9 cursor-pointer items-center rounded-full border px-4 ${advanceGateway === g ? 'border-inverse bg-inverse text-paper' : 'border-line bg-surface text-ink'}`}>
                    <input type="radio" name="advance_gateway" value={g} checked={advanceGateway === g} onChange={() => setAdvanceGateway(g)} className="sr-only" />
                    {METHOD_LABEL[g]}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          {advanceBlocked ? <Notice tone="error">This shop needs the delivery charge paid in advance, but online payment isn&apos;t available right now. Contact the shop to order.</Notice> : null}
          {online ? (
            <p className="type-body-s flex items-start gap-2.5 rounded-sf-sm bg-sky-tint p-3.5 text-ink-secondary">
              <Icon name="lock" className="mt-px text-brand" />
              {method === 'bkash' ? "You'll approve the payment in bKash, then come back here." : "You'll pay on the secure SSLCommerz page, then come back here."} Your order is held for 30 minutes.
            </p>
          ) : (
            <p className="type-body-s flex items-start gap-2.5 rounded-sf-sm bg-sky-tint p-3.5 text-ink-secondary">
              <Icon name="phone" size={18} className="mt-px text-brand" />
              For some cash orders our team calls to confirm before dispatch — it only takes a minute.
            </p>
          )}
          {!online ? (
            <p className="type-body-s text-ink-muted" data-sp-guard-privacy>
              {GUARD_COPY.privacy.en}
            </p>
          ) : null}
        </Step>

        <div className="flex flex-col gap-2">
          <label htmlFor="customer_note" className="type-label-s text-ink">
            Order note (optional)
          </label>
          <textarea id="customer_note" rows={3} maxLength={500} value={values.customer_note} onChange={set('customer_note')} aria-invalid={Boolean(errors.customer_note)} className="type-body-m w-full rounded-sf-md border border-line bg-surface p-4 text-ink outline-none focus:border-2 focus:border-brand" />
          {errors.customer_note ? <p className="type-body-s text-sale">{errors.customer_note}</p> : null}
        </div>
      </div>

      <aside aria-labelledby="your-order" className="flex flex-col gap-4 rounded-sf-md border border-line bg-surface p-5 lg:sticky lg:top-6 lg:w-[440px] lg:shrink-0 lg:p-7">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="your-order" className="type-h3 text-ink">
            Your order
          </h2>
          <Link href="/cart" className="type-label-s text-brand hover:underline">
            Edit bag
          </Link>
        </div>
        <ul className="flex flex-col gap-4">
          {summary.lines.map((l) => (
            <li key={l.id} className="flex items-center gap-3">
              <span className="relative h-16 w-14 shrink-0 overflow-hidden rounded-sf-xs bg-sunken">{l.image}</span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="type-label-s truncate text-ink">{l.name}</span>
                <span className="type-body-s text-ink-muted">
                  {l.variant ? `${l.variant} · ` : ''}Qty {l.quantity}
                </span>
              </span>
              <span className="type-label-m text-ink">{formatMoney(l.amount, c)}</span>
            </li>
          ))}
        </ul>
        <hr className="border-line" />
        <dl className="type-body-m flex flex-col gap-4 text-ink-secondary">
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
        <hr className="border-line" />
        <div className="flex items-baseline justify-between gap-4">
          <p className="type-label-m text-ink">{online ? 'Total to pay now' : advance ? 'Total' : 'Total to pay on delivery'}</p>
          <p className="type-price-l text-ink" data-sp-total>
            {total === null ? '—' : formatMoney(total, c)}
          </p>
        </div>
        {advance && total !== null && payNow ? (
          <dl className="type-body-s -mt-2 flex flex-col gap-1 text-ink-secondary" data-sp-advance-split>
            <div className="flex justify-between gap-4">
              <dt>Pay now (delivery charge)</dt>
              <dd className="text-ink">{formatMoney(payNow, c)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Pay on delivery</dt>
              <dd className="text-ink">{formatMoney(total - payNow, c)}</dd>
            </div>
          </dl>
        ) : null}
        <button
          type="submit"
          disabled={pending || leaving || state.status === 'redirect' || total === null || Boolean(notLiveMessage) || !geo || advanceBlocked || (method === 'cod' && codBlocked)}
          className="type-label-m flex h-[52px] items-center justify-center gap-2 rounded-control bg-brand px-5 text-on-brand hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {leaving && goingTo
            ? `Taking you to ${goingTo === 'bkash' ? 'bKash' : 'the payment page'}…`
            : pending || leaving || state.status === 'redirect'
              ? 'Placing your order…'
              : total === null
                ? 'Place order'
                : online
                  ? `Pay ${formatMoney(total, c)} with ${method === 'bkash' ? 'bKash' : 'card or mobile banking'}`
                  : advance && payNow
                    ? `Place order — pay ${formatMoney(payNow, c)} now`
                    : `Place order — ${formatMoney(total, c)}`}
          <Icon name="lock" />
        </button>
        <p className="type-body-s text-ink-muted">Prices and delivery are confirmed by our server when you place the order.</p>
      </aside>
    </form>
  );
}
