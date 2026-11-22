import { describe, expect, it, vi } from 'vitest';
import { createApiClient, orderListQuery, returnListQuery } from './index';

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setup(response: Response | (() => Response)) {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => (typeof response === 'function' ? response() : response));
  const client = createApiClient({ baseUrl: 'http://api.test', fetch: fetchMock, getTenantId: () => 'T1' });
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

describe('Phase 5b query mappers', () => {
  it('orderListQuery maps the printed filters', () => {
    expect(orderListQuery({ not_printed: 'label' })).toMatchObject({ 'filter[not_printed]': 'label' });
    expect(orderListQuery({ printed: 'invoice' })['filter[printed]']).toBe('invoice');
    expect(orderListQuery({})['filter[printed]']).toBeUndefined();
  });

  it('returnListQuery maps status, type, reason and provider lists', () => {
    expect(returnListQuery({ status: ['open'], type: ['exchange'], reason: ['damaged', 'wrong_size'], provider: ['steadfast'], q: ' RT-1 ', page: 2 })).toMatchObject({
      'filter[status]': 'open',
      'filter[type]': 'exchange',
      'filter[reason]': 'damaged,wrong_size',
      'filter[provider]': 'steadfast',
      q: 'RT-1',
      page: 2,
    });
  });
});

describe('Phase 5b order changes', () => {
  it('editItems PUTs the line set and returns meta.notices', async () => {
    const { client, call } = setup(json(200, { data: { id: 'O1', revision: 4 }, meta: { notices: ['Coupon WINTER15 removed'] } }));
    const res = await client.orders.editItems('S1', 'O1', { revision: 3, items: [{ id: 'OI1', quantity: 2 }, { variant_id: 'V9', quantity: 1 }], reason: 'customer_request', notify_customer: true });
    expect(call().method).toBe('PUT');
    expect(call().url.pathname).toBe('/api/v1/stores/S1/orders/O1/items');
    expect(res).toEqual({ order: { id: 'O1', revision: 4 }, notices: ['Coupon WINTER15 removed'] });
  });

  it('quoteItems, restock and createReturn hit their paths', async () => {
    const { client, call } = setup(() => json(200, { data: {} }));
    await client.orders.quoteItems('S1', 'O1', { revision: 1, items: [], reason: 'other' });
    await client.orders.restock('S1', 'O1', { lines: [{ item_id: 'OI1', quantity: 1 }] });
    await client.orders.createReturn('S1', 'O1', { type: 'return', reason: 'damaged', lines: [{ order_item_id: 'OI1', quantity: 1 }] });
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/orders/O1/items/quote');
    expect(call(1).url.pathname).toBe('/api/v1/stores/S1/orders/O1/restock');
    expect(call(2).url.pathname).toBe('/api/v1/stores/S1/orders/O1/returns');
    expect(call(2).body.lines).toEqual([{ order_item_id: 'OI1', quantity: 1 }]);
  });
});

describe('Phase 5b returns', () => {
  it('list falls back to zero counts and KPIs', async () => {
    const { client } = setup(json(200, { data: [] }));
    const res = await client.returns.list('S1', { status: ['requested'] });
    expect(res.meta.counts.open).toBe(0);
    expect(res.meta.kpis.return_rate_30d).toBeNull();
  });

  it('transitions POST to their own paths; exchange-order sends the Idempotency-Key', async () => {
    const { client, call } = setup(() => json(200, { data: { id: 'R1' } }));
    await client.returns.approve('S1', 'R1', { pickup_tracking_code: 'SF-1' });
    await client.returns.reject('S1', 'R1', { reason: 'Used item' });
    await client.returns.receive('S1', 'R1', { checks: { tags_intact: true, unused: true, original_packaging: false }, lines: [{ return_item_id: 'RI1', restock_quantity: 1 }] });
    await client.returns.close('S1', 'R1');
    await client.returns.exchangeOrder('S1', 'R1', { shipping_amount_override: null }, 'key-x');
    await client.returns.addNote('S1', 'R1', 'Called');
    expect([0, 1, 2, 3, 4, 5].map((i) => call(i).url.pathname.replace('/api/v1/stores/S1/returns/R1', ''))).toEqual(['/approve', '/reject', '/receive', '/close', '/exchange-order', '/notes']);
    expect(call(4).headers['Idempotency-Key']).toBe('key-x');
    expect(call(5).body).toEqual({ body: 'Called' });
  });
});

describe('Phase 5b documents', () => {
  it('create, get, preview and saveTemplate', async () => {
    const { client, call } = setup(() => json(202, { data: { id: 'D1', status: 'queued' } }));
    await client.documents.create('S1', { kind: 'label_4x6', order_ids: ['O1', 'O2'] });
    await client.documents.get('S1', 'D1');
    await client.documents.preview('S1', { kind: 'invoice_a4', order_id: 'O1' });
    await client.documents.saveTemplate('S1', 'label_4x6', { revision: 2, config: { show_logo: true, show_bin: false, show_product_names: true, show_prices: false, show_sku: false, language: 'bn', footer_text: null } });
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/documents');
    expect(call(0).body).toEqual({ kind: 'label_4x6', order_ids: ['O1', 'O2'] });
    expect(call(1).url.pathname).toBe('/api/v1/stores/S1/documents/D1');
    expect(call(2).url.pathname).toBe('/api/v1/stores/S1/documents/preview');
    expect(call(3).method).toBe('PUT');
    expect(call(3).url.pathname).toBe('/api/v1/stores/S1/document-templates/label_4x6');
  });
});
