import { isApiError } from '@storeplix/api-client';
import type { GatewayProvider, Order, RefundMethod, ReturnRequest } from '@storeplix/types';
import { Badge, Button, Checkbox, Dialog, Input, MoneyInput, ReturnStatusBadge, ReturnTypeBadge, Select, Timeline, Toggle } from '@storeplix/ui';
import { useMutation } from '@tanstack/react-query';
import { ArrowRight, Minus, Plus, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { formatBdt, formatCount } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage } from '../catalog/states';
import { Thumb } from '../catalog/ui';
import { localPhone, newIdempotencyKey, refundMethodLabels, timeAgo } from '../commerce/format';
import { useOrder } from '../commerce/queries';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { gatewayMeta, LINK_EXPIRY, linkGateways, type LinkExpiry } from '../payments/gateways';
import { usePaymentGateways } from '../payments/queries';
import { handlePlanLimit } from '../plan/Banners';
import { refundAmountError } from '../orders/transitions';
import { returnReasonLabels } from './labels';
import { useReturn, useReturnInvalidate } from './queries';
import { returnEventToEntry } from './timeline';

// Return detail panel 146:32329 (P5B-63–67). Actions come from `allowed_transitions`: Approve (optional free-text
// pickup tracking code) / Reject → Mark received (3 checks + per-line restock) → Refund (O A, refunds endpoint with
// `return_id`) or Create exchange order (5b-2: optional payment link for the difference) → Close. Not built (§14):
// customer photo, courier return pickup booking.

export function ReturnPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const query = useReturn(id);
  return (
    <section aria-label="Return detail" className="flex flex-col rounded-card border border-border-default bg-surface-card shadow-elevation-1">
      {query.isPending ? (
        <p className="px-5 py-10 text-center text-caption text-text-muted">Loading return…</p>
      ) : query.isError ? (
        <>
          <div className="flex justify-end p-3">
            <CloseButton onClose={onClose} />
          </div>
          <ErrorBlock
            title={isApiError(query.error) && query.error.status === 404 ? 'Return not found' : 'We couldn’t load this return'}
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        </>
      ) : (
        <ReturnView key={query.data.revision} ret={query.data} onClose={onClose} />
      )}
    </section>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" aria-label="Close return" onClick={onClose} className="rounded-md p-1 text-text-muted hover:bg-surface-subtle hover:text-text-primary">
      <X aria-hidden className="size-4" />
    </button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-t border-border-default px-5 py-4">
      <h3 className="text-caption font-semibold tracking-wide text-text-muted uppercase">{title}</h3>
      {children}
    </div>
  );
}

function Stepper({ label, value, max, onChange }: { label: string; value: number; max: number; onChange: (n: number) => void }) {
  return (
    <span className="flex items-center gap-1" aria-label={label}>
      <button type="button" aria-label={`Fewer · ${label}`} disabled={value <= 0} onClick={() => onChange(value - 1)} className="flex size-7 items-center justify-center rounded-md border border-border-default disabled:opacity-40">
        <Minus aria-hidden className="size-3.5" />
      </button>
      <span className="w-6 text-center text-body font-semibold">{value}</span>
      <button type="button" aria-label={`More · ${label}`} disabled={value >= max} onClick={() => onChange(value + 1)} className="flex size-7 items-center justify-center rounded-md border border-border-default disabled:opacity-40">
        <Plus aria-hidden className="size-3.5" />
      </button>
    </span>
  );
}

type Dlg = 'reject' | 'refund' | 'exchange' | null;

function ReturnView({ ret, onClose }: { ret: ReturnRequest; onClose: () => void }) {
  const scope = useStoreScope();
  const invalidate = useReturnInvalidate();
  const [dialog, setDialog] = useState<Dlg>(null);
  const [pickup, setPickup] = useState(ret.pickup_tracking_code ?? '');
  const [checks, setChecks] = useState({ tags_intact: !!ret.checks.tags_intact, unused: !!ret.checks.unused, original_packaging: !!ret.checks.original_packaging });
  const [restock, setRestock] = useState<Record<string, number>>(() => Object.fromEntries(ret.items.map((i) => [i.id, i.quantity - i.restocked_quantity])));
  // Courier-sourced returns (partially_delivered) arrive without lines; the merchant adds them on receive (§8).
  const needsLines = ret.items.length === 0 && ret.allowed_transitions.includes('received');
  const order = useOrder(needsLines ? ret.order.id : undefined);
  const [courierLines, setCourierLines] = useState<Record<string, { quantity: number; restock: number }>>({});
  const [note, setNote] = useState('');
  const can = (s: ReturnRequest['status']) => ret.allowed_transitions.includes(s);

  const onError = (e: unknown) => {
    if (isApiError(e) && e.status === 409) {
      void invalidate(ret);
      toast('This return changed. We reloaded it.', 'error');
      return;
    }
    toast(isApiError(e) ? (Object.values(e.details ?? {})[0]?.[0] ?? e.message) : errorMessage(e), 'error');
  };
  const done = (message: string) => async () => {
    toast(message);
    await invalidate(ret);
  };

  const approve = useMutation({
    mutationFn: () => api.returns.approve(scope.storeId!, ret.id, { pickup_tracking_code: pickup.trim() || null }),
    onSuccess: done(`${ret.number} approved.`),
    onError,
  });
  const receive = useMutation({
    mutationFn: () =>
      api.returns.receive(scope.storeId!, ret.id, {
        checks,
        lines: needsLines
          ? Object.entries(courierLines)
              .filter(([, v]) => v.quantity > 0)
              .map(([itemId, v]) => ({ order_item_id: itemId, quantity: v.quantity, restock_quantity: Math.min(v.restock, v.quantity) }))
          : ret.items.map((i) => ({ return_item_id: i.id, restock_quantity: restock[i.id] ?? 0 })),
      }),
    onSuccess: done(`${ret.number} received. Stock updated.`),
    onError,
  });
  const close = useMutation({ mutationFn: () => api.returns.close(scope.storeId!, ret.id), onSuccess: done(`${ret.number} closed.`), onError });
  const addNote = useMutation({
    mutationFn: () => api.returns.addNote(scope.storeId!, ret.id, note.trim()),
    onSuccess: async () => {
      setNote('');
      await invalidate(ret);
    },
    onError,
  });

  const refundable = Math.max(0, ret.requested_amount - ret.refunded_amount);
  const diff = ret.price_difference_amount;
  const busy = approve.isPending || receive.isPending || close.isPending;
  const courierLinesValid = !needsLines || Object.values(courierLines).some((v) => v.quantity > 0);

  return (
    <>
      <div className="flex flex-col gap-2 px-5 pt-5 pb-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-heading text-text-primary">{ret.number}</h2>
            <ReturnStatusBadge status={ret.status} />
            <ReturnTypeBadge type={ret.type} />
          </div>
          <CloseButton onClose={onClose} />
        </div>
        <p className="text-caption text-text-secondary">
          Order{' '}
          <Link to={`/orders/${ret.order.id}`} className="font-medium text-brand-600">
            {ret.order.number}
          </Link>{' '}
          · {ret.customer.name} · {localPhone(ret.customer.phone)} · {ret.source === 'courier' ? 'Came back from the courier' : 'Asked'} {timeAgo(ret.created_at)}
        </p>
      </div>

      <Section title="What’s changing">
        {needsLines ? (
          <CourierLines order={order.data} loading={order.isPending} value={courierLines} onChange={setCourierLines} />
        ) : (
          <ul className="flex flex-col gap-2">
            {ret.items.map((i) => (
              <li key={i.id} className="flex items-center gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border-default p-2.5">
                  <Thumb src={i.image?.url} size={36} />
                  <span className="flex min-w-0 flex-col">
                    <span className="text-caption text-text-muted">Sending back{i.quantity > 1 ? ` ×${i.quantity}` : ''}</span>
                    <span className="truncate text-body font-medium text-text-primary">{i.product_name}</span>
                    <span className="truncate text-caption text-text-muted">
                      {i.variant_title} · {formatBdt(i.amount)}
                    </span>
                  </span>
                </div>
                {i.exchange_variant && (
                  <>
                    <ArrowRight aria-hidden className="size-4 shrink-0 text-text-muted" />
                    <div className="flex min-w-0 flex-1 flex-col rounded-lg border border-brand-600 bg-brand-50 p-2.5">
                      <span className="text-caption text-text-muted">Wants instead</span>
                      <span className="truncate text-body font-medium text-text-primary">{i.exchange_variant.title}</span>
                      <span className={i.exchange_variant.available === 0 ? 'text-caption text-danger' : 'text-caption text-success'}>
                        {formatBdt(i.exchange_variant.price_amount)}
                        {i.exchange_variant.available !== null ? ` · ${i.exchange_variant.available > 0 ? `${formatCount(i.exchange_variant.available)} in stock` : 'Out of stock'}` : ''}
                      </span>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Why">
        <Badge tone="warning" className="self-start">
          {returnReasonLabels[ret.reason]}
        </Badge>
        {ret.customer_note && <p className="text-body text-text-primary">“{ret.customer_note}”</p>}
      </Section>

      <Section title={ret.type === 'exchange' ? 'Price difference' : 'Money'}>
        <dl className="flex flex-col gap-1.5 text-body">
          <div className="flex justify-between text-text-secondary">
            <dt>{ret.type === 'exchange' ? 'Credit for returned items' : 'Value of returned items'}</dt>
            <dd className="text-text-primary">{formatBdt(ret.requested_amount)}</dd>
          </div>
          {ret.refunded_amount > 0 && (
            <div className="flex justify-between text-text-secondary">
              <dt>Refunded</dt>
              <dd className="text-text-primary">− {formatBdt(ret.refunded_amount)}</dd>
            </div>
          )}
          {ret.type === 'exchange' && diff !== null && (
            <div className="flex justify-between border-t border-border-default pt-1.5 font-semibold text-text-primary">
              <dt>{diff > 0 ? 'Customer pays' : diff < 0 ? 'You refund' : 'No difference'}</dt>
              <dd>{diff === 0 ? formatBdt(0) : formatBdt(Math.abs(diff))}</dd>
            </div>
          )}
        </dl>
        {ret.exchange_order && (
          <p className="text-body text-text-secondary">
            Exchange order{' '}
            <Link to={`/orders/${ret.exchange_order.id}`} className="font-medium text-brand-600">
              {ret.exchange_order.number}
            </Link>
          </p>
        )}
      </Section>

      {(can('approved') || ret.pickup_tracking_code) && (
        <Section title="Return pickup">
          {can('approved') ? (
            <Input id="ret-pickup" label="Pickup tracking code (optional)" placeholder="If you booked a pickup in your courier panel" maxLength={64} value={pickup} onChange={(e) => setPickup(e.target.value)} />
          ) : (
            <p className="text-body text-text-primary">Tracking {ret.pickup_tracking_code}</p>
          )}
        </Section>
      )}

      {can('received') && (
        <Section title="Check when it arrives">
          <div className="flex flex-col gap-2">
            <Checkbox label="Tags intact" checked={checks.tags_intact} onChange={(e) => setChecks({ ...checks, tags_intact: e.target.checked })} />
            <Checkbox label="Unused — not washed or worn" checked={checks.unused} onChange={(e) => setChecks({ ...checks, unused: e.target.checked })} />
            <Checkbox label="Original packaging" checked={checks.original_packaging} onChange={(e) => setChecks({ ...checks, original_packaging: e.target.checked })} />
          </div>
          {!needsLines && (
            <ul aria-label="Put back in stock" className="flex flex-col gap-2">
              {ret.items.map((i) => {
                const max = i.quantity - i.restocked_quantity;
                const n = restock[i.id] ?? 0;
                return (
                  <li key={i.id} className="flex items-center gap-3 rounded-lg border border-border-default p-3">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-body font-medium text-text-primary">Put back in stock</span>
                      <span className="truncate text-caption text-text-muted">
                        {i.product_name} · {i.variant_title}
                      </span>
                    </span>
                    {max > 1 && n > 0 && <Stepper label={`Restock ${i.product_name}`} value={n} max={max} onChange={(v) => setRestock({ ...restock, [i.id]: Math.max(1, v) })} />}
                    <Toggle label={`Put ${i.product_name} back in stock`} checked={n > 0} disabled={max <= 0} onChange={(on) => setRestock({ ...restock, [i.id]: on ? max : 0 })} />
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      )}

      <Section title="Timeline">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim()) addNote.mutate();
          }}
        >
          <input
            aria-label="Add a note to the return"
            placeholder="Add a note…"
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="h-9 min-w-0 flex-1 rounded-md border border-border-default px-3 text-body outline-none focus:border-brand-600"
          />
          <Button type="submit" size="sm" variant="secondary" loading={addNote.isPending} disabled={!note.trim()}>
            Add
          </Button>
        </form>
        <Timeline label="Return timeline" items={ret.events.map(returnEventToEntry)} />
      </Section>

      {(can('approved') || can('rejected') || can('received') || can('refunded') || can('exchanged') || can('closed')) && (
        <div className="flex flex-wrap gap-2 border-t border-border-default px-5 py-4">
          {can('rejected') && (
            <Button variant="secondary" disabled={busy} onClick={() => setDialog('reject')}>
              Reject
            </Button>
          )}
          {can('closed') && (
            <Button variant="secondary" loading={close.isPending} disabled={busy} onClick={() => close.mutate()}>
              Close
            </Button>
          )}
          {can('refunded') && ret.type === 'return' && scope.canManageRefunds && refundable > 0 && (
            <Button variant="secondary" disabled={busy} onClick={() => setDialog('refund')}>
              Refund
            </Button>
          )}
          {can('approved') && (
            <Button className="flex-1" loading={approve.isPending} disabled={busy} onClick={() => approve.mutate()}>
              {ret.type === 'exchange' ? 'Approve exchange' : 'Approve return'}
            </Button>
          )}
          {can('received') && (
            <Button className="flex-1" loading={receive.isPending} disabled={busy || !courierLinesValid} onClick={() => receive.mutate()}>
              Mark received
            </Button>
          )}
          {can('exchanged') && ret.type === 'exchange' && (
            <Button className="flex-1" disabled={busy} onClick={() => setDialog('exchange')}>
              Create exchange order
            </Button>
          )}
        </div>
      )}

      {dialog === 'reject' && <RejectDialog ret={ret} onClose={() => setDialog(null)} onError={onError} />}
      {dialog === 'refund' && <ReturnRefundDialog ret={ret} refundable={refundable} onClose={() => setDialog(null)} />}
      {dialog === 'exchange' && <ExchangeDialog ret={ret} onClose={() => setDialog(null)} />}
    </>
  );
}

function CourierLines({
  order,
  loading,
  value,
  onChange,
}: {
  order: Order | undefined;
  loading: boolean;
  value: Record<string, { quantity: number; restock: number }>;
  onChange: (v: Record<string, { quantity: number; restock: number }>) => void;
}) {
  if (loading) return <p className="text-caption text-text-muted">Loading the order…</p>;
  if (!order) return <p className="text-caption text-danger">We couldn’t load the order lines.</p>;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-caption text-text-secondary">The courier brought part of this order back. Count what came back and what goes back on the shelf.</p>
      <ul aria-label="Came back" className="flex flex-col gap-2">
        {order.items.map((i) => {
          const v = value[i.id] ?? { quantity: 0, restock: 0 };
          return (
            <li key={i.id} className="flex flex-col gap-2 rounded-lg border border-border-default p-3">
              <span className="truncate text-body font-medium text-text-primary">
                {i.product_name} · {i.variant_title}
              </span>
              <span className="flex items-center justify-between gap-2 text-caption text-text-secondary">
                Came back
                <Stepper label={`Came back ${i.product_name}`} value={v.quantity} max={i.quantity} onChange={(q) => onChange({ ...value, [i.id]: { quantity: q, restock: Math.min(v.restock, q) } })} />
              </span>
              <span className="flex items-center justify-between gap-2 text-caption text-text-secondary">
                Back in stock
                <Stepper label={`Restock ${i.product_name}`} value={v.restock} max={v.quantity} onChange={(r) => onChange({ ...value, [i.id]: { ...v, restock: r } })} />
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RejectDialog({ ret, onClose, onError }: { ret: ReturnRequest; onClose: () => void; onError: (e: unknown) => void }) {
  const { storeId } = useStoreScope();
  const invalidate = useReturnInvalidate();
  const [reason, setReason] = useState('');
  const reject = useMutation({
    mutationFn: () => api.returns.reject(storeId!, ret.id, { reason: reason.trim() }),
    onSuccess: async () => {
      toast(`${ret.number} rejected.`);
      onClose();
      await invalidate(ret);
    },
    onError: (e) => {
      onClose();
      onError(e);
    },
  });
  return (
    <Dialog
      open
      tone="danger"
      title={`Reject ${ret.number}?`}
      description="The customer keeps the item. Tell your team why."
      confirmLabel="Reject"
      loading={reject.isPending}
      confirmDisabled={!reason.trim()}
      onCancel={onClose}
      onConfirm={() => reject.mutate()}
    >
      <Input id="reject-reason" label="Reason" maxLength={255} value={reason} placeholder="Item was used" onChange={(e) => setReason(e.target.value)} />
    </Dialog>
  );
}

/** O A (P5B-66): records a refund on the order with `return_id`. Gateway refunds come with 5b-2. */
function ReturnRefundDialog({ ret, refundable, onClose }: { ret: ReturnRequest; refundable: number; onClose: () => void }) {
  const { storeId } = useStoreScope();
  const invalidate = useReturnInvalidate();
  const [key] = useState(newIdempotencyKey);
  const [amount, setAmount] = useState<number | null>(refundable);
  const [method, setMethod] = useState<RefundMethod>('bkash_personal');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const amountError = refundAmountError(amount, refundable);
  const refund = useMutation({
    mutationFn: () => api.orders.refund(storeId!, ret.order.id, { amount: amount!, method, reference: reference.trim() || null, note: `Return ${ret.number}`, return_id: ret.id }, key),
    onSuccess: async () => {
      toast(`Refund of ${formatBdt(amount ?? 0)} recorded for ${ret.number}.`);
      onClose();
      await invalidate(ret);
    },
    onError: (e) => setError(isApiError(e) ? (e.fieldError('amount') ?? e.message) : errorMessage(e)),
  });
  const methods = (Object.keys(refundMethodLabels) as RefundMethod[]).filter((m) => m !== 'gateway');
  return (
    <Dialog
      open
      title={`Refund ${ret.number}`}
      description={`Record what you paid back to the customer. Up to ${formatBdt(refundable)}.`}
      confirmLabel="Record refund"
      loading={refund.isPending}
      confirmDisabled={!!amountError}
      onCancel={onClose}
      onConfirm={() => refund.mutate()}
    >
      <div className="flex flex-col gap-4">
        <MoneyInput id="ret-refund-amount" label="Amount" value={amount} onChange={setAmount} error={amount !== null ? (amountError ?? undefined) : undefined} />
        <Select id="ret-refund-method" label="Paid back by" value={method} onChange={(e) => setMethod(e.target.value as RefundMethod)}>
          {methods.map((m) => (
            <option key={m} value={m}>
              {refundMethodLabels[m]}
            </option>
          ))}
        </Select>
        <Input id="ret-refund-ref" label="TrxID or reference (optional)" maxLength={64} value={reference} onChange={(e) => setReference(e.target.value)} />
        {error && (
          <p role="alert" className="text-caption text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** P5B-67: new manual order with the exchange credit. Negative difference needs O A. */
function ExchangeDialog({ ret, onClose }: { ret: ReturnRequest; onClose: () => void }) {
  const scope = useStoreScope();
  const navigate = useNavigate();
  const invalidate = useReturnInvalidate();
  const [key] = useState(newIdempotencyKey);
  const [overriding, setOverriding] = useState(false);
  const [override, setOverride] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const diff = ret.price_difference_amount ?? 0;
  const blocked = diff < 0 && !scope.canManageRefunds;
  // P5B-67: ask for the difference with a payment link (connected + enabled gateway only).
  const gateways = linkGateways(usePaymentGateways().data);
  const [sendLink, setSendLink] = useState(false);
  const [linkProvider, setLinkProvider] = useState<GatewayProvider | ''>('');
  const [linkExpiry, setLinkExpiry] = useState<LinkExpiry>(120);
  const provider = linkProvider || gateways[0]?.provider || '';
  const withLink = diff > 0 && sendLink && !!provider;
  const create = useMutation({
    mutationFn: () =>
      api.returns.exchangeOrder(
        scope.storeId!,
        ret.id,
        { shipping_amount_override: overriding ? override : null, send_payment_link: withLink ? { provider: provider as GatewayProvider, expires_in_minutes: linkExpiry } : null },
        key,
      ),
    onSuccess: async (r) => {
      toast(r.payment_link ? `Exchange order ${r.order.number} created and the payment link sent.` : `Exchange order ${r.order.number} created.`);
      onClose();
      await invalidate(ret);
      navigate(`/orders/${r.order.id}`);
    },
    onError: (e) => {
      if (handlePlanLimit(e)) return onClose();
      setError(isApiError(e) ? (e.code === 'out_of_stock' ? 'The new size or colour is out of stock.' : (Object.values(e.details ?? {})[0]?.[0] ?? e.message)) : errorMessage(e));
    },
  });
  return (
    <Dialog
      open
      title="Create exchange order"
      description="A new order with the items the customer wants instead. The returned items’ value is taken off as a discount."
      confirmLabel="Create order"
      loading={create.isPending}
      confirmDisabled={blocked || (overriding && (override === null || !Number.isFinite(override)))}
      onCancel={onClose}
      onConfirm={() => create.mutate()}
    >
      <div className="flex flex-col gap-4">
        <p className="rounded-md bg-surface-subtle px-3 py-2.5 text-body text-text-primary">
          {diff > 0 ? `The customer pays ${formatBdt(diff)} more on delivery.` : diff < 0 ? `You refund ${formatBdt(-diff)} through the original order.` : 'No price difference.'}
        </p>
        <Checkbox label="Set the delivery charge by hand" checked={overriding} onChange={(e) => setOverriding(e.target.checked)} />
        {overriding && <MoneyInput id="exchange-shipping" label="Delivery charge" value={override} onChange={setOverride} />}
        {diff > 0 &&
          (gateways.length ? (
            <div className="flex flex-col gap-3 rounded-md border border-border-default p-3">
              <Checkbox label={`Send a payment link for ${formatBdt(diff)}`} checked={sendLink} onChange={(e) => setSendLink(e.target.checked)} />
              {sendLink && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Select id="exchange-link-gateway" label="Collect with" value={provider} onChange={(e) => setLinkProvider(e.target.value as GatewayProvider)}>
                    {gateways.map((g) => (
                      <option key={g.provider} value={g.provider}>
                        {gatewayMeta[g.provider].name}
                      </option>
                    ))}
                  </Select>
                  <Select id="exchange-link-expiry" label="Link expires in" value={String(linkExpiry)} onChange={(e) => setLinkExpiry(Number(e.target.value) as LinkExpiry)}>
                    {LINK_EXPIRY.map((x) => (
                      <option key={x.minutes} value={x.minutes}>
                        {x.label}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
            </div>
          ) : (
            <p className="text-caption text-text-muted">Connect bKash or SSLCommerz in Integrations to ask for the difference with a payment link.</p>
          ))}
        {blocked && <p className="text-caption text-danger">Only owners and managers can create an exchange that needs a refund.</p>}
        {error && (
          <p role="alert" className="text-caption text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

