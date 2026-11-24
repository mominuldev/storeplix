import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './index';

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

describe('Phase 8.4 developer client', () => {
  it('apiKeys: create / rename / revoke / scopes hit the tenant-level routes', async () => {
    const { client, call } = setup(() => json(200, { data: { id: 'K1' } }));
    await client.apiKeys.create({ name: 'Zapier', scopes: ['orders:read'] });
    expect(call(0)).toMatchObject({ method: 'POST', body: { name: 'Zapier', scopes: ['orders:read'] } });
    expect(call(0).url.pathname).toBe('/api/v1/api-keys');
    expect(call(0).headers['X-Tenant-Id']).toBe('T1');
    await client.apiKeys.rename('K1', { name: 'Books' });
    expect(call(1)).toMatchObject({ method: 'PATCH', body: { name: 'Books' } });
    expect(call(1).url.pathname).toBe('/api/v1/api-keys/K1');
    await client.apiKeys.revoke('K1');
    expect(call(2).method).toBe('DELETE');
    await client.apiKeys.scopes();
    expect(call(3).url.pathname).toBe('/api/v1/api-scopes');
  });

  it('webhooks: endpoints, secret and delivery actions are store-scoped', async () => {
    const { client, call } = setup(() => json(200, { data: {} }));
    await client.webhooks.endpoints.create('S1', { url: 'https://x.test/h', events: ['order.paid'] });
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/webhook-endpoints');
    await client.webhooks.endpoints.update('S1', 'E1', { is_active: false });
    expect(call(1)).toMatchObject({ method: 'PATCH', body: { is_active: false } });
    await client.webhooks.endpoints.test('S1', 'E1');
    expect(call(2).url.pathname).toBe('/api/v1/stores/S1/webhook-endpoints/E1/test');
    await client.webhooks.secret.reveal('S1');
    expect(call(3).url.pathname).toBe('/api/v1/stores/S1/webhook-secret/reveal');
    await client.webhooks.secret.rotate('S1');
    expect(call(4).method).toBe('POST');
    await client.webhooks.deliveries.resend('S1', 'D1');
    expect(call(5).url.pathname).toBe('/api/v1/stores/S1/webhook-deliveries/D1/resend');
    await client.webhooks.deliveries.resendFailed('S1');
    expect(call(6).url.pathname).toBe('/api/v1/stores/S1/webhook-deliveries/resend-failed');
    await client.webhooks.eventTypes();
    expect(call(7).url.pathname).toBe('/api/v1/webhook-event-types');
  });

  it('webhooks.deliveries.list maps filters and returns cursor meta (fallback when absent)', async () => {
    let r = setup(json(200, { data: [], meta: { next_cursor: 'c2', prev_cursor: null, per_page: 25 } }));
    const page = await r.client.webhooks.deliveries.list('S1', { endpoint_id: 'E1', status: 'failed', event_type: 'order.paid', cursor: 'c1' });
    const q = r.call().url.searchParams;
    expect(q.get('filter[endpoint_id]')).toBe('E1');
    expect(q.get('filter[status]')).toBe('failed');
    expect(q.get('filter[event_type]')).toBe('order.paid');
    expect(q.get('cursor')).toBe('c1');
    expect(page.meta.next_cursor).toBe('c2');
    r = setup(json(200, { data: [] }));
    expect((await r.client.webhooks.deliveries.list('S1')).meta).toEqual({ next_cursor: null, prev_cursor: null, per_page: 25 });
    expect(r.call().url.search).toBe('');
  });
});
