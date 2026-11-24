import { FRAUD_GUARD_EVENT_TYPES, type FraudGuardEventType } from '@storeplix/types';
import { Button, EmptyState } from '@storeplix/ui';
import { ShieldCheck } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { ErrorBlock, LoadingRows } from '../catalog/states';
import { FilterSelect } from '../catalog/ui';
import { PageHeader } from '../layout/PageHeader';
import { DecisionList, GuardCard } from './components';
import { GuardBreadcrumb } from './BlockedNumbersPage';
import { eventMeta } from './fraud';
import { useGuardEvents } from './queries';

// PHASE-8-8 §10.1 composed "View all" for Recent decisions 41:11740: every guard decision, newest first, cursor pages
// of 50, filter by type (`filter[type]`).

const isType = (v: string | null): v is FraudGuardEventType => !!v && (FRAUD_GUARD_EVENT_TYPES as readonly string[]).includes(v);

export default function DecisionLogPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('type');
  const type = isType(raw) ? raw : null;
  const events = useGuardEvents('all', type);
  const rows = events.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <div className="flex flex-col gap-5">
      <GuardBreadcrumb current="Decisions" />
      <PageHeader title="Guard decisions" subtitle="Every order the guard held, asked an advance for or stopped — and why." />
      <GuardCard label="Decisions" className="gap-2 p-4 sm:p-5">
        <div>
          <FilterSelect label="Decision type" value={type ?? ''} onChange={(e) => setParams(e.target.value ? { type: e.target.value } : {}, { replace: true })}>
            <option value="">All decisions</option>
            {FRAUD_GUARD_EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t === 'auto_blocked' ? 'Blocked by the return rule' : t === 'blocked_checkout' ? 'Blocked at checkout' : eventMeta[t].label}
              </option>
            ))}
          </FilterSelect>
        </div>
        {events.isPending ? (
          <LoadingRows rows={8} label="Loading decisions" />
        ) : events.isError ? (
          <ErrorBlock error={events.error} title="We couldn’t load decisions" onRetry={() => void events.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState icon={<ShieldCheck />} title="No decisions yet — new orders will appear here." />
        ) : (
          <DecisionList events={rows} />
        )}
        {events.hasNextPage && (
          <Button variant="secondary" size="sm" className="self-center" loading={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()}>
            Show more
          </Button>
        )}
      </GuardCard>
    </div>
  );
}
