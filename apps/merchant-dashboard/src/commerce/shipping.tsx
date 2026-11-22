import type { ShippingZoneInput } from '@storeplix/types';
import { AreaPicker, Button, Drawer, Input, MoneyInput, type AreaValue } from '@storeplix/ui';
import { useState } from 'react';
import { useGeoIndex } from './queries';
import { takenAreas } from './zones';

// Zone editor drawer shared by Settings → Shipping & delivery 60:14364 and Onboarding 06 50:604.

/** Edit zone 66:17755: name, areas picker, charge, delivery time (min–max days). */
export function ZoneDrawer({
  open,
  zone,
  others,
  onClose,
  onSave,
  saving,
}: {
  open: boolean;
  zone: ShippingZoneInput | null;
  /** All zones, with `index` of the one being edited (null for a new zone). */
  others: { zones: ShippingZoneInput[]; index: number | null };
  onClose: () => void;
  onSave: (zone: ShippingZoneInput) => void;
  saving?: boolean;
}) {
  const geo = useGeoIndex();
  const isFallback = zone?.kind === 'fallback';
  const [name, setName] = useState(zone?.name ?? '');
  const [charge, setCharge] = useState<number | null>(zone?.charge_amount ?? null);
  const [minDays, setMinDays] = useState(String(zone?.min_days ?? 1));
  const [maxDays, setMaxDays] = useState(String(zone?.max_days ?? 3));
  const [areas, setAreas] = useState<AreaValue[]>((zone?.areas ?? []).map((a) => ({ district_code: a.district_code, thana_code: a.thana_code ?? null })));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = () => {
    const e: Record<string, string> = {};
    if (!name.trim() || name.trim().length > 60) e.name = 'Give the zone a name (up to 60 characters).';
    if (charge === null || !Number.isFinite(charge) || charge < 0 || charge > 1_000_000) e.charge = 'Enter a charge from ৳ 0 to ৳ 10,000.';
    const min = Number(minDays);
    const max = Number(maxDays);
    if (!/^\d{1,2}$/.test(minDays) || min > 30) e.days = 'Use whole days from 0 to 30.';
    else if (!/^\d{1,2}$/.test(maxDays) || max > 30 || max < min) e.days = 'The longest time must be at least the shortest, up to 30 days.';
    if (!isFallback && areas.length === 0) e.areas = 'Pick at least one district or thana.';
    if (!isFallback && areas.length > 500) e.areas = 'A zone can have up to 500 areas.';
    setErrors(e);
    if (Object.keys(e).length) return;
    onSave({
      ...(zone?.id ? { id: zone.id } : {}),
      kind: zone?.kind ?? 'custom',
      name: name.trim(),
      charge_amount: charge!,
      min_days: min,
      max_days: max,
      is_active: zone?.is_active ?? true,
      areas: isFallback ? [] : areas.map((a) => ({ district_code: a.district_code, thana_code: a.thana_code })),
    });
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={zone ? `Edit ${zone.name}` : 'Add a zone'}
      description={isFallback ? 'Catches every address no other zone covers, so no order is ever blocked.' : 'Customers in these areas pay this charge.'}
      width={480}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={saving} onClick={submit}>
            Save zone
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Input id="zone-name" label="Zone name" value={name} maxLength={60} error={errors.name} onChange={(e) => setName(e.target.value)} />
        <MoneyInput id="zone-charge" label="Delivery charge" value={charge} onChange={setCharge} error={errors.charge} />
        <div className="grid grid-cols-2 gap-3">
          <Input id="zone-min" label="Fastest (days)" inputMode="numeric" value={minDays} onChange={(e) => setMinDays(e.target.value.trim())} />
          <Input id="zone-max" label="Slowest (days)" inputMode="numeric" value={maxDays} onChange={(e) => setMaxDays(e.target.value.trim())} />
        </div>
        {errors.days && <p className="-mt-2 text-caption text-danger">{errors.days}</p>}
        {!isFallback && (
          <div className="flex flex-col gap-1.5">
            <span className="text-body font-medium text-text-primary">Areas</span>
            {geo.isPending ? (
              <span className="text-caption text-text-muted">Loading districts…</span>
            ) : (
              <AreaPicker districts={geo.index.districts} value={areas} onChange={setAreas} taken={takenAreas(others.zones, others.index)} label="Zone areas" />
            )}
            <span className="text-caption text-text-muted">A thana in another zone wins over its whole district.</span>
            {errors.areas && <p className="text-caption text-danger">{errors.areas}</p>}
          </div>
        )}
      </div>
    </Drawer>
  );
}
