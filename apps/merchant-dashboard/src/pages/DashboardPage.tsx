import { Badge, Card, CardBody, CardHeader, Spinner, StatTile, storeStatusTone } from '@storeplix/ui';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider';
import { PageHeader } from '../layout/PageHeader';
import { api } from '../lib/api';
import { PreviewStoreButton } from '../stores/PreviewStoreButton';
import { storeDomain, useTenantStore } from '../stores/useTenantStore';

function greeting(date = new Date()) {
  const h = date.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

const statusLabel = { draft: 'Draft', active: 'Live', suspended: 'Suspended' } as const;

export function DashboardPage() {
  const { user } = useAuth();
  const store = useTenantStore().data;
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.health(), retry: false, refetchInterval: 60_000 });
  const firstName = user?.name.split(' ')[0] ?? '';

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${firstName}`}
        subtitle={store ? `${store.name} · here is what is happening today.` : 'Welcome to Store Plix.'}
        actions={store && <PreviewStoreButton store={store} />}
      />

      <section aria-label="Overview" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
        {store && (
          <StatTile
            label="Shop status"
            value={
              <Badge tone={storeStatusTone[store.status]} dot>
                {statusLabel[store.status]}
              </Badge>
            }
            hint={store.status === 'draft' ? 'Visitors see “Coming soon” until you publish.' : storeDomain(store)}
          />
        )}
      </section>

      {store && (
        <Card>
          <CardHeader title="Your shop" description="Details customers see on your page, receipts and SMS." />
          <CardBody>
            <dl className="grid gap-4 sm:grid-cols-2">
              {[
                ['Name', store.name],
                ['Link', storeDomain(store)],
                ['Currency', store.currency],
                ['Category', store.business_category ?? '—'],
              ].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-1">
                  <dt className="text-caption text-text-muted">{k}</dt>
                  <dd className="text-body font-medium text-text-primary">{v}</dd>
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>
      )}
    </>
  );
}
