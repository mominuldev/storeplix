import type { StockCountDetail, StockCountLine, StockCountSummary, StockTransfer, StockTransferDetail, StockTransferLine, StockTransferSummary, StockVariantRef } from '@storeplix/types';
import { jsonResponse } from '../test/utils';

// PHASE-8-8C part B shapes (§7, §8) with the Figma 153:34425 / 153:35246 sample data.

const page = (total: number, per_page = 25) => ({ current_page: 1, per_page, total, last_page: Math.max(1, Math.ceil(total / per_page)) });

export function variantRef(o: Partial<StockVariantRef> = {}): StockVariantRef {
  return { id: 'V1', product: { id: 'P1', name: 'Jamdani Three-Piece', image: null }, title: 'Red / M', option_values: ['Red', 'M'], sku: 'JT-001-RD-M', barcode: '8801000000011', ...o };
}

export function transfer(o: Partial<StockTransfer> = {}): StockTransfer {
  return {
    id: 'TR1',
    number: 'TR-021',
    status: 'draft',
    from_location: { id: 'LOC1', name: 'Main warehouse' },
    to_location: { id: 'LOC2', name: 'Dhanmondi shop' },
    note: null,
    items_count: 2,
    units_sent: 10,
    units_received: null,
    units_short: 0,
    created_by: { id: 'U1', name: 'Nusrat Jahan' },
    sent_at: null,
    received_at: null,
    cancelled_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    revision: 1,
    ...o,
  };
}

export function transferLine(o: Partial<StockTransferLine> = {}): StockTransferLine {
  return { id: 'TL1', variant: variantRef(), quantity: 6, quantity_received: null, source_on_hand: 46, source_available: 44, source_low_stock_threshold: 5, position: 0, ...o };
}

export const kurtiLine = () =>
  transferLine({ id: 'TL2', variant: variantRef({ id: 'V2', product: { id: 'P2', name: 'Kids Kurti', image: null }, title: 'Yellow / 6–7 y', sku: 'KK-1' }), quantity: 4, source_on_hand: 5, source_available: 5, source_low_stock_threshold: 3, position: 1 });

export function transferDetail(o: Partial<StockTransferDetail> = {}): StockTransferDetail {
  return { ...transfer(o), lines: [transferLine(), kurtiLine()], events: [], ...o };
}

export const transferSummary = (o: Partial<StockTransferSummary> = {}): StockTransferSummary => ({
  drafts_count: 2,
  in_transit_count: 1,
  in_transit_units: 24,
  last_sent_at: new Date(Date.now() - 86_400_000).toISOString(),
  received_this_month_count: 9,
  received_this_month_units: 312,
  locations: { count: 2, names: ['Main warehouse', 'Dhanmondi shop'] },
  ...o,
});

export const transfersList = (rows: StockTransfer[]) =>
  jsonResponse(200, { data: rows, meta: { ...page(rows.length), counts: { all: rows.length, draft: rows.filter((r) => r.status === 'draft').length, in_transit: rows.filter((r) => r.status === 'in_transit').length, received: rows.filter((r) => r.status === 'received').length, cancelled: rows.filter((r) => r.status === 'cancelled').length } } });

export function countSummary(o: Partial<StockCountSummary> = {}): StockCountSummary {
  return { short_units: 11, short_value_amount: 1760000, extra_units: 1, extra_value_amount: 185000, not_counted: 148, matched: 305, differences: 7, net_value_amount: -1575000, ...o };
}

export function countDetail(o: Partial<StockCountDetail> = {}): StockCountDetail {
  return {
    id: 'SC1',
    name: 'Monthly count · Mirpur',
    location: { id: 'LOC1', name: 'Main warehouse' },
    category: null,
    status: 'in_progress',
    lines_count: 460,
    counted_count: 312,
    currency: 'BDT',
    net_value_amount: -1575000,
    zero_uncounted: null,
    started_by: { id: 'U1', name: 'Rahim Uddin' },
    started_at: '2026-11-20T03:00:00Z',
    finished_by: null,
    finished_at: null,
    cancelled_at: null,
    revision: 4,
    summary: countSummary(),
    ...o,
  };
}

export function countLine(o: Partial<StockCountLine> = {}): StockCountLine {
  return { id: 'CL1', variant: variantRef(), counted: 10, expected: 12, difference: -2, on_hand: 12, value_amount: -690000, counted_at: '2026-11-20T04:00:00Z', counted_by: { id: 'U1', name: 'Rahim Uddin' }, applied_delta: null, ...o };
}

export const uncountedLine = () =>
  countLine({ id: 'CL2', variant: variantRef({ id: 'V3', product: { id: 'P3', name: 'Katan Saree', image: null }, title: 'Maroon', sku: 'KS-014-MR' }), counted: null, expected: null, difference: null, on_hand: 4, value_amount: null, counted_at: null, counted_by: null });

export const countLines = (rows: StockCountLine[], counts = { all: 460, not_counted: 148, differences: 7, matched: 305 }) => jsonResponse(200, { data: rows, meta: { ...page(rows.length, 100), counts } });
