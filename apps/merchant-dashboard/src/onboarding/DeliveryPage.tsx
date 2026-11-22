import type { AddressInput, ShippingZoneInput } from '@storeplix/types';
import { Badge, Button, cn, MoneyInput, Toggle } from '@storeplix/ui';
import { useMutation } from '@tanstack/react-query';
import { House, Plus, Truck } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { formatBdt } from '../catalog/format';
import { useProducts } from '../catalog/queries';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock } from '../catalog/states';
import { addressProblems, type AddressErrors } from '../commerce/address';
import { AddressFields } from '../commerce/AddressFields';
import { daysRange } from '../commerce/format';
import { useCommerceInvalidate, useGeoIndex, useShipping } from '../commerce/queries';
import { ZoneDrawer } from '../commerce/shipping';
import { DEFAULT_FREE_DELIVERY, defaultZones, settingsToInputs, shippingErrorMessage } from '../commerce/zones';
import { api } from '../lib/api';
import { LoadingState } from '../online-store/components/Shell';
import { FormAlert } from './AuthShell';
import { OnboardingCard, OnboardingFrame } from './OnboardingFrame';

// Figma Merchant Onboarding · 06 Delivery & charges 50:604 (connect card 45:8086). Contract §9: pickup address →
// default pickup location; Inside / Outside Dhaka cards prefilled ৳ 70 / ৳ 130; free delivery toggle; "+ Add a zone";
// courier cards disabled ("Coming soon", 5b); checkout preview. Continue → PUT /shipping + pickup → 07.

export function DeliveryPage() {
  const shipping = useShipping();
  const geo = useGeoIndex();
  const { store } = useStoreScope();
  if (!store || shipping.isPending || geo.isPending) return <LoadingState label="Loading delivery settings" />;
  if (shipping.isError) return <ErrorBlock error={shipping.error} onRetry={() => void shipping.refetch()} />;
  return <DeliveryForm />;
}

const COURIERS = [
  { name: 'Steadfast Courier', hint: 'Nationwide · COD paid to you in 1–2 days' },
  { name: 'Pathao Courier', hint: 'Fast inside Dhaka · same-day delivery available' },
  { name: 'RedX', hint: '64 districts · free pickup from your door' },
];

function DeliveryForm() {
  const navigate = useNavigate();
  const scope = useStoreScope();
  const shipping = useShipping().data!;
  const geo = useGeoIndex();
  const invalidate = useCommerceInvalidate();
  const editable = scope.canManageSettings;
  const firstProduct = useProducts({ per_page: 1, status: ['active'] }).data?.data[0];

  const [zones, setZones] = useState<ShippingZoneInput[]>(() => (shipping.configured ? settingsToInputs(shipping) : defaultZones(geo.index)));
  const insideIndex = Math.max(0, zones.findIndex((z) => z.kind === 'custom'));
  const fallbackIndex = zones.findIndex((z) => z.kind === 'fallback');
  const [freeOn, setFreeOn] = useState(shipping.free_delivery_over_amount !== null);
  const [freeAmount, setFreeAmount] = useState<number | null>(shipping.free_delivery_over_amount ?? DEFAULT_FREE_DELIVERY);
  const pickup = shipping.pickup_locations.find((p) => p.is_default) ?? shipping.pickup_locations[0] ?? null;
  const [address, setAddress] = useState<AddressInput>({ district_code: pickup?.district_code ?? '', thana_code: pickup?.thana_code ?? '', address_line: pickup?.address_line ?? '' });
  const [addrErrors, setAddrErrors] = useState<AddressErrors>({});
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);

  const setCharge = (i: number, v: number | null) => setZones((zs) => zs.map((z, j) => (j === i ? { ...z, charge_amount: v ?? Number.NaN } : z)));

  const save = useMutation({
    mutationFn: async () => {
      await api.shipping.save(scope.storeId!, { zones, free_delivery_over_amount: freeOn ? freeAmount : null });
      const hasAddress = address.district_code || address.thana_code || address.address_line.trim();
      if (hasAddress) {
        const input = { name: pickup?.name ?? 'Main pickup', district_code: address.district_code, thana_code: address.thana_code, address_line: address.address_line.trim(), is_default: true };
        if (pickup) await api.shipping.updatePickup(scope.storeId!, pickup.id, input);
        else await api.shipping.createPickup(scope.storeId!, input);
      }
    },
    onSuccess: async () => {
      await invalidate.shipping();
      navigate('/onboarding/payments');
    },
    onError: (e) => setError(shippingErrorMessage(e)),
  });

  const submit = () => {
    if (!editable) return navigate('/onboarding/payments');
    const hasAddress = address.district_code || address.thana_code || address.address_line.trim();
    const problems = hasAddress ? addressProblems(address) : {};
    setAddrErrors(problems);
    const badCharge = zones.some((z) => !Number.isFinite(z.charge_amount) || z.charge_amount < 0 || z.charge_amount > 1_000_000);
    const badFree = freeOn && (freeAmount === null || !Number.isFinite(freeAmount) || freeAmount < 100);
    if (Object.keys(problems).length || badCharge || badFree) return setError(badCharge ? 'Enter a delivery charge from ৳ 0 to ৳ 10,000.' : badFree ? 'Enter a free-delivery amount like 3000.' : 'Check the pickup address.');
    setError(null);
    save.mutate();
  };

  const productName = firstProduct?.name ?? 'Jamdani Three-Piece';
  const productPrice = firstProduct?.price_amount ?? 345_000;
  const previewZones = [...zones.filter((z) => z.kind !== 'fallback' && z.is_active !== false), ...zones.filter((z) => z.kind === 'fallback')];
  const chosen = previewZones[Math.min(selected, previewZones.length - 1)];
  const chosenCharge = chosen && Number.isFinite(chosen.charge_amount) ? (freeOn && freeAmount !== null && productPrice >= freeAmount ? 0 : chosen.charge_amount) : 0;

  return (
    <OnboardingFrame
      step={6}
      shopName={scope.store!.name}
      title="Delivery & charges"
      subtitle="Tell us where to pick up parcels and what to charge. Customers see this at checkout."
      bangla="ডেলিভারি চার্জ পরে যেকোনো সময় বদলাতে পারবেন"
      back="/onboarding/products"
      footer={
        <Button loading={save.isPending} onClick={submit}>
          Continue
        </Button>
      }
      aside={
        <>
          <span className="flex items-center gap-2 text-caption font-medium text-brand-600">
            <span className="size-2 rounded-full bg-success" /> Checkout preview
          </span>
          <section aria-label="Checkout preview" className="flex flex-col gap-4 rounded-card bg-surface-card p-4 shadow-elevation-1">
            <span className="text-body-lg font-semibold text-text-primary">Checkout</span>
            <div className="flex items-center justify-between text-body">
              <span className="truncate font-medium text-text-primary">{productName}</span>
              <span className="font-semibold">{formatBdt(productPrice)}</span>
            </div>
            <div role="radiogroup" aria-label="Delivery area" className="flex flex-col gap-2 border-t border-border-default pt-3">
              {previewZones.map((z, i) => (
                <button
                  key={`${z.name}-${i}`}
                  type="button"
                  role="radio"
                  aria-checked={chosen === z}
                  onClick={() => setSelected(i)}
                  className={cn('flex items-center justify-between rounded-lg border px-3 py-2.5 text-left', chosen === z ? 'border-brand-600 bg-brand-50' : 'border-border-default')}
                >
                  <span className="flex flex-col">
                    <span className="text-body font-medium text-text-primary">{z.name}</span>
                    <span className="text-caption text-text-muted">{daysRange(z.min_days, z.max_days)}</span>
                  </span>
                  <span className="text-body font-semibold">{Number.isFinite(z.charge_amount) ? formatBdt(z.charge_amount) : '—'}</span>
                </button>
              ))}
            </div>
            <dl className="flex flex-col gap-1.5 border-t border-border-default pt-3 text-body">
              <div className="flex justify-between text-text-secondary">
                <dt>Subtotal</dt>
                <dd>{formatBdt(productPrice)}</dd>
              </div>
              <div className="flex justify-between text-text-secondary">
                <dt>Delivery</dt>
                <dd>{chosenCharge === 0 ? 'Free' : formatBdt(chosenCharge)}</dd>
              </div>
              <div className="flex justify-between font-semibold text-text-primary">
                <dt>Total</dt>
                <dd>{formatBdt(productPrice + chosenCharge)}</dd>
              </div>
            </dl>
          </section>
        </>
      }
    >
      {error && <FormAlert>{error}</FormAlert>}
      {!editable && <p className="rounded-md bg-surface-subtle px-3 py-2 text-body text-text-secondary">Only owners and managers can change delivery charges.</p>}

      <OnboardingCard title="Pickup address" description="Couriers will collect parcels from here.">
        <AddressFields value={address} onChange={setAddress} errors={addrErrors} extra={false} idPrefix="pickup" disabled={!editable} />
      </OnboardingCard>

      <OnboardingCard title="Delivery charges" description="Pre-filled with what most Dhaka sellers charge. Tap a price to edit.">
        {[insideIndex, fallbackIndex]
          .filter((i, k, arr) => i >= 0 && arr.indexOf(i) === k)
          .map((i) => {
            const z = zones[i]!;
            const fallback = z.kind === 'fallback';
            return (
              <div key={i} className="flex items-center gap-3 rounded-lg border border-border-default p-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-brand-50 text-brand-600">{fallback ? <Truck aria-hidden className="size-4" /> : <House aria-hidden className="size-4" />}</span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-body font-semibold text-text-primary">{z.name}</span>
                  <span className="text-caption text-text-muted">
                    {fallback ? 'All other districts' : 'Dhaka city'} · usually {daysRange(z.min_days, z.max_days)}
                  </span>
                </span>
                <MoneyInput
                  aria-label={`${z.name} charge`}
                  value={Number.isFinite(z.charge_amount) ? z.charge_amount : null}
                  onChange={(v) => setCharge(i, v)}
                  disabled={!editable}
                  containerClassName="w-28"
                />
              </div>
            );
          })}
        {zones
          .map((z, i) => ({ z, i }))
          .filter(({ z, i }) => z.kind === 'custom' && i !== insideIndex)
          .map(({ z }) => (
            <div key={z.name} className="flex items-center justify-between rounded-lg bg-surface-subtle px-3 py-2 text-body">
              <span>{z.name}</span>
              <span className="font-semibold">{formatBdt(z.charge_amount)}</span>
            </div>
          ))}
        <div className="flex items-center justify-between gap-4">
          <span className="flex flex-col">
            <span className="text-body font-medium text-text-primary">Free delivery on orders over {formatBdt(freeAmount ?? DEFAULT_FREE_DELIVERY)}</span>
            <span className="text-caption text-text-muted">A popular nudge for bigger orders</span>
          </span>
          <Toggle label="Free delivery on big orders" checked={freeOn} disabled={!editable} onChange={setFreeOn} />
        </div>
        {freeOn && <MoneyInput id="onb-free" label="Free delivery when the cart is above" value={freeAmount} onChange={setFreeAmount} disabled={!editable} containerClassName="sm:max-w-xs" />}
        {editable && (
          <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-1 self-start text-body font-medium text-brand-600">
            <Plus aria-hidden className="size-4" /> Add a zone (e.g. Savar, Gazipur)
          </button>
        )}
      </OnboardingCard>

      <OnboardingCard title="Connect a courier" description="Book pickups and track parcels without leaving Store Plix. Uses your own merchant account.">
        <ul className="flex flex-col gap-3">
          {COURIERS.map((c) => (
            <li key={c.name} className="flex items-center gap-3 rounded-lg border border-border-default p-3 opacity-70">
              <span className="flex size-10 items-center justify-center rounded-control bg-surface-subtle text-text-secondary">
                <Truck aria-hidden className="size-5" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-body font-semibold text-text-primary">{c.name}</span>
                <span className="text-caption text-text-muted">{c.hint}</span>
              </span>
              <Badge>Coming soon</Badge>
              <Button size="sm" variant="secondary" disabled aria-label={`Connect ${c.name} (coming soon)`}>
                Connect
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between gap-3 text-caption text-text-muted">
          <span>No courier account yet? You can still take orders and deliver yourself.</span>
          <button type="button" className="shrink-0 font-medium text-brand-600" onClick={submit}>
            Connect later
          </button>
        </div>
      </OnboardingCard>

      {adding && (
        <ZoneDrawer
          open
          zone={null}
          others={{ zones, index: null }}
          onClose={() => setAdding(false)}
          onSave={(z) => {
            setZones((zs) => [...zs.filter((x) => x.kind !== 'fallback'), z, ...zs.filter((x) => x.kind === 'fallback')]);
            setAdding(false);
          }}
        />
      )}
    </OnboardingFrame>
  );
}

export default DeliveryPage;
