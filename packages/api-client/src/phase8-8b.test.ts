import { describe, expect, it, vi } from 'vitest';
import type { CreatePurchaseOrderInput, QuickPurchaseInput, ReceivePurchaseOrderInput, SupplierPaymentInput } from '@storeplix/types';
import { PERMISSION_KEYS, PURCHASE_ORDER_STATUSES, SYSTEM_ROLE_PERMISSIONS } from '@storeplix/types';
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

describe('Phase 8.8b suppliers + purchase orders client', () => {
  it('suppliers: list filters, summary, CRUD, archive, payments', async () => {
    const { client, call } = setup(() => json(200, { data: [] }));
    const page = await client.suppliers.list('S1', { q: ' rahim ', archived: true, sort: '-owed_amount' });
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/suppliers');
    expect(call(0).headers['X-Tenant-Id']).toBe('T1');
    expect(call(0).url.searchParams.get('q')).toBe('rahim');
    expect(call(0).url.searchParams.get('filter[archived]')).toBe('1');
    expect(call(0).url.searchParams.get('sort')).toBe('-owed_amount');
    expect(page.meta.per_page).toBe(50);
    expect(page.meta.counts).toEqual({ active: 0, archived: 0 });
    await client.suppliers.summary('S1');
    expect(call(1).url.pathname).toBe('/api/v1/stores/S1/suppliers/summary');
    await client.suppliers.create('S1', { name: 'Rahim Traders', phone: '01712345678', lead_time_days: 5 });
    expect(call(2)).toMatchObject({ method: 'POST', body: { name: 'Rahim Traders', lead_time_days: 5 } });
    await client.suppliers.update('S1', 'SU1', { city: 'Dhaka' });
    expect(call(3)).toMatchObject({ method: 'PATCH', body: { city: 'Dhaka' } });
    expect(call(3).url.pathname).toBe('/api/v1/stores/S1/suppliers/SU1');
    await client.suppliers.archive('S1', 'SU1');
    expect(call(4).url.pathname).toBe('/api/v1/stores/S1/suppliers/SU1/archive');
    await client.suppliers.unarchive('S1', 'SU1');
    expect(call(5).url.pathname).toBe('/api/v1/stores/S1/suppliers/SU1/unarchive');
    await client.suppliers.payments('S1', 'SU1');
    expect(call(6).url.pathname).toBe('/api/v1/stores/S1/suppliers/SU1/payments');
    const payment: SupplierPaymentInput = { amount: 500000, method: 'bkash', paid_on: '2026-11-24', purchase_order_id: 'PO1' };
    await client.suppliers.recordPayment('S1', 'SU1', payment);
    expect(call(7)).toMatchObject({ method: 'POST', body: payment });
  });

  it('deletes return void on 204', async () => {
    const { client, call } = setup(() => new Response(null, { status: 204 }));
    await expect(client.suppliers.delete('S1', 'SU1')).resolves.toBeUndefined();
    expect(call(0)).toMatchObject({ method: 'DELETE' });
    await client.supplierPayments.delete('S1', 'P1');
    expect(call(1).url.pathname).toBe('/api/v1/stores/S1/supplier-payments/P1');
    await client.purchaseOrders.delete('S1', 'PO1');
    expect(call(2).url.pathname).toBe('/api/v1/stores/S1/purchase-orders/PO1');
  });

  it('purchase orders: list filters + counts fallback, summary, create, update, transitions', async () => {
    const { client, call } = setup(() => json(200, { data: [] }));
    const page = await client.purchaseOrders.list('S1', { status: ['ordered', 'partially_received'], supplier_id: 'SU1', q: 'PO-12' });
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/purchase-orders');
    expect(call(0).url.searchParams.get('filter[status]')).toBe('ordered,partially_received');
    expect(call(0).url.searchParams.get('filter[supplier_id]')).toBe('SU1');
    expect(call(0).url.searchParams.get('q')).toBe('PO-12');
    expect(Object.keys(page.meta.counts).sort()).toEqual(['all', ...PURCHASE_ORDER_STATUSES].sort());
    await client.purchaseOrders.summary('S1');
    expect(call(1).url.pathname).toBe('/api/v1/stores/S1/purchase-orders/summary');
    const create: CreatePurchaseOrderInput = {
      supplier_id: 'SU1', lines: [{ variant_id: 'V1', unit_cost_amount: 25000, quantity: 10 }, { variant_id: 'V2', quantity: 5 }],
      shipping_amount: 50000, expected_on: '2026-12-01',
    };
    await client.purchaseOrders.create('S1', create);
    expect(call(2)).toMatchObject({ method: 'POST', body: create });
    await client.purchaseOrders.update('S1', 'PO1', { revision: 3, discount_amount: 1000 });
    expect(call(3)).toMatchObject({ method: 'PATCH', body: { revision: 3, discount_amount: 1000 } });
    await client.purchaseOrders.send('S1', 'PO1', { sent_via: 'whatsapp', revision: 4 });
    expect(call(4)).toMatchObject({ method: 'POST', body: { sent_via: 'whatsapp', revision: 4 } });
    expect(call(4).url.pathname).toBe('/api/v1/stores/S1/purchase-orders/PO1/send');
    await client.purchaseOrders.markOrdered('S1', 'PO1');
    expect(call(5).url.pathname).toBe('/api/v1/stores/S1/purchase-orders/PO1/mark-ordered');
    await client.purchaseOrders.close('S1', 'PO1', { revision: 5 });
    expect(call(6)).toMatchObject({ method: 'POST', body: { revision: 5 } });
    expect(call(6).url.pathname).toBe('/api/v1/stores/S1/purchase-orders/PO1/close');
    await client.purchaseOrders.cancel('S1', 'PO1');
    expect(call(7).url.pathname).toBe('/api/v1/stores/S1/purchase-orders/PO1/cancel');
  });

  it('receive and quick purchase send the Idempotency-Key', async () => {
    const { client, call } = setup(() => json(201, { data: {} }));
    const receipt: ReceivePurchaseOrderInput = { lines: [{ item_id: 'L1', received: 9, damaged: 1 }], supplier_invoice_ref: 'INV-7' };
    await client.purchaseOrders.receive('S1', 'PO1', receipt, 'idem-1');
    expect(call(0)).toMatchObject({ method: 'POST', body: receipt });
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/purchase-orders/PO1/receipts');
    expect(call(0).headers['Idempotency-Key']).toBe('idem-1');
    const quick: QuickPurchaseInput = {
      supplier_id: 'SU1', lines: [{ variant_id: 'V1', unit_cost_amount: 20000, quantity: 12, damaged: 2 }],
      payment: { amount: 200000, method: 'cash', paid_on: '2026-11-24' },
    };
    await client.purchaseOrders.quick('S1', quick, 'idem-2');
    expect(call(1)).toMatchObject({ method: 'POST', body: quick });
    expect(call(1).url.pathname).toBe('/api/v1/stores/S1/purchase-orders/quick');
    expect(call(1).headers['Idempotency-Key']).toBe('idem-2');
  });

  it('pdf downloads a blob with the tenant header; pdfUrl builds the API URL', async () => {
    const { client, call } = setup(() => new Response('%PDF-1.7', { status: 200, headers: { 'Content-Type': 'application/pdf' } }));
    const file = await client.purchaseOrders.pdf('S1', 'PO1', 'PO-0012');
    expect(file.filename).toBe('PO-0012.pdf');
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/purchase-orders/PO1/pdf');
    expect(call(0).headers['X-Tenant-Id']).toBe('T1');
    expect(client.purchaseOrders.pdfUrl('S1', 'PO1')).toBe('http://api.test/api/v1/stores/S1/purchase-orders/PO1/pdf');
  });

  it('reorder suggestions, movements reference filter', async () => {
    const { client, call } = setup(() => json(200, { data: [] }));
    await expect(client.purchasing.reorderSuggestions('S1')).resolves.toEqual([]);
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/purchasing/reorder-suggestions');
    await client.inventory.movements('S1', { reference_type: 'purchase_order' });
    expect(call(1).url.searchParams.get('filter[reference_type]')).toBe('purchase_order');
  });

  it('catalogue: purchasing.manage after inventory.adjust; owner + admin, not staff', () => {
    expect(PERMISSION_KEYS.indexOf('purchasing.manage')).toBe(PERMISSION_KEYS.indexOf('inventory.adjust') + 1);
    expect(PERMISSION_KEYS.filter((k) => k !== 'billing.manage')).toHaveLength(29); // + inbox.manage (PHASE-8-8E), support.manage (PHASE-8-9C)
    expect(SYSTEM_ROLE_PERMISSIONS.owner).toContain('purchasing.manage');
    expect(SYSTEM_ROLE_PERMISSIONS.admin).toContain('purchasing.manage');
    expect(SYSTEM_ROLE_PERMISSIONS.staff).not.toContain('purchasing.manage');
  });
});
