import { ApiError } from '@storeplix/api-client';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { visibleNav } from '../layout/nav';
import { can } from '../lib/permissions';
import { outOfStockLines, alreadyOpenSession, closeNoteDetails } from '../pos/errors';
import {
  addToCart,
  bankedAmount,
  buildTender,
  changeBreakdown,
  countsTotal,
  createAttemptKeys,
  denominationsFor,
  numpadNext,
  openingHint,
  optionGroups,
  parseCount,
  posLocked,
  quickCash,
  setQuantity,
  smsView,
  splitRemaining,
  stockCaption,
  textsToCounts,
  varianceView,
  variantFor,
  vatLabel,
  type TenderState,
} from '../pos/pos';
import { callsTo, jsonResponse, renderApp, signedIn } from '../test/utils';
import { catalogResponse, growthPos, hijab, jamdani, panjabi, quote, receipt, register, sale, session, starterNoPos } from './phase8-8d-a.fixtures';
import { locationsResponse, mainWarehouse, dhanmondi } from './phase8-8c-a.fixtures';

// PHASE-8-8D §14 Web part A: register picker + add register; open register counts → total; sale screen (catalog, chips,
// search vs scan, out-of-stock tile, variant picker, cart qty/clear, customer lookup, totals from quote); payment
// (quick cash, change + breakdown, split remaining, reference fields, disabled offline); idempotency key reused on
// retry and replaced after success; sale complete + receipt render + print; close maths, tolerance, note rule,
// leave/banked; plan note; permission gating.

vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
  vi.stubGlobal('print', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const bodyOf = (call: [string, RequestInit]) => JSON.parse(String(call[1].body));
const headerOf = (call: [string, RequestInit], name: string) => new Headers(call[1].headers).get(name);
const posts = (fetchMock: Parameters<typeof callsTo>[0], path: string) => callsTo(fetchMock, path).filter((c) => c[1].method === 'POST');
const cash = (over: Partial<TenderState> = {}): TenderState => ({ mode: 'cash', cashReceived: null, reference: '', parts: [], ...over });

describe('PHASE-8-8D money helpers (integer minor units)', () => {
  it('denominations, counts and totals', () => {
    const rows = denominationsFor('BDT')!;
    expect(rows.map((r) => r.value)).toEqual([100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100]);
    expect(rows.find((r) => r.value === 500)!.kind).toBe('Coin');
    expect(rows.find((r) => r.value === 1000)!.kind).toBe('Note');
    expect(denominationsFor('USD')).toBeNull();
    expect(countsTotal({ '100000': 14, '50000': 1, '10000': 3 })).toBe(1480000);
    expect(countsTotal({ '100000': 9, '50000': 6, '20000': 4, '10000': 8, '5000': 3, '2000': 6, '1000': 4 })).toBe(1391000);
    expect(parseCount('')).toBe(0);
    expect(parseCount('12')).toBe(12);
    expect(parseCount('1.5')).toBeNull();
    expect(parseCount('10001')).toBeNull();
    expect(textsToCounts('BDT', { '100000': '1', '50000': '', '2000': '5' })).toEqual({ '100000': 1, '2000': 5 });
    expect(textsToCounts('BDT', { '100000': 'x' })).toBeNull();
  });

  it('quick cash chips and change breakdown', () => {
    expect(quickCash(456000)).toEqual([500000, 600000, 1000000]);
    expect(quickCash(45000)).toEqual([50000, 100000, 500000]);
    expect(quickCash(500000, 2)).toEqual([550000, 600000]);
    expect(changeBreakdown(44000)).toBe('2 × 200, 2 × 20');
    expect(changeBreakdown(188800)).toBe('1 × 1,000, 1 × 500, 1 × 200, 1 × 100, 1 × 50, 1 × 20, 1 × 10, 1 × 5, 1 × 2, 1 × 1');
    expect(changeBreakdown(0)).toBe('');
  });

  it('cash, bKash, card tenders', () => {
    expect(buildTender(456000, cash({ cashReceived: 500000 }))).toEqual({ ok: true, payments: [{ method: 'cash', amount: 456000 }], tendered: 500000, change: 44000 });
    expect(buildTender(456000, cash({ cashReceived: 400000 }))).toMatchObject({ ok: false, error: 'Cash received is ৳ 560 short.' });
    expect(buildTender(456000, cash({ cashReceived: Number.NaN }))).toMatchObject({ ok: false });
    expect(buildTender(456000, cash({ mode: 'bkash_personal', reference: ' 9AB3XZ ' }))).toEqual({
      ok: true,
      payments: [{ method: 'bkash_personal', amount: 456000, reference: '9AB3XZ' }],
      tendered: null,
      change: 0,
    });
    expect(buildTender(456000, cash({ mode: 'card', reference: '' }))).toMatchObject({ ok: true, payments: [{ method: 'card', amount: 456000, reference: null }] });
  });

  it('split validation: Σ = total, each > 0, 2–4 parts, one cash part', () => {
    const split = (parts: TenderState['parts']) => buildTender(456000, cash({ mode: 'split', parts }));
    const p = (method: 'cash' | 'bkash_personal' | 'card', amount: number | null, reference = '') => ({ method, amount, reference });
    expect(split([p('cash', 256000), p('bkash_personal', 200000, 'TRX1')])).toEqual({
      ok: true,
      payments: [
        { method: 'cash', amount: 256000, reference: null },
        { method: 'bkash_personal', amount: 200000, reference: 'TRX1' },
      ],
      tendered: 256000,
      change: 0,
    });
    expect(split([p('cash', 256000), p('card', 100000)])).toMatchObject({ ok: false, error: '৳ 1,000 still to pay.' });
    expect(split([p('cash', 356000), p('card', 200000)])).toMatchObject({ ok: false, error: 'Parts are ৳ 1,000 more than the total.' });
    expect(split([p('cash', 456000), p('card', 0)])).toMatchObject({ ok: false });
    expect(split([p('cash', 456000), p('card', null)])).toMatchObject({ ok: false });
    expect(split([p('cash', 200000), p('cash', 256000)])).toMatchObject({ ok: false, error: 'Use one cash part only.' });
    expect(split([p('cash', 456000)])).toMatchObject({ ok: false });
    expect(split([p('cash', 1), p('card', 1), p('card', 1), p('card', 1), p('card', 455996)])).toMatchObject({ ok: false });
    expect(splitRemaining(456000, [p('cash', 256000), p('card', null)])).toBe(200000);
  });

  it('close register variance, tolerance note rule, banked / left', () => {
    expect(varianceView(1480000, 1482000, 5000)).toMatchObject({ variance: -2000, label: 'Short by ৳ 20', tone: 'warning', noteRequired: false });
    expect(varianceView(1482000, 1482000, 5000)).toMatchObject({ variance: 0, label: 'Drawer matches', tone: 'success', noteRequired: false });
    expect(varianceView(1490000, 1482000, 5000)).toMatchObject({ variance: 8000, label: 'Over by ৳ 80', tone: 'danger', noteRequired: true });
    expect(varianceView(1477000, 1482000, 5000).noteRequired).toBe(false);
    expect(varianceView(1476900, 1482000, 5000).noteRequired).toBe(true);
    expect(varianceView(1490000, 1482000, 5000).hint).toBe('Over your ৳ 50 tolerance — add a note to close.');
    expect(bankedAmount(1480000, 200000)).toBe(1280000);
    expect(bankedAmount(1480000, 1480000)).toBe(0);
    expect(bankedAmount(1480000, 1480001)).toBeNull();
    expect(bankedAmount(1480000, -1)).toBeNull();
    expect(openingHint(200000, 200000, '2026-11-18T14:00:00Z')).toEqual({ text: 'Matches last closing (৳ 2,000 left on 18 Nov)', tone: 'muted' });
    expect(openingHint(150000, 200000, null)).toEqual({ text: 'Last closing left ৳ 2,000', tone: 'warning' });
    expect(openingHint(150000, null, null)).toBeNull();
  });

  it('cart: add, bump, stock and line limits, quantity', () => {
    const item = jamdani();
    let r = addToCart([], item, item.variants[0]!, 2);
    expect(r.error).toBeNull();
    expect(r.lines[0]).toMatchObject({ variantId: 'V1', quantity: 2, unitPrice: 165000, variantTitle: 'Red · M' });
    r = addToCart(r.lines, item, item.variants[0]!, 7);
    expect(r.error).toBe('Only 8 left of Jamdani Three-Piece.');
    r = addToCart(r.lines, item, item.variants[1]!);
    expect(r.error).toBe('Jamdani Three-Piece is out of stock here.');
    const lines = addToCart([], panjabi(), panjabi().variants[0]!).lines;
    expect(lines[0]!.variantTitle).toBe('');
    expect(setQuantity(lines, 'V9', 0)).toEqual([]);
    expect(setQuantity(lines, 'V9', 99)[0]!.quantity).toBe(43);
    expect(stockCaption(jamdani())).toEqual({ text: '10 in stock', tone: 'muted' });
    expect(stockCaption(hijab())).toEqual({ text: 'Out of stock', tone: 'danger' });
    expect(stockCaption({ ...panjabi(), variants: [{ ...panjabi().variants[0]!, available: 3 }] }).tone).toBe('warning');
  });

  it('variant picker option groups', () => {
    const item = jamdani();
    expect(optionGroups(item)).toEqual([
      { name: 'Colour', values: ['Red', 'Blue'] },
      { name: 'Size', values: ['M', 'L'] },
    ]);
    expect(variantFor(item, { Colour: 'Red', Size: 'M' }, 'Size', 'L')!.id).toBe('V2');
    expect(variantFor(item, { Colour: 'Blue', Size: 'M' }, 'Size', 'L')).toBeNull();
  });

  it('idempotency: same attempt reuses the key, a new payload or a success mints a new one', () => {
    let n = 0;
    const keys = createAttemptKeys(() => `k${++n}`);
    expect(keys.keyFor('a')).toBe('k1');
    expect(keys.keyFor('a')).toBe('k1');
    expect(keys.keyFor('b')).toBe('k2');
    keys.reset();
    expect(keys.keyFor('b')).toBe('k3');
  });

  it('misc: numpad, SMS row, VAT label, plan lock, error details', () => {
    expect(numpadNext('45', '00')).toBe('4500');
    expect(numpadNext('0', '5')).toBe('5');
    expect(numpadNext('4500', 'back')).toBe('450');
    expect(numpadNext('12345678', '9')).toBe('12345678');
    expect(smsView('sent', '8801711552211', false)).toEqual({ text: 'SMS receipt sent to 01711-552211', tone: 'success', action: 'Resend' });
    expect(smsView('failed', '8801711552211', false).tone).toBe('danger');
    expect(smsView('not_requested', null, false).action).toBeNull();
    expect(vatLabel('en', { rate_bps: 500 })).toBe('VAT 5% (included)');
    expect(vatLabel('en', null)).toBeNull();
    expect(posLocked(starterNoPos())).toBe(true);
    expect(posLocked(growthPos())).toBe(false);
    expect(posLocked(undefined)).toBe(false);
    expect(alreadyOpenSession(new ApiError(409, 'register_already_open', 'x', { session_id: 'PS9' } as never))).toBe('PS9');
    expect(closeNoteDetails(new ApiError(422, 'close_note_required', 'x', { variance_amount: -8000, tolerance_amount: 5000 } as never))).toEqual({ variance_amount: -8000, tolerance_amount: 5000 });
    expect(outOfStockLines(new ApiError(422, 'out_of_stock', 'x', { 'lines.1.quantity': ['Only 2 left at Mirpur shop.'] }))).toEqual({ 1: 'Only 2 left at Mirpur shop.' });
  });
});

describe('PHASE-8-8D gating', () => {
  it('pos.sell: staff sees POS, a custom role without it does not', () => {
    expect(can.sellPos({ role: 'staff' })).toBe(true);
    expect(visibleNav({ role: 'custom', permissions: ['orders.view'] }).some((n) => n.to === '/pos')).toBe(false);
    expect(visibleNav({ role: 'staff' }).some((n) => n.to === '/pos')).toBe(true);
  });

  it('/pos without pos.sell shows the no-access page', async () => {
    signedIn({ role: 'custom', permissions: ['orders.view'] }, { 'GET /features': jsonResponse(200, { data: growthPos() }) });
    renderApp(<AppRoutes />, { route: '/pos' });
    expect(await screen.findByText('You don’t have access to this page')).toBeInTheDocument();
  });

  it('Starter shows the plan note (and lets an open register be closed)', async () => {
    signedIn('owner', {
      'GET /features': jsonResponse(200, { data: starterNoPos() }),
      'GET /stores/S1/pos/registers': jsonResponse(200, { data: [register({ open_session: { id: 'PS1', opened_at: '2026-11-25T04:02:00Z', opened_by: { id: 'U1', name: 'Rahim' } } })] }),
    });
    renderApp(<AppRoutes />, { route: '/pos' });
    expect(await screen.findByTestId('pos-plan-note')).toHaveTextContent('POS is on the Growth plan');
    expect(screen.getByRole('link', { name: 'See plans' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close register' })).toBeInTheDocument();
    expect(screen.queryByTestId('pos-open-submit')).not.toBeInTheDocument();
  });
});

describe('PHASE-8-8D open register', () => {
  it('no registers → create Register 1 at the default location', async () => {
    const fetchMock = signedIn('owner', {
      'GET /features': jsonResponse(200, { data: growthPos() }),
      'GET /stores/S1/pos/registers': jsonResponse(200, { data: [] }),
      'GET /stores/S1/locations': locationsResponse([mainWarehouse, dhanmondi]),
      'POST /stores/S1/pos/registers': jsonResponse(201, { data: register() }),
    });
    renderApp(<AppRoutes />, { route: '/pos' });
    const button = await screen.findByRole('button', { name: 'Create Register 1 at Main warehouse' });
    await userEvent.click(button);
    await waitFor(() => expect(posts(fetchMock, '/stores/S1/pos/registers')).toHaveLength(1));
    expect(bodyOf(posts(fetchMock, '/stores/S1/pos/registers')[0]!)).toEqual({ name: 'Register 1', location_id: 'LOC1' });
  });

  it('counts → total, last-closing hint, open sends counts with an Idempotency-Key and goes to the sale', async () => {
    const fetchMock = signedIn('owner', {
      'GET /features': jsonResponse(200, { data: growthPos() }),
      'GET /stores/S1/pos/registers': jsonResponse(200, {
        data: [register(), register({ id: 'R2', name: 'Register 2', last_session: null, open_session: { id: 'PS7', opened_at: '2026-11-25T04:05:00Z', opened_by: { id: 'U2', name: 'Sumi' } } })],
      }),
      'POST /stores/S1/pos/registers/R1/open': jsonResponse(201, { data: session() }),
      'GET /stores/S1/pos/sessions/PS1': jsonResponse(200, { data: session() }),
      'GET /stores/S1/pos/catalog': catalogResponse([panjabi()]),
      'GET /stores/S1/categories': jsonResponse(200, { data: [] }),
    });
    renderApp(<AppRoutes />, { route: '/pos' });
    // Prefilled from the last "left in drawer" (৳ 2,000 → 2 × 1,000).
    expect(await screen.findByTestId('pos-opening-total')).toHaveTextContent('৳ 2,000');
    expect(screen.getByText('Matches last closing (৳ 2,000 left on 18 Nov)')).toBeInTheDocument();
    expect(screen.getByTestId('pos-cashier')).toHaveValue('Rahim Ahmed');
    expect(screen.getByTestId('pos-cashier')).toHaveAttribute('readonly');
    expect(within(screen.getByTestId('pos-register-list')).getByText('Open · Sumi · since', { exact: false })).toBeInTheDocument();
    expect(screen.getByTestId('pos-last-session')).toHaveTextContent('৳ 24,380 · 17 receipts');

    fireEvent.change(screen.getByLabelText('Count of ৳ 500'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Count of ৳ 20'), { target: { value: '5' } });
    expect(screen.getByTestId('pos-opening-total')).toHaveTextContent('৳ 2,600');
    expect(screen.getByText('Last closing left ৳ 2,000')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Count of ৳ 20'), { target: { value: 'x' } });
    expect(screen.getByTestId('pos-open-submit')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Count of ৳ 20'), { target: { value: '5' } });

    await userEvent.click(screen.getByTestId('pos-open-submit'));
    await waitFor(() => expect(posts(fetchMock, '/stores/S1/pos/registers/R1/open')).toHaveLength(1));
    const call = posts(fetchMock, '/stores/S1/pos/registers/R1/open')[0]!;
    expect(bodyOf(call)).toEqual({ counts: { '100000': 2, '50000': 1, '2000': 5 } });
    expect(headerOf(call, 'Idempotency-Key')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('pos-bar-subtitle')).toHaveTextContent('Register 1 · Mirpur shop · Opened'));
  });

  it('add register dialog (settings.manage) validates and creates', async () => {
    const fetchMock = signedIn('owner', {
      'GET /features': jsonResponse(200, { data: growthPos() }),
      'GET /stores/S1/pos/registers': jsonResponse(200, { data: [register()] }),
      'GET /stores/S1/locations': locationsResponse([mainWarehouse, dhanmondi]),
      'POST /stores/S1/pos/registers': jsonResponse(201, { data: register({ id: 'R3', name: 'Register 2', location: { id: 'LOC2', name: 'Dhanmondi shop', type: 'shop' } }) }),
    });
    renderApp(<AppRoutes />, { route: '/pos' });
    await userEvent.click(await screen.findByRole('button', { name: /Add register/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add register' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add register' }));
    expect(await within(dialog).findByText('Name the register')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Register 2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add register' }));
    await waitFor(() => expect(posts(fetchMock, '/stores/S1/pos/registers')).toHaveLength(1));
    // Shops are listed first and preselected.
    expect(bodyOf(posts(fetchMock, '/stores/S1/pos/registers')[0]!)).toEqual({ name: 'Register 2', location_id: 'LOC2' });
  });

  it('staff (no settings.manage) cannot add registers', async () => {
    signedIn('staff', {
      'GET /features': jsonResponse(200, { data: growthPos() }),
      'GET /stores/S1/pos/registers': jsonResponse(200, { data: [register()] }),
    });
    renderApp(<AppRoutes />, { route: '/pos' });
    expect(await screen.findByTestId('pos-open-submit')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add register/ })).not.toBeInTheDocument();
  });
});

function saleRoutes(extra: Record<string, Response | ((init: RequestInit, h: Record<string, string>) => Response)> = {}) {
  return {
    'GET /features': jsonResponse(200, { data: growthPos() }),
    'GET /stores/S1/pos/sessions/PS1': jsonResponse(200, { data: session() }),
    'GET /stores/S1/pos/catalog': catalogResponse([jamdani(), panjabi(), hijab()], 'c2'),
    'GET /stores/S1/categories': jsonResponse(200, { data: [{ id: 'C1', name: 'Panjabi' }] }),
    'POST /stores/S1/pos/quote': (init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { lines: { variant_id: string; quantity: number }[]; coupon_code?: string | null };
      const qty = body.lines.reduce((s, l) => s + l.quantity, 0);
      const discount = body.coupon_code === 'LOYAL5' ? 7500 : 0;
      return jsonResponse(200, {
        data: quote({
          lines: body.lines.map((l) => ({ variant_id: l.variant_id, name: 'x', variant_title: '', quantity: l.quantity, unit_price_amount: 150000, compare_at_amount: null, line_total_amount: 150000 * l.quantity, available: 43, problem: null })),
          items_count: qty,
          subtotal_amount: 150000 * qty,
          discount_amount: discount,
          coupon_code: body.coupon_code ?? null,
          total_amount: 150000 * qty - discount,
        }),
      });
    },
    ...extra,
  };
}

async function addPanjabi() {
  await userEvent.click(await screen.findByRole('button', { name: /^Cotton Panjabi/ }));
  await waitFor(() => expect(screen.getByTestId('pos-charge')).toBeEnabled());
}

describe('PHASE-8-8D sale screen', () => {
  it('POS bar, catalog tiles, out-of-stock tile, load more, Scanner ready hidden', async () => {
    signedIn('owner', saleRoutes());
    renderApp(<AppRoutes />, { route: '/pos/PS1' });
    await waitFor(() => expect(screen.getByTestId('pos-bar-subtitle')).toHaveTextContent('Register 1 · Mirpur shop · Opened'));
    expect(screen.getByTestId('pos-cash-in-drawer')).toHaveTextContent('৳ 14,820');
    expect(screen.getByTestId('pos-online-pill')).toHaveTextContent('Online');
    expect(await screen.findByRole('button', { name: /^Georgette Hijab/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Jamdani Three-Piece/ })).toHaveTextContent('10 in stock');
    expect(screen.getByRole('button', { name: 'Load more products' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Panjabi' })).toBeInTheDocument();
    expect(screen.queryByText('Scanner ready')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hold sale' })).not.toBeInTheDocument();
    expect(screen.getByTestId('pos-charge')).toBeDisabled();
  });

  it('category chip and search filter the catalog; Enter scans an exact code into the cart', async () => {
    const fetchMock = signedIn('owner', saleRoutes({ 'GET /stores/S1/pos/lookup': jsonResponse(200, { data: panjabi() }) }));
    renderApp(<AppRoutes />, { route: '/pos/PS1' });
    await userEvent.click(await screen.findByRole('tab', { name: 'Panjabi' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/pos/catalog').some((c) => new URL(c[0], 'http://x').searchParams.get('filter[category_id]') === 'C1')).toBe(true));
    await userEvent.type(screen.getByTestId('pos-search'), 'CP-1{Enter}');
    await waitFor(() => expect(screen.getAllByTestId('pos-cart-line')).toHaveLength(1));
    expect(new URL(callsTo(fetchMock, '/stores/S1/pos/lookup')[0]![0], 'http://x').searchParams.get('code')).toBe('CP-1');
    expect(screen.getByTestId('pos-search')).toHaveValue('');
  });

  it('variant picker adds the chosen option; cart quantity and clear', async () => {
    signedIn('owner', saleRoutes());
    renderApp(<AppRoutes />, { route: '/pos/PS1' });
    await userEvent.click(await screen.findByRole('button', { name: /^Jamdani Three-Piece/ }));
    const picker = await screen.findByTestId('pos-variant-picker');
    expect(within(picker).getByRole('button', { name: /L\s*Out/ })).toBeDisabled();
    await userEvent.click(within(picker).getByRole('button', { name: 'Blue' }));
    expect(within(picker).getByText('Blue · M · 2 in this shop')).toBeInTheDocument();
    await userEvent.click(within(picker).getByRole('button', { name: 'Increase quantity' }));
    expect(within(picker).getByRole('button', { name: 'Increase quantity' })).toBeDisabled();
    await userEvent.click(within(picker).getByTestId('pos-picker-add'));
    const line = await screen.findByTestId('pos-cart-line');
    expect(line).toHaveTextContent('Blue · M');
    expect(within(line).getByTestId('pos-line-qty')).toHaveTextContent('2');
    expect(within(line).getByRole('button', { name: 'Increase Jamdani Three-Piece' })).toBeDisabled();
    await userEvent.click(within(line).getByRole('button', { name: 'Decrease Jamdani Three-Piece' }));
    expect(within(line).getByTestId('pos-line-qty')).toHaveTextContent('1');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByTestId('pos-cart-line')).not.toBeInTheDocument();
  });

  it('totals come from the quote; coupon re-prices', async () => {
    const fetchMock = signedIn('owner', saleRoutes());
    renderApp(<AppRoutes />, { route: '/pos/PS1' });
    await addPanjabi();
    expect(screen.getByTestId('pos-total')).toHaveTextContent('৳ 1,500');
    await userEvent.click(screen.getByRole('button', { name: 'Add coupon' }));
    await userEvent.type(screen.getByLabelText('Coupon code'), 'loyal5{Enter}');
    await waitFor(() => expect(screen.getByTestId('pos-total')).toHaveTextContent('৳ 1,425'));
    expect(screen.getByTestId('pos-totals')).toHaveTextContent('Discount · LOYAL5');
    expect(posts(fetchMock, '/stores/S1/pos/quote').some((c) => bodyOf(c).coupon_code === 'LOYAL5')).toBe(true);
  });

  it('customer lookup: known card, unknown → new customer name', async () => {
    signedIn('owner', {
      ...saleRoutes(),
      'GET /stores/S1/pos/customers/lookup': (init: RequestInit) => {
        void init;
        return jsonResponse(200, {
          data: { id: 'C9', name: 'Farhana Yasmin', phone: '8801711552211', email: null, orders_count: 6, delivered_orders_count: 6, returned_orders_count: 0, total_spent_amount: 1470000, risk: { tier: 'good', rate: 1, delivered: 6, total: 6 } },
        });
      },
    });
    renderApp(<AppRoutes />, { route: '/pos/PS1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Add customer' }));
    await userEvent.type(screen.getByLabelText('Customer phone'), '01711552211');
    const card = await screen.findByText('Farhana Yasmin · 01711-552211');
    expect(card.parentElement).toHaveTextContent('6 orders · ৳ 14,700 spent');
  });

  it('offline disables Charge and shows the Offline pill', async () => {
    signedIn('owner', saleRoutes());
    renderApp(<AppRoutes />, { route: '/pos/PS1' });
    await addPanjabi();
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByTestId('pos-online-pill')).toHaveTextContent('Offline — reconnect to charge');
    expect(screen.getByTestId('pos-charge')).toBeDisabled();
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.getByTestId('pos-charge')).toBeEnabled();
  });

  it('cash sale: change + breakdown, Idempotency-Key reused on retry, receipt and print', async () => {
    let attempt = 0;
    const fetchMock = signedIn('owner', {
      ...saleRoutes(),
      'POST /stores/S1/pos/sales': () => {
        attempt += 1;
        if (attempt === 1) throw new TypeError('Failed to fetch');
        return jsonResponse(201, { data: sale() });
      },
    });
    renderApp(<AppRoutes />, { route: '/pos/PS1' });
    await addPanjabi();
    await userEvent.click(screen.getByTestId('pos-charge'));
    const dialog = await screen.findByTestId('pos-payment');
    expect(within(dialog).getByTestId('pos-amount-to-pay')).toHaveTextContent('৳ 1,500');
    await userEvent.click(within(dialog).getByRole('button', { name: '৳ 2,000' }));
    expect(within(dialog).getByTestId('pos-change')).toHaveTextContent('৳ 500');
    expect(within(dialog).getByTestId('pos-change')).toHaveTextContent('Give 1 × 500');
    expect(within(dialog).queryByText('Open drawer')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'SMS receipt' })).toBeDisabled();

    await userEvent.click(within(dialog).getByTestId('pos-complete-sale'));
    expect(await within(dialog).findByTestId('pos-payment-error')).toHaveTextContent('won’t be charged twice');
    expect(screen.getByTestId('pos-online-pill')).toHaveTextContent('Offline');
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(within(dialog).getByTestId('pos-complete-sale')).toBeEnabled());
    await userEvent.click(within(dialog).getByTestId('pos-complete-sale'));

    const done = await screen.findByTestId('pos-sale-complete');
    const calls = posts(fetchMock, '/stores/S1/pos/sales');
    expect(calls).toHaveLength(2);
    expect(headerOf(calls[0]!, 'Idempotency-Key')).toBe(headerOf(calls[1]!, 'Idempotency-Key'));
    expect(bodyOf(calls[1]!)).toEqual({
      session_id: 'PS1',
      lines: [{ variant_id: 'V9', quantity: 1 }],
      coupon_code: null,
      expected_total_amount: 150000,
      payments: [{ method: 'cash', amount: 150000 }],
      tendered_cash_amount: 200000,
      sms_receipt: false,
    });
    expect(within(done).getByTestId('pos-receipt-number')).toHaveTextContent('Receipt MF-2232 · paid in cash');
    expect(within(done).getByTestId('pos-give-change')).toHaveTextContent('৳ 500');
    expect(within(done).getByTestId('pos-receipt')).toHaveTextContent('BIN 0012-3456');
    await waitFor(() => expect(window.print).toHaveBeenCalledTimes(1));
    expect(within(done).getByText('Printed on 80 mm printer')).toBeInTheDocument();

    // New sale empties the cart; the next sale gets a fresh key.
    await userEvent.click(within(done).getByTestId('pos-new-sale'));
    expect(screen.queryByTestId('pos-cart-line')).not.toBeInTheDocument();
    await addPanjabi();
    await userEvent.click(screen.getByTestId('pos-charge'));
    await userEvent.click(within(await screen.findByTestId('pos-payment')).getByTestId('pos-complete-sale'));
    await waitFor(() => expect(posts(fetchMock, '/stores/S1/pos/sales')).toHaveLength(3));
    expect(headerOf(posts(fetchMock, '/stores/S1/pos/sales')[2]!, 'Idempotency-Key')).not.toBe(headerOf(calls[0]!, 'Idempotency-Key'));
  });

  it('split payment with bKash TrxID sends both parts; remaining shown', async () => {
    const fetchMock = signedIn('owner', { ...saleRoutes(), 'POST /stores/S1/pos/sales': jsonResponse(201, { data: sale({ change_amount: 0, receipt: receipt({ payments: [{ method: 'cash', amount: 50000 }, { method: 'bkash_personal', amount: 100000 }], change_amount: 0 }) }) }) });
    renderApp(<AppRoutes />, { route: '/pos/PS1' });
    await addPanjabi();
    await userEvent.click(screen.getByTestId('pos-charge'));
    const dialog = await screen.findByTestId('pos-payment');
    await userEvent.click(within(dialog).getByRole('radio', { name: /Split/ }));
    expect(within(dialog).getByTestId('pos-split-remaining')).toHaveTextContent('Remaining ৳ 1,500');
    expect(within(dialog).getByTestId('pos-complete-sale')).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Part 1 amount'), '500');
    expect(within(dialog).getByTestId('pos-split-remaining')).toHaveTextContent('Remaining ৳ 1,000');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rest' }));
    await userEvent.type(within(dialog).getByLabelText('Part 2 reference'), '9AB3XZ');
    expect(within(dialog).getByTestId('pos-split-remaining')).toHaveTextContent('Fully paid');
    await userEvent.click(within(dialog).getByTestId('pos-complete-sale'));
    await waitFor(() => expect(posts(fetchMock, '/stores/S1/pos/sales')).toHaveLength(1));
    expect(bodyOf(posts(fetchMock, '/stores/S1/pos/sales')[0]!)).toMatchObject({
      payments: [
        { method: 'cash', amount: 50000, reference: null },
        { method: 'bkash_personal', amount: 100000, reference: '9AB3XZ' },
      ],
      tendered_cash_amount: 50000,
    });
    expect(await screen.findByTestId('pos-receipt-number')).toHaveTextContent('paid in split');
  });

  it('card sale sends the approval code; out_of_stock marks the cart line', async () => {
    const fetchMock = signedIn('owner', {
      ...saleRoutes(),
      'POST /stores/S1/pos/sales': jsonResponse(422, { error: { code: 'out_of_stock', message: 'Not enough stock.', details: { 'lines.0.quantity': ['Only 0 left at Mirpur shop.'] } } }),
    });
    renderApp(<AppRoutes />, { route: '/pos/PS1' });
    await addPanjabi();
    await userEvent.click(screen.getByRole('radio', { name: 'Card' }));
    await userEvent.click(screen.getByTestId('pos-charge'));
    const dialog = await screen.findByTestId('pos-payment');
    await userEvent.type(within(dialog).getByTestId('pos-reference'), 'A12345');
    await userEvent.click(within(dialog).getByTestId('pos-complete-sale'));
    await waitFor(() => expect(posts(fetchMock, '/stores/S1/pos/sales')).toHaveLength(1));
    expect(bodyOf(posts(fetchMock, '/stores/S1/pos/sales')[0]!).payments).toEqual([{ method: 'card', amount: 150000, reference: 'A12345' }]);
    expect(await screen.findByText('Only 0 left at Mirpur shop.')).toBeInTheDocument();
    expect(screen.getByTestId('pos-cart-notice')).toHaveTextContent('Refresh cart');
    expect(screen.getByTestId('pos-charge')).toBeDisabled();
  });
});

describe('PHASE-8-8D close register', () => {
  const closeRoutes = (extra: Record<string, Response | ((init: RequestInit) => Response)> = {}) => ({
    'GET /features': jsonResponse(200, { data: growthPos() }),
    'GET /stores/S1/pos/sessions/PS1': jsonResponse(200, { data: session() }),
    ...extra,
  });
  const count = (label: string, value: string) => fireEvent.change(screen.getByLabelText(`Count of ${label}`), { target: { value } });

  it('cash check, short within tolerance, leave / banked, Z-report print and close', async () => {
    const fetchMock = signedIn('owner', closeRoutes({ 'POST /stores/S1/pos/sessions/PS1/close': jsonResponse(200, { data: session({ status: 'closed', banked_amount: 1280000 }) }), 'GET /stores/S1/pos/registers': jsonResponse(200, { data: [register()] }) }));
    renderApp(<AppRoutes />, { route: '/pos/PS1/close' });
    expect(await screen.findByTestId('pos-expected')).toHaveTextContent('৳ 14,820');
    count('৳ 1,000', '14');
    count('৳ 500', '1');
    count('৳ 100', '3');
    expect(screen.getByTestId('pos-counted')).toHaveTextContent('৳ 14,800');
    expect(screen.getByTestId('pos-variance')).toHaveTextContent('Short by ৳ 20');
    expect(screen.getByTestId('pos-variance')).toHaveTextContent('Within your ৳ 50 tolerance. Add a note if you know why.');
    expect(screen.getByTestId('pos-leave-in-drawer')).toHaveValue('2000');
    expect(screen.getByTestId('pos-banked')).toHaveTextContent('৳ 12,800');
    expect(screen.getByText('Today’s sales').closest('section')).toHaveTextContent('bKash৳ 6,400');

    await userEvent.click(screen.getByTestId('pos-print-z'));
    expect(window.print).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.pos-print-root [data-testid="pos-z-report"]')).toHaveTextContent('Counted৳ 14,800');

    await userEvent.click(screen.getByTestId('pos-close-submit'));
    await userEvent.click(await screen.findByTestId('pos-close-confirm'));
    await waitFor(() => expect(posts(fetchMock, '/stores/S1/pos/sessions/PS1/close')).toHaveLength(1));
    const call = posts(fetchMock, '/stores/S1/pos/sessions/PS1/close')[0]!;
    expect(bodyOf(call)).toEqual({
      counts: { '100000': 14, '50000': 1, '10000': 3 },
      left_in_drawer_amount: 200000,
      note: null,
      revision: 3,
    });
    expect(headerOf(call, 'Idempotency-Key')).toBeTruthy();
  });

  it('over tolerance requires a note; left above counted is refused; held sales warning', async () => {
    signedIn('owner', closeRoutes({ 'GET /stores/S1/pos/sessions/PS1': jsonResponse(200, { data: session({ totals: { ...session().totals, held_sales_count: 2 } }) }) }));
    renderApp(<AppRoutes />, { route: '/pos/PS1/close' });
    await screen.findByTestId('pos-expected');
    expect(screen.getByText('2 held sales will be deleted')).toBeInTheDocument();
    count('৳ 1,000', '15');
    expect(screen.getByTestId('pos-variance')).toHaveTextContent('Over by ৳ 180');
    expect(screen.getByTestId('pos-variance')).toHaveTextContent('Over your ৳ 50 tolerance — add a note to close.');
    expect(screen.getByTestId('pos-close-submit')).toBeDisabled();
    await userEvent.type(screen.getByTestId('pos-close-note'), 'Float top-up from owner');
    expect(screen.getByTestId('pos-close-submit')).toBeEnabled();
    await userEvent.clear(screen.getByTestId('pos-leave-in-drawer'));
    await userEvent.type(screen.getByTestId('pos-leave-in-drawer'), '20000');
    expect(screen.getByTestId('pos-banked')).toHaveTextContent('—');
    expect(screen.getByTestId('pos-close-submit')).toBeDisabled();
  });
});

describe('PHASE-8-8D orders', () => {
  it('created_via chip filters to POS', async () => {
    const fetchMock = signedIn('owner', { 'GET /stores/S1/orders': jsonResponse(200, { data: [], meta: { current_page: 1, per_page: 25, total: 0, last_page: 1, counts: {} } }) });
    renderApp(<AppRoutes />, { route: '/orders' });
    await userEvent.click(await screen.findByTestId('orders-pos-chip'));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/orders').some((c) => new URL(c[0], 'http://x').searchParams.get('filter[created_via]') === 'pos')).toBe(true));
  });
});
