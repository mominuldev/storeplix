import { isApiError } from '@storeplix/api-client';
import { Badge, Card, CardBody, CardHeader, EmptyState, Spinner, StatTile, storeStatusTone } from '@storeplix/ui';
import { useQuery } from '@tanstack/react-query';
import { Store as StoreIcon } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { PageHeader } from '../layout/PageHeader';
import { api } from '../lib/api';

function greeting(date = new Date()) {
  const h = date.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export function DashboardPage() {
  const { user, activeTenant, tenantId } = useAuth();
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.health(), retry: false, refetchInterval: 60_000 });
  const stores = useQuery({
    queryKey: ['stores', tenantId],
    queryFn: () => api.stores.list(),
    enabled: !!tenantId,
    retry: false,
  });

  const firstName = user?.name.split(' ')[0] ?? '';

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${firstName}`}
        subtitle={activeTenant ? `${activeTenant.name} · here is what is happening today.` : 'Welcome to Store Plix.'}
      />

      <section aria-label="System status" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="API status"
          value={
            health.isPending ? (
              <Spinner size="sm" label="Checking API" />
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
          hint={health.data ? `v${health.data.version} · ${new Date(health.data.time).toLocaleTimeString()}` : health.isError ? 'Is the API running on :8000?' : undefined}
        />
        <StatTile label="Shops" value={stores.data?.data.length ?? '—'} hint={activeTenant?.name} />
      </section>

      <Card>
        <CardHeader title="Your shops" description="Shops in this workspace." />
        <CardBody>
          {!tenantId ? (
            <EmptyState icon={<StoreIcon />} title="No workspace yet" description="Your account is not linked to a shop workspace yet." />
          ) : stores.isPending ? (
            <div className="flex justify-center py-8">
              <Spinner label="Loading shops" />
            </div>
          ) : stores.isError ? (
            <EmptyState
              icon={<StoreIcon />}
              title="Couldn't load shops"
              description={isApiError(stores.error) ? stores.error.message : 'Please try again.'}
            />
          ) : stores.data.data.length === 0 ? (
            <EmptyState icon={<StoreIcon />} title="No shops yet" description="Create your first shop to start selling." />
          ) : (
            <ul className="divide-y divide-border-default">
              {stores.data.data.map((store) => (
                <li key={store.id} className="flex items-center gap-3 py-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-accent-100 text-body font-semibold text-warning">
                    {store.name.charAt(0).toUpperCase()}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-body font-semibold text-text-primary">{store.name}</span>
                    <span className="truncate text-caption text-text-muted">{store.primary_domain}</span>
                  </div>
                  <span className="hidden text-caption text-text-secondary sm:inline">{store.currency}</span>
                  <Badge tone={storeStatusTone[store.status]} dot className="capitalize">
                    {store.status}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </>
  );
}
