import type { AdminAnalyticsOverview, AdminRevenueReport, AdminTenantMetrics, AnalyticsMeta } from '@storeplix/types';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../App';
import { adminSession, emptyList, jsonResponse, mockApi, on, renderApp, tenant } from '../test/utils';
import { customRangeSchema } from './range';
import { delta, rate, relativeTime } from './format';

const meta = (over: Partial<AnalyticsMeta> = {}): AnalyticsMeta => ({
  as_of: '2026-11-22',
  computed_at: '2026-11-22T18:24:00Z',
  data_starts_on: '2025-01-01',
  timezone: 'Asia/Dhaka',
  currency: 'BDT',
  range: '30d',
  granularity: 'month',
  from: '2025-12-01',
  to: '2026-11-22',
  previous_from: '2024-12-01',
  previous_to: '2025-11-30',
  ...over,
});

const plans = [
  { code: 'free', name: 'Free', sort: 0, monthly_price_amount: 0 },
  { code: 'starter', name: 'Starter', sort: 1, monthly_price_amount: 49900 },
  { code: 'growth', name: 'Growth', sort: 2, monthly_price_amount: 149900 },
];

const overviewData: AdminAnalyticsOverview = {
  mrr: { amount: 184_000_000, previous_amount: 165_800_000, arr_amount: 2_210_000_000 },
  active_shops: { total: 3482, paying: 1906, trialing: 0, comp: 2, free: 1574, past_due: 12, previous_total: 3268 },
  trial_conversion: { rate: 0.27, previous_rate: 0.24, converted: 112, ended: 415, trialing_now: 412 },
  gmv: { amount: 9_600_000_000, previous_amount: 8_130_000_000, orders_count: 142000, previous_orders_count: 120000, aov_amount: 67600 },
  revenue_churn: { rate: 0.021, previous_rate: 0.025, churned_amount: 3_500_000, cancellations: 38, opening_mrr_amount: 166_000_000 },
  mrr_series: [
    { bucket_start: '2026-10-01', bucket_end: '2026-10-31', mrr_amount: null, by_plan: {} },
    { bucket_start: '2026-11-01', bucket_end: '2026-11-22', mrr_amount: 184_000_000, by_plan: { starter: 60_000_000, growth: 124_000_000 } },
  ],
  plan_mix: [
    { plan_code: 'free', plan_name: 'Free', count: 1576 },
    { plan_code: 'starter', plan_name: 'Starter', count: 1288 },
    { plan_code: 'growth', plan_name: 'Growth', count: 618 },
  ],
  plans,
};

const overview8_1 = {
  tenants: { total: 10, active: 9, suspended: 1 },
  subscriptions: { paying: 4, trialing: 2, free: 3, past_due: 0, by_plan: [] },
  past_due: { count: 0, amount: 0, currency: 'BDT' },
  open_invoices: 0,
  domains: { active: 1, pending: 0, failing: 0, suspended: 0 },
  active_impersonations: 0,
  newest_tenants: [],
};
const overview81Ok = on('GET', '/admin/overview', () => jsonResponse(200, { data: overview8_1 }));
const analyticsOk = (data: AdminAnalyticsOverview = overviewData, m: Partial<AnalyticsMeta> = {}) =>
  on('GET', '/admin/analytics/overview', (c) => jsonResponse(200, { data, meta: meta({ range: (c.url.searchParams.get('range') ?? '30d') as AnalyticsMeta['range'], ...m }) }));

const revenueData: AdminRevenueReport = {
  kpis: {
    mrr: { amount: 184_000_000, previous_amount: 166_000_000 },
    arr: { amount: 2_210_000_000, previous_amount: 1_990_000_000 },
    net_new_mrr: { amount: 18_300_000, previous_amount: 16_800_000, new_amount: 18_800_000, expansion_amount: 4_600_000, contraction_amount: 1_600_000, churned_amount: 3_500_000 },
    churned_mrr: { amount: 3_500_000, previous_amount: 3_800_000, rate: 0.021, previous_rate: 0.023, opening_mrr_amount: 166_000_000, count: 44 },
    arpa: { amount: 96500, previous_amount: 94700, paying: 1906 },
    ltv: { amount: 2_760_000, lifetime_months: 29 },
  },
  movement: [
    {
      bucket_start: '2026-10-01', bucket_end: '2026-10-31', opening_mrr_amount: null, new_amount: null, expansion_amount: null,
      contraction_amount: null, churned_amount: null, net_new_amount: null, closing_mrr_amount: null, counts: null,
    },
    {
      bucket_start: '2026-11-01', bucket_end: '2026-11-22', opening_mrr_amount: 166_000_000, new_amount: 18_800_000, expansion_amount: 4_600_000,
      contraction_amount: 1_600_000, churned_amount: 3_500_000, net_new_amount: 18_300_000, closing_mrr_amount: 184_300_000,
      counts: { new: 214, expansion: 38, contraction: 21, churned: 44 },
    },
  ],
  cohorts: {
    rows: [
      { cohort: '2026-01', size: 168, retention: [1, 0.8, 0.7, null] },
      { cohort: '2026-11', size: 258, retention: [1] },
    ],
    m3_average: 0.76,
  },
  by_plan: {
    rows: [
      { plan_code: 'growth', plan_name: 'Growth', monthly_price_amount: 149900, shops: 618, mrr_amount: 92_600_000, previous_mrr_amount: 82_700_000, share: 0.5, yearly_share: 0.33 },
      { plan_code: 'starter', plan_name: 'Starter', monthly_price_amount: 49900, shops: 1288, mrr_amount: 91_400_000, previous_mrr_amount: 92_000_000, share: 0.5, yearly_share: 0.18 },
      { plan_code: 'free', plan_name: 'Free', monthly_price_amount: 0, shops: 1576, mrr_amount: 0, previous_mrr_amount: 0, share: 0, yearly_share: null },
    ],
    total: { shops: 3482, paying: 1906, mrr_amount: 184_000_000, previous_mrr_amount: 174_700_000 },
  },
  trial_funnel: { signed_up: 1420, store_published: 986, trial_ended: 900, converted: 165, trial_to_paid_rate: 0.27, signup_to_paid_rate: 0.116, median_days_to_paid: 11 },
  top_merchants: [
    {
      tenant: { id: 'T1', name: 'Gadget Haat', slug: 'gadgethaat' }, primary_host: 'gadgethaat.com.bd', plan_code: 'growth', billing_interval: 'month',
      last_payment_provider: 'bkash', orders_30d: 4810, mrr_amount: 149900, customer_since: '2025-03-14', lifetime_paid_amount: 6_124_000,
    },
  ],
};
const revenueOk = (data: AdminRevenueReport = revenueData, m: Partial<AnalyticsMeta> = {}) =>
  on('GET', '/admin/analytics/revenue', () => jsonResponse(200, { data, meta: meta({ range: '12m', ...m }) }));

describe('analytics format helpers', () => {
  it('rates, deltas (pts, churn down = green, hidden when previous is null or 0) and relative time', () => {
    expect(rate(0.27)).toBe('27%');
    expect(rate(0.021)).toBe('2.1%');
    expect(rate(null)).toBe('—');
    expect(delta(0.27, 0.24, 'points')).toEqual({ label: '↑ 3 pts', good: true });
    expect(delta(0.021, 0.025, 'points', { higherIsBetter: false })).toEqual({ label: '↓ 0.4 pts', good: true });
    expect(delta(110, 100, 'ratio')).toEqual({ label: '↑ 10%', good: true });
    expect(delta(5, 0, 'ratio')).toBeNull();
    expect(delta(5, null, 'count')).toBeNull();
    const now = Date.parse('2026-11-23T10:00:00Z');
    expect(relativeTime('2026-11-23T09:48:00Z', now)).toBe('12 min ago');
    expect(relativeTime('2026-11-22T10:00:00Z', now)).toBe('1 day ago');
    expect(relativeTime(null, now)).toBe('—');
  });

  it('custom range validation', () => {
    const schema = customRangeSchema('2026-11-22');
    expect(schema.safeParse({ from: '2026-01-01', to: '2026-02-01' }).success).toBe(true);
    expect(schema.safeParse({ from: '2026-03-01', to: '2026-02-01' }).success).toBe(false);
    expect(schema.safeParse({ from: '2023-12-31', to: '2024-02-01' }).success).toBe(false);
    expect(schema.safeParse({ from: '2024-01-01', to: '2025-12-31' }).success).toBe(true); // 731 days
    expect(schema.safeParse({ from: '2024-01-01', to: '2026-01-01' }).success).toBe(false); // 732 days
    expect(schema.safeParse({ from: '2026-11-01', to: '2026-11-23' }).success).toBe(false);
  });
});

describe('dashboard 15:123 analytics', () => {
  it('shows the KPI row with lakh/crore formatting, pts and churn down = green', async () => {
    mockApi([overview81Ok, analyticsOk()]);
    renderApp(<AppRoutes />, { route: '/' });
    const mrr = await screen.findByRole('region', { name: 'MRR' });
    expect(within(mrr).getByText('৳ 18.4 L')).toBeInTheDocument();
    expect(within(mrr).getByText('ARR ৳ 2.21 Cr')).toBeInTheDocument();
    expect(within(mrr).getByText('↑ 11%')).toHaveAttribute('data-tone', 'good');
    const shops = screen.getByRole('region', { name: 'Active shops' });
    expect(within(shops).getByText('3,482')).toBeInTheDocument();
    expect(within(shops).getByText('1,906 paying · 1,574 free · 2 comp')).toBeInTheDocument();
    expect(within(shops).getByText('↑ 214')).toBeInTheDocument();
    const trial = screen.getByRole('region', { name: 'Trial → paid' });
    expect(within(trial).getByText('27%')).toBeInTheDocument();
    expect(within(trial).getByText('↑ 3 pts')).toBeInTheDocument();
    expect(within(trial).getByText('412 trials running')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Merchant GMV' })).getByText('৳ 9.6 Cr')).toBeInTheDocument();
    const churn = screen.getByRole('region', { name: 'Revenue churn' });
    expect(within(churn).getByText('2.1%')).toBeInTheDocument();
    expect(within(churn).getByText('↓ 0.4 pts')).toHaveAttribute('data-tone', 'good');
    expect(within(churn).getByText('38 cancellations')).toBeInTheDocument();
    expect(screen.getByTestId('analytics-as-of')).toHaveTextContent('Data as of 22 Nov · updated 00:24');
    // MRR by plan: stacked series per paid plan, null bucket → "No data"; plan mix centre total.
    const chart = screen.getByRole('table', { name: 'Monthly recurring revenue by plan' });
    expect(within(chart).getByRole('columnheader', { name: 'Starter' })).toBeInTheDocument();
    expect(within(chart).getByRole('columnheader', { name: 'Growth' })).toBeInTheDocument();
    expect(within(chart).queryByRole('columnheader', { name: 'Pro' })).toBeNull();
    expect(within(chart).getByText('No data')).toBeInTheDocument();
    const mix = screen.getByRole('list', { name: 'Shops by plan' });
    expect(within(mix).getByText('1,288')).toBeInTheDocument();
    expect(screen.queryByText(/upgrade nudges|Integration health/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
  });

  it('range tabs read and write ?range= and refetch', async () => {
    const api = mockApi([overview81Ok, analyticsOk()]);
    renderApp(<AppRoutes />, { route: '/?range=12m' });
    await screen.findByRole('region', { name: 'MRR' });
    expect(api.find('GET', '/admin/analytics/overview')[0]!.url.searchParams.get('range')).toBe('12m');
    const tabs = screen.getByRole('tablist', { name: 'Date range' });
    expect(within(tabs).getByRole('tab', { name: '12 months' })).toHaveAttribute('aria-selected', 'true');
    expect(within(tabs).queryByRole('tab', { name: 'Custom' })).toBeNull();
    await userEvent.click(within(tabs).getByRole('tab', { name: 'Quarter' }));
    await waitFor(() => expect(api.find('GET', '/admin/analytics/overview').at(-1)!.url.searchParams.get('range')).toBe('quarter'));
    expect(within(tabs).getByRole('tab', { name: 'Quarter' })).toHaveAttribute('aria-selected', 'true');
  });

  it('empty (no snapshot yet), error with retry, and loading states', async () => {
    const first = mockApi([overview81Ok, analyticsOk({ ...overviewData, mrr_series: [], plan_mix: [] }, { as_of: null, computed_at: null })]);
    const r1 = renderApp(<AppRoutes />, { route: '/' });
    expect(await screen.findByText('No data yet')).toBeInTheDocument();
    expect(screen.getByText('4 paying · 3 free')).toBeInTheDocument();
    expect(first.find('GET', '/admin/analytics/overview')).toHaveLength(1);
    r1.unmount();

    mockApi([overview81Ok, on('GET', '/admin/analytics/overview', () => jsonResponse(500, { error: { code: 'server_error', message: 'Boom' } }))]);
    const r2 = renderApp(<AppRoutes />, { route: '/' });
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    r2.unmount();

    mockApi([overview81Ok, on('GET', '/admin/analytics/overview', () => new Promise<Response>(() => undefined) as unknown as Response)]);
    renderApp(<AppRoutes />, { route: '/' });
    expect(await screen.findByRole('status', { name: 'Loading key numbers' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading MRR chart' })).toBeInTheDocument();
  });

  it('Support (no view_analytics) keeps the 8.1 layout, never calls analytics and has no Revenue reports nav', async () => {
    const api = mockApi([overview81Ok, analyticsOk()], { session: adminSession('support') });
    renderApp(<AppRoutes />, { route: '/' });
    expect(await screen.findByText('4 paying · 3 free')).toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Date range' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'MRR' })).toBeNull();
    expect(api.find('GET', '/admin/analytics/overview')).toHaveLength(0);
    expect(within(screen.getByRole('navigation')).queryByRole('link', { name: 'Revenue reports' })).toBeNull();
  });
});

describe('revenue reports 39:12705', () => {
  it('renders KPIs, movement (diverging), cohorts heatmap, revenue by plan, funnel and top merchants', async () => {
    const api = mockApi([revenueOk()]);
    renderApp(<AppRoutes />, { route: '/revenue' });
    expect(await screen.findByRole('heading', { name: 'Revenue reports' })).toBeInTheDocument();
    const mrr = await screen.findByRole('region', { name: 'MRR' });
    expect(within(mrr).getByText('vs ৳ 16.6 L in Nov')).toBeInTheDocument();
    expect(api.find('GET', '/admin/analytics/revenue')[0]!.url.searchParams.get('range')).toBe('12m');
    expect(within(screen.getByRole('region', { name: 'ARR' })).getByText('Run-rate · 1,906 paying')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Churned MRR' })).getByText('2.1% of opening MRR')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'ARPA' })).getByText('৳ 965')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'LTV' })).getByText('ARPA ÷ churn · 29 mo')).toBeInTheDocument();

    const movement = screen.getByRole('table', { name: 'MRR movement' });
    expect(within(movement).getByText('−৳ 35 K')).toBeInTheDocument();
    expect(within(movement).getByText('+1.83L')).toBeInTheDocument();
    expect(within(movement).getByText('No data')).toBeInTheDocument();
    const breakdown = screen.getByRole('list', { name: 'Breakdown · Nov' });
    expect(within(breakdown).getByText('214 new paying shops')).toBeInTheDocument();
    expect(within(breakdown).getByText('44 cancellations')).toBeInTheDocument();
    expect(screen.queryByText(/overage/)).toBeNull();

    const cohorts = screen.getByRole('table', { name: 'Cohort retention' });
    expect(within(cohorts).getByRole('rowheader', { name: 'Jan 2026' })).toBeInTheDocument();
    expect(within(cohorts).getAllByLabelText('No data').length).toBe(4);
    expect(screen.getByText('M3 avg 76%')).toBeInTheDocument();
    expect(screen.getByText('Share of paying shops still subscribed, by first paid month')).toBeInTheDocument();

    const byPlan = screen.getByRole('table', { name: 'Revenue by plan' });
    expect(within(byPlan).getByText('৳ 1,499/mo · 33% annual')).toBeInTheDocument();
    expect(within(byPlan).getByText('Free plan')).toBeInTheDocument();
    expect(within(byPlan).getByText('Total · 1,906 paying')).toBeInTheDocument();
    expect(within(byPlan).queryByText('Pro')).toBeNull();

    const funnel = screen.getByRole('list', { name: 'Trial funnel steps' });
    expect(within(funnel).getAllByRole('listitem')).toHaveLength(3);
    expect(within(funnel).getByText('↓ 434 never published a store')).toBeInTheDocument();
    expect(within(funnel).getByText('↓ 821 did not convert')).toBeInTheDocument();
    expect(screen.queryByText(/Started 14-day trial/)).toBeNull();
    expect(screen.getByText('27% trial → paid')).toBeInTheDocument();
    expect(screen.getByText('11 days')).toBeInTheDocument();

    const top = screen.getByRole('region', { name: 'Top paying merchants' });
    expect(within(top).getByText('bKash · monthly')).toBeInTheDocument();
    expect(within(top).getByText('Mar 2025')).toBeInTheDocument();
    expect(within(top).getByRole('link', { name: /All merchants/ })).toHaveAttribute('href', '/merchants?sort=-mrr');
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
  });

  it('compare toggle hides delta pills and previous values', async () => {
    mockApi([revenueOk()]);
    renderApp(<AppRoutes />, { route: '/revenue' });
    const mrr = await screen.findByRole('region', { name: 'MRR' });
    expect(within(mrr).getByText('↑ 11%')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'vs prev.' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('switch', { name: 'Compare to previous period' }));
    expect(within(mrr).queryByText('↑ 11%')).toBeNull();
    expect(within(mrr).queryByText(/^vs /)).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'vs prev.' })).toBeNull();
  });

  it('custom range validates and then sends from/to', async () => {
    const api = mockApi([revenueOk()]);
    renderApp(<AppRoutes />, { route: '/revenue' });
    await screen.findByRole('region', { name: 'MRR' });
    await userEvent.click(screen.getByRole('tab', { name: 'Custom' }));
    const form = screen.getByRole('form', { name: 'Custom range' });
    await userEvent.type(within(form).getByLabelText('From'), '2026-06-01');
    await userEvent.type(within(form).getByLabelText('To'), '2026-05-01');
    await userEvent.click(within(form).getByRole('button', { name: 'Apply' }));
    expect(within(form).getByRole('alert')).toHaveTextContent('“To” must be on or after “From”.');
    await userEvent.clear(within(form).getByLabelText('To'));
    await userEvent.type(within(form).getByLabelText('To'), '2026-08-31');
    await userEvent.click(within(form).getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      const p = api.find('GET', '/admin/analytics/revenue').at(-1)!.url.searchParams;
      expect(p.get('range')).toBe('custom');
      expect(p.get('from')).toBe('2026-06-01');
      expect(p.get('to')).toBe('2026-08-31');
    });
    expect(screen.queryByRole('form', { name: 'Custom range' })).toBeNull();
  });

  it('page-level empty state before the first nightly run; history note', async () => {
    mockApi([revenueOk(revenueData, { as_of: null, computed_at: null })]);
    const r = renderApp(<AppRoutes />, { route: '/revenue' });
    expect(await screen.findByText('No data yet')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'MRR' })).toBeNull();
    r.unmount();
    mockApi([revenueOk(revenueData, { from: '2024-06-01', data_starts_on: '2025-01-01' })]);
    renderApp(<AppRoutes />, { route: '/revenue' });
    expect(await screen.findByTestId('analytics-as-of')).toHaveTextContent('History starts 1 Jan 2025');
  });

  it('Support has no access', async () => {
    const api = mockApi([revenueOk()], { session: adminSession('support') });
    renderApp(<AppRoutes />, { route: '/revenue' });
    expect(await screen.findByText('You don’t have access to revenue reports')).toBeInTheDocument();
    expect(api.find('GET', '/admin/analytics/revenue')).toHaveLength(0);
  });
});

describe('merchants list 32:5527 metrics', () => {
  const rows = [
    tenant({ id: 'T1', last_active_at: new Date(Date.now() - 12 * 60_000).toISOString(), metrics: { as_of: '2026-11-22', mrr_amount: 299900, is_comp: false, orders_30d: 4810, gmv_30d_amount: 962050000 } }),
    tenant({ id: 'T2', name: 'Rong Bazar', last_active_at: null, metrics: null }),
    tenant({ id: 'T3', name: 'Comp Shop', metrics: { as_of: '2026-11-22', mrr_amount: 0, is_comp: true, orders_30d: 5, gmv_30d_amount: 100000 } }),
  ];
  const list = on('GET', '/admin/tenants', () =>
    jsonResponse(200, { data: rows, meta: { current_page: 1, per_page: 25, total: 3, last_page: 1, counts: { all: 3, paying: 2, trial: 0, past_due: 0, suspended: 0 }, metrics_as_of: '2026-11-22' } }),
  );

  it('metric cells, "—" for missing metrics, Comp, relative last active and the MRR header caption', async () => {
    mockApi([list, analyticsOk()]);
    renderApp(<AppRoutes />, { route: '/merchants' });
    const gadget = (await screen.findByText('Gadget Haat')).closest('[role="row"]') as HTMLElement;
    expect(within(gadget).getByText('2,999')).toBeInTheDocument();
    expect(within(gadget).getByText('4,810')).toBeInTheDocument();
    expect(within(gadget).getByText('96,20,500')).toBeInTheDocument();
    expect(within(gadget).getByText('12 min ago')).toBeInTheDocument();
    const rong = screen.getByText('Rong Bazar').closest('[role="row"]') as HTMLElement;
    expect(within(rong).getAllByText('—').length).toBeGreaterThanOrEqual(4);
    expect(within(screen.getByText('Comp Shop').closest('[role="row"]') as HTMLElement).getByText('Comp')).toBeInTheDocument();
    expect(await screen.findByText('3 shops · 2 paying · ৳ 18.4 L MRR')).toBeInTheDocument();
  });

  it('sort select maps to the sort param; Support sees no MRR in the caption', async () => {
    const api = mockApi([list, analyticsOk()], { session: adminSession('support') });
    renderApp(<AppRoutes />, { route: '/merchants' });
    await screen.findByText('Gadget Haat');
    expect(screen.getByText('3 shops · 2 paying')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), 'MRR · high to low');
    await waitFor(() => expect(api.find('GET', '/admin/tenants').at(-1)!.url.searchParams.get('sort')).toBe('-mrr'));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), 'Last active · recent first');
    await waitFor(() => expect(api.find('GET', '/admin/tenants').at(-1)!.url.searchParams.get('sort')).toBe('-last_active_at'));
    expect(api.find('GET', '/admin/analytics/overview')).toHaveLength(0);
  });

  it('reads ?sort=-mrr from the URL (Top paying merchants link)', async () => {
    const api = mockApi([on('GET', '/admin/tenants', () => emptyList({ counts: { all: 0, paying: 0, trial: 0, past_due: 0, suspended: 0 } }))]);
    renderApp(<AppRoutes />, { route: '/merchants?sort=-mrr' });
    await screen.findByText('No merchants yet');
    expect(api.find('GET', '/admin/tenants')[0]!.url.searchParams.get('sort')).toBe('-mrr');
    expect(screen.getByRole('combobox', { name: 'Sort' })).toHaveValue('-mrr');
  });
});

describe('merchant detail 33:4851 metrics', () => {
  const metrics: AdminTenantMetrics = {
    mrr_amount: 49900, is_comp: false, plan_code: 'starter', billing_interval: 'month',
    orders_30d: 120, previous_orders_30d: 100, gmv_30d_amount: 96_000_000, previous_gmv_30d_amount: 80_000_000, aov_30d_amount: 80000,
    avg_orders_per_day_30d: 4, gmv_month_amount: 62_000_000, paid_12m_amount: 598800,
    monthly: Array.from({ length: 12 }, (_, i) => ({ month: `2026-${String(i + 1).padStart(2, '0')}`, gmv_amount: i === 0 ? null : (i + 1) * 1_000_000, orders_count: i === 0 ? null : i })),
  };
  const detail = (m: AdminTenantMetrics | 'error', metaOver: Partial<AnalyticsMeta> = {}) =>
    mockApi([
      on('GET', '/admin/tenants/T1', () => jsonResponse(200, { data: tenant() })),
      on('GET', '/admin/tenants/T1/metrics', () =>
        m === 'error' ? jsonResponse(500, { error: { code: 'server_error', message: 'Boom' } }) : jsonResponse(200, { data: m, meta: meta({ range: '30d', ...metaOver }) }),
      ),
      on('GET', /\/admin\/tenants\/T1\/(invoices|audit-logs)$/, () => jsonResponse(200, { data: [], meta: { current_page: 1, per_page: 5, total: 0, last_page: 1, next_cursor: null, prev_cursor: null } })),
    ]);

  it('tiles (MRR, Orders · 30d, GMV · 30d, Lifetime paid) and the GMV & platform revenue card', async () => {
    detail(metrics);
    renderApp(<AppRoutes />, { route: '/merchants/T1' });
    expect(await screen.findByText('Starter · monthly')).toBeInTheDocument();
    expect(screen.getByText('↑ 20% vs previous 30 days')).toBeInTheDocument();
    expect(screen.getByText('AOV ৳ 800')).toBeInTheDocument();
    expect(screen.getByText('৳ 9.6 L')).toBeInTheDocument();
    expect(screen.queryByText('Health score')).toBeNull();
    expect(screen.getByRole('heading', { name: 'GMV & platform revenue' })).toBeInTheDocument();
    expect(screen.getByText('৳ 6.2 L')).toBeInTheDocument();
    expect(screen.getByText('৳ 5,988')).toBeInTheDocument();
    expect(screen.getByText('↑ 20%')).toBeInTheDocument();
    const bars = screen.getByRole('table', { name: 'GMV per month' });
    expect(within(bars).getByText('No data')).toBeInTheDocument();
  });

  it('comp caption and error state with retry', async () => {
    detail({ ...metrics, is_comp: true, mrr_amount: 0 });
    const r = renderApp(<AppRoutes />, { route: '/merchants/T1' });
    expect(await screen.findByText('Comp · not billed')).toBeInTheDocument();
    r.unmount();
    detail('error');
    renderApp(<AppRoutes />, { route: '/merchants/T1' });
    expect(await screen.findByText('We couldn’t load this shop’s metrics.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Try again' }).length).toBeGreaterThan(0);
  });
});
