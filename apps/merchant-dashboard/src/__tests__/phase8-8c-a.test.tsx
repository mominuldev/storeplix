import { ApiError } from '@storeplix/api-client';
import type { StockMovement } from '@storeplix/types';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { inUseReasons, inUseReasonText, locationFormSchema, locationInputOf, multiWarehouseLocked, receiveAtText, stockAt } from '../inventory/locations';
import { receiveFooter } from '../purchasing/purchasing';
import { callsTo, jsonResponse, renderApp, signedIn } from '../test/utils';
import { inventoryItem, inventoryList, product, variant } from './catalog.fixtures';
import { shipping } from './phase5.fixtures';
import { poDetail, purchasingRoutes } from './phase8-8b.fixtures';
import { dhanmondi, growthPlan, locationsResponse, mainWarehouse, oldHub, splitItem, starterPlan } from './phase8-8c-a.fixtures';

// PHASE-8-8C §13 Web part A: location selector + All locations expansion, Warehouses tab + dialog + archive reasons,
// adjust dialog location, product editor "at other locations", Receive at; permission/plan gating; one-location store
// shows no location UI except the Warehouses tab.

const SLOW = { timeout: 5000 };
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const byMethod = (fetchMock: Parameters<typeof callsTo>[0], path: string, method: string) => callsTo(fetchMock, path).filter((c) => (c[1].method ?? 'GET') === method);
const bodyOf = (call: [string, RequestInit]) => JSON.parse(String(call[1].body));
const searchOf = (call: [string, RequestInit]) => new URL(String(call[0]), 'http://localhost').searchParams;

const movement = (o: Partial<StockMovement> = {}): StockMovement => ({
  id: 'MV1',
  variant_id: 'V1',
  product: { id: 'P1', name: 'Jamdani Three-Piece' },
  variant_title: 'M / Red',
  sku: null,
  location: { id: 'LOC2', name: 'Dhanmondi shop' },
  delta: -3,
  on_hand_after: 5,
  reason: 'damaged',
  note: null,
  reference: null,
  actor: { id: 'U2', name: 'Rahim' },
  created_at: '2026-11-15T10:20:00Z',
  ...o,
});

const inventoryRoutes = (locs = [mainWarehouse, dhanmondi], o: Record<string, Response | ((init: RequestInit) => Response)> = {}) => ({
  'GET /features': jsonResponse(200, { data: growthPlan() }),
  'GET /stores/S1/locations': locationsResponse(locs),
  'GET /stores/S1/inventory': inventoryList([splitItem()]),
  'GET /stores/S1/inventory/movements': jsonResponse(200, { data: [movement()], meta: { current_page: 1, per_page: 25, total: 1, last_page: 1 } }),
  ...o,
});

describe('PHASE-8-8C part A helpers', () => {
  it('stock at a location, missing row = 0, no location = top-level', () => {
    const i = splitItem();
    expect(stockAt(i, 'LOC2')).toEqual({ on_hand: 5, committed: 0, available: 5 });
    expect(stockAt(i, 'LOC9')).toEqual({ on_hand: 0, committed: 0, available: 0 });
    expect(stockAt(i, null)).toEqual({ on_hand: 19, committed: 6, available: 13 });
  });

  it('archive reasons from 409 location_in_use, plan lock, receive-at text, footer', () => {
    const e = new ApiError(409, 'location_in_use', 'In use', { reasons: ['has_stock', 'open_purchase_orders', 'nonsense'] });
    expect(inUseReasons(e)).toEqual(['has_stock', 'open_purchase_orders']);
    expect(inUseReasons(new ApiError(422, 'validation_failed', 'x'))).toBeNull();
    expect(inUseReasonText.has_stock).toMatch(/still has stock/);
    expect(multiWarehouseLocked(starterPlan())).toBe(true);
    expect(multiWarehouseLocked(growthPlan())).toBe(false);
    expect(multiWarehouseLocked(undefined)).toBe(false);
    expect(receiveAtText(false, { name: 'Main warehouse' })).toBeNull();
    expect(receiveAtText(true, { name: 'Main warehouse' })).toBe('Main warehouse');
    expect(receiveFooter({ units: 38, damaged: 0, value: null }, 'Main warehouse').title).toBe('Adding 38 units to Main warehouse');
    expect(receiveFooter({ units: 38, damaged: 0, value: null }).title).toBe('Adding 38 units to stock');
  });

  it('location form schema and input', () => {
    expect(locationFormSchema.safeParse({ name: ' ', type: 'shop', use_pickup: false, pickup_location_id: '', address: '' }).success).toBe(false);
    expect(locationFormSchema.safeParse({ name: 'x'.repeat(61), type: 'shop', use_pickup: false, pickup_location_id: '', address: '' }).success).toBe(false);
    expect(locationFormSchema.safeParse({ name: 'Uttara', type: 'shop', use_pickup: true, pickup_location_id: '', address: '' }).success).toBe(false);
    expect(locationInputOf({ name: ' Uttara shop ', type: 'shop', use_pickup: false, pickup_location_id: 'PK1', address: ' ' })).toEqual({ name: 'Uttara shop', type: 'shop', address: null, pickup_location_id: null });
    expect(locationInputOf({ name: 'Hub', type: 'warehouse', use_pickup: true, pickup_location_id: 'PK1', address: 'Agrabad' })).toEqual({ name: 'Hub', type: 'warehouse', address: 'Agrabad', pickup_location_id: 'PK1' });
  });
});

describe('Inventory with locations (§10.1, 11:589)', () => {
  it('one-location store: no location selector, no expansion, no location column; adjust body unchanged; Warehouses tab shown', async () => {
    let body: unknown = null;
    signedIn(
      'owner',
      inventoryRoutes([mainWarehouse], {
        'GET /stores/S1/inventory': inventoryList([inventoryItem()]),
        'POST /stores/S1/inventory/adjustments': (init) => {
          body = JSON.parse(String(init.body));
          return jsonResponse(200, { data: { items: [], movements: [] } });
        },
      }),
    );
    renderApp(<AppRoutes />, { route: '/inventory' });
    await screen.findByRole('button', { name: 'Adjust Jamdani Three-Piece M / Red' }, SLOW);
    expect(screen.queryByRole('combobox', { name: 'Location' })).toBeNull();
    expect(screen.queryByRole('button', { name: /stock per location/ })).toBeNull();
    expect(within(screen.getByRole('tablist', { name: 'Inventory' })).getByRole('tab', { name: 'Warehouses' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Adjust Jamdani Three-Piece M / Red' }));
    expect(screen.queryByRole('combobox', { name: 'Location' })).toBeNull();
    await userEvent.type(screen.getByLabelText('New on-hand count'), '10');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(body).toEqual({ reason: 'correction', note: null, items: [{ variant_id: 'V1', mode: 'set', quantity: 10, expected_on_hand: 14 }] }));
  });

  it('a failing locations request reads as one location (no location UI)', async () => {
    signedIn('owner', inventoryRoutes([mainWarehouse], { 'GET /stores/S1/locations': jsonResponse(500, { error: { code: 'server_error', message: 'x' } }) }));
    renderApp(<AppRoutes />, { route: '/inventory' });
    await screen.findByRole('button', { name: 'Adjust Jamdani Three-Piece M / Red' }, SLOW);
    expect(screen.queryByRole('combobox', { name: 'Location' })).toBeNull();
  });

  it('selector lists All locations + each; All locations rows expand to per-location numbers; picking one filters', async () => {
    const fetchMock = signedIn('owner', inventoryRoutes([mainWarehouse, dhanmondi, oldHub]));
    renderApp(<AppRoutes />, { route: '/inventory' });
    const select = await screen.findByRole('combobox', { name: 'Location' }, SLOW);
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['All locations', 'Main warehouse', 'Dhanmondi shop']);
    const toggle = await screen.findByRole('button', { name: 'Show stock per location for Jamdani Three-Piece M / Red' }, SLOW);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    const list = screen.getByRole('list', { name: 'Stock per location for Jamdani Three-Piece M / Red' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Main warehouse· OnlineOn hand 14Held 6Available 8');
    expect(rows[1]).toHaveTextContent('Dhanmondi shopOn hand 5Held 0Available 5');
    // latest changes show the location in All locations
    expect(await screen.findByText(/Dhanmondi shop · By Rahim/)).toBeInTheDocument();

    await userEvent.selectOptions(select, 'LOC2');
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/inventory').some((c) => searchOf(c).get('filter[location_id]') === 'LOC2')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('button', { name: /stock per location/ })).toBeNull());
    expect(callsTo(fetchMock, '/stores/S1/inventory/movements').some((c) => searchOf(c).get('filter[location_id]') === 'LOC2')).toBe(true);
  });

  it('adjust dialog: location select; numbers, expected_on_hand, location_id and threshold use that location', async () => {
    let body: unknown = null;
    const fetchMock = signedIn(
      'owner',
      inventoryRoutes(undefined, {
        'POST /stores/S1/inventory/adjustments': (init) => {
          body = JSON.parse(String(init.body));
          return jsonResponse(200, { data: { items: [], movements: [] } });
        },
        'PATCH /stores/S1/inventory/V1': jsonResponse(200, { data: splitItem() }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/inventory' });
    await userEvent.click(await screen.findByRole('button', { name: 'Adjust Jamdani Three-Piece M / Red' }, SLOW));
    const dialog = await screen.findByRole('dialog', { name: 'Adjust stock' });
    const loc = within(dialog).getByRole('combobox', { name: 'Location' });
    expect(loc).toHaveValue('LOC1');
    expect(screen.getByText('on hand at Main warehouse')).toBeInTheDocument();
    await userEvent.selectOptions(loc, 'LOC2');
    expect(screen.getByText('on hand at Dhanmondi shop')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: '− Remove' }));
    await userEvent.type(screen.getByLabelText('Quantity'), '6');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Only 5 in stock at Dhanmondi shop.')).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Quantity'));
    await userEvent.type(screen.getByLabelText('Quantity'), '2');
    await userEvent.type(screen.getByLabelText('Low-stock alert at'), '3');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(body).toEqual({ reason: 'correction', note: null, items: [{ variant_id: 'V1', mode: 'delta', quantity: -2, expected_on_hand: 5, location_id: 'LOC2' }] }));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/inventory/V1', 'PATCH')[0]!)).toEqual({ low_stock_threshold: 3, location_id: 'LOC2' });
  });

  it('movements tab: location filter and Location column', async () => {
    const fetchMock = signedIn('owner', inventoryRoutes());
    renderApp(<AppRoutes />, { route: '/inventory?tab=movements' });
    const table = await screen.findByRole('table', { name: 'Stock movements' }, SLOW);
    expect(await within(table).findByRole('columnheader', { name: 'Location' })).toBeInTheDocument();
    expect(await within(table).findByText('Dhanmondi shop', undefined, SLOW)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Location' }), 'LOC2');
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/inventory/movements').some((c) => searchOf(c).get('filter[location_id]') === 'LOC2')).toBe(true));
  });
});

describe('Warehouses tab (§10.2, composed)', () => {
  it('lists locations with type, Default tag, numbers and value; add dialog validates and posts; pickup prefills address', async () => {
    const fetchMock = signedIn(
      'owner',
      inventoryRoutes([mainWarehouse, dhanmondi], {
        'GET /stores/S1/shipping': jsonResponse(200, {
          data: shipping({ pickup_locations: [{ id: 'PK1', name: 'Uttara pickup', contact_name: null, contact_phone: null, district_code: 'dhaka', thana_code: 'dhaka-uttara', district: 'Dhaka', thana: 'Uttara', address_line: 'House 4, Sector 7', is_default: false, created_at: '', updated_at: '' }] }),
        }),
        'POST /stores/S1/locations': jsonResponse(201, { data: { ...dhanmondi, id: 'LOC4', name: 'Uttara shop' } }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/inventory/warehouses' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Warehouses' }, SLOW)).toBeInTheDocument();
    expect(within(screen.getByRole('tablist', { name: 'Inventory' })).getByRole('tab', { name: 'Warehouses' })).toHaveAttribute('aria-selected', 'true');
    const table = screen.getByRole('table', { name: 'Locations' });
    expect(await within(table).findByText('Main warehouse', undefined, SLOW)).toBeInTheDocument();
    expect(within(table).getByText('Default')).toBeInTheDocument();
    expect(within(table).getByText('Online orders ship from here · Mirpur 10, Dhaka')).toBeInTheDocument();
    expect(within(table).getByText('Shop')).toBeInTheDocument();
    expect(within(table).getByText('1,284')).toBeInTheDocument();
    expect(within(table).getByText('৳ 3,92,000')).toBeInTheDocument();
    expect(screen.queryByText('No other locations yet')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: '+ Add location' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add location' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add location' }));
    expect(await within(dialog).findByText('Enter a name.')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Uttara shop');
    await userEvent.selectOptions(within(dialog).getByLabelText('Type'), 'shop');
    await userEvent.click(await within(dialog).findByLabelText('Use a pickup address'));
    await userEvent.selectOptions(within(dialog).getByLabelText('Pickup address'), 'PK1');
    expect(within(dialog).getByLabelText('Address (optional)')).toHaveValue('House 4, Sector 7, Uttara, Dhaka');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add location' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/locations', 'POST')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/locations', 'POST')[0]!)).toEqual({ name: 'Uttara shop', type: 'shop', address: 'House 4, Sector 7, Uttara, Dhaka', pickup_location_id: 'PK1' });
    expect(await screen.findByText('Uttara shop added.')).toBeInTheDocument();
  });

  it('name taken shows on the field', async () => {
    signedIn(
      'owner',
      inventoryRoutes([mainWarehouse, dhanmondi], {
        'GET /stores/S1/shipping': jsonResponse(200, { data: shipping() }),
        'POST /stores/S1/locations': jsonResponse(422, { error: { code: 'location_name_taken', message: 'Taken', details: { name: ['Taken'] } } }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/inventory/warehouses' });
    await userEvent.click(await screen.findByRole('button', { name: '+ Add location' }, SLOW));
    const dialog = await screen.findByRole('dialog', { name: 'Add location' });
    expect(within(dialog).queryByLabelText('Use a pickup address')).toBeNull();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Dhanmondi shop');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add location' }));
    expect(await within(dialog).findByText('You already have a location with this name.')).toBeInTheDocument();
  });

  it('archive shows the 409 reasons; make default asks first and posts', async () => {
    const fetchMock = signedIn(
      'owner',
      inventoryRoutes([mainWarehouse, dhanmondi], {
        'POST /stores/S1/locations/LOC2/archive': jsonResponse(409, { error: { code: 'location_in_use', message: 'In use', details: { reasons: ['has_stock', 'open_purchase_orders'] } } }),
        'POST /stores/S1/locations/LOC2/make-default': jsonResponse(200, { data: { ...dhanmondi, is_default: true } }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/inventory/warehouses' });
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for Dhanmondi shop' }, SLOW));
    await userEvent.click(screen.getByRole('menuitem', { name: /Archive/ }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Archive Dhanmondi shop?' })).getByRole('button', { name: 'Archive' }));
    const blocked = await screen.findByRole('dialog', { name: 'Dhanmondi shop can’t be archived yet' });
    const reasons = within(blocked).getByRole('list', { name: 'Why it can’t be archived' });
    expect(within(reasons).getAllByRole('listitem').map((l) => l.textContent)).toEqual([inUseReasonText.has_stock, inUseReasonText.open_purchase_orders]);
    await userEvent.click(within(blocked).getByRole('button', { name: 'OK' }));

    // the default location offers neither Make default nor Archive
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Main warehouse' }));
    expect(screen.queryByRole('menuitem', { name: /Make default/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Archive/ })).toBeNull();
    await userEvent.keyboard('{Escape}');

    await userEvent.click(screen.getByRole('button', { name: 'Actions for Dhanmondi shop' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Make default/ }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Ship online orders from Dhanmondi shop?' })).getByRole('button', { name: 'Make default' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/locations/LOC2/make-default', 'POST')).toHaveLength(1));
    expect(await screen.findByText('Online orders now ship from Dhanmondi shop.')).toBeInTheDocument();
  });

  it('one location on Starter: upgrade note, empty copy, no Add location', async () => {
    signedIn('owner', inventoryRoutes([mainWarehouse], { 'GET /features': jsonResponse(200, { data: starterPlan() }) }));
    renderApp(<AppRoutes />, { route: '/inventory/warehouses' });
    expect(await screen.findByText(/More than one location is on Growth/, undefined, SLOW)).toBeInTheDocument();
    expect(await screen.findByText('No other locations yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Add location' })).toBeNull();
  });

  it('archived locations can be restored', async () => {
    const fetchMock = signedIn('owner', inventoryRoutes([mainWarehouse, dhanmondi, oldHub], { 'POST /stores/S1/locations/LOC3/unarchive': jsonResponse(200, { data: { ...oldHub, archived_at: null } }) }));
    renderApp(<AppRoutes />, { route: '/inventory/warehouses?archived=1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for Old hub' }, SLOW));
    await userEvent.click(screen.getByRole('menuitem', { name: /Restore/ }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/locations/LOC3/unarchive', 'POST')).toHaveLength(1));
  });

  it('without settings.manage: read-only (no Add, no row menus, no stock value without costs.view)', async () => {
    signedIn({ role: 'custom', permissions: ['inventory.adjust', 'products.edit'] }, inventoryRoutes([mainWarehouse, { ...dhanmondi, stock_value_amount: null }]));
    renderApp(<AppRoutes />, { route: '/inventory/warehouses' });
    const table = await screen.findByRole('table', { name: 'Locations' }, SLOW);
    expect(await within(table).findByText('Dhanmondi shop', undefined, SLOW)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Add location' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
    expect(within(table).queryByText('Stock value')).toBeNull();
  });

  it('error state retries', async () => {
    signedIn('owner', inventoryRoutes([mainWarehouse], { 'GET /stores/S1/locations': jsonResponse(500, { error: { code: 'server_error', message: 'Boom' } }) }));
    renderApp(<AppRoutes />, { route: '/inventory/warehouses' });
    expect(await screen.findByText('We couldn’t load your locations', undefined, SLOW)).toBeInTheDocument();
  });
});

describe('Product editor (§10.3)', () => {
  it('"+ n at other locations" opens a popover listing them', async () => {
    const p = product({ options: [], variants: [variant({ title: 'Default', option_values: [], inventory: { on_hand: 14, committed: 0, available: 14, low_stock_threshold: null, effective_threshold: 5, status: 'in_stock', location_id: 'LOC1', total_on_hand: 19, other_locations_on_hand: 5 } })] });
    signedIn('owner', { 'GET /stores/S1/products/P1': jsonResponse(200, { data: p }), 'GET /stores/S1/inventory': inventoryList([splitItem()]) });
    renderApp(<AppRoutes />, { route: '/products/P1' });
    const btn = await screen.findByRole('button', { name: 'Product: 5 at other locations' }, SLOW);
    expect(btn).toHaveTextContent('+ 5 at other locations');
    await userEvent.click(btn);
    const pop = await screen.findByRole('dialog', { name: 'Stock at other locations for Product' });
    const items = await within(pop).findAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual(['Dhanmondi shop5']);
  });

  it('no stock elsewhere → no link and no extra request', async () => {
    const fetchMock = signedIn('owner', { 'GET /stores/S1/products/P1': jsonResponse(200, { data: product() }) });
    renderApp(<AppRoutes />, { route: '/products/P1' });
    await screen.findByLabelText('Product name', {}, SLOW);
    expect(screen.queryByText(/at other locations/)).toBeNull();
    expect(callsTo(fetchMock, '/stores/S1/locations')).toHaveLength(0);
  });
});

describe('Purchasing "Receive at" (§10.3, 35:6644 / 36:6615 / 36:7118)', () => {
  const routes = (locs = [mainWarehouse, dhanmondi]) =>
    purchasingRoutes({
      'GET /stores/S1/locations': locationsResponse(locs),
      'GET /stores/S1/inventory': inventoryList([inventoryItem({ variant_id: 'V1', cost_amount: 110000, on_hand: 8 })]),
      'POST /stores/S1/purchase-orders': jsonResponse(201, { data: poDetail({ id: 'PO15', number: 'PO-0015', status: 'draft', revision: 1 }) }),
      'GET /stores/S1/purchase-orders/PO15': jsonResponse(200, { data: poDetail({ id: 'PO15', number: 'PO-0015', status: 'draft' }) }),
    });

  const fillAndSave = async () => {
    await userEvent.click(screen.getByRole('button', { name: '+ Add product' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Add Jamdani Three-Piece M / Red' }));
    await userEvent.type(screen.getByLabelText('Quantity of Jamdani Three-Piece M / Red'), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  };

  it('new PO: select defaults to the default location; the chosen one is sent', async () => {
    const fetchMock = signedIn('owner', routes());
    renderApp(<AppRoutes />, { route: '/inventory/purchase-orders/new?supplier=SUP1' });
    const select = await screen.findByRole('combobox', { name: 'Receive at' }, SLOW);
    await waitFor(() => expect(select).toHaveValue('LOC1'));
    await userEvent.selectOptions(select, 'LOC2');
    await within(screen.getByRole('region', { name: 'Supplier' })).findByText('Tangail Weavers', undefined, SLOW);
    await fillAndSave();
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/purchase-orders', 'POST')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/purchase-orders', 'POST')[0]!).location_id).toBe('LOC2');
  });

  it('one location: no Receive at and no location_id in the body', async () => {
    const fetchMock = signedIn('owner', routes([mainWarehouse]));
    renderApp(<AppRoutes />, { route: '/inventory/purchase-orders/new?supplier=SUP1' });
    await within(await screen.findByRole('region', { name: 'Supplier' }, SLOW)).findByText('Tangail Weavers', undefined, SLOW);
    expect(screen.queryByText(/Receive at/)).toBeNull();
    await fillAndSave();
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/purchase-orders', 'POST')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/purchase-orders', 'POST')[0]!)).not.toHaveProperty('location_id');
  });

  it('PO detail: subtitle "receive at …" and footer "Adding n units to …" with > 1 location', async () => {
    signedIn('owner', routes());
    renderApp(<AppRoutes />, { route: '/inventory/purchase-orders/PO12' });
    expect(await screen.findByText(/receive at Main warehouse/, undefined, SLOW)).toBeInTheDocument();
    const receive = screen.getByRole('region', { name: 'Receive items' });
    await userEvent.click(within(receive).getByRole('button', { name: 'Receive all remaining' }));
    expect(within(receive).getByText('Adding 40 units to Main warehouse')).toBeInTheDocument();
  });

  it('PO detail with one location keeps the old copy', async () => {
    signedIn('owner', routes([mainWarehouse]));
    renderApp(<AppRoutes />, { route: '/inventory/purchase-orders/PO12' });
    const receive = await screen.findByRole('region', { name: 'Receive items' }, SLOW);
    await userEvent.click(within(receive).getByRole('button', { name: 'Receive all remaining' }));
    expect(within(receive).getByText('Adding 40 units to stock')).toBeInTheDocument();
    expect(screen.queryByText(/receive at/)).toBeNull();
  });
});

