import { RUN_STATUSES, type AutomationRun, type RunStatus } from '@storeplix/types';
import { Badge, Button, Chip, cn } from '@storeplix/ui';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { dateTime, formatBdt } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, LoadingRows, NoResults } from '../catalog/states';
import { FilterSelect } from '../catalog/ui';
import { PageHeader } from '../layout/PageHeader';
import { outcomeReasonLabels, runStatusMeta, stepLine } from './automations';
import { useAutomationRuns, useAutomations } from './queries';

// PHASE-8-6 §10.4 Run log (composed: page header + filters + list, states 148:34032). Filters: automation, status chips
// (All / Completed / Waiting / Skipped / Stopped / Failed). Rows: time, automation, subject, masked contact, outcome pill +
// reason, steps summary; a row expands to its step list. Cursor "Load more". Addresses are always masked (API).

const CHIPS: { value: RunStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'completed', label: 'Completed' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'failed', label: 'Failed' },
];

export function AutomationRunsPage() {
  const scope = useStoreScope();
  const tz = scope.store?.timezone ?? 'Asia/Dhaka';
  const [params, setParams] = useSearchParams();
  const automationId = params.get('automation') ?? '';
  const raw = params.get('status');
  const status = (RUN_STATUSES as readonly string[]).includes(raw ?? '') ? (raw as RunStatus) : 'all';
  const automations = useAutomations();
  const runs = useAutomationRuns({ automation_id: automationId || undefined, status: status === 'all' ? undefined : status === 'waiting' ? ['waiting', 'running'] : [status] });
  const rows = runs.data?.pages.flatMap((p) => p.data) ?? [];
  const filtered = !!automationId || status !== 'all';

  const set = (k: string, v: string | null) =>
    setParams(
      (p) => {
        if (v) p.set(k, v);
        else p.delete(k);
        return p;
      },
      { replace: true },
    );

  return (
    <>
      <PageHeader title="Run log" subtitle="Every time a recipe ran: what it did, what it skipped and why. Kept for 90 days." />
      <section aria-label="Runs" className="flex min-w-0 flex-col rounded-card border border-border-default bg-surface-card shadow-elevation-1">
        <div className="flex flex-col gap-3 border-b border-border-default px-4 pt-3.5 pb-3 sm:flex-row sm:items-center">
          <FilterSelect label="Automation" value={automationId} onChange={(e) => set('automation', e.target.value || null)}>
            <option value="">All automations</option>
            {(automations.data?.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </FilterSelect>
          <div role="group" aria-label="Status" className="flex flex-wrap gap-2">
            {CHIPS.map((c) => (
              <Chip key={c.value} check={false} selected={status === c.value} aria-pressed={status === c.value} onClick={() => set('status', c.value === 'all' ? null : c.value)}>
                {c.label}
              </Chip>
            ))}
          </div>
        </div>
        {runs.isPending ? (
          <LoadingRows label="Loading runs" />
        ) : runs.isError ? (
          <ErrorBlock error={runs.error} onRetry={() => void runs.refetch()} />
        ) : rows.length === 0 ? (
          filtered ? (
            <NoResults title="No runs match these filters" onClear={() => setParams(new URLSearchParams(), { replace: true })} clearLabel="Clear filters" />
          ) : (
            <NoResults title="No runs yet" description="Runs show up here as soon as a recipe that’s on is triggered." />
          )
        ) : (
          <>
            <ul className="flex flex-col">
              {rows.map((r) => (
                <RunRow key={r.id} run={r} tz={tz} />
              ))}
            </ul>
            {runs.hasNextPage && (
              <div className="flex justify-center border-t border-border-default p-3">
                <Button variant="secondary" size="sm" loading={runs.isFetchingNextPage} onClick={() => void runs.fetchNextPage()}>
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </>
  );
}

function RunRow({ run, tz }: { run: AutomationRun; tz: string }) {
  const [open, setOpen] = useState(false);
  const meta = runStatusMeta[run.status];
  const summary = run.steps.length === 0 ? 'No steps' : run.steps.map(stepLine).join(' · ');
  const panel = `run-${run.id}`;
  void tz;
  return (
    <li className="border-t border-border-default first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full flex-wrap items-start gap-x-4 gap-y-1.5 px-4 py-3 text-left outline-none hover:bg-surface-canvas focus-visible:shadow-focus md:flex-nowrap md:items-center"
      >
        <time dateTime={run.started_at} className="w-full shrink-0 text-caption text-text-muted md:w-32">
          {dateTime(run.started_at)}
        </time>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-body font-medium text-text-primary">
            {run.subject.label} · {run.automation.name}
          </span>
          <span className="truncate text-caption text-text-secondary">
            {run.contact?.masked_address ? `${run.contact.name ?? 'Customer'} · ${run.contact.masked_address}` : (run.contact?.name ?? '—')}
            {' · '}
            {summary}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <Badge tone={meta.tone} dot>
            {meta.label}
            {run.outcome_reason ? ` · ${outcomeReasonLabels[run.outcome_reason]}` : ''}
          </Badge>
          <ChevronDown aria-hidden className={cn('size-4 text-text-muted transition-transform', open && 'rotate-180')} />
        </span>
      </button>
      {open && (
        <div id={panel} className="flex flex-col gap-2 bg-surface-canvas px-4 pt-1 pb-4 md:pl-40">
          {run.steps.length === 0 ? (
            <div className="flex flex-col gap-1">
              <p className="text-caption text-text-secondary">No action ran. {run.outcome_reason ? outcomeReasonLabels[run.outcome_reason] : ''}</p>
              {run.outcome_detail && run.outcome_detail.conditions.some((c) => !c.passed) && (
                <ul aria-label="Conditions not met" className="flex flex-col gap-0.5 text-caption text-text-secondary">
                  {run.outcome_detail.conditions.filter((c) => !c.passed).map((c) => (
                    <li key={c.field}>
                      <span className="font-medium text-text-primary">{c.label}</span>
                      {c.detail ? ` · ${c.detail}` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <ol aria-label="Steps" className="flex flex-col gap-1.5">
              {run.steps.map((s) => (
                <li key={s.index} className="flex flex-wrap items-center gap-2 text-caption text-text-secondary">
                  <span className="font-medium text-text-primary">Step {s.index + 1}</span>
                  <span>{stepLine(s)}</span>
                  {s.parts > 0 && <span>· {s.parts} SMS</span>}
                  <span className="text-text-muted">· {dateTime(s.executed_at)}</span>
                </li>
              ))}
            </ol>
          )}
          {run.status === 'waiting' && run.resume_at && <p className="text-caption text-text-secondary">Next step at {dateTime(run.resume_at)}.</p>}
          {run.conversion && (
            <p className="text-caption text-success">
              Recovered: order {run.conversion.order.number} · {formatBdt(run.conversion.order.total_amount)}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export default AutomationRunsPage;
