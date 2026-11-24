import { isApiError } from '@storeplix/api-client';
import type { Automation, AutomationKpis, AutomationRun, RecipeCard } from '@storeplix/types';
import { Badge, Button, buttonVariants, KpiTile, Skeleton, Toggle } from '@storeplix/ui';
import { RefreshCw, Send, ShoppingCart, Sparkles } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { formatBdt, formatCount } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage, LoadingRows, NoResults, StateCard } from '../catalog/states';
import { allowanceLeft, allowanceOf } from '../campaigns/campaigns';
import { PageHeader } from '../layout/PageHeader';
import { toast } from '../online-store/components/Toast';
import { useFeatures } from '../plan/useFeatures';
import { automationPath, automationsLocked, clockOrDate, incompleteMessage, relativeTime, runIcon, runLine, succeededHint } from './automations';
import { useAutomationRuns, useAutomations, useCreateAutomation, useToggleAutomation } from './queries';
import { AutomationPlanNote, Card, IconBadge, PausedPill, QuietHoursNote, RecipeTags, recipeIcon, runIconOf } from './ui';

// Figma Automations 140:30336 (Main 140:30338), PHASE-8-6 §10.1. Header "Run log" + "+ New automation" (scrolls to the
// recipe tiles); KPI tiles Active recipes, Runs this week, Messages sent (composed), Carts recovered (composed) — "Risky
// orders held" / "Time saved" hidden; "Your automations" table with the ON toggle; "Recent runs" (last 6); "Start from a
// recipe" tiles for catalogue recipes not added yet (hidden Figma recipes never shown). Below `lg` the cards stack and the
// table rows wrap (Q166).

export function AutomationsPage() {
  const navigate = useNavigate();
  const scope = useStoreScope();
  const features = useFeatures();
  const locked = automationsLocked(features.data);
  const list = useAutomations();
  const runs = useAutomationRuns({});
  const create = useCreateAutomation();
  const toggle = useToggleAutomation();
  const tz = scope.store?.timezone ?? 'Asia/Dhaka';
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;
  const recipes = (meta?.recipes ?? []).filter((r) => !r.added);

  const use = (r: RecipeCard) =>
    create.mutate(r.recipe, {
      onSuccess: (a) => navigate(automationPath(a)),
      onError: (e) => {
        if (isApiError(e) && e.code === 'automation_exists') {
          const existing = rows.find((x) => x.recipe === r.recipe);
          if (existing) navigate(automationPath(existing));
          return;
        }
        toast(isApiError(e) && e.status === 402 ? 'Automations are part of the Starter plan.' : errorMessage(e), 'error');
      },
    });

  const onToggle = (a: Automation, on: boolean) =>
    toggle.mutate(
      { id: a.id, on },
      {
        onSuccess: () => toast(on ? `“${a.name}” is on.` : `“${a.name}” is off. Nothing is deleted.`),
        onError: (e) => {
          if (isApiError(e) && e.code === 'automation_incomplete') toast(incompleteMessage(e.details as Record<string, unknown> | undefined), 'error');
          else if (isApiError(e) && e.status === 402) toast('Automations are part of the Starter plan.', 'error');
          else toast(errorMessage(e), 'error');
        },
      },
    );

  return (
    <>
      <PageHeader
        title="Automations"
        subtitle="Recipes that do the routine work for you — when something happens, Storeplix does the next step."
        actions={
          <>
            <Link to="/marketing/automations/runs" className={buttonVariants({ variant: 'secondary' })}>
              Run log
            </Link>
            <Button disabled={locked} onClick={() => document.getElementById('start-from-a-recipe')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
              + New automation
            </Button>
          </>
        }
      />
      {features.data && locked && <AutomationPlanNote canSeePlans={scope.canViewBilling} />}

      {list.isPending ? (
        <PageSkeleton />
      ) : list.isError ? (
        <StateCard>
          <ErrorBlock title="We couldn’t load automations" error={list.error} onRetry={() => void list.refetch()} />
        </StateCard>
      ) : (
        <>
          <Kpis kpis={meta!.kpis} features={features.data} />
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
            <Card
              title="Your automations"
              subtitle="Turn a recipe off any time — nothing is deleted."
              className="flex-1 gap-4"
              action={
                meta!.kpis.active > 0 ? (
                  <Badge tone="success" dot className="shrink-0">
                    {formatCount(meta!.kpis.active)} on
                  </Badge>
                ) : undefined
              }
            >
              {rows.length === 0 ? (
                <div className="rounded-lg border border-border-default">
                  <NoResults
                    title="No automations yet"
                    description="Pick a recipe below, check the message and switch it on."
                    onClear={locked ? undefined : () => document.getElementById('start-from-a-recipe')?.scrollIntoView({ behavior: 'smooth' })}
                    clearLabel="Start from a recipe"
                  />
                </div>
              ) : (
                <AutomationsTable rows={rows} tz={tz} locked={locked} busyId={toggle.isPending ? toggle.variables?.id : undefined} onToggle={onToggle} onOpen={(a) => navigate(automationPath(a))} />
              )}
              <QuietHoursNote />
            </Card>
            <RecentRuns runs={runs.data?.pages[0]?.data ?? []} pending={runs.isPending} error={runs.isError ? runs.error : null} onRetry={() => void runs.refetch()} tz={tz} />
          </div>
          <Card id="start-from-a-recipe" title="Start from a recipe" subtitle="Ready-made for Bangladeshi COD shops. Pick one, check the message, switch it on." className="scroll-mt-6 gap-4">
            {recipes.length === 0 ? (
              <p className="text-body text-text-secondary">You’ve added every recipe. Open one above to change it.</p>
            ) : (
              <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {recipes.map((r) => {
                  const Icon = recipeIcon(r.recipe, r.icon);
                  return (
                    <li key={r.recipe} className="flex flex-col items-start gap-2.5 rounded-lg border border-border-default p-4">
                      <IconBadge icon={Icon} tone="brand" />
                      <h3 className="text-body font-semibold text-text-primary">{r.name}</h3>
                      <p className="text-caption text-text-secondary">{r.description}</p>
                      <Button variant="secondary" size="sm" disabled={locked || create.isPending} loading={create.isPending && create.variables === r.recipe} onClick={() => use(r)} aria-label={`Use recipe ${r.name}`}>
                        Use recipe
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </>
      )}
    </>
  );
}

function PageSkeleton() {
  return (
    <div role="status" aria-label="Loading automations" className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-[118px] rounded-card" />
        ))}
      </div>
      <Skeleton className="h-[420px] rounded-card" />
    </div>
  );
}

function Kpis({ kpis, features }: { kpis: AutomationKpis; features: Parameters<typeof allowanceOf>[0] }) {
  const sms = allowanceOf(features, 'sms');
  const left = allowanceLeft(sms);
  return (
    <section aria-label="Automations summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <KpiTile icon={<Sparkles />} label="Active recipes" value={formatCount(kpis.active)} hint={`${formatCount(kpis.drafts)} draft · ${formatCount(kpis.total)} total`} />
      <KpiTile icon={<RefreshCw />} label="Runs this week" value={formatCount(kpis.runs_7d)} hint={succeededHint(kpis.runs_7d_succeeded_pct)} />
      <KpiTile icon={<Send />} label="Messages sent" value={formatCount(kpis.messages_sent_month)} hint={left === null ? 'this month' : `this month · ${formatCount(left)} SMS left`} />
      <KpiTile icon={<ShoppingCart />} label="Carts recovered" value={formatCount(kpis.carts_recovered_30d)} hint={`${formatBdt(kpis.recovered_revenue_30d)} · last 30 days`} />
    </section>
  );
}

function AutomationsTable({ rows, tz, locked, busyId, onToggle, onOpen }: { rows: Automation[]; tz: string; locked: boolean; busyId?: string; onToggle: (a: Automation, on: boolean) => void; onOpen: (a: Automation) => void }) {
  return (
    <div role="table" aria-label="Your automations" className="overflow-hidden rounded-lg border border-border-default">
      <div role="rowgroup" className="hidden bg-surface-subtle md:block">
        <div role="row" className="flex items-center gap-4 px-4 py-2.5 text-caption font-medium text-text-muted uppercase">
          <span role="columnheader" className="min-w-0 flex-1">
            Recipe
          </span>
          <span role="columnheader" className="w-24 shrink-0">
            Runs · 7 days
          </span>
          <span role="columnheader" className="w-[110px] shrink-0">
            Last run
          </span>
          <span role="columnheader" className="w-12 shrink-0">
            On
          </span>
        </div>
      </div>
      <div role="rowgroup">
        {rows.map((a) => (
          <div
            key={a.id}
            role="row"
            tabIndex={0}
            aria-label={a.name}
            onClick={() => onOpen(a)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onOpen(a);
            }}
            className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-2 border-t border-border-default px-4 py-3 outline-none first:border-t-0 hover:bg-surface-canvas focus-visible:shadow-focus md:flex-nowrap"
          >
            <div role="cell" className="flex min-w-0 basis-full flex-col gap-1.5 md:basis-auto md:flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-body font-medium text-text-primary">{a.name}</span>
                {a.paused_reason === 'plan' && <PausedPill />}
              </span>
              <RecipeTags trigger={a.trigger_label} action={a.action_label} />
            </div>
            <span role="cell" className="text-body text-text-primary md:w-24 md:shrink-0">
              <span className="text-text-muted md:hidden">Runs · 7 days </span>
              {a.status === 'draft' ? '—' : formatCount(a.runs_7d)}
            </span>
            <span role="cell" className="flex-1 text-body text-text-primary md:w-[110px] md:flex-none md:shrink-0">
              {a.status === 'draft' ? 'Draft' : relativeTime(a.last_run_at, tz)}
            </span>
            <span role="cell" className="flex w-12 shrink-0 justify-end md:justify-start" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
              <Toggle label={`${a.name} on`} checked={a.status === 'on'} disabled={busyId === a.id || (locked && a.status !== 'on')} onChange={(on) => onToggle(a, on)} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RecentRuns({ runs, pending, error, onRetry, tz }: { runs: AutomationRun[]; pending: boolean; error: unknown; onRetry: () => void; tz: string }) {
  const rows = runs.slice(0, 6);
  return (
    <Card
      title="Recent runs"
      className="gap-1 lg:w-[360px] lg:shrink-0"
      action={
        <Link to="/marketing/automations/runs" className="text-caption font-medium text-brand-600">
          See all
        </Link>
      }
    >
      {pending ? (
        <LoadingRows rows={4} label="Loading runs" />
      ) : error ? (
        <ErrorBlock title="We couldn’t load runs" error={error} onRetry={onRetry} />
      ) : rows.length === 0 ? (
        <p className="py-3 text-body text-text-secondary">No runs yet. They show up here as soon as a recipe does something.</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((r) => {
            const icon = runIcon(r);
            return (
              <li key={r.id} className="flex items-center gap-3 py-2.5">
                <IconBadge icon={runIconOf[icon.kind]} tone={icon.tone} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <p className="truncate text-body font-medium text-text-primary">
                    {r.subject.label} · {r.automation.name}
                  </p>
                  <p className="truncate text-caption text-text-secondary">{runLine(r)}</p>
                </div>
                <time dateTime={r.started_at} className="shrink-0 text-caption text-text-muted">
                  {clockOrDate(r.started_at, tz)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export default AutomationsPage;
