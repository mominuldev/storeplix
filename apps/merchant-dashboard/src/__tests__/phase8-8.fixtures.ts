import { FRAUD_GUARD_DEFAULTS, type BlockedNumber, type FraudGuardEvent, type FraudGuardOverview, type FraudGuardSettings, type NumberCheck, type OrderGuard } from '@storeplix/types';
import { jsonResponse } from '../test/utils';
import { features } from './phase7.fixtures';

// PHASE-8-8 §8.2 shapes for the fake-order guard (Figma 39:11233 / 33:3676 sample data, own-shop records only).

export function guardSettings(o: Partial<FraudGuardSettings> = {}): FraudGuardSettings {
  return { ...FRAUD_GUARD_DEFAULTS, daily_limit_enabled: false, updated_by: { id: 'U1', name: 'Rafiqul Alam' }, updated_at: '2026-11-20T08:00:00Z', ...o };
}

export function overview(o: Partial<FraudGuardOverview> = {}): FraudGuardOverview {
  return {
    month: '2026-11',
    rules_on: 5,
    rules_total: 6,
    orders_checked: 1248,
    stopped: { held: 41, blocked: 14, duplicates: 8, limited: 0 },
    advance_collected_amount: 756000,
    currency: 'BDT',
    blocked_count: 14,
    ...o,
  };
}

export function blocked(o: Partial<BlockedNumber> = {}): BlockedNumber {
  return {
    id: 'BN1',
    phone_masked: '01819•••466',
    phone: '8801819224466',
    customer: { id: 'CU9', name: 'Tanvir Hasan' },
    reason: 'repeat_returns',
    note: null,
    source: 'auto',
    returned_count: 5,
    created_by: null,
    created_at: '2026-11-09T10:00:00Z',
    ...o,
  };
}

export const blockedRows: BlockedNumber[] = [
  blocked(),
  blocked({
    id: 'BN2',
    phone_masked: '01633•••120',
    phone: '8801633445120',
    customer: { id: 'CU8', name: 'Rashed Karim' },
    reason: 'manual',
    note: 'Refused 3 parcels at the door',
    source: 'staff',
    returned_count: 3,
    created_by: { id: 'U2', name: 'Sumi Akter', role_label: 'Manager' },
    created_at: '2026-11-02T10:00:00Z',
  }),
];

export function guardEvent(o: Partial<FraudGuardEvent> = {}): FraudGuardEvent {
  return {
    id: 'GE1',
    type: 'held',
    order: { id: 'O1', number: 'GS-1041' },
    phone_masked: '01819•••466',
    detail: { rate: 58, delivered: 7, total: 12, reasons: ['rate_below_hold'] },
    created_at: new Date().toISOString(),
    ...o,
  };
}

export const events: FraudGuardEvent[] = [
  guardEvent(),
  guardEvent({ id: 'GE2', type: 'advance_asked', order: { id: 'O3', number: 'GS-1043' }, detail: { amount: 13000, rate: 71, delivered: 5, total: 7 } }),
  guardEvent({ id: 'GE3', type: 'advance_paid', order: { id: 'O4', number: 'GS-1039' }, detail: { amount: 12000 } }),
  guardEvent({ id: 'GE4', type: 'limit_reached', order: null, phone_masked: '01521•••877', detail: { count: 6, limit: 3 } }),
  guardEvent({ id: 'GE5', type: 'duplicate', order: { id: 'O5', number: 'GS-1037' }, detail: { duplicate_of_number: 'GS-1035', window_hours: 24 } }),
];

export function numberCheck(o: Partial<NumberCheck> = {}): NumberCheck {
  return { phone_masked: '01819•••466', tier: 'risky', rate: 58, delivered: 7, total: 12, sources: [{ key: 'shop', delivered: 7, total: 12 }], blocked: false, last_return_on: '2026-11-09', ...o };
}

export function guard(o: Partial<OrderGuard> = {}): OrderGuard {
  return {
    hold: 'call_first',
    tier: 'risky',
    rate: 58,
    reasons: ['rate_below_hold'],
    decision: 'hold',
    record: { total: 12, delivered: 7, sources: [{ key: 'shop', delivered: 7, total: 12 }] },
    payment_link_id: null,
    checked_at: new Date().toISOString(),
    ...o,
  };
}

const cursor = { next_cursor: null, prev_cursor: null, per_page: 50 };
export const starter = () => features({ plan_code: 'starter', features: { ...features().features, fake_order_guard: true } });

export function guardRoutes(o: Record<string, Response | ((init: RequestInit) => Response)> = {}) {
  return {
    'GET /features': jsonResponse(200, { data: starter() }),
    'GET /stores/S1/fraud-guard/settings': jsonResponse(200, { data: guardSettings() }),
    'GET /stores/S1/fraud-guard/overview': jsonResponse(200, { data: overview() }),
    'GET /stores/S1/fraud-guard/events': jsonResponse(200, { data: events, meta: cursor }),
    'GET /stores/S1/fraud-guard/blocked-numbers': jsonResponse(200, { data: blockedRows, meta: cursor }),
    'GET /stores/S1/payment-gateways': jsonResponse(200, { data: [] }),
    ...o,
  };
}
