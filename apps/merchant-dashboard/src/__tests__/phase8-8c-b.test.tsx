import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { countPill, countProgress, differencePill, lineExpected, parseCounted, scanCode, signedMoney, summaryLines } from '../inventory/counts/counts';
import {
  draftProblem,
  lowStockWarning,
  movementRefLabel,
  receiveAllDraft,
  receiveTotals,
  stockPreview,
  transferDate,
  transferPill,
} from '../inventory/transfers/transfers';
import { callsTo, jsonResponse, renderApp, signedIn } from '../test/utils';
import { inventoryItem, inventoryList } from './catalog.fixtures';
import {
  countDetail,
  countLine,
  countLines,
  countSummary,
  kurtiLine,
  transfer,
  transferDetail,
  transferLine,
  transfersList,
  transferSummary,
  uncountedLine,
} from './phase8-8c-b.fixtures';
import { dhanmondi, growthPlan, locationsResponse, mainWarehouse, splitItem, starterPlan } from './phase8-8c-a.fixtures';

// PHASE-8-8C §13 Web part B: transfer list / panel / send / receive / short maths / cancel; count list / start / scan
// box (+1, unknown code), editable count, chips, summary maths, finish confirm; permission / plan gating; a one-location
// store shows no transfer UI (Stock count stays).

const SLOW = { timeout: 5000 };
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const byMethod = (fetchMock: Parameters<typeof callsTo>[0], path: string, method: string) => callsTo(fetchMock, path).filter((c) => (c[1].method ?? 'GET') === method);
const bodyOf = (call: [string, RequestInit]) => JSON.parse(String(call[1].body));
const headerOf = (call: [string, RequestInit], name: string) => new Headers(call[1].headers).get(name);
const searchOf = (call: [string, RequestInit]) => new URL(String(call[0]), 'http://localhost').searchParams;

const transferRoutes = (o: Record<string, Response | ((init: RequestInit) => Response)> = {}) => ({
  'GET /features': jsonResponse(200, { data: growthPlan() }),
  'GET /stores/S1/locations': locationsResponse([mainWarehouse, dhanmondi]),
  'GET /stores/S1/stock-transfers/summary': jsonResponse(200, { data: transferSummary() }),
  'GET /stores/S1/stock-transfers': transfersList([
    transfer(),
    transfer({ id: 'TR2', number: 'TR-019', status: 'in_transit', units_sent: 24, sent_at: '2026-11-19T05:00:00Z' }),
    transfer({ id: 'TR3', number: 'TR-017', status: 'received', units_sent: 60, units_received: 58, units_short: 2, sent_at: '2026-11-14T05:00:00Z' }),
  ]),
  'GET /stores/S1/inventory': inventoryList([splitItem()]),
  ...o,
});

describe('PHASE-8-8C part B helpers', () => {
  it('transfer pills, date and short maths', () => {
    expect(transferPill({ status: 'received', units_short: 2 })).toEqual({ label: 'Received · 2 short', tone: 'danger' });
    expect(transferPill({ status: 'received', units_short: 0 })).toEqual({ label: 'Received', tone: 'success' });
    expect(transferPill({ status: 'in_transit', units_short: 0 }).tone).toBe('info');
    expect(transferPill({ status: 'draft', units_short: 0 })).toEqual({ label: 'Draft', tone: 'neutral' });
    const now = new Date('2026-11-25T10:00:00');
    expect(transferDate({ sent_at: null, created_at: '2026-11-25T08:00:00' }, now)).toBe('Today');
    expect(transferDate({ sent_at: '2026-11-24T08:00:00', created_at: '2026-11-20T08:00:00' }, now)).toBe('Yesterday');
    expect(transferDate({ sent_at: '2026-11-19T08:00:00', created_at: '2026-11-18T08:00:00' }, now)).toBe('19 Nov');
    const t = transferDetail({ status: 'in_transit' });
    expect(receiveTotals(t, {})).toEqual({ received: 0, short: 10, invalid: false });
    expect(receiveTotals(t, receiveAllDraft(t))).toEqual({ received: 10, short: 0, invalid: false });
    expect(receiveTotals(t, { TL1: 6, TL2: 2 })).toEqual({ received: 8, short: 2, invalid: false });
    expect(receiveTotals(t, { TL1: 7 }).invalid).toBe(true);
  });

  it('source preview turns red at or below the threshold; warning copy; draft checks', () => {
    expect(stockPreview('Mirpur', { on_hand: 46, available: 44, threshold: 5 }, 6)).toEqual({ text: 'Mirpur stock 46 → 40', after: 40, low: false, over: false });
    expect(stockPreview('Mirpur', { on_hand: 5, available: 5, threshold: 3 }, 4)).toMatchObject({ text: 'Mirpur stock 5 → 1', low: true });
    expect(stockPreview('Mirpur', { on_hand: 5, available: 3, threshold: null }, 4)).toMatchObject({ low: false, over: true });
    expect(stockPreview('Mirpur', null, 4)).toBeNull();
    expect(lowStockWarning([{ name: 'Kids Kurti', after: 1, low: true }], 'Mirpur', true)).toBe('Kids Kurti will drop to 1 in Mirpur — online orders may sell out.');
    expect(lowStockWarning([{ name: 'Kids Kurti', after: 1, low: true }], 'Hub', false)).toBe('Kids Kurti will drop to 1 in Hub.');
    expect(lowStockWarning([{ name: 'A', after: 9, low: false }], 'Hub', false)).toBeNull();
    expect(draftProblem({ from: 'A', to: 'A', lines: [] })).toMatch(/different/);
    expect(draftProblem({ from: 'A', to: 'B', lines: [] })).toMatch(/Add at least one/);
    expect(draftProblem({ from: 'A', to: 'B', lines: [{ variant_id: 'V', name: 'x', variant: null, quantity: 0 }] })).toMatch(/quantity/);
    expect(draftProblem({ from: 'A', to: 'B', lines: [{ variant_id: 'V', name: 'x', variant: null, quantity: 2 }] })).toBeNull();
  });

  it('movement row labels', () => {
    expect(movementRefLabel({ reason: 'transfer_out', reference: { type: 'stock_transfer', id: 'TR1' }, note: 'TR-021 → Dhanmondi shop' })).toEqual({ label: 'Transfer → Dhanmondi shop', sub: 'TR-021', to: '/inventory/transfers/TR1' });
    expect(movementRefLabel({ reason: 'transfer_in', reference: { type: 'stock_transfer', id: 'TR1' }, note: 'Cancelled' })?.label).toBe('Transfer cancelled');
    expect(movementRefLabel({ reason: 'count', reference: { type: 'stock_count', id: 'SC1' }, note: 'Monthly count' })).toEqual({ label: 'Count · Monthly count', sub: null, to: '/inventory/counts/SC1' });
    expect(movementRefLabel({ reason: 'damaged', reference: null, note: null })).toBeNull();
  });

  it('count maths and parsing', () => {
    expect(countProgress({ counted_count: 312, lines_count: 460 })).toEqual({ pct: 68, text: '312 of 460 variants counted' });
    expect(countProgress({ counted_count: 0, lines_count: 0 }).pct).toBe(0);
    expect(lineExpected({ expected: null, on_hand: 4 })).toBe(4);
    expect(lineExpected({ expected: 12, on_hand: 9 })).toBe(12);
    expect(differencePill({ counted: 10, difference: -2 })).toEqual({ label: '−2', tone: 'danger' });
    expect(differencePill({ counted: 21, difference: 1 })).toEqual({ label: '+1', tone: 'info' });
    expect(differencePill({ counted: 9, difference: 0 })).toEqual({ label: 'Match', tone: 'success' });
    expect(differencePill({ counted: null, difference: null })).toBeNull();
    expect(signedMoney(-690000)).toBe('− ৳ 6,900');
    expect(signedMoney(185000)).toBe('+ ৳ 1,850');
    expect(signedMoney(null)).toBe('—');
    const withValues = summaryLines(countSummary(), true);
    expect(withValues.short).toBe('11 items · ৳ 17,600');
    expect(withValues.extra).toBe('1 item · ৳ 1,850');
    expect(withValues.notCounted).toBe('148 variants');
    expect(withValues.net).toEqual({ label: 'Net stock loss', value: '− ৳ 15,750', tone: 'danger' });
    const noValues = summaryLines(countSummary({ short_value_amount: null, extra_value_amount: null, net_value_amount: null }), false);
    expect(noValues.short).toBe('11 items');
    expect(noValues.net).toBeNull();
    expect(parseCounted('')).toBeNull();
    expect(parseCounted('12')).toBe(12);
    expect(parseCounted('-1')).toBeUndefined();
    expect(parseCounted('1.5')).toBeUndefined();
    expect(parseCounted('1000001')).toBeUndefined();
    expect(scanCode('  jt-001 ')).toBe('jt-001');
    expect(scanCode('   ')).toBeNull();
    expect(scanCode('x'.repeat(65))).toBeNull();
    expect(countPill('completed')).toEqual({ label: 'Completed', tone: 'success' });
  });
});

describe('Inventory gating (§10.1, 11:788)', () => {
  it('one-location Starter store: no Transfers tab, no Transfer stock; Stock count tab shown', async () => {
    signedIn('owner', {
      'GET /features': jsonResponse(200, { data: starterPlan() }),
      'GET /stores/S1/locations': locationsResponse([mainWarehouse]),
      'GET /stores/S1/inventory': inventoryList([inventoryItem()]),
      'GET /stores/S1/inventory/movements': jsonResponse(200, { data: [], meta: { current_page: 1, per_page: 25, total: 0, last_page: 1 } }),
    });
    renderApp(<AppRoutes />, { route: '/inventory' });
    await screen.findByRole('button', { name: 'Adjust Jamdani Three-Piece M / Red' }, SLOW);
    const tabs = screen.getByRole('tablist', { name: 'Inventory' });
    expect(within(tabs).getByRole('tab', { name: 'Stock count' })).toBeInTheDocument();
    expect(within(tabs).queryByRole('tab', { name: 'Transfers' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Transfer stock' })).toBeNull();
  });

  it('Starter store with two locations sees no Transfer stock button', async () => {
    signedIn('owner', {
      'GET /features': jsonResponse(200, { data: starterPlan() }),
      'GET /stores/S1/locations': locationsResponse([mainWarehouse, dhanmondi]),
      'GET /stores/S1/inventory': inventoryList([splitItem()]),
      'GET /stores/S1/inventory/movements': jsonResponse(200, { data: [], meta: { current_page: 1, per_page: 25, total: 0, last_page: 1 } }),
    });
    renderApp(<AppRoutes />, { route: '/inventory' });
    await screen.findByRole('combobox', { name: 'Location' }, SLOW);
    expect(screen.queryByRole('link', { name: 'Transfer stock' })).toBeNull();
    expect(within(screen.getByRole('tablist', { name: 'Inventory' })).getByRole('tab', { name: 'Transfers' })).toBeInTheDocument();
  });

  it('Growth with two locations: Transfer stock opens a new transfer; movement rows show transfer and count', async () => {
    signedIn(
      'owner',
      transferRoutes({
        'GET /stores/S1/inventory/movements': jsonResponse(200, {
          data: [
            {
              id: 'MV1', variant_id: 'V1', product: { id: 'P1', name: 'Jamdani Three-Piece' }, variant_title: 'M / Red', sku: null, location: { id: 'LOC1', name: 'Main warehouse' },
              delta: -6, on_hand_after: 40, reason: 'transfer_out', note: 'TR-021 → Dhanmondi shop', reference: { type: 'stock_transfer', id: 'TR1' }, actor: { id: 'U1', name: 'Rahim' }, created_at: '2026-11-20T10:00:00Z',
            },
            {
              id: 'MV2', variant_id: 'V1', product: { id: 'P1', name: 'Jamdani Three-Piece' }, variant_title: 'M / Red', sku: null, location: { id: 'LOC1', name: 'Main warehouse' },
              delta: -2, on_hand_after: 38, reason: 'count', note: 'Monthly count', reference: { type: 'stock_count', id: 'SC1' }, actor: { id: 'U1', name: 'Rahim' }, created_at: '2026-11-21T10:00:00Z',
            },
          ],
          meta: { current_page: 1, per_page: 25, total: 2, last_page: 1 },
        }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/inventory?tab=movements' });
    expect(await screen.findByRole('link', { name: 'Transfer → Dhanmondi shop' }, SLOW)).toHaveAttribute('href', '/inventory/transfers/TR1');
    expect(screen.getByRole('link', { name: 'Count · Monthly count' })).toHaveAttribute('href', '/inventory/counts/SC1');
    await userEvent.click(await screen.findByRole('link', { name: 'Transfer stock' }, SLOW));
    expect(await screen.findByRole('dialog', { name: 'New transfer' }, SLOW)).toBeInTheDocument();
  });
});

describe('Stock transfers (§10.4, 153:34425)', () => {
  it('KPI tiles (Drafts, no approval), chips with counts, pills, row opens the panel', async () => {
    signedIn('owner', transferRoutes({ 'GET /stores/S1/stock-transfers/TR3': jsonResponse(200, { data: transferDetail({ id: 'TR3', number: 'TR-017', status: 'received', units_sent: 10, units_received: 8, units_short: 2, lines: [transferLine({ quantity_received: 4 }), kurtiLine()] }) }) }));
    renderApp(<AppRoutes />, { route: '/inventory/transfers' });
    const kpis = await screen.findByRole('region', { name: 'Transfer summary' }, SLOW);
    expect(kpis).toHaveTextContent('Drafts2Not sent yet');
    expect(kpis).toHaveTextContent('24 items · sent yesterday');
    expect(kpis).toHaveTextContent('312 items moved');
    expect(screen.queryByText(/approval/i)).toBeNull();
    expect(await screen.findByRole('button', { name: 'All · 3' }, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Draft · 1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cancelled/ })).toBeNull();
    expect(screen.getByText('Received · 2 short')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'TR-017' }));
    expect(await screen.findByText(/8 of 10 units received · 2 short, written off/, {}, SLOW)).toBeInTheDocument();
    expect(screen.getByText('4 received · 2 short')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Receive' })).toBeNull();
  });

  it('chip filters the list by status', async () => {
    const fetchMock = signedIn('owner', transferRoutes());
    renderApp(<AppRoutes />, { route: '/inventory/transfers' });
    await userEvent.click(await screen.findByRole('button', { name: 'In transit · 1' }, SLOW));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/stock-transfers').some((c) => searchOf(c).get('filter[status]') === 'in_transit')).toBe(true));
  });

  it('new transfer: add product, preview + low-stock warning, Send creates and sends with an idempotency key', async () => {
    const kurti = inventoryItem({
      variant_id: 'V2', product: { id: 'P2', name: 'Kids Kurti', status: 'active', image: null }, title: 'Yellow', low_stock_threshold: 3, effective_threshold: 3,
      on_hand: 5, committed: 0, available: 5, location_id: null,
      locations: [
        { id: 'LOC1', name: 'Main warehouse', on_hand: 5, committed: 0, available: 5 },
        { id: 'LOC2', name: 'Dhanmondi shop', on_hand: 0, committed: 0, available: 0 },
      ],
    });
    const fetchMock = signedIn(
      'owner',
      transferRoutes({
        'GET /stores/S1/inventory': inventoryList([kurti]),
        'POST /stores/S1/stock-transfers': jsonResponse(201, { data: transferDetail({ id: 'TR9', number: 'TR-022', status: 'in_transit', units_sent: 4, lines: [kurtiLine()] }) }),
        'GET /stores/S1/stock-transfers/TR9': jsonResponse(200, { data: transferDetail({ id: 'TR9', number: 'TR-022', status: 'in_transit', units_sent: 4, lines: [kurtiLine()] }) }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/inventory/transfers/new' });
    const panel = await screen.findByRole('dialog', { name: 'New transfer' }, SLOW);
    expect(within(panel).getByRole('combobox', { name: 'From' })).toHaveValue('LOC1');
    expect(within(panel).getByRole('combobox', { name: 'To' })).toHaveValue('LOC2');
    await userEvent.click(within(panel).getByRole('button', { name: '+ Add product' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Add Kids Kurti Yellow' }, SLOW));
    const qty = within(panel).getByRole('spinbutton', { name: 'Quantity of Kids Kurti Yellow' });
    await userEvent.clear(qty);
    await userEvent.type(qty, '4');
    const preview = within(panel).getByText('Yellow · Main warehouse stock 5 → 1');
    expect(preview).toHaveClass('text-danger');
    expect(within(panel).getByRole('note')).toHaveTextContent('Kids Kurti will drop to 1 in Main warehouse — online orders may sell out.');
    await userEvent.click(within(panel).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/stock-transfers', 'POST')).toHaveLength(1));
    const call = byMethod(fetchMock, '/stores/S1/stock-transfers', 'POST')[0]!;
    expect(bodyOf(call)).toEqual({ from_location_id: 'LOC1', to_location_id: 'LOC2', note: null, lines: [{ variant_id: 'V2', quantity: 4 }], send: true });
    expect(headerOf(call, 'Idempotency-Key')).toBeTruthy();
    expect(await screen.findByRole('dialog', { name: 'TR-022' }, SLOW)).toBeInTheDocument();
  });

  it('draft: Send shows insufficient stock per line', async () => {
    signedIn(
      'owner',
      transferRoutes({
        'GET /stores/S1/stock-transfers/TR1': jsonResponse(200, { data: transferDetail() }),
        'POST /stores/S1/stock-transfers/TR1/send': jsonResponse(422, { error: { code: 'insufficient_stock', message: 'Not enough stock', details: { lines: [{ variant_id: 'V2', requested: 4, available: 2 }] } } }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/inventory/transfers/TR1' });
    const panel = await screen.findByRole('dialog', { name: 'TR-021' }, SLOW);
    expect(within(panel).getByText(/Created by Nusrat Jahan/)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Save draft' })).toBeDisabled();
    await userEvent.click(within(panel).getByRole('button', { name: 'Send' }));
    expect(await within(panel).findByText('Only 2 available at Main warehouse', {}, SLOW)).toBeInTheDocument();
    expect(within(panel).getByRole('alert')).toHaveTextContent(/Not enough stock at the source/);
  });

  it('in transit: Receive all, live short, confirm when short; body has every line and a key', async () => {
    const inTransit = transferDetail({ status: 'in_transit', sent_at: '2026-11-24T05:00:00Z' });
    const fetchMock = signedIn(
      'owner',
      transferRoutes({
        'GET /stores/S1/stock-transfers/TR1': jsonResponse(200, { data: inTransit }),
        'POST /stores/S1/stock-transfers/TR1/receive': jsonResponse(200, { data: { ...inTransit, status: 'received', units_received: 8, units_short: 2 } }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/inventory/transfers/TR1' });
    const panel = await screen.findByRole('dialog', { name: 'TR-021' }, SLOW);
    expect(within(panel).getByText('0 received · 10 short')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Receive' })).toBeDisabled();
    await userEvent.click(within(panel).getByRole('button', { name: 'Receive all' }));
    expect(within(panel).getByText('10 received · 0 short')).toBeInTheDocument();
    const kurti = within(panel).getByRole('spinbutton', { name: 'Received of Kids Kurti Yellow / 6–7 y' });
    await userEvent.clear(kurti);
    await userEvent.type(kurti, '2');
    expect(within(panel).getByText('8 received · 2 short')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Receive' }));
    const confirm = await screen.findByRole('dialog', { name: 'Receive with 2 short?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Receive' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/stock-transfers/TR1/receive', 'POST')).toHaveLength(1));
    const call = byMethod(fetchMock, '/stores/S1/stock-transfers/TR1/receive', 'POST')[0]!;
    expect(bodyOf(call)).toEqual({ revision: 1, lines: [{ item_id: 'TL1', received: 6 }, { item_id: 'TL2', received: 2 }] });
    expect(headerOf(call, 'Idempotency-Key')).toBeTruthy();
  });

  it('cancel an in-transit transfer from the menu', async () => {
    const inTransit = transferDetail({ status: 'in_transit' });
    const fetchMock = signedIn(
      'owner',
      transferRoutes({
        'GET /stores/S1/stock-transfers/TR1': jsonResponse(200, { data: inTransit }),
        'POST /stores/S1/stock-transfers/TR1/cancel': jsonResponse(200, { data: { ...inTransit, status: 'cancelled' } }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/inventory/transfers/TR1' });
    const panel = await screen.findByRole('dialog', { name: 'TR-021' }, SLOW);
    await userEvent.click(within(panel).getByRole('button', { name: 'Transfer actions' }));
    await userEvent.click(within(panel).getByRole('menuitem', { name: /Cancel transfer/ }));
    const confirm = await screen.findByRole('dialog', { name: 'Cancel TR-021?' });
    expect(confirm).toHaveTextContent('The 10 units sent go back to Main warehouse.');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel transfer' }));
    await waitFor(() => expect(bodyOf(byMethod(fetchMock, '/stores/S1/stock-transfers/TR1/cancel', 'POST')[0]!)).toEqual({ revision: 1 }));
  });

  it('Starter: plan note, no New transfer; in-transit can still be received', async () => {
    signedIn('owner', transferRoutes({ 'GET /features': jsonResponse(200, { data: starterPlan() }), 'GET /stores/S1/stock-transfers/TR1': jsonResponse(200, { data: transferDetail({ status: 'in_transit' }) }) }));
    renderApp(<AppRoutes />, { route: '/inventory/transfers/TR1' });
    expect(await screen.findByText(/Stock transfers are on the Growth plan/, {}, SLOW)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '+ New transfer' })).toBeNull();
    const panel = await screen.findByRole('dialog', { name: 'TR-021' }, SLOW);
    expect(within(panel).getByRole('button', { name: 'Receive all' })).toBeInTheDocument();
  });

  it('without inventory.adjust: read-only (no New transfer, no receive inputs, no menu)', async () => {
    signedIn({ role: 'custom', permissions: ['products.edit'] }, transferRoutes({ 'GET /stores/S1/stock-transfers/TR1': jsonResponse(200, { data: transferDetail({ status: 'in_transit' }) }) }));
    renderApp(<AppRoutes />, { route: '/inventory/transfers/TR1' });
    const panel = await screen.findByRole('dialog', { name: 'TR-021' }, SLOW);
    expect(within(panel).queryByRole('spinbutton')).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Transfer actions' })).toBeNull();
    expect(screen.queryByRole('link', { name: '+ New transfer' })).toBeNull();
  });

  it('empty states: no other locations; no transfers yet; error retries', async () => {
    signedIn('owner', transferRoutes({ 'GET /stores/S1/locations': locationsResponse([mainWarehouse]), 'GET /stores/S1/stock-transfers': transfersList([]) }));
    const { unmount } = renderApp(<AppRoutes />, { route: '/inventory/transfers' });
    expect(await screen.findByText('No other locations yet', {}, SLOW)).toBeInTheDocument();
    unmount();
    signedIn('owner', transferRoutes({ 'GET /stores/S1/stock-transfers': transfersList([]) }));
    const r2 = renderApp(<AppRoutes />, { route: '/inventory/transfers' });
    expect(await screen.findByText('No transfers yet — move stock between your locations.', {}, SLOW)).toBeInTheDocument();
    r2.unmount();
    signedIn('owner', transferRoutes({ 'GET /stores/S1/stock-transfers': jsonResponse(500, { error: { code: 'server_error', message: 'Boom' } }) }));
    renderApp(<AppRoutes />, { route: '/inventory/transfers' });
    expect(await screen.findByText('We couldn’t load your transfers', {}, SLOW)).toBeInTheDocument();
  });
});

const countRoutes = (o: Record<string, Response | ((init: RequestInit) => Response)> = {}) => ({
  'GET /features': jsonResponse(200, { data: starterPlan() }),
  'GET /stores/S1/locations': locationsResponse([mainWarehouse]),
  'GET /stores/S1/stock-counts/SC1': jsonResponse(200, { data: countDetail() }),
  'GET /stores/S1/stock-counts/SC1/lines': countLines([countLine(), uncountedLine()]),
  ...o,
});

describe('Stock counts (§10.5, 153:35246)', () => {
  it('list empty state; Start count posts and opens the count', async () => {
    const fetchMock = signedIn(
      'owner',
      countRoutes({
        'GET /stores/S1/stock-counts': jsonResponse(200, { data: [], meta: { current_page: 1, per_page: 25, total: 0, last_page: 1, counts: { all: 0, in_progress: 0, completed: 0, cancelled: 0 } } }),
        'GET /stores/S1/categories': jsonResponse(200, { data: [] }),
        'POST /stores/S1/stock-counts': jsonResponse(201, { data: countDetail() }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/inventory/counts' });
    expect(await screen.findByText('No counts yet', {}, SLOW)).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Start count' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Start count' });
    await userEvent.type(within(dialog).getByLabelText('Name (optional)'), 'Monthly count');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start count' }));
    await waitFor(() => expect(bodyOf(byMethod(fetchMock, '/stores/S1/stock-counts', 'POST')[0]!)).toEqual({ location_id: 'LOC1', category_id: null, name: 'Monthly count' }));
    expect(await screen.findByRole('heading', { name: 'Monthly count · Mirpur', level: 1 }, SLOW)).toBeInTheDocument();
  });

  it('Start count: 409 count_in_progress links to the open count', async () => {
    signedIn(
      'owner',
      countRoutes({
        'GET /stores/S1/stock-counts': jsonResponse(200, { data: [countDetail()], meta: { current_page: 1, per_page: 25, total: 1, last_page: 1, counts: { all: 1, in_progress: 1, completed: 0, cancelled: 0 } } }),
        'GET /stores/S1/categories': jsonResponse(200, { data: [] }),
        'POST /stores/S1/stock-counts': jsonResponse(409, { error: { code: 'count_in_progress', message: 'Open', details: { count_id: 'SC1' } } }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/inventory/counts' });
    expect(await screen.findByRole('link', { name: /Monthly count · Mirpur/ }, SLOW)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start count' }));
    const dialog = await screen.findByRole('dialog', { name: 'Start count' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start count' }));
    expect(await within(dialog).findByRole('link', { name: 'Open it' }, SLOW)).toHaveAttribute('href', '/inventory/counts/SC1');
  });

  it('count screen: header, progress, summary values, no hidden Figma items', async () => {
    signedIn('owner', countRoutes());
    renderApp(<AppRoutes />, { route: '/inventory/counts/SC1' });
    expect(await screen.findByRole('heading', { name: 'Monthly count · Mirpur', level: 1 }, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent(/Inventory.*Stock counts· started 20 Nov \d\d:\d\d by Rahim Uddin/);
    expect(screen.getByRole('region', { name: 'Progress' })).toHaveTextContent('312 of 460 variants counted');
    expect(screen.getByRole('region', { name: 'Progress' })).toHaveTextContent('68%');
    const summary = screen.getByRole('region', { name: 'If you finish now' });
    expect(summary).toHaveTextContent('11 items · ৳ 17,600');
    expect(summary).toHaveTextContent('Net stock loss− ৳ 15,750');
    const options = screen.getByRole('region', { name: 'When you finish' });
    expect(within(options).getAllByRole('switch')).toHaveLength(1);
    for (const hidden of [/Pause/, /Scanner ready/, /Record shortage/, /Lock online sales/]) expect(screen.queryByText(hidden)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    // table: expected for uncounted = on hand, difference pills, value
    expect(await screen.findByText('− ৳ 6,900', {}, SLOW)).toBeInTheDocument();
    expect(screen.getByText('−2')).toBeInTheDocument();
  });

  it('without costs.view: no values anywhere', async () => {
    signedIn(
      { role: 'custom', permissions: ['inventory.adjust'] },
      countRoutes({
        'GET /stores/S1/stock-counts/SC1': jsonResponse(200, { data: countDetail({ net_value_amount: null, summary: countSummary({ short_value_amount: null, extra_value_amount: null, net_value_amount: null }) }) }),
        'GET /stores/S1/stock-counts/SC1/lines': countLines([countLine({ value_amount: null })]),
      }),
    );
    renderApp(<AppRoutes />, { route: '/inventory/counts/SC1' });
    const summary = await screen.findByRole('region', { name: 'If you finish now' }, SLOW);
    expect(summary).toHaveTextContent('11 items');
    expect(summary).not.toHaveTextContent('৳');
    expect(screen.queryByText(/Net stock/)).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Value' })).toBeNull();
  });

  it('scan box: Enter scans +1, clears and keeps focus; unknown code shows a message', async () => {
    let n = 0;
    const fetchMock = signedIn(
      'owner',
      countRoutes({
        'POST /stores/S1/stock-counts/SC1/scan': (init) => {
          n += 1;
          const code = JSON.parse(String(init.body)).code as string;
          if (code === 'NOPE') return jsonResponse(404, { error: { code: 'count_line_not_found', message: 'Not found', details: { code: 'NOPE' } } });
          return jsonResponse(200, { data: { line: countLine({ counted: 11, difference: -1, value_amount: -345000 }), summary: countSummary({ short_units: 10 }), count: countDetail({ counted_count: 312 }) } });
        },
      }),
    );
    renderApp(<AppRoutes />, { route: '/inventory/counts/SC1' });
    const box = await screen.findByRole('textbox', { name: 'SKU or barcode' }, SLOW);
    expect(box).toHaveAttribute('placeholder', 'Type or scan a SKU — each scan adds 1');
    await userEvent.type(box, 'JT-001-RD-M{Enter}');
    await waitFor(() => expect(bodyOf(byMethod(fetchMock, '/stores/S1/stock-counts/SC1/scan', 'POST')[0]!)).toEqual({ code: 'JT-001-RD-M' }));
    expect(box).toHaveValue('');
    expect(await screen.findByText('+1 · Jamdani Three-Piece Red / M · counted 11', {}, SLOW)).toBeInTheDocument();
    expect(box).toHaveFocus();
    // the row is patched from the response (no refetch of lines)
    expect(await screen.findByText('− ৳ 3,450')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'If you finish now' })).toHaveTextContent('10 items');
    await userEvent.type(box, 'NOPE{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('No product in this count has the SKU or barcode “NOPE”.');
    expect(box).toHaveFocus();
    expect(n).toBe(2);
  });

  it('COUNTED is editable on click; chips filter by state', async () => {
    const fetchMock = signedIn(
      'owner',
      countRoutes({
        'PUT /stores/S1/stock-counts/SC1/lines/CL2': jsonResponse(200, { data: { line: { ...uncountedLine(), counted: 3, expected: 4, difference: -1, value_amount: -890000 }, summary: countSummary(), count: countDetail({ counted_count: 313 }) } }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/inventory/counts/SC1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit counted for Katan Saree Maroon' }, SLOW));
    const input = screen.getByRole('textbox', { name: 'Counted for Katan Saree Maroon' });
    await userEvent.type(input, '3{Enter}');
    await waitFor(() => expect(bodyOf(byMethod(fetchMock, '/stores/S1/stock-counts/SC1/lines/CL2', 'PUT')[0]!)).toEqual({ counted: 3 }));
    expect(await screen.findByRole('region', { name: 'Progress' })).toHaveTextContent('313 of 460');
    await userEvent.click(screen.getByRole('button', { name: 'Differences · 7' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/stock-counts/SC1/lines').some((c) => searchOf(c).get('filter[state]') === 'differences')).toBe(true));
  });

  it('Finish & adjust stock: confirm with summary, zero uncounted, idempotency key', async () => {
    const fetchMock = signedIn('owner', countRoutes({ 'POST /stores/S1/stock-counts/SC1/finish': jsonResponse(200, { data: countDetail({ status: 'completed', zero_uncounted: true }) }) }));
    renderApp(<AppRoutes />, { route: '/inventory/counts/SC1' });
    await userEvent.click(await screen.findByRole('switch', { name: 'Set uncounted items to 0' }, SLOW));
    expect(screen.getByText('On: 148 variants go to 0')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Finish & adjust stock' }));
    const dialog = await screen.findByRole('dialog', { name: 'Finish & adjust stock?' });
    expect(within(dialog).getByRole('list', { name: 'Finish summary' })).toHaveTextContent('148 variants · set to 0');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Finish & adjust stock' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/stock-counts/SC1/finish', 'POST')).toHaveLength(1));
    const call = byMethod(fetchMock, '/stores/S1/stock-counts/SC1/finish', 'POST')[0]!;
    expect(bodyOf(call)).toEqual({ zero_uncounted: true, revision: 4 });
    expect(headerOf(call, 'Idempotency-Key')).toBeTruthy();
  });

  it('completed counts are read-only', async () => {
    signedIn('owner', countRoutes({ 'GET /stores/S1/stock-counts/SC1': jsonResponse(200, { data: countDetail({ status: 'completed', zero_uncounted: false, finished_at: '2026-11-21T10:00:00Z' }) }) }));
    renderApp(<AppRoutes />, { route: '/inventory/counts/SC1' });
    expect(await screen.findByText('Completed', {}, SLOW)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'SKU or barcode' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Finish & adjust stock' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit counted/ })).toBeNull();
    expect(screen.getByText(/Uncounted items kept their stock/)).toBeInTheDocument();
  });

  it('cancel count from the menu', async () => {
    const fetchMock = signedIn(
      'owner',
      countRoutes({
        'POST /stores/S1/stock-counts/SC1/cancel': jsonResponse(200, { data: countDetail({ status: 'cancelled' }) }),
        'GET /stores/S1/stock-counts': jsonResponse(200, { data: [], meta: { current_page: 1, per_page: 25, total: 0, last_page: 1, counts: { all: 0, in_progress: 0, completed: 0, cancelled: 0 } } }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/inventory/counts/SC1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Count actions' }, SLOW));
    await userEvent.click(screen.getByRole('menuitem', { name: /Cancel count/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this count?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel count' }));
    await waitFor(() => expect(bodyOf(byMethod(fetchMock, '/stores/S1/stock-counts/SC1/cancel', 'POST')[0]!)).toEqual({ revision: 4 }));
  });

  it('without inventory.adjust: no scan box, no finish, no Start count', async () => {
    signedIn(
      { role: 'custom', permissions: ['products.edit'] },
      countRoutes({ 'GET /stores/S1/stock-counts': jsonResponse(200, { data: [], meta: { current_page: 1, per_page: 25, total: 0, last_page: 1, counts: { all: 0, in_progress: 0, completed: 0, cancelled: 0 } } }) }),
    );
    const { unmount } = renderApp(<AppRoutes />, { route: '/inventory/counts/SC1' });
    await screen.findByRole('heading', { name: 'Monthly count · Mirpur', level: 1 }, SLOW);
    expect(screen.queryByRole('textbox', { name: 'SKU or barcode' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Finish & adjust stock' })).toBeNull();
    unmount();
    renderApp(<AppRoutes />, { route: '/inventory/counts' });
    expect(await screen.findByText('No counts yet', {}, SLOW)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start count' })).toBeNull();
  });
});
