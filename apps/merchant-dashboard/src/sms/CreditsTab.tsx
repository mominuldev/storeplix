import { isApiError } from '@storeplix/api-client';
import type { BillingInvoiceSummary, GatewayProvider, SmsCreditAccount, SmsCreditPack, SmsCreditPackCode, SmsOverview } from '@storeplix/types';
import { Badge, Button, cn, formatCount, ProviderLogo, Spinner } from '@storeplix/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock, Download } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { useReadOnly } from '../impersonation/hooks';
import { saveFile } from '../catalog/download';
import { ErrorBlock, LoadingRows } from '../catalog/states';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { billingKeys, formatDate, isSafeRedirect, money, newIdempotencyKey } from '../plan/billing';
import { payNavigation, PayDialog } from '../settings/billing/PayDialog';
import { KeyValue, Panel } from './components';
import { smsErrorText } from './errors';
import { smsKeys, useCreditLedger, usePurchaseCredits, useSmsCredits, useSmsPurchases } from './queries';
import { dailyCreditPace, LEDGER_LABELS, packBadge, paceDuration, perSmsPrice, purchaseStatus, signedCredits } from './sms';

// Figma Buy credits 2075:51449 (§12.5): packs, Pay with, Order summary → POST /billing/sms-credits/purchase →
// provider page. Credits arrive only after the API verifies the payment (rule 8): the return (`?payment=`) polls the
// payment and never trusts the redirect. Purchase history = billing invoices of kind `sms_credits`.

export const POLL_MS = 2_000;
export const POLL_WINDOW_MS = 60_000;

export const providerName: Record<GatewayProvider, string> = { bkash: 'bKash', sslcommerz: 'SSLCommerz' };
const providerHint: Record<GatewayProvider, string> = { bkash: 'Pay from your bKash account', sslcommerz: 'Card, Nagad, Rocket or internet banking' };

/** Pack + provider selection and the purchase call. One Idempotency-Key per (pack, provider) reused on retry. */
export function usePurchaseFlow(account: SmsCreditAccount | undefined) {
  const [packCode, setPackCode] = useState<SmsCreditPackCode | null>(null);
  const [selectedProvider, setProvider] = useState<GatewayProvider | null>(null);
  const [hidden, setHidden] = useState<GatewayProvider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());
  const purchase = usePurchaseCredits();
  const packs = account?.packs ?? [];
  const pack = packs.find((p) => p.code === packCode) ?? packs.find((p) => p.code === 'credits_5000') ?? packs[0] ?? null;
  const providers = (account?.providers ?? []).filter((p) => !hidden.includes(p));
  const provider = selectedProvider && providers.includes(selectedProvider) ? selectedProvider : (providers[0] ?? null);

  const buy = () => {
    if (!pack || !provider) return;
    const id = `${pack.code}:${provider}`;
    if (!keys.current.has(id)) keys.current.set(id, newIdempotencyKey());
    setError(null);
    purchase.mutate(
      { input: { pack: pack.code, provider }, key: keys.current.get(id)! },
      {
        onSuccess: ({ payment }) => {
          keys.current.delete(id);
          if (isSafeRedirect(payment.redirect_url)) payNavigation.assign(payment.redirect_url);
          else setError('We couldn’t open the payment page. Try again in a moment.');
        },
        onError: (e) => {
          if (isApiError(e) && e.code === 'billing_gateway_unavailable') {
            setHidden((h) => [...h, provider]);
            keys.current.delete(id);
          }
          setError(smsErrorText(e, 'We couldn’t start the payment. Try again.'));
        },
      },
    );
  };

  return {
    pack,
    packs,
    provider,
    providers,
    setPack: (c: SmsCreditPackCode) => setPackCode(c),
    setProvider,
    buy,
    pending: purchase.isPending || purchase.isSuccess,
    error,
  };
}

export function PurchaseError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg bg-danger-bg px-3 py-2.5 text-caption font-medium text-danger">
      {message}
    </p>
  );
}

/** Compact pack picker of the overview credits card (31:5758). */
export function MiniPackPicker({ packs, value, onChange }: { packs: SmsCreditPack[]; value: SmsCreditPackCode | undefined; onChange: (c: SmsCreditPackCode) => void }) {
  return (
    <div role="radiogroup" aria-label="Credit pack" className="flex gap-2">
      {packs.map((p) => {
        const on = p.code === value;
        return (
          <button
            key={p.code}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(p.code)}
            className={cn(
              'flex min-w-0 flex-1 flex-col items-center rounded-control py-2.5 outline-none focus-visible:shadow-focus',
              on ? 'border-2 border-brand-600 bg-brand-50' : 'border border-border-default bg-surface-card hover:bg-surface-subtle',
            )}
          >
            <span className="text-body font-semibold text-text-primary">{formatCount(p.credits)}</span>
            <span className="text-caption text-text-secondary">{money(p.price_amount)}</span>
          </button>
        );
      })}
    </div>
  );
}

export function CreditsTab({ overview, canBuy, canViewHistory, paymentId, onPaymentDone }: { overview: SmsOverview | undefined; canBuy: boolean; canViewHistory: boolean; paymentId: string | null; onPaymentDone: () => void }) {
  const account = useSmsCredits();
  const flow = usePurchaseFlow(account.data);
  const readOnly = useReadOnly();
  const [payInvoice, setPayInvoice] = useState<BillingInvoiceSummary | null>(null);

  if (account.isPending) return <LoadingRows label="Loading SMS credits" />;
  if (account.isError) return <ErrorBlock title="We couldn’t load your SMS credits" error={account.error} onRetry={() => void account.refetch()} />;
  const a = account.data;
  const pace = dailyCreditPace(overview?.this_month.credits_used ?? 0);
  const lasts = flow.pack ? paceDuration(flow.pack.credits, pace) : null;
  const open = a.open_invoice;

  return (
    <div className="flex flex-col gap-5">
      {paymentId && <PaymentReturn paymentId={paymentId} overview={overview} onDone={onPaymentDone} />}
      {open && open.status === 'open' && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg bg-warning-bg px-4 py-3">
          <AlertTriangle aria-hidden className="size-4 shrink-0 text-warning" />
          <p className="min-w-[12rem] flex-1 text-body text-text-primary">
            You have an unpaid SMS credit invoice {open.number} ({money(open.total_amount)}). A new purchase replaces it.
          </p>
          {canBuy && open.can_pay && (
            <Button size="sm" variant="secondary" onClick={() => setPayInvoice(open)}>
              Pay
            </Button>
          )}
        </div>
      )}
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-5">
          <Panel title="Choose a pack" description="Purchased credits never expire. 1 credit = 1 SMS part. Your plan allowance is always used first.">
            <div role="radiogroup" aria-label="Credit pack" className="grid gap-3 sm:grid-cols-3">
              {flow.packs.map((p) => {
                const on = flow.pack?.code === p.code;
                const badge = packBadge(p);
                return (
                  <button
                    key={p.code}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={!canBuy}
                    onClick={() => flow.setPack(p.code)}
                    className={cn(
                      'flex flex-col items-start gap-1 rounded-card p-4 text-left outline-none focus-visible:shadow-focus disabled:cursor-not-allowed',
                      on ? 'border-2 border-brand-600 bg-brand-50' : 'border border-border-default bg-surface-card enabled:hover:bg-surface-subtle',
                    )}
                  >
                    <span className="flex w-full items-center gap-2">
                      <span aria-hidden className={cn('flex size-[18px] items-center justify-center rounded-full border-2', on ? 'border-brand-600' : 'border-border-strong')}>
                        {on && <span className="size-2 rounded-full bg-brand-600" />}
                      </span>
                      <span className="flex-1" />
                      {badge && (
                        <Badge size="sm" tone={p.code === 'credits_10000' ? 'success' : 'brand'}>
                          {badge}
                        </Badge>
                      )}
                    </span>
                    <span className="mt-2 text-heading-24 font-semibold text-text-primary">{formatCount(p.credits)}</span>
                    <span className="text-caption text-text-secondary">SMS credits</span>
                    <span className="mt-2 text-body-lg font-medium text-text-primary">{money(p.price_amount)}</span>
                    <span className="text-caption text-text-muted">{perSmsPrice(p)}</span>
                  </button>
                );
              })}
            </div>
            {flow.pack && lasts && (
              <p className="flex items-center gap-2 rounded-lg bg-surface-subtle px-3 py-2.5 text-caption text-text-secondary">
                <Clock aria-hidden className="size-4 shrink-0 text-text-muted" />
                {formatCount(flow.pack.credits)} credits last {lasts} at your current pace.
              </p>
            )}
          </Panel>
          <Panel title="Pay with">
            {flow.providers.length === 0 ? (
              <p role="alert" className="rounded-lg bg-warning-bg px-4 py-3 text-body text-text-primary">
                Online payment isn’t available right now.
              </p>
            ) : (
              <div role="radiogroup" aria-label="Pay with" className="grid gap-3 sm:grid-cols-2">
                {flow.providers.map((p) => {
                  const on = flow.provider === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      disabled={!canBuy}
                      onClick={() => flow.setProvider(p)}
                      className={cn(
                        'flex items-center gap-3 rounded-card px-4 py-3 text-left outline-none focus-visible:shadow-focus disabled:cursor-not-allowed',
                        on ? 'border-2 border-brand-600 bg-brand-50' : 'border border-border-default bg-surface-card enabled:hover:bg-surface-subtle',
                      )}
                    >
                      <ProviderLogo provider={p} size="sm" />
                      <span className="flex min-w-0 flex-col">
                        <span className="text-body font-semibold text-text-primary">{providerName[p]}</span>
                        <span className="text-caption text-text-secondary">{providerHint[p]}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </Panel>
        </div>
        <Panel title="Order summary" className="lg:w-[310px] lg:shrink-0">
          {flow.pack && (
            <>
              <KeyValue label="SMS credits" value={formatCount(flow.pack.credits)} />
              <KeyValue label="Price" value={money(flow.pack.price_amount)} />
              <KeyValue label="VAT" value="Included" />
              <div className="h-px bg-border-default" />
              <KeyValue label={<span className="font-medium text-text-primary">Total</span>} value={money(flow.pack.price_amount)} valueClassName="text-body-lg font-semibold" />
              <p className="flex items-center justify-between gap-3 rounded-md bg-surface-subtle px-2 py-1.5 text-caption text-text-secondary">
                <span>Purchased credits</span>
                <span className="font-medium text-text-primary">
                  {formatCount(a.balance)} → {formatCount(a.balance + flow.pack.credits)}
                </span>
              </p>
            </>
          )}
          {canBuy ? (
            <>
              <Button fullWidth loading={flow.pending} disabled={readOnly || !flow.pack || !flow.provider || flow.pending} onClick={flow.buy}>
                {flow.pack && flow.provider ? `Pay ${money(flow.pack.price_amount)} with ${providerName[flow.provider]}` : 'Pay'}
              </Button>
              <PurchaseError message={flow.error} />
              <p className="text-caption text-text-secondary">
                You’ll go to {flow.provider ? providerName[flow.provider] : 'the gateway'} to pay. Credits are added only after we confirm the payment — usually within a minute. The invoice
                appears in Purchase history.
              </p>
            </>
          ) : (
            <p className="rounded-lg bg-surface-subtle px-3 py-2.5 text-body text-text-secondary">Only the shop owner can buy credits.</p>
          )}
        </Panel>
      </div>
      {canViewHistory && <PurchaseHistory />}
      {canViewHistory && <CreditHistory />}
      {payInvoice && <PayDialog invoice={payInvoice} providers={a.providers} onClose={() => setPayInvoice(null)} />}
    </div>
  );
}

/** §12.5 Return: poll the payment every 2 s for 60 s; success / still confirming / failed. */
export function PaymentReturn({ paymentId, overview, onDone }: { paymentId: string; overview: SmsOverview | undefined; onDone: () => void }) {
  const { tenantId } = useAuth();
  const qc = useQueryClient();
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setExpired(true), POLL_WINDOW_MS);
    return () => clearTimeout(t);
  }, []);
  const payment = useQuery({
    queryKey: billingKeys.payment(tenantId, paymentId),
    queryFn: () => api.billing.payment(paymentId),
    retry: 1,
    refetchInterval: (q) => (expired || (q.state.data && q.state.data.status !== 'pending') ? false : POLL_MS),
  });
  const p = payment.data;
  const invoice = useQuery({ queryKey: billingKeys.invoice(tenantId, p?.invoice_id ?? ''), queryFn: () => api.billing.invoice(p!.invoice_id), enabled: p?.status === 'succeeded', retry: false });
  const account = useSmsCredits();
  const refreshed = useRef(false);
  useEffect(() => {
    if (p?.status === 'succeeded' && !refreshed.current) {
      refreshed.current = true;
      void qc.invalidateQueries({ queryKey: smsKeys.credits(tenantId) });
      void qc.invalidateQueries({ queryKey: ['billing', tenantId, 'invoices'] });
      void qc.invalidateQueries({ queryKey: [tenantId] });
    }
  }, [p?.status, qc, tenantId]);

  if (payment.isError) {
    return (
      <div role="alert" className="flex items-center gap-2.5 rounded-lg bg-danger-bg px-4 py-3 text-body text-text-primary">
        <AlertTriangle aria-hidden className="size-4 shrink-0 text-danger" />
        We couldn’t check your payment. Refresh the page in a moment.
      </div>
    );
  }
  if (!p || p.status === 'pending') {
    return (
      <Panel label="Confirming your payment" className="items-center text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-warning-bg text-warning">{expired ? <Clock aria-hidden className="size-6" /> : <Spinner label="Checking payment" />}</span>
        <h2 className="text-heading font-semibold text-text-primary">Confirming your payment…</h2>
        <p className="max-w-md text-body text-text-secondary">
          We’re checking with {p && p.provider !== 'manual' ? providerName[p.provider] : 'the gateway'}. Credits appear here as soon as the payment is confirmed — you can safely leave this page.
        </p>
        <Button variant="secondary" onClick={onDone}>
          Back to SMS
        </Button>
      </Panel>
    );
  }
  if (p.status === 'succeeded') {
    const credits = invoice.data?.sms_credits ?? null;
    const balance = account.data?.balance ?? null;
    const allowanceLeft = overview?.allowance.transactional.remaining ?? null;
    const download = async () => {
      if (!invoice.data) return;
      try {
        saveFile(await api.billing.invoicePdf(invoice.data.id, invoice.data.number));
      } catch {
        toast('We couldn’t download the PDF. Try again.', 'error');
      }
    };
    return (
      <Panel label="Payment confirmed" className="items-center text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-success-bg text-success">
          <CheckCircle2 aria-hidden className="size-6" />
        </span>
        <h2 className="text-heading font-semibold text-text-primary">{credits ? `${formatCount(credits)} credits added` : 'Credits added'}</h2>
        <p className="text-body text-text-secondary">Payment confirmed by {p.provider !== 'manual' ? providerName[p.provider] : 'Store Plix'}</p>
        <dl className="flex flex-wrap justify-center gap-6 rounded-lg bg-surface-subtle px-4 py-2">
          <Stat label="Purchased credits" value={balance === null ? '—' : formatCount(balance)} />
          <Stat label="Allowance left" value={allowanceLeft === null ? (overview ? 'Unlimited' : '—') : formatCount(allowanceLeft)} />
          {balance !== null && allowanceLeft !== null && <Stat label="Total SMS left" value={formatCount(balance + allowanceLeft)} />}
        </dl>
        <div className="flex gap-2">
          <Button variant="secondary" leftIcon={<Download aria-hidden className="size-4" />} disabled={!invoice.data} onClick={() => void download()}>
            Download invoice
          </Button>
          <Button onClick={onDone}>Done</Button>
        </div>
      </Panel>
    );
  }
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2.5 rounded-lg bg-danger-bg px-4 py-3">
      <AlertTriangle aria-hidden className="size-4 shrink-0 text-danger" />
      <p className="min-w-[12rem] flex-1 text-body text-text-primary">Payment didn’t go through. You haven’t been charged.</p>
      <Button size="sm" variant="secondary" onClick={onDone}>
        Dismiss
      </Button>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center">
      <dd className="text-body-lg font-medium text-text-primary">{value}</dd>
      <dt className="text-caption text-text-secondary">{label}</dt>
    </div>
  );
}

/** Purchase history: billing invoices with kind `sms_credits` (Figma "PAID WITH" omitted, §18). */
function PurchaseHistory() {
  const [page, setPage] = useState(1);
  const list = useSmsPurchases(page, true);
  const [downloading, setDownloading] = useState<string | null>(null);
  const download = async (inv: BillingInvoiceSummary) => {
    setDownloading(inv.id);
    try {
      saveFile(await api.billing.invoicePdf(inv.id, inv.number));
    } catch {
      toast('We couldn’t download the PDF. Try again.', 'error');
    } finally {
      setDownloading(null);
    }
  };
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;
  return (
    <Panel title="Purchase history">
      {list.isPending ? (
        <LoadingRows rows={3} label="Loading purchases" />
      ) : list.isError ? (
        <ErrorBlock title="We couldn’t load your purchases" error={list.error} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <p className="py-4 text-center text-body text-text-muted">No purchases yet. Credits you buy show up here with their invoice.</p>
      ) : (
        <div className="overflow-hidden rounded-card border border-border-default">
          <table className="w-full text-left text-body">
            <thead className="hidden bg-surface-subtle text-caption font-medium text-text-muted uppercase md:table-header-group">
              <tr>
                <th className="px-4 py-2.5 font-medium">Date</th>
                <th className="px-4 py-2.5 font-medium">Pack</th>
                <th className="px-4 py-2.5 font-medium">Amount</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Invoice</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((inv) => {
                const st = purchaseStatus(inv);
                return (
                  <tr key={inv.id} className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border-default px-4 py-3 first:border-t-0 md:table-row md:p-0">
                    <td className="text-text-primary md:px-4 md:py-3">{formatDate(inv.issued_at)}</td>
                    <td className="font-medium text-text-primary md:px-4 md:py-3 md:font-normal">{inv.description}</td>
                    <td className="text-text-primary md:px-4 md:py-3">{money(inv.total_amount)}</td>
                    <td className="md:px-4 md:py-3">
                      <Badge tone={st.tone} dot size="sm">
                        {st.label}
                      </Badge>
                    </td>
                    <td className="w-full md:w-auto md:px-4 md:py-3">
                      {inv.status === 'paid' ? (
                        <button
                          type="button"
                          disabled={downloading === inv.id}
                          onClick={() => void download(inv)}
                          className="inline-flex items-center gap-1.5 font-medium text-brand-600 hover:underline disabled:opacity-50"
                        >
                          <Download aria-hidden className="size-3.5" />
                          {inv.number}
                        </button>
                      ) : (
                        <span className="text-text-muted">{inv.number}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {meta && meta.last_page > 1 && (
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <Button size="sm" variant="secondary" disabled={page >= meta.last_page} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      )}
    </Panel>
  );
}

/** Composed credit ledger (`billing.view`): raw rows, Load more. */
function CreditHistory() {
  const ledger = useCreditLedger(true);
  const rows = ledger.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <Panel title="Credit history" description="Every change to your purchased credits.">
      {ledger.isPending ? (
        <LoadingRows rows={3} label="Loading credit history" />
      ) : ledger.isError ? (
        <ErrorBlock title="We couldn’t load your credit history" error={ledger.error} onRetry={() => void ledger.refetch()} />
      ) : rows.length === 0 ? (
        <p className="py-4 text-center text-body text-text-muted">No credit changes yet.</p>
      ) : (
        <ul aria-label="Credit history" className="flex flex-col">
          {rows.map((r) => (
            <li key={r.id} className="flex items-start gap-3 border-t border-border-default py-2.5 first:border-t-0">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-body font-medium text-text-primary">
                  {LEDGER_LABELS[r.type]}
                  {r.invoice ? ` · ${r.invoice.number}` : ''}
                </span>
                {r.reason && <span className="text-caption text-text-secondary">{r.reason}</span>}
                <span className="text-caption text-text-muted">{formatDate(r.created_at)}</span>
              </div>
              <div className="flex shrink-0 flex-col items-end">
                <span className={cn('text-body font-medium', r.credits > 0 ? 'text-success' : 'text-text-primary')}>{signedCredits(r.credits)}</span>
                <span className="text-caption text-text-muted">Balance {formatCount(r.balance_after)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {ledger.hasNextPage && (
        <Button size="sm" variant="secondary" loading={ledger.isFetchingNextPage} onClick={() => void ledger.fetchNextPage()}>
          Load more
        </Button>
      )}
    </Panel>
  );
}

