import { isApiError } from '@storeplix/api-client';
import type { AddressInput, EditItemsReason, EditOrderItemsInput, MediaRef, Order, OrderItemsQuote, Product, ShippingQuote } from '@storeplix/types';
import { Badge, Button, buttonVariants, cn, Input, MoneyInput, Select, Toggle } from '@storeplix/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Minus, Plus, Trash2, Truck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { dateTime, formatBdt, formatCount } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage, StateCard } from '../catalog/states';
import { Thumb, useDebounced } from '../catalog/ui';
import { addressProblems, type AddressErrors } from '../commerce/address';
import { AddressFields } from '../commerce/AddressFields';
import { daysRange } from '../commerce/format';
import { useCommerceInvalidate, useOrder } from '../commerce/queries';
import { api } from '../lib/api';
import { normalizeBdPhone } from '../lib/phone';
import { FormAlert } from '../onboarding/AuthShell';
import { ConflictDialog, LoadingState } from '../online-store/components/Shell';
import { toast } from '../online-store/components/Toast';
import { courierLabels, editReasonLabels } from '../returns/labels';
import { useStoreSettings } from '../settings/commerceSettings';
import { ProductPicker, QUOTE_DEBOUNCE_MS } from './CreateOrderPage';
import { Card } from './OrderDetailPage';
import { activeCourierShipment, ITEM_EDIT_STATUSES } from './transitions';

// Figma Edit order 144:46654. Contact, address and customer note (P5-20) plus 5b Edit items (P5B-60–62): lines with
// stepper and remove (Removed state greyed), "+ Add product", live "What changes" from POST items/quote (debounced),
// delivery keep / recalculate / set by hand, "Why the change?" (reason + note) and "Send updated total by SMS".
// Items are read-only while a courier parcel is active (Q56). Not built: Scan barcode, "Saving will update the COD
// amount on the parcel" (§14), variant select on existing lines (remove the line and add the other variant instead).

export function OrderEditPage() {
  const { orderId } = useParams();
  const query = useOrder(orderId);
  // Kept above the form so it survives refetches after the save.
  const [hint, setHint] = useState<ShippingQuote | null>(null);
  if (query.isPending) return <LoadingState label="Loading order" />;
  if (query.isError)
    return (
      <StateCard>
        <ErrorBlock error={query.error} onRetry={() => void query.refetch()} />
      </StateCard>
    );
  if (!query.data.can.edit)
    return (
      <StateCard>
        <ErrorBlock title="This order can’t be edited" message="Orders can be edited until they are shipped." />
        <p className="pb-8 text-center">
          <Link to={`/orders/${query.data.id}`} className="font-semibold text-brand-600">
            Back to {query.data.number}
          </Link>
        </p>
      </StateCard>
    );
  return <EditForm key={query.data.id} order={query.data} hint={hint} setHint={setHint} />;
}

interface EditLine {
  key: string;
  id: string | null;
  variant_id: string | null;
  product_name: string;
  variant_title: string;
  unit_price_amount: number;
  image: MediaRef | null;
  quantity: number;
  original: number;
  /** Extra units that can be added (null = untracked). */
  headroom: number | null;
}

type ShippingMode = 'keep' | 'recalc' | 'override';

const linesFrom = (order: Order): EditLine[] =>
  order.items.map((i) => ({
    key: i.id,
    id: i.id,
    variant_id: i.variant_id,
    product_name: i.product_name,
    variant_title: i.variant_title,
    unit_price_amount: i.unit_price_amount,
    image: i.image,
    quantity: i.quantity,
    original: i.quantity,
    headroom: i.current_stock?.tracked ? i.current_stock.available : null,
  }));

function EditForm({ order, hint, setHint }: { order: Order; hint: ShippingQuote | null; setHint: (h: ShippingQuote | null) => void }) {
  const navigate = useNavigate();
  const scope = useStoreScope();
  const invalidate = useCommerceInvalidate();
  const settings = useStoreSettings();
  const [name, setName] = useState(order.contact.name);
  const [phone, setPhone] = useState(order.contact.phone.startsWith('880') ? order.contact.phone.slice(2) : order.contact.phone);
  const [email, setEmail] = useState(order.contact.email ?? '');
  const a = order.shipping_address;
  const [address, setAddress] = useState<AddressInput>({ district_code: a.district_code, thana_code: a.thana_code, address_line: a.address_line, area: a.area, landmark: a.landmark, label: a.label });
  const [customerNote, setCustomerNote] = useState(order.customer_note ?? '');
  const [lines, setLines] = useState<EditLine[]>(() => linesFrom(order));
  const [shippingMode, setShippingMode] = useState<ShippingMode>('keep');
  const [override, setOverride] = useState<number | null>(order.shipping_amount);
  const [reason, setReason] = useState<EditItemsReason | ''>('');
  const [why, setWhy] = useState('');
  const [notifyChoice, setNotifyChoice] = useState<boolean | null>(null);
  const notify = notifyChoice ?? settings.data?.commerce?.notifications.customer_sms.order_updated ?? true;
  const [errors, setErrors] = useState<AddressErrors & Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [bookedByServer, setBookedByServer] = useState(false);

  const booked = activeCourierShipment(order);
  const itemsLocked = !!booked || bookedByServer || !ITEM_EDIT_STATUSES.includes(order.status);
  const itemsChanged = lines.some((l) => l.quantity !== l.original);
  const shippingChanged = shippingMode !== 'keep';
  const changingItems = !itemsLocked && (itemsChanged || shippingChanged);

  const addressChanged =
    address.district_code !== a.district_code || address.thana_code !== a.thana_code || address.address_line !== a.address_line || (address.area ?? null) !== (a.area ?? null) || (address.landmark ?? null) !== (a.landmark ?? null);
  const contactChanged =
    addressChanged ||
    name.trim() !== order.contact.name ||
    (normalizeBdPhone(phone) ?? phone) !== order.contact.phone ||
    (email.trim() || null) !== order.contact.email ||
    (customerNote.trim() || null) !== (order.customer_note ?? null);

  const payloadLines = lines.filter((l) => l.id || l.quantity > 0);
  const itemsPayload = (revision: number): EditOrderItemsInput => ({
    revision,
    items: payloadLines.map((l) => (l.id ? { id: l.id, quantity: l.quantity } : { variant_id: l.variant_id, quantity: l.quantity })),
    reason: reason || 'other',
    note: why.trim() || null,
    recalculate_shipping: shippingMode === 'recalc',
    shipping_amount_override: shippingMode === 'override' && override !== null && Number.isFinite(override) ? override : null,
    notify_customer: notify,
  });

  // The quote ignores the note, reason and SMS choice so typing doesn't re-quote.
  const rawQuoteKey = JSON.stringify(changingItems ? { ...itemsPayload(order.revision), note: null, reason: 'other', notify_customer: false } : null);
  const quoteKey = useDebounced(rawQuoteKey, QUOTE_DEBOUNCE_MS);
  const quoteInput = useMemo(() => JSON.parse(quoteKey) as EditOrderItemsInput | null, [quoteKey]);
  const quote = useQuery({
    queryKey: [scope.tenantId, scope.storeId, 'order-items-quote', order.id, quoteKey],
    queryFn: ({ signal }) => api.orders.quoteItems(scope.storeId!, order.id, quoteInput!, { signal }),
    enabled: !!scope.storeId && !!quoteInput && quoteInput.items.some((i) => i.quantity > 0),
    retry: false,
    staleTime: 30_000,
  });
  const q = changingItems ? quote.data : undefined;

  const save = useMutation({
    mutationFn: async () => {
      let revision = order.revision;
      let shippingHint: ShippingQuote | null = null;
      let notices: string[] = [];
      if (contactChanged) {
        const res = await api.orders.update(scope.storeId!, order.id, {
          revision,
          contact: { name: name.trim(), phone: normalizeBdPhone(phone) ?? phone, email: email.trim() || null },
          ...(addressChanged ? { shipping_address: address } : {}),
          customer_note: customerNote.trim() || null,
        });
        revision = res.order.revision;
        shippingHint = res.shippingHint;
      }
      if (changingItems) {
        notices = (await api.orders.editItems(scope.storeId!, order.id, itemsPayload(revision))).notices;
      } else if (why.trim()) {
        await api.orders.addNote(scope.storeId!, order.id, `Edited: ${why.trim()}`);
      }
      return { shippingHint, notices };
    },
    onSuccess: async ({ shippingHint, notices }) => {
      await invalidate.afterOrderChange(order.id, order.customer.id);
      for (const n of notices) toast(n);
      if (addressChanged && !changingItems && shippingHint && shippingHint.amount !== order.shipping_amount) {
        setHint({ ...shippingHint });
        window.scrollTo?.({ top: 0 });
        return;
      }
      toast(changingItems ? `${order.number} updated${notify ? '. The customer gets the new total by SMS.' : '.'}` : 'Order updated.');
      navigate(`/orders/${order.id}`);
    },
    onError: (e) => {
      if (!isApiError(e)) return setFormError('We couldn’t save your changes.');
      if (e.code === 'revision_conflict') return setConflict(true);
      if (e.code === 'shipment_booked') {
        setBookedByServer(true);
        void invalidate.afterOrderChange(order.id);
        return setFormError('This order is booked with a courier. Cancel the parcel to edit items.');
      }
      if (e.code === 'total_below_paid') return setFormError('The new total would be less than what the customer already paid. Refund first.');
      if (e.status === 422 && e.details) {
        const next: Record<string, string> = {};
        for (const [k, m] of Object.entries(e.details)) {
          const line = /^items\.(\d+)\./.exec(k);
          if (line) next[`line:${payloadLines[Number(line[1])]?.key ?? ''}`] = m[0] ?? '';
          else next[k.replace(/^contact\./, '').replace(/^shipping_address\./, '')] = m[0] ?? '';
        }
        setErrors(next);
        return setFormError(e.code === 'out_of_stock' ? 'Some items don’t have enough stock.' : 'Some fields need attention.');
      }
      setFormError(e.message || 'We couldn’t save your changes.');
    },
  });

  const submit = () => {
    const next: Record<string, string | undefined> = { ...addressProblems(address) };
    if (name.trim().length < 2) next.name = 'Enter the customer’s name.';
    if (!normalizeBdPhone(phone)) next.phone = 'Enter a Bangladeshi mobile number (01XXXXXXXXX).';
    if (changingItems) {
      if (!reason) next.reason = 'Choose why the items changed.';
      if (!lines.some((l) => l.quantity > 0)) next.items = 'Keep at least one item. To drop everything, cancel the order.';
      else if (lines.filter((l) => l.quantity > 0).length > 50) next.items = 'Up to 50 lines per order.';
      if (shippingMode === 'override' && (override === null || !Number.isFinite(override) || override > 1_000_000)) next.shipping_amount_override = 'Enter a delivery charge up to ৳ 10,000.';
    }
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v));
    setErrors(clean);
    if (Object.keys(clean).length) return setFormError('Some fields need attention.');
    setFormError(null);
    save.mutate();
  };

  const setQty = (key: string, quantity: number) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, quantity: Math.max(0, Math.min(99, quantity)) } : l)));
  const remove = (l: EditLine) => (l.id ? setQty(l.key, 0) : setLines((ls) => ls.filter((x) => x.key !== l.key)));
  const addVariant = (p: Product, v: Product['variants'][number]) => {
    const existing = lines.find((l) => l.variant_id === v.id);
    if (existing) return setQty(existing.key, Math.max(1, existing.quantity + 1));
    setLines((ls) => [
      ...ls,
      {
        key: `new-${v.id}`,
        id: null,
        variant_id: v.id,
        product_name: p.name,
        variant_title: v.title,
        unit_price_amount: v.price_amount,
        image: p.images.find((i) => i.media_id === v.image_media_id)?.media ?? p.image,
        quantity: 1,
        original: 0,
        headroom: v.track_inventory && !v.allow_backorder ? v.inventory.available : null,
      },
    ]);
  };
  const quoteLine = (l: EditLine) => q?.lines.find((x) => (l.id ? x.id === l.id : x.id === null && x.variant_id === l.variant_id));
  const lastEdit = [...order.events].reverse().find((e) => e.type === 'items_edited' || e.type === 'edited');

  return (
    <>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-heading-24 text-text-primary">Edit order {order.number}</h1>
          <nav aria-label="Breadcrumb" className="text-body text-text-secondary">
            <Link to="/orders" className="hover:text-text-primary">
              Orders
            </Link>
            <span aria-hidden className="mx-1.5">›</span>
            <Link to={`/orders/${order.id}`} className="hover:text-text-primary">
              {order.number}
            </Link>
            <span aria-hidden className="mx-1.5">›</span>
            Edit · {order.contact.name} · placed {dateTime(order.placed_at)}
          </nav>
        </div>
        <div className="flex gap-3">
          <Link to={`/orders/${order.id}`} className={buttonVariants({ variant: 'secondary' })}>
            Discard
          </Link>
          <Button loading={save.isPending} onClick={submit}>
            Save changes
          </Button>
        </div>
      </div>
      {formError && <FormAlert>{formError}</FormAlert>}
      {(booked || bookedByServer) && (
        <p role="status" className="flex items-center gap-2 rounded-card bg-info-bg px-4 py-3 text-body text-text-primary">
          <Truck aria-hidden className="size-4 shrink-0 text-info" />
          {booked
            ? `This order is booked with ${courierLabels[booked.provider]}${booked.consignment_id ? ` (${booked.consignment_id})` : ''}. Cancel the parcel to edit items.`
            : 'This order is booked with a courier. Cancel the parcel to edit items.'}
        </p>
      )}
      {hint && (
        <div role="status" className="flex flex-col gap-2 rounded-card border border-warning bg-warning-bg p-4 text-body text-text-primary">
          <p>
            Saved. The new address is in <strong>{hint.zone_name}</strong> ({daysRange(hint.min_days, hint.max_days)}), where delivery is {hint.is_free ? 'free' : formatBdt(hint.amount)}. This order keeps its
            delivery charge of {formatBdt(order.shipping_amount)}.
          </p>
          <Button size="sm" className="self-start" onClick={() => navigate(`/orders/${order.id}`)}>
            Back to order
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <div className="flex flex-col gap-5">
          <Card title={`Products · ${lines.filter((l) => l.quantity > 0).length}`} label="Products">
            {!itemsLocked && <ProductPicker onAdd={addVariant} idPrefix="edit" />}
            {itemsLocked && !booked && !bookedByServer && <p className="text-caption text-text-muted">Items can change until the order is shipped.</p>}
            {errors.items && (
              <p role="alert" className="text-caption text-danger">
                {errors.items}
              </p>
            )}
            <ul className="flex flex-col gap-3">
              {lines.map((l) => {
                const removed = l.id !== null && l.quantity === 0;
                const added = l.id === null;
                const ql = quoteLine(l);
                const lineError = errors[`line:${l.key}`];
                const extra = l.quantity - l.original;
                const short = l.headroom !== null && extra > l.headroom;
                return (
                  <li key={l.key} aria-label={l.product_name} className={cn('flex items-center gap-3 rounded-lg border border-border-default p-3', removed && 'bg-surface-subtle opacity-60')}>
                    <Thumb src={l.image?.url} />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-body font-semibold text-text-primary">{l.product_name}</span>
                        {added && <Badge tone="success">Added</Badge>}
                        {removed && <Badge tone="danger">Removed</Badge>}
                        {!added && !removed && extra !== 0 && <Badge tone="info">Changed</Badge>}
                      </span>
                      <span className="truncate text-caption text-text-muted">{l.variant_title !== 'Default' ? l.variant_title : ''}</span>
                      {(lineError || ql?.issue || short) && (
                        <span className="text-caption text-danger">{lineError ?? (ql?.issue === 'unavailable' ? 'No longer available' : `Only ${formatCount(Math.max(0, l.headroom ?? 0))} more in stock`)}</span>
                      )}
                    </div>
                    <span className="text-body text-text-secondary">{formatBdt(l.unit_price_amount)}</span>
                    {itemsLocked ? (
                      <span className="w-20 text-center text-body font-semibold">× {l.quantity}</span>
                    ) : (
                      <>
                        <span className="flex items-center gap-1">
                          <button type="button" aria-label={`Fewer ${l.product_name}`} disabled={l.quantity <= 0} onClick={() => setQty(l.key, l.quantity - 1)} className="flex size-8 items-center justify-center rounded-md border border-border-default disabled:opacity-40">
                            <Minus aria-hidden className="size-4" />
                          </button>
                          <span className="w-8 text-center text-body font-semibold" aria-label={`${l.product_name} quantity`}>
                            {l.quantity}
                          </span>
                          <button type="button" aria-label={`More ${l.product_name}`} disabled={l.quantity >= 99} onClick={() => setQty(l.key, l.quantity + 1)} className="flex size-8 items-center justify-center rounded-md border border-border-default disabled:opacity-40">
                            <Plus aria-hidden className="size-4" />
                          </button>
                        </span>
                        <button type="button" aria-label={`Remove ${l.product_name}`} disabled={removed} onClick={() => remove(l)} className="rounded-sm p-1 text-text-muted hover:text-danger disabled:opacity-40">
                          <Trash2 aria-hidden className="size-4" />
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>

          <Card title="Customer & delivery">
            <p className="-mt-2 text-body text-text-secondary">Changing the area may change the delivery charge.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Input id="edit-name" label="Name" value={name} maxLength={120} error={errors.name} onChange={(e) => setName(e.target.value)} />
              <Input id="edit-phone" label="Phone" inputMode="tel" value={phone} error={errors.phone} onChange={(e) => setPhone(e.target.value)} />
              <Input id="edit-email" label="Email (optional)" type="email" value={email} maxLength={254} error={errors.email} containerClassName="sm:col-span-2" onChange={(e) => setEmail(e.target.value)} />
            </div>
            <AddressFields value={address} onChange={setAddress} errors={errors} idPrefix="edit" />
            {!itemsLocked && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Select id="edit-delivery" label="Delivery" value={shippingMode} onChange={(e) => setShippingMode(e.target.value as ShippingMode)}>
                  <option value="keep">
                    Keep {order.shipping_zone_name} · {formatBdt(order.shipping_amount)}
                  </option>
                  <option value="recalc">Recalculate from the address</option>
                  <option value="override">Set by hand</option>
                </Select>
                {shippingMode === 'override' && <MoneyInput id="edit-shipping" label="Delivery charge" value={override} onChange={setOverride} error={errors.shipping_amount_override} />}
              </div>
            )}
            <Input id="edit-customer-note" label="Customer’s note" value={customerNote} maxLength={500} onChange={(e) => setCustomerNote(e.target.value)} />
          </Card>
        </div>

        <div className="flex flex-col gap-5 lg:sticky lg:top-20">
          <Card title="What changes">
            <WhatChanges order={order} quote={q} changing={changingItems} loading={changingItems && (quote.isFetching || quoteKey !== rawQuoteKey)} error={changingItems && quote.isError ? quote.error : null} />
          </Card>
          <Card title="Why the change?">
            <p className="-mt-2 text-body text-text-secondary">Saved in the order timeline.</p>
            {changingItems && (
              <Select id="edit-reason" label="Reason" value={reason} error={errors.reason} onChange={(e) => setReason(e.target.value as EditItemsReason)}>
                <option value="">Choose a reason</option>
                {(Object.keys(editReasonLabels) as EditItemsReason[]).map((r) => (
                  <option key={r} value={r}>
                    {editReasonLabels[r]}
                  </option>
                ))}
              </Select>
            )}
            <Input id="edit-why" label={changingItems ? 'Note (optional)' : 'Why the change? (saved for your team)'} placeholder="Customer called to add a kurti" value={why} maxLength={500} onChange={(e) => setWhy(e.target.value)} />
            {changingItems && (
              <div className="flex items-center justify-between gap-3">
                <span className="flex flex-col">
                  <span className="text-body font-medium text-text-primary">Send updated total by SMS</span>
                  <span className="text-caption text-text-muted">So the buyer isn’t surprised at the door</span>
                </span>
                <Toggle label="Send updated total by SMS" checked={notify} onChange={setNotifyChoice} />
              </div>
            )}
            {lastEdit && (
              <p className="rounded-md bg-surface-subtle px-3 py-2 text-caption text-text-secondary">
                Last edited{lastEdit.actor.user ? ` by ${lastEdit.actor.user.name}` : ''} · {dateTime(lastEdit.created_at)}
              </p>
            )}
          </Card>
        </div>
      </div>
      <ConflictDialog
        open={conflict}
        onReload={() => {
          setConflict(false);
          void invalidate.afterOrderChange(order.id);
          navigate(`/orders/${order.id}`);
        }}
      />
    </>
  );
}

function WhatChanges({ order, quote, changing, loading, error }: { order: Order; quote: OrderItemsQuote | undefined; changing: boolean; loading: boolean; error: unknown }) {
  if (!changing) return <p className="text-body text-text-secondary">Change a quantity, add a product or recalculate delivery to see the new total.</p>;
  if (error) return <p className="text-body text-danger">{errorMessage(error, 'We couldn’t work out the new total.')}</p>;
  if (!quote) return <p className="text-body text-text-muted">Working out the new total…</p>;
  const row = (label: string, before: number, after: number, minus = false) => (
    <div className="flex items-center justify-between gap-3 text-body">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="flex items-center gap-2 text-text-primary">
        {before !== after && <s className="text-text-muted">{`${minus ? '− ' : ''}${formatBdt(before)}`}</s>}
        <span>{`${minus && after > 0 ? '− ' : ''}${formatBdt(after)}`}</span>
      </dd>
    </div>
  );
  const delta = quote.due_delta_amount;
  return (
    <div className="flex flex-col gap-3" aria-busy={loading}>
      <dl className="flex flex-col gap-2">
        {row('Subtotal', order.subtotal_amount, quote.subtotal_amount)}
        {row('Delivery', order.shipping_amount, quote.shipping_amount)}
        {(order.discount_amount > 0 || quote.discount_amount > 0) && row('Discount', order.discount_amount, quote.discount_amount, true)}
        <div className="flex items-center justify-between gap-3 border-t border-border-default pt-3">
          <dt className="text-body-lg font-semibold text-text-primary">Collect on delivery</dt>
          <dd className="flex items-center gap-2">
            {order.due_amount !== quote.due_amount && <s className="text-body text-text-muted">{formatBdt(order.due_amount)}</s>}
            <span className="text-heading text-text-primary" aria-label="New amount to collect">
              {formatBdt(quote.due_amount)}
            </span>
          </dd>
        </div>
      </dl>
      {delta !== 0 && (
        <Badge tone={delta > 0 ? 'warning' : 'info'} dot className="self-start">
          {delta > 0 ? `+ ${formatBdt(delta)} more to collect` : `${formatBdt(-delta)} less to collect`}
        </Badge>
      )}
      {quote.notices.map((n) => (
        <p key={n} className="text-caption text-text-secondary">
          {n}
        </p>
      ))}
      {loading && <p className="text-caption text-text-muted">Updating…</p>}
    </div>
  );
}

export default OrderEditPage;
