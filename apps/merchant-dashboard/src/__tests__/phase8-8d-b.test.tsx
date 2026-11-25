import type { OrderItem, PosHeldSale, PosSaleSummary } from '@storeplix/types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { filterHeld, HELD_STOCK_NOTE, heldSub, heldTitle, hydrateLines, linesFromHeld, returnableOf, returnEstimate, returnLines, saleCustomerLine, salePill } from '../pos/pos';
import { callsTo, jsonResponse, renderApp, signedIn } from '../test/utils';
import { order } from './phase5.fixtures';
import { catalogResponse, growthPos, hijab, jamdani, panjabi, quote, register, sale, session } from './phase8-8d-a.fixtures';

// PHASE-8-8D §14 Web part B: held sales list / resume / delete (+ hold dialog, no stock reserved copy), history filters
// + KPIs + detail (pill, reprint), return dialog maths, permission (`orders.refund`) and idempotency.

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
const byMethod = (fetchMock: Parameters<typeof callsTo>[0], path: string, method: string) => callsTo(fetchMock, path).filter((c) => (c[1].method ?? 'GET') === method);
const searchOf = (call: [string, RequestInit]) => new URL(String(call[0]), 'http://localhost').searchParams;

function held(o: Partial<PosHeldSale> = {}): PosHeldSale {
  return {
    id: 'H1',
    register_id: 'R1',
    customer_id: 'C9',
    customer_name: 'Farhana Yasmin',
    customer_phone: '8801711552211',
    coupon_code: null,
    note: 'Trying another size',
    lines: [{ variant_id: 'V9', quantity: 2 }],
    items_count: 2,
    total_amount: 300000,
    currency: 'BDT',
    held_by: { id: 'U1', name: 'Rahim' },
    created_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    ...o,
  };
}

function summary(o: Partial<PosSaleSummary> = {}): PosSaleSummary {
  return {
    id: 'SALE1',
    order_id: 'O1',
    number: 'MF-2232',
    placed_at: '2026-11-25T08:42:00Z',
    register_name: 'Register 1',
    cashier_name: 'Rahim',
    customer_name: 'Farhana Yasmin',
    items_count: 3,
    paid_by: 'cash',
    total_amount: 456000,
    refunded_amount: 0,
    currency: 'BDT',
    ...o,
  };
}

const item = (o: Partial<OrderItem> = {}): OrderItem => ({ ...order().items[0]!, ...o });
const twoItems = [
  item({ id: 'OI1', product_name: 'Jamdani Three-Piece', variant_title: 'Red · M', quantity: 2, total_amount: 330000, restocked_quantity: 0 }),
  item({ id: 'OI2', product_name: 'Cotton Panjabi', variant_title: '', quantity: 1, total_amount: 150000, restocked_quantity: 1 }),
];
const detail = (o: Parameters<typeof sale>[0] = {}) =>
  sale({ customer_name: 'Farhana Yasmin', total_amount: 456000, order: order({ id: 'O1', number: 'MF-2232', items: twoItems }), ...o });
const salesMeta = {
  next_cursor: null,
  prev_cursor: null,
  per_page: 25,
  summary: { sales_amount: 2281000, receipts_count: 14, average_sale_amount: 162929, returns_count: 1, returns_amount: 45000 },
};

describe('PHASE-8-8D part B helpers', () => {
  it('held sale labels, search and the no-reservation copy', () => {
    expect(HELD_STOCK_NOTE).toBe('Held sales don’t hold stock. Items are checked again when you resume.');
    expect(heldTitle(held({ customer_name: null }))).toBe('Walk-in customer');
    expect(heldSub(held())).toBe('01711-552211 · 2 items');
    expect(heldSub(held({ customer_phone: null, items_count: 1 }))).toBe('— · 1 item');
    const list = [held(), held({ id: 'H2', customer_name: null, customer_phone: null, note: 'Gone to ATM' })];
    expect(filterHeld(list, 'farhana').map((h) => h.id)).toEqual(['H1']);
    expect(filterHeld(list, 'atm').map((h) => h.id)).toEqual(['H2']);
    expect(filterHeld(list, '01711-552').map((h) => h.id)).toEqual(['H1']);
    expect(filterHeld(list, 'walk-in').map((h) => h.id)).toEqual(['H2']);
    expect(filterHeld(list, ' ')).toHaveLength(2);
  });

  it('resumed lines are hydrated from the quote', () => {
    const lines = linesFromHeld(held());
    expect(lines[0]).toMatchObject({ variantId: 'V9', quantity: 2, name: '' });
    const q = quote({
      lines: [
        {
          variant_id: 'V9',
          name: 'Cotton Panjabi',
          variant_title: 'White · 40',
          quantity: 2,
          unit_price_amount: 150000,
          compare_at_amount: null,
          line_total_amount: 300000,
          available: 43,
          problem: null,
        },
      ],
    });
    expect(hydrateLines(lines, q)[0]).toMatchObject({ name: 'Cotton Panjabi', variantTitle: 'White · 40', unitPrice: 150000, available: 43 });
    expect(hydrateLines(lines, undefined)).toBe(lines);
  });

  it('history pills and customer line', () => {
    expect(salePill({ refunded_amount: 0, total_amount: 100 })).toEqual({ label: 'Paid', tone: 'success' });
    expect(salePill({ refunded_amount: 40, total_amount: 100 })).toEqual({ label: 'Partly refunded', tone: 'warning' });
    expect(salePill({ refunded_amount: 100, total_amount: 100 }).label).toBe('Refunded');
    expect(saleCustomerLine({ customer_name: null, items_count: 1 })).toBe('Walk-in · 1 item');
  });

  it('return maths: returnable, estimate (pro rata, integer), lines', () => {
    expect(returnableOf(twoItems[0]!)).toBe(2);
    expect(returnableOf(twoItems[1]!)).toBe(0);
    const odd = [item({ id: 'A', quantity: 3, total_amount: 100000, restocked_quantity: 0 })];
    expect(returnEstimate(odd, { A: 1 })).toBe(33333);
    expect(returnEstimate(odd, { A: 3 })).toBe(100000);
    expect(returnEstimate(twoItems, { OI1: 1 })).toBe(165000);
    expect(returnLines(twoItems, { OI1: 1 })).toEqual([{ order_item_id: 'OI1', quantity: 1 }]);
    expect(returnLines(twoItems, {})).toBeNull();
    expect(returnLines(twoItems, { OI1: 3 })).toBeNull();
    expect(returnLines(twoItems, { OI2: 1 })).toBeNull();
  });
});

function tillRoutes(extra: Record<string, Response | ((init: RequestInit) => Response)> = {}) {
  return {
    'GET /features': jsonResponse(200, { data: growthPos() }),
    'GET /stores/S1/pos/sessions/PS1': jsonResponse(200, { data: session({ totals: { ...session().totals, held_sales_count: 2 } }) }),
    'GET /stores/S1/pos/catalog': catalogResponse([jamdani(), panjabi(), hijab()]),
    'GET /stores/S1/categories': jsonResponse(200, { data: [] }),
    'GET /stores/S1/pos/customers/lookup': jsonResponse(200, {
      data: {
        id: 'C9',
        name: 'Farhana Yasmin',
        phone: '8801711552211',
        email: null,
        orders_count: 6,
        delivered_orders_count: 6,
        returned_orders_count: 0,
        total_spent_amount: 1470000,
        risk: { tier: 'good', rate: 1, delivered: 6, total: 6 },
      },
    }),
    'POST /stores/S1/pos/quote': (init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { lines: { variant_id: string; quantity: number }[] };
      const qty = body.lines.reduce((s, l) => s + l.quantity, 0);
      return jsonResponse(200, {
        data: quote({
          lines: body.lines.map((l) => ({
            variant_id: l.variant_id,
            name: 'Cotton Panjabi',
            variant_title: '',
            quantity: l.quantity,
            unit_price_amount: 150000,
            compare_at_amount: null,
            line_total_amount: 150000 * l.quantity,
            available: 43,
            problem: null,
          })),
          items_count: qty,
          subtotal_amount: 150000 * qty,
          total_amount: 150000 * qty,
        }),
      });
    },
    'GET /stores/S1/pos/held-sales': jsonResponse(200, {
      data: [
        held(),
        held({
          id: 'H2',
          customer_id: null,
          customer_name: null,
          customer_phone: null,
          note: 'Gone to ATM',
          lines: [{ variant_id: 'V9', quantity: 1 }],
          items_count: 1,
          total_amount: 150000,
        }),
      ],
    }),
    ...extra,
  };
}

describe('PHASE-8-8D held sales', () => {
  it('Hold sale parks the cart with a note; Hold is disabled for an empty cart', async () => {
    const fetchMock = signedIn('owner', tillRoutes({ 'POST /stores/S1/pos/held-sales': jsonResponse(201, { data: held({ id: 'H3' }) }) }));
    renderApp(<AppRoutes />, { route: '/pos/PS1' });
    expect(await screen.findByTestId('pos-hold-sale')).toBeDisabled();
    expect(screen.getByTestId('pos-held-open')).toHaveTextContent('Held · 2');
    await userEvent.click(await screen.findByRole('button', { name: /^Cotton Panjabi/ }));
    await userEvent.click(screen.getByTestId('pos-hold-sale'));
    const dialog = await screen.findByRole('dialog', { name: 'Hold sale' });
    expect(dialog).toHaveTextContent('Held sales don’t hold stock.');
    await userEvent.type(within(dialog).getByTestId('pos-hold-note'), 'Gone to ATM');
    await userEvent.click(within(dialog).getByTestId('pos-hold-confirm'));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/pos/held-sales', 'POST')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/pos/held-sales', 'POST')[0]!)).toEqual({
      session_id: 'PS1',
      lines: [{ variant_id: 'V9', quantity: 1 }],
      coupon_code: null,
      note: 'Gone to ATM',
    });
    await waitFor(() => expect(screen.queryByTestId('pos-cart-line')).not.toBeInTheDocument());
  });

  it('held_sales_limit shows the 20-sale message', async () => {
    signedIn('owner', tillRoutes({ 'POST /stores/S1/pos/held-sales': jsonResponse(409, { error: { code: 'held_sales_limit', message: 'Limit.' } }) }));
    renderApp(<AppRoutes />, { route: '/pos/PS1' });
    await userEvent.click(await screen.findByRole('button', { name: /^Cotton Panjabi/ }));
    await userEvent.click(screen.getByTestId('pos-hold-sale'));
    await userEvent.click(await screen.findByTestId('pos-hold-confirm'));
    expect(await screen.findByText('This register already has 20 held sales. Resume or delete one first.')).toBeInTheDocument();
  });

  it('drawer lists, searches, deletes and resumes; the sale then sends held_sale_id', async () => {
    const fetchMock = signedIn('owner', {
      ...tillRoutes(),
      'DELETE /stores/S1/pos/held-sales/H2': new Response(null, { status: 204 }),
      'POST /stores/S1/pos/sales': jsonResponse(201, { data: sale() }),
    });
    renderApp(<AppRoutes />, { route: '/pos/PS1' });
    await userEvent.click(await screen.findByTestId('pos-held-open'));
    const drawer = await screen.findByTestId('pos-held-drawer');
    const cards = await within(drawer).findAllByTestId('pos-held-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent('Farhana Yasmin');
    expect(cards[0]).toHaveTextContent('01711-552211 · 2 items');
    expect(cards[0]).toHaveTextContent('Held 2 min ago · “Trying another size”');
    expect(cards[1]).toHaveTextContent('Walk-in customer');
    expect(screen.getByTestId('pos-held-note')).toHaveTextContent('don’t hold stock');
    expect(screen.queryByText(/reserved for 30 minutes/)).not.toBeInTheDocument();
    expect(new URL(callsTo(fetchMock, '/stores/S1/pos/held-sales')[0]![0], 'http://x').searchParams.get('register_id')).toBe('R1');

    await userEvent.type(within(drawer).getByLabelText('Search by customer or note'), 'atm');
    expect(within(drawer).getAllByTestId('pos-held-card')).toHaveLength(1);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await userEvent.click(within(drawer).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/pos/held-sales/H2', 'DELETE')).toHaveLength(1));

    await userEvent.clear(within(drawer).getByLabelText('Search by customer or note'));
    await userEvent.click(within(drawer).getAllByRole('button', { name: 'Resume' })[0]!);
    const line = await screen.findByTestId('pos-cart-line');
    await waitFor(() => expect(line).toHaveTextContent('Cotton Panjabi'));
    expect(within(line).getByTestId('pos-line-qty')).toHaveTextContent('2');
    expect(await screen.findByText('Farhana Yasmin · 01711-552211')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId('pos-charge')).toBeEnabled());
    await userEvent.click(screen.getByTestId('pos-charge'));
    await userEvent.click(within(await screen.findByTestId('pos-payment')).getByTestId('pos-complete-sale'));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/pos/sales', 'POST')).toHaveLength(1));
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/pos/sales', 'POST')[0]!)).toMatchObject({ held_sale_id: 'H1', customer_id: 'C9', lines: [{ variant_id: 'V9', quantity: 2 }] });
  });

  it('empty held list', async () => {
    signedIn('owner', tillRoutes({ 'GET /stores/S1/pos/held-sales': jsonResponse(200, { data: [] }) }));
    renderApp(<AppRoutes />, { route: '/pos/PS1' });
    await userEvent.click(await screen.findByTestId('pos-held-open'));
    expect(await screen.findByTestId('pos-held-empty')).toHaveTextContent('No held sales');
  });
});

function historyRoutes(extra: Record<string, Response | ((init: RequestInit) => Response)> = {}) {
  return {
    'GET /features': jsonResponse(200, { data: growthPos() }),
    'GET /stores/S1/pos/sessions/PS1': jsonResponse(200, { data: session() }),
    'GET /stores/S1/pos/registers': jsonResponse(200, { data: [register(), register({ id: 'R2', name: 'Register 2' })] }),
    'GET /stores/S1/pos/sales': jsonResponse(200, {
      data: [
        summary(),
        summary({ id: 'SALE2', number: 'MF-2231', customer_name: null, items_count: 1, paid_by: 'bkash_personal', total_amount: 95000 }),
        summary({ id: 'SALE3', number: 'MF-2227', refunded_amount: 45000, total_amount: 90000 }),
      ],
      meta: salesMeta,
    }),
    'GET /stores/S1/pos/sales/SALE1': jsonResponse(200, { data: detail() }),
    ...extra,
  };
}

describe('PHASE-8-8D sales history', () => {
  it('KPIs, rows, register defaults to the session, filters re-query', async () => {
    const fetchMock = signedIn('owner', historyRoutes());
    renderApp(<AppRoutes />, { route: '/pos/history?session=PS1' });
    const kpis = await screen.findByTestId('pos-history-kpis');
    await waitFor(() => expect(kpis).toHaveTextContent('Sales today৳ 22,810'));
    expect(kpis).toHaveTextContent('Receipts14');
    expect(kpis).toHaveTextContent('Average sale৳ 1,629.29');
    expect(kpis).toHaveTextContent('Returns1 · ৳ 450');
    const rows = await screen.findAllByTestId('pos-history-row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('Walk-in · 1 item');
    expect(rows[1]).toHaveTextContent('bKash');
    expect(rows[2]).toHaveTextContent('Return');
    expect(rows[2]).toHaveTextContent('− ৳ 450');
    expect(searchOf(callsTo(fetchMock, '/stores/S1/pos/sales')[0]!).get('filter[register_id]')).toBe('R1');
    expect(searchOf(callsTo(fetchMock, '/stores/S1/pos/sales')[0]!).get('filter[date]')).toBe('today');
    expect(screen.getByTestId('pos-bar-subtitle')).toHaveTextContent('Register 1 · Mirpur shop · Today');
    expect(screen.getByTestId('pos-back-to-sale')).toHaveAttribute('href', '/pos/PS1');

    fireEvent.change(screen.getByTestId('pos-history-date'), { target: { value: 'yesterday' } });
    fireEvent.change(screen.getByTestId('pos-history-method'), { target: { value: 'split' } });
    fireEvent.change(screen.getByTestId('pos-history-register'), { target: { value: '' } });
    await waitFor(() => {
      const last = searchOf(callsTo(fetchMock, '/stores/S1/pos/sales').at(-1)!);
      expect(last.get('filter[date]')).toBe('yesterday');
      expect(last.get('filter[method]')).toBe('split');
      expect(last.get('filter[register_id]')).toBeNull();
    });
    await userEvent.type(screen.getByTestId('pos-history-search'), 'MF-2232');
    await waitFor(() => expect(searchOf(callsTo(fetchMock, '/stores/S1/pos/sales').at(-1)!).get('q')).toBe('MF-2232'));
  });

  it('custom date range sends from/to', async () => {
    const fetchMock = signedIn('owner', historyRoutes());
    renderApp(<AppRoutes />, { route: '/pos/history?session=PS1&date=custom' });
    fireEvent.change(await screen.findByLabelText('From'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-20' } });
    await waitFor(() => {
      const last = searchOf(callsTo(fetchMock, '/stores/S1/pos/sales').at(-1)!);
      expect(last.get('from')).toBe('2026-11-01');
      expect(last.get('to')).toBe('2026-11-20');
    });
  });

  it('empty and error states', async () => {
    signedIn('owner', historyRoutes({ 'GET /stores/S1/pos/sales': jsonResponse(200, { data: [], meta: { ...salesMeta, summary: { ...salesMeta.summary, receipts_count: 0 } } }) }));
    renderApp(<AppRoutes />, { route: '/pos/history?session=PS1' });
    expect(await screen.findByTestId('pos-history-empty')).toHaveTextContent('No sales yet today');
  });

  it('detail: pill, lines, cash received / change, reprint, SMS; Void receipt hidden', async () => {
    const fetchMock = signedIn('owner', {
      ...historyRoutes(),
      'POST /stores/S1/pos/sales/SALE1/sms-receipt': jsonResponse(200, { data: detail({ sms_receipt_status: 'queued' }) }),
    });
    renderApp(<AppRoutes />, { route: '/pos/history?session=PS1' });
    await userEvent.click((await screen.findAllByTestId('pos-history-row'))[0]!);
    const panel = await screen.findByTestId('pos-sale-detail');
    expect(await within(panel).findByText('Receipt MF-2232')).toBeInTheDocument();
    expect(within(panel).getByTestId('pos-sale-pill')).toHaveTextContent('Paid');
    expect(panel).toHaveTextContent('Cash received৳ 2,000');
    expect(panel).toHaveTextContent('Change given৳ 500');
    expect(panel).toHaveTextContent('1 returned');
    expect(screen.queryByText(/Void receipt/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Return or exchange/)).not.toBeInTheDocument();
    await userEvent.click(within(panel).getByTestId('pos-reprint'));
    expect(window.print).toHaveBeenCalledTimes(1);
    expect(within(panel).getByTestId('pos-send-sms')).toBeDisabled(); // walk-in receipt (no phone)
    void fetchMock;
  });

  it('Return items needs orders.refund (staff has pos.sell only)', async () => {
    signedIn('staff', historyRoutes());
    renderApp(<AppRoutes />, { route: '/pos/history?session=PS1&sale=SALE1' });
    expect(await screen.findByRole('heading', { name: 'Receipt MF-2232' })).toBeInTheDocument();
    expect(screen.queryByTestId('pos-return-items')).not.toBeInTheDocument();
  });

  it('return dialog: quantities ≤ returnable, refund estimate, method, Idempotency-Key reused on retry; drawer_short', async () => {
    let attempt = 0;
    const fetchMock = signedIn('owner', {
      ...historyRoutes(),
      'POST /stores/S1/pos/sales/SALE1/returns': () => {
        attempt += 1;
        if (attempt === 1) return jsonResponse(422, { error: { code: 'drawer_short', message: 'Short.', details: { cash_in_drawer_amount: 10000 } } });
        return jsonResponse(201, { data: { sale: detail({ refunded_amount: 165000 }), return_request: {}, refund: { amount: 165000 } } });
      },
    });
    renderApp(<AppRoutes />, { route: '/pos/history?session=PS1&sale=SALE1' });
    await userEvent.click(await screen.findByTestId('pos-return-items'));
    const dialog = await screen.findByTestId('pos-return-dialog');
    const lines = within(dialog).getAllByTestId('pos-return-line');
    expect(lines).toHaveLength(1); // the panjabi is already returned
    expect(lines[0]).toHaveTextContent('2 of 2 returnable');
    expect(screen.getByTestId('pos-return-submit')).toBeDisabled();
    const more = within(lines[0]!).getByRole('button', { name: 'Return one more Jamdani Three-Piece' });
    await userEvent.click(more);
    await userEvent.click(more);
    expect(more).toBeDisabled();
    await userEvent.click(within(lines[0]!).getByRole('button', { name: 'Return one less Jamdani Three-Piece' }));
    expect(screen.getByTestId('pos-return-submit')).toHaveTextContent('Return and refund ৳ 1,650');
    expect(within(dialog).getByRole('radio', { name: 'Cash' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.change(within(dialog).getByTestId('pos-return-reason'), { target: { value: 'wrong_size' } });

    await userEvent.click(screen.getByTestId('pos-return-submit'));
    expect(await within(dialog).findByTestId('pos-return-error')).toHaveTextContent('isn’t enough cash in the drawer');
    await userEvent.click(screen.getByTestId('pos-return-submit'));
    await waitFor(() => expect(screen.queryByTestId('pos-return-dialog')).not.toBeInTheDocument());
    const calls = byMethod(fetchMock, '/stores/S1/pos/sales/SALE1/returns', 'POST');
    expect(calls).toHaveLength(2);
    expect(bodyOf(calls[0]!)).toEqual({ session_id: 'PS1', lines: [{ order_item_id: 'OI1', quantity: 1 }], refund_method: 'cash', reason: 'wrong_size', note: null });
    expect(headerOf(calls[0]!, 'Idempotency-Key')).toBeTruthy();
    expect(headerOf(calls[0]!, 'Idempotency-Key')).toBe(headerOf(calls[1]!, 'Idempotency-Key'));
    expect(await screen.findByTestId('pos-sale-pill')).toHaveTextContent('Partly refunded');
  });

  it('without an open session, Return items is disabled with a hint', async () => {
    signedIn('owner', historyRoutes());
    renderApp(<AppRoutes />, { route: '/pos/history?sale=SALE1' });
    expect(await screen.findByTestId('pos-return-items')).toBeDisabled();
    expect(screen.getByText('Open a register to take returns at the till.')).toBeInTheDocument();
  });
});

describe('PHASE-8-8D part B API behaviours', () => {
  it('over-return (409 return_not_allowed) shows a message; reason defaults to other', async () => {
    const fetchMock = signedIn('owner', {
      ...historyRoutes(),
      'POST /stores/S1/pos/sales/SALE1/returns': jsonResponse(409, { error: { code: 'return_not_allowed', message: 'Already returned.' } }),
    });
    renderApp(<AppRoutes />, { route: '/pos/history?session=PS1&sale=SALE1' });
    await userEvent.click(await screen.findByTestId('pos-return-items'));
    const dialog = await screen.findByTestId('pos-return-dialog');
    expect(within(dialog).getByTestId('pos-return-reason')).toHaveValue('other');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Return one more Jamdani Three-Piece' }));
    await userEvent.click(screen.getByTestId('pos-return-submit'));
    expect(await within(dialog).findByTestId('pos-return-error')).toHaveTextContent('already returned');
    expect(bodyOf(byMethod(fetchMock, '/stores/S1/pos/sales/SALE1/returns', 'POST')[0]!).reason).toBe('other');
  });

  it('a search covers every day (no default date filter); custom range over 366 days is refused', async () => {
    const fetchMock = signedIn('owner', historyRoutes());
    renderApp(<AppRoutes />, { route: '/pos/history?session=PS1' });
    await userEvent.type(await screen.findByTestId('pos-history-search'), '01711552211');
    await waitFor(() => {
      const last = searchOf(callsTo(fetchMock, '/stores/S1/pos/sales').at(-1)!);
      expect(last.get('q')).toBe('01711552211');
      expect(last.get('filter[date]')).toBeNull();
    });
    fireEvent.change(screen.getByTestId('pos-history-date'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2025-01-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-20' } });
    expect(await screen.findByText('Pick a range of up to 366 days.')).toBeInTheDocument();
  });

  it('a stale held_sale_id (422) drops the link and lets the cashier sell again', async () => {
    let attempt = 0;
    const fetchMock = signedIn('owner', {
      ...tillRoutes(),
      'POST /stores/S1/pos/sales': () => {
        attempt += 1;
        return attempt === 1
          ? jsonResponse(422, { error: { code: 'validation_failed', message: 'Invalid.', details: { held_sale_id: ['This held sale is no longer available.'] } } })
          : jsonResponse(201, { data: sale() });
      },
    });
    renderApp(<AppRoutes />, { route: '/pos/PS1' });
    await userEvent.click(await screen.findByTestId('pos-held-open'));
    await userEvent.click((await screen.findAllByRole('button', { name: 'Resume' }))[1]!);
    await waitFor(() => expect(screen.getByTestId('pos-charge')).toBeEnabled());
    await userEvent.click(screen.getByTestId('pos-charge'));
    const pay = await screen.findByTestId('pos-payment');
    await userEvent.click(within(pay).getByTestId('pos-complete-sale'));
    expect(await within(pay).findByTestId('pos-payment-error')).toHaveTextContent('no longer available');
    await userEvent.click(within(pay).getByTestId('pos-complete-sale'));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/pos/sales', 'POST')).toHaveLength(2));
    const [first, second] = byMethod(fetchMock, '/stores/S1/pos/sales', 'POST');
    expect(bodyOf(first!).held_sale_id).toBe('H2');
    expect(bodyOf(second!).held_sale_id).toBeUndefined();
  });
});
