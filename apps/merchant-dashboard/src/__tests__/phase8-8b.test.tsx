import type { StockMovement } from '@storeplix/types';
import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { fieldLabels, importCopy, importTypeOf } from '../imports/fields';
import { can } from '../lib/permissions';
import {
  advanceSplit,
  eventText,
  expectedCell,
  itemsLine,
  movementPoRef,
  orderableCount,
  orderedCell,
  poTotals,
  purchasingLocked,
  receiveAll,
  receiveFooter,
  receiveLineError,
  receiveTotals,
  receivingBar,
  recentPoPill,
  sellsOutText,
  termsLabel,
  whatsappLink,
  whatsappText,
} from '../purchasing/purchasing';
import { invalidateAfterReceipt, invalidatePurchasing, purchasingKeys } from '../purchasing/queries';
import { callsTo, jsonResponse, renderApp, signedIn } from '../test/utils';
import { inventoryItem, inventoryList } from './catalog.fixtures';
import { features } from './phase7.fixtures';
import { adjustOnly, po, poDetail, poRows, purchasingRoutes, suggestions, supplier } from './phase8-8b.fixtures';

// PHASE-8-8B §13 Web: PO list (chips, KPIs, late flag, receiving bar), new PO form (line maths, last-bought hint, remove
// line, suggested lines), receive form (left/damaged maths, receive-all, footer totals, adjust-only view without money),
// payments dialog, quick purchase dialog, suppliers list + panel + add/edit + import, inventory INCOMING column and
// movement reference, reorder card, permission/plan gating, WhatsApp link text, mobile cards.

const SLOW = { timeout: 5000 };
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const byMethod = (fetchMock: Parameters<typeof callsTo>[0], path: string, method: string) => callsTo(fetchMock, path).filter((c) => (c[1].method ?? 'GET') === method);
const bodyOf = (call: [string, RequestInit]) => JSON.parse(String(call[1].body));
const adjustOnlyRole = { role: 'custom' as const, permissions: ['inventory.adjust', 'products.edit'] as const };
const noMoney = () => expect(document.querySelector('main')?.textContent ?? '').not.toMatch(/৳/);

describe('PHASE-8-8B helpers', () => {
  it('receiving bar, expected/late, items line, ordered cell', () => {
    expect(receivingBar(po())).toEqual({ text: '60 / 100 units', share: 0.6, complete: false });
    expect(receivingBar(po({ status: 'received', units_received: 40, units_ordered: 40 }))?.complete).toBe(true);
    expect(receivingBar(po({ status: 'draft' }))).toBeNull();
    expect(expectedCell(po({ expected_on: '2026-11-17', is_late: true }))).toEqual({ text: '17 Nov · late', late: true });
    expect(expectedCell(po({ expected_on: null }))).toEqual({ text: '—', late: false });
    expect(itemsLine(po())).toBe('Jamdani, Katan Saree · 5 lines');
    expect(orderedCell(po({ ordered_at: '2026-11-24T05:00:00Z' }), '2026-11-24', 'Asia/Dhaka')).toBe('Today');
    expect(orderedCell(po(), '2026-11-24', 'Asia/Dhaka')).toBe('10 Nov');
  });

  it('PO maths: totals, advance split, terms copy', () => {
    const t = poTotals(
      [
        { variant_id: 'V1', unit_cost_amount: 110000, quantity: 30 },
        { variant_id: 'V2', unit_cost_amount: 260000, quantity: 10 },
      ],
      120000,
      400000,
    );
    expect(t).toMatchObject({ units: 40, subtotal: 5900000, shipping: 120000, discount: 400000, total: 5620000 });
    expect(advanceSplit(8400000, 50)).toEqual({ percent: 50, advance: 4200000, onDelivery: 4200000 });
    expect(advanceSplit(101, 50)).toEqual({ percent: 50, advance: 51, onDelivery: 50 });
    expect(advanceSplit(8400000, null)).toBeNull();
    expect(termsLabel({ payment_terms_days: null, advance_percent: 50 })).toBe('50% advance, rest on delivery');
    expect(termsLabel({ payment_terms_days: 15, advance_percent: null })).toBe('15 days after delivery');
    expect(termsLabel({ payment_terms_days: null, advance_percent: null })).toBe('On delivery');
  });

  it('receive maths: left check, receive all, footer totals', () => {
    const d = poDetail();
    expect(receiveLineError(d.lines[1]!, { received: 28, damaged: 2 })).toBeNull();
    expect(receiveLineError(d.lines[1]!, { received: 30, damaged: 1 })).toBe('Only 30 left on this line.');
    const all = receiveAll(d.lines);
    expect(all).toEqual({ L3: { received: 30, damaged: 0 }, L4: { received: 10, damaged: 0 } });
    const t = receiveTotals(d.lines, { L3: { received: 28, damaged: 2 }, L4: { received: 10, damaged: 0 } });
    expect(t).toEqual({ units: 38, damaged: 2, value: 28 * 100000 + 10 * 250000 });
    expect(receiveFooter(t)).toEqual({ title: 'Adding 38 units to stock', detail: 'Stock value + ৳ 53,000 · cost prices updated · 2 damaged, not added to stock' });
    // adjust-only: no cost → no money line
    const hidden = receiveTotals(adjustOnly(d).lines, { L3: { received: 5, damaged: 0 } });
    expect(hidden.value).toBeNull();
    expect(receiveFooter(hidden)).toEqual({ title: 'Adding 5 units to stock', detail: '' });
  });

  it('WhatsApp link text and tel/wa links', () => {
    const text = whatsappText({
      number: 'PO-0015',
      storeName: 'Mugdho Fashion',
      supplierName: 'Karim Mia',
      expected_on: '2026-11-24',
      lines: [
        { name: 'Jamdani Three-Piece', variant: 'Red · M', quantity: 30, unit_cost_amount: 110000 },
        { name: 'Silk Saree', variant: 'Default', quantity: 10, unit_cost_amount: 260000 },
      ],
      shipping_amount: 120000,
      discount_amount: 400000,
      total_amount: 8400000,
      notes: null,
    });
    expect(text).toBe(
      [
        'Purchase order PO-0015 from Mugdho Fashion',
        'Hi Karim Mia, please send:',
        '• Jamdani Three-Piece (Red · M) × 30 @ ৳ 1,100',
        '• Silk Saree × 10 @ ৳ 2,600',
        'Transport: ৳ 1,200',
        'Discount: − ৳ 4,000',
        'Total: ৳ 84,000',
        'Needed by 24 Nov 2026',
      ].join('\n'),
    );
    expect(whatsappLink('8801711889900', 'Hi there')).toBe('https://wa.me/8801711889900?text=Hi%20there');
    expect(whatsappLink('01711-889900')).toBe('https://wa.me/8801711889900');
    expect(whatsappLink(null)).toBeNull();
  });

  it('history, movement reference, reorder copy, plan lock, pills', () => {
    expect(eventText(poDetail().events[2]!)).toBe('Received 60 units · Sumi');
    expect(eventText({ type: 'sent', actor: null, created_at: '', sent_via: 'pdf', units: null, damaged: null, amount: null })).toBe('Sent to supplier as PDF');
    expect(eventText({ type: 'payment_recorded', actor: null, created_at: '', sent_via: null, units: null, damaged: null, amount: 5000000 })).toBe('Payment ৳ 50,000 recorded');
    const mv = { reference: { type: 'purchase_order' as const, id: 'PO12' }, note: 'PO-0012 · Tangail Weavers' };
    expect(movementPoRef(mv)).toEqual({ id: 'PO12', number: 'PO-0012', supplier: 'Tangail Weavers' });
    expect(movementPoRef({ reference: { type: 'order', id: 'O1' }, note: null })).toBeNull();
    expect(sellsOutText(suggestions[0]!.items[0]!)).toBe('8 left · Sells out in 5 days');
    expect(sellsOutText(suggestions[1]!.items[0]!)).toBe('0 left · Out of stock');
    expect(orderableCount(suggestions)).toBe(1);
    expect(purchasingLocked(features())).toBe(true);
    expect(purchasingLocked(features({ features: { ...features().features, purchasing: true } }))).toBe(false);
    expect(purchasingLocked(undefined)).toBe(false);
    expect(recentPoPill(po({ status: 'ordered' }))).toEqual({ label: 'On the way', tone: 'info' });
    expect(recentPoPill(po({ status: 'received', payment_status: 'unpaid' }))).toEqual({ label: 'Unpaid', tone: 'danger' });
  });

  it('supplier import type copy and columns', () => {
    expect(importTypeOf('suppliers')).toBe('suppliers');
    expect(importTypeOf('nope')).toBe('products');
    expect(importCopy('suppliers').back).toBe('/inventory/suppliers');
    expect(fieldLabels('suppliers').lead_time_days).toBe('Lead time (days)');
  });

  it('permissions: purchasing.manage and receiving', () => {
    expect(can.managePurchasing({ role: 'owner' })).toBe(true);
    expect(can.managePurchasing({ role: 'admin' })).toBe(true);
    expect(can.managePurchasing({ role: 'staff' })).toBe(false);
    expect(can.receiveStock({ role: 'staff' })).toBe(true); // staff holds inventory.adjust
    expect(can.receiveStock({ role: 'custom', permissions: ['orders.view'] })).toBe(false);
    expect(can.receiveStock({ role: 'custom', permissions: ['purchasing.manage', 'costs.view'] })).toBe(true);
  });

  it('a receipt refreshes purchasing, inventory, movements and products; other writes leave stock alone', async () => {
    const s = { tenantId: 'T1', storeId: 'S1' };
    const seed = () => {
      const qc = new QueryClient();
      for (const k of [purchasingKeys.orderSummary(s), purchasingKeys.supplierSummary(s), purchasingKeys.suggestions(s), ['T1', 'S1', 'inventory', {}], ['T1', 'S1', 'movements', {}], ['T1', 'S1', 'products'], ['T1', 'S1', 'expenses']]) qc.setQueryData(k, 1);
      return qc;
    };
    const a = seed();
    await invalidateAfterReceipt(a, s);
    expect(a.getQueryState(purchasingKeys.orderSummary(s))?.isInvalidated).toBe(true);
    expect(a.getQueryState(['T1', 'S1', 'inventory', {}])?.isInvalidated).toBe(true);
    expect(a.getQueryState(['T1', 'S1', 'movements', {}])?.isInvalidated).toBe(true);
    expect(a.getQueryState(['T1', 'S1', 'products'])?.isInvalidated).toBe(true);
    expect(a.getQueryState(['T1', 'S1', 'expenses'])?.isInvalidated).toBe(false); // §6.3 purchases are not expenses
    const b = seed();
    await invalidatePurchasing(b, s);
    expect(b.getQueryState(purchasingKeys.supplierSummary(s))?.isInvalidated).toBe(true);
    expect(b.getQueryState(['T1', 'S1', 'inventory', {}])?.isInvalidated).toBe(false);
  });
});

describe('Purchase orders list (§10.2)', () => {
  it('KPIs, status chips with counts, late flag, receiving bar, reorder card', async () => {
    const fetchMock = signedIn('owner', purchasingRoutes());
    renderApp(<AppRoutes />, { route: '/inventory/purchase-orders' });
    const table = await screen.findByRole('table', { name: 'Purchase orders' }, SLOW);
    const tabs = screen.getByRole('tablist', { name: 'Inventory' });
    expect(within(tabs).getByRole('tab', { name: 'Purchase orders' })).toHaveAttribute('aria-selected', 'true');
    expect(within(tabs).getByRole('tab', { name: 'Suppliers' })).toBeInTheDocument();
    expect(within(tabs).queryByRole('tab', { name: /Warehouses|Stock count/ })).toBeNull();
    const kpis = await screen.findByRole('region', { name: 'Purchase order summary' });
    expect(within(kpis).getByText('৳ 2,48,600 in total')).toBeInTheDocument();
    expect(within(kpis).getByText('186')).toBeInTheDocument();
    expect(within(kpis).getByText('Across 3 suppliers')).toBeInTheDocument();
    expect(within(kpis).getByText('৳ 1,12,400')).toBeInTheDocument();
    expect(within(kpis).getByText('2 payments due this week')).toBeInTheDocument();
    expect(within(kpis).getByText('PO-0013 · 2 days late')).toBeInTheDocument();
    const chips = screen.getByRole('group', { name: 'Status' });
    expect(within(chips).getByRole('button', { name: 'All · 14' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(chips).getByRole('button', { name: 'Partly received · 1' })).toBeInTheDocument();
    expect(within(chips).queryByRole('button', { name: /Closed/ })).toBeNull();
    expect(within(table).getByText('17 Nov · late')).toHaveClass('text-danger');
    expect(within(table).getByText('60 / 100 units')).toBeInTheDocument();
    expect(within(table).getByText('Partly received')).toBeInTheDocument();
    expect(within(table).getByText('৳ 1,18,000')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quick purchase' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '+ New purchase order' })).toHaveAttribute('href', '/inventory/purchase-orders/new');
    expect(screen.queryByRole('link', { name: 'Suppliers' })).toBeNull(); // header button hidden; the tab exists

    await userEvent.click(within(chips).getByRole('button', { name: 'Ordered · 2' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/purchase-orders').some((c) => new URL(c[0], 'http://x').searchParams.get('filter[status]') === 'ordered')).toBe(true));

    // Reorder suggestions: one orderable item (the other has no supplier yet) → one draft
    const card = await screen.findByRole('region', { name: 'Reorder suggestions' });
    expect(within(card).getByText('8 left · Sells out in 5 days')).toBeInTheDocument();
    expect(within(card).getByText('No supplier yet')).toBeInTheDocument();
    expect(within(card).getByText('Order 30')).toBeInTheDocument();
  });

  it('"Create PO for 1 item" creates one draft per supplier group', async () => {
    const fetchMock = signedIn('owner', purchasingRoutes({ 'POST /stores/S1/purchase-orders': jsonResponse(201, { data: poDetail({ id: 'PO15', number: 'PO-0015', status: 'draft' }) }), 'GET /stores/S1/purchase-orders/PO15': jsonResponse(200, { data: poDetail({ id: 'PO15', number: 'PO-0015', status: 'draft' }) }) }));
    renderApp(<AppRoutes />, { route: '/inventory/purchase-orders' });
    await userEvent.click(await screen.findByRole('button', { name: 'Create PO for 1 item' }, SLOW));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/purchase-orders', 'POST')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/purchase-orders', 'POST')[0]!)).toEqual({ supplier_id: 'SUP1', lines: [{ variant_id: 'V9', quantity: 30, unit_cost_amount: 105000 }] });
    expect(await screen.findByRole('heading', { level: 1, name: /PO-0015/ }, SLOW)).toBeInTheDocument();
  });

  it('empty state copy', async () => {
    signedIn('owner', purchasingRoutes({ 'GET /stores/S1/purchase-orders': jsonResponse(200, { data: [], meta: { current_page: 1, per_page: 25, total: 0, last_page: 1, counts: { all: 0, draft: 0, ordered: 0, partially_received: 0, received: 0, closed: 0, cancelled: 0 } } }), 'GET /stores/S1/purchasing/reorder-suggestions': jsonResponse(200, { data: [] }) }));
    renderApp(<AppRoutes />, { route: '/inventory/purchase-orders' });
    expect(await screen.findByText('No purchase orders yet — create one or record a quick purchase.', undefined, SLOW)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Reorder suggestions' })).toBeNull();
  });

  it('adjust-only receiver: list without money, no KPIs, no Suppliers tab, no create buttons', async () => {
    const rows = poRows.map((r) => ({ ...r, total_amount: null, paid_amount: null, subtotal_amount: null, received_value_amount: null, balance_amount: null, payment_status: null }));
    const fetchMock = signedIn(adjustOnlyRole, purchasingRoutes({ 'GET /stores/S1/purchase-orders': jsonResponse(200, { data: rows, meta: { current_page: 1, per_page: 25, total: 4, last_page: 1, counts: { all: 4, draft: 1, ordered: 1, partially_received: 1, received: 1, closed: 0, cancelled: 0 } } }) }));
    renderApp(<AppRoutes />, { route: '/inventory/purchase-orders' });
    await screen.findByRole('table', { name: 'Purchase orders' }, SLOW);
    expect(await screen.findByText('PO-0012', undefined, SLOW)).toBeInTheDocument();
    const tabs = screen.getByRole('tablist', { name: 'Inventory' });
    expect(within(tabs).queryByRole('tab', { name: 'Suppliers' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Purchase order summary' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Quick purchase' })).toBeNull();
    expect(screen.queryByText('Total')).toBeNull();
    noMoney();
    expect(callsTo(fetchMock, '/stores/S1/purchase-orders/summary')).toHaveLength(0);
    expect(callsTo(fetchMock, '/stores/S1/purchasing/reorder-suggestions')).toHaveLength(0);
  });

  it('staff without inventory.adjust or purchasing.manage get the no-access state', async () => {
    signedIn({ role: 'custom', permissions: ['orders.view'] }, purchasingRoutes());
    renderApp(<AppRoutes />, { route: '/inventory/purchase-orders' });
    expect(await screen.findByText(/don’t have access|do not have access|No access/i, undefined, SLOW)).toBeInTheDocument();
  });

  it('Free plan shows the plan note', async () => {
    signedIn('owner', purchasingRoutes({ 'GET /features': jsonResponse(200, { data: features() }) }));
    renderApp(<AppRoutes />, { route: '/inventory/purchase-orders' });
    expect(await screen.findByText(/on Starter and Growth\./, undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See plans' })).toHaveAttribute('href', '/settings/plan');
  });
});

describe('Quick purchase dialog (P88B-13)', () => {
  it('supplier, a line, transport and cash payment → one quick request with an Idempotency-Key', async () => {
    const created = poDetail({ id: 'PO16', number: 'PO-0016', status: 'received', units_received: 9 });
    const fetchMock = signedIn(
      'owner',
      purchasingRoutes({
        'GET /stores/S1/inventory': inventoryList([inventoryItem({ variant_id: 'V1', cost_amount: 100000 })]),
        'POST /stores/S1/purchase-orders/quick': jsonResponse(201, { data: created }),
        'GET /stores/S1/purchase-orders/PO16': jsonResponse(200, { data: created }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/inventory/purchase-orders' });
    await userEvent.click(await screen.findByRole('button', { name: 'Quick purchase' }, SLOW));
    await userEvent.click(screen.getByRole('button', { name: 'Choose supplier' }));
    await userEvent.click(await screen.findByRole('button', { name: /Narsingdi Textiles/ }));
    await userEvent.click(screen.getByRole('button', { name: '+ Add product' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Add Jamdani Three-Piece M / Red' }));
    const pieces = screen.getByLabelText('Pieces of Jamdani Three-Piece');
    await userEvent.clear(pieces);
    await userEvent.type(pieces, '10');
    await userEvent.type(screen.getByLabelText('Damaged pieces of Jamdani Three-Piece'), '1');
    await userEvent.type(screen.getByLabelText('Transport'), '200');
    await userEvent.click(screen.getByRole('button', { name: 'Record purchase' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/purchase-orders/quick', 'POST')).toHaveLength(1));
    const call = byMethod(fetchMock, '/stores/S1/purchase-orders/quick', 'POST')[0]!;
    expect((call[1].headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
    expect(bodyOf(call)).toMatchObject({
      supplier_id: 'SUP2',
      lines: [{ variant_id: 'V1', unit_cost_amount: 100000, quantity: 10, damaged: 1 }],
      shipping_amount: 20000,
      discount_amount: 0,
      payment: { amount: 1020000, method: 'bkash' },
    });
    expect(await screen.findByRole('heading', { level: 1, name: /PO-0016/ }, SLOW)).toBeInTheDocument();
  });
});

describe('New purchase order (§10.3, 35:6210)', () => {
  const routes = () =>
    purchasingRoutes({
      'GET /stores/S1/inventory': inventoryList([inventoryItem({ variant_id: 'V1', cost_amount: 110000, on_hand: 8 }), inventoryItem({ variant_id: 'V7', title: 'Default', product: { id: 'P7', name: 'Silk Saree', status: 'active', image: null }, cost_amount: 260000, on_hand: 0 })]),
      'POST /stores/S1/purchase-orders': jsonResponse(201, { data: poDetail({ id: 'PO15', number: 'PO-0015', status: 'draft', revision: 1 }) }),
      'GET /stores/S1/purchase-orders/PO15': jsonResponse(200, { data: poDetail({ id: 'PO15', number: 'PO-0015', status: 'draft' }) }),
    });

  it('supplier card from ?supplier=, add products, line maths, suggested lines with Last bought, remove, summary, save draft', async () => {
    const fetchMock = signedIn('owner', routes());
    renderApp(<AppRoutes />, { route: '/inventory/purchase-orders/new?supplier=SUP1' });
    expect(await screen.findByRole('heading', { level: 1, name: 'New purchase order' }, SLOW)).toBeInTheDocument();
    const sup = screen.getByRole('region', { name: 'Supplier' });
    expect(await within(sup).findByText('Tangail Weavers', undefined, SLOW)).toBeInTheDocument();
    expect(within(sup).getByText('Delivers in ~5 days')).toBeInTheDocument();
    expect(within(sup).getByText('12 past orders')).toBeInTheDocument();
    expect(within(sup).getByText('You owe ৳ 86,000')).toBeInTheDocument();
    expect(screen.queryByText(/Receive at/)).toBeNull();
    expect(screen.queryByText(/owner approval/)).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: '+ Add product' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Add Jamdani Three-Piece M / Red' }));
    const qty = screen.getByLabelText('Quantity of Jamdani Three-Piece M / Red');
    await userEvent.clear(qty);
    await userEvent.type(qty, '30');
    await userEvent.click(screen.getByRole('button', { name: '+ Add product' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Add Silk Saree' }));
    expect(screen.getByLabelText('Unit cost of Silk Saree')).toHaveValue('2600');
    // suggested line for this supplier carries "Last bought at"
    await userEvent.click(await screen.findByRole('button', { name: 'Add 1 suggested' }));
    expect(screen.getByText('Last bought at ৳ 1,050')).toBeInTheDocument();
    expect(screen.getByText('Items · 3')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Remove Jamdani Red · M' })[0]!);
    expect(screen.getByText('Items · 2')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Transport'), '1200');
    await userEvent.type(screen.getByLabelText('Supplier discount'), '4000');
    // 30 × 1,100 + 1 × 2,600 + 1,200 − 4,000
    const summary = screen.getByRole('region', { name: 'Summary' });
    expect(within(summary).getByTestId('po-total')).toHaveTextContent('৳ 32,800');
    expect(within(summary).getByText('Items (31 units)')).toBeInTheDocument();
    expect(within(summary).getByText('Advance now (50%)')).toBeInTheDocument();
    expect(within(summary).getAllByText('৳ 16,400')).toHaveLength(2); // advance now + on delivery
    expect(within(summary).getByText('bKash')).toBeInTheDocument();
    expect(within(summary).getByRole('note')).toHaveTextContent('Stock value goes up by ৳ 32,800 when received. Cost prices update automatically.');

    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/purchase-orders', 'POST')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/purchase-orders', 'POST')[0]!)).toEqual({
      supplier_id: 'SUP1',
      expected_on: null,
      shipping_amount: 120000,
      discount_amount: 400000,
      notes: null,
      lines: [
        { variant_id: 'V1', unit_cost_amount: 110000, quantity: 30 },
        { variant_id: 'V7', unit_cost_amount: 260000, quantity: 1 },
      ],
    });
    expect(await screen.findByRole('heading', { level: 1, name: /PO-0015/ }, SLOW)).toBeInTheDocument();
  });

  it('validation: supplier and at least one product', async () => {
    const fetchMock = signedIn('owner', routes());
    renderApp(<AppRoutes />, { route: '/inventory/purchase-orders/new' });
    await userEvent.click(await screen.findByRole('button', { name: 'Save draft' }, SLOW));
    expect(await screen.findByText('Choose a supplier.')).toBeInTheDocument();
    expect(screen.getByText('Add at least one product.')).toBeInTheDocument();
    expect(byMethod(fetchMock, '/stores/S1/purchase-orders', 'POST')).toHaveLength(0);
  });

  it('Send to supplier → WhatsApp: creates, sends with sent_via whatsapp and opens wa.me with the PO summary (no Email)', async () => {
    const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const sent = poDetail({ id: 'PO15', number: 'PO-0015', status: 'ordered', revision: 2 });
    const fetchMock = signedIn('owner', { ...routes(), 'POST /stores/S1/purchase-orders/PO15/send': jsonResponse(200, { data: sent }), 'GET /stores/S1/purchase-orders/PO15': jsonResponse(200, { data: sent }) });
    renderApp(<AppRoutes />, { route: '/inventory/purchase-orders/new?supplier=SUP1' });
    await screen.findByText('Delivers in ~5 days', undefined, SLOW);
    await userEvent.click(screen.getByRole('button', { name: '+ Add product' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Add Jamdani Three-Piece M / Red' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send to supplier' }));
    expect(screen.getByRole('menuitem', { name: /PDF/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Email/ })).toBeNull();
    await userEvent.click(screen.getByRole('menuitem', { name: /WhatsApp/ }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/purchase-orders/PO15/send', 'POST')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/purchase-orders/PO15/send', 'POST')[0]!)).toEqual({ sent_via: 'whatsapp', revision: 1 });
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    await waitFor(() => expect(tab.location.href).toMatch(/^https:\/\/wa\.me\/8801711889900\?text=Purchase%20order%20PO-0015/));
    expect(decodeURIComponent(tab.location.href)).toContain('Total: ৳ 1,18,000');
  });
});

describe('PO detail / Receive (§10.3, 36:6607)', () => {
  it('progress, money summary, receive all + damaged, footer totals, receipt body with Idempotency-Key, inventory refreshed', async () => {
    const after = poDetail({ status: 'received', units_received: 98, units_damaged: 2, units_left: 0 });
    const fetchMock = signedIn('owner', purchasingRoutes({ 'POST /stores/S1/purchase-orders/PO12/receipts': jsonResponse(201, { data: after }) }));
    renderApp(<AppRoutes />, { route: '/inventory/purchase-orders/PO12' });
    expect(await screen.findByRole('heading', { level: 1, name: 'PO-0012 · Tangail Weavers' }, SLOW)).toBeInTheDocument();
    const progress = screen.getByRole('region', { name: 'Progress' });
    expect(within(progress).getByText('60 of 100 units received')).toBeInTheDocument();
    expect(within(progress).getByText('40 still coming')).toBeInTheDocument();
    expect(within(progress).getByText('৳ 1,18,000')).toBeInTheDocument();
    expect(within(progress).getByText('৳ 68,000')).toBeInTheDocument();

    const receive = screen.getByRole('region', { name: 'Receive items' });
    expect(within(receive).getAllByText('Fully received')).toHaveLength(1);
    await userEvent.click(within(receive).getByRole('button', { name: 'Receive all remaining' }));
    expect(within(receive).getByLabelText('Receiving now of Jamdani Three-Piece Green · S')).toHaveValue('30');
    const now = within(receive).getByLabelText('Receiving now of Jamdani Three-Piece Green · S');
    await userEvent.clear(now);
    await userEvent.type(now, '28');
    await userEvent.type(within(receive).getByLabelText('Damaged of Jamdani Three-Piece Green · S'), '2');
    expect(within(receive).getByText('Adding 38 units to stock')).toBeInTheDocument();
    expect(within(receive).getByText('Stock value + ৳ 53,000 · cost prices updated · 2 damaged, not added to stock')).toBeInTheDocument();
    // over-receive is caught before the request
    await userEvent.type(within(receive).getByLabelText('Damaged of Katan Saree Emerald'), '1');
    expect(within(receive).getByText('Only 10 left on this line.')).toBeInTheDocument();
    expect(within(receive).getByRole('button', { name: 'Receive 38 units' })).toBeDisabled();
    await userEvent.clear(within(receive).getByLabelText('Damaged of Katan Saree Emerald'));

    // payments card shows the receipt effect
    const pay = screen.getByRole('region', { name: 'Payments to supplier' });
    expect(within(pay).getByText('Owed after this receipt')).toBeInTheDocument();

    await userEvent.click(within(receive).getByRole('button', { name: 'Receive 38 units' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/purchase-orders/PO12/receipts', 'POST')).toHaveLength(1));
    const call = byMethod(fetchMock, '/stores/S1/purchase-orders/PO12/receipts', 'POST')[0]!;
    expect((call[1].headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
    expect(bodyOf(call)).toEqual({
      lines: [
        { item_id: 'L3', received: 28, damaged: 2 },
        { item_id: 'L4', received: 10, damaged: 0 },
      ],
      supplier_invoice_ref: null,
      invoice_media_id: null,
    });
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/purchase-orders/PO12').length).toBeGreaterThan(1));
  });

  it('history without "Approved by", supplier Call/WhatsApp, More menu, documents', async () => {
    signedIn('owner', purchasingRoutes());
    renderApp(<AppRoutes />, { route: '/inventory/purchase-orders/PO12' });
    await screen.findByRole('heading', { level: 1, name: /PO-0012/ }, SLOW);
    const history = screen.getByRole('region', { name: 'History' });
    expect(within(history).getByText('Created by Rahim')).toBeInTheDocument();
    expect(within(history).getByText('Sent to supplier on WhatsApp')).toBeInTheDocument();
    expect(within(history).getByText('Received 60 units · Sumi')).toBeInTheDocument();
    expect(screen.queryByText(/Approved by/)).toBeNull();
    const sup = screen.getByRole('region', { name: 'Supplier' });
    expect(within(sup).getByRole('link', { name: /Call/ })).toHaveAttribute('href', 'tel:+8801711889900');
    expect(within(sup).getByRole('link', { name: /WhatsApp/ })).toHaveAttribute('href', 'https://wa.me/8801711889900');
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: /Close/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Edit/ })).toBeNull(); // only draft / ordered can change
    expect(screen.queryByRole('menuitem', { name: /Cancel order/ })).toBeNull(); // something was received
    expect(screen.queryByRole('menuitem', { name: /Delete draft/ })).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Documents' })).getByText('PO-0012.pdf')).toBeInTheDocument();
  });

  it('close asks first and posts with the revision', async () => {
    const fetchMock = signedIn('owner', purchasingRoutes({ 'POST /stores/S1/purchase-orders/PO12/close': jsonResponse(200, { data: poDetail({ status: 'closed' }) }) }));
    renderApp(<AppRoutes />, { route: '/inventory/purchase-orders/PO12' });
    await userEvent.click(await screen.findByRole('button', { name: 'More actions' }, SLOW));
    await userEvent.click(screen.getByRole('menuitem', { name: /Close/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Close order' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/purchase-orders/PO12/close', 'POST')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/purchase-orders/PO12/close', 'POST')[0]!)).toEqual({ revision: 3 });
  });

  it('Record payment dialog posts to the supplier with the PO', async () => {
    const fetchMock = signedIn(
      'owner',
      purchasingRoutes({
        'POST /stores/S1/suppliers/SUP1/payments': jsonResponse(201, {
          data: { id: 'PAY2', supplier: { id: 'SUP1', name: 'Tangail Weavers' }, purchase_order: { id: 'PO12', number: 'PO-0012' }, amount: 2000000, currency: 'BDT', method: 'bkash', paid_on: '2026-11-24', reference: null, note: null, created_by: null, created_at: '' },
        }),
      }),
    );
    renderApp(<AppRoutes />, { route: '/inventory/purchase-orders/PO12' });
    await screen.findByRole('heading', { level: 1, name: /PO-0012/ }, SLOW);
    await userEvent.click(screen.getAllByRole('button', { name: 'Record payment' })[0]!);
    const amount = screen.getByLabelText('Amount');
    expect(amount).toHaveValue('68000'); // due prefilled
    await userEvent.clear(amount);
    await userEvent.type(amount, '20000');
    await userEvent.type(screen.getByLabelText('Note (optional)'), 'TrxID 8N7');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/suppliers/SUP1/payments', 'POST')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/suppliers/SUP1/payments', 'POST')[0]!)).toMatchObject({ amount: 2000000, method: 'bkash', purchase_order_id: 'PO12', note: 'TrxID 8N7' });
  });

  it('adjust-only receiver: quantities only — no ৳, no Total/Paid/Due, no Record payment, can still receive', async () => {
    const fetchMock = signedIn(adjustOnlyRole, purchasingRoutes({ 'GET /stores/S1/purchase-orders/PO12': jsonResponse(200, { data: adjustOnly(poDetail()) }), 'POST /stores/S1/purchase-orders/PO12/receipts': jsonResponse(201, { data: adjustOnly(poDetail()) }) }));
    renderApp(<AppRoutes />, { route: '/inventory/purchase-orders/PO12' });
    await screen.findByRole('heading', { level: 1, name: /PO-0012/ }, SLOW);
    expect(screen.queryByRole('button', { name: 'Record payment' })).toBeNull();
    expect(screen.queryByText('Due')).toBeNull();
    expect(screen.queryByText('Paid')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Payments to supplier' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
    const receive = screen.getByRole('region', { name: 'Receive items' });
    await userEvent.type(within(receive).getByLabelText('Receiving now of Katan Saree Emerald'), '4');
    expect(within(receive).getByText('Adding 4 units to stock')).toBeInTheDocument();
    noMoney();
    await userEvent.click(within(receive).getByRole('button', { name: 'Receive 4 units' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/purchase-orders/PO12/receipts', 'POST')).toHaveLength(1));
  });

  it('receive table stacks per line (one DOM; md: columns)', async () => {
    signedIn('owner', purchasingRoutes());
    renderApp(<AppRoutes />, { route: '/inventory/purchase-orders/PO12' });
    const table = await screen.findByRole('table', { name: 'Purchase order items' }, SLOW);
    const rows = within(table).getAllByRole('row').filter((r) => r.getAttribute('aria-label'));
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveClass('flex-col', 'md:flex-row');
  });
});

describe('Suppliers (§10.4, 153:35999)', () => {
  it('KPIs incl. Bought this month (no comparison), table, panel with owed banner, recent POs, import link', async () => {
    signedIn('owner', purchasingRoutes());
    renderApp(<AppRoutes />, { route: '/inventory/suppliers' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Suppliers' }, SLOW)).toBeInTheDocument();
    const kpis = await screen.findByRole('region', { name: 'Supplier summary' });
    expect(within(kpis).getByText('5 active this month')).toBeInTheDocument();
    expect(within(kpis).getByText('৳ 1,42,500')).toBeInTheDocument();
    expect(within(kpis).getByText('3 suppliers · 1 overdue')).toBeInTheDocument();
    expect(within(kpis).getByText('3 POs')).toBeInTheDocument();
    expect(within(kpis).getByText('Bought this month')).toBeInTheDocument();
    expect(within(kpis).getByText('৳ 3,86,000')).toBeInTheDocument();
    expect(screen.queryByText(/last month/)).toBeNull();
    const table = screen.getByRole('table', { name: 'Suppliers' });
    expect(within(table).getByText('৳ 86,000')).toHaveClass('text-danger');
    expect(within(table).getByText('৳ 38,500')).not.toHaveClass('text-danger');
    expect(within(table).getByText('Jamdani, saree · Tangail')).toBeInTheDocument();
    const panel = await screen.findByRole('region', { name: 'Supplier details' });
    expect(within(panel).getByText('You owe ৳ 86,000')).toBeInTheDocument();
    expect(within(panel).getByText('৳ 40,000 overdue since 15 Nov · terms: 15 days')).toBeInTheDocument();
    expect(within(panel).getByText('15 days after delivery')).toBeInTheDocument();
    expect(within(panel).getByText('bKash · 01712-889900')).toBeInTheDocument();
    expect(within(panel).getByText('5 days')).toBeInTheDocument();
    expect(within(panel).getByText('PO-0042 · arriving 22 Nov')).toBeInTheDocument();
    expect(within(panel).getByText('On the way')).toBeInTheDocument();
    expect(within(panel).getByText('Unpaid')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'New PO' })).toHaveAttribute('href', '/inventory/purchase-orders/new?supplier=SUP1');
    expect(screen.getByRole('link', { name: 'Import' })).toHaveAttribute('href', '/products/import?type=suppliers');
  });

  it('add supplier dialog validates and posts normalised fields', async () => {
    const fetchMock = signedIn('owner', purchasingRoutes({ 'POST /stores/S1/suppliers': jsonResponse(201, { data: supplier({ id: 'SUP9', name: 'Islampur Hijab House' }) }) }));
    renderApp(<AppRoutes />, { route: '/inventory/suppliers' });
    await userEvent.click(await screen.findByRole('button', { name: '+ Add supplier' }, SLOW));
    await userEvent.type(screen.getByLabelText('Phone (optional)'), '12345');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add supplier' }));
    expect(await screen.findByText('Enter the supplier’s name.')).toBeInTheDocument();
    expect(screen.getByText('Enter a Bangladeshi mobile number like 01711-889900.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Supplier name'), 'Islampur Hijab House');
    await userEvent.clear(screen.getByLabelText('Phone (optional)'));
    await userEvent.type(screen.getByLabelText('Phone (optional)'), '01812-334455');
    await userEvent.type(screen.getByLabelText('Lead time (days)'), '3');
    await userEvent.selectOptions(screen.getByLabelText('Pay by'), 'cash');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add supplier' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/suppliers', 'POST')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/suppliers', 'POST')[0]!)).toEqual({
      name: 'Islampur Hijab House',
      contact_name: null,
      phone: '8801812334455',
      city: null,
      supplies: null,
      payment_terms_days: null,
      advance_percent: null,
      lead_time_days: 3,
      pays_by_method: 'cash',
      pays_by_account: null,
      notes: null,
    });
  });

  it('archive from the panel menu', async () => {
    const fetchMock = signedIn('owner', purchasingRoutes({ 'POST /stores/S1/suppliers/SUP1/archive': jsonResponse(200, { data: supplier({ archived_at: '2026-11-24T00:00:00Z' }) }) }));
    renderApp(<AppRoutes />, { route: '/inventory/suppliers?supplier=SUP1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for Tangail Weavers' }, SLOW));
    await userEvent.click(screen.getByRole('menuitem', { name: /Archive/ }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/suppliers/SUP1/archive', 'POST')).toHaveLength(1));
  });

  it('search sends q and the empty state copy', async () => {
    const fetchMock = signedIn('owner', purchasingRoutes({ 'GET /stores/S1/suppliers': jsonResponse(200, { data: [], meta: { current_page: 1, per_page: 50, total: 0, last_page: 1, counts: { active: 0, archived: 0 } } }) }));
    renderApp(<AppRoutes />, { route: '/inventory/suppliers' });
    expect(await screen.findByText('No suppliers yet', undefined, SLOW)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Search suppliers'), 'Tangail');
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/suppliers').some((c) => new URL(c[0], 'http://x').searchParams.get('q') === 'Tangail')).toBe(true));
  });

  it('supplier import page uses supplier copy', async () => {
    signedIn('owner', purchasingRoutes());
    renderApp(<AppRoutes />, { route: '/products/import?type=suppliers' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Import suppliers from CSV' }, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Suppliers' })).toHaveAttribute('href', '/inventory/suppliers');
  });
});

describe('Inventory additions (§10.1)', () => {
  const movement = (o: Partial<StockMovement> = {}): StockMovement => ({
    id: 'MV1',
    variant_id: 'V1',
    product: { id: 'P1', name: 'Jamdani Three-Piece' },
    variant_title: 'M / Red',
    sku: null,
    delta: 38,
    on_hand_after: 46,
    reason: 'received',
    note: 'PO-0012 · Tangail Weavers',
    reference: { type: 'purchase_order', id: 'PO12' },
    actor: { id: 'U2', name: 'Sumi Akter' },
    created_at: '2026-11-15T10:20:00Z',
    ...o,
  });

  it('Incoming column, "Purchase order" header button, reorder card, "Received · PO-0012" in latest changes', async () => {
    signedIn('owner', purchasingRoutes({ 'GET /stores/S1/inventory': inventoryList([inventoryItem({ incoming: 40 }), inventoryItem({ variant_id: 'V2', title: 'L / Blue', incoming: 0 })]), 'GET /stores/S1/inventory/movements': jsonResponse(200, { data: [movement()], meta: { current_page: 1, per_page: 6, total: 1, last_page: 1 } }) }));
    renderApp(<AppRoutes />, { route: '/inventory' });
    const table = await screen.findByRole('table', { name: 'Stock levels' }, SLOW);
    expect(within(table).getByText('Incoming')).toBeInTheDocument();
    expect(await within(table).findByText('+40', undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Purchase order' })).toHaveAttribute('href', '/inventory/purchase-orders/new');
    expect(screen.queryByText('Transfer stock')).toBeNull();
    expect(await screen.findByText('Received · PO-0012 · Jamdani Three-Piece')).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Reorder suggestions' })).toBeInTheDocument();
    const tabs = screen.getByRole('tablist', { name: 'Inventory' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Stock levels', 'Stock movements', 'Purchase orders', 'Suppliers']);
  });

  it('Stock movements: PO reference links to the purchase order', async () => {
    signedIn('owner', purchasingRoutes({ 'GET /stores/S1/inventory': inventoryList([inventoryItem()]), 'GET /stores/S1/inventory/movements': jsonResponse(200, { data: [movement()], meta: { current_page: 1, per_page: 25, total: 1, last_page: 1 } }) }));
    renderApp(<AppRoutes />, { route: '/inventory?tab=movements' });
    const link = await screen.findByRole('link', { name: 'Received · PO-0012' }, SLOW);
    expect(link).toHaveAttribute('href', '/inventory/purchase-orders/PO12');
  });

  it('staff (inventory.adjust only): Purchase orders tab but no Suppliers tab, no Purchase order button, no suggestions call', async () => {
    const fetchMock = signedIn('staff', purchasingRoutes({ 'GET /stores/S1/inventory': inventoryList([inventoryItem({ cost_amount: null })]), 'GET /stores/S1/inventory/movements': jsonResponse(200, { data: [] }) }));
    renderApp(<AppRoutes />, { route: '/inventory' });
    const tabs = await screen.findByRole('tablist', { name: 'Inventory' }, SLOW);
    expect(within(tabs).getByRole('tab', { name: 'Purchase orders' })).toBeInTheDocument();
    expect(within(tabs).queryByRole('tab', { name: 'Suppliers' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Purchase order' })).toBeNull();
    expect(callsTo(fetchMock, '/stores/S1/purchasing/reorder-suggestions')).toHaveLength(0);
  });
});

