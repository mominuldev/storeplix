import { isApiError } from '@storeplix/api-client';
import { EXPENSE_CATEGORIES, PAID_FROM_LABELS, type Expense, type ExpenseCategory, type ExpenseSummary } from '@storeplix/types';
import { Badge, Button, Chip, chartToneClass, cn, EmptyState, formatBdt, KpiTile, Select, Skeleton } from '@storeplix/ui';
import { BarChart3, CreditCard, Megaphone, Package, Receipt } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { saveFile } from '../catalog/download';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, LoadingRows } from '../catalog/states';
import { ReadOnlyActions } from '../impersonation/ReadOnlyActions';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { ReportTabs } from '../reports/ReportsPage';
import { localToday } from '../reports/range';
import { ExpenseForm } from './ExpenseForm';
import { categoryBars, categoryBarTone, categoryLabel, categoryTone, compareLine, isCategory, isMonth, monthLabel, monthName, sharePct, shortDate, totalRow } from './expenses';
import { useExpenseList, useExpenseSummary } from './queries';

// PHASE-8-7 §10.1 Expenses — section 144:41613, frame 144:41614. Reports tab bar (composed, P87-16) above the page
// header 144:41619; KPI tiles 144:42211; list card 144:42264 (toolbar 144:42265, table 144:42315, total 144:42390);
// side column 144:42393 (Add expense 144:42394, By category 144:42444). Below lg (Q180): KPI tiles 2-up, the add card
// collapses behind "+ Add expense" and opens above the list, the table becomes cards, By category under the list.

const FORM_ID = 'expense-form';
const bdt = (paisa: number | null | undefined) => formatBdt(paisa);

export default function ExpensesPage() {
  const scope = useStoreScope();
  const [params, setParams] = useSearchParams();
  const today = localToday(scope.store?.timezone);
  const current = today.slice(0, 7);
  const rawMonth = params.get('month');
  const month = isMonth(rawMonth) && rawMonth <= current ? rawMonth : current;
  const rawCategory = params.get('category');
  const category: ExpenseCategory | null = isCategory(rawCategory) ? rawCategory : null;
  const summary = useExpenseSummary(month);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const setFilter = (next: { month?: string; category?: ExpenseCategory | null }) => {
    const m = next.month ?? month;
    const c = next.category === undefined ? category : next.category;
    setParams({ ...(m !== current ? { month: m } : {}), ...(c ? { category: c } : {}) });
  };

  const focusForm = () =>
    requestAnimationFrame(() => {
      const el = document.getElementById(FORM_ID);
      el?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      el?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    });
  const startAdd = () => {
    setEditing(null);
    setFormOpen(true);
    focusForm();
  };
  const startEdit = (e: Expense) => {
    setEditing(e);
    setFormOpen(true);
    focusForm();
  };
  const closeForm = () => {
    setEditing(null);
    setFormOpen(false);
  };

  const exportCsv = async () => {
    if (!scope.storeId) return;
    setExporting(true);
    try {
      saveFile(await api.expenses.exportCsv(scope.storeId, month));
    } catch (e) {
      toast(isApiError(e) ? e.message : 'Export failed. Try again.', 'error');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <ReportTabs value="expenses" />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="text-heading-24 text-text-primary">Expenses</h1>
          <p className="text-body text-text-secondary">Ads, packaging, rent, salaries — add them here so your profit is real profit.</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          {/* P87-14: the CSV export stays readable in a support session; only the write action is read-only. */}
          <Button variant="secondary" loading={exporting} onClick={() => void exportCsv()}>
            Export CSV
          </Button>
          <ReadOnlyActions>
            <Button onClick={startAdd}>+ Add expense</Button>
          </ReadOnlyActions>
        </div>
      </div>

      {summary.isPending ? (
        <KpiLoading />
      ) : summary.isError ? (
        <section className="rounded-card border border-border-default bg-surface-card shadow-elevation-1">
          <ErrorBlock error={summary.error} title="We couldn’t load your expenses" onRetry={() => void summary.refetch()} />
        </section>
      ) : (
        <Kpis s={summary.data} month={month} />
      )}

      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:grid-rows-[auto_1fr] lg:items-start">
        <div className={cn('lg:col-start-2 lg:row-start-1', !formOpen && 'max-lg:hidden')}>
          <ExpenseForm key={editing?.id ?? 'new'} id={FORM_ID} editing={editing} today={today} onDone={closeForm} />
        </div>
        <ExpenseList
          className="lg:col-start-1 lg:row-span-2 lg:row-start-1"
          month={month}
          category={category}
          summary={summary.data}
          editingId={editing?.id ?? null}
          onMonth={(m) => setFilter({ month: m, category })}
          onCategory={(c) => setFilter({ category: c })}
          onEdit={startEdit}
          onAdd={startAdd}
        />
        <div className="lg:col-start-2 lg:row-start-2">{summary.data && <ByCategory s={summary.data} />}</div>
      </div>
    </div>
  );
}

function KpiLoading() {
  return (
    <div role="status" aria-label="Loading expenses" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1">
          <Skeleton className="h-4 w-2/3 rounded-full" />
          <Skeleton className="h-7 w-1/2" />
          <Skeleton className="h-3 w-3/4 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function Kpis({ s, month }: { s: ExpenseSummary; month: string }) {
  const cmp = compareLine(s.compare);
  const showProfit = s.profit_after_expenses_amount !== null;
  return (
    <section aria-label="Expenses summary" className={cn('grid grid-cols-2 gap-3 sm:gap-4', showProfit ? 'xl:grid-cols-4' : 'xl:grid-cols-3')}>
      <KpiTile
        icon={<CreditCard aria-hidden />}
        label={`Spent in ${monthName(month)}`}
        value={bdt(s.total_amount)}
        hint={cmp ? <span className={cmp.text.startsWith('↑') ? 'text-danger' : cmp.text.startsWith('↓') ? 'text-success' : undefined}>{cmp.text}</span> : undefined}
      />
      {/* 144:42224 composed: "Facebook ads" → "Ads" (Q178). */}
      <KpiTile icon={<Megaphone aria-hidden />} label="Ads" value={bdt(s.ads_amount)} hint={s.ads_share === null ? 'No expenses yet' : `${sharePct(s.ads_share)} of expenses`} />
      {showProfit && (
        <Link to={`/reports/profit?from=${s.from}&to=${s.to}`} className="flex min-w-0 rounded-card outline-none focus-visible:shadow-focus [&>div]:flex-1 [&>div]:hover:border-brand-100">
          <KpiTile icon={<BarChart3 aria-hidden />} label="Profit after expenses" value={bdt(s.profit_after_expenses_amount)} hint="Delivered sales − costs" />
        </Link>
      )}
      <KpiTile
        icon={<Package aria-hidden />}
        label="Cost per order"
        value={s.cost_per_order_amount === null ? '—' : bdt(s.cost_per_order_amount)}
        hint={`${s.delivered_orders_count.toLocaleString('en-IN')} delivered ${s.delivered_orders_count === 1 ? 'order' : 'orders'}`}
      />
    </section>
  );
}

function ByCategory({ s }: { s: ExpenseSummary }) {
  const bars = categoryBars(s);
  return (
    <section aria-label="By category" className="flex flex-col gap-3 rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1 sm:p-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-body-lg font-medium text-text-primary">By category</h2>
        <p className="text-body text-text-secondary">{monthName(s.month)}</p>
      </div>
      {bars.length === 0 ? (
        <p className="text-body text-text-muted">Nothing spent yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {bars.map((b) => (
            <li key={b.category} className="flex flex-col gap-1.5">
              <div className="flex items-start text-body text-text-primary">
                <span className="min-w-0 flex-1">{categoryLabel(b.category)}</span>
                <span className="font-medium whitespace-nowrap">{bdt(b.amount)}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-subtle" role="presentation">
                <div className={cn('h-1.5 rounded-full', chartToneClass(categoryBarTone[b.category]))} style={{ width: `${b.width}%` }} data-testid={`bar-${b.category}`} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ExpenseList({
  className,
  month,
  category,
  summary,
  editingId,
  onMonth,
  onCategory,
  onEdit,
  onAdd,
}: {
  className?: string;
  month: string;
  category: ExpenseCategory | null;
  summary: ExpenseSummary | undefined;
  editingId: string | null;
  onMonth: (m: string) => void;
  onCategory: (c: ExpenseCategory | null) => void;
  onEdit: (e: Expense) => void;
  onAdd: () => void;
}) {
  const list = useExpenseList(month, category);
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const months = Array.from(new Set([month, ...(summary?.months ?? [])])).sort().reverse();
  const total = summary ? totalRow(summary, category) : null;

  return (
    <section aria-label="Expenses" className={cn('flex min-w-0 flex-col gap-4 rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1 sm:p-6', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Month" value={month} onChange={(e) => onMonth(e.target.value)} containerClassName="shrink-0" className="h-10 rounded-md pl-3 font-medium">
          {months.map((m) => (
            <option key={m} value={m}>
              {monthLabel(m)}
            </option>
          ))}
        </Select>
        <div role="group" aria-label="Category" className="-mx-1 flex max-w-full gap-2 overflow-x-auto px-1 py-0.5">
          <Chip check={false} selected={category === null} onClick={() => onCategory(null)} className="shrink-0">
            All
          </Chip>
          {EXPENSE_CATEGORIES.map((c) => (
            <Chip key={c} check={false} selected={category === c} onClick={() => onCategory(category === c ? null : c)} className="shrink-0">
              {categoryLabel(c)}
            </Chip>
          ))}
        </div>
      </div>

      {list.isPending ? (
        <LoadingRows rows={6} label="Loading expenses" />
      ) : list.isError ? (
        <ErrorBlock error={list.error} title="We couldn’t load your expenses" onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Receipt />}
          title={category ? `No ${categoryLabel(category)} expenses in ${monthName(month)}` : `No expenses in ${monthName(month)}`}
          description="Add ads, packaging, rent and salaries so Profit & loss shows what you really keep."
          action={
            <ReadOnlyActions>
              <Button size="sm" onClick={onAdd}>
                Add expense
              </Button>
            </ReadOnlyActions>
          }
        />
      ) : (
        <>
          <div className={cn('overflow-hidden rounded-xl border border-border-default max-md:hidden', list.isPlaceholderData && 'opacity-60')}>
            <table aria-label="Expenses this month" className="w-full table-fixed text-body">
              <thead className="bg-surface-subtle text-caption font-medium text-text-muted uppercase">
                <tr>
                  <th scope="col" className="w-24 py-2.5 pr-4 pl-4 text-left font-medium">
                    Date
                  </th>
                  <th scope="col" className="w-[136px] px-4 py-2.5 text-left font-medium">
                    Category
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-left font-medium">
                    Note
                  </th>
                  <th scope="col" className="w-[110px] px-4 py-2.5 text-left font-medium max-xl:hidden">
                    Paid from
                  </th>
                  <th scope="col" className="w-28 py-2.5 pr-4 pl-4 text-right font-medium">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr
                    key={e.id}
                    tabIndex={0}
                    aria-label={`Edit ${categoryLabel(e.category)} expense of ${shortDate(e.spent_on)}`}
                    aria-current={editingId === e.id || undefined}
                    onClick={() => onEdit(e)}
                    onKeyDown={(k) => {
                      if (k.key === 'Enter' || k.key === ' ') {
                        k.preventDefault();
                        onEdit(e);
                      }
                    }}
                    className={cn('cursor-pointer border-t border-border-default outline-none hover:bg-surface-subtle focus-visible:bg-brand-50', editingId === e.id && 'bg-brand-50')}
                  >
                    <td className="py-3 pr-4 pl-4 whitespace-nowrap text-text-primary">{shortDate(e.spent_on)}</td>
                    <td className="px-4 py-3">
                      <Badge size="sm" tone={categoryTone[e.category]}>
                        {categoryLabel(e.category)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <NoteCell e={e} />
                    </td>
                    <td className="px-4 py-3 text-text-secondary max-xl:hidden">{PAID_FROM_LABELS[e.paid_from]}</td>
                    <td className="py-3 pr-4 pl-4 text-right font-semibold whitespace-nowrap text-text-primary">{bdt(e.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul aria-label="Expenses this month" className={cn('flex flex-col divide-y divide-border-default rounded-xl border border-border-default md:hidden', list.isPlaceholderData && 'opacity-60')}>
            {rows.map((e) => (
              <li key={e.id} className={cn('flex flex-col gap-1 px-3 py-3', editingId === e.id && 'bg-brand-50')}>
                <button
                  type="button"
                  onClick={() => onEdit(e)}
                  aria-label={`Edit ${categoryLabel(e.category)} expense of ${shortDate(e.spent_on)}`}
                  className="flex items-center gap-2 rounded-md text-left outline-none focus-visible:shadow-focus"
                >
                  <span className="text-body text-text-primary">{shortDate(e.spent_on)}</span>
                  <Badge size="sm" tone={categoryTone[e.category]}>
                    {categoryLabel(e.category)}
                  </Badge>
                  <span className="min-w-0 flex-1" />
                  <span className="text-body font-semibold whitespace-nowrap text-text-primary">{bdt(e.amount)}</span>
                </button>
                <NoteCell e={e} withPaidFrom />
              </li>
            ))}
          </ul>
          {list.hasNextPage && (
            <Button variant="secondary" size="sm" className="self-center" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              Show more
            </Button>
          )}
          {total && (
            <div className="flex items-center gap-3 px-4 py-1 text-body">
              <span className="min-w-0 flex-1 text-text-secondary">{total.label}</span>
              <span className="font-semibold whitespace-nowrap text-text-primary">Total {bdt(total.amount)}</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Note line 1, then "Receipt attached" (opens the 5-minute link, §5.3) and the composed "Repeats monthly" caption. */
function NoteCell({ e, withPaidFrom = false }: { e: Expense; withPaidFrom?: boolean }) {
  const scope = useStoreScope();
  const [state, setState] = useState<'idle' | 'opening' | 'processing'>('idle');
  const open = async (ev: React.MouseEvent) => {
    ev.stopPropagation();
    if (!scope.storeId) return;
    setState('opening');
    try {
      const link = await api.expenses.receiptLink(scope.storeId, e.id);
      window.open(link.url, '_blank', 'noopener,noreferrer');
      setState('idle');
    } catch (err) {
      if (isApiError(err) && err.code === 'receipt_processing') return setState('processing');
      setState('idle');
      toast(isApiError(err) ? err.message : 'We couldn’t open the receipt.', 'error');
    }
  };
  const extras = [withPaidFrom ? PAID_FROM_LABELS[e.paid_from] : null, e.repeat_monthly ? 'Repeats monthly' : null].filter(Boolean).join(' · ');
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className={cn('truncate', e.note ? 'text-text-primary' : 'text-text-muted')}>{e.note ?? categoryLabel(e.category)}</span>
      {(e.receipt || extras) && (
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-caption text-text-secondary">
          {e.receipt &&
            (state === 'processing' || e.receipt.status === 'processing' ? (
              <span className="text-text-muted">Receipt processing…</span>
            ) : (
              <button type="button" onClick={(ev) => void open(ev)} disabled={state === 'opening'} className="text-text-secondary underline-offset-2 outline-none hover:text-brand-600 hover:underline focus-visible:shadow-focus">
                Receipt attached
              </button>
            ))}
          {e.receipt && extras && <span aria-hidden>·</span>}
          {extras && <span>{extras}</span>}
        </span>
      )}
    </div>
  );
}

