import { isApiError } from '@storeplix/api-client';
import type { AddressInput, PickupLocation, PickupLocationInput, ShippingSettings, ShippingZoneInput } from '@storeplix/types';
import { Badge, Button, Checkbox, Dialog, Input, MoneyInput, Spinner, Toggle } from '@storeplix/ui';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, ChevronRight, MapPin, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { formatBdt } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage } from '../catalog/states';
import { addressProblems, type AddressErrors } from '../commerce/address';
import { AddressFields } from '../commerce/AddressFields';
import { daysRange, localPhone } from '../commerce/format';
import { useCommerceInvalidate, useGeoIndex, useShipping } from '../commerce/queries';
import { ZoneDrawer } from '../commerce/shipping';
import { areaSummary, DEFAULT_FREE_DELIVERY, defaultZones, settingsToInputs, shippingErrorMessage } from '../commerce/zones';
import { api } from '../lib/api';
import { normalizeBdPhone } from '../lib/phone';
import { FormAlert } from '../onboarding/AuthShell';
import { toast } from '../online-store/components/Toast';
import { SettingsCard } from './SettingsLayout';

// Figma Settings → Shipping & delivery 60:14364, Edit zone 66:17755. Contract §9: zones table (fallback row
// "Everywhere else", not deletable), zone drawer with the area picker, Free delivery card, Pickup addresses.
// Not built (§11): Default courier column/field, "You keep ৳ 10 per parcel", Weight-based charge, More options
// (COD/packaging/rounding/return charges), Courier accounts card, "Manage couriers".

export function ShippingPage() {
  const shipping = useShipping();
  const geo = useGeoIndex();
  if (shipping.isPending || geo.isPending)
    return (
      <div className="flex justify-center py-16">
        <Spinner label="Loading delivery settings" />
      </div>
    );
  if (shipping.isError) return <ErrorBlock error={shipping.error} onRetry={() => void shipping.refetch()} />;
  // Remount only when the saved settings actually change (a background refetch must not wipe an open editor).
  return <ShippingForm key={JSON.stringify(shipping.data)} data={shipping.data} />;
}

function ShippingForm({ data }: { data: ShippingSettings }) {
  const scope = useStoreScope();
  const geo = useGeoIndex();
  const invalidate = useCommerceInvalidate();
  const editable = scope.canManageSettings;
  const configured = data.configured;
  const [zones, setZones] = useState<ShippingZoneInput[]>(() => (configured ? settingsToInputs(data) : defaultZones(geo.index)));
  const [freeOn, setFreeOn] = useState(data.free_delivery_over_amount !== null);
  const [freeAmount, setFreeAmount] = useState<number | null>(data.free_delivery_over_amount ?? DEFAULT_FREE_DELIVERY);
  const [editing, setEditing] = useState<{ index: number | null } | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (next: { zones: ShippingZoneInput[]; free: number | null }) => api.shipping.save(scope.storeId!, { zones: next.zones, free_delivery_over_amount: next.free }),
    onSuccess: async () => {
      setError(null);
      setEditing(null);
      setRemoving(null);
      toast('Delivery charges saved.');
      await invalidate.shipping();
    },
    onError: (e) => setError(shippingErrorMessage(e)),
  });
  const freeValue = freeOn ? freeAmount : null;
  const freeInvalid = freeOn && (freeAmount === null || !Number.isFinite(freeAmount) || freeAmount < 100);
  const commit = (next: ShippingZoneInput[], free = freeValue) => {
    setZones(next);
    save.mutate({ zones: next, free });
  };

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-heading text-text-primary">Shipping & delivery</h2>
        <p className="text-body text-text-secondary">Delivery charges your customers see at checkout.</p>
      </div>
      {error && <FormAlert>{error}</FormAlert>}
      {!configured && (
        <div role="status" className="flex flex-col gap-3 rounded-card border border-brand-100 bg-brand-50 p-4 sm:flex-row sm:items-center">
          <p className="flex-1 text-body text-text-primary">We’ve filled in what most Dhaka sellers charge. Save to start taking orders with these charges.</p>
          {editable && (
            <Button loading={save.isPending} onClick={() => commit(zones)}>
              Save delivery charges
            </Button>
          )}
        </div>
      )}

      <SettingsCard title="Delivery zones" description="Customers get the charge of their area at checkout. It’s added to the order total and collected with cash on delivery.">
        {editable && (
          <Button size="sm" variant="secondary" className="self-start" leftIcon={<Plus aria-hidden className="size-4" />} onClick={() => setEditing({ index: null })} disabled={zones.length >= 30}>
            Add zone
          </Button>
        )}
        <div role="table" aria-label="Delivery zones" className="overflow-hidden rounded-lg border border-border-default">
          <div role="row" className="hidden gap-3 bg-surface-subtle px-4 py-2.5 text-caption font-medium text-text-muted uppercase md:flex">
            <span role="columnheader" className="flex-1">
              Zone
            </span>
            <span role="columnheader" className="w-20">
              Charge
            </span>
            <span role="columnheader" className="w-28">
              Delivery time
            </span>
            <span role="columnheader" className="w-14">
              Active
            </span>
            <span role="columnheader" className="w-20">
              <span className="sr-only">Actions</span>
            </span>
          </div>
          {zones.map((z, i) => (
            <div key={z.id ?? `new-${i}`} role="row" className="flex flex-wrap items-center gap-3 border-t border-border-default px-4 py-3 first:border-t-0 md:flex-nowrap">
              <span role="cell" className="flex min-w-0 flex-1 items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-brand-50 text-brand-600">
                  <MapPin aria-hidden className="size-4" />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-2 text-body font-semibold text-text-primary">
                    {z.name}
                    {z.kind === 'fallback' && <Badge>Everywhere else</Badge>}
                  </span>
                  <span className="truncate text-caption text-text-muted">{areaSummary(z, geo.index)}</span>
                </span>
              </span>
              <span role="cell" className="w-20 text-body font-semibold text-text-primary">
                {z.charge_amount === 0 ? 'Free' : formatBdt(z.charge_amount)}
              </span>
              <span role="cell" className="w-28 text-body text-text-secondary">
                {daysRange(z.min_days, z.max_days)}
              </span>
              <span role="cell" className="w-14">
                <Toggle
                  label={`${z.name} active`}
                  checked={z.kind === 'fallback' || z.is_active !== false}
                  disabled={!editable || z.kind === 'fallback' || save.isPending}
                  onChange={(on) => commit(zones.map((x, j) => (j === i ? { ...x, is_active: on } : x)))}
                />
              </span>
              <span role="cell" className="flex w-20 justify-end gap-1">
                {editable && z.kind !== 'fallback' && (
                  <button type="button" aria-label={`Delete ${z.name}`} onClick={() => setRemoving(i)} className="flex size-8 items-center justify-center rounded-md text-text-muted hover:text-danger">
                    <Trash2 aria-hidden className="size-4" />
                  </button>
                )}
                {editable && (
                  <button type="button" aria-label={`Edit ${z.name}`} onClick={() => setEditing({ index: i })} className="flex size-8 items-center justify-center rounded-md border border-border-default bg-surface-card">
                    <ChevronRight aria-hidden className="size-4" />
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
        <p className="flex items-center gap-1.5 text-caption text-text-muted">
          <AlertTriangle aria-hidden className="size-3.5" /> Areas not covered by any zone fall back to {zones.find((z) => z.kind === 'fallback')?.name ?? 'Outside Dhaka'}, so no order is ever blocked at checkout.
        </p>
      </SettingsCard>

      <SettingsCard title="Free delivery" description="Nudge bigger orders. Shown on the cart as a progress bar.">
        <div className="flex items-center justify-between gap-4">
          <span className="flex flex-col">
            <span className="text-body font-medium text-text-primary">Offer free delivery above an order value</span>
            <span className="text-caption text-text-muted">Delivery becomes ৳ 0 in every zone when the cart, after discounts, reaches this amount.</span>
          </span>
          <Toggle label="Offer free delivery" checked={freeOn} disabled={!editable} onChange={setFreeOn} />
        </div>
        {freeOn && (
          <>
            <MoneyInput
              id="free-amount"
              label="Free delivery when cart is above"
              value={freeAmount}
              onChange={setFreeAmount}
              disabled={!editable}
              error={freeInvalid ? 'Enter an amount like 3000.' : undefined}
              containerClassName="sm:max-w-xs"
            />
            {!freeInvalid && freeAmount !== null && (
              <div className="flex flex-col gap-2 rounded-lg bg-brand-50 p-3">
                <span className="text-caption font-medium text-brand-600">Customer sees at checkout</span>
                <span className="text-body text-text-primary">Add {formatBdt(Math.min(45_000, freeAmount))} more for free delivery</span>
                <span className="h-1.5 rounded-full bg-brand-100">
                  <span className="block h-full w-3/4 rounded-full bg-brand-600" />
                </span>
              </div>
            )}
          </>
        )}
        {editable && (
          <Button className="self-end" variant="secondary" disabled={freeInvalid} loading={save.isPending && !editing} onClick={() => commit(zones, freeValue)}>
            Save free delivery
          </Button>
        )}
      </SettingsCard>

      <PickupCard pickups={data.pickup_locations} editable={editable} />

      {editing && (
        <ZoneDrawer
          open
          zone={editing.index === null ? null : (zones[editing.index] ?? null)}
          others={{ zones, index: editing.index }}
          saving={save.isPending}
          onClose={() => setEditing(null)}
          onSave={(z) => {
            const next = editing.index === null ? [...zones.filter((x) => x.kind !== 'fallback'), z, ...zones.filter((x) => x.kind === 'fallback')] : zones.map((x, j) => (j === editing.index ? z : x));
            commit(next);
          }}
        />
      )}
      <Dialog
        open={removing !== null}
        tone="danger"
        title={`Delete ${removing !== null ? zones[removing]?.name : ''}?`}
        description="Its areas fall back to your “everywhere else” zone."
        confirmLabel="Delete zone"
        loading={save.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing !== null && commit(zones.filter((_, j) => j !== removing))}
      />
    </>
  );
}

function PickupCard({ pickups, editable }: { pickups: PickupLocation[]; editable: boolean }) {
  const scope = useStoreScope();
  const invalidate = useCommerceInvalidate();
  const [editing, setEditing] = useState<PickupLocation | 'new' | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.shipping.deletePickup(scope.storeId!, id),
    onSuccess: () => invalidate.shipping(),
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  const makeDefault = useMutation({
    mutationFn: (id: string) => api.shipping.updatePickup(scope.storeId!, id, { is_default: true }),
    onSuccess: () => invalidate.shipping(),
    onError: (e) => toast(errorMessage(e), 'error'),
  });
  return (
    <SettingsCard title="Pickup addresses" description="Where couriers collect parcels.">
      {editable && (
        <Button size="sm" variant="secondary" className="self-start" leftIcon={<Plus aria-hidden className="size-4" />} disabled={pickups.length >= 10} onClick={() => setEditing('new')}>
          Add address
        </Button>
      )}
      {pickups.length === 0 ? (
        <p className="text-body text-text-muted">No pickup address yet.</p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {pickups.map((p) => (
            <li key={p.id} className={p.is_default ? 'flex flex-col gap-1.5 rounded-lg border border-brand-100 bg-brand-50 p-4' : 'flex flex-col gap-1.5 rounded-lg border border-border-default p-4'}>
              <div className="flex items-center gap-2">
                <MapPin aria-hidden className="size-4 text-brand-600" />
                <span className="flex-1 truncate text-body font-semibold text-text-primary">{p.name}</span>
                {p.is_default && <Badge tone="brand">Default</Badge>}
              </div>
              <span className="text-body text-text-secondary">{[p.address_line, p.thana, p.district].filter(Boolean).join(', ')}</span>
              {(p.contact_name || p.contact_phone) && <span className="text-caption text-text-muted">{[p.contact_name, localPhone(p.contact_phone)].filter(Boolean).join(' · ')}</span>}
              {editable && (
                <div className="flex gap-3 pt-1 text-caption font-medium">
                  <button type="button" className="text-brand-600" onClick={() => setEditing(p)}>
                    Edit
                  </button>
                  {!p.is_default && (
                    <button type="button" className="text-brand-600" onClick={() => makeDefault.mutate(p.id)}>
                      Make default
                    </button>
                  )}
                  <button type="button" className="text-danger" onClick={() => remove.mutate(p.id)}>
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <PickupDialog pickup={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </SettingsCard>
  );
}

export function PickupDialog({ pickup, onClose }: { pickup: PickupLocation | null; onClose: () => void }) {
  const scope = useStoreScope();
  const invalidate = useCommerceInvalidate();
  const [name, setName] = useState(pickup?.name ?? 'Main pickup');
  const [contactName, setContactName] = useState(pickup?.contact_name ?? '');
  const [phone, setPhone] = useState(pickup?.contact_phone ? pickup.contact_phone.slice(2) : '');
  const [address, setAddress] = useState<AddressInput>({ district_code: pickup?.district_code ?? '', thana_code: pickup?.thana_code ?? '', address_line: pickup?.address_line ?? '' });
  const [isDefault, setIsDefault] = useState(pickup?.is_default ?? false);
  const [errors, setErrors] = useState<AddressErrors & Record<string, string | undefined>>({});
  const save = useMutation({
    mutationFn: () => {
      const input: PickupLocationInput = {
        name: name.trim(),
        contact_name: contactName.trim() || null,
        contact_phone: phone.trim() ? normalizeBdPhone(phone) : null,
        district_code: address.district_code,
        thana_code: address.thana_code,
        address_line: address.address_line.trim(),
        is_default: isDefault || undefined,
      };
      return pickup ? api.shipping.updatePickup(scope.storeId!, pickup.id, input) : api.shipping.createPickup(scope.storeId!, input);
    },
    onSuccess: async () => {
      toast('Pickup address saved.');
      onClose();
      await invalidate.shipping();
    },
    onError: (e) => {
      if (isApiError(e) && e.details) setErrors(Object.fromEntries(Object.entries(e.details).map(([k, m]) => [k, m[0]])));
      else toast(errorMessage(e), 'error');
    },
  });
  const submit = () => {
    const e: Record<string, string | undefined> = { ...addressProblems(address) };
    if (!name.trim()) e.name = 'Give this address a name.';
    if (phone.trim() && !normalizeBdPhone(phone)) e.contact_phone = 'Enter a Bangladeshi mobile number (01XXXXXXXXX).';
    const clean = Object.fromEntries(Object.entries(e).filter(([, v]) => v));
    setErrors(clean);
    if (!Object.keys(clean).length) save.mutate();
  };
  return (
    <Dialog open title={pickup ? 'Edit pickup address' : 'Add pickup address'} confirmLabel="Save address" size="md" loading={save.isPending} onCancel={onClose} onConfirm={submit}>
      <div className="flex flex-col gap-4">
        <Input id="pickup-name" label="Name" placeholder="Main warehouse · Mirpur" maxLength={60} value={name} error={errors.name} onChange={(e) => setName(e.target.value)} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input id="pickup-contact" label="Contact person (optional)" maxLength={80} value={contactName} onChange={(e) => setContactName(e.target.value)} />
          <Input id="pickup-phone" label="Contact phone (optional)" inputMode="tel" value={phone} error={errors.contact_phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <AddressFields value={address} onChange={setAddress} errors={errors} extra={false} idPrefix="pickup" />
        <Checkbox label="Use as the default pickup address" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
      </div>
    </Dialog>
  );
}

export default ShippingPage;
