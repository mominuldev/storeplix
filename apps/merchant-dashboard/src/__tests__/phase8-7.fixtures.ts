import type { Expense, ExpenseSummary } from '@storeplix/types';
import { localToday } from '../reports/range';
import { jsonResponse } from '../test/utils';
import { features } from './phase7.fixtures';

// PHASE-8-7 §8.2 shapes for the Expenses page (Figma 144:41614 sample data). Dates follow the real clock in the store
// timezone (Asia/Dhaka) so "today" and the current month match the page.

export const TODAY = localToday('Asia/Dhaka');
export const MONTH = TODAY.slice(0, 7);
const prevMonth = (ym: string) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};
export const PREV = prevMonth(MONTH);
const day = (d: number) => `${MONTH}-${String(Math.min(d, Number(TODAY.slice(8, 10)))).padStart(2, '0')}`;

export function expense(o: Partial<Expense> = {}): Expense {
  return {
    id: 'E1',
    category: 'ads',
    paid_from: 'card',
    amount: 800000,
    currency: 'BDT',
    spent_on: day(19),
    note: 'Facebook boost · Winter Jamdani',
    receipt: { id: 'M1', mime: 'image/jpeg', size_bytes: 120_000, status: 'ready' },
    repeat_monthly: false,
    recurrence_id: null,
    created_by: { id: 'U1', name: 'Rahim Ahmed' },
    created_at: '2026-11-19T10:00:00Z',
    updated_at: '2026-11-19T10:00:00Z',
    ...o,
  };
}

export const expenses: Expense[] = [
  expense(),
  expense({ id: 'E2', category: 'packaging', paid_from: 'cash', amount: 325000, spent_on: day(18), note: 'Poly mailers × 500, tape', receipt: null }),
  expense({ id: 'E3', category: 'salaries', paid_from: 'bank', amount: 1800000, spent_on: day(15), note: 'Nusrat, Rahim — half month', receipt: null }),
  expense({ id: 'E4', category: 'rent_bills', paid_from: 'bkash', amount: 1220000, spent_on: day(10), note: 'Mirpur store room + internet', receipt: null, repeat_monthly: true, recurrence_id: 'RC1' }),
  expense({ id: 'E5', category: 'courier', paid_from: 'cash', amount: 110000, spent_on: day(8), note: 'Return charges not on invoice', receipt: { id: 'M5', mime: 'application/pdf', size_bytes: 40_000, status: 'ready' } }),
];

export function summary(o: Partial<ExpenseSummary> = {}): ExpenseSummary {
  return {
    month: MONTH,
    from: `${MONTH}-01`,
    to: TODAY,
    currency: 'BDT',
    total_amount: 4255000,
    count: 5,
    ads_amount: 800000,
    ads_share: 0.188,
    by_category: [
      { category: 'salaries', amount: 1800000, count: 1, share: 0.423 },
      { category: 'rent_bills', amount: 1220000, count: 1, share: 0.2867 },
      { category: 'ads', amount: 800000, count: 1, share: 0.188 },
      { category: 'packaging', amount: 325000, count: 1, share: 0.0764 },
      { category: 'courier', amount: 110000, count: 1, share: 0.0259 },
    ],
    compare: { label_month: PREV, total_amount: 3800000, change_pct: 12 },
    delivered_orders_count: 612,
    cost_per_order_amount: 6952,
    profit_after_expenses_amount: 4123000,
    months: [MONTH, PREV],
    ...o,
  };
}

const growth = () => features({ plan_code: 'growth', features: { ...features().features, profit_reports: true } });

export function expenseRoutes(o: Record<string, Response | ((init: RequestInit) => Response)> = {}) {
  return {
    'GET /features': jsonResponse(200, { data: growth() }),
    'GET /stores/S1/expenses/summary': jsonResponse(200, { data: summary() }),
    'GET /stores/S1/expenses': jsonResponse(200, { data: expenses, meta: { next_cursor: null, prev_cursor: null, per_page: 50 } }),
    ...o,
  };
}
