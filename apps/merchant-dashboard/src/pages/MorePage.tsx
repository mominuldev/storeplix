import { cn } from '@storeplix/ui';
import { Bell, ChevronDown, ChevronRight, ExternalLink, Search, Store as StoreIcon } from 'lucide-react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { mainNav, mobileMoreGroups } from '../layout/nav';
import { storeDomain, useTenantStore } from '../stores/useTenantStore';

// Figma Merchant Admin – Mobile · More 32:6541 — "More" app bar (Heading/24 + search + bell), shop card
// (48 avatar, Switch pill, Visit row), grouped MenuRow 30:3202 cards (36 tinted icon tiles), footer links.
// Row hints are the static ones from Figma; data-driven hints/counts (orders, products, …) are not shown.
const groupTile: Record<string, string> = {
  Sales: 'bg-brand-50 text-brand-600',
  Catalog: 'bg-accent-100 text-accent-500',
  Grow: 'bg-success-bg text-success',
  Setup: 'bg-info-bg text-info',
};

const hints: Record<string, string> = {
  '/pos': 'Bill walk-in customers',
  '/reports': 'Profit, couriers, returns',
  '/online-store': 'Theme, pages, domain',
  '/integrations': 'Steadfast, Pathao, bKash',
  '/settings': 'Shop, staff, payments',
};

const roleLabel = (role: string | undefined) => (role ? role.charAt(0).toUpperCase() + role.slice(1) : '');

export function MorePage() {
  const { logout, user, tenants, activeTenant } = useAuth();
  const store = useTenantStore().data;
  const name = store?.name ?? activeTenant?.name ?? 'Your shop';
  const domain = store ? storeDomain(store) : null;

  return (
    <>
      <div className="flex items-center gap-2">
        <h1 className="min-w-0 flex-1 text-heading-24 text-text-primary">More</h1>
        <button type="button" aria-label="Search" className="flex size-11 items-center justify-center rounded-full border border-border-default bg-surface-card text-text-primary lg:hidden">
          <Search className="size-[22px]" aria-hidden />
        </button>
        <button type="button" aria-label="Notifications" className="flex size-11 items-center justify-center rounded-full border border-border-default bg-surface-card text-text-primary lg:hidden">
          <Bell className="size-[22px]" aria-hidden />
        </button>
      </div>

      <section aria-label="Your shop" className="flex flex-col gap-3 rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1">
        <div className="flex items-center gap-3">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-[14px] bg-accent-100 text-heading text-accent-500">
            {name.trim().charAt(0).toUpperCase() || '?'}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-body-lg font-medium text-text-primary">{name}</span>
            <span className="truncate text-caption text-text-muted">
              {[roleLabel(activeTenant?.role), user?.name].filter(Boolean).join(' · ')}
            </span>
          </span>
          {tenants.length > 1 && (
            <Link to="/choose-shop" className="flex h-10 items-center gap-1 rounded-lg bg-brand-50 pr-2 pl-3 text-body font-semibold text-brand-600">
              Switch <ChevronDown className="size-[18px]" aria-hidden />
            </Link>
          )}
        </div>
        {domain && (
          <a href={`https://${domain}`} target="_blank" rel="noreferrer" className="flex h-11 items-center gap-2 rounded-lg bg-surface-subtle px-3">
            <StoreIcon className="size-[18px] shrink-0 text-text-secondary" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-body text-text-secondary">{domain}</span>
            <span className="text-body font-semibold text-brand-600">Visit</span>
            <ExternalLink className="size-4 text-brand-600" aria-hidden />
          </a>
        )}
      </section>

      {mobileMoreGroups.map((group) => (
        <section key={group.heading} aria-label={group.heading} className="flex flex-col gap-2">
          <h2 className="pl-1 text-caption font-medium tracking-[0.06em] text-text-muted uppercase">{group.heading}</h2>
          <div className="flex flex-col rounded-card border border-border-default bg-surface-card py-1 shadow-elevation-1">
            {group.items.map((to, i) => {
              const item = mainNav.find((n) => n.to === to)!;
              const Icon = item.icon;
              return (
                <Link
                  key={to}
                  to={to}
                  className={cn(
                    'flex min-h-14 items-center gap-3 py-2.5 pr-3 pl-4 hover:bg-surface-subtle',
                    i < group.items.length - 1 && 'border-b border-border-default',
                  )}
                >
                  <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-control', groupTile[group.heading])}>
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-px">
                    <span className="truncate text-body-lg font-medium text-text-primary">{item.label}</span>
                    {hints[to] && <span className="truncate text-caption text-text-muted">{hints[to]}</span>}
                  </span>
                  <ChevronRight className="size-5 shrink-0 text-text-muted" aria-hidden />
                </Link>
              );
            })}
          </div>
        </section>
      ))}

      <footer className="flex flex-col items-center gap-1 pt-1 text-center">
        <p className="text-body font-medium text-text-secondary">
          <Link to="/help">Help &amp; support</Link>
          {' · '}
          <button type="button" onClick={() => void logout()} className="font-medium text-text-secondary">
            Log out
          </button>
        </p>
        <p className="text-caption text-text-muted">Storeplix v1.0 · Made in Bangladesh</p>
      </footer>
    </>
  );
}
