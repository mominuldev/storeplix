import { describe, expect, it, vi } from 'vitest';
import {
  PLATFORM_SMS_AUDIT_ACTIONS,
  PLATFORM_SMS_LOCKED_TYPES,
  PLATFORM_SMS_PURPOSES,
  PLATFORM_SMS_TYPE_GROUP,
  PLATFORM_SMS_TYPES,
  SMS_MESSAGE_GROUPS,
  SMS_PRIMARY_REQUIRED_GROUPS,
  type CreateSmsProviderInput,
} from '@storeplix/types';
import { createApiClient, platformSmsBroadcastQuery, platformSmsLogQuery } from './index';

// PHASE-8-9B (§4–§8, §10): admin.platformSms.* (manage_settings), account.smsPreferences, platformSms opt-out.

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

const base = '/api/v1/admin/sms';

describe('PHASE-8-9B constants and queries', () => {
  it('catalogue: nine types, locked codes keep their otp_* purposes, groups', () => {
    expect(PLATFORM_SMS_TYPES).toHaveLength(9);
    expect(PLATFORM_SMS_LOCKED_TYPES).toEqual(['phone_verification', 'sign_in_code', 'password_reset_code']);
    expect(PLATFORM_SMS_PURPOSES.sign_in_code).toBe('otp_login');
    expect(PLATFORM_SMS_PURPOSES.phone_verification).toBe('otp_verify_phone');
    expect(PLATFORM_SMS_PURPOSES.invoice_issued).toBe('platform_invoice_issued');
    expect(PLATFORM_SMS_TYPE_GROUP.broadcast).toBe('promotional');
    expect(SMS_MESSAGE_GROUPS).toContain('shop');
    expect(SMS_PRIMARY_REQUIRED_GROUPS).not.toContain('promotional');
    expect(PLATFORM_SMS_AUDIT_ACTIONS).toContain('sms_provider.credentials_rotated');
  });

  it('log and broadcast queries', () => {
    expect(platformSmsLogQuery({ q: ' 01711552211 ', status: ['failed', 'queued'], group: ['billing'], from: '2026-11-01', cursor: 'c' })).toEqual({
      'filter[q]': '01711552211', 'filter[status]': 'failed,queued', 'filter[group]': 'billing', 'filter[from]': '2026-11-01',
      'filter[to]': undefined, cursor: 'c',
    });
    expect(platformSmsLogQuery({})).toEqual({
      'filter[q]': undefined, 'filter[status]': undefined, 'filter[group]': undefined, 'filter[from]': undefined, 'filter[to]': undefined, cursor: undefined,
    });
    expect(platformSmsBroadcastQuery({ status: ['scheduled', 'draft'], page: 2 })).toEqual({ 'filter[status]': 'scheduled,draft', page: 2, per_page: undefined });
  });
});

describe('PHASE-8-9B admin providers', () => {
  it('overview, drivers, alerts without X-Tenant-Id', async () => {
    const { client, call } = setup(() => json(200, { data: {} }));
    await client.admin.platformSms.providers.overview();
    expect(call(0).url.pathname).toBe(`${base}/providers`);
    expect(call(0).headers['X-Tenant-Id']).toBeUndefined();
    await client.admin.platformSms.drivers();
    expect(call(1).url.pathname).toBe(`${base}/drivers`);
    await client.admin.platformSms.alerts();
    expect(call(2).url.pathname).toBe(`${base}/alerts`);
  });

  it('create, update, test, activate (typed name), rotate, remove, refresh balance', async () => {
    const { client, call } = setup(() => json(200, { data: {} }));
    const input: CreateSmsProviderInput = {
      driver: 'revesms', name: 'REVE SMS', credentials: { api_key: 'k-123456', secret_key: 's-abcdef' },
      settings: { account_id: 'ACC1', base_url: 'https://smpp.revesms.com:7790', http: null },
      default_sender_id: 'Storeplix', message_groups: ['shop', 'registration', 'billing', 'security', 'promotional'],
    };
    await client.admin.platformSms.providers.create(input);
    expect(call(0)).toMatchObject({ method: 'POST', body: input });
    await client.admin.platformSms.providers.update('P1', { revision: 3, rate_limit_per_minute: 200 });
    expect(call(1)).toMatchObject({ method: 'PATCH', body: { revision: 3, rate_limit_per_minute: 200 } });
    expect(call(1).url.pathname).toBe(`${base}/providers/P1`);
    await client.admin.platformSms.providers.test('P1', { phone: '01711552211' });
    expect(call(2)).toMatchObject({ method: 'POST', body: { phone: '01711552211' } });
    expect(call(2).url.pathname).toBe(`${base}/providers/P1/test`);
    await client.admin.platformSms.providers.activate('P1', { role: 'primary', confirm_name: 'REVE SMS' });
    expect(call(3).body).toEqual({ role: 'primary', confirm_name: 'REVE SMS', keep_previous_as_failover: true });
    await client.admin.platformSms.providers.activate('P2', { role: 'failover' });
    expect(call(4).body).toEqual({ role: 'failover', confirm_name: null, keep_previous_as_failover: true });
    await client.admin.platformSms.providers.rotate('P1', { credentials: { secret_key: 'new-secret' }, phone: '01711552211' });
    expect(call(5)).toMatchObject({ method: 'POST', body: { credentials: { secret_key: 'new-secret' }, settings: null, phone: '01711552211' } });
    expect(call(5).url.pathname).toBe(`${base}/providers/P1/rotate`);
    await client.admin.platformSms.providers.remove('P2', { confirm_name: 'SSL Wireless' });
    expect(call(6)).toMatchObject({ method: 'POST', body: { confirm_name: 'SSL Wireless' } });
    expect(call(6).url.pathname).toBe(`${base}/providers/P2/remove`);
    await client.admin.platformSms.providers.refreshBalance('P1');
    expect(call(7).url.pathname).toBe(`${base}/providers/P1/refresh-balance`);
  });
});

describe('PHASE-8-9B admin message types', () => {
  it('list with meta, toggle, template PUT/DELETE, preview, test', async () => {
    const meta = { kpis: { sent_this_month: 10, codes_this_month: 4, promotional_this_month: 2, cost_this_month_paisa: 900 }, groups: [] };
    const { client, call } = setup(() => json(200, { data: [], meta }));
    const page = await client.admin.platformSms.messageTypes.list();
    expect(call(0).url.pathname).toBe(`${base}/message-types`);
    expect(page.meta.kpis.codes_this_month).toBe(4);
    await client.admin.platformSms.messageTypes.update('welcome', { enabled: false });
    expect(call(1)).toMatchObject({ method: 'PATCH', body: { enabled: false } });
    expect(call(1).url.pathname).toBe(`${base}/message-types/welcome`);
    await client.admin.platformSms.messageTypes.updateTemplate('invoice_issued', 'bn', { body: 'Store Plix: {invoice_no} {link}', revision: 0 });
    expect(call(2)).toMatchObject({ method: 'PUT', body: { body: 'Store Plix: {invoice_no} {link}', revision: 0 } });
    expect(call(2).url.pathname).toBe(`${base}/message-types/invoice_issued/templates/bn`);
    await client.admin.platformSms.messageTypes.resetTemplate('invoice_issued', 'en');
    expect(call(3)).toMatchObject({ method: 'DELETE' });
    await client.admin.platformSms.messageTypes.preview({ type: 'welcome', language: 'en', body: 'Hi {merchant_name}' });
    expect(call(4).url.pathname).toBe(`${base}/message-types/preview`);
    await client.admin.platformSms.messageTypes.test('welcome', { language: 'en', phone: '01711552211' });
    expect(call(5).body).toEqual({ language: 'en', phone: '01711552211', body: null });
  });
});

describe('PHASE-8-9B admin broadcasts and log', () => {
  it('list with kpis, estimate, create, schedule (typed count), cancel, recipients', async () => {
    const { client, call } = setup(() =>
      json(200, { data: [], meta: { current_page: 1, per_page: 25, total: 0, last_page: 1, kpis: { broadcasts_this_month: 1, sent_success_rate: 98.5, opted_out_total: 3, spend_this_month_paisa: 5000 } } }),
    );
    const page = await client.admin.platformSms.broadcasts.list({ status: ['scheduled'] });
    expect(call(0).url.searchParams.get('filter[status]')).toBe('scheduled');
    expect(page.meta.kpis.sent_success_rate).toBe(98.5);
    const audience = { kind: 'plan' as const, plans: ['starter'] };
    await client.admin.platformSms.broadcasts.estimate({ audience, body_bn: 'অফার', body_en: 'Offer' });
    expect(call(1)).toMatchObject({ method: 'POST', body: { audience, body_bn: 'অফার', body_en: 'Offer' } });
    expect(call(1).url.pathname).toBe(`${base}/broadcasts/estimate`);
    await client.admin.platformSms.broadcasts.create({ name: 'Eid', body_bn: 'অফার', body_en: 'Offer', audience, scheduled_at: null });
    expect(call(2).url.pathname).toBe(`${base}/broadcasts`);
    await client.admin.platformSms.broadcasts.schedule('B1', { acknowledged: true, confirm_recipients: 412, revision: 2 });
    expect(call(3).body).toEqual({ acknowledged: true, confirm_recipients: 412, revision: 2 });
    expect(call(3).url.pathname).toBe(`${base}/broadcasts/B1/schedule`);
    await client.admin.platformSms.broadcasts.cancel('B1');
    expect(call(4).url.pathname).toBe(`${base}/broadcasts/B1/cancel`);
    await client.admin.platformSms.broadcasts.recipients('B1', { status: ['skipped'] });
    expect(call(5).url.searchParams.get('filter[status]')).toBe('skipped');
    await client.admin.platformSms.broadcasts.audiences();
    expect(call(6).url.pathname).toBe(`${base}/broadcasts/audiences`);
  });

  it('log with filters and CSV export', async () => {
    const log = setup(() => json(200, { data: [], meta: { next_cursor: null, prev_cursor: null, per_page: 50 } }));
    await log.client.admin.platformSms.messages({ group: ['security'] });
    expect(log.call(0).url.pathname).toBe(`${base}/messages`);
    expect(log.call(0).url.searchParams.get('filter[group]')).toBe('security');
    const csv = setup(() => new Response('a,b\n', { status: 200, headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="platform-sms-2026-11-28.csv"' } }));
    const file = await csv.client.admin.platformSms.exportMessages({ status: ['failed'] });
    expect(csv.call(0).url.pathname).toBe(`${base}/messages/export`);
    expect(csv.call(0).url.searchParams.get('filter[status]')).toBe('failed');
    expect(file.filename).toBe('platform-sms-2026-11-28.csv');
  });
});

describe('PHASE-8-9B merchant opt-out', () => {
  it('account sms-preferences without X-Tenant-Id; public opt-out lookup and POST', async () => {
    const { client, call } = setup(() => json(200, { data: { promotional: false } }));
    await client.account.smsPreferences.get();
    expect(call(0).url.pathname).toBe('/api/v1/account/sms-preferences');
    expect(call(0).headers['X-Tenant-Id']).toBeUndefined();
    await client.account.smsPreferences.update({ promotional: false });
    expect(call(1)).toMatchObject({ method: 'PATCH', body: { promotional: false } });
    await client.platformSms.optOutLookup('Ab12Cd34Ef');
    expect(call(2)).toMatchObject({ method: 'GET' });
    expect(call(2).url.pathname).toBe('/api/v1/platform-sms/opt-out/Ab12Cd34Ef');
    await client.platformSms.optOut('Ab12Cd34Ef');
    expect(call(3)).toMatchObject({ method: 'POST' });
  });
});
