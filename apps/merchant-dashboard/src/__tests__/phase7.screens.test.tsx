import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { payNavigation } from '../settings/billing/PayDialog';
import { callsTo, jsonResponse, renderApp, signedIn } from '../test/utils';
import {
  billingRoutes,
  deliveryReport,
  features,
  inDays,
  invoice,
  invoicesResponse,
  invoiceSummary,
  payment,
  planBy,
  profitReport,
  quote,
  reportMeta,
  salesReport,
  subscription,
} from './phase7.fixtures';

// Phase 7 §11 "Dashboard": plan cards per state and role, Monthly/Yearly, quote + change + pay, provider errors, return
// polling, invoices, banners, 402 dialog; reports range ↔ URL, tab states and profit gating.

const SLOW = { timeout: 5000 };
const plan = '/settings/plan';
const byMethod = (fetchMock: Parameters<typeof callsTo>[0], path: string, method: string) => callsTo(fetchMock, path).filter((c) => (c[1].method ?? 'GET') === method);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Plan & billing', () => {
  it('Free owner: subscribe buttons, Monthly/Yearly prices, payment method and empty invoices', async () => {
    signedIn('owner', billingRoutes(subscription()));
    renderApp(<AppRoutes />, { route: plan });
    expect(await screen.findByRole('heading', { name: 'Free plan' }, SLOW)).toBeInTheDocument();
    const plans = screen.getByRole('region', { name: 'Plans' });
    expect(within(plans).getByRole('button', { name: 'Subscribe to Starter' })).toBeInTheDocument();
    expect(within(plans).getByRole('button', { name: 'Subscribe to Growth' })).toBeInTheDocument();
    expect(within(plans).getByRole('button', { name: 'Current plan' })).toBeDisabled();
    expect(within(plans).getByText('৳ 1,499')).toBeInTheDocument();
    await userEvent.click(within(plans).getByRole('button', { name: 'Yearly · 2 months free' }));
    expect(within(plans).getByText('৳ 14,990')).toBeInTheDocument();
    expect(within(plans).getAllByText('/ year')).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'Payment method' })).toHaveTextContent('nothing is charged automatically');
    expect(await screen.findByText('No invoices yet')).toBeInTheDocument();
  });

  it('trial: Starter shows "Your trial" and Subscribe; trial strip', async () => {
    signedIn('owner', billingRoutes(subscription({ status: 'trialing', plan: planBy('starter'), trial_ends_at: inDays(5) })));
    renderApp(<AppRoutes />, { route: plan });
    await screen.findByRole('heading', { name: 'Starter plan' }, SLOW);
    expect(screen.getByText('Free trial')).toBeInTheDocument();
    expect(screen.getByText(/left in your Starter trial/)).toBeInTheDocument();
    expect(screen.getByText('Your trial')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Plans' })).getByRole('button', { name: 'Subscribe to Starter' })).toBeInTheDocument();
  });

  it('paid Starter: upgrade and switch labels; scheduled change with Keep', async () => {
    const sub = subscription({ plan: planBy('starter'), scheduled_change: { plan: planBy('free'), interval: 'month', effective_at: '2026-12-01T00:00:00Z' }, cancel_at_period_end: true });
    const fetchMock = signedIn('owner', billingRoutes(sub, undefined, { 'DELETE /billing/scheduled-change': jsonResponse(200, { data: subscription({ plan: planBy('starter') }) }) }));
    renderApp(<AppRoutes />, { route: plan });
    await screen.findByRole('heading', { name: 'Starter plan' }, SLOW);
    expect(screen.getByText('Ends 1 Dec')).toBeInTheDocument();
    expect(screen.getByText('Switches to Free on 1 Dec 2026.')).toBeInTheDocument();
    const plans = screen.getByRole('region', { name: 'Plans' });
    expect(within(plans).getByRole('button', { name: 'Upgrade to Growth' })).toBeInTheDocument();
    expect(within(plans).getByRole('button', { name: 'Scheduled' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Keep Starter' }));
    await waitFor(() => expect(byMethod(fetchMock, '/billing/scheduled-change', 'DELETE')).toHaveLength(1));
  });

  it('admin reads only; staff gets the empty state', async () => {
    signedIn('admin', billingRoutes(subscription({ plan: planBy('starter') })));
    const { unmount } = renderApp(<AppRoutes />, { route: plan });
    await screen.findByRole('heading', { name: 'Starter plan' }, SLOW);
    expect(screen.getByText('Only the shop owner can change the plan.')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Plans' })).queryByRole('button', { name: /Upgrade|Switch|Subscribe/ })).not.toBeInTheDocument();
    unmount();
    vi.unstubAllGlobals();
    signedIn('staff', billingRoutes(subscription()));
    renderApp(<AppRoutes />, { route: plan });
    expect(await screen.findByText('Plan & billing is for owners and managers', undefined, SLOW)).toBeInTheDocument();
  });

  it('upgrade: quote → change-plan (Idempotency-Key) → pay with bKash → provider redirect', async () => {
    const assign = vi.spyOn(payNavigation, 'assign').mockImplementation(() => undefined);
    const fetchMock = signedIn(
      'owner',
      billingRoutes(subscription({ plan: planBy('starter') }), undefined, {
        'POST /billing/quote': jsonResponse(200, { data: quote({ warnings: [{ key: 'products', used: 140, limit: null, message: 'You have 140 products; Growth has no limit' }] }) }),
        'POST /billing/change-plan': jsonResponse(201, { data: { subscription: subscription({ plan: planBy('starter') }), invoice: invoice({ kind: 'upgrade', total_amount: 40000 }) } }),
        'POST /billing/invoices/I1/pay': jsonResponse(201, { data: payment() }),
      }),
    );
    renderApp(<AppRoutes />, { route: plan });
    await screen.findByRole('heading', { name: 'Starter plan' }, SLOW);
    await userEvent.click(within(screen.getByRole('region', { name: 'Plans' })).getByRole('button', { name: 'Upgrade to Growth' }));
    const dialog = await screen.findByRole('dialog', { name: 'Upgrade to Growth' });
    expect(await within(dialog).findByText('Charged ৳ 400 now for the rest of this month, then ৳ 1,499 on 1 Dec 2026.')).toBeInTheDocument();
    expect(within(dialog).getByText('You have 140 products; Growth has no limit')).toBeInTheDocument();
    expect(JSON.parse(String(byMethod(fetchMock, '/billing/quote', 'POST')[0]![1].body))).toEqual({ plan_code: 'growth', interval: 'month' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue to pay ৳ 400' }));
    const pay = await screen.findByRole('dialog', { name: 'Pay ৳ 400' });
    const change = byMethod(fetchMock, '/billing/change-plan', 'POST')[0]!;
    expect((change[1].headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
    expect(within(pay).getByText(/SP-2026-000123/)).toBeInTheDocument();
    expect(within(pay).getByRole('radio', { name: /bKash/ })).toBeChecked();
    await userEvent.click(within(pay).getByRole('button', { name: 'Pay now' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://sandbox.bka.sh/checkout/abc'));
    expect(JSON.parse(String(byMethod(fetchMock, '/billing/invoices/I1/pay', 'POST')[0]![1].body))).toEqual({ provider: 'bkash' });
  });

  it('downgrade quote: no charge, schedules and closes', async () => {
    const fetchMock = signedIn(
      'owner',
      billingRoutes(subscription({ plan: planBy('growth') }), undefined, {
        'POST /billing/quote': jsonResponse(200, {
          data: quote({
            kind: 'downgrade',
            plan: planBy('starter'),
            amount: 0,
            requires_payment: false,
            lines: [],
            effective_at: '2026-12-01T00:00:00Z',
            warnings: [
              { key: 'profit_reports', used: null, limit: null, message: 'Profit & loss reports is not included in Starter.' },
              { key: 'products', used: 140, limit: 1000, message: 'You have 140 products; Starter allows 1,000.' },
            ],
          }),
        }),
        'POST /billing/change-plan': jsonResponse(200, { data: { subscription: subscription({ plan: planBy('growth'), scheduled_change: { plan: planBy('starter'), interval: 'month', effective_at: '2026-12-01T00:00:00Z' } }), invoice: null } }),
      }),
    );
    renderApp(<AppRoutes />, { route: plan });
    await screen.findByRole('heading', { name: 'Growth plan' }, SLOW);
    await userEvent.click(within(screen.getByRole('region', { name: 'Plans' })).getByRole('button', { name: 'Switch to Starter' }));
    const dialog = await screen.findByRole('dialog', { name: 'Switch to Starter' });
    expect(await within(dialog).findByText(/no charge/)).toBeInTheDocument();
    const lost = within(dialog).getByText('Profit & loss reports is not included in Starter.').closest('li')!;
    expect(within(lost).getByLabelText('Heads up')).toBeInTheDocument();
    expect(within(within(dialog).getByText('You have 140 products; Starter allows 1,000.').closest('li')!).getByLabelText('Fits')).toBeInTheDocument();
    expect(within(dialog).queryByText('profit_reports')).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Switch to Starter' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Switch to Starter' })).not.toBeInTheDocument());
    expect(byMethod(fetchMock, '/billing/change-plan', 'POST')).toHaveLength(1);
    expect(byMethod(fetchMock, '/billing/invoices/I1/pay', 'POST')).toHaveLength(0);
  });

  it('quote errors show the API message (422 plan_unavailable)', async () => {
    signedIn('owner', billingRoutes(subscription({ plan: planBy('starter'), billing_interval: 'year' }), undefined, {
      'POST /billing/quote': jsonResponse(422, { error: { code: 'plan_unavailable', message: 'Switch to Growth yearly or change at renewal.' } }),
    }));
    renderApp(<AppRoutes />, { route: plan });
    await screen.findByRole('heading', { name: 'Starter plan' }, SLOW);
    await userEvent.click(within(screen.getByRole('region', { name: 'Plans' })).getByRole('button', { name: 'Upgrade to Growth' }));
    expect(await screen.findByText('Switch to Growth yearly or change at renewal.')).toBeInTheDocument();
  });

  it('pay dialog: 422 billing_gateway_unavailable hides the provider; 502 asks to retry', async () => {
    const open = invoiceSummary({ kind: 'renewal', total_amount: 49900, due_at: inDays(-1), is_overdue: true });
    let calls = 0;
    signedIn(
      'owner',
      billingRoutes(subscription({ status: 'past_due', plan: planBy('starter'), grace_ends_at: '2026-11-25T00:00:00Z', open_invoice: open }), undefined, {
        'POST /billing/invoices/I1/pay': () => (++calls === 1 ? jsonResponse(422, { error: { code: 'billing_gateway_unavailable', message: 'No' } }) : jsonResponse(502, { error: { code: 'provider_unavailable', message: 'Down' } })),
      }),
    );
    renderApp(<AppRoutes />, { route: plan });
    await screen.findByText('Past due', undefined, SLOW);
    expect(screen.getByText(/Payment failed — ৳ 499 due\. Pay by 25 Nov 2026/)).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('region', { name: 'Current plan' })).getByRole('button', { name: 'Pay now' }));
    const pay = await screen.findByRole('dialog', { name: 'Pay ৳ 499' });
    await userEvent.click(within(pay).getByRole('button', { name: 'Pay now' }));
    expect(await within(pay).findByText(/bKash isn’t available right now/)).toBeInTheDocument();
    expect(within(pay).queryByRole('radio', { name: /bKash/ })).not.toBeInTheDocument();
    expect(within(pay).getByRole('radio', { name: /SSLCommerz/ })).toBeChecked();
    await userEvent.click(within(pay).getByRole('button', { name: 'Pay now' }));
    expect(await within(pay).findByText(/didn’t answer\. Nothing was charged/)).toBeInTheDocument();
  });

  it('return: succeeded payment shows the receipt and strips the params', async () => {
    signedIn('owner', billingRoutes(subscription({ plan: planBy('growth') }), undefined, {
      'GET /billing/payments/PAY1': jsonResponse(200, { data: payment({ status: 'succeeded', redirect_url: null }) }),
      'GET /billing/invoices/I1': jsonResponse(200, { data: invoice({ status: 'paid' }) }),
    }));
    renderApp(<AppRoutes />, { route: `${plan}?payment=PAY1` });
    expect(await screen.findByText(/You’re on Growth\. Receipt SP-2026-000123\./, undefined, SLOW)).toBeInTheDocument();
  });

  it('return: failed payment offers Pay again; pending says confirming; payment_error is generic', async () => {
    signedIn('owner', billingRoutes(subscription({ plan: planBy('starter') }), undefined, {
      'GET /billing/payments/PAY1': jsonResponse(200, { data: payment({ status: 'failed', failure_code: 'amount_mismatch' }) }),
      'GET /billing/payments/PAY2': jsonResponse(200, { data: payment({ id: 'PAY2' }) }),
    }));
    const a = renderApp(<AppRoutes />, { route: `${plan}?payment=PAY1` });
    expect(await screen.findByText('Payment didn’t go through. You haven’t been charged.', undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay again' })).toBeInTheDocument();
    a.unmount();
    const b = renderApp(<AppRoutes />, { route: `${plan}?payment=PAY2` });
    expect(await screen.findByText('Confirming your payment…', undefined, SLOW)).toBeInTheDocument();
    b.unmount();
    renderApp(<AppRoutes />, { route: `${plan}?payment_error=1` });
    expect(await screen.findByText(/We couldn’t confirm that payment/, undefined, SLOW)).toBeInTheDocument();
  });

  it('invoices: statuses, Pay on open rows, PDF download', async () => {
    const rows = [
      invoiceSummary({ id: 'I1', number: 'SP-2026-000003', status: 'open', is_overdue: true }),
      invoiceSummary({ id: 'I2', number: 'SP-2026-000002', status: 'paid', can_pay: false, paid_at: inDays(-20) }),
      invoiceSummary({ id: 'I3', number: 'SP-2026-000001', status: 'void', can_pay: false }),
    ];
    const createUrl = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() }));
    const fetchMock = signedIn('owner', billingRoutes(subscription({ plan: planBy('growth') }), undefined, {
      'GET /billing/invoices': invoicesResponse(rows),
      'GET /billing/invoices/I1': jsonResponse(200, { data: invoice() }),
      'GET /billing/invoices/I2/pdf': new Response(new Blob(['%PDF']), { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="SP-2026-000002.pdf"' } }),
    }));
    renderApp(<AppRoutes />, { route: plan });
    const card = await screen.findByRole('region', { name: 'Invoices' }, SLOW);
    const table = await within(card).findByRole('table');
    expect(within(table).getByRole('row', { name: /SP-2026-000003/ })).toHaveTextContent('Overdue');
    expect(within(table).getByRole('row', { name: /SP-2026-000002/ })).toHaveTextContent('Paid');
    expect(within(table).getByRole('row', { name: /SP-2026-000001/ })).toHaveTextContent('Void');
    expect(within(within(table).getByRole('row', { name: /SP-2026-000003/ })).getByRole('button', { name: 'Pay' })).toBeInTheDocument();
    expect(within(within(table).getByRole('row', { name: /SP-2026-000002/ })).queryByRole('button', { name: 'Pay' })).not.toBeInTheDocument();
    expect(await within(card).findByText(/Invoices are issued to Mugdho Fashion, House 12/)).toBeInTheDocument();
    await userEvent.click(within(table).getByRole('button', { name: 'Download SP-2026-000002 PDF' }));
    await waitFor(() => expect(callsTo(fetchMock, '/billing/invoices/I2/pdf')).toHaveLength(1));
    await waitFor(() => expect(createUrl).toHaveBeenCalled());
  });

  it('?upgrade=growth from the 402 dialog opens the change dialog for the owner', async () => {
    signedIn('owner', billingRoutes(subscription({ plan: planBy('starter') }), undefined, { 'POST /billing/quote': jsonResponse(200, { data: quote() }) }));
    renderApp(<AppRoutes />, { route: `${plan}?upgrade=growth` });
    expect(await screen.findByRole('dialog', { name: 'Upgrade to Growth' }, SLOW)).toBeInTheDocument();
  });
});

describe('App-wide billing banners', () => {
  it('past_due banner with Pay now (owner)', async () => {
    signedIn('owner', billingRoutes(subscription({ status: 'past_due', plan: planBy('starter'), grace_ends_at: '2026-11-25T00:00:00Z', open_invoice: invoiceSummary({ kind: 'renewal' }) }), features({ plan_code: 'starter', subscription_status: 'past_due' }), {
      'GET /stores/S1/dashboard': jsonResponse(404, { error: { code: 'not_found', message: 'x' } }),
    }));
    renderApp(<AppRoutes />, { route: '/customers' });
    const banner = await screen.findByText('Payment failed for your Starter plan. Pay by 25 Nov to keep your custom domain.', undefined, SLOW);
    expect(within(banner.closest('[role="alert"]') as HTMLElement).getByRole('link', { name: 'Pay now' })).toHaveAttribute('href', '/settings/plan?pay=1');
  });

  it('domain grace banner wins over renewal; admin gets View plan', async () => {
    signedIn('admin', billingRoutes(subscription({ plan: planBy('starter'), domain_grace_ends_at: '2026-11-30T00:00:00Z', open_invoice: invoiceSummary({ kind: 'renewal', due_at: inDays(2) }) })));
    renderApp(<AppRoutes />, { route: '/customers' });
    expect(await screen.findByText('Your custom domain stops working on 30 Nov. Upgrade to keep it.', undefined, SLOW)).toBeInTheDocument();
    expect(screen.queryByText(/renews on/)).not.toBeInTheDocument();
  });

  it('staff: 402 dialog asks the owner instead of upgrading', async () => {
    const { handlePlanLimit } = await import('../plan/Banners');
    signedIn('staff', billingRoutes(subscription()));
    renderApp(<AppRoutes />, { route: '/customers' });
    await screen.findByRole('heading', { name: 'Customers' }, SLOW);
    handlePlanLimit(Object.assign(new (await import('@storeplix/api-client')).ApiError(402, 'plan_limit_reached', 'Your plan allows 100 products.', { upgrade_plan: ['starter'] })));
    const dialog = await screen.findByRole('dialog', { name: 'You’ve reached your plan’s limit' });
    expect(within(dialog).getByText(/Ask your shop owner to upgrade/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'OK' })).toBeInTheDocument();
  });
});

describe('Reports', () => {
  const reportRoutes = (o: Record<string, Response | ((init: RequestInit) => Response)> = {}) => ({
    'GET /features': jsonResponse(200, { data: features({ plan_code: 'growth', features: { ...features().features, profit_reports: true } }) }),
    'GET /stores/S1/reports/sales': jsonResponse(200, { data: salesReport(), meta: reportMeta() }),
    'GET /stores/S1/reports/profit': jsonResponse(200, { data: profitReport(), meta: reportMeta() }),
    'GET /stores/S1/reports/delivery': jsonResponse(200, { data: deliveryReport(), meta: reportMeta() }),
    ...o,
  });

  it('/reports opens Sales with KPIs, charts with sr tables, channels and districts', async () => {
    signedIn('owner', reportRoutes());
    renderApp(<AppRoutes />, { route: '/reports' });
    expect(await screen.findByRole('heading', { name: 'Sales overview' }, SLOW)).toBeInTheDocument();
    expect((await screen.findAllByText('৳ 4,86,200', undefined, SLOW)).length).toBeGreaterThan(0);
    expect(screen.getByText('↑ 14%')).toBeInTheDocument();
    expect(screen.getByText('5.8% of orders · fake orders: 5')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Sales per day' })).toBeInTheDocument();
    expect(screen.getByText('Sat 14 Nov · ৳ 31,400')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Orders by channel' })).toHaveTextContent('Facebook');
    expect(screen.getByRole('region', { name: 'Top products' })).toHaveTextContent('Jamdani Three-Piece');
    expect(screen.getByText('Inside Dhaka · 47%')).toBeInTheDocument();
  });

  it('range picker writes the URL and refetches with from/to', async () => {
    const fetchMock = signedIn('owner', reportRoutes());
    renderApp(<AppRoutes />, { route: '/reports/sales' });
    await screen.findAllByText('৳ 4,86,200', undefined, SLOW);
    await userEvent.click(screen.getByRole('tab', { name: 'Last 30 days' }));
    await waitFor(() => {
      const urls = callsTo(fetchMock, '/stores/S1/reports/sales').map((c) => new URL(c[0], 'http://x'));
      expect(urls.length).toBeGreaterThan(1);
      const last = urls.at(-1)!;
      expect(last.searchParams.get('from')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(last.searchParams.get('from')).not.toBe(urls[0]!.searchParams.get('from'));
    });
    expect(screen.getByRole('tab', { name: 'Last 30 days' })).toHaveAttribute('aria-selected', 'true');
  });

  it('custom range validates before applying', async () => {
    signedIn('owner', reportRoutes());
    renderApp(<AppRoutes />, { route: '/reports/sales?from=2026-11-02&to=2026-11-10' });
    expect(await screen.findByRole('tab', { name: 'Custom' }, SLOW)).toHaveAttribute('aria-selected', 'true');
    const from = screen.getByLabelText('From');
    await userEvent.clear(from);
    await userEvent.type(from, '2026-11-12');
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('The start date must be before the end date.')).toBeInTheDocument();
  });

  it('empty, error and loading states', async () => {
    signedIn('owner', reportRoutes({
      'GET /stores/S1/reports/sales': jsonResponse(200, { data: salesReport({ summary: { ...salesReport().summary, orders_count: 0, sold_orders_count: 0 }, channels: [], daily: [] }), meta: reportMeta() }),
      'GET /stores/S1/reports/delivery': jsonResponse(500, { error: { code: 'server_error', message: 'Boom' } }),
    }));
    const a = renderApp(<AppRoutes />, { route: '/reports/sales' });
    expect(await screen.findByText('No orders in this period', undefined, SLOW)).toBeInTheDocument();
    a.unmount();
    renderApp(<AppRoutes />, { route: '/reports/delivery' });
    expect(await screen.findByText('We couldn’t load the delivery report', undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('profit: Growth owner sees the waterfall, data-quality notice and 7 of N days', async () => {
    signedIn('owner', reportRoutes());
    renderApp(<AppRoutes />, { route: '/reports/profit' });
    expect(await screen.findByRole('heading', { name: 'Profit & loss' }, SLOW)).toBeInTheDocument();
    expect(await screen.findByText(/12 items have no cost price/, undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Revenue to net profit' })).toHaveTextContent('Not tracked');
    expect(screen.getByText('Showing 7 of 9 days')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show all 9 days' }));
    expect(screen.getByText('All 9 days')).toBeInTheDocument();
  });

  it('profit on Starter shows the upgrade card without a request; staff never sees the tab', async () => {
    const fetchMock = signedIn('owner', reportRoutes({ 'GET /features': jsonResponse(200, { data: features({ plan_code: 'starter' }) }) }));
    const a = renderApp(<AppRoutes />, { route: '/reports/profit' });
    expect(await screen.findByText('See what you actually keep', undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Upgrade to Growth' })).toHaveAttribute('href', '/settings/plan?upgrade=growth');
    expect(callsTo(fetchMock, '/stores/S1/reports/profit')).toHaveLength(0);
    a.unmount();
    vi.unstubAllGlobals();
    signedIn('staff', reportRoutes());
    renderApp(<AppRoutes />, { route: '/reports/profit' });
    expect(await screen.findByRole('heading', { name: 'Sales overview' }, SLOW)).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Profit & loss' })).not.toBeInTheDocument();
  });

  it('delivery: courier rows, reasons, returning parcels link to the order, district tiles', async () => {
    signedIn('owner', reportRoutes());
    renderApp(<AppRoutes />, { route: '/reports/delivery' });
    expect(await screen.findByText('84.2%', undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByText('↑ 3.2 pts')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Delivery success by courier' })).toHaveTextContent('Steadfast');
    expect(screen.getByRole('region', { name: 'Why parcels came back' })).toHaveTextContent('Refused at door');
    expect(screen.getByRole('link', { name: /GS-1031 · Rubina Khatun/ })).toHaveAttribute('href', '/orders/O1');
    expect(screen.getByRole('region', { name: 'Delivery success by district' })).toHaveTextContent('Rajshahi');
  });
});
