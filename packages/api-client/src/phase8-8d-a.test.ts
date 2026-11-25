import { describe, expect, it, vi } from 'vitest';
import type { PosSaleInput } from '@storeplix/types';
import { POS_BDT_DENOMINATIONS, POS_PAYMENT_METHOD_LABELS, PERMISSION_KEYS, SYSTEM_ROLE_PERMISSIONS } from '@storeplix/types';
import { createApiClient, isApiError, orderListQuery, posCatalogQuery, posRegisterListQuery } from './index';

// PHASE-8-8D part A (§10, §12): pos.registers.*, pos.sessions.*, pos.catalog, pos.lookup, pos.customerLookup,
// pos.quote, pos.sales.create/get/smsReceipt, orders `filter[created_via]`.

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

const base = '/api/v1/stores/S1/pos';

describe('PHASE-8-8D types', () => {
  it('pos.sell is catalogued after orders.refund and granted to staff', () => {
    expect(PERMISSION_KEYS.indexOf('pos.sell')).toBe(PERMISSION_KEYS.indexOf('orders.refund') + 1);
    expect(SYSTEM_ROLE_PERMISSIONS.staff).toContain('pos.sell');
    expect(POS_BDT_DENOMINATIONS[0]).toBe(100000);
    expect(POS_PAYMENT_METHOD_LABELS.bkash_personal).toBe('bKash');
  });
});

describe('PHASE-8-8D queries', () => {
  it('orders created_via filter is a comma list', () => {
    expect(orderListQuery({ created_via: ['pos'] })['filter[created_via]']).toBe('pos');
    expect(orderListQuery({ created_via: ['storefront', 'dashboard'] })['filter[created_via]']).toBe('storefront,dashboard');
    expect(orderListQuery({})['filter[created_via]']).toBeUndefined();
  });

  it('catalog and register list queries', () => {
    expect(posCatalogQuery({ register_id: 'R1', q: '  jam ', category_id: 'C1', cursor: 'abc' })).toEqual({
      register_id: 'R1', q: 'jam', 'filter[category_id]': 'C1', cursor: 'abc',
    });
    expect(posCatalogQuery({ register_id: 'R1', q: ' ' })).toEqual({ register_id: 'R1', q: undefined, 'filter[category_id]': undefined, cursor: undefined });
    expect(posRegisterListQuery({ archived: true })['filter[archived]']).toBe('true');
    expect(posRegisterListQuery()['filter[archived]']).toBeUndefined();
  });
});

describe('PHASE-8-8D api-client', () => {
  it('registers: list, create, update, archive, unarchive', async () => {
    const { client, call } = setup(() => json(200, { data: [] }));
    await client.pos.registers.list('S1');
    expect(call(0).url.pathname).toBe(`${base}/registers`);
    await client.pos.registers.list('S1', { archived: true });
    expect(call(1).url.searchParams.get('filter[archived]')).toBe('true');
    await client.pos.registers.create('S1', { name: 'Register 1', location_id: 'L1' });
    expect(call(2)).toMatchObject({ method: 'POST', body: { name: 'Register 1', location_id: 'L1' } });
    await client.pos.registers.update('S1', 'R1', { name: 'Front' });
    expect(call(3)).toMatchObject({ method: 'PATCH', body: { name: 'Front' } });
    expect(call(3).url.pathname).toBe(`${base}/registers/R1`);
    await client.pos.registers.archive('S1', 'R1');
    expect(call(4).url.pathname).toBe(`${base}/registers/R1/archive`);
    await client.pos.registers.unarchive('S1', 'R1');
    expect(call(5).url.pathname).toBe(`${base}/registers/R1/unarchive`);
  });

  it('open and close send the Idempotency-Key', async () => {
    const { client, call } = setup(() => json(201, { data: { id: 'PS1' } }));
    await client.pos.registers.open('S1', 'R1', { counts: { '100000': 1 } }, 'key-open');
    expect(call(0).url.pathname).toBe(`${base}/registers/R1/open`);
    expect(call(0).headers['Idempotency-Key']).toBe('key-open');
    expect(call(0).body).toEqual({ counts: { '100000': 1 } });
    await client.pos.sessions.close('S1', 'PS1', { counted_cash_amount: 1480000, left_in_drawer_amount: 200000, note: null, revision: 3 }, 'key-close');
    expect(call(1).url.pathname).toBe(`${base}/sessions/PS1/close`);
    expect(call(1).headers['Idempotency-Key']).toBe('key-close');
    await client.pos.sessions.get('S1', 'PS1');
    expect(call(2)).toMatchObject({ method: 'GET' });
    expect(call(2).url.pathname).toBe(`${base}/sessions/PS1`);
  });

  it('catalog unwraps cursor meta; lookup and customer lookup', async () => {
    const { client, call } = setup(() => json(200, { data: [{ product_id: 'P1' }], meta: { next_cursor: 'n2', prev_cursor: null, per_page: 40 } }));
    const page = await client.pos.catalog('S1', { register_id: 'R1', category_id: 'C1' });
    expect(page.meta.next_cursor).toBe('n2');
    expect(page.data).toHaveLength(1);
    expect(call(0).url.searchParams.get('filter[category_id]')).toBe('C1');
    await client.pos.lookup('S1', { register_id: 'R1', code: 'JT-001' });
    expect(call(1).url.pathname).toBe(`${base}/lookup`);
    expect(call(1).url.searchParams.get('code')).toBe('JT-001');
    await client.pos.customerLookup('S1', '01711552211');
    expect(call(2).url.pathname).toBe(`${base}/customers/lookup`);
    expect(call(2).url.searchParams.get('phone')).toBe('01711552211');
  });

  it('catalog without meta falls back to an empty cursor', async () => {
    const { client } = setup(() => json(200, { data: [] }));
    const page = await client.pos.catalog('S1', { register_id: 'R1' });
    expect(page.meta).toEqual({ next_cursor: null, prev_cursor: null, per_page: 40 });
  });

  it('quote, sale create/get and SMS receipt', async () => {
    const { client, call } = setup(() => json(201, { data: { id: 'SALE1' } }));
    await client.pos.quote('S1', { session_id: 'PS1', lines: [{ variant_id: 'V1', quantity: 2 }], coupon_code: 'LOYAL5' });
    expect(call(0)).toMatchObject({ method: 'POST', body: { session_id: 'PS1', coupon_code: 'LOYAL5' } });
    expect(call(0).url.pathname).toBe(`${base}/quote`);
    const input: PosSaleInput = {
      session_id: 'PS1', lines: [{ variant_id: 'V1', quantity: 2 }], expected_total_amount: 456000,
      payments: [{ method: 'cash', amount: 456000 }], tendered_cash_amount: 500000, sms_receipt: false,
    };
    await client.pos.sales.create('S1', input, 'sale-key');
    expect(call(1).url.pathname).toBe(`${base}/sales`);
    expect(call(1).headers['Idempotency-Key']).toBe('sale-key');
    expect(call(1).body).toEqual(input);
    await client.pos.sales.get('S1', 'SALE1');
    expect(call(2).url.pathname).toBe(`${base}/sales/SALE1`);
    await client.pos.sales.smsReceipt('S1', 'SALE1');
    expect(call(3)).toMatchObject({ method: 'POST' });
    expect(call(3).url.pathname).toBe(`${base}/sales/SALE1/sms-receipt`);
  });

  it('surfaces POS error codes', async () => {
    const { client } = setup(() => json(409, { error: { code: 'register_already_open', message: 'Already open.', details: { session_id: 'PS9' } } }));
    const error = await client.pos.registers.open('S1', 'R1', { opening_cash_amount: 0 }, 'k').catch((e: unknown) => e);
    expect(isApiError(error) && error.code).toBe('register_already_open');
    expect(isApiError(error) && error.details).toEqual({ session_id: 'PS9' });
  });
});
