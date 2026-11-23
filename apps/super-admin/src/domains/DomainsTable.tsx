import type { AdminDomain, DomainFailureCode } from '@storeplix/types';
import { cn, DataTable, DomainStatusBadge, FloatingMenu, type DataTableColumn, type MenuEntry } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ban, MoreHorizontal, RefreshCw, RotateCcw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { CheckBadge } from '../components/badges';
import { ReasonDialog } from '../components/ReasonDialog';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { formatDateTime } from '../lib/format';
import { useCan } from '../lib/permissions';
import { useToast } from '../lib/toast';

const failureText: Record<DomainFailureCode, string> = {
  txt_missing: 'Verification TXT missing',
  txt_mismatch: 'Verification TXT mismatch',
  cname_missing: 'No CNAME record found',
  cname_mismatch: 'CNAME points elsewhere',
  dns_error: 'DNS lookup failed',
  verification_timeout: 'Verification timed out',
  provider_error: 'Edge provider error',
  provider_blocked: 'Blocked by the edge provider',
  provider_moved: 'Moved to another edge account',
  ssl_validation_failed: 'SSL validation failed',
  ssl_timeout: 'SSL issuing timed out',
  ssl_lost: 'SSL certificate lost',
  suspended: 'Suspended by Store Plix',
  plan_limit: 'Not included in the shop’s plan',
};

// Settings – Domains & SSL 45:8156, custom domains table (§7.1): Domain, Shop, DNS, SSL, Status, Last checked; row
// menu Re-check (`manage_domains`), Suspend / Reinstate (`suspend`). `showShop={false}` in the merchant Domains tab.
export function DomainsTable({
  rows,
  state,
  footer,
  showShop = true,
  className,
}: {
  rows: AdminDomain[];
  state?: ReactNode;
  footer?: ReactNode;
  showShop?: boolean;
  className?: string;
}) {
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<{
    kind: 'suspend' | 'reinstate';
    domain: AdminDomain;
  } | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'domains'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'tenant'] });
  };
  const recheck = useMutation({
    mutationFn: (d: AdminDomain) => api.admin.domains.recheck(d.id),
    onSuccess: (d) => {
      toast(`Re-check started for ${d.hostname}`);
      invalidate();
    },
    onError: (e) => toast(errorMessage(e), 'danger'),
  });

  const entries = (d: AdminDomain): MenuEntry[] => [
    ...(can('manage_domains') && d.kind === 'custom' && d.status !== 'suspended'
      ? [
          {
            key: 'recheck',
            label: 'Re-check',
            hint: 'Run DNS and SSL checks now',
            icon: <RefreshCw />,
            onSelect: () => recheck.mutate(d),
          },
        ]
      : []),
    ...(can('suspend') && d.kind === 'custom'
      ? d.status === 'suspended'
        ? [
            {
              key: 'reinstate',
              label: 'Reinstate',
              icon: <RotateCcw />,
              onSelect: () => setDialog({ kind: 'reinstate', domain: d }),
            },
          ]
        : [
            {
              key: 'suspend',
              label: 'Suspend',
              icon: <Ban />,
              danger: true,
              onSelect: () => setDialog({ kind: 'suspend', domain: d }),
            },
          ]
      : []),
  ];

  const columns: DataTableColumn<AdminDomain>[] = [
    {
      key: 'domain',
      header: 'Domain',
      mobileLabel: false,
      cell: (d) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-body font-medium text-text-primary">
            {d.hostname}
            {d.is_primary && <span className="ml-2 text-caption font-medium text-brand-600">Primary</span>}
          </span>
          <span className="truncate text-caption text-text-muted">
            {d.failure_code ? failureText[d.failure_code] : d.kind === 'platform' ? 'Platform address' : 'Custom domain'}
          </span>
        </span>
      ),
    },
    ...(showShop
      ? [
          {
            key: 'shop',
            header: 'Shop',
            width: 180,
            cell: (d: AdminDomain) => (
              <Link
                to={`/merchants/${d.tenant.id}`}
                onClick={(e) => e.stopPropagation()}
                className="truncate text-body text-text-primary hover:text-brand-600 hover:underline"
              >
                {d.tenant.name}
              </Link>
            ),
          },
        ]
      : []),
    {
      key: 'dns',
      header: 'DNS',
      width: 112,
      cell: (d) => <CheckBadge kind="dns" ok={d.dns_ok} status={d.status} />,
    },
    {
      key: 'ssl',
      header: 'SSL',
      width: 88,
      cell: (d) => <CheckBadge kind="ssl" ok={d.ssl_ok} status={d.status} />,
    },
    {
      key: 'status',
      header: 'Status',
      width: 128,
      cell: (d) => <DomainStatusBadge status={d.status} />,
    },
    {
      key: 'checked',
      header: 'Last checked',
      width: 150,
      cell: (d) => <span className="text-caption text-text-secondary">{d.last_checked_at ? formatDateTime(d.last_checked_at) : 'Not yet'}</span>,
    },
    {
      key: 'menu',
      header: <span className="sr-only">Actions</span>,
      width: 32,
      align: 'end',
      mobileLabel: false,
      cell: (d) => {
        const e = entries(d);
        return e.length ? <FloatingMenu label={`Actions for ${d.hostname}`} trigger={<MoreHorizontal aria-hidden className="size-5" />} entries={e} /> : null;
      },
    },
  ];

  return (
    <>
      <div className="relative overflow-x-auto">
        <DataTable
          label="Domains"
          columns={columns}
          rows={rows}
          getRowId={(d) => d.id}
          state={state}
          footer={footer}
          className={cn('relative min-w-[860px]', className)}
        />
      </div>
      {dialog && (
        <ReasonDialog
          title={dialog.kind === 'suspend' ? `Suspend ${dialog.domain.hostname}?` : `Reinstate ${dialog.domain.hostname}?`}
          description={
            dialog.kind === 'suspend'
              ? 'The domain stops serving the storefront right away. The shop stays online on its platform address.'
              : 'The domain is checked again and serves the storefront once DNS and SSL pass.'
          }
          confirmLabel={dialog.kind === 'suspend' ? 'Suspend domain' : 'Reinstate domain'}
          tone={dialog.kind === 'suspend' ? 'danger' : 'primary'}
          onCancel={() => setDialog(null)}
          onSubmit={(reason) =>
            dialog.kind === 'suspend' ? api.admin.domains.suspend(dialog.domain.id, reason) : api.admin.domains.reinstate(dialog.domain.id, reason)
          }
          onDone={(d) => {
            setDialog(null);
            toast(`${d.hostname} ${dialog.kind === 'suspend' ? 'suspended' : 'reinstated'}`);
            invalidate();
          }}
        />
      )}
    </>
  );
}
