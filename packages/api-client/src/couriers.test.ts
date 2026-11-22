import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './index';

// Phase 5b-3 couriers (PHASE-5B §4.6): paths, methods, the once-only webhook secret in `meta`, area `meta.suggested`.

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
    };
  };
  return { client, call };
}

describe('Phase 5b-3 couriers', () => {
  it('list GETs the store couriers', async () => {
    const { client, call } = setup(json(200, { data: [{ provider: 'steadfast', status: 'not_connected' }] }));
    const list = await client.couriers.list('S1');
    expect(call().url.pathname).toBe('/api/v1/stores/S1/couriers');
    expect(list[0]!.provider).toBe('steadfast');
  });

  it('connect PUTs mode + credentials and returns the once-only webhook secret from meta', async () => {
    const { client, call } = setup(json(200, { data: { provider: 'steadfast', status: 'connected' }, meta: { webhook_secret: 'whsec_40chars' } }));
    const res = await client.couriers.connect('S1', 'steadfast', { mode: 'live', credentials: { api_key: 'k', secret_key: 's' } });
    expect(call().method).toBe('PUT');
    expect(call().url.pathname).toBe('/api/v1/stores/S1/couriers/steadfast');
    expect(call().body).toEqual({ mode: 'live', credentials: { api_key: 'k', secret_key: 's' } });
    expect(res.account.status).toBe('connected');
    expect(res.webhook_secret).toBe('whsec_40chars');
  });

  it('connect without meta gives a null secret (RedX); 402 plan_limit_reached surfaces', async () => {
    const { client } = setup(json(200, { data: { provider: 'redx', status: 'connected' } }));
    expect((await client.couriers.connect('S1', 'redx', { mode: 'live', credentials: { access_token: 't' } })).webhook_secret).toBeNull();
    const limited = setup(json(402, { error: { code: 'plan_limit_reached', message: 'Free plan: 1 courier' } }));
    await expect(limited.client.couriers.connect('S1', 'pathao', { mode: 'sandbox', credentials: { client_id: 'a', client_secret: 'b', username: 'c', password: 'd' } })).rejects.toMatchObject({
      status: 402,
      code: 'plan_limit_reached',
    });
  });

  it('update PATCHes, test/rotate POST, disconnect DELETEs and surfaces courier_busy', async () => {
    const { client, call } = setup(() => json(200, { data: { ok: true, checked_at: '2026-11-22T00:00:00Z', webhook_url: 'u', webhook_secret: 'n' } }));
    await client.couriers.update('S1', 'pathao', { revision: 3, settings: { default_weight_grams: 700 }, is_default: true });
    expect(call(0).method).toBe('PATCH');
    expect(call(0).body).toEqual({ revision: 3, settings: { default_weight_grams: 700 }, is_default: true });
    await client.couriers.test('S1', 'pathao');
    expect(call(1).url.pathname).toBe('/api/v1/stores/S1/couriers/pathao/test');
    expect(call(1).method).toBe('POST');
    const rotated = await client.couriers.rotateWebhookSecret('S1', 'steadfast');
    expect(call(2).url.pathname).toBe('/api/v1/stores/S1/couriers/steadfast/webhook-secret');
    expect(rotated.webhook_secret).toBe('n');
    const busy = setup(json(409, { error: { code: 'courier_busy', message: 'Active parcels' } }));
    await expect(busy.client.couriers.disconnect('S1', 'steadfast')).rejects.toMatchObject({ status: 409, code: 'courier_busy' });
    expect(busy.call().method).toBe('DELETE');
  });

  it('areas sends level/parent and reads meta.suggested; pickupStores GETs', async () => {
    const { client, call } = setup(json(200, { data: [{ id: '1', name: 'Dhaka', level: 'city', parent_id: null }], meta: { suggested: { city_id: '1', zone_id: null, area_id: null } } }));
    const res = await client.couriers.areas('S1', 'pathao', { level: 'city', district_code: 'dhaka' });
    expect(call().url.pathname).toBe('/api/v1/stores/S1/couriers/pathao/areas');
    expect(call().url.searchParams.get('level')).toBe('city');
    expect(call().url.searchParams.get('district_code')).toBe('dhaka');
    expect(res.suggested).toEqual({ city_id: '1', zone_id: null, area_id: null });
    const stores = setup(json(200, { data: [{ id: '70412', name: 'Mirpur', address: null }] }));
    expect((await stores.client.couriers.pickupStores('S1', 'redx'))[0]!.id).toBe('70412');
    expect(stores.call().url.pathname).toBe('/api/v1/stores/S1/couriers/redx/pickup-stores');
  });
});
