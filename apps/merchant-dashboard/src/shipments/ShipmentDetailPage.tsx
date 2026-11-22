import { isApiError } from '@storeplix/api-client';
import type { ShipmentDetail, ShipmentEvent } from '@storeplix/types';
import { Button, buttonVariants, cn, Dialog, Input, ShipmentStatusBadge, shipmentStatusMeta, Stepper, Timeline, type TimelineEntry } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ExternalLink, MapPin, Phone, Printer, RotateCcw, Truck, XCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { dateTime, formatBdt } from '../catalog/format';
import { keys, useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage, StateCard } from '../catalog/states';
import { localPhone, timeAgo } from '../commerce/format';
import { usePrintJob } from '../documents/usePrintJob';
import { api } from '../lib/api';
import { LoadingState } from '../online-store/components/Shell';
import { toast } from '../online-store/components/Toast';
import { codCell, courierName, isCourier, problemLabels, trackingSteps } from './labels';
import { useShipment, useShipmentInvalidate } from './queries';

// Figma Shipment detail 146:33100 (PHASE-5B §10): consignment, courier, order link, booked time; stepper Booked →
// Picked up → At hub → Out for delivery → Delivered (or Returned/Cancelled); Tracking timeline with Refresh; Parcel
// card; Cash on delivery card; buyer card; Print label, Open in {courier}, Cancel the parcel (or "cancel in the courier
// panel, then mark it cancelled here", P5B-41). Not built (§14): Call rider, rider card, risk badge, Change address or
// COD, Ask to hold.

export function ShipmentDetailPage() {
  const { shipmentId } = useParams();
  const query = useShipment(shipmentId);
  if (query.isPending) return <LoadingState label="Loading shipment" />;
  if (query.isError) {
    const notFound = isApiError(query.error) && query.error.status === 404;
    return (
      <StateCard>
        <ErrorBlock title={notFound ? 'Shipment not found' : 'We couldn’t load this shipment'} error={notFound ? undefined : query.error} onRetry={notFound ? undefined : () => void query.refetch()} />
        <p className="pb-8 text-center">
          <Link to="/shipments" className="font-semibold text-brand-600">
            Back to shipments
          </Link>
        </p>
      </StateCard>
    );
  }
  return <ShipmentView shipment={query.data} />;
}

function eventEntry(e: ShipmentEvent, latest: boolean): TimelineEntry {
  const meta = shipmentStatusMeta[e.status];
  const bad = e.status === 'delivery_failed' || e.status === 'returned' || e.status === 'booking_failed' || e.status === 'cancelled';
  const warn = e.status === 'on_hold' || e.status === 'returning';
  return {
    id: e.id,
    icon: bad ? <XCircle /> : warn ? <AlertTriangle /> : latest ? <Truck /> : <CheckCircle2 />,
    tone: bad ? 'danger' : warn ? 'warning' : latest ? 'brand' : 'success',
    title: e.description ?? meta?.label ?? e.status,
    detail: [e.location, e.provider_status && e.description ? null : e.provider_status].filter(Boolean).join(' · ') || undefined,
    time: dateTime(e.occurred_at),
  };
}

function Card({ title, actions, children, className, label }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; label?: string }) {
  return (
    <section aria-label={label ?? (typeof title === 'string' ? title : undefined)} className={cn('flex flex-col gap-4 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1', className)}>
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-body-lg font-semibold text-text-primary">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

function ShipmentView({ shipment: s }: { shipment: ShipmentDetail }) {
  const scope = useStoreScope();
  const qc = useQueryClient();
  const invalidate = useShipmentInvalidate();
  const print = usePrintJob();
  const [dialog, setDialog] = useState<'cancel' | 'mark' | null>(null);
  const courier = isCourier(s.provider) ? courierName[s.provider] : (s.carrier_name ?? courierName.manual);
  const title = s.consignment_id ?? s.tracking_code ?? s.order.number;
  const events = [...s.events].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));

  const refresh = useMutation({
    mutationFn: () => api.shipments.refresh(scope.storeId!, s.id),
    onSuccess: async (next) => {
      qc.setQueryData(keys.shipment(scope, s.id), next);
      toast(`Updated from ${courier}.`);
      await invalidate({ orderId: s.order.id });
    },
    onError: (e) =>
      toast(
        isApiError(e) && e.status === 429 ? 'Refreshed a moment ago. Try again in a few seconds.' : isApiError(e) && e.code === 'provider_unavailable' ? `${courier} didn’t answer. Try again in a minute.` : errorMessage(e),
        'error',
      ),
  });

  const c = codCell(s);
  return (
    <>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-heading-24 break-all text-text-primary">{title}</h1>
            <ShipmentStatusBadge status={s.status} />
          </div>
          <p className="text-body text-text-secondary">
            <Link to="/shipments" className="text-brand-600 hover:text-brand-700">
              Shipments
            </Link>{' '}
            › {courier} · order{' '}
            <Link to={`/orders/${s.order.id}`} className="font-medium text-brand-600 hover:text-brand-700">
              {s.order.number}
            </Link>{' '}
            · {s.order.customer_name}
            {s.booked_at ? ` · booked ${dateTime(s.booked_at)}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="secondary" loading={print.pending} onClick={() => print.start('label_4x6', [s.order.id])}>
            <Printer aria-hidden className="size-4" /> Print label
          </Button>
          {s.tracking_url && (
            <a href={s.tracking_url} target="_blank" rel="noopener noreferrer nofollow" className={buttonVariants({ variant: 'secondary' })}>
              Open in {courier} <ExternalLink aria-hidden className="size-4" />
            </a>
          )}
        </div>
      </div>

      <div className="rounded-card border border-border-default bg-surface-card px-5 py-4 shadow-elevation-1">
        <Stepper label="Parcel progress" steps={trackingSteps(s.status)} />
      </div>

      {s.problem && (
        <p role="status" className="flex items-start gap-2.5 rounded-card border border-warning bg-warning-bg px-4 py-3 text-body text-text-primary">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            <span className="font-semibold">{problemLabels[s.problem]}</span>
            {s.failure_reason ? ` · ${s.failure_reason}` : ''}. Call the customer, then check with {courier}.
          </span>
        </p>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <div className="flex flex-col gap-5">
          <Card
            title="Tracking"
            actions={
              s.can.refresh && (
                <Button size="sm" variant="ghost" loading={refresh.isPending} onClick={() => refresh.mutate()}>
                  <RotateCcw aria-hidden className="size-4" /> Refresh
                </Button>
              )
            }
          >
            <p className="-mt-3 text-body text-text-secondary">
              {isCourier(s.provider) ? `Live from ${courier}` : 'Updated by your team'}
              {s.last_event_at ? ` · updated ${timeAgo(s.last_event_at)}` : ''}
            </p>
            {events.length === 0 ? (
              <p className="text-body text-text-muted">No scans yet. {courier} sends the first one when the rider picks the parcel up.</p>
            ) : (
              <Timeline label="Tracking timeline" items={events.map((e, i) => eventEntry(e, i === 0))} />
            )}
          </Card>

          <Card title="Parcel">
            <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Tile label="Items" value={s.parcel.items_summary || '—'} />
              <Tile label="Weight" value={s.parcel.weight_grams ? `${s.parcel.weight_grams / 1000} kg` : '—'} />
              <Tile label="Delivery" value={`${s.order.thana}, ${s.order.district}`} />
              <Tile label="Booked from" value={s.parcel.pickup_location ?? '—'} />
            </dl>
            <p className="flex items-center gap-2 rounded-lg bg-surface-subtle px-3.5 py-2.5 text-caption text-text-secondary">
              <MapPin aria-hidden className="size-4 shrink-0" /> Deliver to {s.order.customer_name} · {s.order.thana}, {s.order.district}
            </p>
          </Card>
        </div>

        <div className="flex flex-col gap-5">
          <Card title="Cash on delivery">
            <p className="-mt-3 text-body text-text-secondary">{isCourier(s.provider) ? `${courier} pays out after delivery.` : 'Collected by your rider.'}</p>
            <dl className="flex flex-col gap-2.5">
              <Row label="Collect from customer" value={formatBdt(s.money.collect_amount)} />
              {s.money.delivery_fee_amount !== null && <Row label="Delivery charge" value={`− ${formatBdt(s.money.delivery_fee_amount)}`} />}
              {s.money.cod_charge_amount !== null && <Row label="COD charge" value={`− ${formatBdt(s.money.cod_charge_amount)}`} />}
              <div className="flex items-center justify-between border-t border-border-default pt-3">
                <dt className="text-body-lg font-semibold text-text-primary">You’ll receive</dt>
                <dd className="text-heading text-success">{s.money.net_amount !== null ? formatBdt(s.money.net_amount) : 'After delivery'}</dd>
              </div>
            </dl>
            {c.label !== 'To collect' && <p className={cn('text-caption', c.tone === 'danger' ? 'text-danger' : 'text-text-muted')}>{c.label}{c.label === 'Collected' ? ` ${formatBdt(c.amount)}` : ''}</p>}
          </Card>

          <section aria-label="Customer" className="flex items-center gap-3 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-body-lg font-semibold text-text-primary">{s.order.customer_name}</span>
              <span className="text-body text-text-secondary">{localPhone(s.order.customer_phone)}</span>
            </span>
            <a href={`tel:+${s.order.customer_phone}`} className={buttonVariants({ size: 'sm', variant: 'secondary' })}>
              <Phone aria-hidden className="size-4" /> Call
            </a>
          </section>

          {(s.can.cancel || s.can.mark_cancelled) && (
            <Card title="Something wrong?">
              {s.can.cancel ? (
                <Button variant="secondary" className="w-full" onClick={() => setDialog('cancel')}>
                  Cancel the parcel
                </Button>
              ) : (
                <>
                  <p className="text-body text-text-secondary">
                    {courier} can’t cancel through Store Plix. Cancel it in the {courier} panel, then mark it cancelled here.
                  </p>
                  <Button variant="secondary" className="w-full" onClick={() => setDialog('mark')}>
                    Mark cancelled
                  </Button>
                </>
              )}
            </Card>
          )}
        </div>
      </div>

      {dialog === 'cancel' && <CancelParcelDialog shipment={s} courier={courier} onUnsupported={() => setDialog('mark')} onClose={() => setDialog(null)} />}
      {dialog === 'mark' && <MarkCancelledDialog shipment={s} courier={courier} onClose={() => setDialog(null)} />}
    </>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-body">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="text-text-primary">{value}</dd>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md bg-surface-subtle px-3.5 py-2.5">
      <dt className="text-caption text-text-muted">{label}</dt>
      <dd className="text-body font-medium break-words text-text-primary">{value}</dd>
    </div>
  );
}

/** P5B-41: cancel while `booked`. 409 `courier_cancel_unsupported` → the "mark cancelled" instructions. */
export function CancelParcelDialog({ shipment, courier, onUnsupported, onClose }: { shipment: ShipmentDetail; courier: string; onUnsupported: () => void; onClose: () => void }) {
  const { storeId } = useStoreScope();
  const invalidate = useShipmentInvalidate();
  const [reason, setReason] = useState('');
  const cancel = useMutation({
    mutationFn: () => api.shipments.cancel(storeId!, shipment.id, { reason: reason.trim() || null }),
    onSuccess: async () => {
      toast(`Parcel cancelled with ${courier}. ${shipment.order.number} is ready to ship again.`);
      onClose();
      await invalidate({ orderId: shipment.order.id, shipmentId: shipment.id });
    },
    onError: async (e) => {
      if (isApiError(e) && e.code === 'courier_cancel_unsupported') return onUnsupported();
      if (isApiError(e) && e.code === 'invalid_state_transition') {
        toast('The rider already has this parcel, so it can’t be cancelled now.', 'error');
        onClose();
        await invalidate({ orderId: shipment.order.id, shipmentId: shipment.id });
        return;
      }
      toast(isApiError(e) && e.code === 'provider_unavailable' ? `${courier} didn’t answer. Nothing changed — try again in a minute.` : errorMessage(e), 'error');
    },
  });
  return (
    <Dialog
      open
      tone="danger"
      title={`Cancel ${shipment.consignment_id ?? 'this parcel'}?`}
      description={`${courier} won’t pick it up. The order goes back to Ready to ship so you can book it again.`}
      confirmLabel="Cancel the parcel"
      cancelLabel="Keep it"
      loading={cancel.isPending}
      onConfirm={() => cancel.mutate()}
      onCancel={onClose}
    >
      <Input id="cancel-reason" label="Reason (optional)" maxLength={255} value={reason} onChange={(e) => setReason(e.target.value)} />
    </Dialog>
  );
}

export function MarkCancelledDialog({ shipment, courier, onClose }: { shipment: ShipmentDetail; courier: string; onClose: () => void }) {
  const { storeId } = useStoreScope();
  const invalidate = useShipmentInvalidate();
  const [note, setNote] = useState('');
  const mark = useMutation({
    mutationFn: () => api.shipments.markCancelled(storeId!, shipment.id, { note: note.trim() || null }),
    onSuccess: async () => {
      toast(`Marked cancelled. ${shipment.order.number} is ready to ship again.`);
      onClose();
      await invalidate({ orderId: shipment.order.id, shipmentId: shipment.id });
    },
    onError: async (e) => {
      if (!(isApiError(e) && e.status === 409)) return toast(errorMessage(e), 'error');
      toast('This parcel has moved on and can’t be marked cancelled. We reloaded it.', 'error');
      onClose();
      await invalidate({ orderId: shipment.order.id, shipmentId: shipment.id });
    },
  });
  return (
    <Dialog
      open
      title="Cancel it in the courier panel"
      description={`${courier} can’t cancel through Store Plix. Cancel ${shipment.consignment_id ?? 'the parcel'} in the ${courier} panel first, then mark it cancelled here so the order can be booked again.`}
      confirmLabel="I cancelled it · mark cancelled"
      cancelLabel="Not yet"
      loading={mark.isPending}
      onConfirm={() => mark.mutate()}
      onCancel={onClose}
    >
      <div className="flex flex-col gap-3">
        <p className="flex items-center gap-2 text-caption text-text-muted">
          <AlertTriangle aria-hidden className="size-4 shrink-0 text-warning" /> Store Plix can’t check this. Only mark it once {courier} shows it cancelled.
        </p>
        <Input id="mark-note" label="Note (optional)" maxLength={255} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Dialog>
  );
}

export default ShipmentDetailPage;
