import { describe, expect, it, vi } from 'vitest';
import type { CampaignAudience } from '@storeplix/types';
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

const audience: CampaignAudience = {
  segment: 'repeat_inactive',
  params: { min_orders: 2, inactive_days: 60 },
  exclude: { risky: true, ordered_within_days: 7 },
};

describe('Phase 8.5 campaigns client', () => {
  it('campaigns CRUD + actions hit the store-scoped routes; schedule/send carry Idempotency-Key', async () => {
    const { client, call } = setup(() => json(200, { data: { id: 'C1' } }));
    await client.campaigns.create('S1', { name: 'Win-back', channel: 'sms', language: 'bn', audience, body: 'Hi {name}' });
    expect(call(0)).toMatchObject({ method: 'POST', body: { name: 'Win-back', channel: 'sms', audience } });
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/campaigns');
    expect(call(0).headers['X-Tenant-Id']).toBe('T1');
    await client.campaigns.update('S1', 'C1', { body: 'Hello', revision: 2 });
    expect(call(1)).toMatchObject({ method: 'PATCH', body: { body: 'Hello', revision: 2 } });
    await client.campaigns.schedule('S1', 'C1', { scheduled_at: '2026-12-05T10:00:00+06:00' }, 'idem-1');
    expect(call(2).url.pathname).toBe('/api/v1/stores/S1/campaigns/C1/schedule');
    expect(call(2).headers['Idempotency-Key']).toBe('idem-1');
    expect(call(2).body).toEqual({ scheduled_at: '2026-12-05T10:00:00+06:00' });
    await client.campaigns.send('S1', 'C1', 'idem-2');
    expect(call(3)).toMatchObject({ method: 'POST' });
    expect(call(3).url.pathname).toBe('/api/v1/stores/S1/campaigns/C1/send');
    expect(call(3).headers['Idempotency-Key']).toBe('idem-2');
    for (const [i, action] of (['unschedule', 'cancel', 'duplicate'] as const).entries()) {
      await client.campaigns[action]('S1', 'C1');
      expect(call(4 + i).url.pathname).toBe(`/api/v1/stores/S1/campaigns/C1/${action}`);
    }
    await client.campaigns.sendTest('S1', 'C1');
    expect(call(7).url.pathname).toBe('/api/v1/stores/S1/campaigns/C1/test');
    await client.campaigns.audiencePreview('S1', { channel: 'email', audience });
    expect(call(8)).toMatchObject({ method: 'POST', body: { channel: 'email', audience } });
    expect(call(8).url.pathname).toBe('/api/v1/stores/S1/campaigns/audience-preview');
    await client.campaigns.estimate('S1', { channel: 'sms', language: 'en', body: 'x', audience });
    expect(call(9).url.pathname).toBe('/api/v1/stores/S1/campaigns/estimate');
    await client.marketing.overview('S1', '7d');
    expect(call(10).url.pathname).toBe('/api/v1/stores/S1/marketing/overview');
    expect(call(10).url.searchParams.get('range')).toBe('7d');
    await client.campaigns.devSink('S1');
    expect(call(11).url.pathname).toBe('/api/v1/dev/stores/S1/message-sink');
  });

  it('campaigns.list maps filters; recipients use cursor meta (fallback per_page 50)', async () => {
    let r = setup(json(200, { data: [], meta: { current_page: 1, per_page: 25, total: 0, last_page: 1 } }));
    await r.client.campaigns.list('S1', { status: ['scheduled', 'sending'], channel: 'sms', q: ' eid ', sort: '-started_at' });
    const q = r.call().url.searchParams;
    expect(q.get('filter[status]')).toBe('scheduled,sending');
    expect(q.get('filter[channel]')).toBe('sms');
    expect(q.get('q')).toBe('eid');
    expect(q.get('sort')).toBe('-started_at');
    r = setup(json(200, { data: [] }));
    const page = await r.client.campaigns.recipients('S1', 'C1', { status: ['skipped'], skip_reason: ['opted_out'], cursor: 'c1' });
    const rq = r.call().url.searchParams;
    expect(r.call().url.pathname).toBe('/api/v1/stores/S1/campaigns/C1/recipients');
    expect(rq.get('filter[status]')).toBe('skipped');
    expect(rq.get('filter[skip_reason]')).toBe('opted_out');
    expect(rq.get('cursor')).toBe('c1');
    expect(page.meta).toEqual({ next_cursor: null, prev_cursor: null, per_page: 50 });
  });

  it('customer marketing opt-out toggles', async () => {
    const { client, call } = setup(() => json(200, { data: {} }));
    await client.customers.marketingOptOut('S1', 'U1', 'sms');
    expect(call(0)).toMatchObject({ method: 'POST', body: { channel: 'sms' } });
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/customers/U1/marketing-opt-out');
    await client.customers.removeMarketingOptOut('S1', 'U1', 'email');
    expect(call(1).method).toBe('DELETE');
    expect(call(1).url.pathname).toBe('/api/v1/stores/S1/customers/U1/marketing-opt-out/email');
  });

  it('storefront unsubscribe sends host/key/client-ip and no tenant header', async () => {
    const { client, call } = setup(() => json(200, { data: { channel: 'sms', status: 'subscribed' } }));
    await client.storefront.unsubscribe.get('Shop.Test:3000', 'k', 'Ab3dE5gH9z', { clientIp: '203.0.113.9' });
    expect(call(0).url.pathname).toBe('/api/v1/storefront/unsubscribe/Ab3dE5gH9z');
    expect(call(0).headers['X-Storefront-Host']).toBe('shop.test');
    expect(call(0).headers['X-Storefront-Key']).toBe('k');
    expect(call(0).headers['X-Storefront-Client-Ip']).toBe('203.0.113.9');
    expect(call(0).headers['X-Tenant-Id']).toBeUndefined();
    await client.storefront.unsubscribe.post('shop.test', 'k', 'Ab3dE5gH9z', { action: 'unsubscribe', one_click: true });
    expect(call(1)).toMatchObject({ method: 'POST', body: { action: 'unsubscribe', one_click: true } });
    expect(call(1).headers['X-Storefront-Client-Ip']).toBeUndefined();
  });
});
