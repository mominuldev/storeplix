import { describe, expect, it, vi } from 'vitest';
import type { Automation, ThankYouSettings } from '@storeplix/types';
import { RECOVERY_CODE_PATTERN } from '@storeplix/types';
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

const settings: ThankYouSettings = {
  delay_hours: 2,
  message: { channel: 'sms', language: 'bn', body: 'ধন্যবাদ {name}! {order_no}', subject: null },
  conditions: [{ field: 'order.payment_method', op: 'is', value: 'cod' }],
};

describe('Phase 8.6 automations client', () => {
  it('automations CRUD + actions hit the store-scoped routes', async () => {
    const { client, call } = setup(() => json(200, { data: { id: 'A1' } }));
    await client.automations.create('S1', { recipe: 'thank_you' });
    expect(call(0)).toMatchObject({ method: 'POST', body: { recipe: 'thank_you' } });
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/automations');
    expect(call(0).headers['X-Tenant-Id']).toBe('T1');
    await client.automations.update<'thank_you'>('S1', 'A1', { settings, revision: 3 });
    expect(call(1)).toMatchObject({ method: 'PATCH', body: { settings, revision: 3 } });
    expect(call(1).url.pathname).toBe('/api/v1/stores/S1/automations/A1');
    for (const [i, action] of (['enable', 'disable'] as const).entries()) {
      await client.automations[action]('S1', 'A1');
      expect(call(2 + i)).toMatchObject({ method: 'POST' });
      expect(call(2 + i).url.pathname).toBe(`/api/v1/stores/S1/automations/A1/${action}`);
    }
    await client.automations.dryRun('S1', 'A1', { order_id: 'O1' });
    expect(call(4)).toMatchObject({ method: 'POST', body: { order_id: 'O1' } });
    expect(call(4).url.pathname).toBe('/api/v1/stores/S1/automations/A1/dry-run');
    await client.automations.testMessage('S1', 'A1', 2);
    expect(call(5)).toMatchObject({ method: 'POST', body: { step: 2 } });
    expect(call(5).url.pathname).toBe('/api/v1/stores/S1/automations/A1/test-message');
    await client.automations.stats('S1', 'A1', 30);
    expect(call(6).url.pathname).toBe('/api/v1/stores/S1/automations/A1/stats');
    expect(call(6).url.searchParams.get('days')).toBe('30');
    await client.automations.get('S1', 'A1');
    expect(call(7)).toMatchObject({ method: 'GET' });
    await client.automations.run('S1', 'R1');
    expect(call(8).url.pathname).toBe('/api/v1/stores/S1/automation-runs/R1');
  });

  it('delete resolves on 204', async () => {
    const { client, call } = setup(() => new Response(null, { status: 204 }));
    await expect(client.automations.delete('S1', 'A1')).resolves.toBeUndefined();
    expect(call(0)).toMatchObject({ method: 'DELETE' });
  });

  it('list returns recipes + kpis meta (fallback when absent); runs map filters with cursor meta', async () => {
    let r = setup(json(200, { data: [] }));
    const list = await r.client.automations.list('S1');
    expect(r.call().url.pathname).toBe('/api/v1/stores/S1/automations');
    expect(list.meta.recipes).toEqual([]);
    expect(list.meta.kpis.runs_7d_succeeded_pct).toBeNull();

    r = setup(json(200, { data: [] }));
    const page = await r.client.automations.runs('S1', { automation_id: 'A1', recipe: 'checkout_recovery', status: ['waiting', 'stopped'], since: '2026-11-01T00:00:00Z', cursor: 'c1' });
    const q = r.call().url.searchParams;
    expect(r.call().url.pathname).toBe('/api/v1/stores/S1/automation-runs');
    expect(q.get('filter[automation_id]')).toBe('A1');
    expect(q.get('filter[recipe]')).toBe('checkout_recovery');
    expect(q.get('filter[status]')).toBe('waiting,stopped');
    expect(q.get('filter[since]')).toBe('2026-11-01T00:00:00Z');
    expect(q.get('cursor')).toBe('c1');
    expect(page.meta).toEqual({ next_cursor: null, prev_cursor: null, per_page: 50 });
  });

  it('Automation narrows settings by recipe', () => {
    const a = { recipe: 'thank_you', settings } as Automation;
    if (a.recipe === 'thank_you') expect(a.settings.delay_hours).toBe(2);
  });

  it('storefront cart contact + recover send host/key/client-ip (+ cart token) and no tenant header', async () => {
    const { client, call } = setup(() => new Response(null, { status: 204 }));
    await client.storefront.saveCartContact('Shop.Test:3010', 'k', 'tok', { phone: '01711000044', name: 'Rahim' }, { clientIp: '203.0.113.9' });
    expect(call(0)).toMatchObject({ method: 'PUT', body: { phone: '01711000044', name: 'Rahim' } });
    expect(call(0).url.pathname).toBe('/api/v1/storefront/cart/contact');
    expect(call(0).headers['X-Storefront-Host']).toBe('shop.test');
    expect(call(0).headers['X-Storefront-Key']).toBe('k');
    expect(call(0).headers['X-Cart-Token']).toBe('tok');
    expect(call(0).headers['X-Storefront-Client-Ip']).toBe('203.0.113.9');
    expect(call(0).headers['X-Tenant-Id']).toBeUndefined();

    const r = setup(json(201, { data: { cart_token: 'new', next: 'checkout' } }));
    const res = await r.client.storefront.recoverCart('shop.test', 'k', 'Ab3dE5gH9z');
    expect(res).toEqual({ cart_token: 'new', next: 'checkout' });
    expect(r.call()).toMatchObject({ method: 'POST', body: { code: 'Ab3dE5gH9z' } });
    expect(r.call().url.pathname).toBe('/api/v1/storefront/carts/recover');
    expect(r.call().headers['X-Cart-Token']).toBeUndefined();
    expect(RECOVERY_CODE_PATTERN.test('Ab3dE5gH9z')).toBe(true);
    expect(RECOVERY_CODE_PATTERN.test('Ab3dE5gH9')).toBe(false);
  });
});
