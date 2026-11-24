import { describe, expect, it, vi } from 'vitest';
import type { ExpenseInput } from '@storeplix/types';
import { EXPENSE_CATEGORIES, PERMISSION_KEYS, SYSTEM_ROLE_PERMISSIONS } from '@storeplix/types';
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

const input: ExpenseInput = { amount: 800000, category: 'ads', paid_from: 'card', spent_on: '2026-11-19', note: 'Facebook boost', repeat_monthly: false };

describe('Phase 8.7 expenses client', () => {
  it('CRUD hits the store-scoped routes with the tenant header', async () => {
    const { client, call } = setup(() => json(200, { data: { id: 'E1' } }));
    await client.expenses.create('S1', input);
    expect(call(0)).toMatchObject({ method: 'POST', body: input });
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/expenses');
    expect(call(0).headers['X-Tenant-Id']).toBe('T1');
    await client.expenses.update('S1', 'E1', { receipt_id: null, repeat_monthly: false });
    expect(call(1)).toMatchObject({ method: 'PATCH', body: { receipt_id: null, repeat_monthly: false } });
    expect(call(1).url.pathname).toBe('/api/v1/stores/S1/expenses/E1');
    await client.expenses.get('S1', 'E1');
    expect(call(2).url.pathname).toBe('/api/v1/stores/S1/expenses/E1');
    await client.expenses.receiptLink('S1', 'E1');
    expect(call(3).url.pathname).toBe('/api/v1/stores/S1/expenses/E1/receipt');
  });

  it('list and summary send month/category filters', async () => {
    const { client, call } = setup(() => json(200, { data: [], meta: { next_cursor: null, prev_cursor: null, per_page: 50 } }));
    await client.expenses.list('S1', { month: '2026-11', category: ['ads', 'courier'], cursor: 'c1' });
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/expenses');
    expect(call(0).url.searchParams.get('filter[month]')).toBe('2026-11');
    expect(call(0).url.searchParams.get('filter[category]')).toBe('ads,courier');
    expect(call(0).url.searchParams.get('cursor')).toBe('c1');
    await client.expenses.summary('S1', '2026-10');
    expect(call(1).url.pathname).toBe('/api/v1/stores/S1/expenses/summary');
    expect(call(1).url.searchParams.get('month')).toBe('2026-10');
  });

  it('delete returns void on 204', async () => {
    const { client, call } = setup(() => new Response(null, { status: 204 }));
    await expect(client.expenses.delete('S1', 'E1')).resolves.toBeUndefined();
    expect(call(0).method).toBe('DELETE');
  });

  it('catalogue: six categories; expenses.manage after reports.view; owner + admin, not staff', () => {
    expect(EXPENSE_CATEGORIES).toEqual(['ads', 'packaging', 'salaries', 'rent_bills', 'courier', 'other']);
    expect(PERMISSION_KEYS.indexOf('expenses.manage')).toBe(PERMISSION_KEYS.indexOf('reports.view') + 1);
    expect(SYSTEM_ROLE_PERMISSIONS.admin).toContain('expenses.manage');
    expect(SYSTEM_ROLE_PERMISSIONS.staff).not.toContain('expenses.manage');
  });
});
