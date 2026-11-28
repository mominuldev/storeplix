import type { AdminSenderIdRequest, SmsSenderIdStatus } from '@storeplix/types';
import { Avatar, Badge, Card, DataTable, Pagination, type DataTableColumn } from '@storeplix/ui';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { ChevronRight, FileText, Search, Shield } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { PillTabs } from '../components/PillTabs';
import { Empty, ErrorState, LoadingRows } from '../components/States';
import { PageHeader } from '../layout/PageHeader';
import { api } from '../lib/api';
import { saveBlob } from '../lib/download';
import { errorMessage } from '../lib/errors';
import { formatDate } from '../lib/format';
import { useCan } from '../lib/permissions';
import { useToast } from '../lib/toast';
import { useDebounced } from '../lib/useDebounced';
import { relativeDay, senderIdStatusMeta, usesLabel } from './format';
import { smsKeys } from './queries';
import { SenderIdDrawer } from './SenderIdDrawer';

type Tab = Extract<SmsSenderIdStatus, 'pending' | 'approved' | 'rejected'>;
const TAB_VALUES: Tab[] = ['pending', 'approved', 'rejected'];

// Platform / Sender ID requests 2087:7872 (PHASE-8-9A §13.1, `manage_domains`): header, tabs Pending review (count) ·
// Approved · Rejected (only the pending count is in the API; the "All" tab is not offered because `filter[status]`
// has no "all" value and defaults to pending), "Search shop or sender ID" (≥ 2), table MERCHANT · REQUESTED ID ·
// PURPOSE · SUBMITTED · DOCUMENTS · STATUS + chevron. Row → review drawer 2095:8922 (`?request=`).
export function SenderIdsPage() {
  const can = useCan();
  const allowed = can('manage_domains');
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = (TAB_VALUES.find((t) => t === params.get('tab')) ?? 'pending') as Tab;
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const requestId = params.get('request');
  const [q, setQ] = useState(params.get('q') ?? '');
  const debouncedQ = useDebounced(q.trim(), 300);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    if (!('page' in patch) && !('request' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };
  useEffect(() => {
    // The API needs ≥ 2 characters; one character searches nothing yet.
    const value = debouncedQ.length >= 2 ? debouncedQ : '';
    if ((params.get('q') ?? '') !== value) update({ q: value });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);

  const filters = { status: tab, q: params.get('q') ?? undefined, page, per_page: 25 };
  const list = useQuery({
    queryKey: [...smsKeys.senderIds, 'list', filters],
    queryFn: () => api.admin.senderIds.list(filters),
    placeholderData: keepPreviousData,
    enabled: allowed,
  });
  const download = useMutation({
    mutationFn: (r: AdminSenderIdRequest) => api.admin.senderIds.document(r.id, r.document.filename),
    onSuccess: (file) => saveBlob(file.blob, file.filename),
    onError: (e) => toast(errorMessage(e), 'danger'),
  });

  if (!allowed) {
    return (
      <>
        <PageHeader title="Sender ID requests" />
        <Card>
          <Empty icon={<Shield />} title="You don’t have access to sender ID requests" description="Ask a super admin for the “Re-check domains” permission (support and super admins have it)." />
        </Card>
      </>
    );
  }

  const pending = list.data?.meta.counts.pending;
  const searching = !!filters.q;
  const columns: DataTableColumn<AdminSenderIdRequest>[] = [
    {
      key: 'merchant',
      header: 'Merchant',
      mobileLabel: false,
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar name={r.tenant.name} size="sm" className="rounded-md" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-body font-semibold text-text-primary">{r.tenant.name}</span>
            <span className="truncate text-caption text-text-secondary">{r.tenant.slug}</span>
          </span>
        </span>
      ),
    },
    {
      key: 'id',
      header: 'Requested ID',
      width: 150,
      cell: (r) => <span className="text-body font-semibold text-text-primary">{r.sender_id}</span>,
    },
    {
      key: 'uses',
      header: 'Purpose',
      width: 200,
      cell: (r) => <span className="text-body text-text-secondary">{usesLabel(r.uses)}</span>,
    },
    {
      key: 'submitted',
      header: 'Submitted',
      width: 150,
      cell: (r) => (
        <span className="flex flex-col">
          <span className="text-body text-text-primary">{formatDate(r.requested_at)}</span>
          <span className="text-caption text-text-muted">{relativeDay(r.requested_at)}</span>
        </span>
      ),
    },
    {
      key: 'documents',
      header: 'Documents',
      width: 170,
      cell: (r) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            download.mutate(r);
          }}
          disabled={download.isPending}
          aria-label={`Download trade licence for ${r.sender_id}`}
          className="flex items-center gap-1.5 rounded-sm text-body font-medium text-brand-600 outline-none hover:underline focus-visible:shadow-focus disabled:opacity-60"
        >
          <FileText aria-hidden className="size-3.5" />
          Trade licence
        </button>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (r) => (
        <span className="flex items-center gap-2">
          <Badge size="sm" dot tone={senderIdStatusMeta[r.status].tone}>
            {senderIdStatusMeta[r.status].label}
          </Badge>
          <span className="flex-1" />
          <ChevronRight aria-hidden className="size-4 text-text-muted" />
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Sender ID requests" subtitle="Masked sender IDs merchants asked for. Approve once REVE SMS confirms the BTRC registration is live." />
      <div className="flex flex-wrap items-center gap-3">
        <PillTabs
          aria-label="Request status"
          value={tab}
          onChange={(v) => update({ tab: v === 'pending' ? null : v })}
          items={[
            { value: 'pending', label: 'Pending review', count: pending ?? null },
            { value: 'approved', label: 'Approved' },
            { value: 'rejected', label: 'Rejected' },
          ]}
        />
        <div className="flex-1" />
        <label className="flex h-10 w-full items-center gap-2 rounded-md border border-border-default bg-surface-card px-3 focus-within:border-brand-600 focus-within:shadow-focus sm:w-80">
          <Search aria-hidden className="size-4 text-text-muted" />
          <input
            type="search"
            aria-label="Search shop or sender ID"
            placeholder="Search shop or sender ID"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-text-muted"
          />
        </label>
      </div>
      <DataTable
        label="Sender ID requests"
        columns={columns}
        rows={list.data?.data ?? []}
        getRowId={(r) => r.id}
        rowLabel={(r) => `${r.sender_id} · ${r.tenant.name}`}
        onRowClick={(r) => update({ request: r.id })}
        rowClassName={(r) => (r.id === requestId ? 'bg-brand-50' : undefined)}
        state={
          list.isPending ? (
            <LoadingRows label="Loading sender ID requests" />
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          ) : list.data.data.length === 0 ? (
            <Empty
              icon={<Shield />}
              title={searching ? 'No requests match this search' : tab === 'pending' ? 'No requests waiting for review' : `No ${tab} requests`}
              description={
                searching ? 'Try another shop name or sender ID.' : tab === 'pending' ? 'New requests from shops appear here, oldest first.' : 'Nothing in this tab yet.'
              }
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
              noun="requests"
              onPage={(p) => update({ page: p > 1 ? String(p) : null })}
            />
          ) : undefined
        }
      />
      {requestId && <SenderIdDrawer requestId={requestId} onClose={() => update({ request: null })} />}
    </>
  );
}
