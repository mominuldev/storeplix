import { describe, expect, it, vi } from 'vitest';
import { createApiClient, shipmentListQuery } from './index';

// Phase 5b-3 §4.7 shipments client.

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setup(response: Response | (() => Response)) {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => (typeof response === 'function' ? response() : response));
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

describe('shipmentListQuery', () => {
  it('maps provider, status groups, booked range, search and sort', () => {
    expect(shipmentListQuery({ provider: ['steadfast', 'pathao'], status: ['problems'], booked_from: '2026-11-15', booked_to: '2026-11-22', q: ' 0171 ', sort: '-cod', page: 2, per_page: 25 })).toEqual({
      'filter[provider]': 'steadfast,pathao',
      'filter[status]': 'problems',
      'filter[booked_at][gte]': '2026-11-15',
      'filter[booked_at][lte]': '2026-11-22',
      q: '0171',
      sort: '-cod',
      page: 2,
      per_page: 25,
    });
    expect(shipmentListQuery({})['filter[status]']).toBeUndefined();
  });
});

describe('shipments client', () => {
  it('book POSTs to the order with the Idempotency-Key', async () => {
    const { client, call } = setup(json(201, { data: { id: 'SH1', status: 'booked' } }));
    const res = await client.shipments.book('S1', 'O1', { provider: 'pathao', area: { city_id: '1', zone_id: '2', area_id: null }, remember_area: true }, 'key-1');
    expect(call().method).toBe('POST');
    expect(call().url.pathname).toBe('/api/v1/stores/S1/orders/O1/shipments');
    expect(call().headers['Idempotency-Key']).toBe('key-1');
    expect(call().body).toMatchObject({ provider: 'pathao', remember_area: true });
    expect(res).toEqual({ id: 'SH1', status: 'booked' });
  });

  it('list returns typed meta and falls back to empty KPIs', async () => {
    const { client, call } = setup(json(200, { data: [] }));
    const res = await client.shipments.list('S1', { status: ['active'] });
    expect(call().url.searchParams.get('filter[status]')).toBe('active');
    expect(res.meta.kpis.cod_held.total_amount).toBe(0);
    expect(res.meta.counts.all).toBe(0);
  });

  it('bulk, batch, refresh, sync, cancel and markCancelled hit their paths', async () => {
    const { client, call } = setup(() => json(200, { data: {} }));
    await client.shipments.bulk('S1', { provider: 'steadfast', order_ids: ['O1', 'O2'] });
    await client.shipments.batch('S1', 'B1');
    await client.shipments.refresh('S1', 'SH1');
    await client.shipments.sync('S1');
    await client.shipments.cancel('S1', 'SH1', { reason: 'Customer cancelled' });
    await client.shipments.markCancelled('S1', 'SH1', { note: null });
    await client.shipments.get('S1', 'SH1');
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => `${call(i).method ?? 'GET'} ${call(i).url.pathname}`)).toEqual([
      'POST /api/v1/stores/S1/shipments/bulk',
      'GET /api/v1/stores/S1/shipment-batches/B1',
      'POST /api/v1/stores/S1/shipments/SH1/refresh',
      'POST /api/v1/stores/S1/shipments/sync',
      'POST /api/v1/stores/S1/shipments/SH1/cancel',
      'POST /api/v1/stores/S1/shipments/SH1/mark-cancelled',
      'GET /api/v1/stores/S1/shipments/SH1',
    ]);
    expect(call(0).body).toEqual({ provider: 'steadfast', order_ids: ['O1', 'O2'] });
  });

  it('surfaces courier_cancel_unsupported as an ApiError', async () => {
    const { client } = setup(json(409, { error: { code: 'courier_cancel_unsupported', message: 'Cancel it in the Steadfast panel, then mark it cancelled here.' } }));
    await expect(client.shipments.cancel('S1', 'SH1')).rejects.toMatchObject({ status: 409, code: 'courier_cancel_unsupported' });
  });
});
