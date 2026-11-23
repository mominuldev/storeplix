import type { Customer, CustomerListFilters } from '@storeplix/types';
import { Avatar, Button, buttonVariants, cn, DataTable, KpiTile, Pagination, Tabs, type DataTableColumn } from '@storeplix/ui';
import { ChevronRight, Plus, Repeat, ShoppingCart, Users } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { PageHeader } from '../layout/PageHeader';
import { formatBdt, formatCount, formatIntlPhone, monthYear } from '../catalog/format';
import { useCustomers } from '../catalog/queries';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, LoadingRows, NoResults } from '../catalog/states';
import { Cell2, iconButton, SearchBox, useDebounced } from '../catalog/ui';
import { useExport } from '../imports/useExport';
import { timeAgo } from '../commerce/format';
import { channelLabels, CustomerFormDialog } from './CustomerFormDialog';

// Figma Customers 63:14972 (Main 63:14974), Customer/Row 61:12494, Avatar 61:12493. Contract §9.1: tabs Repeat /
// Risky / Blocked, the risky banner, district/risk/last-order filters, Delivered/Returns/Risk columns and
// order-number search are not built. Phase 5a: Delivered and Returns columns show this shop's counters.

export function startOfMonthIso(now = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

export function CustomersPage() {
  const navigate = useNavigate();
  const scope = useStoreScope();
  const exporter = useExport();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'new' ? 'new' : 'all';
  const [q, setQ] = useState(params.get('q') ?? '');
  const debounced = useDebounced(q);
  const page = Number(params.get('page') ?? '1') || 1;
  const [adding, setAdding] = useState(false);

  const filters: CustomerListFilters = { q: debounced || undefined, created_from: tab === 'new' ? startOfMonthIso() : undefined, page, per_page: 25 };
  const list = useCustomers(filters);
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (!v) next.delete(k);
      else next.set(k, v);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const columns: DataTableColumn<Customer>[] = [
    {
      key: 'customer',
      header: 'Customer',
      mobileLabel: false,
      cell: (c) => (
        <Link to={`/customers/${c.id}`} className="flex min-w-0 items-center gap-3" onClick={(e) => e.stopPropagation()}>
          <Avatar name={c.name} className="bg-brand-50" />
          <Cell2 top={c.name} bottom={[`Since ${monthYear(c.created_at)}`, c.channel ? channelLabels[c.channel] : null].filter(Boolean).join(' · ')} />
        </Link>
      ),
    },
    { key: 'phone', header: 'Phone', width: 140, cell: (c) => <span className="text-body whitespace-nowrap text-text-primary">{c.phone ? formatIntlPhone(c.phone) : (c.email ?? '—')}</span> },
    { key: 'district', header: 'District', width: 92, cell: (c) => <span className="truncate text-body text-text-secondary">{c.district ?? '—'}</span> },
    { key: 'orders', header: 'Orders', width: 52, cell: (c) => <span className="text-body font-semibold text-text-primary">{formatCount(c.orders_count)}</span> },
    { key: 'delivered', header: 'Delivered', width: 96, cell: (c) => <DeliveryMeter delivered={c.delivered_orders_count} returned={c.returned_orders_count} /> },
    { key: 'returns', header: 'Returns', width: 64, cell: (c) => <span className="text-body text-text-primary">{formatCount(c.returned_orders_count)}</span> },
    { key: 'spent', header: 'Total spent', width: 96, cell: (c) => <span className="text-body font-semibold text-text-primary">{formatBdt(c.total_spent_amount)}</span> },
    { key: 'last', header: 'Last order', width: 88, cell: (c) => <span className="text-caption whitespace-nowrap text-text-muted">{c.last_order_at ? timeAgo(c.last_order_at) : '—'}</span> },
    {
      key: 'go',
      header: <span className="sr-only">Open</span>,
      mobileLabel: false,
      width: 40,
      align: 'end',
      hideOnMobile: true,
      cell: (c) => (
        <Link to={`/customers/${c.id}`} aria-label={`Open ${c.name}`} className={iconButton} onClick={(e) => e.stopPropagation()}>
          <ChevronRight aria-hidden />
        </Link>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Customers"
        subtitle="People who buy from you. Add them by hand or import a list."
        actions={
          <>
            {scope.canBulkData && (
              <Link to="/products/import?type=customers" className={buttonVariants({ variant: 'secondary' })}>
                Import
              </Link>
            )}
            {scope.canExportData && (
              <Button variant="secondary" loading={exporter.running} onClick={() => void exporter.start({ type: 'customers', filters: { q: filters.q, created_from: filters.created_from } })}>
                Export
              </Button>
            )}
            {scope.canEditCustomers && (
              <Button leftIcon={<Plus aria-hidden className="size-4" />} onClick={() => setAdding(true)}>
                Add customer
              </Button>
            )}
          </>
        }
      />
      <Tabs
        aria-label="Customer groups"
        value={tab}
        onChange={(v) => set({ tab: v === 'new' ? 'new' : null })}
        items={[
          { value: 'all', label: 'All', count: meta?.counts.all },
          { value: 'new', label: 'New this month', count: meta?.counts.new_this_month },
        ]}
      />
      <section aria-label="Customer summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile icon={<Users />} label="Total customers" value={formatCount(meta?.counts.all ?? 0)} hint={`+${formatCount(meta?.counts.new_this_month ?? 0)} joined this month`} />
        <KpiTile icon={<Plus />} label="New this month" value={formatCount(meta?.counts.new_this_month ?? 0)} hint="Added by hand or import" />
        <KpiTile icon={<Repeat />} label="Repeat rate" value="—" hint="Starts with your first order" />
        <KpiTile icon={<ShoppingCart />} label="Avg order value" value="—" hint="Starts with your first order" />
      </section>
      <DataTable
        label="Customers"
        toolbar={
          <div className="flex flex-wrap items-center gap-2 px-4 py-3.5">
            <SearchBox
              value={q}
              onChange={(v) => {
                setQ(v);
                set({ q: v });
              }}
              placeholder="Name, phone or email"
              label="Search customers"
              className="h-[38px] w-full border border-border-default bg-surface-card sm:max-w-[300px] [&>svg]:size-4"
            />
          </div>
        }
        columns={columns}
        rows={rows}
        getRowId={(c) => c.id}
        onRowClick={(c) => navigate(`/customers/${c.id}`)}
        state={
          list.isPending ? (
            <LoadingRows label="Loading customers" />
          ) : list.isError ? (
            <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
          ) : rows.length === 0 ? (
            debounced || tab === 'new' ? (
              <NoResults
                title={debounced ? `No customers match “${debounced}”` : 'No new customers this month'}
                description={debounced ? 'Check the number, or search by name or email instead.' : undefined}
                onClear={() => {
                  setQ('');
                  setParams(new URLSearchParams(), { replace: true });
                }}
              />
            ) : (
              <NoResults title="No customers yet" description="Add your first customer, or import a list from a spreadsheet." onClear={scope.canEditCustomers ? () => setAdding(true) : undefined} clearLabel="Add customer" />
            )
          ) : undefined
        }
        footer={meta && meta.total > 0 && <Pagination page={meta.current_page} perPage={meta.per_page} total={meta.total} lastPage={meta.last_page} noun="customers" onPage={(p) => set({ page: String(p) })} />}
      />
      <CustomerFormDialog open={adding} onClose={() => setAdding(false)} onSaved={(c) => navigate(`/customers/${c.id}`)} />
    </>
  );
}

/** Customer/Row "Delivered" (61:12504): Caption/12 Medium rate over a 10-segment meter (6×4, gap 2). Shop-only counts. */
export function DeliveryMeter({ delivered, returned }: { delivered: number; returned: number }) {
  const done = delivered + returned;
  const pct = done > 0 ? Math.round((delivered / done) * 100) : null;
  const filled = pct === null ? 0 : Math.round(pct / 10);
  const tone = pct === null ? '' : pct >= 80 ? 'bg-success' : pct >= 60 ? 'bg-warning' : 'bg-danger';
  return (
    <span className="flex flex-col gap-1.5">
      <span className="text-caption font-medium whitespace-nowrap text-text-primary">{pct === null ? 'No record' : `${pct}%`}</span>
      <span aria-hidden className="flex h-1 gap-0.5">
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} className={cn('h-1 w-1.5 rounded-[2px]', i < filled ? tone : 'bg-surface-subtle')} />
        ))}
      </span>
    </span>
  );
}

export default CustomersPage;
