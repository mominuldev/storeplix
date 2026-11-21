import { Badge, Card, CardBody, CardHeader, Spinner, StatTile } from '@storeplix/ui';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '../layout/PageHeader';
import { api } from '../lib/api';

export function DashboardPage() {
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.health(), retry: false, refetchInterval: 60_000 });
  const month = new Date().toLocaleDateString('en', { month: 'long', year: 'numeric' });
  return (
    <>
      <PageHeader title="Platform overview" subtitle={`All merchants · ${month}`} />
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="API status"
          value={
            health.isPending ? (
              <Spinner size="sm" />
            ) : health.isError ? (
              <Badge tone="danger" dot>
                Unreachable
              </Badge>
            ) : (
              <Badge tone="success" dot>
                Operational
              </Badge>
            )
          }
          hint={health.data ? `v${health.data.version}` : undefined}
        />
      </section>
      <Card>
        <CardHeader title="Coming next" description="Merchant, billing and risk metrics arrive in Phase 8." />
        <CardBody className="text-body text-text-secondary">Use the navigation to explore the planned sections.</CardBody>
      </Card>
    </>
  );
}
