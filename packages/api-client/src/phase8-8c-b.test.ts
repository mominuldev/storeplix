import { describe, expect, it, vi } from 'vitest';
import type {
  CreateStockTransferInput,
  InsufficientStockDetails,
  LocationInUseReason,
  StockCount,
  StockCountErrorCode,
  StockCountLine,
  StockCountSummary,
  StockTransfer,
  StockTransferErrorCode,
  StockTransferSummary,
} from '@storeplix/types';
import {
  LOCATION_IN_USE_REASONS,
  OPEN_STOCK_TRANSFER_STATUSES,
  STOCK_COUNT_AUDIT_ACTIONS,
  STOCK_COUNT_CODE_MAX,
  STOCK_COUNT_LINE_STATES,
  STOCK_COUNT_LINES_MAX,
  STOCK_COUNT_STATUSES,
  STOCK_TRANSFER_AUDIT_ACTIONS,
  STOCK_TRANSFER_LINES_MAX,
  STOCK_TRANSFER_STATUS_LABELS,
  STOCK_TRANSFER_STATUSES,
} from '@storeplix/types';
import { createApiClient, isApiError, stockCountLineListQuery, stockCountListQuery, stockTransferListQuery } from './index';

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

const transfer: StockTransfer = {
  id: 'TR1', number: 'TR-021', status: 'received',
  from_location: { id: 'L1', name: 'Main warehouse' }, to_location: { id: 'L2', name: 'Dhanmondi shop' },
  note: null, items_count: 2, units_sent: 12, units_received: 10, units_short: 2, created_by: { id: 'U1', name: 'Rahim' },
  sent_at: '2026-11-25T04:00:00Z', received_at: '2026-11-25T08:00:00Z', cancelled_at: null,
  created_at: '2026-11-25T03:00:00Z', updated_at: '2026-11-25T08:00:00Z', revision: 3,
};

const summary: StockCountSummary = {
  short_units: 3, short_value_amount: null, extra_units: 1, extra_value_amount: null,
  not_counted: 40, matched: 6, differences: 2, net_value_amount: null,
};

const count: StockCount = {
  id: 'C1', name: 'Count 25 Nov · Main warehouse', location: { id: 'L1', name: 'Main warehouse' }, category: null,
  status: 'in_progress', lines_count: 48, counted_count: 8, currency: 'BDT', net_value_amount: null, zero_uncounted: null,
  started_by: { id: 'U1', name: 'Rahim' }, started_at: '2026-11-25T03:00:00Z', finished_by: null, finished_at: null,
  cancelled_at: null, revision: 9,
};

const line: StockCountLine = {
  id: 'CL1',
  variant: { id: 'V1', product: { id: 'P1', name: 'Panjabi', image: null }, title: 'M', option_values: ['M'], sku: 'PJ-M', barcode: null },
  counted: 4, expected: 5, difference: -1, on_hand: 5, value_amount: null, counted_at: '2026-11-25T04:00:00Z',
  counted_by: { id: 'U1', name: 'Rahim' }, applied_delta: null,
};

describe('Phase 8.8c part B: stock transfers + stock counts client', () => {
  it('constants', () => {
    expect(STOCK_TRANSFER_STATUSES).toEqual(['draft', 'in_transit', 'received', 'cancelled']);
    expect(OPEN_STOCK_TRANSFER_STATUSES).toEqual(['draft', 'in_transit']);
    expect(STOCK_TRANSFER_STATUS_LABELS.in_transit).toBe('In transit');
    expect(STOCK_TRANSFER_LINES_MAX).toBe(200);
    expect(STOCK_COUNT_STATUSES).toEqual(['in_progress', 'completed', 'cancelled']);
    expect(STOCK_COUNT_LINE_STATES).toEqual(['not_counted', 'differences', 'matched']);
    expect(STOCK_COUNT_LINES_MAX).toBe(5000);
    expect(STOCK_COUNT_CODE_MAX).toBe(64);
    expect(STOCK_TRANSFER_AUDIT_ACTIONS).toEqual([
      'stock_transfer.created', 'stock_transfer.updated', 'stock_transfer.sent', 'stock_transfer.received',
      'stock_transfer.cancelled', 'stock_transfer.deleted',
    ]);
    expect(STOCK_COUNT_AUDIT_ACTIONS).toEqual(['stock_count.started', 'stock_count.finished', 'stock_count.cancelled']);
    const reasons: LocationInUseReason[] = ['open_transfers', 'open_counts'];
    for (const r of reasons) expect(LOCATION_IN_USE_REASONS).toContain(r);
  });

  it('query builders', () => {
    expect(stockTransferListQuery({ status: ['draft', 'in_transit'], location_id: 'L2', q: ' TR-02 ', page: 2 })).toEqual({
      'filter[status]': 'draft,in_transit', 'filter[location_id]': 'L2', q: 'TR-02', page: 2, per_page: undefined,
    });
    expect(stockTransferListQuery()).toEqual({
      'filter[status]': undefined, 'filter[location_id]': undefined, q: undefined, page: undefined, per_page: undefined,
    });
    expect(stockCountListQuery({ status: ['completed'], location_id: 'L1' })).toMatchObject({
      'filter[status]': 'completed', 'filter[location_id]': 'L1',
    });
    expect(stockCountLineListQuery({ state: 'differences', q: 'pj', page: 3 })).toEqual({
      'filter[state]': 'differences', q: 'pj', page: 3, per_page: undefined,
    });
    expect(stockCountLineListQuery()['filter[state]']).toBeUndefined();
  });

  it('stock transfers: list, summary, get, create, update, delete', async () => {
    const tiles: StockTransferSummary = {
      drafts_count: 1, in_transit_count: 2, in_transit_units: 30, last_sent_at: null,
      received_this_month_count: 4, received_this_month_units: 80, locations: { count: 2, names: ['Main warehouse', 'Dhanmondi shop'] },
    };
    const { client, call } = setup(() => json(200, { data: [transfer], meta: { current_page: 1, per_page: 25, total: 1, last_page: 1, counts: { all: 1, draft: 0, in_transit: 0, received: 1, cancelled: 0 } } }));
    const page = await client.stockTransfers.list('S1', { status: ['received'], location_id: 'L2' });
    expect(page.data[0]!.units_short).toBe(2);
    expect(page.meta.counts.received).toBe(1);
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/stock-transfers');
    expect(call(0).headers['X-Tenant-Id']).toBe('T1');
    expect(call(0).url.searchParams.get('filter[status]')).toBe('received');
    expect(call(0).url.searchParams.get('filter[location_id]')).toBe('L2');
    await client.stockTransfers.summary('S1');
    expect(call(1).url.pathname).toBe('/api/v1/stores/S1/stock-transfers/summary');
    expect(tiles.locations.names).toHaveLength(2);
    await client.stockTransfers.get('S1', 'TR1');
    expect(call(2).url.pathname).toBe('/api/v1/stores/S1/stock-transfers/TR1');

    const input: CreateStockTransferInput = { from_location_id: 'L1', to_location_id: 'L2', note: 'Eid', lines: [{ variant_id: 'V1', quantity: 12 }] };
    await client.stockTransfers.create('S1', input);
    expect(call(3)).toMatchObject({ method: 'POST', body: input });
    expect(call(3).headers['Idempotency-Key']).toBeUndefined();
    await client.stockTransfers.create('S1', { ...input, send: true }, 'idem-create');
    expect(call(4)).toMatchObject({ method: 'POST', body: { send: true } });
    expect(call(4).headers['Idempotency-Key']).toBe('idem-create');
    await client.stockTransfers.update('S1', 'TR1', { revision: 2, lines: [{ variant_id: 'V1', quantity: 10 }] });
    expect(call(5)).toMatchObject({ method: 'PATCH', body: { revision: 2, lines: [{ variant_id: 'V1', quantity: 10 }] } });
    expect(call(5).url.pathname).toBe('/api/v1/stores/S1/stock-transfers/TR1');
    await client.stockTransfers.delete('S1', 'TR1');
    expect(call(6)).toMatchObject({ method: 'DELETE' });
  });

  it('stock transfers: send, receive (idempotent) and cancel', async () => {
    const { client, call } = setup(() => json(200, { data: transfer }));
    await client.stockTransfers.send('S1', 'TR1', 'idem-send', { revision: 2 });
    expect(call(0)).toMatchObject({ method: 'POST', body: { revision: 2 } });
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/stock-transfers/TR1/send');
    expect(call(0).headers['Idempotency-Key']).toBe('idem-send');
    await client.stockTransfers.receive('S1', 'TR1', { lines: [{ item_id: 'I1', received: 10 }, { item_id: 'I2', received: 0 }] }, 'idem-recv');
    expect(call(1)).toMatchObject({ method: 'POST', body: { lines: [{ item_id: 'I1', received: 10 }, { item_id: 'I2', received: 0 }] } });
    expect(call(1).url.pathname).toBe('/api/v1/stores/S1/stock-transfers/TR1/receive');
    expect(call(1).headers['Idempotency-Key']).toBe('idem-recv');
    await client.stockTransfers.cancel('S1', 'TR1');
    expect(call(2)).toMatchObject({ method: 'POST', body: {} });
    expect(call(2).url.pathname).toBe('/api/v1/stores/S1/stock-transfers/TR1/cancel');
  });

  it('send surfaces 422 insufficient_stock with lines', async () => {
    const code: StockTransferErrorCode = 'insufficient_stock';
    const details: InsufficientStockDetails = { lines: [{ variant_id: 'V1', requested: 12, available: 9 }] };
    const { client } = setup(() => json(422, { error: { code, message: 'Not enough stock', details } }));
    const err = await client.stockTransfers.send('S1', 'TR1', 'k').catch((e: unknown) => e);
    expect(isApiError(err)).toBe(true);
    if (isApiError(err)) {
      expect(err.status).toBe(422);
      expect(err.code).toBe('insufficient_stock');
    }
  });

  it('stock counts: list, get, lines, start', async () => {
    const { client, call } = setup(() => json(200, { data: [] }));
    const counts = await client.stockCounts.list('S1', { status: ['in_progress'] });
    expect(counts.meta.counts.in_progress).toBe(0);
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/stock-counts');
    expect(call(0).url.searchParams.get('filter[status]')).toBe('in_progress');
    await client.stockCounts.get('S1', 'C1');
    expect(call(1).url.pathname).toBe('/api/v1/stores/S1/stock-counts/C1');
    const lines = await client.stockCounts.lines('S1', 'C1', { state: 'not_counted', q: 'PJ' });
    expect(lines.meta.per_page).toBe(100);
    expect(lines.meta.counts.not_counted).toBe(0);
    expect(call(2).url.pathname).toBe('/api/v1/stores/S1/stock-counts/C1/lines');
    expect(call(2).url.searchParams.get('filter[state]')).toBe('not_counted');
    expect(call(2).url.searchParams.get('q')).toBe('PJ');
    await client.stockCounts.start('S1', { location_id: 'L1', category_id: null });
    expect(call(3)).toMatchObject({ method: 'POST', body: { location_id: 'L1', category_id: null } });
    expect(call(3).url.pathname).toBe('/api/v1/stores/S1/stock-counts');
  });

  it('stock counts: scan, set line, finish (idempotent), cancel', async () => {
    const { client, call } = setup(() => json(200, { data: { line, summary, count } }));
    const scanned = await client.stockCounts.scan('S1', 'C1', { code: 'PJ-M' });
    expect(scanned.line.difference).toBe(-1);
    expect(scanned.summary.short_units).toBe(3);
    expect(scanned.count.revision).toBe(9);
    expect(call(0)).toMatchObject({ method: 'POST', body: { code: 'PJ-M' } });
    expect(call(0).url.pathname).toBe('/api/v1/stores/S1/stock-counts/C1/scan');
    await client.stockCounts.setLine('S1', 'C1', 'CL1', { counted: null, revision: 9 });
    expect(call(1)).toMatchObject({ method: 'PUT', body: { counted: null, revision: 9 } });
    expect(call(1).url.pathname).toBe('/api/v1/stores/S1/stock-counts/C1/lines/CL1');
    await client.stockCounts.finish('S1', 'C1', { zero_uncounted: false }, 'idem-finish');
    expect(call(2)).toMatchObject({ method: 'POST', body: { zero_uncounted: false } });
    expect(call(2).url.pathname).toBe('/api/v1/stores/S1/stock-counts/C1/finish');
    expect(call(2).headers['Idempotency-Key']).toBe('idem-finish');
    await client.stockCounts.cancel('S1', 'C1');
    expect(call(3)).toMatchObject({ method: 'POST', body: {} });
    expect(call(3).url.pathname).toBe('/api/v1/stores/S1/stock-counts/C1/cancel');
  });

  it('count errors: count_in_progress, count_line_not_found', async () => {
    const inProgress: StockCountErrorCode = 'count_in_progress';
    const { client } = setup(() => json(409, { error: { code: inProgress, message: 'A count is open', details: { count_id: 'C1' } } }));
    const err = await client.stockCounts.start('S1', { location_id: 'L1' }).catch((e: unknown) => e);
    expect(isApiError(err) && err.status === 409 && err.code === 'count_in_progress').toBe(true);

    const notFound: StockCountErrorCode = 'count_line_not_found';
    const second = setup(() => json(404, { error: { code: notFound, message: 'No line', details: { code: 'XX' } } }));
    const err2 = await second.client.stockCounts.scan('S1', 'C1', { code: 'XX' }).catch((e: unknown) => e);
    expect(isApiError(err2) && err2.status === 404 && err2.code === 'count_line_not_found').toBe(true);
  });
});
