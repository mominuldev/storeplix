import { isApiError } from '@storeplix/api-client';
import type { CancelReason, Order, RefundMethod, ReturnReason, ReturnType, ShipOrderInput } from '@storeplix/types';
import { Checkbox, Dialog, Input, MoneyInput, SegmentedControl, Select } from '@storeplix/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Minus, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { formatBdt } from '../catalog/format';
import { keys, useStoreScope } from '../catalog/scope';
import { errorMessage } from '../catalog/states';
import { cancelReasonLabels, newIdempotencyKey, refundMethodLabels } from '../commerce/format';
import { useCommerceInvalidate } from '../commerce/queries';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { returnReasonLabels } from '../returns/labels';
import { handleOrderError, refundAmountError, type Target } from './transitions';

// Order dialogs (PHASE-5 §4): Cancel 41:9687, Ship (no frame; cancel layout), Return, Refund (O A).

function Textarea({ id, label, value, onChange, max, placeholder }: { id: string; label: string; value: string; onChange: (v: string) => void; max: number; placeholder?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-body font-medium text-text-primary">
        {label}
      </label>
      <textarea
        id={id}
        rows={3}
        maxLength={max}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-border-default px-3 py-2 text-body outline-none focus:border-brand-600"
      />
    </div>
  );
}

/** Cancel 41:9687: reason select (6), note, "Send SMS to customer" (default from the store toggle). */
export function CancelOrderDialog({ order, open, onClose, smsDefault = true }: { order: Target; open: boolean; onClose: () => void; smsDefault?: boolean }) {
  const { storeId } = useStoreScope();
  const invalidate = useCommerceInvalidate();
  const [reason, setReason] = useState<CancelReason | ''>('');
  const [note, setNote] = useState('');
  const [notify, setNotify] = useState(smsDefault);
  const [error, setError] = useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: () => api.orders.cancel(storeId!, order.id, { reason: reason as CancelReason, note: note.trim() || null, notify_customer: notify }),
    onSuccess: async () => {
      toast(`${order.number} cancelled. Stock released.`);
      onClose();
      await invalidate.afterOrderChange(order.id, order.customerId);
    },
    onError: (e) => {
      if (isApiError(e) && e.status === 403) return setError(e.message || 'Only owners and managers can cancel paid orders.');
      if (isApiError(e) && e.status === 422) return setError(e.fieldError('reason') ?? e.fieldError('note') ?? e.message);
      onClose();
      handleOrderError(e, () => invalidate.afterOrderChange(order.id, order.customerId));
    },
  });
  return (
    <Dialog
      open={open}
      tone="danger"
      title={`Cancel ${order.number}?`}
      description="The items go back to stock and any coupon use is released."
      confirmLabel="Cancel order"
      cancelLabel="Keep order"
      loading={cancel.isPending}
      confirmDisabled={!reason}
      onCancel={onClose}
      onConfirm={() => cancel.mutate()}
    >
      <div className="flex flex-col gap-4">
        <Select id="cancel-reason" label="Reason" value={reason} onChange={(e) => setReason(e.target.value as CancelReason)}>
          <option value="">Choose a reason</option>
          {(Object.keys(cancelReasonLabels) as CancelReason[]).map((r) => (
            <option key={r} value={r}>
              {cancelReasonLabels[r]}
            </option>
          ))}
        </Select>
        <Textarea id="cancel-note" label="Note (optional)" value={note} onChange={setNote} max={500} placeholder="No answer 3 times" />
        <Checkbox label="Send SMS to customer" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
        {error && (
          <p role="alert" className="text-caption text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

const COURIERS = ['Steadfast', 'Pathao', 'RedX', 'Sundarban', 'Other'];

/** Ship (manual shipment, §4): courier name with suggestions, tracking code, tracking link (https), SMS toggle. */
export function ShipOrderDialog({ order, open, onClose, smsDefault = true }: { order: Target; open: boolean; onClose: () => void; smsDefault?: boolean }) {
  const { storeId } = useStoreScope();
  const invalidate = useCommerceInvalidate();
  const [v, setV] = useState<ShipOrderInput>({ carrier_name: '', tracking_code: '', tracking_url: '', notify_customer: smsDefault });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const urlOk = !v.tracking_url || /^https:\/\/\S+$/i.test(v.tracking_url);
  const ship = useMutation({
    mutationFn: () =>
      api.orders.ship(storeId!, order.id, {
        carrier_name: v.carrier_name?.trim() || null,
        tracking_code: v.tracking_code?.trim() || null,
        tracking_url: v.tracking_url?.trim() || null,
        notify_customer: v.notify_customer,
      }),
    onSuccess: async () => {
      toast(`${order.number} shipped. Stock updated.`);
      onClose();
      await invalidate.afterOrderChange(order.id, order.customerId);
    },
    onError: (e) => {
      if (isApiError(e) && e.status === 422 && e.details) {
        return setErrors(Object.fromEntries(Object.entries(e.details).map(([k, m]) => [k, m[0] ?? ''])));
      }
      onClose();
      handleOrderError(e, () => invalidate.afterOrderChange(order.id, order.customerId));
    },
  });
  return (
    <Dialog
      open={open}
      title={`Ship ${order.number}`}
      description="Add the courier details so you and your customer can track the parcel. Booking couriers from Store Plix is coming soon."
      confirmLabel="Mark shipped"
      loading={ship.isPending}
      confirmDisabled={!urlOk}
      onCancel={onClose}
      onConfirm={() => ship.mutate()}
    >
      <div className="flex flex-col gap-4">
        <Input
          id="ship-carrier"
          label="Courier"
          list="ship-couriers"
          maxLength={60}
          value={v.carrier_name ?? ''}
          error={errors.carrier_name}
          onChange={(e) => setV({ ...v, carrier_name: e.target.value })}
        />
        <datalist id="ship-couriers">
          {COURIERS.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <Input id="ship-code" label="Tracking code (optional)" maxLength={64} value={v.tracking_code ?? ''} error={errors.tracking_code} onChange={(e) => setV({ ...v, tracking_code: e.target.value })} />
        <Input
          id="ship-url"
          label="Tracking link (optional)"
          placeholder="https://"
          maxLength={500}
          value={v.tracking_url ?? ''}
          error={errors.tracking_url ?? (urlOk ? undefined : 'Use a link that starts with https://')}
          onChange={(e) => setV({ ...v, tracking_url: e.target.value })}
        />
        <Checkbox label="Send SMS with tracking" checked={!!v.notify_customer} onChange={(e) => setV({ ...v, notify_customer: e.target.checked })} />
      </div>
    </Dialog>
  );
}

/** Return: restock steppers per line (default full quantity), note. */
export function ReturnOrderDialog({ order, open, onClose }: { order: Order; open: boolean; onClose: () => void }) {
  const { storeId } = useStoreScope();
  const invalidate = useCommerceInvalidate();
  const [qty, setQty] = useState<Record<string, number>>(() => Object.fromEntries(order.items.map((i) => [i.id, i.quantity])));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ret = useMutation({
    mutationFn: () =>
      api.orders.return(storeId!, order.id, {
        restock: order.items.filter((i) => (qty[i.id] ?? 0) > 0).map((i) => ({ item_id: i.id, quantity: qty[i.id]! })),
        note: note.trim() || null,
      }),
    onSuccess: async () => {
      toast(`${order.number} marked returned.`);
      onClose();
      await invalidate.afterOrderChange(order.id, order.customer.id);
    },
    onError: (e) => {
      if (isApiError(e) && e.status === 422) return setError(Object.values(e.details ?? {})[0]?.[0] ?? e.message);
      onClose();
      handleOrderError(e, () => invalidate.afterOrderChange(order.id, order.customer.id));
    },
  });
  return (
    <Dialog
      open={open}
      title={`Returned ${order.number}`}
      description="The parcel came back. Choose what goes back on the shelf."
      confirmLabel="Mark returned"
      loading={ret.isPending}
      size="md"
      onCancel={onClose}
      onConfirm={() => ret.mutate()}
    >
      <div className="flex flex-col gap-4">
        <ul aria-label="Restock" className="flex flex-col divide-y divide-border-default rounded-md border border-border-default">
          {order.items.map((i) => {
            const n = qty[i.id] ?? 0;
            const set = (next: number) => setQty((q) => ({ ...q, [i.id]: Math.max(0, Math.min(i.quantity, next)) }));
            return (
              <li key={i.id} className="flex items-center gap-3 px-3 py-2.5">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-body font-medium text-text-primary">{i.product_name}</span>
                  <span className="truncate text-caption text-text-muted">
                    {i.variant_title} · sent {i.quantity}
                  </span>
                </span>
                <span className="flex items-center gap-1" aria-label={`Restock ${i.product_name}`}>
                  <button type="button" aria-label={`Fewer ${i.product_name}`} disabled={n === 0} onClick={() => set(n - 1)} className="flex size-8 items-center justify-center rounded-md border border-border-default disabled:opacity-40">
                    <Minus aria-hidden className="size-4" />
                  </button>
                  <span className="w-8 text-center text-body font-semibold" aria-live="polite">
                    {n}
                  </span>
                  <button type="button" aria-label={`More ${i.product_name}`} disabled={n >= i.quantity} onClick={() => set(n + 1)} className="flex size-8 items-center justify-center rounded-md border border-border-default disabled:opacity-40">
                    <Plus aria-hidden className="size-4" />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
        <Textarea id="return-note" label="Note (optional)" value={note} onChange={setNote} max={500} placeholder="Refused at the door" />
        {error && (
          <p role="alert" className="text-caption text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** Refund (O A, P5-18): amount ≤ refundable, method, TrxID/reference, note. Idempotency key per dialog open (§9.1). */
export function RefundDialog({ order, open, onClose }: { order: Order; open: boolean; onClose: () => void }) {
  const { storeId } = useStoreScope();
  const invalidate = useCommerceInvalidate();
  const refundable = Math.max(0, order.paid_amount - order.refunded_amount);
  const [key] = useState(newIdempotencyKey);
  const [amount, setAmount] = useState<number | null>(refundable);
  const [method, setMethod] = useState<RefundMethod>('cash');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const amountError = refundAmountError(amount, refundable);
  const refund = useMutation({
    mutationFn: () => api.orders.refund(storeId!, order.id, { amount: amount!, method, reference: reference.trim() || null, note: note.trim() || null }, key),
    onSuccess: async () => {
      toast(`Refund of ${formatBdt(amount ?? 0)} recorded.`);
      onClose();
      await invalidate.afterOrderChange(order.id, order.customer.id);
    },
    onError: (e) => setError(isApiError(e) ? (e.fieldError('amount') ?? e.message) : errorMessage(e)),
  });
  return (
    <Dialog
      open={open}
      title="Record a refund"
      description={`Store Plix doesn’t move money. Record what you paid back to the customer. Up to ${formatBdt(refundable)}.`}
      confirmLabel="Record refund"
      loading={refund.isPending}
      confirmDisabled={!!amountError}
      onCancel={onClose}
      onConfirm={() => refund.mutate()}
    >
      <div className="flex flex-col gap-4">
        <MoneyInput id="refund-amount" label="Amount" value={amount} onChange={setAmount} error={amount !== null ? (amountError ?? undefined) : undefined} />
        <Select id="refund-method" label="Paid back by" value={method} onChange={(e) => setMethod(e.target.value as RefundMethod)}>
          {(Object.keys(refundMethodLabels) as RefundMethod[]).map((m) => (
            <option key={m} value={m}>
              {refundMethodLabels[m]}
            </option>
          ))}
        </Select>
        <Input id="refund-ref" label="TrxID or reference (optional)" maxLength={64} value={reference} onChange={(e) => setReference(e.target.value)} />
        <Textarea id="refund-note" label="Note (optional)" value={note} onChange={setNote} max={255} />
        {error && (
          <p role="alert" className="text-caption text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}


/** 5b P5B-69: put a courier-returned order's items back on the shelf, cumulative up to the shipped quantity. */
export function RestockDialog({ order, open, onClose }: { order: Order; open: boolean; onClose: () => void }) {
  const { storeId } = useStoreScope();
  const invalidate = useCommerceInvalidate();
  const remaining = (i: Order['items'][number]) => Math.max(0, i.quantity - i.restocked_quantity);
  const [qty, setQty] = useState<Record<string, number>>(() => Object.fromEntries(order.items.map((i) => [i.id, remaining(i)])));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const lines = order.items.filter((i) => (qty[i.id] ?? 0) > 0).map((i) => ({ item_id: i.id, quantity: qty[i.id]! }));
  const restock = useMutation({
    mutationFn: () => api.orders.restock(storeId!, order.id, { lines, note: note.trim() || null }),
    onSuccess: async () => {
      toast(`Put back in stock for ${order.number}.`);
      onClose();
      await invalidate.afterOrderChange(order.id, order.customer.id);
    },
    onError: (e) => {
      if (isApiError(e) && e.status === 422) return setError(Object.values(e.details ?? {})[0]?.[0] ?? e.message);
      onClose();
      handleOrderError(e, () => invalidate.afterOrderChange(order.id, order.customer.id));
    },
  });
  return (
    <Dialog
      open={open}
      title={`Restock ${order.number}`}
      description="The parcel came back. Choose what goes back on the shelf."
      confirmLabel="Put back in stock"
      loading={restock.isPending}
      confirmDisabled={lines.length === 0}
      size="md"
      onCancel={onClose}
      onConfirm={() => restock.mutate()}
    >
      <div className="flex flex-col gap-4">
        <ul aria-label="Restock" className="flex flex-col divide-y divide-border-default rounded-md border border-border-default">
          {order.items.map((i) => {
            const max = remaining(i);
            const n = qty[i.id] ?? 0;
            const set = (next: number) => setQty((q) => ({ ...q, [i.id]: Math.max(0, Math.min(max, next)) }));
            return (
              <li key={i.id} className="flex items-center gap-3 px-3 py-2.5">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-body font-medium text-text-primary">{i.product_name}</span>
                  <span className="truncate text-caption text-text-muted">
                    {i.variant_title} · sent {i.quantity}
                    {i.restocked_quantity > 0 ? ` · ${i.restocked_quantity} already back` : ''}
                  </span>
                </span>
                <QtyStepper name={i.product_name} value={n} max={max} onChange={set} />
              </li>
            );
          })}
        </ul>
        <Textarea id="restock-note" label="Note (optional)" value={note} onChange={setNote} max={500} />
        {error && (
          <p role="alert" className="text-caption text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function QtyStepper({ name, value, max, onChange }: { name: string; value: number; max: number; onChange: (n: number) => void }) {
  return (
    <span className="flex items-center gap-1" aria-label={`Quantity ${name}`}>
      <button type="button" aria-label={`Fewer ${name}`} disabled={value <= 0} onClick={() => onChange(value - 1)} className="flex size-8 items-center justify-center rounded-md border border-border-default disabled:opacity-40">
        <Minus aria-hidden className="size-4" />
      </button>
      <span className="w-8 text-center text-body font-semibold" aria-live="polite">
        {value}
      </span>
      <button type="button" aria-label={`More ${name}`} disabled={value >= max} onClick={() => onChange(value + 1)} className="flex size-8 items-center justify-center rounded-md border border-border-default disabled:opacity-40">
        <Plus aria-hidden className="size-4" />
      </button>
    </span>
  );
}

/** 5b P5B-63: merchant-created return or exchange on a delivered order (39:9900 "+ Create return"). */
export function CreateReturnDialog({ order, open, onClose }: { order: Order; open: boolean; onClose: () => void }) {
  const { storeId } = useStoreScope();
  const navigate = useNavigate();
  const invalidate = useCommerceInvalidate();
  const [type, setType] = useState<ReturnType>('return');
  const [reason, setReason] = useState<ReturnReason | ''>('');
  const [qty, setQty] = useState<Record<string, number>>(() => (order.items.length === 1 ? { [order.items[0]!.id]: order.items[0]!.quantity } : {}));
  const [swap, setSwap] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const lines = order.items
    .filter((i) => (qty[i.id] ?? 0) > 0)
    .map((i) => ({ order_item_id: i.id, quantity: qty[i.id]!, ...(type === 'exchange' ? { exchange_variant_id: swap[i.id] || null } : {}) }));
  const missingSwap = type === 'exchange' && lines.some((l) => !l.exchange_variant_id);
  const create = useMutation({
    mutationFn: () => api.orders.createReturn(storeId!, order.id, { type, reason: reason as ReturnReason, customer_note: note.trim() || null, lines }),
    onSuccess: async (r) => {
      toast(`${r.number} created.`);
      onClose();
      await invalidate.afterOrderChange(order.id, order.customer.id);
      navigate(`/returns/${r.id}`);
    },
    onError: (e) => {
      if (isApiError(e) && (e.status === 422 || e.code === 'return_not_allowed')) return setError(Object.values(e.details ?? {})[0]?.[0] ?? e.message);
      setError(errorMessage(e, 'We couldn’t create the return.'));
    },
  });
  return (
    <Dialog
      open={open}
      title={`Return from ${order.number}`}
      description="Record what the customer is sending back. Stock changes when you mark it received."
      confirmLabel={type === 'exchange' ? 'Create exchange' : 'Create return'}
      loading={create.isPending}
      confirmDisabled={!reason || lines.length === 0 || missingSwap}
      size="md"
      onCancel={onClose}
      onConfirm={() => create.mutate()}
    >
      <div className="flex flex-col gap-4">
        <SegmentedControl
          aria-label="Return type"
          value={type}
          onChange={setType}
          options={[
            { value: 'return', label: 'Return for refund' },
            { value: 'exchange', label: 'Exchange' },
          ]}
        />
        <Select id="return-reason" label="Reason" value={reason} onChange={(e) => setReason(e.target.value as ReturnReason)}>
          <option value="">Choose a reason</option>
          {(Object.keys(returnReasonLabels) as ReturnReason[]).map((r) => (
            <option key={r} value={r}>
              {returnReasonLabels[r]}
            </option>
          ))}
        </Select>
        <ul aria-label="Items coming back" className="flex flex-col divide-y divide-border-default rounded-md border border-border-default">
          {order.items.map((i) => {
            const n = qty[i.id] ?? 0;
            return (
              <li key={i.id} className="flex flex-col gap-2 px-3 py-2.5">
                <div className="flex items-center gap-3">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-body font-medium text-text-primary">{i.product_name}</span>
                    <span className="truncate text-caption text-text-muted">
                      {i.variant_title} · bought {i.quantity}
                    </span>
                  </span>
                  <QtyStepper name={i.product_name} value={n} max={i.quantity} onChange={(v) => setQty((q) => ({ ...q, [i.id]: Math.max(0, Math.min(i.quantity, v)) }))} />
                </div>
                {type === 'exchange' && n > 0 && i.product_id && <SwapVariant productId={i.product_id} currentVariantId={i.variant_id} name={i.product_name} value={swap[i.id] ?? ''} onChange={(v) => setSwap((s) => ({ ...s, [i.id]: v }))} />}
              </li>
            );
          })}
        </ul>
        <Textarea id="return-note" label="What did the customer say? (optional)" value={note} onChange={setNote} max={500} placeholder="Chest is too tight, needs L" />
        {error && (
          <p role="alert" className="text-caption text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function SwapVariant({ productId, currentVariantId, name, value, onChange }: { productId: string; currentVariantId: string | null; name: string; value: string; onChange: (v: string) => void }) {
  const scope = useStoreScope();
  const product = useQuery({ queryKey: keys.product(scope, productId), queryFn: () => api.products.get(scope.storeId!, productId), enabled: !!scope.storeId });
  const options = (product.data?.variants ?? []).filter((v) => v.is_enabled && v.id !== currentVariantId);
  if (product.isPending) return <span className="text-caption text-text-muted">Loading sizes and colours…</span>;
  if (!options.length) return <span className="text-caption text-danger">{name} has no other variant to swap to.</span>;
  return (
    <Select id={`swap-${productId}`} label={`Wants instead · ${name}`} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose a variant</option>
      {options.map((v) => (
        <option key={v.id} value={v.id}>
          {v.title} · {formatBdt(v.price_amount)}
          {v.track_inventory && !v.allow_backorder ? ` · ${v.inventory.available} in stock` : ''}
        </option>
      ))}
    </Select>
  );
}
