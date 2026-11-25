import { isApiError } from '@storeplix/api-client';
import {
  LOCATION_ADDRESS_MAX,
  LOCATION_IN_USE_REASONS,
  LOCATION_NAME_MAX,
  type FeatureAccess,
  type InventoryItem,
  type Location,
  type LocationInput,
  type LocationInUseReason,
  type UpdateLocationInput,
} from '@storeplix/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { keys, useStoreScope } from '../catalog/scope';
import { errorMessage } from '../catalog/states';
import { api } from '../lib/api';
import { handlePlanLimit } from '../plan/Banners';

// PHASE-8-8C part A (§10.1–§10.3): locations query, helpers and copy shared by Inventory, the Warehouses tab, the product
// editor and purchasing. Every location element is hidden unless the store has more than one non-archived location
// (`multi`), so a one-location store looks exactly as before (except the Warehouses tab).

type Scope = { tenantId: string | null; storeId: string | null };

export const locationKeys = {
  all: (s: Scope) => [s.tenantId, s.storeId, 'locations'] as const,
};

/** Every location (active and archived), default first. An error (e.g. an older API) reads as "one location". */
export function useLocations() {
  const s = useStoreScope();
  return useQuery({
    queryKey: locationKeys.all(s),
    queryFn: () => api.locations.list(s.storeId!),
    enabled: !!s.storeId,
    retry: false,
    staleTime: 30_000,
  });
}

/** Active locations, the default (online) one, and whether location UI shows at all (> 1 active location). */
export function useStockLocations() {
  const q = useLocations();
  const active = activeLocations(q.data);
  return { query: q, active, multi: active.length > 1, defaultLocation: active.find((l) => l.is_default) ?? active[0] ?? null };
}

export const activeLocations = (list: readonly Location[] | undefined): Location[] => (list ?? []).filter((l) => !l.archived_at);

/** P88C-13: `multi_warehouse` missing (Free / Starter). Unknown features → not locked (the API still enforces it). */
export function multiWarehouseLocked(features: FeatureAccess | undefined): boolean {
  return !!features && features.features.multi_warehouse === false;
}

/** On hand / held / available of an inventory row at one location (missing row = 0). */
export function stockAt(item: Pick<InventoryItem, 'locations' | 'location_id' | 'on_hand' | 'committed' | 'available'>, locationId: string | null | undefined) {
  if (!locationId) return { on_hand: item.on_hand, committed: item.committed, available: item.available };
  const row = item.locations?.find((l) => l.id === locationId);
  if (row) return { on_hand: row.on_hand, committed: row.committed, available: row.available };
  if (item.location_id === locationId) return { on_hand: item.on_hand, committed: item.committed, available: item.available };
  return { on_hand: 0, committed: 0, available: 0 };
}

/** P88C-17 reasons (409 `location_in_use`, `details.reasons`) as sentences. */
export const inUseReasonText: Record<LocationInUseReason, string> = {
  is_default: 'Online orders ship from here. Make another location the default first.',
  has_stock: 'It still has stock. Adjust or move it to 0 first.',
  has_committed: 'Some of its stock is held for open orders.',
  open_purchase_orders: 'Open purchase orders will be received here. Change “Receive at” or close them first.',
  open_transfers: 'A stock transfer to or from here isn’t finished yet.',
  open_counts: 'A stock count is in progress here.',
};

export function inUseReasons(e: unknown): LocationInUseReason[] | null {
  if (!isApiError(e) || e.code !== 'location_in_use') return null;
  const raw = (e.details as Record<string, unknown> | undefined)?.reasons;
  const list = Array.isArray(raw) ? raw.filter((r): r is LocationInUseReason => typeof r === 'string' && (LOCATION_IN_USE_REASONS as readonly string[]).includes(r)) : [];
  return list;
}

/** Location write errors → copy. A 402 opens the plan dialog and returns null. */
export function locationError(e: unknown, fallback: string): string | null {
  if (handlePlanLimit(e)) return null;
  if (isApiError(e)) {
    if (e.code === 'location_name_taken') return 'You already have a location with this name.';
    if (e.code === 'location_archived') return 'This location is archived. Restore it first.';
    if (e.code === 'location_in_use') return 'This location is still in use.';
    if (e.status === 422) return e.fieldErrors ? (Object.values(e.fieldErrors)[0]?.[0] ?? e.message) : e.message || fallback;
  }
  return errorMessage(e, fallback);
}

/** Every location write changes the list, inventory numbers, movements, products (online stock) and the dashboard. */
export function useLocationMutations() {
  const s = useStoreScope();
  const qc = useQueryClient();
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: locationKeys.all(s) }),
      qc.invalidateQueries({ queryKey: keys.inventory(s) }),
      qc.invalidateQueries({ queryKey: keys.movements(s) }),
      qc.invalidateQueries({ queryKey: keys.products(s) }),
      qc.invalidateQueries({ queryKey: [s.tenantId, s.storeId, 'product'] }),
      qc.invalidateQueries({ queryKey: keys.dashboard(s) }),
    ]);
  const id = () => s.storeId!;
  return {
    create: useMutation({ mutationFn: (input: LocationInput) => api.locations.create(id(), input), onSuccess: refresh }),
    update: useMutation({ mutationFn: (v: { id: string; input: UpdateLocationInput }) => api.locations.update(id(), v.id, v.input), onSuccess: refresh }),
    archive: useMutation({ mutationFn: (locationId: string) => api.locations.archive(id(), locationId), onSuccess: refresh }),
    unarchive: useMutation({ mutationFn: (locationId: string) => api.locations.unarchive(id(), locationId), onSuccess: refresh }),
    makeDefault: useMutation({ mutationFn: (locationId: string) => api.locations.makeDefault(id(), locationId), onSuccess: refresh }),
  };
}

// ---------- Add / edit form (RHF + Zod) ----------

export const locationFormSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter a name.').max(LOCATION_NAME_MAX, `Keep the name under ${LOCATION_NAME_MAX} characters.`),
    type: z.enum(['warehouse', 'shop']),
    use_pickup: z.boolean(),
    pickup_location_id: z.string(),
    address: z.string().trim().max(LOCATION_ADDRESS_MAX, `Keep the address under ${LOCATION_ADDRESS_MAX} characters.`),
  })
  .superRefine((v, ctx) => {
    if (v.use_pickup && !v.pickup_location_id) ctx.addIssue({ code: 'custom', path: ['pickup_location_id'], message: 'Choose a pickup address.' });
  });
export type LocationFormValues = z.input<typeof locationFormSchema>;

export const locationValuesOf = (l: Location | null): LocationFormValues => ({
  name: l?.name ?? '',
  type: l?.type ?? 'warehouse',
  use_pickup: !!l?.pickup_location,
  pickup_location_id: l?.pickup_location?.id ?? '',
  address: l?.address ?? '',
});

export function locationInputOf(v: LocationFormValues): LocationInput {
  return {
    name: v.name.trim(),
    type: v.type,
    address: v.address.trim() || null,
    pickup_location_id: v.use_pickup ? v.pickup_location_id || null : null,
  };
}

/** "Receive at Main warehouse" text (36:6615 / 36:7118), only when the store has > 1 active location. */
export const receiveAtText = (multi: boolean, location: { name: string } | null | undefined) => (multi && location ? location.name : null);
