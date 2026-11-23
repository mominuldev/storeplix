import type { BillingDowngradeWarning, BillingInterval, BillingInvoiceSummary, BillingQuote, Plan } from '@storeplix/types';
import { Dialog, Spinner } from '@storeplix/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { errorMessage } from '../../catalog/states';
import { api } from '../../lib/api';
import { toast } from '../../online-store/components/Toast';
import { billingKeys, formatDate, intervalWord, invalidatePlanState, money, newIdempotencyKey, planPrice } from '../../plan/billing';

// §8.2 Change plan dialog: POST /billing/quote → amount and "what happens when" → POST /billing/change-plan with a fresh
// Idempotency-Key per dialog open. new/upgrade continue to the Pay dialog with the open invoice.

/**
 * A quote warning "fits" the target plan only for a limit with room (limit null = unlimited, or used ≤ limit). Feature
 * losses come with `used: null, limit: null` and never fit. `message` is shown as the API sends it.
 */
export function warningFits(w: BillingDowngradeWarning): boolean {
  if (w.used === null && w.limit === null) return false;
  return w.limit === null || (w.used !== null && w.used <= w.limit);
}

const isPast = (iso: string, now = Date.now()) => Date.parse(iso) <= now + 60_000;

/** One sentence that says what is charged and when the change takes effect. */
export function quoteSummary(q: BillingQuote, now = Date.now()): string {
  const price = planPrice(q.plan, q.interval);
  const next = price !== null && q.period_end ? `, then ${money(price)} on ${formatDate(q.period_end)}` : '';
  switch (q.kind) {
    case 'new':
      return `Charged ${money(q.amount)} now for your ${q.plan.name} plan${q.period_end ? ` until ${formatDate(q.period_end)}` : ''}${next}.`;
    case 'upgrade':
      return q.credit_amount > 0
        ? `Charged ${money(q.amount)} now (${money(q.credit_amount)} credit for the unused time included)${next}.`
        : `Charged ${money(q.amount)} now for the rest of this ${intervalWord(q.interval)}${next}.`;
    case 'downgrade':
      return `Switches to ${q.plan.name} (${intervalWord(q.interval)}ly) on ${formatDate(q.effective_at)}, no charge. You keep your current plan until then.`;
    case 'cancel':
      return isPast(q.effective_at, now)
        ? 'Your shop moves to the Free plan now, no charge. Nothing is deleted.'
        : `Switches to Free on ${formatDate(q.effective_at)}, no charge. You keep your current plan until then.`;
  }
}

export function ChangePlanDialog({
  plan,
  interval,
  onClose,
  onInvoice,
}: {
  plan: Plan;
  interval: BillingInterval;
  onClose: () => void;
  onInvoice: (invoice: BillingInvoiceSummary) => void;
}) {
  const { tenantId } = useAuth();
  const qc = useQueryClient();
  const [idempotencyKey] = useState(newIdempotencyKey);
  const input = { plan_code: plan.code, interval: plan.code === 'free' ? ('month' as const) : interval };
  const quote = useQuery({
    queryKey: billingKeys.quote(tenantId, input.plan_code, input.interval),
    queryFn: () => api.billing.quote(input),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const change = useMutation({ mutationFn: () => api.billing.changePlan(input, idempotencyKey) });
  const q = quote.data;

  const confirm = () =>
    change.mutate(undefined, {
      onSuccess: async (res) => {
        await invalidatePlanState(qc);
        if (res.invoice && res.invoice.status === 'open') return onInvoice(res.invoice);
        const sched = res.subscription.scheduled_change;
        toast(sched ? `Your plan switches to ${sched.plan.name} on ${formatDate(sched.effective_at)}.` : `You’re on the ${res.subscription.plan.name} plan.`);
        onClose();
      },
    });

  const title = plan.code === 'free' ? 'Switch to Free' : q?.kind === 'downgrade' ? `Switch to ${plan.name}` : q?.kind === 'upgrade' ? `Upgrade to ${plan.name}` : `Subscribe to ${plan.name}`;
  const confirmLabel = !q ? 'Continue' : q.requires_payment ? `Continue to pay ${money(q.amount)}` : q.kind === 'cancel' ? 'Switch to Free' : `Switch to ${plan.name}`;

  return (
    <Dialog
      open
      size="md"
      title={title}
      description={plan.code === 'free' ? undefined : `${money(planPrice(plan, input.interval))} / ${intervalWord(input.interval)} · prices include VAT`}
      confirmLabel={confirmLabel}
      confirmDisabled={!q}
      loading={change.isPending}
      onConfirm={confirm}
      onCancel={() => !change.isPending && onClose()}
    >
      {quote.isPending ? (
        <div className="flex justify-center py-6">
          <Spinner label="Working out the price" />
        </div>
      ) : quote.isError ? (
        <p role="alert" className="rounded-lg bg-danger-bg px-4 py-3 text-body text-text-primary">
          {errorMessage(quote.error, 'We couldn’t work out the price. Try again.')}
        </p>
      ) : (
        q && (
          <div className="flex flex-col gap-4">
            <p className="text-body text-text-primary">{quoteSummary(q)}</p>
            {q.lines.length > 0 && (
              <ul className="flex flex-col divide-y divide-border-default rounded-lg border border-border-default">
                {q.lines.map((l, i) => (
                  <li key={i} className="flex items-start gap-3 px-4 py-2.5 text-body">
                    <span className="min-w-0 flex-1 text-text-secondary">{l.description}</span>
                    <span className="font-semibold text-text-primary">{money(l.amount)}</span>
                  </li>
                ))}
                {q.requires_payment && (
                  <li className="flex items-center gap-3 px-4 py-2.5 text-body">
                    <span className="flex-1 font-semibold text-text-primary">Due now</span>
                    <span className="font-semibold text-text-primary">{money(q.amount)}</span>
                  </li>
                )}
              </ul>
            )}
            {q.warnings.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-caption font-medium text-text-muted uppercase">On the {q.plan.name} plan</p>
                <ul className="flex flex-col gap-2">
                  {q.warnings.map((w) => {
                    const ok = warningFits(w);
                    return (
                      <li key={w.key} data-fits={ok} className="flex items-start gap-2 text-body text-text-primary">
                        {ok ? <Check aria-label="Fits" className="mt-0.5 size-4 shrink-0 text-success" /> : <AlertTriangle aria-label="Heads up" className="mt-0.5 size-4 shrink-0 text-warning" />}
                        <span>{w.message}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {change.isError && (
              <p role="alert" className="rounded-lg bg-danger-bg px-4 py-3 text-body text-text-primary">
                {errorMessage(change.error, 'We couldn’t change your plan. Try again.')}
              </p>
            )}
          </div>
        )
      )}
    </Dialog>
  );
}
