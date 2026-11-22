import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { vatIncluded } from '../settings/commerceSettings';
import { callsTo, jsonResponse, renderApp, signedIn } from '../test/utils';
import { product } from './catalog.fixtures';
import { geo, order, orderList, orderSummary, settingsWithCommerce } from './phase5.fixtures';
import { documentTemplate, itemsQuote, READY_URL, returnList, returnRequest, returnSummary, storeDocument, templates } from './phase5b.fixtures';

const SLOW = { timeout: 5000 };
const geoRoute = { 'GET /geo/bd': jsonResponse(200, { data: geo }) };
const bodyOf = (call: [string, RequestInit]) => JSON.parse(String(call[1].body));
const posts = (fetchMock: Parameters<typeof callsTo>[0], path: string) => callsTo(fetchMock, path).filter((c) => c[1].method === 'POST');
const urlOf = (call: [string, RequestInit]) => new URL(String(call[0]), 'http://localhost');

function fakeWindow() {
  const win = { closed: false, opener: {} as unknown, location: { href: '' }, close: vi.fn() };
  const open = vi.fn(() => win as unknown as Window);
  vi.stubGlobal('open', open);
  return { win, open };
}

describe('Edit items (144:46654)', () => {
  it('debounces the quote, shows what changes and saves the line set with the reason', async () => {
    const fetchMock = signedIn('owner', {
      ...geoRoute,
      'GET /stores/S1/settings': settingsWithCommerce(),
      'GET /stores/S1/orders/O1': jsonResponse(200, { data: order({ status: 'confirmed' }) }),
      'POST /stores/S1/orders/O1/items/quote': jsonResponse(200, { data: itemsQuote({ notices: ['Coupon still applies.'] }) }),
      'PUT /stores/S1/orders/O1/items': jsonResponse(200, { data: order({ status: 'confirmed', revision: 2 }), meta: { notices: [] } }),
    });
    renderApp(<AppRoutes />, { route: '/orders/O1/edit' });
    const products = await screen.findByRole('region', { name: 'Products' }, SLOW);
    await userEvent.click(within(products).getByRole('button', { name: 'More Cotton Panjabi' }));
    await userEvent.click(within(products).getByRole('button', { name: 'More Cotton Panjabi' }));
    await userEvent.click(within(products).getByRole('button', { name: 'Fewer Cotton Panjabi' }));
    expect(within(products).getByText('Changed')).toBeInTheDocument();
    const changes = screen.getByRole('region', { name: 'What changes' });
    expect(await within(changes).findByLabelText('New amount to collect', {}, SLOW)).toHaveTextContent('৳ 3,470');
    expect(within(changes).getByText('+ ৳ 1,700 more to collect')).toBeInTheDocument();
    expect(within(changes).getByText('Coupon still applies.')).toBeInTheDocument();
    // Three clicks inside the debounce window → one quote, for the final quantity.
    expect(posts(fetchMock, '/stores/S1/orders/O1/items/quote')).toHaveLength(1);
    expect(bodyOf(posts(fetchMock, '/stores/S1/orders/O1/items/quote')[0]!).items).toEqual([{ id: 'OI1', quantity: 2 }]);

    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Choose why the items changed.')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Reason'), 'customer_request');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/orders/O1/items').filter((c) => c[1].method === 'PUT')).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, '/stores/S1/orders/O1/items').find((c) => c[1].method === 'PUT')!)).toEqual({
      revision: 1,
      items: [{ id: 'OI1', quantity: 2 }],
      reason: 'customer_request',
      note: null,
      recalculate_shipping: false,
      shipping_amount_override: null,
      notify_customer: true,
    });
    // Contact unchanged → no PATCH.
    expect(callsTo(fetchMock, '/stores/S1/orders/O1').filter((c) => c[1].method === 'PATCH')).toHaveLength(0);
  }, 15_000);

  it('is read-only while a courier parcel is active', async () => {
    const shipment = {
      id: 'SH1', provider: 'steadfast' as const, carrier_name: 'Steadfast', tracking_code: null, tracking_url: null, status: 'booked' as const, cod_amount: 177_000, shipped_at: null, delivered_at: null, returned_at: null,
      consignment_id: 'SF-8841205', provider_status: null, attempts: 0, problem: null, weight_grams: 500, delivery_fee_amount: null, cod_charge_amount: null, cod_collected_amount: null, last_location: null,
      last_event_at: null, booked_at: new Date().toISOString(), picked_up_at: null, cancelled_at: null, failure_reason: null,
    };
    signedIn('owner', { ...geoRoute, 'GET /stores/S1/orders/O1': jsonResponse(200, { data: order({ status: 'ready_to_ship', shipment }) }) });
    renderApp(<AppRoutes />, { route: '/orders/O1/edit' });
    expect(await screen.findByText('This order is booked with Steadfast (SF-8841205). Cancel the parcel to edit items.', {}, SLOW)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More Cotton Panjabi' })).toBeNull();
    expect(screen.queryByRole('searchbox', { name: 'Search products' })).toBeNull();
  });

  it('shows “Refund first” on total_below_paid', async () => {
    signedIn('owner', {
      ...geoRoute,
      'GET /stores/S1/orders/O1': jsonResponse(200, { data: order({ status: 'confirmed', items: [{ ...order().items[0]!, quantity: 2, total_amount: 340_000 }] }) }),
      'POST /stores/S1/orders/O1/items/quote': jsonResponse(200, { data: itemsQuote({ due_delta_amount: -170_000 }) }),
      'PUT /stores/S1/orders/O1/items': jsonResponse(422, { error: { code: 'total_below_paid', message: 'Refund first.' } }),
    });
    renderApp(<AppRoutes />, { route: '/orders/O1/edit' });
    const products = await screen.findByRole('region', { name: 'Products' }, SLOW);
    await userEvent.click(within(products).getByRole('button', { name: 'Fewer Cotton Panjabi' }));
    await userEvent.selectOptions(screen.getByLabelText('Reason'), 'out_of_stock');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/less than what the customer already paid. Refund first./, {}, SLOW)).toBeInTheDocument();
  });
});

describe('Order detail 5b actions', () => {
  it('prints an invoice: creates the document, polls until ready and opens the signed URL', async () => {
    const { win, open } = fakeWindow();
    let polls = 0;
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/orders/O1': jsonResponse(200, { data: order({ status: 'confirmed' }) }),
      'POST /stores/S1/documents': jsonResponse(202, { data: storeDocument() }),
      'GET /stores/S1/documents/D1': () => jsonResponse(200, { data: ++polls < 2 ? storeDocument({ status: 'rendering' }) : storeDocument({ status: 'ready', download_url: READY_URL }) }),
    });
    renderApp(<AppRoutes />, { route: '/orders/O1' });
    await userEvent.click(await screen.findByRole('button', { name: /Invoice/ }, SLOW));
    expect(open).toHaveBeenCalledWith('', '_blank');
    await waitFor(() => expect(win.location.href).toBe(READY_URL), { timeout: 4000 });
    expect(bodyOf(posts(fetchMock, '/stores/S1/documents')[0]!)).toEqual({ kind: 'invoice_a4', order_ids: ['O1'] });
    expect(polls).toBe(2);
  }, 10_000);

  it('creates a return from a delivered order with an exchange variant', async () => {
    const delivered = order({ status: 'delivered', payment_status: 'paid', paid_amount: 177_000, due_amount: 0, allowed_transitions: [], can: { edit: false, cancel: false, refund: true } });
    const fetchMock = signedIn('staff', {
      'GET /stores/S1/orders/O1': jsonResponse(200, { data: delivered }),
      'GET /stores/S1/products/P1': jsonResponse(200, { data: product() }),
      'POST /stores/S1/orders/O1/returns': jsonResponse(201, { data: returnRequest() }),
      'GET /stores/S1/returns': returnList([returnSummary()]),
      'GET /stores/S1/returns/R1': jsonResponse(200, { data: returnRequest() }),
    });
    renderApp(<AppRoutes />, { route: '/orders/O1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Create return' }, SLOW));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Exchange' }));
    await userEvent.selectOptions(within(dialog).getByLabelText('Reason'), 'wrong_size');
    expect(within(dialog).getByRole('button', { name: 'Create exchange' })).toBeDisabled();
    await userEvent.selectOptions(await within(dialog).findByLabelText('Wants instead · Cotton Panjabi', {}, SLOW), 'V2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create exchange' }));
    await waitFor(() => expect(posts(fetchMock, '/stores/S1/orders/O1/returns')).toHaveLength(1));
    expect(bodyOf(posts(fetchMock, '/stores/S1/orders/O1/returns')[0]!)).toEqual({
      type: 'exchange',
      reason: 'wrong_size',
      customer_note: null,
      lines: [{ order_item_id: 'OI1', quantity: 1, exchange_variant_id: 'V2' }],
    });
    expect(await screen.findByRole('region', { name: 'Return detail' }, SLOW)).toBeInTheDocument();
  });

  it('restocks a courier-returned order up to what is left', async () => {
    const item = { ...order().items[0]!, quantity: 3, restocked_quantity: 1 };
    const fetchMock = signedIn('staff', {
      'GET /stores/S1/orders/O1': jsonResponse(200, { data: order({ status: 'returned', items: [item], allowed_transitions: [], can: { edit: false, cancel: false, refund: false } }) }),
      'POST /stores/S1/orders/O1/restock': jsonResponse(200, { data: order({ status: 'returned' }) }),
    });
    renderApp(<AppRoutes />, { route: '/orders/O1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Restock' }, SLOW));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'More Cotton Panjabi' })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Fewer Cotton Panjabi' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Put back in stock' }));
    await waitFor(() => expect(posts(fetchMock, '/stores/S1/orders/O1/restock')).toHaveLength(1));
    expect(bodyOf(posts(fetchMock, '/stores/S1/orders/O1/restock')[0]!)).toEqual({ lines: [{ item_id: 'OI1', quantity: 1 }], note: null });
  });

  it('shows Edit items only before shipping', async () => {
    signedIn('owner', { 'GET /stores/S1/orders/O1': jsonResponse(200, { data: order({ status: 'shipped', allowed_transitions: ['delivered', 'returned'] }) }) });
    renderApp(<AppRoutes />, { route: '/orders/O1' });
    expect(await screen.findByRole('heading', { name: 'MU-1042' }, SLOW)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Edit items' })).toBeNull();
  });
});

describe('Returns & exchanges (39:9900, 146:32329)', () => {
  it('shows KPIs and tab counts, opens the panel and approves with a pickup code', async () => {
    let status: 'requested' | 'approved' = 'requested';
    const fetchMock = signedIn('staff', {
      'GET /stores/S1/returns': returnList([returnSummary()]),
      'GET /stores/S1/returns/R1': () => jsonResponse(200, { data: returnRequest(status === 'approved' ? { status, allowed_transitions: ['received', 'closed'], revision: 2 } : {}) }),
      'POST /stores/S1/returns/R1/approve': () => {
        status = 'approved';
        return jsonResponse(200, { data: returnRequest({ status }) });
      },
      'GET /stores/S1/orders/O1': jsonResponse(200, { data: order() }),
    });
    renderApp(<AppRoutes />, { route: '/returns' });
    const kpis = await screen.findByRole('group', { name: 'Return KPIs' }, SLOW);
    expect(await within(kpis).findByText('4.8%')).toBeInTheDocument();
    expect(within(kpis).getByText('৳ 6,840')).toBeInTheDocument();
    expect(within(screen.getByRole('tablist', { name: 'Return status' })).getByRole('tab', { name: /All open\s*18/ })).toBeInTheDocument();
    expect(urlOf(callsTo(fetchMock, '/stores/S1/returns')[0]!).searchParams.get('filter[status]')).toBe('open');

    const table = screen.getByRole('table', { name: 'Returns' });
    await userEvent.click(await within(table).findByText('RT-31'));
    const panel = await screen.findByRole('region', { name: 'Return detail' }, SLOW);
    expect(await within(panel).findByText('White / 42')).toBeInTheDocument();
    expect(within(panel).getByText('Customer pays')).toBeInTheDocument();
    await userEvent.type(within(panel).getByLabelText('Pickup tracking code (optional)'), 'SF-RET-9');
    await userEvent.click(within(panel).getByRole('button', { name: 'Approve exchange' }));
    await waitFor(() => expect(posts(fetchMock, '/stores/S1/returns/R1/approve')).toHaveLength(1));
    expect(bodyOf(posts(fetchMock, '/stores/S1/returns/R1/approve')[0]!)).toEqual({ pickup_tracking_code: 'SF-RET-9' });
    expect(await within(screen.getByRole('region', { name: 'Return detail' })).findByRole('button', { name: 'Mark received' }, SLOW)).toBeInTheDocument();
  });

  it('receives with checks and per-line restock', async () => {
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/returns': returnList([returnSummary({ status: 'approved' })]),
      'GET /stores/S1/returns/R1': jsonResponse(200, { data: returnRequest({ status: 'approved', allowed_transitions: ['received', 'closed'] }) }),
      'POST /stores/S1/returns/R1/receive': jsonResponse(200, { data: returnRequest({ status: 'received' }) }),
    });
    renderApp(<AppRoutes />, { route: '/returns/R1' });
    const panel = await screen.findByRole('region', { name: 'Return detail' }, SLOW);
    await userEvent.click(await within(panel).findByLabelText('Tags intact'));
    await userEvent.click(within(panel).getByLabelText('Original packaging'));
    expect(within(panel).getByRole('switch', { name: 'Put Cotton Panjabi back in stock' })).toBeChecked();
    await userEvent.click(within(panel).getByRole('button', { name: 'Mark received' }));
    await waitFor(() => expect(posts(fetchMock, '/stores/S1/returns/R1/receive')).toHaveLength(1));
    expect(bodyOf(posts(fetchMock, '/stores/S1/returns/R1/receive')[0]!)).toEqual({
      checks: { tags_intact: true, unused: false, original_packaging: true },
      lines: [{ return_item_id: 'RI1', restock_quantity: 1 }],
    });
  });

  it('owner refunds a received return through the refunds endpoint with return_id; staff cannot', async () => {
    const received = returnRequest({ type: 'return', status: 'received', price_difference_amount: null, allowed_transitions: ['refunded', 'closed'] });
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/returns': returnList([returnSummary({ type: 'return', status: 'received' })]),
      'GET /stores/S1/returns/R1': jsonResponse(200, { data: received }),
      'POST /stores/S1/orders/O1/refunds': jsonResponse(201, { data: { id: 'PAY9' } }),
    });
    renderApp(<AppRoutes />, { route: '/returns/R1' });
    const panel = await screen.findByRole('region', { name: 'Return detail' }, SLOW);
    await userEvent.click(await within(panel).findByRole('button', { name: 'Refund' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record refund' }));
    await waitFor(() => expect(posts(fetchMock, '/stores/S1/orders/O1/refunds')).toHaveLength(1));
    const call = posts(fetchMock, '/stores/S1/orders/O1/refunds')[0]!;
    expect(bodyOf(call)).toMatchObject({ amount: 170_000, method: 'bkash_personal', return_id: 'R1' });
    expect((call[1].headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
  });

  it('staff sees no Refund on a received return', async () => {
    signedIn('staff', {
      'GET /stores/S1/returns': returnList([]),
      'GET /stores/S1/returns/R1': jsonResponse(200, { data: returnRequest({ type: 'return', status: 'received', allowed_transitions: ['refunded', 'closed'] }) }),
    });
    renderApp(<AppRoutes />, { route: '/returns/R1' });
    const panel = await screen.findByRole('region', { name: 'Return detail' }, SLOW);
    expect(await within(panel).findByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Refund' })).toBeNull();
  });

  it('creates the exchange order with an Idempotency-Key and opens it', async () => {
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/returns': returnList([]),
      'GET /stores/S1/returns/R1': jsonResponse(200, { data: returnRequest({ status: 'received', allowed_transitions: ['exchanged', 'closed'] }) }),
      'POST /stores/S1/returns/R1/exchange-order': jsonResponse(201, { data: { return: returnRequest({ status: 'exchanged' }), order: order({ id: 'O2', number: 'MU-1050' }), payment_link: null } }),
      'GET /stores/S1/orders/O2': jsonResponse(200, { data: order({ id: 'O2', number: 'MU-1050' }) }),
    });
    renderApp(<AppRoutes />, { route: '/returns/R1' });
    const panel = await screen.findByRole('region', { name: 'Return detail' }, SLOW);
    await userEvent.click(await within(panel).findByRole('button', { name: 'Create exchange order' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('The customer pays ৳ 110 more on delivery.')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create order' }));
    await waitFor(() => expect(posts(fetchMock, '/stores/S1/returns/R1/exchange-order')).toHaveLength(1));
    const call = posts(fetchMock, '/stores/S1/returns/R1/exchange-order')[0]!;
    expect(bodyOf(call)).toEqual({ shipping_amount_override: null, send_payment_link: null });
    expect((call[1].headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'MU-1050' }, SLOW)).toBeInTheDocument();
  });

  it('rejects with a reason', async () => {
    const fetchMock = signedIn('staff', {
      'GET /stores/S1/returns': returnList([]),
      'GET /stores/S1/returns/R1': jsonResponse(200, { data: returnRequest() }),
      'POST /stores/S1/returns/R1/reject': jsonResponse(200, { data: returnRequest({ status: 'rejected', allowed_transitions: [] }) }),
    });
    renderApp(<AppRoutes />, { route: '/returns/R1' });
    const panel = await screen.findByRole('region', { name: 'Return detail' }, SLOW);
    await userEvent.click(await within(panel).findByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'Item was used');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(posts(fetchMock, '/stores/S1/returns/R1/reject')).toHaveLength(1));
    expect(bodyOf(posts(fetchMock, '/stores/S1/returns/R1/reject')[0]!)).toEqual({ reason: 'Item was used' });
  });
});

describe('Invoices & labels (39:10790)', () => {
  it('lists not-printed orders, previews in a sandboxed iframe, saves settings and prints the selection', async () => {
    const { win } = fakeWindow();
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/orders': (init) => {
        void init;
        return orderList([orderSummary({ status: 'confirmed' }), orderSummary({ id: 'O2', number: 'MU-1043', status: 'confirmed', due_amount: 50_000 })]);
      },
      'GET /stores/S1/document-templates': templates(),
      'PUT /stores/S1/document-templates/label_4x6': jsonResponse(200, { data: documentTemplate('label_4x6', { revision: 1, config: { ...documentTemplate('label_4x6').config, show_logo: false } }) }),
      'POST /stores/S1/documents/preview': jsonResponse(200, { data: { html: '<p>Label preview</p>' } }),
      'POST /stores/S1/documents': jsonResponse(202, { data: storeDocument({ kind: 'label_4x6', status: 'ready', download_url: READY_URL, orders_count: 2 }) }),
    });
    renderApp(<AppRoutes />, { route: '/orders/print' });
    const list = await screen.findByRole('list', { name: 'Orders to print' }, SLOW);
    expect(within(list).getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByText('COD ৳ 2,270')).toBeInTheDocument();
    const orderCalls = callsTo(fetchMock, '/stores/S1/orders').map(urlOf);
    expect(orderCalls.some((u) => u.searchParams.get('filter[not_printed]') === 'label' && u.searchParams.get('filter[status]') === 'confirmed,ready_to_ship')).toBe(true);
    expect(orderCalls.some((u) => u.searchParams.get('filter[printed]') === 'label')).toBe(true);

    const frame = await screen.findByTitle('Document preview', {}, SLOW);
    expect(frame).toHaveAttribute('sandbox', '');
    expect(frame.getAttribute('srcdoc')).toBe('<p>Label preview</p>');
    expect(bodyOf(posts(fetchMock, '/stores/S1/documents/preview')[0]!)).toMatchObject({ kind: 'label_4x6', order_id: 'O1' });

    await userEvent.click(within(list).getByRole('checkbox', { name: 'Select MU-1043' }));
    expect(screen.getAllByRole('button', { name: 'Print 1 label' })[0]).toBeInTheDocument();
    await userEvent.click(within(list).getByRole('checkbox', { name: 'Select MU-1043' }));

    await userEvent.click(screen.getByRole('switch', { name: 'Show shop logo' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/document-templates/label_4x6')).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, '/stores/S1/document-templates/label_4x6')[0]!)).toMatchObject({ revision: 0, config: { show_logo: false } });

    await userEvent.click(screen.getAllByRole('button', { name: 'Print 2 labels' })[0]!);
    await waitFor(() => expect(win.location.href).toBe(READY_URL));
    expect(bodyOf(posts(fetchMock, '/stores/S1/documents')[0]!)).toEqual({ kind: 'label_4x6', order_ids: ['O1', 'O2'] });
  }, 10_000);

  it('staff can print but not change print settings', async () => {
    signedIn('staff', {
      'GET /stores/S1/orders': orderList([orderSummary({ status: 'confirmed' })]),
      'GET /stores/S1/document-templates': templates(),
      'POST /stores/S1/documents/preview': jsonResponse(200, { data: { html: '<p>x</p>' } }),
    });
    renderApp(<AppRoutes />, { route: '/orders/print' });
    expect(await screen.findByRole('switch', { name: 'Show shop logo' }, SLOW)).toBeDisabled();
    expect(screen.getAllByRole('button', { name: 'Print 1 label' })[0]).toBeEnabled();
  });
});

describe('Orders list 5b', () => {
  it('filters by printed state and bulk-prints the selection', async () => {
    const { win } = fakeWindow();
    const fetchMock = signedIn('owner', {
      ...geoRoute,
      'GET /stores/S1/orders': orderList([orderSummary({ status: 'confirmed' })]),
      'POST /stores/S1/documents': jsonResponse(202, { data: storeDocument({ kind: 'packing_slip', status: 'ready', download_url: READY_URL }) }),
    });
    renderApp(<AppRoutes />, { route: '/orders' });
    const table = await screen.findByRole('table', { name: 'Orders' }, SLOW);
    await userEvent.selectOptions(screen.getByLabelText('Printed'), 'label_not');
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/orders').map(urlOf).some((u) => u.searchParams.get('filter[not_printed]') === 'label')).toBe(true));
    await userEvent.click(await within(table).findByRole('checkbox', { name: 'Select MU-1042' }));
    await userEvent.click(within(screen.getByRole('region', { name: 'Bulk actions' })).getByRole('button', { name: 'Print selected' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: '1 packing slip' }));
    await waitFor(() => expect(win.location.href).toBe(READY_URL));
    expect(bodyOf(posts(fetchMock, '/stores/S1/documents')[0]!)).toEqual({ kind: 'packing_slip', order_ids: ['O1'] });
  });
});

describe('Settings → Taxes & invoices (60:16858)', () => {
  it('saves VAT display, rate and BIN, and the footer', async () => {
    const fetchMock = signedIn('owner', { 'GET /stores/S1/settings': settingsWithCommerce(), 'PATCH /stores/S1/settings': settingsWithCommerce() });
    renderApp(<AppRoutes />, { route: '/settings/invoices' });
    await userEvent.click(await screen.findByRole('switch', { name: 'Show VAT on invoices' }, SLOW));
    await userEvent.type(screen.getByLabelText('BIN (Business Identification Number)'), '0045678');
    expect(screen.getByText('Use 9 digits, or 9 digits, a dash and 4 digits.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('BIN (Business Identification Number)'), '91-0101');
    expect(screen.getByText(/includes VAT ৳ 107.14/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save VAT' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/settings').filter((c) => c[1].method === 'PATCH')).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, '/stores/S1/settings').find((c) => c[1].method === 'PATCH')!)).toEqual({ tax: { display: 'included', rate_bps: 500, bin: '004567891-0101' } });

    await userEvent.type(screen.getByLabelText('Footer note'), 'ধন্যবাদ!');
    await userEvent.click(screen.getByRole('button', { name: 'Save footer' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/settings').filter((c) => c[1].method === 'PATCH')).toHaveLength(2));
    expect(bodyOf(callsTo(fetchMock, '/stores/S1/settings').filter((c) => c[1].method === 'PATCH')[1]!)).toEqual({ invoice: { footer: 'ধন্যবাদ!' } });
  });

  it('vatIncluded floors total × rate / (10 000 + rate)', () => {
    expect(vatIncluded(225_000, 500)).toBe(10_714);
    expect(vatIncluded(177_000, 0)).toBe(0);
  });
});
