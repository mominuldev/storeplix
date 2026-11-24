import { STOCK_COUNT_LINE_STATES, type StockCountDetail, type StockCountLine, type StockCountLineState } from '@storeplix/types';
import { Badge, Button, Chip, cn, DataTable, Dialog, Menu, Pagination, Toggle, type DataTableColumn } from '@storeplix/ui';
import { ChevronRight, MoreHorizontal, ScanBarcode, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { dateTime, formatCount, plural } from '../../catalog/format';
import { useStoreScope } from '../../catalog/scope';
import { ErrorBlock, LoadingRows, NoResults, StateCard } from '../../catalog/states';
import { Cell2 } from '../../catalog/ui';
import { clock, newIdempotencyKey } from '../../commerce/format';
import { ReadOnlyActions } from '../../impersonation/ReadOnlyActions';
import { toast } from '../../online-store/components/Toast';
import { variantText } from '../transfers/transfers';
import { countError, countPill, countProgress, differencePill, lineExpected, parseCounted, scanCode, signedMoney, summaryLines, useCount, useCountLines, useCountMutations } from './counts';

// PHASE-8-8C §10.5 Stock count — Figma 153:35246: header 153:35251 ("{name}", breadcrumb "Inventory › Stock counts ·
// started {date} by {name}", Finish & adjust stock + Cancel count menu), progress 153:35844, count card 153:35853 (SKU /
// barcode box 153:35854 — Enter submits, focus kept, unknown code message; chips 153:35864; table 153:35907 with
// click-to-edit COUNTED, composed), "If you finish now" 153:35960 (values only with costs.view), "When you finish"
// 153:35977 with only "Set uncounted items to 0". Hidden: Pause, Scanner ready, Record shortage as expense, Lock online
// sales while counting. Completed / cancelled counts open read-only. Mobile: table → cards, SKU box sticky.

/** "20 Nov 09:00" (153:35251). */
const shortDateTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${clock(iso)}`;
};

const chipLabel: Record<'all' | StockCountLineState, string> = { all: 'All', not_counted: 'Not counted', differences: 'Differences', matched: 'Matched' };

export default function CountPage() {
  const { id } = useParams();
  const scope = useStoreScope();
  const count = useCount(id);
  if (count.isPending) return <LoadingRows label="Loading count" />;
  if (count.isError)
    return (
      <StateCard>
        <ErrorBlock error={count.error} title="We couldn’t load this count" onRetry={() => void count.refetch()} />
      </StateCard>
    );
  return <CountScreen count={count.data} canWrite={scope.canAdjustInventory} withValues={scope.canViewCosts} />;
}

function CountScreen({ count, canWrite, withValues }: { count: StockCountDetail; canWrite: boolean; withValues: boolean }) {
  const navigate = useNavigate();
  const open = count.status === 'in_progress';
  const editable = open && canWrite;
  const [state, setState] = useState<StockCountLineState | null>(null);
  const [page, setPage] = useState(1);
  const lines = useCountLines(count.id, { state: state ?? undefined, page, per_page: 100 });
  const m = useCountMutations(count.id);
  const [zero, setZero] = useState(false);
  const [confirm, setConfirm] = useState<'finish' | 'cancel' | null>(null);
  const finishKey = useRef(newIdempotencyKey());
  const progress = countProgress(count);
  const sum = summaryLines(count.summary, withValues);
  const pill = countPill(count.status);
  const counts = lines.data?.meta.counts;

  const finish = () =>
    m.finish.mutate(
      { input: { zero_uncounted: zero, revision: count.revision }, key: finishKey.current },
      {
        onSuccess: () => {
          setConfirm(null);
          finishKey.current = newIdempotencyKey();
          toast(`Stock at ${count.location.name} adjusted.`);
        },
        onError: (e) => {
          setConfirm(null);
          toast(countError(e, 'We couldn’t finish this count.'), 'error');
        },
      },
    );
  const cancel = () =>
    m.cancel.mutate(count.revision, {
      onSuccess: () => {
        setConfirm(null);
        toast('Count cancelled. Stock didn’t change.');
        navigate('/inventory/counts');
      },
      onError: (e) => {
        setConfirm(null);
        toast(countError(e, 'We couldn’t cancel this count.'), 'error');
      },
    });

  const rows = lines.data?.data ?? [];
  const meta = lines.data?.meta;
  const columns: DataTableColumn<StockCountLine>[] = [
    {
      key: 'product',
      header: 'Product',
      mobileLabel: false,
      cell: (l) => <Cell2 top={l.variant.product.name} bottom={[variantText(l.variant.title), l.variant.sku].filter(Boolean).join(' · ') || undefined} />,
    },
    { key: 'expected', header: 'Expected', width: 80, align: 'end', cell: (l) => <span className="text-body text-text-primary">{formatCount(lineExpected(l))}</span> },
    { key: 'counted', header: 'Counted', width: 90, align: 'end', cell: (l) => <CountedCell line={l} editable={editable} onSave={(v) => m.setLine.mutateAsync({ lineId: l.id, input: { counted: v } })} /> },
    {
      key: 'difference',
      header: 'Difference',
      width: 96,
      cell: (l) => {
        const d = differencePill(l);
        return d ? (
          <Badge size="sm" tone={d.tone} dot>
            {d.label}
          </Badge>
        ) : (
          <span className="text-body text-text-muted">—</span>
        );
      },
    },
    ...(withValues
      ? ([
          {
            key: 'value',
            header: 'Value',
            width: 100,
            align: 'end',
            cell: (l) => <span className={cn('text-body', (l.value_amount ?? 0) < 0 ? 'text-danger' : (l.value_amount ?? 0) > 0 ? 'text-info' : 'text-text-muted')}>{signedMoney(l.value_amount)}</span>,
          },
        ] satisfies DataTableColumn<StockCountLine>[])
      : []),
  ];

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="flex flex-wrap items-center gap-2 text-heading-24 text-text-primary">
            {count.name}
            {!open && (
              <Badge tone={pill.tone} dot>
                {pill.label}
              </Badge>
            )}
          </h1>
          <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-body text-text-secondary">
            <Link to="/inventory" className="hover:text-text-primary">
              Inventory
            </Link>
            <ChevronRight aria-hidden className="size-3.5" />
            <Link to="/inventory/counts" className="hover:text-text-primary">
              Stock counts
            </Link>
            <span>
              · started {shortDateTime(count.started_at)}
              {count.started_by ? ` by ${count.started_by.name}` : ''}
            </span>
          </nav>
        </div>
        {editable && (
          <ReadOnlyActions className="flex shrink-0 items-center gap-3">
            <Menu
              label="Count actions"
              trigger={<MoreHorizontal aria-hidden className="size-4" />}
              triggerClassName="size-10 rounded-md border border-border-default bg-surface-card"
              entries={[{ key: 'cancel', label: 'Cancel count', hint: 'Stock doesn’t change', icon: <X />, danger: true, onSelect: () => setConfirm('cancel') }]}
            />
            <Button onClick={() => setConfirm('finish')}>Finish &amp; adjust stock</Button>
          </ReadOnlyActions>
        )}
      </div>

      <section aria-label="Progress" className="flex flex-col gap-2.5 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1">
        <div className="flex items-center gap-3 text-body-lg font-medium">
          <span className="min-w-0 flex-1 text-text-primary">
            {progress.text}
            {count.location ? <span className="sr-only"> at {count.location.name}</span> : null}
          </span>
          <span className="text-brand-600">{progress.pct}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-surface-subtle" role="progressbar" aria-label="Counted" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.pct}>
          <div className="h-2 rounded-full bg-brand-500" style={{ width: `${progress.pct}%` }} />
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_350px] xl:items-start">
        <section aria-label="Count" className="flex min-w-0 flex-col gap-4 rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1 sm:p-6">
          {editable && <ScanBox countId={count.id} />}
          <div role="group" aria-label="Line filter" className="-mx-1 flex min-w-0 gap-2 overflow-x-auto px-1 py-0.5">
            {(['all', ...STOCK_COUNT_LINE_STATES] as const).map((c) => {
              const n = counts?.[c];
              const on = c === 'all' ? state === null : state === c;
              return (
                <Chip
                  key={c}
                  check={false}
                  selected={on}
                  onClick={() => {
                    setState(c === 'all' ? null : c);
                    setPage(1);
                  }}
                  className="shrink-0"
                >
                  {n === undefined || c === 'all' ? chipLabel[c] : `${chipLabel[c]} · ${formatCount(n)}`}
                </Chip>
              );
            })}
          </div>
          <DataTable
            label="Count lines"
            className={cn('shadow-none', lines.isPlaceholderData && 'opacity-60')}
            columnGap={16}
            columns={columns}
            rows={rows}
            getRowId={(l) => l.id}
            state={
              lines.isPending ? (
                <LoadingRows label="Loading products" />
              ) : lines.isError ? (
                <ErrorBlock error={lines.error} onRetry={() => void lines.refetch()} />
              ) : rows.length === 0 ? (
                <NoResults title={state ? `No ${chipLabel[state].toLowerCase()} products` : 'No products in this count'} onClear={state ? () => setState(null) : undefined} clearLabel="Show all" />
              ) : undefined
            }
            footer={meta && meta.total > meta.per_page && <Pagination page={meta.current_page} perPage={meta.per_page} total={meta.total} lastPage={meta.last_page} noun="products" onPage={setPage} />}
          />
        </section>

        <div className="flex min-w-0 flex-col gap-6">
          <section aria-label={open ? 'If you finish now' : 'Result'} className="flex flex-col gap-3 rounded-card border border-border-default bg-surface-card p-6 shadow-elevation-1">
            <h2 className="text-body-lg font-medium text-text-primary">{open ? 'If you finish now' : 'Result'}</h2>
            <SummaryRow label="Short" value={sum.short} className="text-danger" />
            <SummaryRow label="Extra" value={sum.extra} className="text-info" />
            <SummaryRow label={open ? 'Not counted yet' : 'Not counted'} value={sum.notCounted} className="text-warning" />
            {sum.net && (
              <>
                <div className="h-px bg-border-default" />
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 text-body-lg font-medium text-text-primary">{sum.net.label}</span>
                  <span className={cn('text-heading whitespace-nowrap', sum.net.tone === 'danger' ? 'text-danger' : sum.net.tone === 'info' ? 'text-info' : 'text-text-primary')}>{sum.net.value}</span>
                </div>
              </>
            )}
          </section>
          <section aria-label="When you finish" className="flex flex-col gap-3 rounded-card border border-border-default bg-surface-card p-6 shadow-elevation-1">
            <h2 className="text-body-lg font-medium text-text-primary">{open ? 'When you finish' : 'Uncounted items'}</h2>
            {open ? (
              <div className="flex items-center gap-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-body font-medium text-text-primary">Set uncounted items to 0</span>
                  <span className="text-caption text-text-muted">{zero ? `On: ${plural(count.summary.not_counted, 'variant')} go to 0` : 'Off: they keep their current stock'}</span>
                </div>
                <Toggle label="Set uncounted items to 0" checked={zero} onChange={setZero} disabled={!editable} />
              </div>
            ) : (
              <p className="text-body text-text-secondary">
                {count.status === 'cancelled' ? 'This count was cancelled. Stock didn’t change.' : count.zero_uncounted ? 'Uncounted items were set to 0.' : 'Uncounted items kept their stock.'}
                {count.finished_at ? ` Finished ${dateTime(count.finished_at)}${count.finished_by ? ` by ${count.finished_by.name}` : ''}.` : ''}
              </p>
            )}
          </section>
        </div>
      </div>

      <Dialog
        open={confirm === 'finish'}
        title="Finish & adjust stock?"
        description={`Stock at ${count.location.name} changes by the difference on every counted product. Sales made since a product was counted are kept.`}
        confirmLabel="Finish & adjust stock"
        loading={m.finish.isPending}
        onConfirm={finish}
        onCancel={() => setConfirm(null)}
      >
        <ul aria-label="Finish summary" className="flex flex-col gap-2 text-body">
          <li className="flex justify-between gap-3">
            <span className="text-text-secondary">Short</span>
            <span className="font-medium text-danger">{sum.short}</span>
          </li>
          <li className="flex justify-between gap-3">
            <span className="text-text-secondary">Extra</span>
            <span className="font-medium text-info">{sum.extra}</span>
          </li>
          <li className="flex justify-between gap-3">
            <span className="text-text-secondary">Not counted</span>
            <span className="font-medium text-text-primary">
              {sum.notCounted} · {zero ? 'set to 0' : 'keep stock'}
            </span>
          </li>
          {sum.net && (
            <li className="flex justify-between gap-3">
              <span className="text-text-secondary">{sum.net.label}</span>
              <span className={cn('font-semibold', sum.net.tone === 'danger' ? 'text-danger' : 'text-text-primary')}>{sum.net.value}</span>
            </li>
          )}
        </ul>
      </Dialog>
      <Dialog
        open={confirm === 'cancel'}
        title="Cancel this count?"
        description="Counted numbers are discarded and stock doesn’t change."
        confirmLabel="Cancel count"
        cancelLabel="Keep counting"
        tone="danger"
        loading={m.cancel.isPending}
        onConfirm={cancel}
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}

function SummaryRow({ label, value, className }: { label: string; value: string; className: string }) {
  return (
    <div className="flex items-center gap-3 text-body">
      <span className="min-w-0 flex-1 text-text-secondary">{label}</span>
      <span className={cn('font-medium whitespace-nowrap', className)}>{value}</span>
    </div>
  );
}

/** SKU / barcode box 153:35854: Enter → scan (+1); the input keeps focus; result or unknown-code message below. */
function ScanBox({ countId }: { countId: string }) {
  const { scan } = useCountMutations(countId);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const submit = () => {
    const c = scanCode(code);
    if (!c) return;
    setCode('');
    scan.mutate(
      { code: c },
      {
        onSuccess: (r) => setMsg({ text: `+1 · ${r.line.variant.product.name}${variantText(r.line.variant.title) ? ` ${variantText(r.line.variant.title)}` : ''} · counted ${formatCount(r.line.counted ?? 0)}`, tone: 'ok' }),
        onError: (e) => setMsg({ text: countError(e, 'We couldn’t record this scan.'), tone: 'error' }),
        onSettled: () => ref.current?.focus(),
      },
    );
    ref.current?.focus();
  };
  return (
    <div className="sticky top-0 z-10 -mx-1 flex flex-col gap-1.5 bg-surface-card px-1 py-1 md:static md:mx-0 md:p-0">
      <label className="flex items-center gap-2.5 rounded-xl border border-brand-500 bg-brand-50 px-3.5 py-3 focus-within:shadow-focus">
        <ScanBarcode aria-hidden className="size-5 shrink-0 text-brand-600" />
        <input
          ref={ref}
          autoFocus
          value={code}
          maxLength={64}
          aria-label="SKU or barcode"
          placeholder="Type or scan a SKU — each scan adds 1"
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-body text-text-primary outline-none placeholder:text-brand-600"
        />
      </label>
      {msg && (
        <p role={msg.tone === 'error' ? 'alert' : 'status'} className={cn('text-caption', msg.tone === 'error' ? 'text-danger' : 'text-success')}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

/** COUNTED (composed): number; click to edit, Enter / blur saves, Escape cancels; empty = not counted. */
function CountedCell({ line, editable, onSave }: { line: StockCountLine; editable: boolean; onSave: (v: number | null) => Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const name = `${line.variant.product.name}${variantText(line.variant.title) ? ` ${variantText(line.variant.title)}` : ''}`;
  const shown = line.counted === null ? '—' : formatCount(line.counted);
  if (!editable) return <span className="text-body text-text-primary">{shown}</span>;
  if (!editing)
    return (
      <button
        type="button"
        aria-label={`Edit counted for ${name}`}
        onClick={() => {
          setText(line.counted === null ? '' : String(line.counted));
          setError(null);
          setEditing(true);
        }}
        className="min-w-10 rounded-md px-2 py-1 text-right text-body text-text-primary outline-none hover:bg-surface-subtle focus-visible:shadow-focus"
      >
        {shown}
      </button>
    );
  const save = () => {
    const v = parseCounted(text);
    if (v === undefined) return setError('0–1,000,000');
    if (v === line.counted) return setEditing(false);
    onSave(v)
      .then(() => setEditing(false))
      .catch((e: unknown) => setError(countError(e, 'Not saved')));
  };
  return (
    <span className="flex flex-col items-end gap-0.5">
      <input
        autoFocus
        type="text"
        inputMode="numeric"
        aria-label={`Counted for ${name}`}
        aria-invalid={!!error || undefined}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setEditing(false);
          }
        }}
        className="h-8 w-20 rounded-md border border-border-default bg-surface-card px-2 text-right text-body text-text-primary outline-none focus-visible:border-brand-600 focus-visible:shadow-focus aria-invalid:border-danger"
      />
      {error && <span className="text-caption text-danger">{error}</span>}
    </span>
  );
}
