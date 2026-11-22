import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { callsTo, jsonResponse, renderApp, signedIn } from '../test/utils';
import { connectedSteadfast, courier, couriersResponse, pickupLocation } from './couriers.fixtures';
import { order, orderList, orderSummary, shipping } from './phase5.fixtures';
import { shipmentBatch, shipmentDetail, shipmentList, shipmentSummary } from './shipments.fixtures';

// Phase 5b-3 dashboard (PHASE-5B §13 "Dashboard"): booking dialog (area selects for Pathao/RedX, COD hidden for
// staff), shipments table/filters/KPIs, bulk results. API mocked per openapi 1.6.0.

const SLOW = { timeout: 5000 };
const bodyOf = (call: [string, RequestInit]) => JSON.parse(String(call[1].body));
const byMethod = (fetchMock: Parameters<typeof callsTo>[0], path: string, method: string) => callsTo(fetchMock, path).filter((c) => (c[1].method ?? 'GET') === method);
const urlOf = (call: [string, RequestInit]) => new URL(String(call[0]), 'http://localhost');

afterEach(() => vi.unstubAllGlobals());

const connectedPathao = () =>
  courier('pathao', {
    status: 'connected',
    mode: 'sandbox',
    is_default: false,
    settings: { pickup_location_id: 'PL1', parcel_description: '{items}', default_weight_grams: 500, pathao_store_id: '77', delivery_type: 48 },
  });

/** The mock router ignores the query string; area lists differ by `level`, so they are answered here. */
function withAreas(fetchMock: ReturnType<typeof signedIn>) {
  const base = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/v1/stores/S1/couriers/pathao/areas') {
      const level = url.searchParams.get('level');
      if (level === 'city')
        return jsonResponse(200, {
          data: [
            { id: 'C1', name: 'Dhaka', level: 'city', parent_id: null },
            { id: 'C2', name: 'Chattogram', level: 'city', parent_id: null },
          ],
          meta: url.searchParams.get('thana_code') ? { suggested: { city_id: 'C1', zone_id: 'Z7', area_id: null } } : {},
        });
      if (level === 'zone') return jsonResponse(200, { data: [{ id: 'Z7', name: 'Mirpur', level: 'zone', parent_id: 'C1' }, { id: 'Z8', name: 'Uttara', level: 'zone', parent_id: 'C1' }] });
      return jsonResponse(200, { data: [{ id: 'A1', name: 'Mirpur 10', level: 'area', parent_id: 'Z7' }] });
    }
    return base(input, init);
  });
  return fetchMock;
}

describe('Shipments (39:10347)', () => {
  it('shows KPI tiles, COD held, needs attention and the table; filters go to the API', async () => {
    const problem = shipmentSummary({ id: 'SH2', status: 'delivery_failed', problem: 'delivery_failed', failure_reason: '2nd attempt failed · phone switched off', attempts: 2, consignment_id: 'SF-88214498', order: { id: 'O2', number: 'MU-1036', customer_name: 'Farhana Yasmin', customer_phone: '8801812345678', district: 'Dhaka', thana: 'Uttara' } });
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/shipments': shipmentList([shipmentSummary(), problem, shipmentSummary({ id: 'SH3', status: 'delivered', cod_collected_amount: 165_000, consignment_id: 'SF-1' })]),
    });
    renderApp(<AppRoutes />, { route: '/shipments' });
    const kpis = await screen.findByRole('group', { name: 'Shipment KPIs' }, SLOW);
    await waitFor(() => expect(within(kpis).getByText('42')).toBeInTheDocument());
    expect(within(kpis).getByText('94% delivery rate')).toBeInTheDocument();
    expect(within(kpis).getByText('3 failed · 2 on hold · 2 returning')).toBeInTheDocument();
    expect(within(kpis).getByText('৳ 1,84,250')).toBeInTheDocument();
    const cod = screen.getByRole('region', { name: 'COD with couriers' });
    expect(within(cod).getByText('Steadfast')).toBeInTheDocument();
    expect(within(cod).getByText('৳ 1,12,400')).toBeInTheDocument();

    const attention = screen.getByRole('region', { name: 'Needs attention' });
    expect(within(attention).getByRole('link', { name: /Call Farhana Yasmin/ })).toHaveAttribute('href', 'tel:+8801812345678');
    expect(within(attention).queryByRole('button', { name: 'Reschedule' })).not.toBeInTheDocument();

    const table = screen.getByRole('table', { name: 'Shipments' });
    expect(within(table).getByText('SF-88214573')).toBeInTheDocument();
    expect(within(table).getByText('Failed attempt')).toBeInTheDocument();
    expect(within(table).getByText('Collected')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Pathao/ }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/shipments').some((c) => urlOf(c).searchParams.get('filter[provider]') === 'pathao')).toBe(true));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'problems');
    await waitFor(() =>
      expect(callsTo(fetchMock, '/stores/S1/shipments').some((c) => urlOf(c).searchParams.get('filter[status]') === 'problems' && urlOf(c).searchParams.get('filter[provider]') === 'pathao')).toBe(true),
    );
  });

  it('Sync now posts once and cools down for a minute', async () => {
    const fetchMock = signedIn('owner', { 'GET /stores/S1/shipments': shipmentList([], { counts: { all: 0, steadfast: 0, pathao: 0, redx: 0, manual: 0 } }), 'POST /stores/S1/shipments/sync': jsonResponse(202, { data: { queued: 2 } }) });
    renderApp(<AppRoutes />, { route: '/shipments' });
    await userEvent.click(await screen.findByRole('button', { name: 'Sync now' }, SLOW));
    expect(await screen.findByRole('button', { name: /Sync again in \d+s/ })).toBeDisabled();
    expect(byMethod(fetchMock, '/stores/S1/shipments/sync', 'POST')).toHaveLength(1);
    expect(await screen.findByText('No parcels yet')).toBeInTheDocument();
  });

  it('empty store shows the empty state with Book parcels', async () => {
    signedIn('owner', { 'GET /stores/S1/shipments': shipmentList([], { counts: { all: 0, steadfast: 0, pathao: 0, redx: 0, manual: 0 } }) });
    renderApp(<AppRoutes />, { route: '/shipments?range=all' });
    expect(await screen.findByText('No parcels yet', {}, SLOW)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Book parcels' })).toHaveLength(2);
  });
});

describe('Shipment detail (146:33100)', () => {
  it('shows the stepper, timeline and money; cancel unsupported → mark cancelled', async () => {
    const detail = shipmentDetail({ status: 'booked', can: { cancel: true, mark_cancelled: true, refresh: true } });
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/shipments/SH1': jsonResponse(200, { data: detail }),
      'POST /stores/S1/shipments/SH1/cancel': jsonResponse(409, { error: { code: 'courier_cancel_unsupported', message: 'Cancel it in the Steadfast panel, then mark it cancelled here.' } }),
      'POST /stores/S1/shipments/SH1/mark-cancelled': jsonResponse(200, { data: { ...detail, status: 'cancelled' } }),
    });
    renderApp(<AppRoutes />, { route: '/shipments/SH1' });
    expect(await screen.findByRole('heading', { name: 'SF-88214573' }, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Parcel progress' })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Tracking timeline' })).getByText('Sorted at Steadfast hub, Tejgaon')).toBeInTheDocument();
    expect(screen.getByText('৳ 1,682.30')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open in Steadfast/ })).toHaveAttribute('href', 'https://steadfast.com.bd/t/SF-88214573');

    await userEvent.click(screen.getByRole('button', { name: 'Cancel the parcel' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel the parcel' }));
    const mark = await screen.findByRole('dialog', { name: 'Cancel it in the courier panel' });
    await userEvent.click(within(mark).getByRole('button', { name: 'I cancelled it · mark cancelled' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/shipments/SH1/mark-cancelled', 'POST')).toHaveLength(1));
  });
});

describe('Booking dialog (33:3676)', () => {
  const confirmed = (o = {}) => order({ status: 'confirmed', allowed_transitions: ['ready_to_ship', 'shipped', 'cancelled'], ...o });

  it('Pathao: area selects pre-selected from meta.suggested; sends area + remember', async () => {
    const fetchMock = withAreas(
      signedIn('owner', {
        'GET /stores/S1/orders/O1': jsonResponse(200, { data: confirmed() }),
        'GET /stores/S1/couriers': couriersResponse([connectedSteadfast(), connectedPathao(), courier('redx')]),
        'GET /stores/S1/shipping': jsonResponse(200, { data: shipping({ pickup_locations: [pickupLocation()] }) }),
        'POST /stores/S1/orders/O1/shipments': jsonResponse(201, { data: shipmentSummary({ provider: 'pathao', status: 'booked', consignment_id: 'DT221122ABCD' }) }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/orders/O1' });
    const card = await screen.findByRole('region', { name: 'Shipping' }, SLOW);
    await userEvent.click(await within(card).findByRole('button', { name: /Pathao/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Book MU-1042 with Pathao' });
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: 'City' })).toHaveValue('C1'));
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: 'Zone' })).toHaveValue('Z7'));
    expect(within(dialog).getByText(/matched to Pathao’s list/)).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: /Remember for Mirpur, Dhaka/ })).toBeChecked();
    expect(within(dialog).getByRole('textbox', { name: 'Cash to collect' })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Book with Pathao' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/orders/O1/shipments', 'POST')).toHaveLength(1));
    const call = byMethod(fetchMock, '/stores/S1/orders/O1/shipments', 'POST')[0]!;
    expect(bodyOf(call)).toMatchObject({ provider: 'pathao', pickup_location_id: 'PL1', weight_grams: 500, delivery_type: 48, area: { city_id: 'C1', zone_id: 'Z7', area_id: null }, remember_area: true });
    expect(bodyOf(call)).not.toHaveProperty('cod_amount');
    expect((call[1].headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
  });

  it('staff: COD field hidden and never sent; courier_rejected shows the courier message', async () => {
    const fetchMock = signedIn('staff', {
      'GET /stores/S1/orders/O1': jsonResponse(200, { data: confirmed({ can: { edit: true, cancel: true, refund: false } }) }),
      'GET /stores/S1/couriers': couriersResponse([connectedSteadfast()]),
      'GET /stores/S1/shipping': jsonResponse(200, { data: shipping({ pickup_locations: [pickupLocation()] }) }),
      'POST /stores/S1/orders/O1/shipments': jsonResponse(422, { error: { code: 'courier_rejected', message: 'Recipient phone is invalid.' } }),
    });
    renderApp(<AppRoutes />, { route: '/orders/O1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Book with Steadfast' }, SLOW));
    const dialog = await screen.findByRole('dialog', { name: 'Book MU-1042 with Steadfast' });
    expect(within(dialog).queryByRole('textbox', { name: 'Cash to collect' })).not.toBeInTheDocument();
    expect(within(dialog).getByText('Cash to collect · order due amount')).toBeInTheDocument();
    expect(within(dialog).queryByRole('combobox', { name: 'City' })).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Book with Steadfast' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Steadfast refused this parcel: Recipient phone is invalid.');
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/orders/O1/shipments', 'POST')[0]!)).not.toHaveProperty('cod_amount');
  });

  it('owner COD override is sent; provider_unavailable keeps the Idempotency-Key for the retry', async () => {
    let n = 0;
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/orders/O1': jsonResponse(200, { data: confirmed() }),
      'GET /stores/S1/couriers': couriersResponse([connectedSteadfast()]),
      'GET /stores/S1/shipping': jsonResponse(200, { data: shipping({ pickup_locations: [pickupLocation()] }) }),
      'POST /stores/S1/orders/O1/shipments': () =>
        ++n === 1 ? jsonResponse(502, { error: { code: 'provider_unavailable', message: 'Courier timeout' } }) : jsonResponse(201, { data: shipmentSummary({ status: 'booked' }) }),
    });
    renderApp(<AppRoutes />, { route: '/orders/O1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Book with Steadfast' }, SLOW));
    const dialog = await screen.findByRole('dialog', { name: 'Book MU-1042 with Steadfast' });
    const cod = within(dialog).getByRole('textbox', { name: 'Cash to collect' });
    await userEvent.clear(cod);
    await userEvent.type(cod, '1500');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Book with Steadfast' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Steadfast didn’t answer. Nothing was booked');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Book with Steadfast' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const calls = byMethod(fetchMock, '/stores/S1/orders/O1/shipments', 'POST');
    expect(bodyOf(calls[0]!)).toMatchObject({ cod_amount: 150_000 });
    const key = (c: [string, RequestInit]) => (c[1].headers as Record<string, string>)['Idempotency-Key'];
    expect(key(calls[1]!)).toBe(key(calls[0]!));
  });

  it('booked order shows the parcel card with tracking instead of the booking buttons', async () => {
    const parcel = shipmentSummary({ status: 'in_transit' });
    signedIn('owner', {
      'GET /stores/S1/orders/O1': jsonResponse(200, { data: order({ status: 'shipped', shipment: parcel, shipments: [parcel], allowed_transitions: ['delivered', 'returned'] }) }),
      'GET /stores/S1/couriers': couriersResponse([connectedSteadfast()]),
      'GET /stores/S1/shipping': jsonResponse(200, { data: shipping() }),
    });
    renderApp(<AppRoutes />, { route: '/orders/O1' });
    const card = await screen.findByRole('region', { name: 'Shipping' }, SLOW);
    expect(await within(card).findByText('In transit')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'View parcel' })).toHaveAttribute('href', '/shipments/SH1');
    expect(within(card).getByRole('link', { name: /Track on Steadfast/ })).toHaveAttribute('href', 'https://steadfast.com.bd/t/SF-88214573');
    expect(within(card).queryByRole('button', { name: /Book with/ })).not.toBeInTheDocument();
  });
});

describe('Bulk booking (39:18808)', () => {
  const waiting = [
    orderSummary({ id: 'O1', number: 'MU-1042', status: 'confirmed' }),
    orderSummary({ id: 'O2', number: 'MU-1040', status: 'ready_to_ship', paid_amount: 7_000, due_amount: 170_000 }),
    orderSummary({ id: 'O3', number: 'MU-1038', status: 'confirmed', shipment: { provider: 'steadfast', status: 'booked', consignment_id: 'SF-9' } }),
  ];

  it('books the waiting orders, polls the batch and lists per-order results', async () => {
    let polls = 0;
    const fetchMock = signedIn('owner', {
      'GET /stores/S1/shipments': shipmentList([]),
      'GET /stores/S1/couriers': couriersResponse([connectedSteadfast(), connectedPathao()]),
      'GET /stores/S1/orders': orderList(waiting),
      'POST /stores/S1/shipments/bulk': jsonResponse(202, { data: shipmentBatch({ provider: 'pathao' }) }),
      'GET /stores/S1/shipment-batches/B1': () =>
        jsonResponse(200, {
          data:
            ++polls < 2
              ? shipmentBatch({ provider: 'pathao', status: 'running', booked: 1 })
              : shipmentBatch({
                  provider: 'pathao',
                  status: 'completed',
                  booked: 1,
                  skipped: 1,
                  results: [
                    { order_id: 'O1', order_number: 'MU-1042', shipment_id: 'SH9', status: 'booked', reason: null },
                    { order_id: 'O2', order_number: 'MU-1040', shipment_id: null, status: 'skipped', reason: 'area_unmapped' },
                  ],
                  finished_at: '2026-11-22T09:01:00Z',
                }),
        }),
    });
    renderApp(<AppRoutes />, { route: '/shipments' });
    await userEvent.click(await screen.findByRole('button', { name: 'Book parcels' }, SLOW));
    const dialog = await screen.findByRole('dialog', { name: 'Book 2 orders with a courier' });
    expect(within(dialog).queryByText('MU-1038')).not.toBeInTheDocument();
    expect(within(dialog).getByText('৳ 70 advance paid')).toBeInTheDocument();
    expect(within(dialog).getByText('৳ 3,470')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Pathao' }));
    expect(within(dialog).getByText(/Orders whose area you haven’t matched yet are skipped/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Book 2 parcels' }));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/shipments/bulk', 'POST')[0]!)).toEqual({ provider: 'pathao', order_ids: ['O1', 'O2'] });
    const results = await screen.findByRole('list', { name: 'Booking results' }, { timeout: 6000 });
    await waitFor(() => expect(within(results).getByText(/Area needs mapping/)).toBeInTheDocument(), { timeout: 6000 });
    expect(screen.getByRole('dialog', { name: '1 parcel booked with Pathao' })).toBeInTheDocument();
  });

  it('402 feature_not_in_plan opens the upgrade dialog', async () => {
    signedIn('owner', {
      'GET /stores/S1/shipments': shipmentList([]),
      'GET /stores/S1/couriers': couriersResponse([connectedSteadfast()]),
      'GET /stores/S1/orders': orderList(waiting),
      'POST /stores/S1/shipments/bulk': jsonResponse(402, { error: { code: 'feature_not_in_plan', message: 'Bulk booking isn’t on the Free plan.' } }),
    });
    renderApp(<AppRoutes />, { route: '/shipments' });
    await userEvent.click(await screen.findByRole('button', { name: 'Book parcels' }, SLOW));
    const dialog = await screen.findByRole('dialog', { name: 'Book 2 orders with a courier' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Book 2 parcels' }));
    const upgrade = await screen.findByRole('dialog', { name: 'Bulk booking is on Starter and up' });
    expect(within(upgrade).getByRole('button', { name: 'Upgrade to Starter' })).toBeInTheDocument();
  });
});
