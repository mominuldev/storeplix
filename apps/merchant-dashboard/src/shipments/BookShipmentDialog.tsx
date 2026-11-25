import { isApiError } from '@storeplix/api-client';
import type { BookShipmentInput, CourierAccount, CourierArea, CourierProvider, Order, Shipment } from '@storeplix/types';
import { Button, Checkbox, cn, Input, Modal, MoneyInput, ProviderLogo, SegmentedControl, Select } from '@storeplix/ui';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { formatBdt } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { errorMessage } from '../catalog/states';
import { newIdempotencyKey } from '../commerce/format';
import { useShipping } from '../commerce/queries';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { connectedCouriers, courierName, needsArea, renderDescription } from './labels';
import { useCourierAccounts, useCourierAreas, useShipmentInvalidate } from './queries';

// Order detail courier card 33:3676 "Book with {courier}" and bulk booking 39:18808 (single-order variant), PHASE-5B
// §10/§13: courier select among connected, pickup, COD (O A editable, hidden for staff, P5B-35), weight, description,
// note, delivery type (Pathao), area selects for Pathao/RedX pre-selected from `meta.suggested` with "remember"
// (P5B-39). Errors: `courier_rejected` (sanitised server message), `shipment_booked`, `provider_unavailable`.
// Not built (§14): price quote, "Print label after booking", fraud estimate.

type Area = NonNullable<BookShipmentInput['area']>;
const EMPTY_AREA: Area = { city_id: null, zone_id: null, area_id: null };

export interface BookShipmentDialogProps {
  order: Order;
  /** Preselect this courier (e.g. "Book with Pathao"). Defaults to the default connected courier. */
  provider?: CourierProvider;
  onClose: () => void;
  onBooked?: (shipment: Shipment) => void;
}

export function BookShipmentDialog({ order, provider: initialProvider, onClose, onBooked }: BookShipmentDialogProps) {
  const scope = useStoreScope();
  const couriers = useCourierAccounts();
  const shipping = useShipping();
  const invalidate = useShipmentInvalidate();
  const canOverrideCod = scope.canManageRefunds; // S33: COD override needs orders.refund
  const connected = connectedCouriers(couriers.data);
  const [chosen, setChosen] = useState<CourierProvider | null>(initialProvider ?? null);
  const provider = chosen && connected.some((c) => c.provider === chosen) ? chosen : (connected[0]?.provider ?? null);
  const account = connected.find((c) => c.provider === provider);

  const pickups = shipping.data?.pickup_locations ?? [];
  const [pickup, setPickup] = useState<string>('');
  const pickupId = pickup || account?.settings.pickup_location_id || pickups.find((p) => p.is_default)?.id || pickups[0]?.id || '';
  const [cod, setCod] = useState<number | null>(order.due_amount);
  const [weight, setWeight] = useState<string>('');
  const weightText = weight || (account ? String((account.settings.default_weight_grams || 500) / 1000) : '0.5');
  const [description, setDescription] = useState('');
  const [note, setNote] = useState('');
  const [deliveryType, setDeliveryType] = useState<'48' | '12' | ''>('');
  const [area, setArea] = useState<Area | null>(null);
  const [remember, setRemember] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  // One key per attempt body; a definitive 4xx starts a new attempt (a changed body under the old key is refused).
  const [key, setKey] = useState(newIdempotencyKey);

  const grams = Math.round(Number(weightText.replace(',', '.')) * 1000);
  const weightError = !Number.isFinite(grams) || grams <= 0 ? 'Enter the weight in kg, like 0.5' : provider === 'pathao' && (grams < 500 || grams > 10000) ? 'Pathao takes 0.5 to 10 kg' : null;
  const codError = canOverrideCod ? (cod === null || !Number.isFinite(cod) || cod < 0 ? 'Enter an amount, 0 or more' : cod > order.total_amount ? `Up to the order total ${formatBdt(order.total_amount)}` : null) : null;
  const areaMissing = provider && needsArea(provider) ? (provider === 'pathao' ? !area?.city_id || !area?.zone_id : !area?.area_id) : false;
  const template = account?.settings.parcel_description;
  const descriptionPreview = template ? renderDescription(template, order) : '';

  const book = useMutation({
    mutationFn: () => {
      const input: BookShipmentInput = {
        provider: provider!,
        pickup_location_id: pickupId || null,
        weight_grams: grams,
        item_description: description.trim() || null,
        note: note.trim() || null,
        ...(canOverrideCod && cod !== order.due_amount ? { cod_amount: cod } : {}),
        ...(provider === 'pathao' ? { delivery_type: Number(deliveryType || account?.settings.delivery_type || 48) as 48 | 12 } : {}),
        ...(provider && needsArea(provider) ? { area, remember_area: remember } : {}),
      };
      return api.shipments.book(scope.storeId!, order.id, input, key);
    },
    onSuccess: async (shipment) => {
      const name = courierName[shipment.provider];
      toast(
        shipment.status === 'booking'
          ? `${name} is slow to answer. We’ll finish booking ${order.number} in the background.`
          : `Booked with ${name}${shipment.consignment_id ? ` · ${shipment.consignment_id}` : ''}.`,
      );
      onBooked?.(shipment);
      onClose();
      await invalidate({ orderId: order.id, shipmentId: shipment.id });
    },
    onError: async (e) => {
      setErrors({});
      if (!isApiError(e)) return setBanner(errorMessage(e, 'We couldn’t book this parcel. Check your connection and try again.'));
      if (e.status !== 502 && e.status !== 429 && e.status >= 400 && e.status < 500) setKey(newIdempotencyKey());
      const name = provider ? courierName[provider] : 'The courier';
      switch (e.code) {
        case 'courier_rejected':
          return setBanner(`${name} refused this parcel: ${e.message}`);
        case 'provider_unavailable':
          return setBanner(`${name} didn’t answer. Nothing was booked — try again in a minute.`);
        case 'shipment_booked':
          toast(`${order.number} is already booked with a courier.`, 'error');
          onClose();
          await invalidate({ orderId: order.id });
          return;
        case 'invalid_state_transition':
          toast('This order changed and can’t be booked now. We reloaded it.', 'error');
          onClose();
          await invalidate({ orderId: order.id });
          return;
        case 'gateway_not_connected':
          return setBanner(`${name} isn’t connected any more. Check Integrations.`);
      }
      if (e.status === 422 && e.fieldErrors) {
        const next = Object.fromEntries(Object.entries(e.fieldErrors).map(([k, m]) => [k.startsWith('area') ? 'area' : k, m[0] ?? '']));
        setErrors(next);
        return setBanner(next.area && !Object.keys(next).some((k) => k !== 'area') ? null : e.message);
      }
      setBanner(e.message || errorMessage(e));
    },
  });

  const loading = couriers.isPending;
  const disabled = !provider || !!weightError || !!codError || areaMissing || book.isPending;

  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title={provider ? `Book ${order.number} with ${courierName[provider]}` : `Book ${order.number} with a courier`}
      description={`${order.contact.name} · ${order.shipping_address.thana}, ${order.shipping_address.district}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={book.isPending}>
            Cancel
          </Button>
          <Button disabled={disabled} loading={book.isPending} onClick={() => book.mutate()}>
            {provider ? `Book with ${courierName[provider]}` : 'Book parcel'}
          </Button>
        </>
      }
    >
      {loading ? (
        <p className="text-body text-text-muted">Loading your couriers…</p>
      ) : couriers.isError ? (
        <p role="alert" className="text-body text-danger">
          {errorMessage(couriers.error, 'We couldn’t load your couriers.')}{' '}
          <button type="button" className="font-medium text-brand-600" onClick={() => void couriers.refetch()}>
            Try again
          </button>
        </p>
      ) : connected.length === 0 ? (
        <p className="rounded-lg bg-surface-subtle p-4 text-body text-text-secondary">
          Connect Steadfast, Pathao or RedX to book parcels from here.{' '}
          {scope.canManageIntegrations ? (
            <Link to="/integrations" className="font-medium text-brand-600">
              Go to Integrations
            </Link>
          ) : (
            'Ask the shop owner to connect a courier.'
          )}
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          <CourierChoice accounts={connected} value={provider} onChange={(p) => { setChosen(p); setArea(null); setErrors({}); setBanner(null); }} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Select id="book-pickup" label="Pickup from" value={pickupId} error={errors.pickup_location_id} onChange={(e) => setPickup(e.target.value)}>
              {pickups.length === 0 && <option value="">No pickup location yet</option>}
              {pickups.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.thana}
                </option>
              ))}
            </Select>
            <Input id="book-weight" label="Weight (kg)" inputMode="decimal" value={weightText} error={errors.weight_grams ?? weightError ?? undefined} onChange={(e) => setWeight(e.target.value)} />
          </div>
          {canOverrideCod ? (
            <MoneyInput
              id="book-cod"
              label="Cash to collect"
              value={cod}
              onChange={setCod}
              error={errors.cod_amount ?? codError ?? undefined}
              hint={`Order due amount is ${formatBdt(order.due_amount)}. Changing it is noted in the activity log.`}
            />
          ) : (
            <div className="flex items-center justify-between rounded-md bg-surface-subtle px-3.5 py-2.5 text-body">
              <span className="text-text-secondary">Cash to collect · order due amount</span>
              <span className="font-semibold text-text-primary">{formatBdt(order.due_amount)}</span>
            </div>
          )}
          {provider && needsArea(provider) && (
            <AreaSelects key={provider} provider={provider} order={order} value={area} onChange={setArea} error={errors.area} remember={remember} onRemember={setRemember} />
          )}
          {provider === 'pathao' && (
            <div className="flex flex-col gap-1.5">
              <span className="text-body font-medium text-text-primary">Delivery type</span>
              <SegmentedControl
                aria-label="Delivery type"
                value={deliveryType || String(account?.settings.delivery_type ?? 48) as '48' | '12'}
                onChange={(v) => setDeliveryType(v)}
                options={[
                  { value: '48', label: 'Normal delivery' },
                  { value: '12', label: 'On-demand' },
                ]}
              />
            </div>
          )}
          <Input
            id="book-description"
            label="Parcel description (optional)"
            maxLength={120}
            value={description}
            placeholder={descriptionPreview || 'What’s in the parcel'}
            hint={template ? 'Leave empty to use your template from the courier settings.' : undefined}
            error={errors.item_description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <Input id="book-note" label="Note for the rider (optional)" maxLength={255} value={note} placeholder="Call before coming" error={errors.note} onChange={(e) => setNote(e.target.value)} />
          {banner && (
            <p role="alert" className="flex items-start gap-2.5 rounded-lg bg-danger-bg px-3.5 py-2.5 text-body text-danger">
              <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" /> <span className="min-w-0 break-words">{banner}</span>
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Courier cards (39:18808 "Choose a courier"): logo, name, Default hint; radio semantics. */
export function CourierChoice({ accounts, value, onChange }: { accounts: CourierAccount[]; value: CourierProvider | null; onChange: (p: CourierProvider) => void }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-body-lg font-semibold text-text-primary">Choose a courier</legend>
      <div className="grid gap-3 sm:grid-cols-3">
        {accounts.map((a) => {
          const on = a.provider === value;
          return (
            <label
              key={a.provider}
              className={cn(
                'flex cursor-pointer items-center gap-3 rounded-lg border p-3.5 has-[:focus-visible]:shadow-focus',
                on ? 'border-brand-600 bg-brand-50 shadow-[inset_0_0_0_1px_var(--color-brand-600)]' : 'border-border-default bg-surface-card hover:bg-surface-subtle',
              )}
            >
              <ProviderLogo provider={a.provider} size="sm" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body font-semibold text-text-primary">{courierName[a.provider]}</span>
                <span className="truncate text-caption text-text-muted">{a.is_default ? 'Your default' : a.mode === 'sandbox' ? 'Sandbox' : 'Connected'}</span>
              </span>
              <input type="radio" name="courier" value={a.provider} checked={on} onChange={() => onChange(a.provider)} className="size-4 accent-brand-600" aria-label={courierName[a.provider]} />
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * P5B-39 area selects. Pathao: city → zone → area (area optional); RedX: one area list. The first list is requested
 * with the order's district/thana so the API can send `meta.suggested`; the suggestion fills the selects once.
 */
function AreaSelects({
  provider,
  order,
  value,
  onChange,
  error,
  remember,
  onRemember,
}: {
  provider: CourierProvider;
  order: Order;
  value: Area | null;
  onChange: (a: Area) => void;
  error?: string;
  remember: boolean;
  onRemember: (v: boolean) => void;
}) {
  const addr = order.shipping_address;
  const pathao = provider === 'pathao';
  const v = value ?? EMPTY_AREA;
  const first = useCourierAreas(provider, { level: pathao ? 'city' : 'area', district_code: addr.district_code, thana_code: addr.thana_code });
  const zones = useCourierAreas(provider, pathao && v.city_id ? { level: 'zone', parent_id: v.city_id } : null);
  const areas = useCourierAreas(provider, pathao && v.zone_id ? { level: 'area', parent_id: v.zone_id } : null);
  const suggested = first.data?.suggested ?? null;

  useEffect(() => {
    if (value === null && first.isSuccess) onChange(suggested ?? EMPTY_AREA);
  }, [value, first.isSuccess, suggested, onChange]);

  const matched = useMemo(() => !!suggested && (pathao ? !!suggested.city_id && !!suggested.zone_id : !!suggested.area_id), [suggested, pathao]);
  const name = courierName[provider];
  const listError = first.isError ? errorMessage(first.error, `We couldn’t load ${name} areas.`) : null;

  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-border-default p-4">
      <legend className="px-1 text-body font-medium text-text-primary">{name} delivery area</legend>
      <p className="text-caption text-text-muted">
        {addr.thana}, {addr.district} ·{' '}
        {first.isPending ? 'finding the matching area…' : matched ? `matched to ${name}’s list — check it` : `choose it from ${name}’s list`}
      </p>
      {listError ? (
        <p role="alert" className="text-caption text-danger">
          {listError}{' '}
          <button type="button" className="font-medium text-brand-600" onClick={() => void first.refetch()}>
            Try again
          </button>
        </p>
      ) : pathao ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <AreaSelect id="area-city" label="City" list={first.data?.data} pending={first.isPending} value={v.city_id} onChange={(id) => onChange({ city_id: id, zone_id: null, area_id: null })} />
          <AreaSelect id="area-zone" label="Zone" list={zones.data?.data} pending={!!v.city_id && zones.isPending} disabled={!v.city_id} value={v.zone_id} onChange={(id) => onChange({ ...v, zone_id: id, area_id: null })} />
          <AreaSelect id="area-area" label="Area (optional)" list={areas.data?.data} pending={!!v.zone_id && areas.isPending} disabled={!v.zone_id} value={v.area_id} onChange={(id) => onChange({ ...v, area_id: id })} />
        </div>
      ) : (
        <AreaSelect id="area-area" label="Area" list={first.data?.data} pending={first.isPending} value={v.area_id} onChange={(id) => onChange({ city_id: null, zone_id: null, area_id: id })} />
      )}
      {error && (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      )}
      <Checkbox label={`Remember for ${addr.thana}, ${addr.district}`} checked={remember} onChange={(e) => onRemember(e.target.checked)} />
    </fieldset>
  );
}

function AreaSelect({ id, label, list, pending, disabled, value, onChange }: { id: string; label: string; list: CourierArea[] | undefined; pending: boolean; disabled?: boolean; value: string | null; onChange: (id: string | null) => void }) {
  return (
    <Select id={id} label={label} value={value ?? ''} disabled={disabled || pending} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{pending ? 'Loading…' : 'Choose'}</option>
      {(list ?? []).map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </Select>
  );
}
