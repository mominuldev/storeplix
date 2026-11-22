import type { ShipmentBatch, ShipmentDetail, ShipmentListMeta, ShipmentSummary } from '@storeplix/types';
import { jsonResponse } from '../test/utils';

// Phase 5b-3 shipment fixtures shaped like openapi 1.6.0 ShipmentSummary / ShipmentDetail / ShipmentBatch (§4.7, §9).

export function shipmentSummary(s: Partial<ShipmentSummary> = {}): ShipmentSummary {
  return {
    id: 'SH1',
    provider: 'steadfast',
    carrier_name: 'Steadfast',
    tracking_code: 'SF-88214573',
    tracking_url: 'https://steadfast.com.bd/t/SF-88214573',
    status: 'out_for_delivery',
    cod_amount: 177_000,
    shipped_at: '2026-11-20T09:00:00Z',
    delivered_at: null,
    returned_at: null,
    consignment_id: 'SF-88214573',
    provider_status: 'pending',
    attempts: 1,
    problem: null,
    weight_grams: 500,
    delivery_fee_amount: 7_000,
    cod_charge_amount: 1_770,
    cod_collected_amount: null,
    last_location: 'Mirpur hub',
    last_event_at: '2026-11-22T04:42:00Z',
    booked_at: '2026-11-18T15:40:00Z',
    picked_up_at: '2026-11-19T05:05:00Z',
    cancelled_at: null,
    failure_reason: null,
    order: { id: 'O1', number: 'MU-1042', customer_name: 'Nasrin Akter', customer_phone: '8801712345678', district: 'Dhaka', thana: 'Mirpur' },
    age_days: 1,
    ...s,
  };
}

export function shipmentDetail(s: Partial<ShipmentDetail> = {}): ShipmentDetail {
  return {
    ...shipmentSummary(),
    events: [
      { id: 'EV1', status: 'booked', provider_status: 'in_review', description: 'Booked by Rahim Ahmed', location: null, source: 'user', occurred_at: '2026-11-18T15:40:00Z' },
      { id: 'EV2', status: 'in_transit', provider_status: 'pending', description: 'Sorted at Steadfast hub, Tejgaon', location: 'Tejgaon', source: 'webhook', occurred_at: '2026-11-19T12:20:00Z' },
      { id: 'EV3', status: 'out_for_delivery', provider_status: 'pending', description: 'Out for delivery', location: 'Mirpur hub', source: 'poll', occurred_at: '2026-11-22T04:42:00Z' },
    ],
    money: { collect_amount: 177_000, delivery_fee_amount: 7_000, cod_charge_amount: 1_770, net_amount: 168_230 },
    parcel: { items_summary: 'Cotton Panjabi × 1', weight_grams: 500, pickup_location: 'Main warehouse' },
    can: { cancel: false, mark_cancelled: false, refresh: true },
    ...s,
  };
}

export function shipmentMeta(m: Partial<ShipmentListMeta> = {}): ShipmentListMeta {
  return {
    current_page: 1,
    per_page: 25,
    total: 2,
    last_page: 1,
    counts: { all: 64, steadfast: 38, pathao: 19, redx: 7, manual: 0 },
    kpis: {
      in_transit: 42,
      out_for_delivery_today: 18,
      delivered_7d: 126,
      delivery_rate_7d: 0.94,
      problems: { total: 7, delivery_failed: 3, on_hold: 2, returning: 2 },
      cod_held: {
        total_amount: 18_425_000,
        by_provider: [
          { provider: 'steadfast', amount: 11_240_000, parcels: 38 },
          { provider: 'pathao', amount: 5_835_000, parcels: 19 },
        ],
      },
    },
    last_synced_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    ...m,
  };
}

export const shipmentList = (rows: ShipmentSummary[], meta: Partial<ShipmentListMeta> = {}) => jsonResponse(200, { data: rows, meta: shipmentMeta({ total: rows.length, ...meta }) });

export function shipmentBatch(b: Partial<ShipmentBatch> = {}): ShipmentBatch {
  return { id: 'B1', provider: 'steadfast', status: 'queued', total: 2, booked: 0, skipped: 0, failed: 0, results: [], created_at: '2026-11-22T09:00:00Z', finished_at: null, ...b };
}
