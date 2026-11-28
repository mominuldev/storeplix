import { HELP_FEEDBACK_REASON_LABELS, HELP_LANGUAGE_LABELS } from '@storeplix/types';
import { Badge, Drawer, Pagination, SegmentedControl } from '@storeplix/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import { useState } from 'react';
import { Empty, ErrorState, LoadingRows } from '../components/States';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import { helpKeys } from './queries';

type Filter = 'all' | 'no' | 'yes';

// "See all feedback" (editor Feedback card): every vote with reason, note, language and shop, newest first.
export function FeedbackDrawer({ articleId, open, onClose }: { articleId: string; open: boolean; onClose: () => void }) {
  const [filter, setFilter] = useState<Filter>('no');
  const [page, setPage] = useState(1);
  const helpful = filter === 'all' ? undefined : filter === 'yes';
  const list = useQuery({
    queryKey: helpKeys.feedback(articleId, helpful, page),
    queryFn: () => api.admin.help.articles.feedback(articleId, { helpful, page }),
    placeholderData: keepPreviousData,
    enabled: open,
  });
  return (
    <Drawer open={open} onClose={onClose} title="Feedback" description="Votes from merchants on this guide" width={480}>
      <div className="flex flex-col gap-3 p-4">
        <SegmentedControl
          aria-label="Feedback filter"
          size="sm"
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setPage(1);
          }}
          options={[
            { value: 'no', label: 'Not helpful' },
            { value: 'yes', label: 'Helpful' },
            { value: 'all', label: 'All' },
          ]}
        />
        {list.isPending ? (
          <LoadingRows label="Loading feedback" rows={4} />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.data.length === 0 ? (
          <Empty icon={<MessageSquare />} title="No feedback here yet" description="Votes appear as merchants read the guide." />
        ) : (
          <ul className="flex flex-col divide-y divide-border-default">
            {list.data.data.map((f) => (
              <li key={f.id} className="flex flex-col gap-1 py-3">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge size="sm" tone={f.helpful ? 'success' : 'warning'}>
                    {f.helpful ? 'Helpful' : 'Not helpful'}
                  </Badge>
                  <span className="text-caption text-text-muted">
                    {HELP_LANGUAGE_LABELS[f.language]} · {f.tenant?.name ?? 'Removed shop'} · {formatDate(f.updated_at)}
                  </span>
                </span>
                {f.reason && <span className="text-body font-medium text-text-primary">{HELP_FEEDBACK_REASON_LABELS[f.reason]}</span>}
                {f.note && <p className="text-body whitespace-pre-line text-text-secondary">{f.note}</p>}
              </li>
            ))}
          </ul>
        )}
        {list.data && list.data.meta.total > list.data.meta.per_page && (
          <Pagination page={list.data.meta.current_page} perPage={list.data.meta.per_page} total={list.data.meta.total} lastPage={list.data.meta.last_page} noun="votes" onPage={setPage} />
        )}
      </div>
    </Drawer>
  );
}
