import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../App';
import { QUOTE_DEBOUNCE_MS } from '../orders/CreateOrderPage';
import { callsTo, jsonResponse, renderApp, signedIn } from '../test/utils';
import { dashboard, product, productList, summary } from './catalog.fixtures';
import { checklist, coupon, geo, order, orderList, orderSummary, settingsWithCommerce, shipping } from './phase5.fixtures';

const SLOW = { timeout: 5000 };
const geoRoute = { 'GET /geo/bd': jsonResponse(200, { data: geo }) };
const bodyOf = (call: [string, RequestInit]) => JSON.parse(String(call[1].body));
const headerOf = (call: [string, RequestInit], name: string) => (call[1].headers as Record<string, string>)[name];

describe('Orders list', () => {
  it('shows status tab counts and runs the next step', async () => {
    const fetchMock = signedIn('staff', {
      ...geoRoute,
      'GET /stores/S1/orders': orderList([orderSummary(), orderSummary({ id: 'O2', number: 'MU-1041', status: 'delivered', payment_status: 'paid', due_amount: 0, paid_amount: 177_000 })]),
      'POST /stores/S1/orders/O1/confirm': jsonResponse(200, { data: order({ status: 'confirmed' }) }),
    });
    renderApp(<AppRoutes />, { route: '/orders' });
    const table = await screen.findByRole('table', { name: 'Orders' }, SLOW);
    expect(await within(table).findByText('MU-1042')).toBeInTheDocument();
    const tabs = screen.getByRole('tablist', { name: 'Order status' });
    expect(within(tabs).getByRole('tab', { name: /Pending\s*4/ })).toBeInTheDocument();
    expect(within(tabs).getByRole('tab', { name: /In transit\s*1/ })).toBeInTheDocument();
    expect(within(table).getAllByText('01712-345678 · 3rd order · 2/3 delivered')).toHaveLength(2);
    // Delivered orders have no next step.
    expect(within(table).queryByRole('button', { name: /MU-1041/ })).toBeNull();
    await userEvent.click(within(table).getByRole('button', { name: 'Confirm MU-1042' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/orders/O1/confirm')).toHaveLength(1));
  });

  it('bulk-confirms the selected orders', async () => {
    const fetchMock = signedIn('owner', {
      ...geoRoute,
      'GET /stores/S1/orders': orderList([orderSummary()]),
      'POST /stores/S1/orders/bulk': jsonResponse(200, { data: { action: 'confirm', updated: 1, skipped: [] } }),
    });
    renderApp(<AppRoutes />, { route: '/orders' });
    const table = await screen.findByRole('table', { name: 'Orders' }, SLOW);
    await userEvent.click(await within(table).findByRole('checkbox', { name: 'Select MU-1042' }));
    await userEvent.click(within(screen.getByRole('region', { name: 'Bulk actions' })).getByRole('button', { name: 'Confirm 1 order' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/orders/bulk')).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, '/stores/S1/orders/bulk')[0]!)).toEqual({ action: 'confirm', ids: ['O1'] });
  });

  it('shows the empty state when there are no orders', async () => {
    signedIn('owner', { ...geoRoute, 'GET /stores/S1/orders': orderList([], { ...orderSummaryCounts(0) }) });
    renderApp(<AppRoutes />, { route: '/orders' });
    expect(await screen.findByRole('heading', { name: 'No orders yet' }, SLOW)).toBeInTheDocument();
  });
});

function orderSummaryCounts(n: number) {
  return { all: n, pending_payment: 0, pending: 0, confirmed: 0, ready_to_ship: 0, shipped: 0, delivered: 0, returned: 0, cancelled: 0 };
}

describe('Order detail', () => {
  it('shows transition buttons from allowed_transitions and sends the cancel payload', async () => {
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/settings': settingsWithCommerce(),
      'GET /stores/S1/orders/O1': jsonResponse(200, { data: order() }),
      'POST /stores/S1/orders/O1/cancel': jsonResponse(200, { data: order({ status: 'cancelled', allowed_transitions: [] }) }),
    });
    renderApp(<AppRoutes />, { route: '/orders/O1' });
    expect(await screen.findByRole('heading', { name: 'MU-1042' }, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark shipped' })).toBeNull();
    expect(screen.getByText('43 in stock')).toBeInTheDocument();
    expect(screen.getByText('Due on delivery ৳ 1,770')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel order' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('Reason'), 'unreachable');
    await userEvent.type(within(dialog).getByLabelText('Note (optional)'), 'No answer 3 times');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/orders/O1/cancel')).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, '/stores/S1/orders/O1/cancel')[0]!)).toEqual({ reason: 'unreachable', note: 'No answer 3 times', notify_customer: true });
  });

  it('reloads with a toast on 409', async () => {
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/orders/O1': jsonResponse(200, { data: order() }),
      'POST /stores/S1/orders/O1/confirm': jsonResponse(409, { error: { code: 'invalid_state_transition', message: 'No.' } }),
    });
    renderApp(<AppRoutes />, { route: '/orders/O1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }, SLOW));
    expect(await screen.findByText('This order changed. We reloaded it.')).toBeInTheDocument();
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/orders/O1').length).toBeGreaterThan(1));
  });

  it('owner refund dialog is bounded by what was paid', async () => {
    const paid = order({ status: 'delivered', payment_status: 'paid', paid_amount: 177_000, due_amount: 0, allowed_transitions: [] });
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/orders/O1': jsonResponse(200, { data: paid }),
      'POST /stores/S1/orders/O1/refunds': jsonResponse(201, { data: { id: 'R1' } }),
    });
    renderApp(<AppRoutes />, { route: '/orders/O1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Record refund' }, SLOW));
    const dialog = await screen.findByRole('dialog');
    const amount = within(dialog).getByLabelText('Amount');
    await userEvent.clear(amount);
    await userEvent.type(amount, '2000');
    expect(within(dialog).getByText('You can refund up to ৳ 1,770.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Record refund' })).toBeDisabled();
    await userEvent.clear(amount);
    await userEvent.type(amount, '500');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record refund' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/orders/O1/refunds')).toHaveLength(1));
    const call = callsTo(fetchMock, '/stores/S1/orders/O1/refunds')[0]!;
    expect(bodyOf(call)).toMatchObject({ amount: 50_000, method: 'cash' });
    expect(headerOf(call, 'Idempotency-Key')).toBeTruthy();
  });

  it('staff: no refund action and no cancel for paid orders', async () => {
    signedIn('staff', {
      'GET /stores/S1/orders/O1': jsonResponse(200, { data: order({ status: 'delivered', paid_amount: 177_000, payment_status: 'paid', allowed_transitions: [], can: { edit: false, cancel: false, refund: false } }) }),
    });
    renderApp(<AppRoutes />, { route: '/orders/O1' });
    expect(await screen.findByRole('heading', { name: 'MU-1042' }, SLOW)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record refund' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel order' })).toBeNull();
  });
});

describe('Edit order', () => {
  it('keeps the shipping hint after the save remounts the form', async () => {
    let rev = 1;
    const hint = { zone_id: 'Z9', zone_name: 'Outside Dhaka', min_days: 2, max_days: 4, charge_amount: 13_000, amount: 13_000, is_free: false };
    const fetchMock = signedIn('owner', {
      ...geoRoute,
      'GET /stores/S1/orders/O1': () => jsonResponse(200, { data: order({ revision: rev }) }),
      'PATCH /stores/S1/orders/O1': () => {
        rev = 2;
        return jsonResponse(200, { data: order({ revision: 2 }), meta: { shipping_hint: hint } });
      },
    });
    renderApp(<AppRoutes />, { route: '/orders/O1/edit' });
    await screen.findByRole('option', { name: 'Gazipur' }, SLOW);
    await userEvent.selectOptions(screen.getByLabelText('District'), 'gazipur');
    await userEvent.selectOptions(screen.getByLabelText('Thana / Upazila'), 'gazipur-sadar');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/The new address is in/, {}, SLOW)).toHaveTextContent('Outside Dhaka (2–4 days), where delivery is ৳ 130. This order keeps its delivery charge of ৳ 70.');
    expect(bodyOf(callsTo(fetchMock, '/stores/S1/orders/O1').find((c) => c[1].method === 'PATCH')!)).toMatchObject({ revision: 1, shipping_address: { district_code: 'gazipur', thana_code: 'gazipur-sadar' } });
  });
});

describe('Create order', () => {
  it('debounces the quote and reuses the Idempotency-Key on retry', async () => {
    let attempt = 0;
    const fetchMock = signedIn('owner', {
      ...geoRoute,
      'GET /stores/S1/customers': jsonResponse(200, { data: [], meta: { current_page: 1, per_page: 5, total: 0, last_page: 1, counts: { all: 0, new_this_month: 0 } } }),
      'GET /stores/S1/products': productList([summary()]),
      'GET /stores/S1/products/P1': jsonResponse(200, { data: product() }),
      'POST /stores/S1/orders/quote': jsonResponse(200, {
        data: { lines: [], zone: { zone_id: 'Z1', zone_name: 'Inside Dhaka', min_days: 1, max_days: 2, charge_amount: 7_000, amount: 7_000, is_free: false }, coupon_error: null, subtotal_amount: 690_000, discount_amount: 0, shipping_amount: 7_000, total_amount: 697_000, customer: null },
      }),
      'POST /stores/S1/orders': () => (++attempt === 1 ? jsonResponse(500, { error: { code: 'server_error', message: 'Boom' } }) : jsonResponse(201, { data: order() })),
      'GET /stores/S1/orders/O1': jsonResponse(200, { data: order() }),
    });
    renderApp(<AppRoutes />, { route: '/orders/new' });
    await userEvent.type(await screen.findByLabelText('Search products', {}, SLOW), 'Jam');
    await userEvent.click(await screen.findByRole('button', { name: /Jamdani Three-Piece/ }, SLOW));
    await userEvent.click(await screen.findByRole('button', { name: 'Add' }, SLOW));
    const more = await screen.findByRole('button', { name: 'More Jamdani Three-Piece' });
    await userEvent.click(more);
    await userEvent.click(more);
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/orders/quote').length).toBeGreaterThan(0), SLOW);
    await new Promise((r) => setTimeout(r, QUOTE_DEBOUNCE_MS + 150));
    const quotes = callsTo(fetchMock, '/stores/S1/orders/quote');
    expect(quotes).toHaveLength(1);
    expect(bodyOf(quotes[0]!).items).toEqual([{ variant_id: 'V1', quantity: 3 }]);
    expect(await screen.findByLabelText('Order total')).toHaveTextContent('৳ 6,970');

    await userEvent.type(screen.getByLabelText('Phone number'), '01712345678');
    await userEvent.type(screen.getByLabelText('Name'), 'Nasrin Akter');
    await userEvent.selectOptions(screen.getByLabelText('District'), 'dhaka');
    await userEvent.selectOptions(screen.getByLabelText('Thana / Upazila'), 'dhaka-mirpur');
    await userEvent.type(screen.getByLabelText('Full address'), 'House 12, Road 7');
    await userEvent.click(screen.getByRole('button', { name: 'Create order' }));
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: 'Create order' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/orders').filter((c) => c[1].method === 'POST')).toHaveLength(2));
    const posts = callsTo(fetchMock, '/stores/S1/orders').filter((c) => c[1].method === 'POST');
    expect(headerOf(posts[0]!, 'Idempotency-Key')).toBe(headerOf(posts[1]!, 'Idempotency-Key'));
    expect(bodyOf(posts[1]!)).toMatchObject({ channel: 'facebook', contact: { name: 'Nasrin Akter', phone: '8801712345678' }, items: [{ variant_id: 'V1', quantity: 3 }], notify_customer: true });
  }, 15_000);
});

describe('Create order: plan limit', () => {
  it('a 402 opens exactly one plan-limit dialog', async () => {
    signedIn('owner', {
      ...geoRoute,
      'GET /stores/S1/customers': jsonResponse(200, { data: [], meta: { current_page: 1, per_page: 5, total: 0, last_page: 1, counts: { all: 0, new_this_month: 0 } } }),
      'GET /stores/S1/products': productList([summary()]),
      'GET /stores/S1/products/P1': jsonResponse(200, { data: product() }),
      'POST /stores/S1/orders/quote': jsonResponse(422, { error: { code: 'validation_failed', message: 'x' } }),
      'POST /stores/S1/orders': jsonResponse(402, { error: { code: 'plan_limit_reached', message: 'You’ve used all 50 orders this month.' } }),
    });
    renderApp(<AppRoutes />, { route: '/orders/new' });
    await userEvent.type(await screen.findByLabelText('Search products', {}, SLOW), 'Jam');
    await userEvent.click(await screen.findByRole('button', { name: /Jamdani Three-Piece/ }, SLOW));
    await userEvent.click(await screen.findByRole('button', { name: 'Add' }, SLOW));
    await userEvent.type(screen.getByLabelText('Phone number'), '01712345678');
    await userEvent.type(screen.getByLabelText('Name'), 'Nasrin Akter');
    await screen.findByRole('option', { name: 'Gazipur' }, SLOW);
    await userEvent.selectOptions(screen.getByLabelText('District'), 'dhaka');
    await userEvent.selectOptions(screen.getByLabelText('Thana / Upazila'), 'dhaka-mirpur');
    await userEvent.type(screen.getByLabelText('Full address'), 'House 12, Road 7');
    await userEvent.click(screen.getByRole('button', { name: 'Create order' }));
    expect(await screen.findByRole('dialog', { name: 'You’ve reached your plan’s limit' }, SLOW)).toBeInTheDocument();
    expect(screen.getAllByRole('dialog', { name: 'You’ve reached your plan’s limit' })).toHaveLength(1);
  }, 15_000);
});

describe('Coupons', () => {
  it('staff sees the list without create', async () => {
    signedIn('staff', { 'GET /stores/S1/coupons': jsonResponse(200, { data: [coupon()], meta: { current_page: 1, per_page: 25, total: 1, last_page: 1, counts: { all: 1, active: 1, scheduled: 0, expired: 0 } } }) });
    renderApp(<AppRoutes />, { route: '/marketing/coupons' });
    const table = await screen.findByRole('table', { name: 'Coupons' }, SLOW);
    expect(await within(table).findByText('WINTER15')).toBeInTheDocument();
    expect(within(table).getByText('15% off · up to ৳ 300')).toBeInTheDocument();
    expect(within(table).getByText('12 / 300')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Create coupon/ })).toBeNull();
  });

  it('create form: type rules, share link and live preview', async () => {
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/categories': jsonResponse(200, { data: [] }),
      'POST /stores/S1/coupons': jsonResponse(201, { data: coupon({ id: 'C2', code: 'EID20' }) }),
      'GET /stores/S1/coupons/C2': jsonResponse(200, { data: coupon({ id: 'C2', code: 'EID20' }) }),
    });
    renderApp(<AppRoutes />, { route: '/marketing/coupons/new' });
    await userEvent.type(await screen.findByLabelText('Code', {}, SLOW), 'eid20');
    expect(screen.getByTestId('share-link')).toHaveTextContent('mugdho.storeplix.com/discount/EID20');
    await userEvent.type(screen.getByLabelText('Discount (%)'), '15');
    await userEvent.type(screen.getByLabelText('Maximum discount (optional)'), '300');
    const preview = screen.getByRole('region', { name: 'At checkout' });
    expect(within(preview).getByText('− ৳ 300')).toBeInTheDocument();
    expect(within(preview).getByText('৳ 2,790')).toBeInTheDocument();
    // Fixed amount needs an amount; Free delivery hides "Applies to".
    await userEvent.click(screen.getByRole('radio', { name: /Fixed amount/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Publish coupon' }));
    expect(await screen.findByText('Enter an amount like 150.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: /Free delivery/ }));
    expect(screen.queryByRole('region', { name: 'Applies to' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Publish coupon' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/coupons')).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, '/stores/S1/coupons')[0]!)).toMatchObject({ code: 'EID20', type: 'free_shipping', applies_to: 'all', status: 'active', percent_bps: null });
  });
});

describe('Settings', () => {
  it('zone editor disables areas taken by another zone', async () => {
    signedIn('owner', { ...geoRoute, 'GET /stores/S1/shipping': jsonResponse(200, { data: shipping() }) });
    renderApp(<AppRoutes />, { route: '/settings/shipping' });
    const zones = await screen.findByRole('table', { name: 'Delivery zones' }, SLOW);
    expect(within(zones).getByText('Everywhere else')).toBeInTheDocument();
    expect(within(zones).queryByRole('button', { name: 'Delete Outside Dhaka' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Add zone' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Show thanas in Dhaka' }));
    expect(screen.getByRole('checkbox', { name: /Mirpur/ })).toBeDisabled();
    expect(screen.getByText('In Inside Dhaka')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Gulshan/ })).toBeEnabled();
  });

  it('staff: shipping, payments and notifications are read-only', async () => {
    signedIn('staff', { ...geoRoute, 'GET /stores/S1/shipping': jsonResponse(200, { data: shipping() }), 'GET /stores/S1/settings': settingsWithCommerce() });
    renderApp(<AppRoutes />, { route: '/settings/shipping' });
    await screen.findByRole('table', { name: 'Delivery zones' }, SLOW);
    expect(screen.queryByRole('button', { name: 'Add zone' })).toBeNull();
    expect(screen.getByRole('switch', { name: 'Inside Dhaka active' })).toBeDisabled();
  });

  it('payments: COD is the only active control', async () => {
    const fetchMock = signedIn('owner', { 'GET /stores/S1/settings': settingsWithCommerce(), 'PATCH /stores/S1/settings': settingsWithCommerce({ checkout: { cod_enabled: false } }) });
    renderApp(<AppRoutes />, { route: '/settings/payments' });
    await userEvent.click(await screen.findByRole('switch', { name: 'Cash on delivery' }, SLOW));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/settings').filter((c) => c[1].method === 'PATCH')).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, '/stores/S1/settings').find((c) => c[1].method === 'PATCH')!)).toEqual({ checkout: { cod_enabled: false } });
    expect(screen.getAllByText('Coming soon')).toHaveLength(2);
  });
});

describe('Onboarding 06 → 07 → publish → 08', () => {
  it('saves delivery charges, shows launch blockers, then goes live', async () => {
    let publishes = 0;
    const fetchMock = signedIn('owner', {
      ...geoRoute,
      'GET /stores/S1/settings': settingsWithCommerce(),
      'GET /stores/S1/shipping': jsonResponse(200, { data: shipping({ zones: [], configured: false }) }),
      'PUT /stores/S1/shipping': jsonResponse(200, { data: shipping() }),
      'GET /stores/S1/products': productList([summary()]),
      'POST /stores/S1/publish': () =>
        ++publishes === 1
          ? jsonResponse(409, { error: { code: 'launch_blocked', message: 'Not yet.', details: { contact_phone: ['Add a phone number customers can call.'] } } })
          : jsonResponse(200, { data: { id: 'S1', status: 'active' } }),
      'GET /stores/S1/launch-checklist': jsonResponse(200, { data: checklist({ status: 'active' }) }),
    });
    renderApp(<AppRoutes />, { route: '/onboarding/delivery' });
    expect(await screen.findByRole('heading', { name: 'Delivery & charges' }, SLOW)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Connect .* \(coming soon\)/ })[0]).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/shipping').filter((c) => c[1].method === 'PUT')).toHaveLength(1));
    const put = bodyOf(callsTo(fetchMock, '/stores/S1/shipping').find((c) => c[1].method === 'PUT')!);
    expect(put.zones.map((z: { name: string; kind: string; charge_amount: number }) => [z.name, z.kind, z.charge_amount])).toEqual([
      ['Inside Dhaka', 'custom', 7_000],
      ['Outside Dhaka', 'fallback', 13_000],
    ]);
    expect(put.free_delivery_over_amount).toBeNull();

    expect(await screen.findByRole('heading', { name: 'Get paid' }, SLOW)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    const blockers = await screen.findByRole('alert', { name: 'Before you go live' });
    expect(within(blockers).getByRole('link', { name: /Add a phone number customers can call/ })).toHaveAttribute('href', '/settings/store');
    await userEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(await screen.findByRole('heading', { name: /You’re live/ }, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Share on WhatsApp' })).toHaveAttribute('href', 'https://wa.me/?text=https%3A%2F%2Fmugdho.storeplix.com');
  }, 15_000);
});

describe('Dashboard and customers', () => {
  it('dashboard shows order KPIs, waiting counts and best sellers', async () => {
    signedIn('owner', {
      'GET /stores/S1/dashboard': jsonResponse(200, {
        data: dashboard({
          setup: { has_products: true },
          orders: {
            this_month: { count: 38, sales_amount: 4_250_000, delivered_count: 30, returned_count: 3, cancelled_count: 2, delivery_success_rate: 0.909 },
            waiting: { pending: 4, confirmed: 2, ready_to_ship: 1 },
            best_sellers: [{ product_id: 'P1', name: 'Cotton Panjabi', image: null, units: 12 }],
            plan: { used: 38, limit: 50 },
          },
        }),
      }),
    });
    renderApp(<AppRoutes />, { route: '/' });
    expect(await screen.findByText('91%', {}, SLOW)).toBeInTheDocument();
    expect(screen.getByText('Confirm 4 orders')).toBeInTheDocument();
    expect(screen.getByText('Pack 2 orders')).toBeInTheDocument();
    const waiting = screen.getByRole('region', { name: 'Orders waiting' });
    expect(within(waiting).getByRole('link', { name: /Waiting to confirm\s*4/ })).toHaveAttribute('href', '/orders?status=pending');
    expect(within(screen.getByRole('region', { name: 'Best sellers' })).getByText('Cotton Panjabi')).toBeInTheDocument();
  });

  it('nav shows only the real Orders children', async () => {
    signedIn('owner', { ...geoRoute, 'GET /stores/S1/orders': orderList([]) });
    renderApp(<AppRoutes />, { route: '/orders' });
    const nav = await screen.findByRole('complementary', { name: 'Main navigation' }, SLOW);
    expect(within(nav).getByRole('link', { name: 'Create order' })).toBeInTheDocument();
    expect(within(nav).queryByText('Unfinished orders')).toBeNull();
    expect(within(nav).queryByText('Fake order guard')).toBeNull();
    expect(within(nav).queryByText('Invoices & labels')).toBeNull();
  });
});
