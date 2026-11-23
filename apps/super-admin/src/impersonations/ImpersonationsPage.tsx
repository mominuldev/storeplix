import type { Impersonation } from '@storeplix/types';
import { Avatar, Button, Card, DataTable, Pagination, Tabs, type DataTableColumn } from '@storeplix/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ImpersonationStatusBadge } from '../components/badges';
import { ReasonDialog } from '../components/ReasonDialog';
import { Empty, ErrorState, LoadingRows } from '../components/States';
import { PageHeader } from '../layout/PageHeader';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useCan } from '../lib/permissions';
import { useToast } from '../lib/toast';

type Tab = 'active' | 'all';

const endedBy = {
  staff: 'Exited by staff',
  expiry: 'Expired after 15 min',
  revoked: 'Revoked',
} as const;

// Composed from the audit table 39:16118 (§7.1): active and recent read-only sessions; Revoke for super admins (P8-11).
export function ImpersonationsPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'all' ? 'all' : 'active';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [revoke, setRevoke] = useState<Impersonation | null>(null);

  const filters = {
    status: tab === 'active' ? ('active' as const) : undefined,
    page,
    per_page: 25,
  };
  const list = useQuery({
    queryKey: ['admin', 'impersonations', filters],
    queryFn: () => api.admin.impersonations.list(filters),
    placeholderData: keepPreviousData,
  });

  const columns: DataTableColumn<Impersonation>[] = [
    {
      key: 'staff',
      header: 'Staff',
      width: 180,
      mobileLabel: false,
      cell: (i) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar name={i.staff.name} size="sm" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-body font-medium text-text-primary">{i.staff.name}</span>
            <span className="truncate text-caption text-text-muted">{i.staff.email}</span>
          </span>
        </span>
      ),
    },
    {
      key: 'shop',
      header: 'Shop',
      width: 150,
      cell: (i) => (
        <Link to={`/merchants/${i.tenant.id}`} className="flex min-w-0 flex-col hover:underline">
          <span className="truncate text-body text-text-primary">{i.tenant.name}</span>
          <span className="truncate text-caption text-text-muted">{i.tenant.slug}</span>
        </Link>
      ),
    },
    {
      key: 'reason',
      header: 'Reason',
      cell: (i) => (
        <span className="flex min-w-0 flex-col">
          <span className="line-clamp-2 text-body text-text-primary">{i.reason}</span>
          {i.ticket_ref && <span className="text-caption text-text-muted">Ticket {i.ticket_ref}</span>}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 90,
      cell: (i) => <ImpersonationStatusBadge status={i.status} />,
    },
    {
      key: 'time',
      header: 'Started · ends',
      width: 170,
      cell: (i) => (
        <span className="flex flex-col text-caption text-text-secondary">
          <span>{i.started_at ? formatDateTime(i.started_at) : `Created ${formatDateTime(i.created_at)}`}</span>
          <span className="text-text-muted">
            {i.ended_at ? `${endedBy[i.ended_by ?? 'staff']} · ${formatDateTime(i.ended_at)}` : i.expires_at ? `Ends ${formatDateTime(i.expires_at)}` : '—'}
          </span>
        </span>
      ),
    },
    {
      key: 'requests',
      header: 'Requests',
      width: 72,
      align: 'end',
      cell: (i) => <span className="text-body text-text-primary tabular-nums">{i.request_count}</span>,
    },
    ...(can('suspend')
      ? [
          {
            key: 'revoke',
            header: <span className="sr-only">Actions</span>,
            width: 84,
            align: 'end' as const,
            mobileLabel: false as const,
            cell: (i: Impersonation) =>
              i.status === 'active' || i.status === 'pending' ? (
                <Button variant="secondary" size="sm" onClick={() => setRevoke(i)}>
                  Revoke
                </Button>
              ) : null,
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader title="Impersonations" subtitle="Read-only support sessions · 15 minutes at most · every session is on the shop’s activity log" />
      <Tabs
        aria-label="Sessions"
        value={tab}
        onChange={(v) => setParams(v === 'active' ? {} : { tab: v }, { replace: true })}
        items={[
          { value: 'active', label: 'Active' },
          { value: 'all', label: 'All sessions' },
        ]}
      />
      <Card className="overflow-hidden">
        <div className="relative overflow-x-auto">
          <DataTable
            label="Impersonation sessions"
            className="relative min-w-[960px] rounded-none border-0 shadow-none"
            columns={columns}
            rows={list.data?.data ?? []}
            getRowId={(i) => i.id}
            state={
              list.isPending ? (
                <LoadingRows label="Loading sessions" />
              ) : list.isError ? (
                <ErrorState error={list.error} onRetry={() => void list.refetch()} />
              ) : list.data.data.length === 0 ? (
                <Empty
                  icon={<Eye />}
                  title={tab === 'active' ? 'No active sessions' : 'No impersonations yet'}
                  description={tab === 'active' ? 'Nobody is viewing a shop as its owner right now.' : 'Sessions started from a shop page appear here.'}
                />
              ) : undefined
            }
            footer={
              list.data && list.data.meta.total > 0 ? (
                <Pagination
                  page={list.data.meta.current_page}
                  perPage={list.data.meta.per_page}
                  total={list.data.meta.total}
                  lastPage={list.data.meta.last_page}
                  noun="sessions"
                  onPage={(p) =>
                    setParams(
                      {
                        ...(tab === 'all' ? { tab } : {}),
                        ...(p > 1 ? { page: String(p) } : {}),
                      },
                      { replace: true },
                    )
                  }
                />
              ) : undefined
            }
          />
        </div>
      </Card>
      {revoke && (
        <ReasonDialog
          title={`Revoke ${revoke.staff.name}’s session?`}
          description={`The read-only session on ${revoke.tenant.name} ends on its next request.`}
          confirmLabel="Revoke session"
          tone="danger"
          onCancel={() => setRevoke(null)}
          onSubmit={(reason) => api.admin.impersonations.revoke(revoke.id, reason)}
          onDone={() => {
            setRevoke(null);
            toast('Session revoked');
            void queryClient.invalidateQueries({
              queryKey: ['admin', 'impersonations'],
            });
            void queryClient.invalidateQueries({
              queryKey: ['admin', 'overview'],
            });
          }}
        />
      )}
    </>
  );
}
