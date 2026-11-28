import type { AdminInvoiceSummary } from '@storeplix/types';
import { cn, DataTable, type DataTableColumn } from '@storeplix/ui';
import type { ReactNode } from 'react';
import { InvoiceStatusBadge } from '../components/badges';
import { formatDate, intervalLabel, money, planName, providerLabel } from '../lib/format';

const kindLabel: Record<string, string> = {
  new: 'New',
  upgrade: 'Upgrade',
  renewal: 'Renewal',
  sms_credits: 'SMS credits',
};

// Billing 34:859 invoice table: Invoice (number + period line), Shop (name + slug), Plan, Amount ৳ (end-aligned),
// Method, Status, Date. Row click opens the drawer (36:1598). `showShop={false}` inside a merchant's Billing tab.
export function InvoicesTable({
  rows,
  state,
  footer,
  toolbar,
  showShop = true,
  onOpen,
  className = 'rounded-none border-0 shadow-none',
}: {
  className?: string;
  rows: AdminInvoiceSummary[];
  state?: ReactNode;
  footer?: ReactNode;
  toolbar?: ReactNode;
  showShop?: boolean;
  onOpen: (invoice: AdminInvoiceSummary) => void;
}) {
  const columns: DataTableColumn<AdminInvoiceSummary>[] = [
    {
      key: 'invoice',
      header: 'Invoice',
      mobileLabel: false,
      cell: (i) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-body font-medium text-text-primary">{i.number}</span>
          <span className="truncate text-caption text-text-muted">
            {kindLabel[i.kind] ?? i.kind}
            {i.billing_interval ? ` · ${intervalLabel(i.billing_interval).toLowerCase()}` : ''}
          </span>
        </span>
      ),
    },
    ...(showShop
      ? [
          {
            key: 'shop',
            header: 'Shop',
            width: 200,
            cell: (i: AdminInvoiceSummary) => (
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-body font-medium text-text-primary">{i.tenant.name}</span>
                <span className="truncate text-caption text-text-muted">{i.tenant.slug}</span>
              </span>
            ),
          },
        ]
      : []),
    {
      key: 'plan',
      header: 'Plan',
      width: 96,
      // PHASE-8-9A: `sms_credits` invoices have no plan.
      cell: (i) => <span className="text-body text-text-primary">{i.kind === 'sms_credits' ? 'SMS credits' : planName(i.plan_code)}</span>,
    },
    {
      key: 'amount',
      header: 'Amount ৳',
      width: 112,
      align: 'end',
      cell: (i) => <span className="text-body font-semibold text-text-primary tabular-nums">{money(i.total_amount)}</span>,
    },
    {
      key: 'method',
      header: 'Method',
      width: 100,
      cell: (i) => <span className="text-body text-text-secondary">{providerLabel(i.provider)}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      width: 84,
      cell: (i) => <InvoiceStatusBadge status={i.status} overdue={i.status === 'open' && !!i.due_at && Date.parse(i.due_at) < Date.now()} />,
    },
    {
      key: 'date',
      header: 'Date',
      width: 108,
      cell: (i) => <span className="text-body text-text-secondary">{formatDate(i.paid_at ?? i.issued_at)}</span>,
    },
  ];
  // The fixed columns take ~600 px (~800 with Shop); below that the flexible Invoice column collapsed under Plan
  // (merchant Overview card, 1024 px). Keep a floor and scroll inside the card instead (not for the empty/loading state,
  // which stays centred in the card).
  return (
    <div className="relative overflow-x-auto">
      <DataTable
        label="Invoices"
        columns={columns}
        rows={rows}
        getRowId={(i) => i.id}
        onRowClick={onOpen}
        state={state}
        footer={footer}
        toolbar={toolbar}
        rowLabel={(i) => i.number}
        className={cn('relative', !state && rows.length > 0 && (showShop ? 'md:min-w-[920px]' : 'md:min-w-[720px]'), className)}
      />
    </div>
  );
}
