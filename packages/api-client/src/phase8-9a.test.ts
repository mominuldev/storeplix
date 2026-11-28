import { describe, expect, it, vi } from 'vitest';
import { SMS_SENDER_ID_PATTERN, SMS_TEMPLATE_EVENTS, type SmsTemplateKey } from '@storeplix/types';
import { adminSenderIdQuery, createApiClient, isApiError, smsCreditLedgerQuery, smsLogQuery } from './index';

// PHASE-8-9A (§5–§10, §12): sms.*, billing.smsCredits.*, admin.senderIds.*, admin.smsCredits.*.

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

const base = '/api/v1/stores/S1/sms';

describe('PHASE-8-9A queries and constants', () => {
  it('log filters: comma lists, trimmed phone, dates, cursor', () => {
    expect(smsLogQuery({ purpose: ['order_placed', 'campaign'], status: ['failed'], from: '2026-11-01', to: '2026-11-28', phone: ' 01711552211 ', cursor: 'c2' })).toEqual({
      'filter[purpose]': 'order_placed,campaign', 'filter[status]': 'failed', 'filter[from]': '2026-11-01', 'filter[to]': '2026-11-28',
      'filter[phone]': '01711552211', cursor: 'c2',
    });
    expect(smsLogQuery({})).toEqual({ 'filter[purpose]': undefined, 'filter[status]': undefined, 'filter[from]': undefined, 'filter[to]': undefined, 'filter[phone]': undefined, cursor: undefined });
    expect(smsCreditLedgerQuery({ type: ['purchase', 'admin_adjust'] })).toEqual({ 'filter[type]': 'purchase,admin_adjust', cursor: undefined });
    expect(adminSenderIdQuery({ status: 'pending', q: ' mug ' })).toMatchObject({ 'filter[status]': 'pending', 'filter[q]': 'mug' });
  });

  it('sender ID pattern: 3–11 letters/digits with a letter', () => {
    expect(SMS_SENDER_ID_PATTERN.test('MUGDHO')).toBe(true);
    expect(SMS_SENDER_ID_PATTERN.test('Shop24')).toBe(true);
    expect(SMS_SENDER_ID_PATTERN.test('AB')).toBe(false);
    expect(SMS_SENDER_ID_PATTERN.test('ABCDEFGHIJKL')).toBe(false);
    expect(SMS_SENDER_ID_PATTERN.test('12345')).toBe(false);
    expect(SMS_SENDER_ID_PATTERN.test('MY SHOP')).toBe(false);
    expect(SMS_TEMPLATE_EVENTS).toContain('pos_receipt');
    expect(SMS_TEMPLATE_EVENTS).not.toContain('checkout_otp' as never);
  });
});

describe('PHASE-8-9A merchant api-client', () => {
  it('overview, test SMS, log', async () => {
    const { client, call } = setup(() => json(200, { data: {} }));
    await client.sms.overview('S1');
    expect(call(0).url.pathname).toBe(base);
    await client.sms.sendTest('S1', { language: 'en' });
    expect(call(1)).toMatchObject({ method: 'POST', body: { language: 'en' } });
    expect(call(1).url.pathname).toBe(`${base}/test`);
    const log = setup(() => json(200, { data: [{ id: 'M1' }], meta: { next_cursor: 'n', prev_cursor: null, per_page: 50 } }));
    const page = await log.client.sms.messages('S1', { status: ['sent'] });
    expect(log.call(0).url.pathname).toBe(`${base}/messages`);
    expect(log.call(0).url.searchParams.get('filter[status]')).toBe('sent');
    expect(page.meta.next_cursor).toBe('n');
  });

  it('templates: list, update (PUT with revision), reset (DELETE), preview', async () => {
    const { client, call } = setup(() => json(200, { data: {} }));
    const key: SmsTemplateKey = 'order_confirmed';
    await client.sms.templates.list('S1');
    expect(call(0).url.pathname).toBe(`${base}/templates`);
    await client.sms.templates.update('S1', key, 'bn', { body: '{shop}: অর্ডার {number} কনফার্ম।', revision: 2 });
    expect(call(1)).toMatchObject({ method: 'PUT', body: { body: '{shop}: অর্ডার {number} কনফার্ম।', revision: 2 } });
    expect(call(1).url.pathname).toBe(`${base}/templates/order_confirmed/bn`);
    await client.sms.templates.reset('S1', key, 'en');
    expect(call(2)).toMatchObject({ method: 'DELETE' });
    expect(call(2).url.pathname).toBe(`${base}/templates/order_confirmed/en`);
    await client.sms.templates.preview('S1', { key, language: 'en', body: 'Hi {first_name}' });
    expect(call(3)).toMatchObject({ method: 'POST', body: { key, language: 'en', body: 'Hi {first_name}' } });
  });

  it('sender IDs: list and cancel; template errors carry details', async () => {
    const { client, call } = setup(() => json(200, { data: { active: null, pending: null, history: [] } }));
    await client.sms.senderIds.list('S1');
    expect(call(0).url.pathname).toBe(`${base}/sender-ids`);
    await client.sms.senderIds.cancel('S1', 'SID1');
    expect(call(1)).toMatchObject({ method: 'POST' });
    expect(call(1).url.pathname).toBe(`${base}/sender-ids/SID1/cancel`);
    const err = setup(() => json(422, { error: { code: 'sms_template_too_long', message: 'Too long.', details: { parts: 4, max_parts: 3 } } }));
    const e = await err.client.sms.templates.update('S1', 'order_placed', 'bn', { body: 'x' }).catch((x: unknown) => x);
    expect(isApiError(e) && e.code).toBe('sms_template_too_long');
    expect(isApiError(e) && e.details?.parts).toBe(4);
  });

  it('billing.smsCredits: get, update threshold, ledger, purchase with Idempotency-Key', async () => {
    const { client, call } = setup(() => json(200, { data: {} }));
    await client.billing.smsCredits.get();
    expect(call(0).url.pathname).toBe('/api/v1/billing/sms-credits');
    expect(call(0).headers['X-Tenant-Id']).toBe('T1');
    await client.billing.smsCredits.update({ low_credit_threshold: 200 });
    expect(call(1)).toMatchObject({ method: 'PATCH', body: { low_credit_threshold: 200 } });
    await client.billing.smsCredits.update({ low_credit_threshold: null });
    expect(call(2).body).toEqual({ low_credit_threshold: null });
    await client.billing.smsCredits.purchase({ pack: 'credits_5000', provider: 'bkash' }, 'buy-key-1');
    expect(call(3)).toMatchObject({ method: 'POST', body: { pack: 'credits_5000', provider: 'bkash' } });
    expect(call(3).url.pathname).toBe('/api/v1/billing/sms-credits/purchase');
    expect(call(3).headers['Idempotency-Key']).toBe('buy-key-1');
    const ledger = setup(() => json(200, { data: [] }));
    const page = await ledger.client.billing.smsCredits.ledger({ type: ['consume'] });
    expect(ledger.call(0).url.searchParams.get('filter[type]')).toBe('consume');
    expect(page.meta.per_page).toBe(50);
  });
});

describe('PHASE-8-9A admin api-client', () => {
  it('sender-ID review: list, approve, reject, revoke without X-Tenant-Id', async () => {
    const { client, call } = setup(() => json(200, { data: [], meta: { current_page: 1, per_page: 25, total: 0, last_page: 1, counts: { pending: 3 } } }));
    const page = await client.admin.senderIds.list();
    expect(call(0).url.pathname).toBe('/api/v1/admin/sender-ids');
    expect(call(0).headers['X-Tenant-Id']).toBeUndefined();
    expect(page.meta.counts.pending).toBe(3);
    await client.admin.senderIds.approve('SID1', { provider_registered: true, reason: 'Registered on REVE' });
    expect(call(1)).toMatchObject({ method: 'POST', body: { provider_registered: true, reason: 'Registered on REVE' } });
    expect(call(1).url.pathname).toBe('/api/v1/admin/sender-ids/SID1/approve');
    await client.admin.senderIds.reject('SID1', { reason: 'Licence is unreadable' });
    expect(call(2).url.pathname).toBe('/api/v1/admin/sender-ids/SID1/reject');
    await client.admin.senderIds.revoke('SID1', 'BTRC withdrew it');
    expect(call(3).body).toEqual({ reason: 'BTRC withdrew it' });
  });

  it('merchant SMS credits: get, ledger, adjust with Idempotency-Key', async () => {
    const { client, call } = setup(() => json(200, { data: {} }));
    await client.admin.smsCredits.get('TN1');
    expect(call(0).url.pathname).toBe('/api/v1/admin/tenants/TN1/sms-credits');
    await client.admin.smsCredits.ledger('TN1', { type: ['admin_adjust'] });
    expect(call(1).url.searchParams.get('filter[type]')).toBe('admin_adjust');
    await client.admin.smsCredits.adjust('TN1', { credits: -200, reason: 'Refunded pack' }, 'adj-key');
    expect(call(2)).toMatchObject({ method: 'POST', body: { credits: -200, reason: 'Refunded pack' } });
    expect(call(2).headers['Idempotency-Key']).toBe('adj-key');
  });
});

describe('PHASE-8-9A purchase history', () => {
  it('billing.invoices filter[kind] as a comma list (sms_credits)', async () => {
    const { client, call } = setup(() => json(200, { data: [], meta: { current_page: 1, per_page: 25, total: 0, last_page: 1, providers: [] } }));
    await client.billing.invoices({ kind: ['sms_credits'] });
    expect(call(0).url.pathname).toBe('/api/v1/billing/invoices');
    expect(call(0).url.searchParams.get('filter[kind]')).toBe('sms_credits');
    await client.billing.invoices();
    expect(call(1).url.searchParams.has('filter[kind]')).toBe(false);
  });
});
