import type { AudiencePreview, Campaign, CampaignEstimate, CampaignListItem, CampaignRecipient, MarketingOverview } from '@storeplix/types';
import { jsonResponse } from '../test/utils';
import { features } from './phase7.fixtures';

// PHASE-8-5 §6.2 shapes with Figma 66:19179 / 70:19774 sample data.

export const starter = () =>
  features(
    { plan_code: 'starter' },
    { campaign_sms_per_month: { limit: 1000, used: 20 }, campaign_emails_per_month: { limit: 5000, used: 0 } },
  );

const stats = (o: Partial<Campaign['stats']> = {}): Campaign['stats'] => ({
  recipients: 214,
  sent: 214,
  failed: 0,
  skipped: 3,
  unsubscribed: 1,
  parts_sent: 428,
  orders: 23,
  revenue_amount: 3_190_000,
  currency: 'BDT',
  ...o,
});

export function campaign(o: Partial<Campaign> = {}): Campaign {
  return {
    id: 'C1',
    name: 'Come back for 15% off',
    channel: 'sms',
    language: 'bn',
    status: 'sent',
    audience: { segment: 'repeat_inactive', params: { min_orders: 2, inactive_days: 60 }, exclude: { risky: true, ordered_within_days: 7 } },
    audience_label: 'Bought twice, inactive 60 days',
    body: 'প্রিয় {name}, অনেকদিন দেখা নেই! কোড {coupon}',
    subject: null,
    coupon: { id: 'CP1', code: 'WINTER15' },
    product: null,
    scheduled_at: null,
    started_at: '2026-11-15T14:00:00Z',
    completed_at: '2026-11-15T14:05:00Z',
    cancelled_at: null,
    failure_reason: null,
    stats: stats(),
    created_by: { id: 'U1', name: 'Rafiqul Alam' },
    created_at: '2026-11-15T10:00:00Z',
    updated_at: '2026-11-15T14:05:00Z',
    revision: 3,
    ...o,
  };
}

export const listItem = (c: Campaign): CampaignListItem => {
  const { body: _b, subject: _s, audience: _a, ...rest } = c;
  return rest;
};

export const campaigns: Campaign[] = [
  campaign(),
  campaign({ id: 'C2', name: 'Friday flash sale', status: 'scheduled', scheduled_at: '2026-12-04T03:00:00Z', started_at: null, completed_at: null, audience_label: 'All customers you can message', stats: stats({ recipients: 0, sent: 0, skipped: 0, unsubscribed: 0, parts_sent: 0, orders: 0, revenue_amount: 0 }) }),
  campaign({ id: 'C3', name: 'Eid draft', status: 'draft', channel: 'email', subject: 'Eid Mubarak!', started_at: null, completed_at: null, stats: stats({ recipients: 0, sent: 0, skipped: 0, unsubscribed: 0, parts_sent: 0, orders: 0, revenue_amount: 0 }) }),
];

export function overview(o: Partial<MarketingOverview> = {}): MarketingOverview {
  const weeks = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23'];
  return {
    range: '30d',
    kpis: { revenue_amount: 38_420_000, revenue_change_pct: 22, campaign_orders: 236, campaign_orders_share_pct: 18, messages_sent: 1250, unsubscribes: 4, carts_recovered: 58, recovered_revenue_amount: 9_240_000 },
    series: weeks.map((w, i) => ({ week_start: w, coupons_amount: 2_000_000 + i * 300_000, campaigns_amount: 900_000 + i * 200_000, recovery_amount: 400_000 + i * 100_000 })),
    active_coupons: [
      { id: 'CP1', code: 'EID25', type: 'percentage', percent_bps: 2500, amount: null, ends_at: null, used_count: 184, usage_limit: 500, revenue_amount: 24_680_000 },
      { id: 'CP2', code: 'FREEDEL', type: 'free_shipping', percent_bps: null, amount: null, ends_at: null, used_count: 96, usage_limit: null, revenue_amount: 11_230_000 },
    ],
    recent_campaigns: campaigns.map(listItem),
    counts: { coupons: 8, campaigns: 14, automations: 3 },
    currency: 'BDT',
    ...o,
  };
}

export const preview = (o: Partial<AudiencePreview> = {}): AudiencePreview => ({
  matched: 214,
  excluded: { risky: 11, recent_orders: 4, opted_out: 2, no_address: 0, not_eligible: 0 },
  recipients: 197,
  risk_breakdown: { good: 84, careful: 16, risky: 0 },
  ...o,
});

export const estimate = (o: Partial<CampaignEstimate> = {}): CampaignEstimate => ({
  recipients: 197,
  parts_per_recipient: 2,
  total_parts: 394,
  encoding: 'ucs2',
  characters: 118,
  allowance: { limit: 1000, used: 20, remaining: 980, after: 586 },
  ...o,
});

export const recipient = (o: Partial<CampaignRecipient> = {}): CampaignRecipient => ({
  id: 'R1',
  customer: { id: 'CU1', name: 'Nasrin Akter' },
  masked_address: '+880 17•• •••123',
  status: 'sent',
  skip_reason: null,
  error_code: null,
  parts: 2,
  sent_at: '2026-11-15T14:01:00Z',
  unsubscribed_at: null,
  attributed_order: { id: 'O1', number: '1042', total_amount: 245_000 },
  ...o,
});

const page = (rows: unknown[]) => ({ data: rows, meta: { current_page: 1, per_page: 25, total: rows.length, last_page: 1 } });

export function marketingRoutes(o: { features?: ReturnType<typeof features>; overview?: MarketingOverview; list?: Campaign[] } = {}) {
  return {
    'GET /features': jsonResponse(200, { data: o.features ?? starter() }),
    'GET /stores/S1/marketing/overview': jsonResponse(200, { data: o.overview ?? overview() }),
    'GET /stores/S1/campaigns': jsonResponse(200, page((o.list ?? campaigns).map(listItem))),
    'POST /stores/S1/campaigns/audience-preview': jsonResponse(200, { data: preview() }),
    'POST /stores/S1/campaigns/estimate': jsonResponse(200, { data: estimate() }),
  };
}
