import { describe, expect, it, vi } from 'vitest';
import { createApiClient, customerListQuery, filenameFromDisposition, inventoryListQuery, movementListQuery, productListQuery } from './index';

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setup(response: Response | (() => Response)) {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
    typeof response === 'function' ? response() : response,
  );
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

describe('Phase 4 query mappers', () => {
  it('productListQuery joins statuses and trims q', () => {
    expect(productListQuery({ status: ['draft', 'archived'], q: '  jam ', stock: 'low', sort: '-price', page: 2 })).toEqual({
      'filter[status]': 'draft,archived',
      'filter[category_id]': undefined,
      'filter[stock]': 'low',
      q: 'jam',
      sort: '-price',
      page: 2,
      per_page: undefined,
    });
    expect(productListQuery({ status: [], q: '  ' })['filter[status]']).toBeUndefined();
  });

  it('inventory, movement and customer mappers use filter[...] keys', () => {
    expect(inventoryListQuery({ stock: ['low', 'out'] })['filter[stock]']).toBe('low,out');
    const m = movementListQuery({ reason: ['received', 'damaged'], created_from: '2026-11-01', created_to: '2026-11-30' });
    expect(m['filter[reason]']).toBe('received,damaged');
    expect(m['filter[created_at][gte]']).toBe('2026-11-01');
    expect(m['filter[created_at][lte]']).toBe('2026-11-30');
    expect(customerListQuery({ channel: ['facebook'], tag: 'vip', q: '0155' })).toMatchObject({ 'filter[channel]': 'facebook', 'filter[tag]': 'vip', q: '0155' });
  });

  it('filenameFromDisposition handles plain and RFC 5987 names', () => {
    expect(filenameFromDisposition('attachment; filename="storeplix-products-template.csv"', 'x')).toBe('storeplix-products-template.csv');
    expect(filenameFromDisposition("attachment; filename*=UTF-8''r%C3%A9port.csv", 'x')).toBe('réport.csv');
    expect(filenameFromDisposition(null, 'fallback.csv')).toBe('fallback.csv');
  });
});

describe('Phase 4 endpoints', () => {
  it('products.list returns data + meta and sends tenant header', async () => {
    const meta = { current_page: 1, per_page: 25, total: 1, last_page: 1, counts: { all: 1, draft: 0, active: 1, archived: 0 } };
    const { client, call } = setup(json(200, { data: [{ id: 'P1' }], meta }));
    await expect(client.products.list('S1', { status: ['active'] })).resolves.toEqual({ data: [{ id: 'P1' }], meta });
    expect(call().url.pathname).toBe('/api/v1/stores/S1/products');
    expect(call().url.searchParams.get('filter[status]')).toBe('active');
    expect(call().headers['X-Tenant-Id']).toBe('T1');
  });

  it('product CRUD paths and methods', async () => {
    const { client, call } = setup(() => json(200, { data: { id: 'P1' } }));
    await client.products.get('S1', 'P1');
    await client.products.create('S1', { name: 'A', variants: [{ price_amount: 100 }] });
    await client.products.update('S1', 'P1', { revision: 3, name: 'B' });
    await client.products.duplicate('S1', 'P1');
    await client.products.bulk('S1', { action: 'archive', ids: ['P1'] });
    const base = '/api/v1/stores/S1/products';
    expect([0, 1, 2, 3, 4].map((i) => `${call(i).method} ${call(i).url.pathname}`)).toEqual([
      `GET ${base}/P1`,
      `POST ${base}`,
      `PATCH ${base}/P1`,
      `POST ${base}/P1/duplicate`,
      `POST ${base}/bulk`,
    ]);
    expect(call(2).body).toEqual({ revision: 3, name: 'B' });
  });

  it('surfaces 402 plan_limit_reached with details', async () => {
    const { client } = setup(json(402, { error: { code: 'plan_limit_reached', message: 'Your plan allows 100 products.', details: { products: ['Your plan allows 100 products.'] } } }));
    await expect(client.products.create('S1', { name: 'A', variants: [{ price_amount: 1 }] })).rejects.toMatchObject({ status: 402, code: 'plan_limit_reached' });
  });

  it('categories: list meta, reorder PUT, delete', async () => {
    const { client, call } = setup(() => json(200, { data: [], meta: { count: 0, limit: 500 } }));
    await expect(client.categories.list('S1', ' sar ')).resolves.toEqual({ data: [], meta: { count: 0, limit: 500 } });
    expect(call().url.searchParams.get('q')).toBe('sar');
    await client.categories.reorder('S1', { items: [{ id: 'C1', parent_id: null }] });
    expect(call(1).method).toBe('PUT');
    expect(call(1).url.pathname).toBe('/api/v1/stores/S1/categories/order');
  });

  it('inventory.adjust posts the adjustment and surfaces 409 stock_changed details', async () => {
    const { client, call } = setup(
      json(409, { error: { code: 'stock_changed', message: 'Stock changed', details: { 'items.0.expected_on_hand': ['Stock changed to 12 since you opened this. Check and try again.'] } } }),
    );
    const err = await client.inventory
      .adjust('S1', { reason: 'correction', items: [{ variant_id: 'V1', mode: 'set', quantity: 4, expected_on_hand: 10 }] })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: 'stock_changed' });
    expect((err as { fieldError(f: string): string | undefined }).fieldError('items.0.expected_on_hand')).toMatch(/changed to 12/);
    expect(call().body).toEqual({ reason: 'correction', items: [{ variant_id: 'V1', mode: 'set', quantity: 4, expected_on_hand: 10 }] });
  });

  it('inventory.list falls back to an empty summary', async () => {
    const { client } = setup(json(200, { data: [] }));
    const res = await client.inventory.list('S1');
    expect(res.meta.summary.units_on_hand).toBe(0);
  });

  it('customers notes paths', async () => {
    const { client, call } = setup(() => json(201, { data: { id: 'N1' } }));
    await client.customers.addNote('S1', 'C1', 'Call first');
    expect(call().url.pathname).toBe('/api/v1/stores/S1/customers/C1/notes');
    expect(call().body).toEqual({ body: 'Call first' });
    await client.customers.deleteNote('S1', 'C1', 'N1');
    expect(`${call(1).method} ${call(1).url.pathname}`).toBe('DELETE /api/v1/stores/S1/customers/C1/notes/N1');
  });

  it('imports.upload sends multipart with type (fetch fallback)', async () => {
    const fetchMock = vi.fn(async () => json(201, { data: { id: 'I1', status: 'uploaded' } }));
    const client = createApiClient({ baseUrl: 'http://api.test', fetch: fetchMock, getTenantId: () => 'T1' });
    await expect(client.imports.upload('S1', { file: new Blob(['a,b\n1,2']), type: 'products', filename: 'p.csv' })).resolves.toMatchObject({ id: 'I1' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api.test/api/v1/stores/S1/imports');
    const form = init.body as FormData;
    expect(form.get('type')).toBe('products');
    expect((form.get('file') as File).name).toBe('p.csv');
  });

  it('imports.template downloads a blob with the disposition filename', async () => {
    const { client, call } = setup(
      new Response('﻿name,price\n', { status: 200, headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="storeplix-products-template.csv"' } }),
    );
    const file = await client.imports.template('S1', 'products');
    expect(file.filename).toBe('storeplix-products-template.csv');
    expect(await file.blob.text()).toContain('name,price');
    expect(call().url.searchParams.get('type')).toBe('products');
  });

  it('imports.errorReport surfaces JSON errors', async () => {
    const { client } = setup(json(409, { error: { code: 'invalid_state_transition', message: 'Not validated yet' } }));
    await expect(client.imports.errorReport('S1', 'I1')).rejects.toMatchObject({ code: 'invalid_state_transition' });
  });

  it('imports.run sends allow_partial; exports + dashboard paths', async () => {
    const { client, call } = setup(() => json(202, { data: { id: 'X' } }));
    await client.imports.run('S1', 'I1', { allow_partial: true });
    expect(call().body).toEqual({ allow_partial: true });
    await client.exports.create('S1', { type: 'customers' });
    expect(`${call(1).method} ${call(1).url.pathname}`).toBe('POST /api/v1/stores/S1/exports');
    await client.dashboard.get('S1');
    expect(call(2).url.pathname).toBe('/api/v1/stores/S1/dashboard');
  });
});
