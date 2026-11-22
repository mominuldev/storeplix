import { describe, expect, it, vi } from 'vitest';
import { couponListQuery, createApiClient, orderListQuery } from './index';

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setup(response: Response | (() => Response)) {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
    typeof response === 'function' ? response() : response,
  );
  const client = createApiClient({ baseUrl: 'http://api.test', fetch: fetchMock, getTenantId: () => 'T1' });
  const call = (i = 0) => {
    const init = fetchMock.mock.calls[i]![1]!;
    return {
      url: new URL(String(fetchMock.mock.calls[i]![0])),
      method: init.method,
      body: init.body && typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      headers: init.headers as Record<string, string>,
    };
  };
  return { client, call };
}

describe('Phase 5a query mappers', () => {
  it('orderListQuery maps statuses, channels and the placed_at range', () => {
    expect(orderListQuery({ status: ['pending', 'confirmed'], channel: ['facebook'], placed_from: '2026-11-01', placed_to: '2026-11-30', q: ' GS-10 ', page: 2 })).toMatchObject({
      'filter[status]': 'pending,confirmed',
      'filter[channel]': 'facebook',
      'filter[placed_at][gte]': '2026-11-01',
      'filter[placed_at][lte]': '2026-11-30',
      q: 'GS-10',
      page: 2,
    });
    expect(orderListQuery({ status: [] })['filter[status]']).toBeUndefined();
  });

  it('couponListQuery maps type and status lists', () => {
    expect(couponListQuery({ type: ['percentage'], status: ['active', 'expired'], sort: '-revenue' })).toMatchObject({ 'filter[type]': 'percentage', 'filter[status]': 'active,expired', sort: '-revenue' });
  });
});

describe('Phase 5a endpoints', () => {
  it('orders.create sends the Idempotency-Key header', async () => {
    const { client, call } = setup(json(201, { data: { id: 'O1' } }));
    await client.orders.create('S1', { items: [{ variant_id: 'V1', quantity: 1 }], channel: 'facebook', contact: { name: 'A', phone: '01712345678' }, shipping_address: { district_code: 'dhaka', thana_code: 'dhaka-mirpur', address_line: 'House 1' } }, 'key-1');
    expect(call().url.pathname).toBe('/api/v1/stores/S1/orders');
    expect(call().headers['Idempotency-Key']).toBe('key-1');
    expect(call().headers['X-Tenant-Id']).toBe('T1');
  });

  it('orders.update returns the order and meta.shipping_hint', async () => {
    const hint = { zone_id: 'Z1', zone_name: 'Outside Dhaka', min_days: 2, max_days: 4, charge_amount: 13000, amount: 13000, is_free: false };
    const { client, call } = setup(json(200, { data: { id: 'O1', revision: 3 }, meta: { shipping_hint: hint } }));
    const res = await client.orders.update('S1', 'O1', { revision: 2, customer_note: 'x' });
    expect(call().method).toBe('PATCH');
    expect(res).toEqual({ order: { id: 'O1', revision: 3 }, shippingHint: hint });
  });

  it('orders.list falls back to zero counts', async () => {
    const { client } = setup(json(200, { data: [] }));
    const res = await client.orders.list('S1');
    expect(res.meta.counts.pending).toBe(0);
  });

  it('transitions hit their own paths', async () => {
    const { client, call } = setup(() => json(200, { data: { id: 'O1' } }));
    await client.orders.confirm('S1', 'O1', { notify_customer: true });
    await client.orders.cancel('S1', 'O1', { reason: 'unreachable' });
    await client.orders.refund('S1', 'O1', { amount: 100, method: 'cash' }, 'k');
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/orders/O1/confirm');
    expect(call(0).body).toEqual({ notify_customer: true });
    expect(call(1).url.pathname).toBe('/api/v1/stores/S1/orders/O1/cancel');
    expect(call(2).headers['Idempotency-Key']).toBe('k');
  });

  it('geo.bd is anonymous', async () => {
    const { client, call } = setup(json(200, { data: { version: '1', divisions: [], districts: [], thanas: [] } }));
    await client.geo.bd();
    expect(call().url.pathname).toBe('/api/v1/geo/bd');
    expect(call().headers['X-Tenant-Id']).toBeUndefined();
  });

  it('shipping.save PUTs the full zone list; launch.publish POSTs', async () => {
    const { client, call } = setup(() => json(200, { data: {} }));
    await client.shipping.save('S1', { zones: [], free_delivery_over_amount: null });
    await client.launch.publish('S1');
    expect(call(0).method).toBe('PUT');
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/shipping');
    expect(call(1).url.pathname).toBe('/api/v1/stores/S1/publish');
  });
});
