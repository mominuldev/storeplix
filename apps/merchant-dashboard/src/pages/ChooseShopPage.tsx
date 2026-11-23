import type { Store, TenantMembership } from '@storeplix/types';
import { Checkbox, cn, Spinner } from '@storeplix/ui';
import { useQueries } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { DEFAULT_TENANT_KEY, useAuth } from '../auth/AuthProvider';
import { AuthShell, FormTitle } from '../onboarding/AuthShell';
import { fetchTenantStore, storeDomain, storeKey } from '../stores/useTenantStore';

const BANGLA = 'সব দোকান এক জায়গা থেকে চালান।';
const tiles = ['bg-accent-100 text-warning', 'bg-info-bg text-info', 'bg-success-bg text-success'];
const roleLabel: Record<string, string> = { owner: 'Owner', admin: 'Admin', staff: 'Staff' };

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

// Figma Merchant Onboarding · L4 Choose a shop 58:957. Contract D1 (revised): one store per tenant, so each
// row is a tenant membership with its single store; picking a row sets the active tenant.
// "Create another shop" is omitted: a second shop means a new tenant, which has no API yet.
export function ChooseShopPage() {
  const { user, tenants, tenantId, setTenant, logout } = useAuth();
  const navigate = useNavigate();
  const [remember, setRemember] = useState(() => {
    try {
      return localStorage.getItem(DEFAULT_TENANT_KEY) === '1';
    } catch {
      return false;
    }
  });
  const stores = useQueries({
    queries: tenants.map((t) => ({ queryKey: storeKey(t.id), queryFn: () => fetchTenantStore(t.id), retry: false })),
  });

  if (tenants.length <= 1) return <Navigate to="/" replace />;

  const choose = (t: TenantMembership) => {
    try {
      if (remember) localStorage.setItem(DEFAULT_TENANT_KEY, '1');
      else localStorage.removeItem(DEFAULT_TENANT_KEY);
    } catch {
      /* ignore */
    }
    setTenant(t.id);
    navigate('/', { replace: true });
  };

  const signOut = (
    <button type="button" onClick={() => void logout()} className="text-body font-semibold text-brand-600 hover:text-brand-700">
      Sign out
    </button>
  );

  return (
    <AuthShell
      pitch={{ eyebrow: 'Your shop, orders and money — in one place', headline: 'One login. All your shops.', bangla: BANGLA }}
      topLeft="Welcome back"
      topRight={
        <>
          Not {user?.name.split(' ')[0]}? {signOut}
        </>
      }
      mobile={{ variant: 'hero', title: 'Choose a shop', bangla: BANGLA }}
      mobileFooter={<p className="flex gap-1 text-body text-text-secondary">Not {user?.name.split(' ')[0]}? {signOut}</p>}
      showTrustRow={false}
    >
      <div className="flex flex-col gap-4 lg:gap-7">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-full bg-brand-100 text-caption font-medium text-brand-700">
              {initials(user?.name ?? '')}
            </span>
            <span className="text-body font-medium text-text-secondary">
              {user?.name} · {user?.phone ?? user?.email}
            </span>
          </div>
          <FormTitle className="hidden lg:flex" title="Choose a shop" />
          <p className="text-body-lg text-text-secondary">You have access to {tenants.length} shops.</p>
        </div>
        <ul className="flex flex-col gap-2.5">
          {tenants.map((t, i) => {
            const q = stores[i]!;
            const store = q.data as Store | null | undefined;
            const selected = t.id === tenantId;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => choose(t)}
                  aria-current={selected || undefined}
                  className={cn(
                    'flex w-full items-center gap-3.5 rounded-[14px] px-4 py-3.5 text-left shadow-elevation-1 outline-none focus-visible:shadow-focus',
                    selected ? 'border-2 border-brand-600 bg-brand-50' : 'border border-border-default bg-surface-card hover:bg-surface-subtle',
                  )}
                >
                  <span className={cn('flex size-11 shrink-0 items-center justify-center rounded-lg text-heading', tiles[i % tiles.length])}>
                    {t.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-body-lg font-medium text-text-primary">{store?.name ?? t.name}</span>
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-caption font-medium',
                          t.role === 'staff' ? 'bg-surface-subtle text-text-secondary' : 'bg-brand-50 text-brand-700',
                        )}
                      >
                        {t.role_name || roleLabel[t.role] || t.role}
                      </span>
                    </span>
                    <span className="truncate text-caption text-text-secondary">
                      {q.isPending ? (
                        <Spinner size="sm" label="Loading shop" />
                      ) : store ? (
                        `${storeDomain(store)} · ${store.status === 'active' ? 'Live' : store.status === 'draft' ? 'Draft' : 'Suspended'}`
                      ) : (
                        'No shop set up yet'
                      )}
                    </span>
                  </span>
                  {selected && <span className="text-caption text-text-muted">Last used</span>}
                  <ChevronRight aria-hidden className="size-[18px] shrink-0 text-text-muted" />
                </button>
              </li>
            );
          })}
        </ul>
        <Checkbox label="Open this shop by default next time" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
      </div>
    </AuthShell>
  );
}
