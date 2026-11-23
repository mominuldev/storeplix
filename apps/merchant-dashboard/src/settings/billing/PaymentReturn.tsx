import type { BillingPayment } from '@storeplix/types';
import { Button, cn, Spinner } from '@storeplix/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { api } from '../../lib/api';
import { billingKeys, invalidatePlanState } from '../../plan/billing';

// §8.2 Return: /settings/plan?payment={id} → poll GET /billing/payments/{id} every 2 s for 60 s, then every 15 s.
// `payment_error=1` → generic error. The page removes the query params after reading them.

export const FAST_POLL_MS = 2_000;
export const SLOW_POLL_MS = 15_000;
export const FAST_WINDOW_MS = 60_000;

const providerName = (p: BillingPayment['provider']) => (p === 'bkash' ? 'bKash' : p === 'sslcommerz' ? 'SSLCommerz' : 'the gateway');

function Frame({ tone, children, onDismiss, action }: { tone: 'success' | 'danger' | 'info'; children: React.ReactNode; onDismiss?: () => void; action?: React.ReactNode }) {
  const Icon = tone === 'success' ? CheckCircle2 : AlertTriangle;
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex flex-wrap items-center gap-2.5 rounded-lg px-4 py-3', tone === 'success' ? 'bg-success-bg' : tone === 'danger' ? 'bg-danger-bg' : 'bg-info-bg')}
    >
      {tone === 'info' ? <Spinner size="sm" label="Checking payment" /> : <Icon aria-hidden className={cn('size-4 shrink-0', tone === 'success' ? 'text-success' : 'text-danger')} />}
      <p className="min-w-[12rem] flex-1 text-body text-text-primary">{children}</p>
      {action}
      {onDismiss && (
        <button type="button" aria-label="Dismiss" onClick={onDismiss} className="rounded-md p-1 text-text-secondary hover:bg-surface-card/60">
          <X aria-hidden className="size-4" />
        </button>
      )}
    </div>
  );
}

export function PaymentReturnBanner({
  paymentId,
  error,
  onDismiss,
  onPayAgain,
}: {
  paymentId: string | null;
  error: boolean;
  onDismiss: () => void;
  onPayAgain: (invoiceId: string) => void;
}) {
  const { tenantId } = useAuth();
  const qc = useQueryClient();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), FAST_WINDOW_MS);
    return () => clearTimeout(t);
  }, []);
  const payment = useQuery({
    queryKey: billingKeys.payment(tenantId, paymentId ?? ''),
    queryFn: () => api.billing.payment(paymentId!),
    enabled: !!paymentId,
    retry: 1,
    refetchInterval: (q) => (q.state.data && q.state.data.status !== 'pending' ? false : slow ? SLOW_POLL_MS : FAST_POLL_MS),
  });
  const p = payment.data;
  const invoice = useQuery({
    queryKey: billingKeys.invoice(tenantId, p?.invoice_id ?? ''),
    queryFn: () => api.billing.invoice(p!.invoice_id),
    enabled: p?.status === 'succeeded',
    retry: false,
  });
  const refreshed = useRef(false);
  useEffect(() => {
    if (p?.status === 'succeeded' && !refreshed.current) {
      refreshed.current = true;
      void invalidatePlanState(qc);
    }
  }, [p?.status, qc]);
  const sub = qc.getQueryData<{ plan: { name: string } }>(billingKeys.subscription(tenantId));

  if (error) {
    return (
      <Frame tone="danger" onDismiss={onDismiss}>
        We couldn’t confirm that payment. If money left your account it shows up here within a few minutes; otherwise pay again from your invoices.
      </Frame>
    );
  }
  if (!paymentId) return null;
  if (payment.isError) {
    return (
      <Frame tone="danger" onDismiss={onDismiss}>
        We couldn’t check your payment. Refresh the page in a moment.
      </Frame>
    );
  }
  if (!p || p.status === 'pending') {
    return <Frame tone="info">{slow && p ? `We’re confirming with ${providerName(p.provider)}. This page updates by itself.` : 'Confirming your payment…'}</Frame>;
  }
  if (p.status === 'succeeded') {
    const planName = invoice.data?.plan_code ? (sub?.plan.name ?? invoice.data.plan_code) : sub?.plan.name;
    return (
      <Frame tone="success" onDismiss={onDismiss}>
        {planName ? `You’re on ${planName}.` : 'Payment received.'}
        {invoice.data ? ` Receipt ${invoice.data.number}.` : ''}
      </Frame>
    );
  }
  return (
    <Frame
      tone="danger"
      onDismiss={onDismiss}
      action={
        <Button size="sm" variant="secondary" onClick={() => onPayAgain(p.invoice_id)}>
          Pay again
        </Button>
      }
    >
      Payment didn’t go through. You haven’t been charged.
    </Frame>
  );
}
