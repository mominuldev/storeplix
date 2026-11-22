import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './index';

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
      method: init.method,
      body: init.body && typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      headers: init.headers as Record<string, string>,
    };
  };
  return { client, call };
}

const meta = { cname_target: 'customers.storeplix.test', txt_prefix: '_storeplix-verify', can_add: true, feature_enabled: true, limit: { used: 1, max: 2 } };

describe('Phase 6 domains client', () => {
  it('list returns rows and meta with the tenant header', async () => {
    const { client, call } = setup(json(200, { data: [{ id: 'D1' }], meta }));
    const res = await client.domains.list('S1');
    expect(call().url.pathname).toBe('/api/v1/stores/S1/domains');
    expect(call().headers['X-Tenant-Id']).toBe('T1');
    expect(res.data).toHaveLength(1);
    expect(res.meta.cname_target).toBe('customers.storeplix.test');
  });

  it('add posts only the hostname', async () => {
    const { client, call } = setup(json(201, { data: { id: 'D2' } }));
    await client.domains.add('S1', { hostname: 'shop.acme.com', status: 'active' } as never);
    expect(call().method).toBe('POST');
    expect(call().body).toEqual({ hostname: 'shop.acme.com' });
  });

  it('recheck, makePrimary and remove hit their paths', async () => {
    const { client, call } = setup(() => json(200, { data: [] }));
    await client.domains.recheck('S1', 'D/1');
    await client.domains.makePrimary('S1', 'D1');
    await client.domains.get('S1', 'D1');
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/domains/D%2F1/verify');
    expect(call(1).url.pathname).toBe('/api/v1/stores/S1/domains/D1/primary');
    expect(call(2).method).toBe('GET');
    const del = setup(new Response(null, { status: 204 }));
    await expect(del.client.domains.remove('S1', 'D1')).resolves.toBeUndefined();
    expect(del.call().method).toBe('DELETE');
  });

  it('surfaces 429 retry_after and 422 domain codes', async () => {
    const limited = setup(json(429, { error: { code: 'rate_limited', message: 'Slow down', details: { retry_after: [42] } } }));
    const err = await limited.client.domains.recheck('S1', 'D1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).retryAfter).toBe(42);
    const taken = setup(json(422, { error: { code: 'domain_taken', message: 'Taken' } }));
    await expect(taken.client.domains.add('S1', { hostname: 'x.com' })).rejects.toMatchObject({ status: 422, code: 'domain_taken' });
  });
});
