import { describe, expect, it, vi } from 'vitest';
import type { UpdateFraudGuardSettingsInput } from '@storeplix/types';
import { FRAUD_GUARD_DEFAULTS, PERMISSION_KEYS, RISK_TIERS, SYSTEM_ROLE_PERMISSIONS } from '@storeplix/types';
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

describe('Phase 8.8a fake-order guard client', () => {
  it('settings get / patch / reset hit the store-scoped routes with the tenant header', async () => {
    const { client, call } = setup(() => json(200, { data: { ...FRAUD_GUARD_DEFAULTS, updated_by: null, updated_at: null } }));
    await client.fraudGuard.settings.get('S1');
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/fraud-guard/settings');
    expect(call(0).headers['X-Tenant-Id']).toBe('T1');
    const patch: UpdateFraudGuardSettingsInput = { hold_below: 55, otp_enabled: false };
    await client.fraudGuard.settings.update('S1', patch);
    expect(call(1)).toMatchObject({ method: 'PATCH', body: patch });
    await client.fraudGuard.settings.reset('S1');
    expect(call(2).method).toBe('POST');
    expect(call(2).url.pathname).toBe('/api/v1/stores/S1/fraud-guard/settings/reset');
  });

  it('overview sends month; events send type filter and cursor', async () => {
    const { client, call } = setup(() => json(200, { data: [], meta: { next_cursor: null, prev_cursor: null, per_page: 50 } }));
    await client.fraudGuard.overview('S1', '2026-11');
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/fraud-guard/overview');
    expect(call(0).url.searchParams.get('month')).toBe('2026-11');
    const page = await client.fraudGuard.events('S1', { type: ['held', 'duplicate'], cursor: 'c1' });
    expect(page.meta.per_page).toBe(50);
    expect(call(1).url.pathname).toBe('/api/v1/stores/S1/fraud-guard/events');
    expect(call(1).url.searchParams.get('filter[type]')).toBe('held,duplicate');
    expect(call(1).url.searchParams.get('cursor')).toBe('c1');
  });

  it('blocked numbers list / create / remove and check', async () => {
    const { client, call } = setup(() => json(200, { data: [] }));
    await client.fraudGuard.blockedNumbers.list('S1', { q: ' 5678 ' });
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/fraud-guard/blocked-numbers');
    expect(call(0).url.searchParams.get('q')).toBe('5678');
    await client.fraudGuard.blockedNumbers.create('S1', { phone: '01712345678', note: 'Fake address' });
    expect(call(1)).toMatchObject({ method: 'POST', body: { phone: '01712345678', note: 'Fake address' } });
    await client.fraudGuard.check('S1', '01712345678');
    expect(call(2)).toMatchObject({ method: 'POST', body: { phone: '01712345678' } });
    expect(call(2).url.pathname).toBe('/api/v1/stores/S1/fraud-guard/check');
  });

  it('unblock returns void on 204', async () => {
    const { client, call } = setup(() => new Response(null, { status: 204 }));
    await expect(client.fraudGuard.blockedNumbers.remove('S1', 'B1')).resolves.toBeUndefined();
    expect(call(0).method).toBe('DELETE');
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/fraud-guard/blocked-numbers/B1');
  });

  it('orders: releaseHold, risk + guard_hold filters, held count fallback, customer risk filter', async () => {
    const { client, call } = setup(() => json(200, { data: [] }));
    await client.orders.releaseHold('S1', 'O1');
    expect(call(0).method).toBe('POST');
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/orders/O1/guard/release');
    const page = await client.orders.list('S1', { risk: ['risky', 'new'], guard_hold: true });
    expect(call(1).url.searchParams.get('filter[risk]')).toBe('risky,new');
    expect(call(1).url.searchParams.get('filter[guard_hold]')).toBe('1');
    expect(page.meta.counts.held).toBe(0);
    await client.orders.list('S1', { guard_hold: false });
    expect(call(2).url.searchParams.has('filter[guard_hold]')).toBe(false);
    await client.customers.list('S1', { risk: ['careful'] });
    expect(call(3).url.searchParams.get('filter[risk]')).toBe('careful');
  });

  it('catalogue: fraud.manage after orders.refund; owner + admin, not staff; four tiers', () => {
    // Phase 8.8d inserts pos.sell between orders.refund and fraud.manage.
    expect(PERMISSION_KEYS.indexOf('fraud.manage')).toBe(PERMISSION_KEYS.indexOf('pos.sell') + 1);
    expect(SYSTEM_ROLE_PERMISSIONS.owner).toContain('fraud.manage');
    expect(SYSTEM_ROLE_PERMISSIONS.admin).toContain('fraud.manage');
    expect(SYSTEM_ROLE_PERMISSIONS.staff).not.toContain('fraud.manage');
    expect(RISK_TIERS).toEqual(['good', 'careful', 'risky', 'new']);
    expect(FRAUD_GUARD_DEFAULTS.advance_below).toBeGreaterThanOrEqual(FRAUD_GUARD_DEFAULTS.hold_below);
  });
});
