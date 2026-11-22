import type { CourierAccount, CourierProvider, PickupLocation } from '@storeplix/types';
import { jsonResponse } from '../test/utils';

// Phase 5b-3 courier fixtures shaped like openapi 1.6.0 CourierAccount (PHASE-5B §4.6, §9).

export function courier(provider: CourierProvider, a: Partial<CourierAccount> = {}): CourierAccount {
  return {
    provider,
    status: 'not_connected',
    mode: null,
    credentials_hint: null,
    is_default: false,
    settings: { pickup_location_id: null, parcel_description: '{items} · {order_no}', default_weight_grams: 500 },
    webhook_url: null,
    webhook_secret_hint: null,
    capabilities: [],
    last_synced_at: null,
    last_webhook_at: null,
    last_error_code: null,
    connected_by: null,
    connected_at: null,
    revision: 1,
    ...a,
  };
}

export const connectedSteadfast = (a: Partial<CourierAccount> = {}) =>
  courier('steadfast', {
    status: 'connected',
    mode: 'live',
    credentials_hint: '••••3f9a',
    is_default: true,
    settings: { pickup_location_id: 'PL1', parcel_description: '{items} · {order_no}', default_weight_grams: 500 },
    webhook_url: 'https://api.storeplix.com/api/v1/webhooks/steadfast/rk_mugdho',
    webhook_secret_hint: '••••a91c',
    capabilities: ['bulk', 'webhook'],
    last_synced_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    connected_by: { id: 'U1', name: 'Rahim Ahmed' },
    connected_at: '2026-11-22T08:00:00Z',
    revision: 3,
    ...a,
  });

export const couriersResponse = (list: CourierAccount[] = [courier('steadfast'), courier('pathao'), courier('redx')]) => jsonResponse(200, { data: list });

export function pickupLocation(p: Partial<PickupLocation> = {}): PickupLocation {
  return {
    id: 'PL1',
    name: 'Main warehouse',
    contact_name: null,
    contact_phone: null,
    district_code: 'dhaka',
    thana_code: 'dhaka-mirpur',
    district: 'Dhaka',
    thana: 'Mirpur',
    address_line: 'House 12, Road 3',
    is_default: true,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    ...p,
  };
}
