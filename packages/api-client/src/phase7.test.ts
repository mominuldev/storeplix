import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './index';

function json(status: number, body?: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function setup(response: Response | (() => Response)) {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => (typeof response === 'function' ? response() : response));
  const client = createApiClient({ baseUrl: 'http://api.test', fetch: fetchMock, getTenantId: () => 'T1', csrf: false });
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

describe('Phase 7 billing client', () => {
  it('quote posts only plan_code and interval', async () => {
    const { client, call } = setup(json(200, { data: { kind: 'new', amount: 49900 } }));
    const q = await client.billing.quote({ plan_code: 'starter', interval: 'month', amount: 1 } as never);
    expect(call().url.pathname).toBe('/api/v1/billing/quote');
    expect(call().method).toBe('POST');
    expect(call().body).toEqual({ plan_code: 'starter', interval: 'month' });
    expect(call().headers['X-Tenant-Id']).toBe('T1');
    expect(q.amount).toBe(49900);
  });

  it('changePlan and pay send the Idempotency-Key and whitelisted fields', async () => {
    const { client, call } = setup(() => json(201, { data: { id: 'X' } }));
    await client.billing.changePlan({ plan_code: 'growth', interval: 'year' }, 'k1');
    await client.billing.pay('INV/1', { provider: 'bkash', amount: 5 } as never, 'k2');
    expect(call(0).url.pathname).toBe('/api/v1/billing/change-plan');
    expect(call(0).headers['Idempotency-Key']).toBe('k1');
    expect(call(1).url.pathname).toBe('/api/v1/billing/invoices/INV%2F1/pay');
    expect(call(1).body).toEqual({ provider: 'bkash' });
    expect(call(1).headers['Idempotency-Key']).toBe('k2');
  });

  it('invoices returns rows and meta with providers; filter and paging map to the query', async () => {
    const meta = { current_page: 2, per_page: 10, total: 11, last_page: 2, providers: ['bkash'] };
    const { client, call } = setup(json(200, { data: [{ id: 'I1' }], meta }));
    const res = await client.billing.invoices({ page: 2, per_page: 10, status: 'open' });
    expect(call().url.searchParams.get('page')).toBe('2');
    expect(call().url.searchParams.get('filter[status]')).toBe('open');
    expect(res.meta.providers).toEqual(['bkash']);
  });

  it('scheduled-change delete, payment get and invoice pdf hit their paths', async () => {
    const { client, call } = setup(() => json(200, { data: {} }));
    await client.billing.cancelScheduledChange();
    await client.billing.payment('P1');
    expect(call(0).method).toBe('DELETE');
    expect(call(0).url.pathname).toBe('/api/v1/billing/scheduled-change');
    expect(call(1).url.pathname).toBe('/api/v1/billing/payments/P1');
    const pdf = setup(new Response(new Blob(['%PDF']), { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="SP-2026-000123.pdf"' } }));
    const file = await pdf.client.billing.invoicePdf('I1', 'SP-2026-000123');
    expect(pdf.call().url.pathname).toBe('/api/v1/billing/invoices/I1/pdf');
    expect(file.filename).toBe('SP-2026-000123.pdf');
  });

  it('surfaces 422 billing_gateway_unavailable and 409 invoice_not_open', async () => {
    const off = setup(json(422, { error: { code: 'billing_gateway_unavailable', message: 'No' } }));
    await expect(off.client.billing.pay('I1', { provider: 'sslcommerz' }, 'k')).rejects.toMatchObject({ status: 422, code: 'billing_gateway_unavailable' });
    const paid = setup(json(409, { error: { code: 'invoice_not_open', message: 'Paid' } }));
    await expect(paid.client.billing.pay('I1', { provider: 'bkash' }, 'k')).rejects.toMatchObject({ status: 409, code: 'invoice_not_open' });
  });
});

describe('Phase 7 reports client', () => {
  it('returns data and meta and passes the range', async () => {
    const meta = { from: '2026-11-01', to: '2026-11-23', previous_from: '2026-10-09', previous_to: '2026-10-31', timezone: 'Asia/Dhaka', currency: 'BDT', generated_at: 'x' };
    const { client, call } = setup(json(200, { data: { summary: {} }, meta }));
    const res = await client.reports.sales('S1', { from: '2026-11-01', to: '2026-11-23' });
    expect(call().url.pathname).toBe('/api/v1/stores/S1/reports/sales');
    expect(call().url.searchParams.get('from')).toBe('2026-11-01');
    expect(res.meta.timezone).toBe('Asia/Dhaka');
  });

  it('omits empty range params and surfaces 402 on profit', async () => {
    const { client, call } = setup(json(200, { data: {}, meta: {} }));
    await client.reports.delivery('S1');
    expect(call().url.search).toBe('');
    const gated = setup(json(402, { error: { code: 'feature_not_in_plan', message: 'Growth', details: { feature: ['profit_reports'] } } }));
    await expect(gated.client.reports.profit('S1')).rejects.toMatchObject({ status: 402, code: 'feature_not_in_plan' });
  });
});
