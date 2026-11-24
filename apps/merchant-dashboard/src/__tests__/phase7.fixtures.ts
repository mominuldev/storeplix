import type {
  BillingInvoice,
  BillingInvoiceSummary,
  BillingPayment,
  BillingQuote,
  DeliveryReport,
  FeatureAccess,
  Plan,
  ProfitReport,
  ReportMeta,
  SalesReport,
  Subscription,
} from '@storeplix/types';
import { jsonResponse } from '../test/utils';

// Phase 7 fixtures shaped like openapi 1.8.0 (PHASE-7-CONTRACT §9).

const limitsOf = (o: number | null, s: number | null, p: number | null, c: number | null, sms: number | null, d: number | null) => ({
  orders_per_month: o,
  staff_seats: s,
  products: p,
  courier_connections: c,
  sms_per_month: sms,
  custom_domains: d,
  campaign_sms_per_month: o === 50 ? 0 : o === null ? 5000 : 1000,
  campaign_emails_per_month: o === 50 ? 0 : o === null ? 20000 : 5000,
});

export const plans: Plan[] = [
  { id: 'P1', code: 'free', name: 'Free', price_amount: 0, price_yearly_amount: null, currency: 'BDT', interval: 'month', limits: limitsOf(50, 5, 100, 1, 200, 0), features: [] },
  {
    id: 'P2',
    code: 'starter',
    name: 'Starter',
    price_amount: 49900,
    price_yearly_amount: 499000,
    currency: 'BDT',
    interval: 'month',
    limits: limitsOf(500, 5, 1000, null, 2000, 2),
    features: ['custom_domain', 'all_couriers', 'bulk_courier_booking'],
  },
  {
    id: 'P3',
    code: 'growth',
    name: 'Growth',
    price_amount: 149900,
    price_yearly_amount: 1499000,
    currency: 'BDT',
    interval: 'month',
    limits: limitsOf(null, 15, null, null, null, 5),
    features: ['custom_domain', 'all_couriers', 'bulk_courier_booking', 'profit_reports'],
  },
];
export const planBy = (code: string) => plans.find((p) => p.code === code)!;

const day = 86_400_000;
export const inDays = (n: number) => new Date(Date.now() + n * day).toISOString();

export function invoiceSummary(o: Partial<BillingInvoiceSummary> = {}): BillingInvoiceSummary {
  return {
    id: 'I1',
    number: 'SP-2026-000123',
    kind: 'new',
    status: 'open',
    description: 'Storeplix Growth plan (monthly)',
    total_amount: 149900,
    currency: 'BDT',
    issued_at: inDays(-1),
    due_at: inDays(1),
    paid_at: null,
    is_overdue: false,
    can_pay: true,
    ...o,
  };
}

export function invoice(o: Partial<BillingInvoice> = {}): BillingInvoice {
  return {
    ...invoiceSummary(),
    plan_code: 'growth',
    interval: 'month',
    subtotal_amount: 130348,
    tax_amount: 19552,
    tax_rate_bps: 1500,
    credit_amount: 0,
    lines: [],
    bill_to: { name: 'Mugdho Fashion', address: 'House 12, Road 7, Mirpur 10, Dhaka 1216', email: null, phone: null },
    period_start: null,
    period_end: null,
    voided_at: null,
    void_reason: null,
    paid_late: false,
    payments: [],
    ...o,
  };
}

export function subscription(o: Partial<Subscription> = {}): Subscription {
  return {
    id: 'SUB1',
    status: 'active',
    plan: planBy('free'),
    trial_ends_at: null,
    current_period_start: inDays(-10),
    current_period_end: inDays(20),
    cancel_at_period_end: false,
    billing_interval: 'month',
    scheduled_change: null,
    past_due_at: null,
    grace_ends_at: null,
    domain_grace_ends_at: null,
    open_invoice: null,
    ...o,
  };
}

export function features(o: Partial<FeatureAccess> = {}, limits: Partial<FeatureAccess['limits']> = {}): FeatureAccess {
  return {
    plan_code: 'free',
    subscription_status: 'active',
    trial_ends_at: null,
    features: {
      custom_domain: false,
      all_couriers: false,
      bulk_courier_booking: false,
      fake_order_guard: false,
      purchasing: false,
      sms_automation: false,
      custom_roles: false,
      multi_warehouse: false,
      pos: false,
      profit_reports: false,
      api_webhooks: false,
    },
    limits: {
      orders_per_month: { limit: 50, used: 10 },
      staff_seats: { limit: 5, used: 1 },
      products: { limit: 100, used: 12 },
      courier_connections: { limit: 1, used: 0 },
      sms_per_month: { limit: 200, used: 3 },
      custom_domains: { limit: 0, used: 0 },
      campaign_sms_per_month: { limit: 0, used: 0 },
      campaign_emails_per_month: { limit: 0, used: 0 },
      ...limits,
    },
    grace_ends_at: null,
    domain_grace_ends_at: null,
    ...o,
  };
}

export function payment(o: Partial<BillingPayment> = {}): BillingPayment {
  return {
    id: 'PAY1',
    invoice_id: 'I1',
    provider: 'bkash',
    status: 'pending',
    amount: 149900,
    currency: 'BDT',
    redirect_url: 'https://sandbox.bka.sh/checkout/abc',
    failure_code: null,
    is_duplicate: false,
    created_at: inDays(0),
    expires_at: inDays(1),
    verified_at: null,
    ...o,
  };
}

export function quote(o: Partial<BillingQuote> = {}): BillingQuote {
  return {
    kind: 'upgrade',
    plan: planBy('growth'),
    interval: 'month',
    amount: 40000,
    credit_amount: 0,
    currency: 'BDT',
    requires_payment: true,
    effective_at: inDays(0),
    period_start: inDays(-10),
    period_end: '2026-12-01T00:00:00Z',
    lines: [{ description: 'Growth plan, rest of this month', plan_code: 'growth', interval: 'month', period_start: null, period_end: null, quantity: 1, unit_amount: 40000, amount: 40000 }],
    warnings: [],
    ...o,
  };
}

export const invoicesResponse = (rows: BillingInvoiceSummary[] = [], providers: string[] = ['bkash', 'sslcommerz']) =>
  jsonResponse(200, { data: rows, meta: { current_page: 1, per_page: 10, total: rows.length, last_page: 1, providers } });

/** Routes for the Plan & billing page; extra routes override. */
export function billingRoutes(sub: Subscription, feat: FeatureAccess = features({ plan_code: sub.plan.code, subscription_status: sub.status }), extra: Record<string, Response | ((init: RequestInit) => Response)> = {}) {
  return {
    'GET /subscription': jsonResponse(200, { data: sub }),
    'GET /features': jsonResponse(200, { data: feat }),
    'GET /plans': jsonResponse(200, { data: plans }),
    'GET /billing/invoices': invoicesResponse(),
    ...extra,
  };
}

// ---------- Reports ----------
export const reportMeta = (o: Partial<ReportMeta> = {}): ReportMeta => ({
  from: '2026-11-01',
  to: '2026-11-23',
  previous_from: '2026-10-09',
  previous_to: '2026-10-31',
  timezone: 'Asia/Dhaka',
  currency: 'BDT',
  generated_at: new Date().toISOString(),
  ...o,
});

const salesSummary = (o: Partial<SalesReport['summary']> = {}): SalesReport['summary'] => ({
  sales_amount: 48620000,
  sold_orders_count: 369,
  orders_count: 412,
  orders_per_day: 17.9,
  average_order_value_amount: 131761,
  items_per_order: 1.6,
  cancelled_count: 24,
  cancelled_rate: 0.0583,
  fake_cancelled_count: 5,
  ...o,
});

export function salesReport(o: Partial<SalesReport> = {}): SalesReport {
  return {
    summary: salesSummary(),
    previous: salesSummary({ sales_amount: 42650000, orders_count: 380, cancelled_count: 30 }),
    best_day: { date: '2026-11-14', sales_amount: 3140000, orders_count: 42 },
    weekend_share: 0.38,
    daily: [
      { date: '2026-11-13', orders_count: 18, sold_orders_count: 15, sales_amount: 2000000 },
      { date: '2026-11-14', orders_count: 42, sold_orders_count: 30, sales_amount: 3140000 },
      { date: '2026-11-15', orders_count: 20, sold_orders_count: 17, sales_amount: 2400000 },
    ],
    channels: [
      { channel: 'facebook', orders_count: 200, sales_amount: 27490000, share: 0.5654 },
      { channel: 'website', orders_count: 169, sales_amount: 21130000, share: 0.4346 },
    ],
    top_products: [{ product_id: 'PR1', name: 'Jamdani Three-Piece', image: null, units: 64, sales_amount: 10560000, share: 0.22 }],
    areas: {
      inside_dhaka_share: 0.47,
      districts: [{ district_code: 'dhaka', district_name: 'Dhaka', orders_count: 180, sales_amount: 22850000, share: 0.47 }],
    },
    ...o,
  };
}

export const profitSummary = (o: Partial<ProfitReport['summary']> = {}): ProfitReport['summary'] => ({
  revenue_amount: 48620000,
  delivered_orders_count: 369,
  product_cost_amount: 24830000,
  delivery_cost_amount: 5230000,
  cod_fee_amount: 1186000,
  gateway_fee_amount: null,
  // PHASE-8-7 §7.3: a store with no expenses reports 0 (was null), other expenses 0, profit before = net profit.
  ad_spend_amount: 0,
  other_expenses_amount: 0,
  total_cost_amount: 31246000,
  profit_before_expenses_amount: 17374000,
  net_profit_amount: 17374000,
  margin: 0.3573,
  profit_per_order_amount: 47084,
  ...o,
});

export function profitReport(o: Partial<ProfitReport> = {}): ProfitReport {
  const s = profitSummary();
  return {
    summary: s,
    previous: profitSummary({ revenue_amount: 40000000, margin: 0.3, net_profit_amount: 12000000 }),
    per_order: { order_value_amount: 131761, product_cost_amount: 67289, delivery_cost_amount: 14173, cod_fee_amount: 3214, gateway_fee_amount: null, ad_spend_amount: 0, other_expenses_amount: 0, profit_amount: 47084 },
    weekly: Array.from({ length: 12 }, (_, i) => ({ week: `2026-W${36 + i}`, week_start: '2026-09-01', revenue_amount: 1000000, net_profit_amount: 250000 + i * 1000, margin: 0.25 + i * 0.001 })),
    daily: Array.from({ length: 9 }, (_, i) => ({
      date: `2026-11-${String(23 - i).padStart(2, '0')}`,
      orders_count: 40,
      revenue_amount: 2940000,
      product_cost_amount: 1510000,
      delivery_cost_amount: 320000,
      cod_fee_amount: 72000,
      gateway_fee_amount: null,
      ad_spend_amount: 0,
      other_expenses_amount: 0,
      total_cost_amount: 1902000,
      profit_before_expenses_amount: 1038000,
      net_profit_amount: 1038000,
      margin: 0.353,
    })),
    data_quality: { items_without_cost: 12, shipments_without_fee: 0, expenses_count: 0 },
    ...o,
  };
}

const deliverySummary = (o: Partial<DeliveryReport['summary']> = {}): DeliveryReport['summary'] => ({
  parcels_count: 1094,
  delivered_count: 921,
  returned_count: 85,
  returning_count: 31,
  in_progress_count: 57,
  success_rate: 0.8419,
  return_rate: 0.0777,
  returning_charges_amount: 684000,
  avg_delivery_days: 2.4,
  avg_delivery_days_inside_dhaka: 1.3,
  avg_delivery_days_outside_dhaka: 3.1,
  ...o,
});

export function deliveryReport(o: Partial<DeliveryReport> = {}): DeliveryReport {
  return {
    summary: deliverySummary(),
    previous: deliverySummary({ success_rate: 0.81, returning_count: 27 }),
    couriers: [{ provider: 'steadfast', parcels_count: 512, delivered_share: 0.88, returned_share: 0.07, in_progress_share: 0.05, avg_delivery_days: 2.1, cod_held_amount: 11000000 }],
    returns_count: 85,
    return_reasons: [
      { reason: 'refused_at_door', count: 32, share: 0.3765 },
      { reason: 'wrong_size', count: 53, share: 0.6235 },
    ],
    weekly: Array.from({ length: 8 }, (_, i) => ({ week: `2026-W${40 + i}`, week_start: '2026-10-01', parcels_count: 120, success_rate: 0.8 + i * 0.005 })),
    returning: [
      {
        shipment_id: 'SH1',
        order_id: 'O1',
        order_number: 'GS-1031',
        customer_name: 'Rubina Khatun',
        district_name: 'Rajshahi',
        provider: 'redx',
        problem: 'Phone off 3 times',
        last_location: 'Rajshahi hub',
        last_event_at: inDays(-1),
      },
    ],
    districts: [
      { district_code: 'dhaka', district_name: 'Dhaka', parcels_count: 512, success_rate: 0.94 },
      { district_code: 'rajshahi', district_name: 'Rajshahi', parcels_count: 44, success_rate: 0.78 },
    ],
    ...o,
  };
}
