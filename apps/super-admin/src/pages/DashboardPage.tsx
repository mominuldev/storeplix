import { Badge, Card, EmptyState, Skeleton } from '@storeplix/ui';
import { BarChart3 } from 'lucide-react';
import { PageHeader } from '../layout/PageHeader';
import { useHealth } from '../lib/health';

// Figma Platform / Dashboard 15:123. Only the API status tile has data today; the MRR/plan-mix/merchant/
// integration widgets are Phase 8 and render as the States 148:34032 empty card until their endpoints exist.
export function DashboardPage() {
  const health = useHealth();
  const month = new Date().toLocaleDateString('en', {
    month: 'long',
    year: 'numeric',
  });
  return (
    <>
      <PageHeader title="Platform overview" subtitle={`All merchants · ${month}`} />
      {/* KPI row 15:272 — 5 columns, gap 16. Tile 15:273: card radius 16, Elevation/1, px 20 py 22, gap 6;
          Body/14 Medium label + status pill (px 8 py 2) on the right; Heading/24 value; Caption muted hint. */}
      <section aria-label="Platform health" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <Card className="flex min-w-0 flex-col gap-1.5 px-5 py-[22px]">
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1 truncate text-body font-medium text-text-secondary">API status</span>
            {health.isPending ? null : health.isError ? (
              <Badge tone="danger" className="h-5 px-2 py-0.5">
                Down
              </Badge>
            ) : (
              <Badge tone="success" className="h-5 px-2 py-0.5">
                Up
              </Badge>
            )}
          </div>
          {health.isPending ? (
            <div role="status" aria-label="Loading API status" className="flex flex-col gap-1.5">
              <Skeleton className="h-8 w-32" />
              <Skeleton className="h-4 w-16" />
            </div>
          ) : (
            <>
              <span className="text-heading-24 text-text-primary">{health.isError ? 'Unreachable' : 'Operational'}</span>
              <span className="text-caption text-text-muted">{health.data ? `v${health.data.version}` : 'Retrying every minute'}</span>
            </>
          )}
        </Card>
      </section>
      <Card>
        <EmptyState
          icon={<BarChart3 />}
          title="Platform metrics are coming next"
          description="MRR, plan mix, new and at-risk merchants, integration health and alerts arrive in Phase 8."
        />
      </Card>
    </>
  );
}
