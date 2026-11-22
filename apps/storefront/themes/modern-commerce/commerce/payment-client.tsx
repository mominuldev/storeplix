'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { payLink, payOrder, type PayActionResult } from '@/app/actions/commerce';
import { METHOD_LABEL, startPaymentPoller, type PolledStatus } from '@/lib/payments';
import type { GatewayProvider } from '@storeplix/types';
import { Icon } from '../components/icon';
import { Notice } from './ui';

/**
 * Client pieces of the online-payment screens (PHASE-5B-CONTRACT §11): retry / switch to COD,
 * the pay-link button and the pending-status poller. They only ever see payment ids and the
 * public link token already in the URL; order tokens stay in the httpOnly cookie.
 */

/** A Server Action that called `redirect()` rejects on the client while Next navigates away. */
export function isNextRedirect(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'digest' in e && String((e as { digest: unknown }).digest).startsWith('NEXT_REDIRECT');
}

const btn = 'type-label-m flex h-[52px] items-center justify-center gap-2 rounded-control px-7 disabled:cursor-not-allowed disabled:opacity-60';

function usePayAction(initialKey: string) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [leaving, setLeaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const key = useRef(initialKey);
  const inFlight = useRef(false);

  const run = (call: (idempotencyKey: string) => Promise<PayActionResult>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setMessage(null);
    startTransition(async () => {
      try {
        const r = await call(key.current);
        if (r.ok) {
          setLeaving(true);
          router.replace(r.redirect);
          router.refresh();
          return;
        }
        key.current = r.idempotencyKey;
        setInvalid(Boolean(r.invalid));
        setMessage(r.message);
      } catch (e) {
        if (isNextRedirect(e)) {
          setLeaving(true); // on the way to the gateway
          return;
        }
        setMessage('We couldn’t reach the shop. Check your connection and try again.');
      } finally {
        inFlight.current = false;
      }
    });
  };
  return { run, busy: pending || leaving, message, invalid };
}

/** "Try again" (same gateway) and "Pay on delivery instead" (P5B-17). */
export function RetryPayment({ retry, cod, idempotencyKey, tone = 'light' }: { retry: GatewayProvider | null; cod: boolean; idempotencyKey: string; tone?: 'light' | 'brand' }) {
  const { run, busy, message } = usePayAction(idempotencyKey);
  if (!retry && !cod) return null;
  return (
    <div className="flex w-full flex-col gap-3" data-sp-retry>
      {message ? <Notice tone="error">{message}</Notice> : null}
      <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
        {retry ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => run((k) => payOrder({ method: retry, idempotencyKey: k }))}
            className={`${btn} ${tone === 'brand' ? 'bg-surface text-[#0e1a33] hover:bg-sunken' : 'bg-brand text-on-brand hover:brightness-110'}`}
          >
            {busy ? 'One moment…' : `Try again with ${retry === 'bkash' ? 'bKash' : 'card or mobile banking'}`}
            <Icon name="arrow-right-sm" />
          </button>
        ) : null}
        {cod ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => run((k) => payOrder({ method: 'cod', idempotencyKey: k }))}
            className={`${btn} ${tone === 'brand' ? 'bg-accent text-on-accent hover:brightness-105' : 'border-[1.5px] border-ink text-ink hover:bg-ink/5'}`}
          >
            Pay on delivery instead
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Pay page button (`payLink` → gateway redirect). */
export function PayLinkButton({ token, provider, amountText, idempotencyKey }: { token: string; provider: GatewayProvider; amountText: string; idempotencyKey: string }) {
  const { run, busy, message, invalid } = usePayAction(idempotencyKey);
  const router = useRouter();
  useEffect(() => {
    // The link expired or was used while the page was open: show the one invalid page.
    if (invalid) router.refresh();
  }, [invalid, router]);
  return (
    <div className="flex w-full flex-col gap-3">
      {message ? <Notice tone="error">{message}</Notice> : null}
      <button type="button" disabled={busy} onClick={() => run((k) => payLink({ token, idempotencyKey: k }))} className={`${btn} w-full bg-brand text-on-brand hover:brightness-110`} data-sp-pay-link>
        {busy ? `Taking you to ${provider === 'bkash' ? 'bKash' : 'the payment page'}…` : `Pay ${amountText} with ${METHOD_LABEL[provider]}`}
        <Icon name="lock" />
      </button>
    </div>
  );
}

/**
 * Pending payment (§11): polls `/api/payment-status` every 2 s for at most 30 s. A settled payment
 * re-renders the server page (paid → thank-you view, failed → retry); after 30 s it stops and says
 * we're still confirming.
 */
export function PaymentPoller({ paymentId }: { paymentId: string }) {
  const router = useRouter();
  const [timedOut, setTimedOut] = useState(false);
  useEffect(
    () =>
      startPaymentPoller({
        fetchStatus: async (signal) => {
          const res = await fetch(`/api/payment-status?payment=${encodeURIComponent(paymentId)}`, { cache: 'no-store', signal });
          if (!res.ok) return null;
          const body = (await res.json().catch(() => null)) as { data?: { status?: unknown } } | null;
          const s = body?.data?.status;
          return s === 'pending' || s === 'succeeded' || s === 'failed' || s === 'cancelled' ? (s as PolledStatus) : null;
        },
        onSettled: () => router.refresh(),
        onTimeout: () => setTimedOut(true),
      }),
    [paymentId, router],
  );
  return timedOut ? (
    <div className="flex flex-col gap-2" role="status" data-sp-confirming>
      <p className="type-h3">We&apos;re confirming your payment</p>
      <p className="type-body-m opacity-90">This can take a few minutes. You don&apos;t need to pay again — we&apos;ll send you an SMS as soon as it&apos;s confirmed.</p>
      <button type="button" onClick={() => router.refresh()} className="type-label-m self-start underline underline-offset-4">
        Check again
      </button>
    </div>
  ) : (
    <p className="type-body-l flex items-center gap-3 opacity-90" role="status" data-sp-polling>
      <span aria-hidden className="size-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      Checking your payment… keep this page open.
    </p>
  );
}
