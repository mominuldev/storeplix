import { Badge, Button, Skeleton } from '@storeplix/ui';
import { errorMessage, ErrorBlock } from '../catalog/states';
import { clock } from '../commerce/format';
import { ReadOnlyActions } from '../impersonation/ReadOnlyActions';
import { toast } from '../online-store/components/Toast';
import { handlePlanLimit } from '../plan/Banners';
import { deliveryPill } from './developer';
import { useFailedLastDay, useRecentDeliveries, useResendFailed } from './queries';
import { DevCard } from './ui';

// Figma Card / Recent deliveries 144:41536: last 5 rows (status pill · "event · subject" · HH:mm, py 10 gap 10), ghost
// "Log" (opens the deliveries drawer), full-width secondary "Resend failed (n)" when n > 0.

export function RecentDeliveriesCard({ locked, onOpenLog }: { locked: boolean; onOpenLog: (deliveryId?: string) => void }) {
  const recent = useRecentDeliveries();
  const failed = useFailedLastDay();
  const resend = useResendFailed();
  const rows = recent.data?.data.slice(0, 5) ?? [];
  const n = failed.data?.count ?? 0;

  return (
    <DevCard
      title="Recent deliveries"
      gap="gap-1"
      action={
        <Button size="sm" variant="ghost" onClick={() => onOpenLog()}>
          Log
        </Button>
      }
    >
      {recent.isPending ? (
        <div role="status" aria-label="Loading deliveries" className="flex flex-col">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex items-center gap-2.5 py-2.5">
              <Skeleton className="h-[22px] w-12 rounded-full" />
              <Skeleton className="h-2.5 flex-1 rounded-full" />
              <Skeleton className="h-2.5 w-8 rounded-full" />
            </div>
          ))}
        </div>
      ) : recent.isError ? (
        <ErrorBlock title="We couldn’t load deliveries" error={recent.error} onRetry={() => void recent.refetch()} className="py-6" />
      ) : rows.length === 0 ? (
        <p className="py-2.5 text-body text-text-muted">No deliveries yet. Events appear here as soon as an endpoint receives one.</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((d) => {
            const pill = deliveryPill(d);
            return (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => onOpenLog(d.id)}
                  className="-mx-2 flex w-[calc(100%+16px)] items-center gap-2.5 rounded-md px-2 py-2.5 text-left outline-none hover:bg-surface-subtle focus-visible:shadow-focus"
                >
                  <Badge tone={pill.tone} dot>
                    {pill.label}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-body text-text-primary">
                    {d.event_type}
                    {d.subject_label ? ` · ${d.subject_label}` : ''}
                  </span>
                  <span className="shrink-0 text-caption text-text-muted">{clock(d.created_at)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {n > 0 && (
        <ReadOnlyActions className="mt-1">
          <Button
            size="sm"
            variant="secondary"
            fullWidth
            loading={resend.isPending}
            disabled={locked}
            onClick={() =>
              resend.mutate(undefined, {
                onSuccess: (r) => toast(r.count === 1 ? '1 delivery queued again.' : `${r.count} deliveries queued again.`),
                onError: (e) => {
                  if (!handlePlanLimit(e)) toast(errorMessage(e, 'We couldn’t resend. Try again.'), 'error');
                },
              })
            }
          >
            {`Resend failed (${n}${failed.data?.more ? '+' : ''})`}
          </Button>
        </ReadOnlyActions>
      )}
    </DevCard>
  );
}
