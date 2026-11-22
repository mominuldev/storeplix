import { isApiError } from '@storeplix/api-client';
import type { CourierProvider, OrderSummary, ShipmentBatch } from '@storeplix/types';
import { Button, cn, DataTable, Modal, ProgressBar, type DataTableColumn } from '@storeplix/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, MinusCircle, XCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { formatBdt, formatCount, plural } from '../catalog/format';
import { keys, useStoreScope } from '../catalog/scope';
import { errorMessage, LoadingRows } from '../catalog/states';
import { Cell2 } from '../catalog/ui';
import { localPhone, orderChannelLabels } from '../commerce/format';
import { useOrders } from '../commerce/queries';
import { api } from '../lib/api';
import { can } from '../lib/permissions';
import { CourierChoice } from './BookShipmentDialog';
import { batchReasonLabel, connectedCouriers, courierName, needsArea } from './labels';
import { useCourierAccounts, useShipmentInvalidate } from './queries';

// Bulk booking 39:18808 (P5B-40): choose a connected courier, review the orders (COD per order), book up to 500;
// 202 `ShipmentBatch` is polled until `completed`/`failed` and the per-order results are listed (`area_unmapped` →
// "book it from the order"). 402 `feature_not_in_plan` → upgrade dialog. Not built (§14): price/delivery estimates,
// "This batch delivered %", "Print labels after booking", "Send tracking SMS" (5a SMS on shipped covers it).

export const BULK_MAX = 500;
export const BATCH_POLL_MS = 1500;
const BOOKABLE: OrderSummary['status'][] = ['confirmed', 'ready_to_ship'];
const bookable = (o: OrderSummary) => BOOKABLE.includes(o.status) && (!o.shipment || o.shipment.status === 'cancelled' || o.shipment.status === 'booking_failed' || o.shipment.provider === 'manual');

type Phase = { kind: 'choose' } | { kind: 'batch'; batch: ShipmentBatch } | { kind: 'upgrade'; message: string };

export interface BulkBookDialogProps {
  /** Orders picked on the Orders list. Without it the dialog loads confirmed/packed orders that have no parcel yet. */
  orders?: OrderSummary[];
  onClose: () => void;
  onDone?: () => void;
}

export function BulkBookDialog({ orders, onClose, onDone }: BulkBookDialogProps) {
  const scope = useStoreScope();
  const couriers = useCourierAccounts();
  const connected = connectedCouriers(couriers.data);
  const [chosen, setChosen] = useState<CourierProvider | null>(null);
  const provider = chosen && connected.some((c) => c.provider === chosen) ? chosen : (connected[0]?.provider ?? null);
  const picker = !orders;
  const waiting = useOrders({ status: BOOKABLE, sort: 'placed_at', per_page: 100 }, picker);
  const candidates = useMemo(() => (orders ?? waiting.data?.data ?? []).filter(bookable), [orders, waiting.data]);
  const skippedUpfront = orders ? orders.length - candidates.length : 0;
  const [selected, setSelected] = useState<string[] | null>(null);
  const ids = selected ?? candidates.map((o) => o.id);
  const picked = candidates.filter((o) => ids.includes(o.id));
  const cod = picked.reduce((sum, o) => sum + Math.max(0, o.due_amount), 0);
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' });
  const [error, setError] = useState<string | null>(null);
  const invalidate = useShipmentInvalidate();

  const start = useMutation({
    mutationFn: () => api.shipments.bulk(scope.storeId!, { provider: provider!, order_ids: picked.map((o) => o.id) }),
    onSuccess: (batch) => setPhase({ kind: 'batch', batch }),
    onError: (e) => {
      if (isApiError(e) && e.status === 402 && e.code === 'feature_not_in_plan') return setPhase({ kind: 'upgrade', message: e.message });
      if (isApiError(e) && e.code === 'gateway_not_connected') return setError(`${provider ? courierName[provider] : 'The courier'} isn’t connected any more. Check Integrations.`);
      if (isApiError(e) && e.status === 422 && e.details) {
        const first = Object.entries(e.details)[0];
        const idx = first ? /order_ids\.(\d+)/.exec(first[0]) : null;
        const order = idx ? picked[Number(idx[1])] : undefined;
        return setError(order ? `${order.number}: ${first?.[1][0] ?? 'can’t be booked'}. Nothing was booked.` : (first?.[1][0] ?? e.message));
      }
      setError(errorMessage(e, 'We couldn’t start the booking. Nothing was booked.'));
    },
  });

  const batchId = phase.kind === 'batch' ? phase.batch.id : null;
  const poll = useQuery({
    queryKey: keys.shipmentBatch(scope, batchId),
    queryFn: () => api.shipments.batch(scope.storeId!, batchId!),
    enabled: !!batchId,
    initialData: phase.kind === 'batch' ? phase.batch : undefined,
    refetchInterval: (q) => (q.state.data && (q.state.data.status === 'queued' || q.state.data.status === 'running') ? BATCH_POLL_MS : false),
  });
  const batch = phase.kind === 'batch' ? (poll.data ?? phase.batch) : null;
  const finished = !!batch && (batch.status === 'completed' || batch.status === 'failed');

  const refreshed = useRef(false);
  useEffect(() => {
    if (!finished || refreshed.current) return;
    refreshed.current = true;
    void invalidate();
  }, [finished, invalidate]);

  const close = () => {
    if (finished) onDone?.();
    onClose();
  };

  if (phase.kind === 'upgrade') return <UpgradeDialog message={phase.message} onClose={onClose} />;

  if (batch) {
    const done = batch.booked + batch.skipped + batch.failed;
    return (
      <Modal
        open
        size="xl"
        onClose={close}
        title={finished ? `${plural(batch.booked, 'parcel')} booked with ${courierName[batch.provider]}` : `Booking ${plural(batch.total, 'parcel')} with ${courierName[batch.provider]}…`}
        description={finished ? 'Labels are ready to print from Invoices & labels.' : 'You can close this window; booking carries on and the results show up on Shipments.'}
        footer={
          <Button onClick={close} variant={finished ? 'primary' : 'secondary'}>
            {finished ? 'Done' : 'Close'}
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <ProgressBar value={batch.total ? done / batch.total : 0} label="Booking progress" />
          <p className="text-body text-text-secondary" aria-live="polite">
            {formatCount(batch.booked)} booked · {formatCount(batch.skipped)} skipped · {formatCount(batch.failed)} failed · {formatCount(batch.total)} in total
          </p>
          {batch.status === 'failed' && (
            <p role="alert" className="flex items-start gap-2 rounded-lg bg-danger-bg px-3.5 py-2.5 text-body text-danger">
              <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" /> {courierName[batch.provider]} stopped answering part-way. Orders that weren’t booked can be booked again.
            </p>
          )}
          {batch.results.length > 0 && (
            <ul aria-label="Booking results" className="flex flex-col divide-y divide-border-default rounded-lg border border-border-default">
              {batch.results.map((r) => (
                <li key={r.order_id} className="flex items-start gap-3 px-4 py-3">
                  {r.status === 'booked' ? (
                    <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                  ) : r.status === 'skipped' ? (
                    <MinusCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
                  ) : (
                    <XCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <Link to={`/orders/${r.order_id}`} onClick={close} className="text-body font-semibold text-text-primary hover:text-brand-600">
                      {r.order_number}
                    </Link>
                    {r.status !== 'booked' && <span className={cn('text-caption', r.status === 'failed' ? 'text-danger' : 'text-warning')}>{batchReasonLabel(r.reason, batch.provider) || (r.status === 'failed' ? 'Failed' : 'Skipped')}</span>}
                  </span>
                  <span className="text-caption font-medium text-text-secondary">{r.status === 'booked' ? 'Booked' : r.status === 'skipped' ? 'Skipped' : 'Failed'}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>
    );
  }

  const columns: DataTableColumn<OrderSummary>[] = [
    { key: 'order', header: 'Order', width: 120, mobileLabel: false, cell: (o) => <Cell2 top={o.number} bottom={orderChannelLabels[o.channel]} /> },
    { key: 'customer', header: 'Customer', mobileLabel: false, cell: (o) => <Cell2 top={o.customer.name} bottom={localPhone(o.customer.phone)} topClass="font-medium" /> },
    { key: 'area', header: 'District · Area', width: 150, cell: (o) => <Cell2 top={o.district} bottom={o.thana} topClass="font-medium" /> },
    {
      key: 'cod',
      header: 'COD',
      width: 120,
      align: 'end',
      cell: (o) => (
        <Cell2
          top={formatBdt(Math.max(0, o.due_amount))}
          bottom={o.due_amount <= 0 ? 'Paid online' : o.paid_amount > 0 ? `${formatBdt(o.paid_amount)} advance paid` : 'Full COD'}
          bottomClass={o.paid_amount > 0 ? 'text-success' : undefined}
        />
      ),
    },
  ];

  const tooMany = picked.length > BULK_MAX;
  const loadingOrders = picker && waiting.isPending;
  const title = picked.length > 0 ? `Book ${plural(picked.length, 'order')} with a courier` : 'Book parcels';
  const preview = picked.slice(0, 3).map((o) => o.number).join(', ') + (picked.length > 3 ? ` +${picked.length - 3} more` : '');

  return (
    <Modal
      open
      size="xl"
      onClose={onClose}
      title={title}
      description={preview || 'Confirmed and packed orders without a parcel'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={start.isPending}>
            Cancel
          </Button>
          <Button disabled={!provider || picked.length === 0 || tooMany || start.isPending} loading={start.isPending} onClick={() => { setError(null); start.mutate(); }}>
            Book {plural(picked.length, 'parcel')}
          </Button>
        </>
      }
    >
      {couriers.isPending ? (
        <p className="text-body text-text-muted">Loading your couriers…</p>
      ) : connected.length === 0 ? (
        <p className="rounded-lg bg-surface-subtle p-4 text-body text-text-secondary">
          Connect Steadfast, Pathao or RedX to book parcels in bulk.{' '}
          {scope.canManageIntegrations && (
            <Link to="/integrations" className="font-medium text-brand-600">
              Go to Integrations
            </Link>
          )}
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          <CourierChoice accounts={connected} value={provider} onChange={setChosen} />
          {provider && needsArea(provider) && (
            <p className="rounded-lg bg-info-bg px-3.5 py-2.5 text-caption text-text-primary">
              {courierName[provider]} needs its own area for each address. Orders whose area you haven’t matched yet are skipped — book those from the order to choose the area once.
            </p>
          )}
          {skippedUpfront > 0 && <p className="text-caption text-text-muted">{plural(skippedUpfront, 'selected order')} left out: not confirmed yet, or already with a courier.</p>}
          <DataTable
            label="Orders to book"
            columns={columns}
            rows={candidates}
            getRowId={(o) => o.id}
            rowLabel={(o) => o.number}
            selected={ids}
            onSelectedChange={setSelected}
            state={
              loadingOrders ? (
                <LoadingRows label="Loading orders" rows={3} />
              ) : waiting.isError && picker ? (
                <p role="alert" className="px-4 py-6 text-body text-danger">
                  {errorMessage(waiting.error)}
                </p>
              ) : candidates.length === 0 ? (
                <p className="px-4 py-8 text-center text-body text-text-secondary">Nothing to book. Confirm orders first — packed and confirmed orders without a parcel show up here.</p>
              ) : undefined
            }
          />
          {picker && (waiting.data?.meta.total ?? 0) > 100 && <p className="text-caption text-text-muted">Showing the oldest 100 waiting orders. Book these, then open this again for the rest.</p>}
          <div className="grid grid-cols-2 gap-4 rounded-lg bg-surface-subtle p-4">
            <div className="flex flex-col gap-0.5">
              <span className="text-caption text-text-secondary">COD to collect</span>
              <span className="text-heading text-text-primary">{formatBdt(cod)}</span>
              <span className="text-caption text-text-muted">From {plural(picked.length, 'buyer')} at the door</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-caption text-text-secondary">Parcels</span>
              <span className="text-heading text-text-primary">{formatCount(picked.length)}</span>
              <span className={cn('text-caption', tooMany ? 'text-danger' : 'text-text-muted')}>Up to {formatCount(BULK_MAX)} at a time</span>
            </div>
          </div>
          {error && (
            <p role="alert" className="flex items-start gap-2 rounded-lg bg-danger-bg px-3.5 py-2.5 text-body text-danger">
              <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" /> {error}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

/** 402 `feature_not_in_plan` (P5B-31): bulk booking is Starter and up. */
function UpgradeDialog({ message, onClose }: { message: string; onClose: () => void }) {
  const navigate = useNavigate();
  const { role } = useStoreScope();
  const billing = can.viewBilling(role);
  return (
    <Modal
      open
      size="sm"
      onClose={onClose}
      title="Bulk booking is on Starter and up"
      description={`${message ? `${message} ` : ''}${billing ? 'Upgrade to book up to 500 parcels in one go. Until then, book each order from its page.' : 'Ask the shop owner to upgrade. Until then, book each order from its page.'}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {billing ? 'Not now' : 'OK'}
          </Button>
          {billing && (
            <Button
              onClick={() => {
                onClose();
                navigate('/settings/plan');
              }}
            >
              Upgrade to Starter
            </Button>
          )}
        </>
      }
    >
      <p className="text-caption text-text-muted">Nothing was booked.</p>
    </Modal>
  );
}
