import { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import { backdateHint, categoryBars, compareLine, downscaleSize, expenseSchema, prepareReceipt, totalRow } from '../expenses/expenses';
import { expenseKeys, invalidateAfterExpenseWrite } from '../expenses/queries';
import { visibleNav } from '../layout/nav';
import { can } from '../lib/permissions';
import { adSpendInsight, waterfallBars } from '../reports/ProfitTab';
import { reportKey } from '../reports/queries';
import { callsTo, jsonResponse, renderApp, settingsFixture, signedIn } from '../test/utils';
import { features, profitReport, profitSummary, reportMeta } from './phase7.fixtures';
import { expense, expenseRoutes, expenses, MONTH, PREV, summary, TODAY } from './phase8-7.fixtures';

// PHASE-8-7 §13 Web: Expenses page from fixtures (tiles incl. hidden profit tile, chips, table + total, add/edit/delete,
// amount ↔ minor units, receipt upload states, repeat toggle, by-category bars, back-dating hint), Reports tabs by
// permission, client-side photo downscale, query invalidation, Profit tab changes, Store details currency lock.

const SLOW = { timeout: 5000 };
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const expensesOnly = { role: 'custom' as const, permissions: ['expenses.manage' as const] };
const byMethod = (fetchMock: Parameters<typeof callsTo>[0], path: string, method: string) => callsTo(fetchMock, path).filter((c) => (c[1].method ?? 'GET') === method);

describe('PHASE-8-7 helpers', () => {
  it('compare line, total row and by-category bars (share of the largest)', () => {
    expect(compareLine({ label_month: '2026-10', total_amount: 1, change_pct: 12 })).toEqual({ text: '↑ 12% vs October', up: true });
    expect(compareLine({ label_month: '2026-10', total_amount: 1, change_pct: -5 })?.text).toBe('↓ 5% vs October');
    expect(compareLine({ label_month: '2026-10', total_amount: 0, change_pct: null })).toBeNull();
    expect(totalRow(summary(), null)).toEqual({ label: '5 expenses this month', amount: 4255000 });
    expect(totalRow(summary(), 'ads')).toEqual({ label: '1 Ads expense', amount: 800000 });
    expect(totalRow(summary(), 'other')).toEqual({ label: '0 Other expenses', amount: 0 });
    const bars = categoryBars(summary());
    expect(bars.map((b) => b.category)).toEqual(['salaries', 'rent_bills', 'ads', 'packaging', 'courier']);
    expect(bars[0]!.width).toBe(100);
    expect(bars[2]!.width).toBeCloseTo((800000 / 1800000) * 100);
  });

  it('form schema: amount in minor units, date ≤ today, note ≤ 200', () => {
    const schema = expenseSchema('2026-11-24');
    const ok = { amount: 240050, category: 'packaging', paid_from: 'cash', spent_on: '2026-11-20', note: 'Gift boxes', repeat_monthly: false } as const;
    expect(schema.safeParse(ok).success).toBe(true);
    expect(schema.safeParse({ ...ok, amount: null }).error?.issues[0]?.message).toBe('Enter the amount.');
    expect(schema.safeParse({ ...ok, amount: Number.NaN }).error?.issues[0]?.message).toBe('Enter an amount like 2400 or 2400.50.');
    expect(schema.safeParse({ ...ok, amount: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...ok, amount: 1_000_000_001 }).success).toBe(false);
    expect(schema.safeParse({ ...ok, spent_on: '2026-11-25' }).success).toBe(false);
    expect(schema.safeParse({ ...ok, spent_on: '2019-12-31' }).success).toBe(false);
    expect(schema.safeParse({ ...ok, note: 'x'.repeat(201) }).success).toBe(false);
  });

  it('back-dating hint only for an earlier month', () => {
    expect(backdateHint('2026-11-02', '2026-11-24')).toBeNull();
    expect(backdateHint('2026-10-31', '2026-11-24')).toBe('This changes Profit & loss for October.');
    expect(backdateHint('2025-12-01', '2026-01-03')).toBe('This changes Profit & loss for December 2025.');
  });

  it('downscale: only photos whose long side is over 2,560 px', () => {
    expect(downscaleSize(2560, 1440)).toBeNull();
    expect(downscaleSize(8160, 6120)).toEqual({ width: 2560, height: 1920 });
    expect(downscaleSize(3000, 6000)).toEqual({ width: 1280, height: 2560 });
  });

  it('prepareReceipt redraws a large photo as JPEG 0.85 and leaves PDFs and small photos alone', async () => {
    const drawImage = vi.fn();
    const toBlob = vi.fn((cb: (b: Blob | null) => void, type: string, q: number) => cb(new Blob([`jpeg ${q}`], { type })));
    const sizes: Record<string, [number, number]> = { big: [8000, 6000], small: [1200, 900] };
    vi.stubGlobal('createImageBitmap', async (f: File) => {
      const [width, height] = sizes[f.name.split('.')[0]!]!;
      return { width, height, close: vi.fn() };
    });
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag !== 'canvas') return realCreate(tag);
      const c = realCreate('canvas') as HTMLCanvasElement;
      c.getContext = (() => ({ drawImage })) as unknown as HTMLCanvasElement['getContext'];
      c.toBlob = toBlob as unknown as HTMLCanvasElement['toBlob'];
      return c;
    }) as typeof document.createElement);

    const out = await prepareReceipt(new File(['x'], 'big.png', { type: 'image/png' }));
    expect(out.name).toBe('big.jpg');
    expect(out.type).toBe('image/jpeg');
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 2560, 1920);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.85);

    const small = new File(['x'], 'small.jpg', { type: 'image/jpeg' });
    expect(await prepareReceipt(small)).toBe(small);
    const pdf = new File(['%PDF-'], 'bill.pdf', { type: 'application/pdf' });
    expect(await prepareReceipt(pdf)).toBe(pdf);
  });

  it('expense writes invalidate the expenses keys and every Profit & loss range', async () => {
    const qc = new QueryClient();
    const s = { tenantId: 'T1', storeId: 'S1' };
    qc.setQueryData(reportKey('T1', 'S1', 'profit', { from: '2026-11-01', to: '2026-11-24' }), 1);
    qc.setQueryData(reportKey('T1', 'S1', 'sales', { from: '2026-11-01', to: '2026-11-24' }), 1);
    qc.setQueryData(expenseKeys.summary(s, MONTH), 1);
    await invalidateAfterExpenseWrite(qc, s);
    expect(qc.getQueryState(reportKey('T1', 'S1', 'profit', { from: '2026-11-01', to: '2026-11-24' }))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(reportKey('T1', 'S1', 'sales', { from: '2026-11-01', to: '2026-11-24' }))?.isInvalidated).toBe(false);
    expect(qc.getQueryState(expenseKeys.summary(s, MONTH))?.isInvalidated).toBe(true);
    expect(expenseKeys.profitReports(s)).toEqual(['T1', 'S1', 'reports', 'profit']);
  });

  it('permissions and nav: Reports shows for reports.view or expenses.manage', () => {
    expect(can.manageExpenses({ role: 'owner' })).toBe(true);
    expect(can.manageExpenses({ role: 'admin' })).toBe(true);
    expect(can.manageExpenses({ role: 'staff' })).toBe(false);
    const reports = (m: Parameters<typeof visibleNav>[0]) => visibleNav(m).some((n) => n.to === '/reports');
    expect(reports(expensesOnly)).toBe(true);
    expect(reports({ role: 'custom', permissions: ['orders.view'] })).toBe(false);
    expect(reports({ role: 'staff' })).toBe(true);
  });
});

describe('Profit & loss with expenses (§10.2)', () => {
  const withExpenses = () => {
    const s = profitSummary({ ad_spend_amount: 2000000, other_expenses_amount: 3000000, total_cost_amount: 36246000, profit_before_expenses_amount: 17374000, net_profit_amount: 12374000 });
    return profitReport({
      summary: s,
      previous: profitSummary({ revenue_amount: 40000000, ad_spend_amount: 1500000 }),
      per_order: { order_value_amount: 131761, product_cost_amount: 67289, delivery_cost_amount: 14173, cod_fee_amount: 3214, gateway_fee_amount: null, ad_spend_amount: 5420, other_expenses_amount: 8130, profit_amount: 33534 },
      data_quality: { items_without_cost: 0, shipments_without_fee: 0, expenses_count: 4 },
    });
  };

  it('waterfall labels and real Ad spend / Other expenses bars', () => {
    const bars = waterfallBars(withExpenses().summary);
    expect(bars.map((b) => b.label)).toEqual(['Revenue', 'Product cost', 'Delivery charges', 'Courier COD fee', 'Gateway fees', 'Ad spend', 'Other expenses', 'Net profit']);
    expect(bars[5]).toMatchObject({ value: 2000000, base: 48620000 - 24830000 - 5230000 - 1186000 - 2000000 });
    expect(bars[6]).toMatchObject({ value: 3000000, base: 12374000 });
    expect(bars.some((b) => b.note === 'Coming with Expenses')).toBe(false);
  });

  it('ad-spend insight (P87-17) boundaries', () => {
    const p = profitSummary({ revenue_amount: 10000, ad_spend_amount: 1000 });
    const s = (rev: number, ad: number) => profitSummary({ revenue_amount: rev, ad_spend_amount: ad });
    expect(adSpendInsight(s(11400, 1220), p)).toBe('Ad spend grew 22% but sales grew 14%. Review your ads before raising the budget.');
    expect(adSpendInsight(s(10000, 1099), p)).toBe('Ad spend grew 10% but sales grew 0%. Review your ads before raising the budget.'); // 9.9 % rounds to 10
    expect(adSpendInsight(s(10000, 1094), p)).toBeNull(); // 9 %
    expect(adSpendInsight(s(11000, 1100), p)).toBeNull(); // 10 % = 10 %, not faster
    expect(adSpendInsight(s(10900, 1100), p)).toBe('Ad spend grew 10% but sales grew 9%. Review your ads before raising the budget.');
    expect(adSpendInsight(s(9000, 1200), p)).toBe('Ad spend grew 20% but sales grew -10%. Review your ads before raising the budget.');
    expect(adSpendInsight(s(11400, 1220), profitSummary({ revenue_amount: 10000, ad_spend_amount: 0 }))).toBeNull();
    expect(adSpendInsight(s(11400, 1220), profitSummary({ revenue_amount: 0, ad_spend_amount: 1000 }))).toBeNull();
  });

  const profitRoutes = (report = withExpenses()) => ({
    'GET /features': jsonResponse(200, { data: features({ plan_code: 'growth', features: { ...features().features, profit_reports: true } }) }),
    'GET /stores/S1/reports/profit': jsonResponse(200, { data: report, meta: reportMeta() }),
  });

  it('Profit tab: before-expenses line, per-order and daily expense columns, insight, add-expenses link', async () => {
    signedIn('owner', profitRoutes());
    renderApp(<AppRoutes />, { route: '/reports/profit' });
    expect(await screen.findByText('৳ 1,73,740 before expenses', undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByText('Product, delivery, fees and ads')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Revenue to net profit' })).toHaveTextContent('Other expenses');
    expect(screen.queryByText('Coming with Expenses')).not.toBeInTheDocument();
    const perOrder = screen.getByRole('region', { name: 'One average order' });
    expect(within(perOrder).getByText('Ad spend')).toBeInTheDocument();
    expect(within(perOrder).getByText('− ৳ 54')).toBeInTheDocument();
    expect(within(perOrder).getByText('Other expenses')).toBeInTheDocument();
    const daily = screen.getByRole('region', { name: 'Day by day' });
    expect(within(daily).getByRole('columnheader', { name: 'Ad spend' })).toBeInTheDocument();
    expect(within(daily).getByRole('columnheader', { name: 'Other exp.' })).toBeInTheDocument();
    expect(within(daily).getByText('৳ 30,000')).toBeInTheDocument(); // total row: other expenses
    const share = screen.getByRole('region', { name: 'Where each ৳ 100 goes' });
    expect(within(share).getAllByRole('listitem').map((li) => li.textContent?.replace(/৳.*$|Not tracked/, ''))).toEqual(['Product cost', 'Ad spend', 'Delivery charges', 'Courier COD fee', 'Gateway fees', 'Other expenses', 'You keep']);
    expect(within(share).getByRole('note')).toHaveTextContent('Ad spend grew 33% but sales grew 22%. Review your ads before raising the budget.');
    expect(screen.getByRole('link', { name: 'Add expenses' })).toHaveAttribute('href', '/reports/expenses');
  });

  it('zero-expense hint only when the period has no expenses and the member can record them', async () => {
    signedIn('owner', profitRoutes(profitReport()));
    const a = renderApp(<AppRoutes />, { route: '/reports/profit' });
    expect(await screen.findByText(/No expenses recorded for this period/, undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Expenses' })).toHaveAttribute('href', '/reports/expenses');
    a.unmount();
    vi.unstubAllGlobals();
    signedIn({ role: 'custom', permissions: ['reports.view', 'costs.view'] }, profitRoutes(profitReport()));
    renderApp(<AppRoutes />, { route: '/reports/profit' });
    expect(await screen.findByText('From sales to profit', undefined, SLOW)).toBeInTheDocument();
    expect(screen.queryByText(/No expenses recorded/)).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Expenses' })).not.toBeInTheDocument();
  });
});

describe('Reports tabs by permission (P87-16)', () => {
  it('owner: Expenses is the last tab', async () => {
    signedIn('owner', { ...expenseRoutes(), 'GET /stores/S1/reports/sales': jsonResponse(404, {}) });
    renderApp(<AppRoutes />, { route: '/reports/sales' });
    const tabs = await screen.findByRole('tablist', { name: 'Reports' }, SLOW);
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Sales', 'Profit & loss', 'Delivery & returns', 'Expenses']);
  });

  it('expenses-only member: nav item visible, /reports → /reports/expenses, only that tab, no profit tile', async () => {
    signedIn(expensesOnly, expenseRoutes({ 'GET /stores/S1/expenses/summary': jsonResponse(200, { data: summary({ profit_after_expenses_amount: null }) }) }));
    renderApp(<AppRoutes />, { route: '/reports' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Expenses' }, SLOW)).toBeInTheDocument();
    expect(within(screen.getByRole('tablist', { name: 'Reports' })).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Expenses']);
    expect(screen.getAllByRole('link', { name: /Reports/ }).length).toBeGreaterThan(0);
    const kpis = await screen.findByRole('region', { name: 'Expenses summary' }, SLOW);
    expect(within(kpis).queryByText('Profit after expenses')).not.toBeInTheDocument();
    expect(within(kpis).getByText('Cost per order')).toBeInTheDocument();
  });

  it('staff without expenses.manage gets the no-access state on /reports/expenses', async () => {
    signedIn('staff', expenseRoutes());
    renderApp(<AppRoutes />, { route: '/reports/expenses' });
    expect(await screen.findByText('You don’t have access to this page', undefined, SLOW)).toBeInTheDocument();
  });
});

describe('Expenses page (§10.1)', () => {
  it('tiles, chips incl. Courier/Other, table + total, by-category bars', async () => {
    signedIn('owner', expenseRoutes());
    renderApp(<AppRoutes />, { route: '/reports/expenses' });
    const kpis = await screen.findByRole('region', { name: 'Expenses summary' }, SLOW);
    expect(within(kpis).getByText('৳ 42,550')).toBeInTheDocument();
    expect(within(kpis).getByText(/↑ 12% vs/)).toHaveClass('text-danger');
    expect(within(kpis).getByText('Ads')).toBeInTheDocument();
    expect(within(kpis).queryByText('Facebook ads')).not.toBeInTheDocument();
    expect(within(kpis).getByText('19% of expenses')).toBeInTheDocument();
    expect(within(kpis).getByRole('link', { name: /Profit after expenses/ })).toHaveAttribute('href', `/reports/profit?from=${MONTH}-01&to=${TODAY}`);
    expect(within(kpis).getByText('612 delivered orders')).toBeInTheDocument();
    expect(within(kpis).getByText('৳ 69.52')).toBeInTheDocument();

    const chips = screen.getByRole('group', { name: 'Category' });
    expect(within(chips).getAllByRole('button').map((b) => b.textContent)).toEqual(['All', 'Ads', 'Packaging', 'Salaries', 'Rent & bills', 'Courier', 'Other']);

    const table = await screen.findByRole('table', { name: 'Expenses this month' }, SLOW);
    expect(within(table).getAllByRole('row')).toHaveLength(6);
    expect(within(table).getAllByText('Receipt attached')).toHaveLength(2);
    expect(within(table).getByText('Repeats monthly')).toBeInTheDocument();
    expect(within(table).getByText('Rent & bills')).toHaveClass('text-warning');
    expect(screen.getByText('5 expenses this month')).toBeInTheDocument();
    expect(screen.getByText('Total ৳ 42,550')).toBeInTheDocument();

    const by = screen.getByRole('region', { name: 'By category' });
    expect(within(by).getAllByRole('listitem').map((li) => li.firstElementChild?.firstElementChild?.textContent)).toEqual(['Salaries', 'Rent & bills', 'Ads', 'Packaging', 'Courier']);
    expect(screen.getByTestId('bar-salaries')).toHaveStyle({ width: '100%' });
  });

  it('a category chip filters the list and the total row', async () => {
    const fetchMock = signedIn('owner', expenseRoutes());
    renderApp(<AppRoutes />, { route: '/reports/expenses' });
    await screen.findByRole('table', { name: 'Expenses this month' }, SLOW);
    await userEvent.click(within(screen.getByRole('group', { name: 'Category' })).getByRole('button', { name: 'Ads' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/expenses').some(([u]) => new URL(u, 'http://x').searchParams.get('filter[category]') === 'ads')).toBe(true));
    expect(await screen.findByText('1 Ads expense')).toBeInTheDocument();
    expect(screen.getByText('Total ৳ 8,000')).toBeInTheDocument();
  });

  it('empty month and error states', async () => {
    signedIn('owner', expenseRoutes({ 'GET /stores/S1/expenses': jsonResponse(200, { data: [], meta: { next_cursor: null, prev_cursor: null, per_page: 50 } }) }));
    const a = renderApp(<AppRoutes />, { route: '/reports/expenses' });
    expect(await screen.findByText(/^No expenses in /, undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add expense' })).toBeInTheDocument();
    a.unmount();
    vi.unstubAllGlobals();
    signedIn('owner', expenseRoutes({ 'GET /stores/S1/expenses/summary': jsonResponse(500, { error: { code: 'server_error', message: 'Boom' } }) }));
    renderApp(<AppRoutes />, { route: '/reports/expenses' });
    expect(await screen.findByText('Boom', undefined, SLOW)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Try again' }).length).toBeGreaterThan(0);
  });

  it('add: amount in taka → minor units, Courier hint, back-dating hint, repeat toggle; invalidates', async () => {
    let body: Record<string, unknown> | null = null;
    const fetchMock = signedIn('owner', {
      ...expenseRoutes(),
      'POST /stores/S1/expenses': (init) => {
        body = JSON.parse(String(init.body));
        return jsonResponse(201, { data: expense({ id: 'E9' }) });
      },
    });
    renderApp(<AppRoutes />, { route: '/reports/expenses' });
    const card = await screen.findByRole('region', { name: 'Add expense' }, SLOW);
    await userEvent.type(within(card).getByLabelText('Amount'), '2400.50');
    await userEvent.selectOptions(within(card).getByLabelText('Category'), 'courier');
    expect(within(card).getByText(/Only charges not already on courier invoices/)).toBeInTheDocument();
    await userEvent.selectOptions(within(card).getByLabelText('Paid from'), 'bkash');
    fireEvent.change(within(card).getByLabelText('Date'), { target: { value: `${PREV}-15` } });
    expect(await within(card).findByText(/^This changes Profit & loss for /)).toBeInTheDocument();
    await userEvent.type(within(card).getByLabelText('Note'), '  Return charges  ');
    await userEvent.click(within(card).getByRole('switch', { name: 'Repeat every month' }));
    const before = callsTo(fetchMock, '/stores/S1/expenses/summary').length;
    await userEvent.click(within(card).getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(body).toEqual({ amount: 240050, category: 'courier', paid_from: 'bkash', spent_on: `${PREV}-15`, note: 'Return charges', repeat_monthly: true }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/expenses/summary').length).toBeGreaterThan(before));
  });

  it('add: client validation and server 422 mapped to the field', async () => {
    signedIn('owner', {
      ...expenseRoutes(),
      'POST /stores/S1/expenses': jsonResponse(422, { error: { code: 'validation_failed', message: 'Invalid', details: { spent_on: ['The date can’t be in the future.'] } } }),
    });
    renderApp(<AppRoutes />, { route: '/reports/expenses' });
    const card = await screen.findByRole('region', { name: 'Add expense' }, SLOW);
    await userEvent.click(within(card).getByRole('button', { name: 'Save expense' }));
    expect(await within(card).findByText('Enter the amount.')).toBeInTheDocument();
    await userEvent.type(within(card).getByLabelText('Amount'), '100');
    await userEvent.click(within(card).getByRole('button', { name: 'Save expense' }));
    expect(await within(card).findByText('The date can’t be in the future.')).toBeInTheDocument();
  });

  it('receipt: upload on pick → chip with name + Processing…, remove, attach on save; 422 inline', async () => {
    class FakeXhr {
      static last: FakeXhr;
      status = 0;
      statusText = '';
      responseText = '';
      body: FormData | null = null;
      upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      url = '';
      constructor() {
        FakeXhr.last = this;
      }
      open(_m: string, url: string) {
        this.url = url;
      }
      setRequestHeader() {}
      send(body: FormData) {
        this.body = body;
      }
      abort() {}
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    let body: Record<string, unknown> | null = null;
    signedIn('owner', {
      ...expenseRoutes(),
      'POST /stores/S1/expenses': (init) => {
        body = JSON.parse(String(init.body));
        return jsonResponse(201, { data: expense({ id: 'E9' }) });
      },
    });
    renderApp(<AppRoutes />, { route: '/reports/expenses' });
    const card = await screen.findByRole('region', { name: 'Add expense' }, SLOW);
    expect(within(card).getByText('JPG, PNG, WebP or PDF · up to 5 MB')).toBeInTheDocument();

    fireEvent.change(within(card).getByLabelText('Add receipt photo'), { target: { files: [new File(['%PDF-1.4'], 'bill.pdf', { type: 'application/pdf' })] } });
    await waitFor(() => expect(FakeXhr.last?.url).toContain('/stores/S1/expenses/receipts'));
    FakeXhr.last.status = 422;
    FakeXhr.last.responseText = JSON.stringify({ error: { code: 'validation_failed', message: 'Invalid', details: { file: ['Unsupported file type. Allowed: JPG, PNG, WebP, PDF.'] } } });
    FakeXhr.last.onload!();
    expect(await within(card).findByText('Unsupported file type. Allowed: JPG, PNG, WebP, PDF.')).toBeInTheDocument();

    const firstXhr = FakeXhr.last;
    fireEvent.change(within(card).getByLabelText('Add receipt photo'), { target: { files: [new File(['jpg'], 'receipt.jpg', { type: 'image/jpeg' })] } });
    await waitFor(() => expect(FakeXhr.last).not.toBe(firstXhr));
    await waitFor(() => expect(FakeXhr.last?.body?.get('file')).toBeTruthy());
    FakeXhr.last.status = 201;
    FakeXhr.last.responseText = JSON.stringify({ data: { id: 'RCPT1', mime: 'image/jpeg', size_bytes: 3, status: 'processing', created_at: '' } });
    FakeXhr.last.onload!();
    expect(await within(card).findByText('receipt.jpg')).toBeInTheDocument();
    expect(within(card).getByText('Processing…')).toBeInTheDocument();

    await userEvent.type(within(card).getByLabelText('Amount'), '500');
    await userEvent.click(within(card).getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(body).toMatchObject({ amount: 50000, receipt_id: 'RCPT1' }));
  });

  it('a file over 5 MB is refused before upload', async () => {
    signedIn('owner', expenseRoutes());
    renderApp(<AppRoutes />, { route: '/reports/expenses' });
    const card = await screen.findByRole('region', { name: 'Add expense' }, SLOW);
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'scan.pdf', { type: 'application/pdf' });
    fireEvent.change(within(card).getByLabelText('Add receipt photo'), { target: { files: [big] } });
    expect(await within(card).findByText('The file may not be larger than 5 MB.')).toBeInTheDocument();
  });

  it('row click → Edit expense; PATCH; repeat off; receipt removal; delete with confirm', async () => {
    let patch: Record<string, unknown> | null = null;
    const fetchMock = signedIn('owner', {
      ...expenseRoutes(),
      'PATCH /stores/S1/expenses/E4': (init) => {
        patch = JSON.parse(String(init.body));
        return jsonResponse(200, { data: expenses[3] });
      },
      'PATCH /stores/S1/expenses/E1': (init) => {
        patch = JSON.parse(String(init.body));
        return jsonResponse(200, { data: expenses[0] });
      },
      'DELETE /stores/S1/expenses/E1': new Response(null, { status: 204 }),
    });
    renderApp(<AppRoutes />, { route: '/reports/expenses' });
    const table = await screen.findByRole('table', { name: 'Expenses this month' }, SLOW);
    await userEvent.click(within(table).getByText('Mirpur store room + internet'));
    const card = await screen.findByRole('region', { name: 'Edit expense' });
    expect(within(card).getByLabelText('Amount')).toHaveValue('12200');
    expect(within(card).getByRole('switch', { name: 'Repeat every month' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.clear(within(card).getByLabelText('Amount'));
    await userEvent.type(within(card).getByLabelText('Amount'), '12500');
    await userEvent.click(within(card).getByRole('switch', { name: 'Repeat every month' }));
    await userEvent.click(within(card).getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(patch).toEqual({ amount: 1250000, category: 'rent_bills', paid_from: 'bkash', spent_on: expenses[3]!.spent_on, note: 'Mirpur store room + internet', repeat_monthly: false }));
    expect(await screen.findByRole('region', { name: 'Add expense' })).toBeInTheDocument();

    await userEvent.click(within(table).getByText('Facebook boost · Winter Jamdani'));
    const edit = await screen.findByRole('region', { name: 'Edit expense' });
    await userEvent.click(within(edit).getByRole('button', { name: 'Remove receipt' }));
    await userEvent.click(within(edit).getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(patch).toMatchObject({ receipt_id: null }));

    await userEvent.click(within(table).getByText('Facebook boost · Winter Jamdani'));
    await userEvent.click(within(await screen.findByRole('region', { name: 'Edit expense' })).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete expense' }));
    await waitFor(() => expect(byMethod(fetchMock, '/stores/S1/expenses/E1', 'DELETE')).toHaveLength(1));
  });

  it('receipt link opens the signed URL; 409 shows Processing…', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    signedIn('owner', {
      ...expenseRoutes(),
      'GET /stores/S1/expenses/E1/receipt': jsonResponse(200, { data: { url: 'https://api/x/download?signature=1', mime: 'image/jpeg', size_bytes: 1, expires_at: '' } }),
      'GET /stores/S1/expenses/E5/receipt': jsonResponse(409, { error: { code: 'receipt_processing', message: 'Still processing' } }),
    });
    renderApp(<AppRoutes />, { route: '/reports/expenses' });
    const table = await screen.findByRole('table', { name: 'Expenses this month' }, SLOW);
    const [first, second] = within(table).getAllByRole('button', { name: 'Receipt attached' });
    await userEvent.click(first!);
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://api/x/download?signature=1', '_blank', 'noopener,noreferrer'));
    expect(screen.queryByRole('region', { name: 'Edit expense' })).not.toBeInTheDocument();
    await userEvent.click(second!);
    expect(await within(table).findByText('Receipt processing…')).toBeInTheDocument();
  });

  it('a processing receipt is polled until it is ready (§10.1)', async () => {
    let calls = 0;
    const meta = { next_cursor: null, prev_cursor: null, per_page: 50 };
    signedIn('owner', expenseRoutes({
      'GET /stores/S1/expenses': () => {
        calls += 1;
        const status = calls === 1 ? 'processing' : 'ready';
        return jsonResponse(200, { data: [expense({ receipt: { id: 'M1', mime: 'image/jpeg', size_bytes: 1, status } })], meta });
      },
    }));
    renderApp(<AppRoutes />, { route: '/reports/expenses' });
    const table = await screen.findByRole('table', { name: 'Expenses this month' }, SLOW);
    expect(await within(table).findByText('Receipt processing…')).toBeInTheDocument();
    expect(await within(table).findByRole('button', { name: 'Receipt attached' }, { timeout: 6000 })).toBeInTheDocument();
    const settled = calls;
    await new Promise((r) => setTimeout(r, 3500));
    expect(calls).toBe(settled); // no more polling once every receipt is ready
  }, 15_000);

  it('Export CSV downloads the month', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const fetchMock = signedIn('owner', {
      ...expenseRoutes(),
      'GET /stores/S1/expenses/export': new Response('date,category\n', { status: 200, headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="expenses-mugdho-${MONTH}.csv"` } }),
    });
    renderApp(<AppRoutes />, { route: '/reports/expenses' });
    await screen.findByRole('table', { name: 'Expenses this month' }, SLOW);
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(callsTo(fetchMock, '/stores/S1/expenses/export')).toHaveLength(1));
    expect(new URL(callsTo(fetchMock, '/stores/S1/expenses/export')[0]![0], 'http://x').searchParams.get('month')).toBe(MONTH);
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
  });
});

describe('Store details currency lock (§6.4)', () => {
  it('locked: Currency select disabled with the note', async () => {
    signedIn('owner', { 'GET /stores/S1/settings': jsonResponse(200, { data: settingsFixture({ region: { country: 'BD', currency: 'BDT', timezone: 'Asia/Dhaka', currency_locked: true } }) }) });
    renderApp(<AppRoutes />, { route: '/settings/store' });
    const select = await screen.findByLabelText('Currency', undefined, SLOW);
    expect(select).toBeDisabled();
    expect(screen.getByText('Locked after your first order or expense.')).toBeInTheDocument();
  });

  it('unlocked: editable; a 409 currency_locked shows the message on the field', async () => {
    signedIn('owner', {
      'GET /stores/S1/settings': jsonResponse(200, { data: settingsFixture({ region: { country: 'BD', currency: 'BDT', timezone: 'Asia/Dhaka', currency_locked: false } }) }),
      'PATCH /stores/S1/settings': jsonResponse(409, { error: { code: 'currency_locked', message: 'Your shop’s currency can’t be changed after the first order or expense.' } }),
    });
    renderApp(<AppRoutes />, { route: '/settings/store' });
    const select = await screen.findByLabelText('Currency', undefined, SLOW);
    expect(select).not.toBeDisabled();
    expect(screen.queryByText('Locked after your first order or expense.')).not.toBeInTheDocument();
    await userEvent.selectOptions(select, 'USD');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Your shop’s currency can’t be changed after the first order or expense.')).toBeInTheDocument();
  });
});
