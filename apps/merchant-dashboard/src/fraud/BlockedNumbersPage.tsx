import { Button } from '@storeplix/ui';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, LoadingRows } from '../catalog/states';
import { SearchBox, useDebounced } from '../catalog/ui';
import { PageHeader } from '../layout/PageHeader';
import { useFeatures } from '../plan/useFeatures';
import { BlockedTable, GuardCard, GuardPlanNote } from './components';
import { BlockNumberDialog } from './dialogs';
import { guardLocked } from './fraud';
import { useBlockedNumbers, useGuardOverview } from './queries';

// PHASE-8-8 §10.1 composed "View all" for Blocked numbers 41:11630: the same table (cards below md), search by the
// last digits, cursor pages of 50 with "Show more".

export function GuardBreadcrumb({ current }: { current: string }) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-body font-medium text-text-secondary">
      <Link to="/orders/fraud-guard" className="text-brand-600 hover:text-brand-700">
        Fake order guard
      </Link>
      <ChevronRight aria-hidden className="size-3.5 text-text-muted" />
      <span>{current}</span>
    </nav>
  );
}

export default function BlockedNumbersPage() {
  const scope = useStoreScope();
  const locked = guardLocked(useFeatures().data);
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.replace(/\D/g, ''));
  const [blocking, setBlocking] = useState(false);
  const overview = useGuardOverview();
  const list = useBlockedNumbers(debounced, 'all');
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const total = overview.data?.blocked_count;
  return (
    <div className="flex flex-col gap-5">
      <GuardBreadcrumb current="Blocked numbers" />
      <PageHeader
        title={`Blocked numbers${total !== undefined ? ` · ${total}` : ''}`}
        subtitle="Cash on delivery is off for these numbers. They can still pay online."
        actions={
          <Button disabled={locked} onClick={() => setBlocking(true)}>
            Block a number
          </Button>
        }
      />
      {locked && <GuardPlanNote canSeePlans={scope.canViewBilling} />}
      <GuardCard label="Blocked numbers">
        <div className="p-4 sm:px-5">
          <SearchBox value={q} onChange={setQ} placeholder="Search number" label="Search blocked numbers" className="h-9 w-full rounded-md border border-border-default sm:w-[240px]" />
        </div>
        {list.isPending ? (
          <LoadingRows rows={6} label="Loading blocked numbers" />
        ) : list.isError ? (
          <ErrorBlock error={list.error} title="We couldn’t load blocked numbers" onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          <p className="border-t border-border-default px-5 py-10 text-center text-body text-text-muted">{debounced ? `No blocked number ends in ${debounced}.` : 'No blocked numbers yet.'}</p>
        ) : (
          <BlockedTable rows={rows} canWrite={!locked} dim={list.isPlaceholderData} />
        )}
        {list.hasNextPage && (
          <div className="flex justify-center border-t border-border-default p-3">
            <Button variant="secondary" size="sm" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              Show more
            </Button>
          </div>
        )}
      </GuardCard>
      {blocking && <BlockNumberDialog onClose={() => setBlocking(false)} />}
    </div>
  );
}
