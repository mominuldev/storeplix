import { Button, EmptyState, Spinner } from '@storeplix/ui';
import { Store as StoreIcon } from 'lucide-react';
import { Navigate, Outlet } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { useTenantStore } from './useTenantStore';

function FullPageSpinner() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-canvas">
      <Spinner size="lg" label="Loading your shop" />
    </div>
  );
}

/**
 * Post-login routing (contract D1, revised): >1 memberships and none chosen → Choose a shop;
 * active tenant without a store → Name your shop; otherwise the dashboard.
 */
export function StoreGate() {
  const { tenants, tenantId } = useAuth();
  const store = useTenantStore();

  if (tenants.length === 0) return <Navigate to="/onboarding/shop" replace />;
  if (!tenantId) return tenants.length > 1 ? <Navigate to="/choose-shop" replace /> : <FullPageSpinner />;
  if (store.isPending) return <FullPageSpinner />;
  if (store.isError) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-surface-canvas px-4">
        <EmptyState
          icon={<StoreIcon />}
          title="We couldn't load your shop"
          description={store.error.message}
          action={<Button onClick={() => void store.refetch()}>Try again</Button>}
        />
      </div>
    );
  }
  if (!store.data) return <Navigate to="/onboarding/shop" replace />;
  return <Outlet />;
}
