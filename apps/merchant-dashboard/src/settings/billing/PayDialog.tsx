import { isApiError } from '@storeplix/api-client';
import type { BillingInvoiceSummary, GatewayProvider } from '@storeplix/types';
import { cn, Dialog, ProviderLogo } from '@storeplix/ui';
import { useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { errorMessage } from '../../catalog/states';
import { api } from '../../lib/api';
import { isSafeRedirect, money, newIdempotencyKey, providerLabel } from '../../plan/billing';

// §8.2 Pay dialog: provider from `meta.providers`, amount and invoice number → POST /billing/invoices/{id}/pay →
// window.location.assign(redirect_url) (https only, or the local fake page in dev). 502 → retry; 422
// `billing_gateway_unavailable` → that provider is hidden. One Idempotency-Key per provider per dialog open.

/** Navigation is a seam so tests can observe the redirect. */
export const payNavigation = { assign: (url: string) => window.location.assign(url) };

export function PayDialog({ invoice, providers, onClose }: { invoice: BillingInvoiceSummary; providers: GatewayProvider[]; onClose: () => void }) {
  const [hidden, setHidden] = useState<GatewayProvider[]>([]);
  const available = providers.filter((p) => !hidden.includes(p));
  const [selected, setSelected] = useState<GatewayProvider | null>(providers[0] ?? null);
  const provider = selected && available.includes(selected) ? selected : (available[0] ?? null);
  const [error, setError] = useState<string | null>(null);
  const keys = useRef(new Map<GatewayProvider, string>());

  const pay = useMutation({
    mutationFn: (p: GatewayProvider) => {
      if (!keys.current.has(p)) keys.current.set(p, newIdempotencyKey());
      return api.billing.pay(invoice.id, { provider: p }, keys.current.get(p)!);
    },
    onSuccess: (payment) => {
      if (isSafeRedirect(payment.redirect_url)) payNavigation.assign(payment.redirect_url);
      else setError('We couldn’t open the payment page. Try again in a moment.');
    },
    onError: (e, p) => {
      if (isApiError(e) && e.code === 'billing_gateway_unavailable') {
        setHidden((h) => [...h, p]);
        setError(`${providerLabel[p]} isn’t available right now. Choose another way to pay.`);
      } else if (isApiError(e) && e.status === 502) setError('The payment gateway didn’t answer. Nothing was charged — try again.');
      else if (isApiError(e) && e.code === 'invoice_not_open') setError('This invoice is already paid or closed. Refresh the page to see it.');
      else setError(errorMessage(e, 'We couldn’t start the payment. Try again.'));
    },
  });

  return (
    <Dialog
      open
      size="sm"
      title={`Pay ${money(invoice.total_amount)}`}
      description={`Invoice ${invoice.number} · ${invoice.description}`}
      confirmLabel={pay.isPending || pay.isSuccess ? 'Opening payment page…' : 'Pay now'}
      confirmDisabled={!provider || pay.isSuccess}
      loading={pay.isPending}
      onConfirm={() => {
        if (!provider) return;
        setError(null);
        pay.mutate(provider);
      }}
      onCancel={() => !pay.isPending && onClose()}
    >
      <div className="flex flex-col gap-3">
        {available.length === 0 ? (
          <p role="alert" className="rounded-lg bg-warning-bg px-4 py-3 text-body text-text-primary">
            Online payment isn’t available right now. Please try again later or contact support.
          </p>
        ) : (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-body font-medium text-text-primary">Pay with</legend>
            {available.map((p) => (
              <label
                key={p}
                className={cn(
                  'flex cursor-pointer items-center gap-3 rounded-lg border px-4 py-3',
                  provider === p ? 'border-brand-600 bg-brand-50' : 'border-border-default bg-surface-card hover:bg-surface-subtle',
                )}
              >
                <input type="radio" name="billing-provider" value={p} checked={provider === p} onChange={() => setSelected(p)} className="size-4 accent-brand-600" />
                <ProviderLogo provider={p} size="sm" />
                <span className="text-body font-medium text-text-primary">{providerLabel[p]}</span>
              </label>
            ))}
          </fieldset>
        )}
        <p className="text-caption text-text-muted">You’ll finish on the gateway’s page. Your plan changes only after the gateway confirms the payment.</p>
        {error && (
          <p role="alert" className="rounded-lg bg-danger-bg px-4 py-3 text-body text-text-primary">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
