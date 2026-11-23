import { Button, EmptyState, Spinner } from '@storeplix/ui';
import { Store as StoreIcon } from 'lucide-react';
import { Navigate, Outlet } from 'react-router';
import { isTenantSuspended } from '@storeplix/api-client';
import { useAuth } from '../auth/AuthProvider';
import { SuspendedShopScreen } from '../impersonation/screens';
import { useSuspendedTenantId } from '../impersonation/suspension';
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
  const { tenants, tenantId, logout } = useAuth();
  const store = useTenantStore();
  const suspendedTenantId = useSuspendedTenantId();

  if (tenants.length === 0) return <Navigate to="/onboarding/shop" replace />;
  if (!tenantId) return tenants.length > 1 ? <Navigate to="/choose-shop" replace /> : <FullPageSpinner />;
  // Phase 8.1 (P8-12): 403 `tenant_suspended` on any merchant call for this shop.
  if ((tenantId && suspendedTenantId === tenantId) || (store.isError && isTenantSuspended(store.error))) {
    return <SuspendedShopScreen onSignOut={() => void logout()} canSwitch={tenants.length > 1} />;
  }
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
