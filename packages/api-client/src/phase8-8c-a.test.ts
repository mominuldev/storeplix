import { describe, expect, it, vi } from 'vitest';
import type {
  CreatePurchaseOrderInput,
  InventoryItem,
  Location,
  LocationErrorCode,
  QuickPurchaseInput,
  StockAdjustmentInput,
  StockMovementReason,
} from '@storeplix/types';
import { LOCATION_AUDIT_ACTIONS, LOCATION_IN_USE_REASONS, LOCATION_TYPES, LOCATIONS_MAX } from '@storeplix/types';
import { createApiClient, isApiError, locationListQuery } from './index';

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setup(response: Response | (() => Response)) {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => (typeof response === 'function' ? response() : response));
  const client = createApiClient({ baseUrl: 'http://api.test', fetch: fetchMock, getTenantId: () => 'T1', csrf: false });
  const call = (i = 0) => {
    const init = fetchMock.mock.calls[i]![1]!;
    return {
      url: new URL(String(fetchMock.mock.calls[i]![0])),
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      headers: init.headers as Record<string, string>,
    };
  };
  return { client, call };
}

const main: Location = {
  id: 'L1', name: 'Main warehouse', type: 'warehouse', address: 'Mirpur 10', is_default: true, position: 0,
  archived_at: null, pickup_location: { id: 'PL1', name: 'Mirpur' }, units_on_hand: 120, stock_value_amount: null,
  variants_count: 8, created_at: '2026-11-24T00:00:00Z', updated_at: '2026-11-24T00:00:00Z',
};

describe('Phase 8.8c part A: locations + per-location stock client', () => {
  it('constants', () => {
    expect(LOCATION_TYPES).toEqual(['warehouse', 'shop']);
    expect(LOCATIONS_MAX).toBe(10);
    expect(LOCATION_AUDIT_ACTIONS).toEqual([
      'location.created', 'location.updated', 'location.archived', 'location.unarchived', 'location.made_default',
    ]);
    expect(LOCATION_IN_USE_REASONS).toContain('is_default');
  });

  it('locationListQuery maps archived', () => {
    expect(locationListQuery()).toEqual({ 'filter[archived]': undefined });
    expect(locationListQuery({ archived: false })).toEqual({ 'filter[archived]': '0' });
    expect(locationListQuery({ archived: true })).toEqual({ 'filter[archived]': '1' });
  });

  it('locations: list, create, update, archive, unarchive, make default', async () => {
    const { client, call } = setup(() => json(200, { data: [main] }));
    const list = await client.locations.list('S1');
    expect(list).toEqual([main]);
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/locations');
    expect(call(0).headers['X-Tenant-Id']).toBe('T1');
    expect(call(0).url.searchParams.has('filter[archived]')).toBe(false);
    await client.locations.list('S1', { archived: false });
    expect(call(1).url.searchParams.get('filter[archived]')).toBe('0');
    await client.locations.create('S1', { name: 'Dhanmondi shop', type: 'shop', address: 'Road 27', pickup_location_id: null });
    expect(call(2)).toMatchObject({ method: 'POST', body: { name: 'Dhanmondi shop', type: 'shop', address: 'Road 27', pickup_location_id: null } });
    expect(call(2).url.pathname).toBe('/api/v1/stores/S1/locations');
    await client.locations.update('S1', 'L2', { name: 'Dhanmondi' });
    expect(call(3)).toMatchObject({ method: 'PATCH', body: { name: 'Dhanmondi' } });
    expect(call(3).url.pathname).toBe('/api/v1/stores/S1/locations/L2');
    await client.locations.archive('S1', 'L2');
    expect(call(4)).toMatchObject({ method: 'POST' });
    expect(call(4).url.pathname).toBe('/api/v1/stores/S1/locations/L2/archive');
    await client.locations.unarchive('S1', 'L2');
    expect(call(5).url.pathname).toBe('/api/v1/stores/S1/locations/L2/unarchive');
    await client.locations.makeDefault('S1', 'L2');
    expect(call(6)).toMatchObject({ method: 'POST' });
    expect(call(6).url.pathname).toBe('/api/v1/stores/S1/locations/L2/make-default');
  });

  it('archive surfaces 409 location_in_use with reasons', async () => {
    const code: LocationErrorCode = 'location_in_use';
    const { client } = setup(() => json(409, { error: { code, message: 'In use', details: { reasons: ['has_stock', 'is_default'] } } }));
    const err = await client.locations.archive('S1', 'L1').catch((e: unknown) => e);
    expect(isApiError(err)).toBe(true);
    if (isApiError(err)) {
      expect(err.status).toBe(409);
      expect(err.code).toBe('location_in_use');
    }
  });

  it('inventory: location filters, adjust with location, threshold with/without location', async () => {
    const { client, call } = setup(() => json(200, { data: [] }));
    await client.inventory.list('S1', { location_id: 'L2', stock: ['low'] });
    expect(call(0).url.searchParams.get('filter[location_id]')).toBe('L2');
    expect(call(0).url.searchParams.get('filter[stock]')).toBe('low');
    await client.inventory.list('S1');
    expect(call(1).url.searchParams.has('filter[location_id]')).toBe(false);
    await client.inventory.movements('S1', { location_id: 'L2', reason: ['transfer_out', 'count'] });
    expect(call(2).url.pathname).toBe('/api/v1/stores/S1/inventory/movements');
    expect(call(2).url.searchParams.get('filter[location_id]')).toBe('L2');
    expect(call(2).url.searchParams.get('filter[reason]')).toBe('transfer_out,count');
    const adjust: StockAdjustmentInput = {
      reason: 'received', items: [{ variant_id: 'V1', mode: 'delta', quantity: 5, location_id: 'L2' }, { variant_id: 'V2', mode: 'set', quantity: 3 }],
    };
    await client.inventory.adjust('S1', adjust);
    expect(call(3)).toMatchObject({ method: 'POST', body: adjust });
    await client.inventory.setThreshold('S1', 'V1', 4, 'L2');
    expect(call(4)).toMatchObject({ method: 'PATCH', body: { low_stock_threshold: 4, location_id: 'L2' } });
    expect(call(4).url.pathname).toBe('/api/v1/stores/S1/inventory/V1');
    await client.inventory.setThreshold('S1', 'V1', null);
    expect(call(5).body).toEqual({ low_stock_threshold: null });
  });

  it('inventory item carries per-location numbers', () => {
    const reason: StockMovementReason = 'transfer_in';
    const item: Pick<InventoryItem, 'location_id' | 'locations' | 'on_hand'> = {
      location_id: null, on_hand: 7,
      locations: [{ id: 'L1', name: 'Main warehouse', on_hand: 5, committed: 1, available: 4 }, { id: 'L2', name: 'Dhanmondi shop', on_hand: 2, committed: 0, available: 2 }],
    };
    expect(item.locations.reduce((n, l) => n + l.on_hand, 0)).toBe(item.on_hand);
    expect(reason).toBe('transfer_in');
  });

  it('purchase orders: create and quick purchase pass location_id', async () => {
    const { client, call } = setup(() => json(201, { data: {} }));
    const create: CreatePurchaseOrderInput = { supplier_id: 'SU1', location_id: 'L2', lines: [{ variant_id: 'V1', quantity: 10 }] };
    await client.purchaseOrders.create('S1', create);
    expect(call(0)).toMatchObject({ method: 'POST', body: { location_id: 'L2' } });
    await client.purchaseOrders.update('S1', 'PO1', { revision: 2, location_id: 'L1' });
    expect(call(1)).toMatchObject({ method: 'PATCH', body: { revision: 2, location_id: 'L1' } });
    const quick: QuickPurchaseInput = { supplier_id: 'SU1', location_id: 'L2', lines: [{ variant_id: 'V1', unit_cost_amount: 1000, quantity: 2 }] };
    await client.purchaseOrders.quick('S1', quick, 'idem-1');
    expect(call(2)).toMatchObject({ method: 'POST', body: { location_id: 'L2' } });
    expect(call(2).headers['Idempotency-Key']).toBe('idem-1');
  });
});
