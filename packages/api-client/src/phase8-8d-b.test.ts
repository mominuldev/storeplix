import { describe, expect, it, vi } from 'vitest';
import { POS_HELD_NOTE_MAX, POS_HELD_SALES_MAX } from '@storeplix/types';
import { createApiClient, isApiError, posSaleListQuery } from './index';

// PHASE-8-8D part B (§9, §10, §12): pos.sales.list / returns, pos.held.*.

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

describe('PHASE-8-8D part B queries', () => {
  it('history filters; from/to only for custom', () => {
    expect(posSaleListQuery({ date: 'today', register_id: 'R1', method: 'split', q: ' MF-2232 ', cursor: 'c2' })).toEqual({
      'filter[date]': 'today', from: undefined, to: undefined, 'filter[register_id]': 'R1', 'filter[method]': 'split', q: 'MF-2232', cursor: 'c2',
    });
    expect(posSaleListQuery({ date: 'custom', from: '2026-11-01', to: '2026-11-25' })).toMatchObject({ from: '2026-11-01', to: '2026-11-25' });
    expect(posSaleListQuery({ date: '7d', from: '2026-11-01' }).from).toBeUndefined();
    expect(POS_HELD_SALES_MAX).toBe(20);
    expect(POS_HELD_NOTE_MAX).toBe(120);
  });
});

describe('PHASE-8-8D part B api-client', () => {
  it('sales.list unwraps summary + cursor (and falls back)', async () => {
    const summary = { sales_amount: 2281000, receipts_count: 14, average_sale_amount: 162929, returns_count: 1, returns_amount: 45000 };
    const { client, call } = setup(() => json(200, { data: [{ id: 'SALE1' }], meta: { next_cursor: 'n', prev_cursor: null, per_page: 25, summary } }));
    const page = await client.pos.sales.list('S1', { date: 'today', register_id: 'R1' });
    expect(call(0).url.pathname).toBe(`${base}/sales`);
    expect(call(0).url.searchParams.get('filter[date]')).toBe('today');
    expect(call(0).url.searchParams.get('filter[register_id]')).toBe('R1');
    expect(page.meta.summary).toEqual(summary);
    const empty = setup(() => json(200, { data: [] }));
    expect((await empty.client.pos.sales.list('S1')).meta.summary.receipts_count).toBe(0);
  });

  it('returns send the Idempotency-Key and body', async () => {
    const { client, call } = setup(() => json(201, { data: { sale: { id: 'SALE1' } } }));
    const input = { session_id: 'PS1', lines: [{ order_item_id: 'OI1', quantity: 1 }], refund_method: 'cash' as const, reason: 'Wrong size' };
    await client.pos.sales.returns('S1', 'SALE1', input, 'ret-key');
    expect(call(0)).toMatchObject({ method: 'POST', body: input });
    expect(call(0).url.pathname).toBe(`${base}/sales/SALE1/returns`);
    expect(call(0).headers['Idempotency-Key']).toBe('ret-key');
  });

  it('held: list by register, get, create, delete', async () => {
    const { client, call } = setup(() => json(200, { data: [] }));
    await client.pos.held.list('S1', 'R1');
    expect(call(0).url.pathname).toBe(`${base}/held-sales`);
    expect(call(0).url.searchParams.get('register_id')).toBe('R1');
    await client.pos.held.get('S1', 'H1');
    expect(call(1).url.pathname).toBe(`${base}/held-sales/H1`);
    await client.pos.held.create('S1', { session_id: 'PS1', lines: [{ variant_id: 'V1', quantity: 2 }], note: 'Gone to ATM' });
    expect(call(2)).toMatchObject({ method: 'POST', body: { session_id: 'PS1', note: 'Gone to ATM' } });
    await client.pos.held.delete('S1', 'H1');
    expect(call(3)).toMatchObject({ method: 'DELETE' });
    expect(call(3).url.pathname).toBe(`${base}/held-sales/H1`);
  });

  it('surfaces held_sales_limit and drawer_short', async () => {
    const { client } = setup(() => json(409, { error: { code: 'held_sales_limit', message: 'Up to 20 held sales.' } }));
    const e = await client.pos.held.create('S1', { session_id: 'PS1', lines: [] }).catch((x: unknown) => x);
    expect(isApiError(e) && e.code).toBe('held_sales_limit');
    const short = setup(() => json(422, { error: { code: 'drawer_short', message: 'Not enough cash in the drawer.', details: { cash_in_drawer_amount: 10000 } } }));
    const e2 = await short.client.pos.sales.returns('S1', 'SALE1', { session_id: 'PS1', lines: [], refund_method: 'cash' }, 'k').catch((x: unknown) => x);
    expect(isApiError(e2) && e2.code).toBe('drawer_short');
    expect(isApiError(e2) && e2.details?.cash_in_drawer_amount).toBe(10000);
  });
});
