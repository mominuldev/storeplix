import { zodResolver } from '@hookform/resolvers/zod';
import type { Location, StockCount } from '@storeplix/types';
import { Badge, Button, cn, DataTable, Dialog, EmptyState, Input, Pagination, Select, type DataTableColumn } from '@storeplix/ui';
import { ClipboardCheck } from 'lucide-react';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { dateTime } from '../../catalog/format';
import { useCategories } from '../../catalog/queries';
import { useStoreScope } from '../../catalog/scope';
import { ErrorBlock, LoadingRows } from '../../catalog/states';
import { PageHeader } from '../../layout/PageHeader';
import { InventoryTabs } from '../InventoryTabs';
import { useStockLocations } from '../locations';
import { countError, countPill, countProgress, defaultCountName, openCountId, signedMoney, startCountSchema, startInputOf, useCountMutations, useCounts, type StartCountValues } from './counts';

// PHASE-8-8C §10.5 Stock counts list (composed — no Figma frame): name, location, status, progress, net value
// (`costs.view`), started; "Start count" dialog (location, optional category, name). Counts work on every plan; writes
// need `inventory.adjust`. Below md the table stacks as cards (DataTable).

export default function CountsPage() {
  const scope = useStoreScope();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const page = Number(params.get('page') ?? '1') || 1;
  const list = useCounts({ page, per_page: 25 });
  const locs = useStockLocations();
  const [starting, setStarting] = useState(false);
  const canWrite = scope.canAdjustInventory;
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;

  const columns: DataTableColumn<StockCount>[] = [
    {
      key: 'name',
      header: 'Count',
      mobileLabel: false,
      cell: (c) => (
        <Link to={`/inventory/counts/${c.id}`} onClick={(e) => e.stopPropagation()} className="flex min-w-0 flex-col">
          <span className="truncate text-body font-medium text-brand-600 hover:text-brand-700">{c.name}</span>
          <span className="truncate text-caption text-text-secondary">{[c.location.name, c.category?.name].filter(Boolean).join(' · ')}</span>
        </Link>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 120,
      cell: (c) => {
        const p = countPill(c.status);
        return (
          <Badge tone={p.tone} dot>
            {p.label}
          </Badge>
        );
      },
    },
    {
      key: 'progress',
      header: 'Progress',
      width: 150,
      cell: (c) => {
        const p = countProgress(c);
        return (
          <div className="flex w-full min-w-[110px] flex-col gap-1.5">
            <span className="text-caption font-medium text-text-primary">
              {c.counted_count} / {c.lines_count}
            </span>
            <div className="h-1 overflow-hidden rounded-full bg-surface-subtle" role="progressbar" aria-label="Counted" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.pct}>
              <div className="h-1 rounded-full bg-brand-500" style={{ width: `${p.pct}%` }} />
            </div>
          </div>
        );
      },
    },
    ...(scope.canViewCosts
      ? ([
          {
            key: 'net',
            header: 'Net value',
            width: 110,
            align: 'end',
            cell: (c) => <span className={cn('text-body font-medium', (c.net_value_amount ?? 0) < 0 ? 'text-danger' : (c.net_value_amount ?? 0) > 0 ? 'text-info' : 'text-text-muted')}>{signedMoney(c.net_value_amount)}</span>,
          },
        ] satisfies DataTableColumn<StockCount>[])
      : []),
    { key: 'started', header: 'Started', width: 150, cell: (c) => <span className="text-body text-text-secondary">{dateTime(c.started_at)}</span> },
  ];

  return (
    <>
      <PageHeader title="Inventory" subtitle="Every stock change is recorded. Available = on hand − held for orders." actions={canWrite && <Button onClick={() => setStarting(true)}>Start count</Button>} />
      <InventoryTabs value="counts" />
      <DataTable
        label="Stock counts"
        className={cn(list.isPlaceholderData && 'opacity-60')}
        columns={columns}
        rows={rows}
        getRowId={(c) => c.id}
        rowLabel={(c) => c.name}
        onRowClick={(c) => navigate(`/inventory/counts/${c.id}`)}
        state={
          list.isPending ? (
            <LoadingRows label="Loading stock counts" />
          ) : list.isError ? (
            <ErrorBlock error={list.error} title="We couldn’t load your counts" onRetry={() => void list.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<ClipboardCheck />}
              title="No counts yet"
              description="Count a location’s stock and fix the differences in one go."
              action={
                canWrite && (
                  <Button size="sm" onClick={() => setStarting(true)}>
                    Start count
                  </Button>
                )
              }
            />
          ) : undefined
        }
        footer={meta && meta.total > meta.per_page && <Pagination page={meta.current_page} perPage={meta.per_page} total={meta.total} lastPage={meta.last_page} noun="counts" onPage={(p) => setParams(new URLSearchParams({ page: String(p) }), { replace: true })} />}
      />
      {starting && <StartCountDialog locations={locs.active} onClose={() => setStarting(false)} onStarted={(id) => navigate(`/inventory/counts/${id}`)} />}
    </>
  );
}

export function StartCountDialog({ locations, onClose, onStarted }: { locations: Location[]; onClose: () => void; onStarted: (id: string) => void }) {
  const categories = useCategories();
  const { start } = useCountMutations();
  const [error, setError] = useState<{ text: string; openId: string | null } | null>(null);
  const form = useForm<StartCountValues>({
    resolver: zodResolver(startCountSchema),
    defaultValues: { location_id: locations.find((l) => l.is_default)?.id ?? locations[0]?.id ?? '', category_id: '', name: '' },
  });
  const locationId = useWatch({ control: form.control, name: 'location_id' });
  const submit = form.handleSubmit((v) => {
    setError(null);
    start.mutate(startInputOf(v), {
      onSuccess: (c) => onStarted(c.id),
      onError: (e) => setError({ text: countError(e, 'We couldn’t start this count.'), openId: openCountId(e) }),
    });
  });
  return (
    <Dialog
      open
      size="md"
      title="Start count"
      description="Every product that tracks stock at this location goes on the list. Sales keep running while you count."
      confirmLabel="Start count"
      loading={start.isPending}
      formId="start-count"
      onConfirm={() => void submit()}
      onCancel={onClose}
    >
      <form id="start-count" onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
        <Select label="Location" error={form.formState.errors.location_id?.message} {...form.register('location_id')}>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
        <Select label="Category (optional)" hint="Count one category at a time in a big store." {...form.register('category_id')}>
          <option value="">All products</option>
          {(categories.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {'— '.repeat(c.depth - 1)}
              {c.name}
            </option>
          ))}
        </Select>
        <Input label="Name (optional)" placeholder={defaultCountName(locations.find((l) => l.id === locationId)?.name)} error={form.formState.errors.name?.message} {...form.register('name')} />
        {error && (
          <p role="alert" className="text-body text-danger">
            {error.text}{' '}
            {error.openId && (
              <Link to={`/inventory/counts/${error.openId}`} className="font-medium text-brand-600 hover:text-brand-700">
                Open it
              </Link>
            )}
          </p>
        )}
      </form>
    </Dialog>
  );
}
