import type { Supplier, SupplierDetail, SupplierSummary } from '@storeplix/types';
import { Badge, Button, buttonVariants, cn, DataTable, Dialog, EmptyState, KpiTile, Menu, Pagination, type DataTableColumn, type MenuEntry } from '@storeplix/ui';
import { Archive, Building2, CreditCard, MoreHorizontal, Package, Pencil, RotateCcw, Trash2, Truck, Users } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { formatBdt, formatCount, plural } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, LoadingRows, NoResults, StateCard } from '../catalog/states';
import { FilterSelect, SearchBox, useDebounced, useIsMobile } from '../catalog/ui';
import { InventoryTabs } from '../inventory/InventoryTabs';
import { PageHeader } from '../layout/PageHeader';
import { formatBdPhone } from '../lib/phone';
import { toast } from '../online-store/components/Toast';
import { useFeatures } from '../plan/useFeatures';
import { KpiLoading, PurchasingPlanNote, SupplierIcon } from './components';
import { RecordPaymentDialog, SupplierFormDialog } from './dialogs';
import { dayMonth, isOpen, leadTimeText, methodLabel, owedTone, paymentTermsText, purchasingLocked, recentPoPill, purchasingError } from './purchasing';
import { useSupplier, useSupplierMutations, useSuppliers, useSupplierSummary } from './queries';

// PHASE-8-8B §10.4 Suppliers — Figma 153:35999: KPI tiles Suppliers / You owe / On the way / Bought this month
// (comparison line hidden, Q211); table (supplier, supplies · city, products, open POs, you owe — red when overdue —,
// last order); detail panel (contact, owed banner with overdue, payment terms, pays by, lead time, recent POs with
// delivery/payment pills, Record payment, New PO); "Import" (CSV via the imports flow, type suppliers); "+ Add supplier"
// (composed dialog); selected-row highlight, search and archive in the panel menu (composed). Below md the table stacks
// as cards and the panel opens under the list for the tapped supplier.

export default function SuppliersPage() {
  const scope = useStoreScope();
  const isMobile = useIsMobile();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const debounced = useDebounced(q);
  const archived = params.get('archived') === '1';
  const page = Number(params.get('page') ?? '1') || 1;
  const summary = useSupplierSummary();
  const list = useSuppliers({ q: debounced || undefined, archived, page, per_page: 50 });
  const locked = purchasingLocked(useFeatures().data);
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null);
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;
  const selectedId = params.get('supplier') ?? (isMobile ? null : (rows[0]?.id ?? null));

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (!v) next.delete(k);
      else next.set(k, v);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const columns: DataTableColumn<Supplier>[] = [
    {
      key: 'supplier',
      header: 'Supplier',
      mobileLabel: false,
      cell: (s) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-body font-medium text-text-primary">{s.name}</span>
          <span className="truncate text-caption text-text-secondary">{[s.supplies, s.city].filter(Boolean).join(' · ') || '—'}</span>
        </span>
      ),
    },
    { key: 'products', header: 'Products', width: 80, align: 'end', cell: (s) => <span className="text-body text-text-primary">{formatCount(s.products_count)}</span> },
    { key: 'open', header: 'Open POs', width: 80, align: 'end', cell: (s) => <span className="text-body text-text-primary">{formatCount(s.open_pos_count)}</span> },
    {
      key: 'owe',
      header: 'You owe',
      width: 104,
      align: 'end',
      cell: (s) => {
        const tone = owedTone(s);
        return <span className={cn('text-body font-semibold', tone === 'danger' ? 'text-danger' : tone === 'muted' ? 'font-normal text-text-muted' : 'text-text-primary')}>{formatBdt(Math.max(0, s.owed_amount))}</span>;
      },
    },
    { key: 'last', header: 'Last order', width: 88, cell: (s) => <span className="text-body text-text-primary">{dayMonth(s.last_order_on)}</span> },
  ];

  const filtered = !!(debounced || archived);
  const state = list.isPending ? (
    <LoadingRows label="Loading suppliers" />
  ) : list.isError ? (
    <ErrorBlock error={list.error} title="We couldn’t load your suppliers" onRetry={() => void list.refetch()} />
  ) : rows.length === 0 ? (
    filtered ? (
      <NoResults
        title={debounced ? `No supplier matches “${debounced}”` : 'No archived suppliers'}
        onClear={() => {
          setQ('');
          setParams(new URLSearchParams(), { replace: true });
        }}
        clearLabel="Clear filters"
      />
    ) : (
      <EmptyState
        icon={<Building2 />}
        title="No suppliers yet"
        description="Add the wholesalers and agents you buy from, or import them from a spreadsheet."
        action={
          <Button size="sm" onClick={() => setEditing('new')}>
            + Add supplier
          </Button>
        }
      />
    )
  ) : undefined;

  return (
    <>
      <PageHeader
        title="Suppliers"
        subtitle="Who you buy from, what you owe them and what’s on the way."
        actions={
          <>
            {scope.canBulkData && (
              <Link to="/products/import?type=suppliers" className={buttonVariants({ variant: 'secondary' })}>
                Import
              </Link>
            )}
            <Button onClick={() => setEditing('new')}>+ Add supplier</Button>
          </>
        }
      />
      <InventoryTabs value="suppliers" />
      {locked && <PurchasingPlanNote canSeePlans={scope.canViewBilling} />}
      {summary.isPending ? (
        <KpiLoading label="Loading supplier summary" />
      ) : summary.isError ? (
        <StateCard>
          <ErrorBlock error={summary.error} title="We couldn’t load the summary" onRetry={() => void summary.refetch()} />
        </StateCard>
      ) : (
        <Kpis s={summary.data} />
      )}

      <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
        <DataTable
          className={cn('min-w-0', list.isPlaceholderData && 'opacity-60')}
          label="Suppliers"
          toolbar={
            <div className="flex flex-wrap items-center gap-2 px-4 py-3.5">
              <SearchBox
                value={q}
                onChange={(v) => {
                  setQ(v);
                  set({ q: v, supplier: null });
                }}
                placeholder="Name, phone or city"
                label="Search suppliers"
                className="h-9 w-full sm:w-[240px] [&>svg]:size-4"
              />
              <FilterSelect label="Show" value={archived ? '1' : ''} onChange={(e) => set({ archived: e.target.value, supplier: null })}>
                <option value="">Active{meta ? ` (${formatCount(meta.counts.active)})` : ''}</option>
                <option value="1">Archived{meta ? ` (${formatCount(meta.counts.archived)})` : ''}</option>
              </FilterSelect>
            </div>
          }
          columns={columns}
          rows={rows}
          getRowId={(s) => s.id}
          rowLabel={(s) => s.name}
          onRowClick={(s) => set({ supplier: s.id })}
          rowClassName={(s) => (s.id === selectedId ? 'bg-brand-50' : undefined)}
          state={state}
          footer={meta && meta.total > meta.per_page && <Pagination page={meta.current_page} perPage={meta.per_page} total={meta.total} lastPage={meta.last_page} noun="suppliers" onPage={(p) => set({ page: String(p) })} />}
        />
        {selectedId && rows.some((r) => r.id === selectedId) && <SupplierPanel id={selectedId} onEdit={(s) => setEditing(s)} onGone={() => set({ supplier: null })} />}
      </div>

      {editing && <SupplierFormDialog supplier={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(s) => editing === 'new' && set({ supplier: s.id })} />}
    </>
  );
}

function Kpis({ s }: { s: SupplierSummary }) {
  return (
    <section aria-label="Supplier summary" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <KpiTile icon={<Users aria-hidden />} label="Suppliers" value={formatCount(s.suppliers_count)} hint={`${formatCount(s.active_this_month)} active this month`} />
      <KpiTile
        icon={<CreditCard aria-hidden />}
        label="You owe"
        value={formatBdt(s.owed_amount)}
        hint={[plural(s.owed_suppliers_count, 'supplier'), s.overdue_count > 0 ? `${formatCount(s.overdue_count)} overdue` : null].filter(Boolean).join(' · ')}
      />
      <KpiTile icon={<Truck aria-hidden />} label="On the way" value={`${formatCount(s.pos_on_the_way)} ${s.pos_on_the_way === 1 ? 'PO' : 'POs'}`} hint={s.arriving_this_week > 0 ? `${formatCount(s.arriving_this_week)} arriving this week` : 'Nothing due this week'} />
      <KpiTile icon={<Package aria-hidden />} label="Bought this month" value={formatBdt(s.bought_this_month_amount)} hint="Received goods, at cost" />
    </section>
  );
}

function SupplierPanel({ id, onEdit, onGone }: { id: string; onEdit: (s: Supplier) => void; onGone: () => void }) {
  const q = useSupplier(id);
  const mut = useSupplierMutations();
  const [paying, setPaying] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (q.isPending)
    return (
      <section aria-label="Supplier details" className="rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1">
        <LoadingRows rows={4} label="Loading supplier" />
      </section>
    );
  if (q.isError)
    return (
      <StateCard>
        <ErrorBlock error={q.error} title="We couldn’t load this supplier" onRetry={() => void q.refetch()} />
      </StateCard>
    );
  const s: SupplierDetail = q.data;
  const fail = (e: unknown, fallback: string) => {
    const msg = purchasingError(e, fallback);
    if (msg) toast(msg, 'error');
  };
  const menu: MenuEntry[] = [
    { key: 'edit', label: 'Edit supplier', icon: <Pencil />, onSelect: () => onEdit(s) },
    s.archived_at
      ? { key: 'unarchive', label: 'Restore', icon: <RotateCcw />, onSelect: () => mut.unarchive.mutate(s.id, { onSuccess: () => toast(`${s.name} restored.`), onError: (e) => fail(e, 'We couldn’t restore this supplier.') }) }
      : {
          key: 'archive',
          label: 'Archive',
          hint: 'Hide from lists; history stays',
          icon: <Archive />,
          onSelect: () =>
            mut.archive.mutate(s.id, {
              onSuccess: () => {
                toast(`${s.name} archived.`);
                onGone();
              },
              onError: (e) => fail(e, 'We couldn’t archive this supplier.'),
            }),
        },
    ...(s.past_orders_count === 0 && s.recent_purchase_orders.length === 0 ? [{ key: 'delete', label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => setConfirmDelete(true) }] : []),
  ];
  const owed = s.owed_amount;
  return (
    <section aria-label="Supplier details" className="flex min-w-0 flex-col gap-4 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1 sm:p-6">
      <div className="flex items-start gap-3">
        <SupplierIcon className="bg-surface-subtle shadow-none" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="truncate text-body-lg font-medium text-text-primary">{s.name}</h2>
          <span className="truncate text-caption text-text-secondary">{[s.contact_name, s.phone ? formatBdPhone(s.phone) : null].filter(Boolean).join(' · ') || 'No contact details'}</span>
          {s.archived_at && (
            <Badge size="sm" className="mt-1 self-start">
              Archived
            </Badge>
          )}
        </div>
        <Menu label={`Actions for ${s.name}`} trigger={<MoreHorizontal aria-hidden className="size-4" />} triggerClassName="size-8" entries={menu} />
      </div>

      {owed > 0 ? (
        <div role="status" className={cn('flex flex-col gap-1 rounded-lg px-4 py-3', s.overdue_amount > 0 ? 'bg-danger-bg' : 'bg-warning-bg')}>
          <span className={cn('text-body-lg font-medium', s.overdue_amount > 0 ? 'text-danger' : 'text-warning')}>You owe {formatBdt(owed)}</span>
          <span className="text-caption text-text-primary">
            {[
              s.overdue_amount > 0 ? `${formatBdt(s.overdue_amount)} overdue${s.overdue_since ? ` since ${dayMonth(s.overdue_since)}` : ''}` : null,
              s.payment_terms_days !== null ? `terms: ${s.payment_terms_days === 0 ? 'on delivery' : `${s.payment_terms_days} days`}` : null,
            ]
              .filter(Boolean)
              .join(' · ') || 'For goods you received'}
          </span>
        </div>
      ) : owed < 0 ? (
        <div role="status" className="rounded-lg bg-success-bg px-4 py-3 text-body font-medium text-success">
          Advance with supplier {formatBdt(-owed)}
        </div>
      ) : (
        <div role="status" className="rounded-lg bg-surface-subtle px-4 py-3 text-body text-text-secondary">
          Nothing owed
        </div>
      )}

      <dl className="flex flex-col gap-3 text-body">
        {(
          [
            ['Payment terms', paymentTermsText(s.payment_terms_days)],
            ['Pays by', [s.pays_by_method ? methodLabel(s.pays_by_method) : null, s.pays_by_account].filter(Boolean).join(' · ') || '—'],
            ['Lead time', leadTimeText(s.lead_time_days)],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="flex items-start justify-between gap-3">
            <dt className="text-text-secondary">{k}</dt>
            <dd className="text-right text-text-primary">{v}</dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-col gap-3 border-t border-border-default pt-4">
        <h3 className="text-body font-medium text-text-primary">Recent purchase orders</h3>
        {s.recent_purchase_orders.length === 0 ? (
          <p className="text-body text-text-muted">No purchase orders yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {s.recent_purchase_orders.map((po) => {
              const pill = recentPoPill(po);
              const when = isOpen(po.status) ? (po.expected_on ? `arriving ${dayMonth(po.expected_on)}` : 'on the way') : po.status === 'draft' ? 'draft' : `ordered ${dayMonth(po.ordered_at ?? po.created_at)}`;
              return (
                <li key={po.id} className="flex items-center gap-2 text-body">
                  <Link to={`/inventory/purchase-orders/${po.id}`} className="min-w-0 flex-1 truncate text-text-primary hover:text-brand-600">
                    {po.number} · {when}
                  </Link>
                  <Badge size="sm" tone={pill.tone} dot>
                    {pill.label}
                  </Badge>
                  <span className="shrink-0 font-medium text-text-primary">{formatBdt(po.total_amount)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Button variant="secondary" onClick={() => setPaying(true)}>
          Record payment
        </Button>
        {!s.archived_at && (
          <Link to={`/inventory/purchase-orders/new?supplier=${s.id}`} className={buttonVariants()}>
            New PO
          </Link>
        )}
      </div>

      {paying && (
        <RecordPaymentDialog
          supplier={s}
          purchaseOrders={s.recent_purchase_orders.filter((p) => p.status !== 'draft' && p.status !== 'cancelled').map((p) => ({ id: p.id, number: p.number }))}
          defaultAmount={owed > 0 ? owed : null}
          onClose={() => setPaying(false)}
        />
      )}
      <Dialog
        open={confirmDelete}
        tone="danger"
        title={`Delete ${s.name}?`}
        description="This supplier has no purchase orders or payments, so it can be removed for good."
        confirmLabel="Delete supplier"
        loading={mut.remove.isPending}
        onConfirm={() =>
          mut.remove.mutate(s.id, {
            onSuccess: () => {
              toast(`${s.name} deleted.`);
              setConfirmDelete(false);
              onGone();
            },
            onError: (e) => {
              setConfirmDelete(false);
              fail(e, 'We couldn’t delete this supplier.');
            },
          })
        }
        onCancel={() => setConfirmDelete(false)}
      />
    </section>
  );
}
