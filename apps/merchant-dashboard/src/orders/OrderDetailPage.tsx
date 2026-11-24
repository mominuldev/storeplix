import { isApiError } from '@storeplix/api-client';
import type { CourierProvider, Order, OrderStatus, Payment } from '@storeplix/types';
import { Avatar, Badge, Button, buttonVariants, cn, Menu, OrderStatusBadge, PaymentStatusBadge, RiskBadge, TagInput, Timeline } from '@storeplix/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronRight, Clock, MapPin, MessageCircle, Phone, Printer, Store } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { formatBdt, formatCount } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, StateCard } from '../catalog/states';
import { Thumb } from '../catalog/ui';
import { dateTime, waLink } from '../catalog/format';
import { cancelReasonLabels, daysRange, localPhone, orderChannelLabels, ordinal, transitionLabels } from '../commerce/format';
import { activeLink, LINK_STATUSES, onlineRefundable, paymentMethodLabel, timeLeft } from '../payments/gateways';
import { ActiveLinkBanner, AskAdvanceDialog, GatewayRefundDialog, PaymentsCardBody } from './payments';
import { useCommerceInvalidate, useOrder } from '../commerce/queries';
import { api } from '../lib/api';
import { LoadingState } from '../online-store/components/Shell';
import { toast } from '../online-store/components/Toast';
import { settingsKey } from '../settings/schema';
import { documentKindLabels } from '../documents/labels';
import { usePrintJob } from '../documents/usePrintJob';
import { orderReturnStatusLabels } from '../returns/labels';
import { CancelOrderDialog, CreateReturnDialog, RefundDialog, RestockDialog, ReturnOrderDialog, ShipOrderDialog } from './actions';
import { BookShipmentDialog } from '../shipments/BookShipmentDialog';
import { OrderCourierCard } from '../shipments/OrderCourierCard';
import { handleOrderError, ITEM_EDIT_STATUSES, useQuickTransition } from './transitions';
import { eventToEntry } from './timeline';
import { BlockNumberDialog } from '../fraud/dialogs';
import { orderTier } from '../fraud/fraud';
import { DeliveryRecordCard, GuardBanner, HoldTag } from '../fraud/OrderGuard';
import { can } from '../lib/permissions';

// Figma Order detail 33:3676 (mobile 32:309). Contract §9: actions from `allowed_transitions`, Items, Payments,
// Shipping, Timeline with notes, Customer card (this shop only), Delivery address with Edit, Order details and tags.
// 5b (PHASE-5B §10): Invoice + other prints (documents), Edit items link, Create return (delivered), Restock
// (courier-returned). 5b-2: Payments card with online charges, links and gateway refunds, Ask for an advance (144:46081),
// active-link banner, awaiting-payment banner, cancel with "Refund ৳N to {gateway}". Not built: Assigned to, Delivery
// record / fraud (Phase 8), Block this number, campaign field. 5b-3: courier card in Shipping (book with a connected
// courier, or the active parcel with status and tracking), ship dialog offers "Book with {courier}".
// PHASE-8-8 §10.2: RiskBadge 33:3890 + hold Tag beside Pending (composed), guard banners 33:3923 (advance) / call_first /
// checking, Delivery record card 33:4122 ("Your shop" bar only) with Block this number, `guard` timeline rows. Confirm is
// not offered while the order is held (API 409 `order_held`).

export function OrderDetailPage() {
  const { orderId } = useParams();
  const query = useOrder(orderId);
  if (query.isPending) return <LoadingState label="Loading order" />;
  if (query.isError) {
    const notFound = isApiError(query.error) && query.error.status === 404;
    return (
      <StateCard>
        <ErrorBlock title={notFound ? 'Order not found' : 'We couldn’t load this order'} error={notFound ? undefined : query.error} onRetry={notFound ? undefined : () => void query.refetch()} />
        <p className="pb-8 text-center">
          <Link to="/orders" className="font-semibold text-brand-600">
            Back to orders
          </Link>
        </p>
      </StateCard>
    );
  }
  return <OrderView order={query.data} />;
}

type DialogKind = 'cancel' | 'cancelFake' | 'ship' | 'return' | 'refund' | 'restock' | 'createReturn' | 'advance' | 'book' | 'block' | null;

export function Card({ title, actions, children, className, label }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; label?: string }) {
  return (
    <section aria-label={label ?? (typeof title === 'string' ? title : undefined)} className={cn('flex flex-col gap-3.5 rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1 sm:px-6 sm:py-[22px]', className)}>
      <div className="flex items-center justify-between gap-2.5">
        <h2 className="text-body-lg font-medium text-text-primary">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Row({ label, value, strong, tone }: { label: ReactNode; value: ReactNode; strong?: boolean; tone?: 'success' }) {
  return (
    <div className={cn('flex items-center justify-between gap-3 text-body', strong ? 'font-semibold text-text-primary' : 'text-text-secondary', tone === 'success' && 'text-success')}>
      <dt>{label}</dt>
      <dd className={cn('text-right font-medium text-text-primary', strong && 'text-body-lg', tone === 'success' && 'text-success')}>{value}</dd>
    </div>
  );
}

function OrderView({ order }: { order: Order }) {
  const scope = useStoreScope();
  const invalidate = useCommerceInvalidate();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [note, setNote] = useState('');
  const [refundCharge, setRefundCharge] = useState<Payment | null>(null);
  const [bookWith, setBookWith] = useState<CourierProvider | undefined>(undefined);
  const openBook = (p?: CourierProvider) => {
    setBookWith(p);
    setDialog('book');
  };
  const settings = useQuery({ queryKey: settingsKey(scope.storeId ?? undefined), queryFn: () => api.stores.getSettings(scope.storeId!), enabled: !!scope.storeId, retry: false });
  const sms = settings.data?.commerce?.notifications.customer_sms;
  const quick = useQuickTransition();
  const target = { id: order.id, number: order.number, customerId: order.customer.id };

  const addNote = useMutation({
    mutationFn: () => api.orders.addNote(scope.storeId!, order.id, note.trim()),
    onSuccess: async () => {
      setNote('');
      await invalidate.afterOrderChange(order.id);
    },
    onError: (e) => toast(isApiError(e) ? (e.fieldError('body') ?? e.message) : 'We couldn’t save the note.', 'error'),
  });
  const tags = useMutation({
    mutationFn: (next: string[]) => api.orders.update(scope.storeId!, order.id, { revision: order.revision, tags: next }),
    onSuccess: () => invalidate.afterOrderChange(order.id),
    onError: (e) => handleOrderError(e, () => invalidate.afterOrderChange(order.id)),
  });

  const run = (to: OrderStatus) => {
    if (to === 'shipped') return setDialog('ship');
    if (to === 'returned') return setDialog('return');
    if (to === 'cancelled') return setDialog('cancel');
    if (to === 'confirmed' || to === 'ready_to_ship' || to === 'delivered') quick.mutate({ target, to });
  };

  const held = !!order.guard?.hold;
  // P88-2: a held order can't be confirmed (or packed) until it's released — the guard banner offers that.
  const forward = order.allowed_transitions.filter((t) => t !== 'cancelled' && t !== 'returned' && !(held && (t === 'confirmed' || t === 'ready_to_ship')));
  const tier = orderTier(order);
  const canBlock = can.manageFraudGuard(scope.membership);
  // ready_to_ship → confirmed is "move back"; show it as a secondary action.
  const primary = forward.find((t) => !(order.status === 'ready_to_ship' && t === 'confirmed'));
  const canCancel = order.allowed_transitions.includes('cancelled') && order.can.cancel;
  const editable = order.can.edit;
  const link = activeLink(order);
  const canAskAdvance = LINK_STATUSES.includes(order.status) && order.due_amount > 0 && !link;
  const online = onlineRefundable(order.payments);
  const c = order.customer;
  const addr = order.shipping_address;
  const print = usePrintJob();
  const itemsEditable = ITEM_EDIT_STATUSES.includes(order.status);
  const restockable = order.status === 'returned' && order.items.some((i) => i.quantity > i.restocked_quantity);

  return (
    <>
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-body font-medium text-text-secondary">
        <Link to="/orders" className="text-brand-600 hover:text-brand-700">
          Orders
        </Link>
        <ChevronRight aria-hidden className="size-3.5 text-text-muted" />
        <span>{order.number}</span>
      </nav>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-heading-32 text-text-primary">{order.number}</h1>
            <OrderStatusBadge status={order.status} />
            {order.guard?.hold && <HoldTag hold={order.guard.hold} />}
            {tier && <RiskBadge tier={tier} />}
            <PaymentStatusBadge status={order.payment_status} />
            {order.return_status !== 'none' && (
              <Link to={`/returns?q=${encodeURIComponent(order.number)}`} aria-label={`${orderReturnStatusLabels[order.return_status]} · see returns`}>
                <Badge tone="warning">{orderReturnStatusLabels[order.return_status]}</Badge>
              </Link>
            )}
          </div>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body text-text-secondary">
            <span className="flex items-center gap-1.5">
              <Clock aria-hidden className="size-3.5" /> Placed {dateTime(order.placed_at)}
            </span>
            <span className="flex items-center gap-1.5">
              <Store aria-hidden className="size-3.5" /> {orderChannelLabels[order.channel]}
              {order.created_by ? ` · added by ${order.created_by.name}` : ''}
            </span>
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="secondary" className="gap-1.5 px-3" loading={print.pending && print.kind === 'invoice_a4'} onClick={() => print.start('invoice_a4', [order.id])}>
            <Printer aria-hidden className="size-4" /> Invoice
          </Button>
          <Menu
            label="More prints"
            align="end"
            triggerClassName={cn(buttonVariants({ variant: 'secondary' }), 'size-auto text-text-primary')}
            trigger={<>More ⋯</>}
            disabled={print.pending}
            entries={(['packing_slip', 'label_4x6', 'receipt_80mm', 'invoice_a5_two_up'] as const).map((k) => ({ key: k, label: documentKindLabels[k].action, onSelect: () => print.start(k, [order.id]) }))}
          />
          {order.status === 'delivered' && (
            <Button variant="secondary" onClick={() => setDialog('createReturn')}>
              Create return
            </Button>
          )}
          {restockable && (
            <Button variant="secondary" onClick={() => setDialog('restock')}>
              Restock
            </Button>
          )}
          {forward
            .filter((t) => t !== primary)
            .map((t) => (
              <Button key={t} variant="secondary" loading={quick.isPending && quick.variables?.to === t} onClick={() => run(t)}>
                {t === 'confirmed' && order.status === 'ready_to_ship' ? 'Move back to confirmed' : transitionLabels[t]}
              </Button>
            ))}
          {order.allowed_transitions.includes('returned') && (
            <Button variant="secondary" onClick={() => run('returned')}>
              Returned
            </Button>
          )}
          {canCancel && (
            <Button variant="danger" onClick={() => run('cancelled')}>
              Cancel order
            </Button>
          )}
          {primary && (
            <Button loading={quick.isPending && quick.variables?.to === primary} onClick={() => run(primary)}>
              {transitionLabels[primary]}
            </Button>
          )}
        </div>
      </div>

      {order.status === 'pending_payment' && (
        <p role="status" className="rounded-card border border-warning bg-warning-bg px-4 py-3 text-body text-text-primary">
          Waiting for the customer to pay online{order.payment_expires_at ? ` · ${timeLeft(order.payment_expires_at)}` : ''}. The order confirms itself when the payment arrives; if it doesn’t, it’s cancelled and the stock goes back.
        </p>
      )}
      {held && <GuardBanner order={order} canProcess={scope.canProcessOrders} onCancelFake={() => setDialog('cancelFake')} />}
      {link && order.guard?.hold !== 'advance' && <ActiveLinkBanner order={order} link={link} />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-5">
        <div className="flex flex-col gap-5 max-lg:contents">
          <Card
            title={`Items · ${formatCount(order.items_count)}`}
            label="Items"
            actions={
              itemsEditable ? (
                <Link to={`/orders/${order.id}/edit`} className="text-body font-medium text-brand-600">
                  Edit items
                </Link>
              ) : undefined
            }
          >
            <ul className="flex flex-col gap-3.5">
              {order.items.map((i) => (
                <li key={i.id} className="flex items-center gap-3.5">
                  <Thumb src={i.image?.url} size={56} className="rounded-lg" />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-body font-semibold text-text-primary">{i.product_name}</span>
                    <span className="truncate text-caption text-text-secondary">{[i.variant_title !== 'Default' ? i.variant_title : null, i.sku ? `SKU ${i.sku}` : null].filter(Boolean).join(' · ')}</span>
                    {i.current_stock && i.current_stock.tracked && (
                      <span className={cn('text-caption', i.current_stock.available > 0 ? 'text-success' : 'text-danger')}>
                        {i.current_stock.available > 0 ? `${formatCount(i.current_stock.available)} in stock` : 'Out of stock'}
                      </span>
                    )}
                  </div>
                  <span className="hidden text-body text-text-secondary sm:inline">
                    {formatBdt(i.unit_price_amount)} × {i.quantity}
                  </span>
                  <span className="w-20 shrink-0 text-right text-body font-semibold text-text-primary">{formatBdt(i.total_amount)}</span>
                </li>
              ))}
            </ul>
            <dl className="flex flex-col gap-2 border-t border-border-default pt-3.5">
              <Row label="Subtotal" value={formatBdt(order.subtotal_amount)} />
              <Row
                label={`Delivery · ${order.shipping_zone_name}${order.shipping_overridden ? ' (set by hand)' : ''}`}
                value={order.shipping_discount_amount > 0 ? `${formatBdt(order.shipping_amount)} (free delivery)` : formatBdt(order.shipping_amount)}
              />
              {order.discount_amount > 0 && <Row label={`Discount${order.coupon_code ? ` · ${order.coupon_code}` : ''}`} value={`− ${formatBdt(order.discount_amount)}`} tone="success" />}
              <div className="border-t border-border-default pt-2">
                <Row label="Total" value={formatBdt(order.total_amount)} strong />
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2.5 rounded-control bg-surface-canvas px-3.5 py-2.5 text-body">
                <span className="font-medium text-text-secondary">Paid {formatBdt(order.paid_amount)}</span>
                <span className="font-semibold text-text-primary">
                  {order.status === 'cancelled' || order.status === 'returned' ? 'Nothing due' : order.due_amount <= 0 ? 'Paid in full' : `Due on delivery ${formatBdt(order.due_amount)}`}
                </span>
              </div>
            </dl>
          </Card>

          <Card
            title="Payments"
            actions={
              <span className="flex flex-wrap justify-end gap-2">
                {canAskAdvance && (
                  <Button size="sm" variant="secondary" onClick={() => setDialog('advance')}>
                    Ask for an advance
                  </Button>
                )}
                {order.can.refund && order.paid_amount - order.refunded_amount > 0 && (
                  <Button size="sm" variant="secondary" onClick={() => setDialog('refund')}>
                    Record refund
                  </Button>
                )}
              </span>
            }
          >
            <PaymentsCardBody order={order} onRefundCharge={setRefundCharge} />
          </Card>

          <Card title="Shipping">
            <dl className="grid gap-3 sm:grid-cols-3">
              <Field label="Zone" value={`${order.shipping_zone_name}${order.delivery_min_days !== null ? ` · ${daysRange(order.delivery_min_days, order.delivery_max_days)}` : ''}`} />
              {order.shipment?.provider === 'manual' && (
                <>
                  <Field label="Courier" value={order.shipment.carrier_name ?? '—'} />
                  <Field
                    label="Tracking"
                    value={
                      order.shipment.tracking_url ? (
                        <a href={order.shipment.tracking_url} target="_blank" rel="noopener noreferrer nofollow" className="text-brand-600 hover:underline">
                          {order.shipment.tracking_code ?? 'Open tracking'}
                        </a>
                      ) : (
                        (order.shipment.tracking_code ?? '—')
                      )
                    }
                  />
                </>
              )}
            </dl>
            <OrderCourierCard order={order} onBook={openBook} />
            {order.cancel_reason && <p className="text-caption text-danger">Cancelled: {cancelReasonLabels[order.cancel_reason]}</p>}
          </Card>

          <Card title="Timeline" className="gap-1">
            <Timeline label="Order timeline" items={order.events.map(eventToEntry)} />
            <form
              className="mt-2.5 flex items-center gap-2.5 rounded-control border border-border-default py-1.5 pr-2 pl-3.5 focus-within:border-brand-600"
              onSubmit={(e) => {
                e.preventDefault();
                if (note.trim()) addNote.mutate();
              }}
            >
              <input
                aria-label="Add a note"
                placeholder="Add a note for your team…"
                maxLength={1000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="h-8 min-w-0 flex-1 bg-transparent text-body text-text-primary outline-none placeholder:text-text-muted"
              />
              <Button type="submit" size="sm" variant="secondary" loading={addNote.isPending} disabled={!note.trim()}>
                Add note
              </Button>
            </form>
          </Card>
        </div>

        <div className="flex flex-col gap-5 max-lg:contents">
          <section aria-label="Customer" className="flex flex-col gap-3.5 max-lg:order-first rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1 sm:px-6 sm:py-[22px]">
            <div className="flex items-center gap-3">
              <Avatar name={c.name} className="size-11 bg-brand-50 text-body font-semibold" />
              <div className="flex min-w-0 flex-col gap-px">
                {c.id ? (
                  <Link to={`/customers/${c.id}`} className="truncate text-body-lg font-medium text-text-primary hover:text-brand-600">
                    {c.name}
                  </Link>
                ) : (
                  <span className="truncate text-body-lg font-medium text-text-primary">{c.name}</span>
                )}
                <span className="text-caption text-text-secondary">
                  {localPhone(c.phone)} · {c.orders_count <= 1 ? 'first order' : `${ordinal(c.orders_count)} order`}
                </span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <a href={`tel:+${c.phone}`} className={cn(buttonVariants(), 'gap-1.5 rounded-control font-semibold')}>
                <Phone aria-hidden className="size-4" /> Call
              </a>
              <a href={waLink(c.phone)} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ variant: 'secondary' }), 'gap-1.5 rounded-control font-semibold')}>
                <MessageCircle aria-hidden className="size-4" /> WhatsApp
              </a>
            </div>
            <div className="h-px bg-border-default" />
            <div className="flex gap-2.5">
              <MapPin aria-hidden className="size-4 shrink-0 text-text-muted" />
              <div className="flex min-w-0 flex-1 flex-col gap-px">
                <span className="text-caption text-text-secondary">Delivery address</span>
                <span className="text-body text-text-primary">{[addr.address_line, addr.area, addr.thana, addr.district].filter(Boolean).join(', ')}</span>
                {addr.landmark && <span className="text-caption text-text-muted">{addr.landmark}</span>}
              </div>
              {editable && (
                <Link to={`/orders/${order.id}/edit`} className="text-caption font-medium text-brand-600">
                  Edit
                </Link>
              )}
            </div>
            {order.customer_note && <p className="rounded-md bg-surface-subtle p-3 text-caption text-text-secondary">“{order.customer_note}”</p>}
            <div className="grid grid-cols-3 gap-2" aria-label="This shop only">
              <Tile label="Orders" value={formatCount(c.orders_count)} />
              <Tile label="Delivered" value={formatCount(c.delivered_orders_count)} />
              <Tile label="Spent" value={formatBdt(c.total_spent_amount)} />
            </div>
          </section>

          <DeliveryRecordCard order={order} onBlock={canBlock ? () => setDialog('block') : undefined} />

          <Card title="Order details" className="gap-2.5">
            <dl className="flex flex-col gap-2.5">
              <Row label="Source" value={orderChannelLabels[order.channel]} />
              <Row label="Payment" value={paymentMethodLabel(order.payment_method)} />
              {order.coupon_code && <Row label="Coupon" value={order.coupon_code} />}
              {order.timestamps.shipped_at && <Row label="Shipped" value={dateTime(order.timestamps.shipped_at)} />}
              {order.timestamps.delivered_at && <Row label="Delivered" value={dateTime(order.timestamps.delivered_at)} />}
              {order.invoice_printed_at && <Row label="Invoice printed" value={dateTime(order.invoice_printed_at)} />}
              {order.label_printed_at && <Row label="Label printed" value={dateTime(order.label_printed_at)} />}
            </dl>
            <TagInput label="Order tags" value={order.tags} disabled={tags.isPending || !editable} onChange={(next) => tags.mutate(next)} placeholder="+ Tag" variant="inline" />
          </Card>
        </div>
      </div>

      {dialog === 'cancel' && (
        <CancelOrderDialog open order={target} smsDefault={sms?.order_cancelled ?? true} onlineRefund={online.amount > 0 && online.provider ? online : undefined} onClose={() => setDialog(null)} />
      )}
      {dialog === 'cancelFake' && (
        <CancelOrderDialog open order={target} defaultReason="fake_order" smsDefault={sms?.order_cancelled ?? true} onlineRefund={online.amount > 0 && online.provider ? online : undefined} onClose={() => setDialog(null)} />
      )}
      {dialog === 'block' && <BlockNumberDialog initialPhone={order.contact.phone} onClose={() => setDialog(null)} />}
      {dialog === 'advance' && <AskAdvanceDialog order={order} onClose={() => setDialog(null)} />}
      {refundCharge && <GatewayRefundDialog order={order} payment={refundCharge} onClose={() => setRefundCharge(null)} />}
      {dialog === 'ship' && <ShipOrderDialog open order={target} smsDefault={sms?.order_shipped ?? true} onClose={() => setDialog(null)} onBookCourier={openBook} />}
      {dialog === 'book' && <BookShipmentDialog order={order} provider={bookWith} onClose={() => setDialog(null)} />}
      {dialog === 'return' && <ReturnOrderDialog open order={order} onClose={() => setDialog(null)} />}
      {dialog === 'refund' && <RefundDialog open order={order} onClose={() => setDialog(null)} />}
      {dialog === 'restock' && <RestockDialog open order={order} onClose={() => setDialog(null)} />}
      {dialog === 'createReturn' && <CreateReturnDialog open order={order} onClose={() => setDialog(null)} />}
    </>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-caption text-text-secondary">{label}</dt>
      <dd className="truncate text-body font-medium text-text-primary">{value}</dd>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col rounded-control bg-surface-canvas px-2.5 py-2">
      <span className="text-caption text-text-secondary">{label}</span>
      <span className="truncate text-body-lg font-medium text-text-primary">{value}</span>
    </div>
  );
}

export default OrderDetailPage;
