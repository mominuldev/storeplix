import { isApiError } from '@storeplix/api-client';
import type { ShippingSettings, ShippingZone, ShippingZoneInput } from '@storeplix/types';
import { areaKey } from '@storeplix/ui';
import type { GeoIndex } from './queries';

// Shipping zone helpers shared by Settings → Shipping & delivery 60:14364 and Onboarding 06 50:604 (P5-7, P5-8).

export const INSIDE_DHAKA = { name: 'Inside Dhaka', charge_amount: 7_000, min_days: 1, max_days: 2 };

export const OUTSIDE_DHAKA = { name: 'Outside Dhaka', charge_amount: 13_000, min_days: 2, max_days: 4 };

export const DEFAULT_FREE_DELIVERY = 300_000;

/** P5-8 defaults: Inside Dhaka = Dhaka city (metropolitan) thanas; fallback Outside Dhaka. */
export function defaultZones(index: GeoIndex): ShippingZoneInput[] {
  const dhaka = index.districts.find((d) => d.code === 'dhaka');
  const city = dhaka?.thanas.filter((t) => t.is_city) ?? [];
  return [
    { kind: 'custom', ...INSIDE_DHAKA, is_active: true, areas: city.map((t) => ({ district_code: 'dhaka', thana_code: t.code })) },
    { kind: 'fallback', ...OUTSIDE_DHAKA, is_active: true, areas: [] },
  ];
}

export function zoneToInput(z: ShippingZone): ShippingZoneInput {
  return {
    id: z.id,
    name: z.name,
    kind: z.kind,
    charge_amount: z.charge_amount,
    min_days: z.min_days,
    max_days: z.max_days,
    is_active: z.kind === 'fallback' ? true : z.is_active,
    areas: z.kind === 'fallback' ? [] : z.areas.map((a) => ({ district_code: a.district_code, thana_code: a.thana_code || null })),
  };
}

export function settingsToInputs(s: ShippingSettings | undefined): ShippingZoneInput[] {
  return [...(s?.zones ?? [])].sort((a, b) => (a.kind === 'fallback' ? 1 : 0) - (b.kind === 'fallback' ? 1 : 0) || a.position - b.position).map(zoneToInput);
}

/** areaKey → zone name for every area of the other zones (AreaPicker `taken`). */
export function takenAreas(zones: ShippingZoneInput[], exceptIndex: number | null): Record<string, string> {
  const out: Record<string, string> = {};
  zones.forEach((z, i) => {
    if (i === exceptIndex || z.kind === 'fallback') return;
    for (const a of z.areas ?? []) out[areaKey(a)] = z.name;
  });
  return out;
}

/** "Dhaka city · 41 thanas" style summary for a zone input. */
export function areaSummary(z: ShippingZoneInput, index: GeoIndex): string {
  if (z.kind === 'fallback') return 'Every area not in another zone';
  const areas = z.areas ?? [];
  if (!areas.length) return 'No areas yet';
  const whole = areas.filter((a) => !a.thana_code).map((a) => index.districtName(a.district_code));
  const thanas = areas.filter((a) => a.thana_code);
  const byDistrict = new Map<string, number>();
  for (const t of thanas) byDistrict.set(t.district_code, (byDistrict.get(t.district_code) ?? 0) + 1);
  const parts = [...whole, ...[...byDistrict].map(([d, n]) => `${index.districtName(d)} · ${n} ${n === 1 ? 'thana' : 'thanas'}`)];
  return parts.length > 3 ? `${parts.slice(0, 3).join(', ')} +${parts.length - 3}` : parts.join(', ');
}

/** Maps a 422/409 from PUT /shipping to a readable message. */
export function shippingErrorMessage(e: unknown): string {
  if (isApiError(e)) {
    const first = Object.values(e.fieldErrors ?? {})[0]?.[0];
    return first ?? e.message;
  }
  return 'We couldn’t save your delivery charges.';
}
