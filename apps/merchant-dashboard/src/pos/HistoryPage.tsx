import type { PosPaidBy, PosSale, PosSaleListFilters, PosSalesDateFilter } from '@storeplix/types';
import { Badge, Button, cn, formatBdt, formatCount } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Phone, RotateCcw, Search, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage, LoadingRows, NoResults } from '../catalog/states';
import { Thumb, useDebounced } from '../catalog/ui';
import { clock } from '../commerce/format';
import { can } from '../lib/permissions';
import { api } from '../lib/api';
import { formatBdPhone } from '../lib/phone';
import { toast } from '../online-store/components/Toast';
import { handlePlanLimit } from '../plan/Banners';
import { PosBar, PrintArea, ReceiptView } from './components';
import { variantCaption, DATE_FILTERS, PAID_BY_LABELS, paidByTone, receiptTime, returnableOf, saleCustomerLine, salePill } from './pos';
import { printPos } from './print';
import { posKeys, usePosRegisters, usePosSale, usePosSales, usePosSession } from './queries';
import { ReturnDialog } from './ReturnDialog';

// PHASE-8-8D §11.7 Sales history 27:754 (part B): header "Sales history", "{register} · {location} · {date}", Back to
// sale; KPI tiles Sales today / Receipts / Average sale / Returns (meta.summary); filters "Receipt no. or phone"
// (exact), date (Today / Yesterday / Last 7 days / custom, composed), registers, methods; table RECEIPT · TIME ·
// CUSTOMER · ITEMS · PAID BY · TOTAL; detail panel (Receipt {number}, date · time · cashier · register, Paid / Partly
// refunded / Refunded pill, customer, lines, totals, Cash received / Change given, Reprint, Send SMS, Return items).
// Hidden: "Void receipt (manager PIN)"; "Return or exchange items" → "Return items" (Q250). A sale with returns shows a
// "Return" tag and the refunded amount (the list has one row per sale; there are no separate return rows).

const methodOptions: { value: '' | PosPaidBy; label: string }[] = [
  { value: '', label: 'All methods' },
  { value: 'cash', label: 'Cash' },
  { value: 'bkash_personal', label: 'bKash' },
  { value: 'card', label: 'Card' },
  { value: 'split', label: 'Split' },
];

const selectClass = 'h-10 rounded-md border border-border-default bg-surface-card px-3 text-body text-text-primary outline-none focus-visible:border-brand-600';

export default function HistoryPage() {
  const scope = useStoreScope();
  const [params, setParams] = useSearchParams();
  const sessionId = params.get('session') ?? undefined;
  const session = usePosSession(sessionId);
  const registers = usePosRegisters();
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.trim(), 300);
  const date = (DATE_FILTERS.find((d) => d.value === params.get('date'))?.value ?? 'today') as PosSalesDateFilter;
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const registerParam = params.get('register');
  // No param → the session's register; `all` → every register.
  const registerId = registerParam === 'all' ? '' : registerParam ?? session.data?.register.id ?? '';
  const method = (methodOptions.find((m) => m.value === params.get('method'))?.value ?? '') as '' | PosPaidBy;
  const selectedId = params.get('sale');

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  // API: with `q` the search covers every day, so the default "Today" isn't sent alongside a search.
  const searchAllDays = !!debounced && date === 'today' && !params.get('date');
  const rangeError = date === 'custom' && from && to && rangeDays(from, to) > 366 ? 'Pick a range of up to 366 days.' : null;
  const filters: PosSaleListFilters = {
    date: searchAllDays ? undefined : date,
    from: date === 'custom' ? from || undefined : undefined,
    to: date === 'custom' ? to || undefined : undefined,
    register_id: registerId || undefined,
    method: method || undefined,
    q: debounced || undefined,
  };
  const waitingForSession = !!sessionId && session.isPending && registerParam === null;
  const list = usePosSales(filters, !waitingForSession && !rangeError);
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const summary = list.data?.pages[0]?.meta.summary;
  const register = registers.data?.find((r) => r.id === registerId);
  const dateLabel = DATE_FILTERS.find((d) => d.value === date)?.label ?? 'Today';
  const subtitle = register ? `${register.name} · ${register.location.name} · ${dateLabel}` : `All registers · ${dateLabel}`;
  const backTo = sessionId && session.data?.status === 'open' ? `/pos/${sessionId}` : '/pos';
  const filtered = !!(debounced || method || date !== 'today' || registerParam !== null);

  return (
    <div className="flex flex-1 flex-col">
      <PosBar subtitle={subtitle}>
        <Link
          to={backTo}
          className="rounded-md border border-border-default bg-surface-card px-4 py-2 text-body font-semibold text-text-primary hover:bg-surface-subtle"
          data-testid="pos-back-to-sale"
        >
          Back to sale
        </Link>
      </PosBar>
      <h1 className="sr-only">Sales history</h1>
      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col gap-4 px-4 pt-5 pb-28 lg:px-6 lg:pb-6" aria-label="Sales history">
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" data-testid="pos-history-kpis">
            <Kpi label={date === 'today' ? 'Sales today' : 'Sales'} value={summary ? formatBdt(summary.sales_amount) : '—'} />
            <Kpi label="Receipts" value={summary ? formatCount(summary.receipts_count) : '—'} />
            <Kpi label="Average sale" value={summary ? formatBdt(summary.average_sale_amount) : '—'} />
            <Kpi label="Returns" value={summary ? `${formatCount(summary.returns_count)} · ${formatBdt(summary.returns_amount)}` : '—'} />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="flex h-10 min-w-[200px] flex-1 items-center gap-2 rounded-md border border-border-default bg-surface-card px-3 focus-within:border-brand-600 sm:max-w-[260px]">
              <Search aria-hidden className="size-4 text-text-muted" />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Receipt no. or phone"
                aria-label="Receipt no. or phone"
                className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-text-muted"
                data-testid="pos-history-search"
              />
            </label>
            <select
              aria-label="Date"
              className={selectClass}
              value={date}
              onChange={(e) => set({ date: e.target.value === 'today' ? null : e.target.value })}
              data-testid="pos-history-date"
            >
              {DATE_FILTERS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
            {rangeError && (
              <p className="w-full text-caption text-danger" role="alert">
                {rangeError}
              </p>
            )}
            {date === 'custom' && (
              <>
                <input type="date" aria-label="From" className={selectClass} value={from} max={to || undefined} onChange={(e) => set({ from: e.target.value })} />
                <input type="date" aria-label="To" className={selectClass} value={to} min={from || undefined} onChange={(e) => set({ to: e.target.value })} />
              </>
            )}
            <select
              aria-label="Register"
              className={selectClass}
              value={registerId}
              onChange={(e) => set({ register: e.target.value || 'all' })}
              data-testid="pos-history-register"
            >
              <option value="">All registers</option>
              {(registers.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {r.location.name}
                </option>
              ))}
            </select>
            <select aria-label="Payment method" className={selectClass} value={method} onChange={(e) => set({ method: e.target.value })} data-testid="pos-history-method">
              {methodOptions.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          {list.isPending ? (
            <LoadingRows rows={6} label="Loading sales" />
          ) : list.isError ? (
            <ErrorBlock error={list.error} title="We couldn’t load sales" onRetry={() => list.refetch()} />
          ) : rows.length === 0 ? (
            filtered ? (
              <NoResults
                title={debounced ? `No sales match “${debounced}”` : 'No sales match these filters'}
                description="Search by the full receipt number or phone, or try another date."
                onClear={() => {
                  setQ('');
                  setParams(sessionId ? new URLSearchParams({ session: sessionId }) : new URLSearchParams(), { replace: true });
                }}
                clearLabel="Clear filters"
              />
            ) : (
              <p
                className="rounded-card border border-border-default bg-surface-card py-12 text-center text-body text-text-muted shadow-elevation-1"
                data-testid="pos-history-empty"
              >
                No sales yet today
              </p>
            )
          ) : (
            <div className="overflow-hidden rounded-card border border-border-default bg-surface-card shadow-elevation-1">
              <table className="w-full border-collapse text-left" data-testid="pos-history-table">
                <thead>
                  <tr className="border-b border-border-default text-caption text-text-secondary uppercase">
                    <th scope="col" className="px-4 py-3 font-normal">
                      Receipt
                    </th>
                    <th scope="col" className="px-2 py-3 font-normal max-sm:hidden">
                      Time
                    </th>
                    <th scope="col" className="px-2 py-3 font-normal">
                      Customer · items
                    </th>
                    <th scope="col" className="px-2 py-3 font-normal max-md:hidden">
                      Paid by
                    </th>
                    <th scope="col" className="px-4 py-3 text-right font-normal">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      data-testid="pos-history-row"
                      aria-selected={r.id === selectedId}
                      onClick={() => set({ sale: r.id })}
                      className={cn('cursor-pointer border-b border-border-default last:border-0 hover:bg-surface-subtle', r.id === selectedId && 'bg-brand-50')}
                    >
                      <td className="px-4 py-3 text-body font-semibold text-text-primary">
                        <button type="button" className="outline-none focus-visible:underline" onClick={() => set({ sale: r.id })}>
                          {r.number}
                        </button>
                      </td>
                      <td className="px-2 py-3 text-body text-text-secondary max-sm:hidden">{clock(r.placed_at)}</td>
                      <td className="px-2 py-3 text-body text-text-primary">
                        <span className="flex flex-wrap items-center gap-2">
                          {saleCustomerLine(r)}
                          {r.refunded_amount > 0 && (
                            <Badge size="sm" tone="danger">
                              Return
                            </Badge>
                          )}
                        </span>
                      </td>
                      <td className="px-2 py-3 max-md:hidden">
                        <Badge size="sm" tone={paidByTone[r.paid_by]}>
                          {PAID_BY_LABELS[r.paid_by]}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="flex flex-col items-end">
                          <span className="text-body font-semibold text-text-primary">{formatBdt(r.total_amount)}</span>
                          {r.refunded_amount > 0 && <span className="text-caption text-danger">− {formatBdt(r.refunded_amount)}</span>}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {list.hasNextPage && (
                <div className="flex justify-center border-t border-border-default p-3">
                  <Button variant="secondary" size="sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                    {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
                  </Button>
                </div>
              )}
            </div>
          )}
        </section>

        {selectedId && (
          <aside
            className="fixed inset-0 z-30 flex flex-col overflow-y-auto bg-surface-card p-5 lg:static lg:z-auto lg:w-[390px] lg:shrink-0 lg:border-l lg:border-border-default"
            aria-label="Receipt detail"
            data-testid="pos-sale-detail"
          >
            <SaleDetail
              saleId={selectedId}
              sessionId={sessionId}
              sessionOpen={session.data?.status === 'open'}
              onClose={() => set({ sale: null })}
              canRefund={can.manageRefunds(scope.membership)}
            />
          </aside>
        )}
      </div>
    </div>
  );
}

/** Inclusive days between two YYYY-MM-DD dates. */
function rangeDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-card border border-border-default bg-surface-card px-4 py-3 shadow-elevation-1">
      <span className="text-caption text-text-secondary">{label}</span>
      <span className="text-heading text-text-primary">{value}</span>
    </div>
  );
}

function SaleDetail({
  saleId,
  sessionId,
  sessionOpen,
  canRefund,
  onClose,
}: {
  saleId: string;
  sessionId: string | undefined;
  sessionOpen: boolean;
  canRefund: boolean;
  onClose: () => void;
}) {
  const scope = useStoreScope();
  const qc = useQueryClient();
  const sale = usePosSale(saleId);
  const [returning, setReturning] = useState(false);
  const sms = useMutation({
    mutationFn: () => api.pos.sales.smsReceipt(scope.storeId!, saleId),
    onSuccess: (next) => {
      qc.setQueryData(posKeys.sale(scope, saleId), next);
      toast('SMS receipt sent.');
    },
    onError: (e) => handlePlanLimit(e) || toast(errorMessage(e, 'We couldn’t send the SMS receipt.'), 'error'),
  });

  if (sale.isPending) return <LoadingRows rows={6} label="Loading receipt" />;
  if (sale.isError) return <ErrorBlock error={sale.error} title="We couldn’t load this receipt" onRetry={() => sale.refetch()} />;
  const s: PosSale = sale.data;
  const pill = salePill(s);
  const r = s.receipt;
  const phone = r.customer?.phone || null;
  const returnable = s.order.items.some((i) => returnableOf(i) > 0);

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-heading-24 text-text-primary">Receipt {s.number}</h2>
          <p className="text-caption text-text-secondary">{[receiptTime(s.placed_at), s.cashier_name, s.register_name].join(' · ')}</p>
        </div>
        <Badge size="sm" tone={pill.tone} data-testid="pos-sale-pill">
          {pill.label}
        </Badge>
        <button
          type="button"
          aria-label="Close receipt"
          className="flex size-8 items-center justify-center rounded-md text-text-muted hover:bg-surface-subtle lg:hidden"
          onClick={onClose}
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>
      <div className="flex items-center gap-3 rounded-lg bg-surface-canvas px-3 py-2.5">
        <Phone aria-hidden className="size-4 text-text-secondary" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-body font-medium text-text-primary">{r.customer?.name || 'Walk-in customer'}</span>
          {phone && <span className="text-caption text-text-secondary">{formatBdPhone(phone)}</span>}
        </div>
      </div>
      <ul className="flex flex-col gap-2">
        {s.order.items.map((i) => (
          <li key={i.id} className="flex items-center gap-3">
            <Thumb src={i.image?.url ?? null} size={44} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-body font-semibold text-text-primary">{i.product_name}</span>
              <span className="text-caption text-text-secondary">
                {[variantCaption(i.variant_title), `Qty ${formatCount(i.quantity)}`, i.restocked_quantity > 0 ? `${formatCount(i.restocked_quantity)} returned` : null]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>
            <span className="text-body font-medium text-text-primary">{formatBdt(i.total_amount)}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2 rounded-lg bg-surface-canvas px-3.5 py-3 text-body">
        <Line label="Subtotal" value={formatBdt(r.subtotal_amount)} />
        {r.discount_amount > 0 && <Line label={`Discount${r.coupon_code ? ` · ${r.coupon_code}` : ''}`} value={`− ${formatBdt(r.discount_amount)}`} tone="success" />}
        <Line label="Total" value={formatBdt(r.total_amount)} strong />
        {s.tendered_cash_amount !== null && <Line label="Cash received" value={formatBdt(s.tendered_cash_amount)} />}
        {s.change_amount > 0 && <Line label="Change given" value={formatBdt(s.change_amount)} />}
        {s.refunded_amount > 0 && <Line label="Refunded" value={`− ${formatBdt(s.refunded_amount)}`} tone="danger" />}
      </div>
      <div className="flex-1" />
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" onClick={printPos} data-testid="pos-reprint">
          Reprint
        </Button>
        <Button variant="secondary" disabled={!phone || sms.isPending} onClick={() => sms.mutate()} data-testid="pos-send-sms">
          {sms.isPending ? 'Sending…' : 'Send SMS'}
        </Button>
      </div>
      {canRefund && returnable && (
        <>
          <Button className="min-h-12" disabled={!sessionId || !sessionOpen} onClick={() => setReturning(true)} data-testid="pos-return-items">
            <RotateCcw aria-hidden className="size-4" /> Return items
          </Button>
          {(!sessionId || !sessionOpen) && <p className="text-center text-caption text-text-muted">Open a register to take returns at the till.</p>}
        </>
      )}
      <PrintArea>
        <ReceiptView receipt={r} className="max-w-none p-2" />
      </PrintArea>
      {returning && sessionId && <ReturnDialog sale={s} sessionId={sessionId} onClose={() => setReturning(false)} />}
    </div>
  );
}

function Line({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: 'success' | 'danger' }) {
  return (
    <div className="flex">
      <span className={cn('flex-1', strong ? 'font-semibold text-text-primary' : 'text-text-secondary')}>{label}</span>
      <span className={cn(strong ? 'font-semibold' : 'font-medium', tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : 'text-text-primary')}>{value}</span>
    </div>
  );
}
