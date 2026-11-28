import { describe, expect, it, vi } from 'vitest';
import {
  AI_CREDIT_COSTS,
  BROWSER_TRACKING_EVENTS,
  GA4_MEASUREMENT_ID_PATTERN,
  GTM_CONTAINER_ID_PATTERN,
  INTEGRATION_PROVIDERS,
  META_PIXEL_ID_PATTERN,
  TIKTOK_PIXEL_ID_PATTERN,
  TRACKING_EVENT_NAMES,
  integrationKind,
  looksLikePastedCode,
  type SaveIntegrationInput,
  type TrackingBeaconInput,
} from '@storeplix/types';
import { aiCreditLedgerQuery, aiGenerationQuery, catalogItemQuery, createApiClient, trackingEventQuery } from './index';

// PHASE-8-9D (§4–§12): integrations.*, integrations.tracking.*, integrations.feeds.*, ai.*, billing.aiCredits.*,
// storefront.tracking.events, admin.aiCredits.*.

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
  return { client, call, fetchMock };
}

const base = '/api/v1/stores/S1/integrations';

describe('PHASE-8-9D constants and validators', () => {
  it('ID patterns accept the documented formats only (P89D-6)', () => {
    expect(META_PIXEL_ID_PATTERN.test('123456789012345')).toBe(true);
    expect(META_PIXEL_ID_PATTERN.test('12345')).toBe(false);
    expect(GA4_MEASUREMENT_ID_PATTERN.test('G-AB12CD34EF')).toBe(true);
    expect(GA4_MEASUREMENT_ID_PATTERN.test('UA-1234-1')).toBe(false);
    expect(TIKTOK_PIXEL_ID_PATTERN.test('C4ABCDEFGHIJKLMNOPQR')).toBe(true);
    expect(TIKTOK_PIXEL_ID_PATTERN.test('c4abc')).toBe(false);
    expect(GTM_CONTAINER_ID_PATTERN.test('GTM-ABC1234')).toBe(true);
  });

  it('pasted code is recognised (rule 7)', () => {
    expect(looksLikePastedCode("<script>!function(f,b,e,v){fbq('init','123')}</script>")).toBe(true);
    expect(looksLikePastedCode("gtag('config', 'G-AB12CD34')")).toBe(true);
    expect(looksLikePastedCode('ttq.load("C4ABCDEFGHIJKLMNOPQR")')).toBe(true);
    expect(looksLikePastedCode('https://www.googletagmanager.com/gtm.js?id=GTM-ABC1234')).toBe(true);
    expect(looksLikePastedCode('123456789012345')).toBe(false);
  });

  it('registry, kinds and event-name map', () => {
    expect(INTEGRATION_PROVIDERS).toHaveLength(8);
    expect(integrationKind('ga4')).toBe('tracking');
    expect(integrationKind('google_merchant')).toBe('feed');
    expect(integrationKind('ai_photos')).toBe('ai');
    expect(BROWSER_TRACKING_EVENTS).not.toContain('purchase');
    expect(TRACKING_EVENT_NAMES.meta_pixel.view_item).toBe('ViewContent');
    expect(TRACKING_EVENT_NAMES.tiktok_pixel.purchase).toBe('CompletePayment');
    expect(TRACKING_EVENT_NAMES.meta_pixel.refund).toBeNull();
    expect(TRACKING_EVENT_NAMES.ga4.refund).toBe('refund');
    expect(AI_CREDIT_COSTS).toEqual({ product_description: 1, photo_edit: 2 });
  });

  it('queries: comma lists, booleans as 1/0, cursor', () => {
    expect(trackingEventQuery({ status: ['failed', 'retrying'], event: ['purchase'], channel: 'server', test: false, cursor: 'c' })).toEqual({
      'filter[status]': 'failed,retrying', 'filter[event]': 'purchase', 'filter[channel]': 'server', 'filter[test]': 0, 'filter[since]': undefined, cursor: 'c',
    });
    expect(catalogItemQuery({ review_status: ['disapproved'], has_issues: true, q: '  saree ' })).toMatchObject({
      'filter[review_status]': 'disapproved', 'filter[has_issues]': 1, q: 'saree',
    });
    expect(aiGenerationQuery({ kind: 'photo_edit', status: ['succeeded', 'applied'] })).toMatchObject({ 'filter[kind]': 'photo_edit', 'filter[status]': 'succeeded,applied' });
    expect(aiCreditLedgerQuery({ type: ['admin_adjust'] })).toEqual({ 'filter[type]': 'admin_adjust', cursor: undefined });
  });
});

describe('PHASE-8-9D merchant api-client', () => {
  it('integrations: list, get, save (PUT), update (PATCH), disconnect (typed), verify', async () => {
    const { client, call } = setup(() => json(200, { data: {} }));
    await client.integrations.list('S1');
    expect(call(0).url.pathname).toBe(base);
    await client.integrations.get('S1', 'meta_pixel');
    expect(call(1).url.pathname).toBe(`${base}/meta_pixel`);
    const input: SaveIntegrationInput<'ga4'> = {
      settings: { measurement_id: 'G-AB12CD34', purchase_trigger: 'order_confirmed', include_delivery_charge: false, wait_for_consent: true, send_customer_data: true, send_refunds: true },
      credentials: { api_secret: 'secret-value' },
    };
    await client.integrations.save('S1', 'ga4', input);
    expect(call(2)).toMatchObject({ method: 'PUT', body: input });
    await client.integrations.update('S1', 'ga4', { settings: { send_refunds: false }, revision: 3 });
    expect(call(3)).toMatchObject({ method: 'PATCH', body: { settings: { send_refunds: false }, revision: 3 } });
    await client.integrations.disconnect('S1', 'meta_catalog');
    expect(call(4)).toMatchObject({ method: 'POST', body: { confirm: 'DISCONNECT' } });
    expect(call(4).url.pathname).toBe(`${base}/meta_catalog/disconnect`);
    await client.integrations.verify('S1', 'tiktok_pixel');
    expect(call(5).url.pathname).toBe(`${base}/tiktok_pixel/verify`);
    expect(call(5).headers['X-Tenant-Id']).toBe('T1');
  });

  it('tracking: test event, test mode, event log, stats', async () => {
    const { client, call } = setup(() => json(200, { data: [], meta: { next_cursor: null, prev_cursor: null, per_page: 50 } }));
    await client.integrations.tracking.sendTest('S1', 'meta_pixel', { event: 'purchase' });
    expect(call(0)).toMatchObject({ method: 'POST', body: { event: 'purchase' } });
    expect(call(0).url.pathname).toBe(`${base}/meta_pixel/test-event`);
    await client.integrations.tracking.startTestMode('S1', 'meta_pixel');
    expect(call(1).url.pathname).toBe(`${base}/meta_pixel/test-mode`);
    const page = await client.integrations.tracking.events('S1', 'gtm_server', { status: ['retrying'] });
    expect(call(2).url.searchParams.get('filter[status]')).toBe('retrying');
    expect(page.meta.per_page).toBe(50);
    await client.integrations.tracking.stats('S1', 'ga4', 30);
    expect(call(3).url.pathname).toBe(`${base}/ga4/stats`);
    expect(call(3).url.searchParams.get('days')).toBe('30');
  });

  it('feeds: oauth start, accounts, choose, overview, sync, runs, items (counts fallback), claim', async () => {
    const { client, call } = setup(() => json(200, { data: [] }));
    await client.integrations.feeds.oauthStart('S1', 'google_merchant');
    expect(call(0)).toMatchObject({ method: 'POST' });
    expect(call(0).url.pathname).toBe(`${base}/google_merchant/oauth/start`);
    await client.integrations.feeds.accounts('S1', 'meta_catalog');
    expect(call(1).url.pathname).toBe(`${base}/meta_catalog/accounts`);
    await client.integrations.feeds.chooseAccount('S1', 'meta_catalog', { create_catalog: true, parent_id: 'B1' });
    expect(call(2)).toMatchObject({ method: 'PUT', body: { create_catalog: true, parent_id: 'B1' } });
    await client.integrations.feeds.overview('S1', 'meta_catalog');
    expect(call(3).url.pathname).toBe(`${base}/meta_catalog/feed`);
    await client.integrations.feeds.syncNow('S1', 'meta_catalog');
    expect(call(4).url.pathname).toBe(`${base}/meta_catalog/sync`);
    await client.integrations.feeds.runs('S1', 'meta_catalog', 'c2');
    expect(call(5).url.searchParams.get('cursor')).toBe('c2');
    const items = await client.integrations.feeds.items('S1', 'google_merchant', { has_issues: true });
    expect(call(6).url.searchParams.get('filter[has_issues]')).toBe('1');
    expect(items.meta.counts.with_issues).toBe(0);
    await client.integrations.feeds.claimWebsite('S1');
    expect(call(7).url.pathname).toBe(`${base}/google_merchant/claim-website`);
  });

  it('ai: idempotent job starts, poll, history, apply, undo', async () => {
    const { client, call } = setup(() => json(202, { data: { id: 'G1', status: 'queued' } }));
    const g = await client.ai.describeProduct('S1', { product_id: 'P1', language: 'bn', tone: 'friendly', variants: 2 }, 'k-1');
    expect(g.status).toBe('queued');
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/ai/product-descriptions');
    expect(call(0).headers['Idempotency-Key']).toBe('k-1');
    await client.ai.editPhoto('S1', { media_id: 'M1', operation: 'replace_background', background: 'studio_white' }, 'k-2');
    expect(call(1)).toMatchObject({ method: 'POST', body: { media_id: 'M1', operation: 'replace_background', background: 'studio_white' } });
    await client.ai.generation('S1', 'G1');
    expect(call(2).url.pathname).toBe('/api/v1/stores/S1/ai/generations/G1');
    await client.ai.generations('S1', { kind: 'photo_edit' });
    expect(call(3).url.searchParams.get('filter[kind]')).toBe('photo_edit');
    await client.ai.applyPhoto('S1', 'G1', { product_id: 'P1', replace_image_id: 'I1' });
    expect(call(4).url.pathname).toBe('/api/v1/stores/S1/ai/photo-edits/G1/apply');
    await client.ai.undoPhoto('S1', 'G1');
    expect(call(5).url.pathname).toBe('/api/v1/stores/S1/ai/photo-edits/G1/undo');
  });

  it('billing.aiCredits: summary and ledger (tenant-level)', async () => {
    const { client, call } = setup(() => json(200, { data: [] }));
    await client.billing.aiCredits.get();
    expect(call(0).url.pathname).toBe('/api/v1/billing/ai-credits');
    await client.billing.aiCredits.ledger({ type: ['consume', 'refund'] });
    expect(call(1).url.searchParams.get('filter[type]')).toBe('consume,refund');
  });

  it('402 ai_credits_exhausted surfaces details', async () => {
    const { client } = setup(() => json(402, { error: { code: 'ai_credits_exhausted', message: 'No AI credits left', details: { needed: 2, available: 0, resets_at: '2026-12-01T00:00:00+06:00' } } }));
    await expect(client.ai.editPhoto('S1', { media_id: 'M1', operation: 'remove_background' }, 'k')).rejects.toMatchObject({
      status: 402, code: 'ai_credits_exhausted', details: { needed: 2 },
    });
  });

  it('Nagad goes through the existing gateway calls', async () => {
    const { client, call } = setup(() => json(200, { data: {} }));
    await client.paymentGateways.connect('S1', 'nagad', {
      mode: 'sandbox',
      credentials: { merchant_id: '683002007104225', merchant_number: '01711000000', merchant_private_key: '-----BEGIN PRIVATE KEY-----x', pg_public_key: '-----BEGIN PUBLIC KEY-----y' },
    });
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/payment-gateways/nagad');
    expect(call(0).method).toBe('PUT');
  });
});

describe('PHASE-8-9D storefront beacon (server-to-server)', () => {
  it('posts events with storefront headers and the client IP', async () => {
    const { client, call } = setup(() => new Response(null, { status: 202 }));
    const input: TrackingBeaconInput = {
      events: [{ event_id: '01JABCDEFGHJKMNPQRSTVWXYZ0', name: 'view_item', occurred_at: '2026-11-28T10:00:00Z', page_path: '/products/saree', variant_id: 'V1' }],
      context: { consent: 'granted', fbp: 'fb.1.1700000000.123', user_agent: 'Mozilla/5.0' },
    };
    await client.storefront.tracking.events('Demo.LocalHost:3010', 'sf-key', input, { clientIp: '203.0.113.9' });
    const c = call(0);
    expect(c.url.pathname).toBe('/api/v1/storefront/tracking/events');
    expect(c.method).toBe('POST');
    expect(c.headers['X-Storefront-Host']).toBe('demo.localhost');
    expect(c.headers['X-Storefront-Key']).toBe('sf-key');
    expect(c.headers['X-Storefront-Client-Ip']).toBe('203.0.113.9');
    expect(c.headers['X-Tenant-Id']).toBeUndefined();
    expect(c.body).toEqual(input);
  });
});

describe('PHASE-8-9D admin AI credits', () => {
  it('get, ledger, adjust with Idempotency-Key', async () => {
    const { client, call } = setup(() => json(200, { data: { tenant_id: 'T9' } }));
    await client.admin.aiCredits.get('T9');
    expect(call(0).url.pathname).toBe('/api/v1/admin/tenants/T9/ai-credits');
    await client.admin.aiCredits.adjust('T9', { credits: 100, reason: 'Goodwill for outage' }, 'idem-1');
    expect(call(1)).toMatchObject({ method: 'POST', body: { credits: 100, reason: 'Goodwill for outage' } });
    expect(call(1).headers['Idempotency-Key']).toBe('idem-1');
    await client.admin.aiCredits.ledger('T9', { type: ['admin_adjust'] });
    expect(call(2).url.searchParams.get('filter[type]')).toBe('admin_adjust');
  });
});
