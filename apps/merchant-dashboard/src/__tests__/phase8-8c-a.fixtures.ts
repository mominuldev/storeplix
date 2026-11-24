import type { Location } from '@storeplix/types';
import { jsonResponse } from '../test/utils';
import { inventoryItem } from './catalog.fixtures';
import { features } from './phase7.fixtures';

// PHASE-8-8C part A shapes (§4, §5.4): locations "Main warehouse · Mirpur" (default) and "Dhanmondi shop" (Figma
// 11:589 sample names).

export function location(o: Partial<Location> = {}): Location {
  return {
    id: 'LOC1',
    name: 'Main warehouse',
    type: 'warehouse',
    address: 'Mirpur 10, Dhaka',
    is_default: true,
    position: 0,
    archived_at: null,
    pickup_location: null,
    units_on_hand: 1284,
    stock_value_amount: 39200000,
    variants_count: 212,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-11-20T00:00:00Z',
    ...o,
  };
}

export const mainWarehouse = location();
export const dhanmondi = location({ id: 'LOC2', name: 'Dhanmondi shop', type: 'shop', address: 'Road 7, Dhanmondi', is_default: false, position: 1, units_on_hand: 140, stock_value_amount: 4200000, variants_count: 36 });
export const oldHub = location({ id: 'LOC3', name: 'Old hub', is_default: false, position: 2, archived_at: '2026-11-01T00:00:00Z', units_on_hand: 0, stock_value_amount: 0, variants_count: 0, address: null });

export const locationsResponse = (rows: Location[]) => jsonResponse(200, { data: rows });

/** A variant with stock at both locations, as "All locations" returns it (top-level = totals). */
export const splitItem = () =>
  inventoryItem({
    on_hand: 19,
    committed: 6,
    available: 13,
    location_id: null,
    locations: [
      { id: 'LOC1', name: 'Main warehouse', on_hand: 14, committed: 6, available: 8 },
      { id: 'LOC2', name: 'Dhanmondi shop', on_hand: 5, committed: 0, available: 5 },
    ],
  });

export const growthPlan = () => features({ plan_code: 'growth', features: { ...features().features, purchasing: true, multi_warehouse: true } });
export const starterPlan = () => features({ plan_code: 'starter', features: { ...features().features, purchasing: true, multi_warehouse: false } });
