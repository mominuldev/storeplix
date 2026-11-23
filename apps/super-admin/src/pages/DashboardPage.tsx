import { Avatar, Card, cn, formatCount, KpiTile, Skeleton } from '@storeplix/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Building, ChevronRight, CheckCircle2 } from 'lucide-react';
import { Link } from 'react-router';
import { TenantStatusBadge } from '../components/badges';
import { Empty, ErrorState, LoadingRows } from '../components/States';
import { PageHeader } from '../layout/PageHeader';
import { api } from '../lib/api';
import { formatDate, formatMonth, money, planName } from '../lib/format';

// Figma Platform / Dashboard 15:123 — subset for 8.1 (§7.1, P8-18): range tabs and Export hidden; KPI row shows only
// "Active shops" (paying vs free); "New merchants" list (15:417 without orders) + "Needs attention" box. Every
// metric that needs analytics (MRR, trial → paid, GMV, churn, plan mix chart, integration health) is 8.2.
export function DashboardPage() {
  const overview = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => api.admin.overview(),
  });
  const o = overview.data;

  const attention = o
    ? [
        o.past_due.count > 0 && {
          key: 'past_due',
          to: '/merchants?tab=past_due',
          tone: 'warning' as const,
          title: `${formatCount(o.past_due.count)} subscription${o.past_due.count === 1 ? '' : 's'} past due`,
          hint: `${money(o.past_due.amount)} to collect`,
        },
        o.domains.failing > 0 && {
          key: 'domains',
          to: '/domains?state=ssl_failing',
          tone: 'danger' as const,
          title: `${formatCount(o.domains.failing)} custom domain${o.domains.failing === 1 ? '' : 's'} failing`,
          hint: 'DNS, verification or SSL checks failed',
        },
        o.active_impersonations > 0 && {
          key: 'impersonations',
          to: '/impersonations',
          tone: 'brand' as const,
          title: `${formatCount(o.active_impersonations)} active impersonation${o.active_impersonations === 1 ? '' : 's'}`,
          hint: 'Read-only support sessions running now',
        },
      ].filter((x): x is Exclude<typeof x, false> => !!x)
    : [];

  return (
    <>
      <PageHeader title="Platform overview" subtitle={`All merchants · ${formatMonth()}`} />
      {overview.isError ? (
        <Card>
          <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
        </Card>
      ) : (
        <>
          <section aria-label="Key numbers" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {o ? (
              <KpiTile
                label="Active shops"
                value={formatCount(o.tenants.active)}
                hint={`${formatCount(o.subscriptions.paying)} paying · ${formatCount(o.subscriptions.free)} free`}
              />
            ) : (
              <div
                role="status"
                aria-label="Loading key numbers"
                className="flex flex-col gap-2 rounded-card border border-border-default bg-surface-card px-5 py-[18px]"
              >
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-8 w-20" />
                <Skeleton className="h-3 w-32" />
              </div>
            )}
          </section>
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <Card className="min-w-0">
              <div className="flex items-center justify-between gap-3 px-6 pt-6 pb-4">
                <h2 className="text-heading text-text-primary">New merchants</h2>
                <Link to="/merchants" className="flex items-center gap-1 text-body font-medium text-brand-600 hover:underline">
                  All merchants <ArrowRight aria-hidden className="size-4" />
                </Link>
              </div>
              {!o ? (
                <LoadingRows label="Loading new merchants" />
              ) : o.newest_tenants.length === 0 ? (
                <Empty icon={<Building />} title="No merchants yet" description="Shops appear here as soon as merchants sign up." />
              ) : (
                <ul aria-label="New merchants" className="border-t border-border-default">
                  {o.newest_tenants.map((t) => (
                    <li key={t.id} className="border-b border-border-default last:border-b-0">
                      <Link
                        to={`/merchants/${t.id}`}
                        className="flex items-center gap-3 px-6 py-4 outline-none hover:bg-surface-subtle focus-visible:bg-surface-subtle"
                      >
                        <Avatar name={t.name} className="rounded-md" />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-body font-semibold text-text-primary">{t.name}</span>
                          <span className="truncate text-caption text-text-muted">{t.store?.primary_host}</span>
                        </span>
                        <span className="hidden w-28 shrink-0 text-body text-text-primary md:block">
                          {planName(t.plan_code)}
                          {t.subscription_status === 'trialing' ? ' · trial' : ''}
                        </span>
                        <span className="hidden w-24 shrink-0 text-caption text-text-muted md:block">{formatDate(t.created_at)}</span>
                        <span className="w-20 shrink-0">
                          <TenantStatusBadge tenant={t} />
                        </span>
                        <ChevronRight aria-hidden className="size-4 text-text-muted" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card className="h-fit">
              <h2 className="px-6 pt-6 pb-4 text-heading text-text-primary">Needs attention</h2>
              <div className="flex flex-col gap-3 px-6 pb-6">
                {!o ? (
                  <>
                    <Skeleton className="h-14 w-full rounded-lg" />
                    <Skeleton className="h-14 w-full rounded-lg" />
                  </>
                ) : attention.length === 0 ? (
                  <p className="flex items-center gap-2 rounded-lg bg-success-bg px-4 py-3 text-body text-success">
                    <CheckCircle2 aria-hidden className="size-4" /> Nothing needs attention right now.
                  </p>
                ) : (
                  attention.map((a) => (
                    <Link
                      key={a.key}
                      to={a.to}
                      className={cn(
                        'flex flex-col gap-0.5 rounded-lg px-4 py-3 outline-none focus-visible:shadow-focus',
                        a.tone === 'warning' && 'bg-warning-bg text-warning',
                        a.tone === 'danger' && 'bg-danger-bg text-danger',
                        a.tone === 'brand' && 'bg-brand-50 text-brand-700',
                      )}
                    >
                      <span className="text-body font-semibold">{a.title}</span>
                      <span className="text-caption text-text-secondary">{a.hint}</span>
                    </Link>
                  ))
                )}
              </div>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
