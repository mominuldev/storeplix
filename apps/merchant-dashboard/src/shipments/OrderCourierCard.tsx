import type { CourierProvider, Order } from '@storeplix/types';
import { Badge, Button, cn, ProviderLogo, ShipmentStatusBadge } from '@storeplix/ui';
import { ExternalLink } from 'lucide-react';
import { Link } from 'react-router';
import { formatBdt } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { timeAgo } from '../commerce/format';
import { useShipping } from '../commerce/queries';
import { codCell, connectedCouriers, courierName, isCourier, problemLabels } from './labels';
import { useCourierAccounts } from './queries';

// Order detail 33:3676 Shipping card, courier part (PHASE-5B §10): connected-courier cards + Pickup · Weight · COD
// summary + "Book with {courier}", or the active parcel (status, last scan, tracking link, COD, View parcel). "Buyer:
// 3 of 5 delivered" and per-courier prices are Phase 8 (§14) and are not shown.

const BOOKABLE: Order['status'][] = ['confirmed', 'ready_to_ship'];

export function OrderCourierCard({ order, onBook }: { order: Order; onBook: (provider: CourierProvider) => void }) {
  const scope = useStoreScope();
  const couriers = useCourierAccounts();
  const shipping = useShipping();
  const parcel = order.shipment && order.shipment.status !== 'cancelled' && order.shipment.status !== 'booking_failed' ? order.shipment : null;

  if (parcel && isCourier(parcel.provider)) {
    const c = codCell(parcel);
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3 rounded-lg border border-border-default p-3.5">
          <ProviderLogo provider={parcel.provider} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-body font-semibold text-text-primary">{courierName[parcel.provider]}</span>
              <ShipmentStatusBadge status={parcel.status} />
            </span>
            <span className="truncate text-caption text-text-muted">
              {[parcel.consignment_id, parcel.last_location, parcel.last_event_at ? timeAgo(parcel.last_event_at) : null].filter(Boolean).join(' · ') || 'Waiting for the courier'}
            </span>
          </span>
          <span className="hidden flex-col text-right sm:flex">
            <span className="text-body font-semibold text-text-primary">{formatBdt(c.amount)}</span>
            <span className={cn('text-caption', c.tone === 'danger' ? 'text-danger' : 'text-text-muted')}>{c.label}</span>
          </span>
        </div>
        {parcel.problem && <p className="text-caption text-danger">{problemLabels[parcel.problem]}{parcel.failure_reason ? ` · ${parcel.failure_reason}` : ''}</p>}
        {parcel.status === 'booking' && <p className="text-caption text-text-muted">{courierName[parcel.provider]} hasn’t confirmed the booking yet. We keep checking for 10 minutes.</p>}
        <div className="flex flex-wrap items-center gap-4">
          <Link to={`/shipments/${parcel.id}`} className="text-caption font-medium text-brand-600">
            View parcel
          </Link>
          {parcel.tracking_url && (
            <a href={parcel.tracking_url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 text-caption font-medium text-brand-600">
              Track on {courierName[parcel.provider]} <ExternalLink aria-hidden className="size-3.5" />
            </a>
          )}
        </div>
      </div>
    );
  }
  if (parcel) return null; // manual shipment: the 5a Courier / Tracking fields cover it

  const connected = connectedCouriers(couriers.data);
  const canBook = BOOKABLE.includes(order.status);
  const notYet = order.status === 'pending' || order.status === 'pending_payment';
  const fallback = order.status === 'cancelled' ? null : <p className="text-caption text-text-muted">Not shipped yet.</p>;
  if (couriers.isPending || couriers.isError) return fallback;
  if (connected.length === 0) {
    if (!canBook && !notYet) return fallback;
    return (
      <p className="text-caption text-text-muted">
        Connect Steadfast, Pathao or RedX to book parcels from here.{' '}
        {scope.canManageIntegrations && (
          <Link to="/integrations" className="font-medium text-brand-600">
            Go to Integrations
          </Link>
        )}
      </p>
    );
  }
  if (!canBook && !notYet) return fallback;
  const first = connected[0]!;
  const pickups = shipping.data?.pickup_locations ?? [];
  const pickup = pickups.find((p) => p.id === first.settings.pickup_location_id) ?? pickups.find((p) => p.is_default) ?? pickups[0];

  return (
    <div className="flex flex-col gap-4">
      {!canBook && (
        <div className="-mt-1 flex justify-end">
          <Badge tone="neutral">Book after confirming</Badge>
        </div>
      )}
      <div className={cn('grid gap-3', connected.length > 1 && 'sm:grid-cols-2')}>
        {connected.map((a) => (
          <button
            key={a.provider}
            type="button"
            disabled={!canBook}
            onClick={() => onBook(a.provider)}
            className={cn(
              'flex items-center gap-3 rounded-lg border p-3.5 text-left outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-60',
              a.is_default ? 'border-brand-600 bg-brand-50 shadow-[inset_0_0_0_1px_var(--color-brand-600)]' : 'border-border-default bg-surface-card hover:bg-surface-subtle',
            )}
          >
            <ProviderLogo provider={a.provider} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-body font-semibold text-text-primary">{courierName[a.provider]}</span>
              <span className="text-caption text-text-muted">{a.is_default ? 'Your default' : 'Connected'}</span>
            </span>
          </button>
        ))}
      </div>
      <dl className="grid grid-cols-3 gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-caption text-text-muted">Pickup</dt>
          <dd className="truncate text-body text-text-primary">{pickup ? `${pickup.name} · ${pickup.thana}` : '—'}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-caption text-text-muted">Weight</dt>
          <dd className="text-body text-text-primary">{(first.settings.default_weight_grams || 500) / 1000} kg</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-caption text-text-muted">COD amount</dt>
          <dd className="text-body text-text-primary">{formatBdt(Math.max(0, order.due_amount))}</dd>
        </div>
      </dl>
      <Button className="w-full" disabled={!canBook} onClick={() => onBook(first.provider)}>
        Book with {courierName[first.provider]}
      </Button>
    </div>
  );
}
