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

describe('Phase 5b-2 payment gateways', () => {
  it('connect PUTs mode + credentials to the provider path', async () => {
    const { client, call } = setup(json(200, { data: { provider: 'bkash', status: 'connected', credentials_hint: '••••3f9a' } }));
    const res = await client.paymentGateways.connect('S1', 'bkash', { mode: 'sandbox', credentials: { app_key: 'k', app_secret: 's', username: 'u', password: 'p' } });
    expect(call().method).toBe('PUT');
    expect(call().url.pathname).toBe('/api/v1/stores/S1/payment-gateways/bkash');
    expect(call().body).toEqual({ mode: 'sandbox', credentials: { app_key: 'k', app_secret: 's', username: 'u', password: 'p' } });
    expect(res.credentials_hint).toBe('••••3f9a');
  });

  it('update PATCHes revision + enabled; testPayment sends the Idempotency-Key; disconnect DELETEs', async () => {
    const { client, call } = setup(() => json(200, { data: { payment_id: 'P1', redirect_url: 'https://pay.test/x' } }));
    await client.paymentGateways.update('S1', 'sslcommerz', { revision: 2, enabled: true, is_default: true });
    expect(call(0).method).toBe('PATCH');
    expect(call(0).body).toEqual({ revision: 2, enabled: true, is_default: true });
    const t = await client.paymentGateways.testPayment('S1', 'bkash', 'idem-1');
    expect(call(1).url.pathname).toBe('/api/v1/stores/S1/payment-gateways/bkash/test-payment');
    expect(call(1).headers['Idempotency-Key']).toBe('idem-1');
    expect(t.redirect_url).toBe('https://pay.test/x');
  });

  it('disconnect DELETEs and surfaces 409 gateway_busy', async () => {
    const { client, call } = setup(json(409, { error: { code: 'gateway_busy', message: 'Pending payments' } }));
    await expect(client.paymentGateways.disconnect('S1', 'bkash')).rejects.toMatchObject({ status: 409, code: 'gateway_busy' });
    expect(call().method).toBe('DELETE');
  });
});

describe('Phase 5b-2 payment links and gateway refunds', () => {
  it('create POSTs the input with an Idempotency-Key', async () => {
    const { client, call } = setup(json(201, { data: { id: 'L1', url: 'https://shop.test/pay/abc' } }));
    const input = { amount_kind: 'percent' as const, percent_bps: 2500, provider: 'bkash' as const, expires_in_minutes: 120 as const, cancel_if_unpaid: true, send_sms: true };
    await client.paymentLinks.create('S1', 'O1', input, 'idem-2');
    expect(call().url.pathname).toBe('/api/v1/stores/S1/orders/O1/payment-links');
    expect(call().headers['Idempotency-Key']).toBe('idem-2');
    expect(call().body).toEqual(input);
  });

  it('resend POSTs and cancel DELETEs the link', async () => {
    const { client, call } = setup(() => json(200, { data: { id: 'L1' } }));
    await client.paymentLinks.resend('S1', 'O1', 'L1');
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/orders/O1/payment-links/L1/resend');
    await client.paymentLinks.cancel('S1', 'O1', 'L1');
    expect(call(1).method).toBe('DELETE');
    expect(call(1).url.pathname).toBe('/api/v1/stores/S1/orders/O1/payment-links/L1');
  });

  it('gateway refund sends method gateway + payment_id; cancel carries refund_to_gateway', async () => {
    const { client, call } = setup(() => json(201, { data: { id: 'R1', status: 'pending' } }));
    await client.orders.refund('S1', 'O1', { amount: 50000, method: 'gateway', payment_id: 'P1' }, 'idem-3');
    expect(call(0).body).toEqual({ amount: 50000, method: 'gateway', payment_id: 'P1' });
    await client.orders.cancel('S1', 'O1', { reason: 'customer_request', refund_to_gateway: true });
    expect(call(1).body).toMatchObject({ refund_to_gateway: true });
  });
});
