import { cn } from '@storeplix/ui';
import { Bell, ChevronDown, House, Menu, Package, Plus, Search, ShoppingBag } from 'lucide-react';
import { Link, NavLink, useLocation } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { useDashboard } from '../catalog/queries';
import { can } from '../lib/permissions';
import { storeDomain, useTenantStore } from '../stores/useTenantStore';

// Figma Merchant Admin – Mobile · Today app bar 31:4300 (60h): shop avatar, name + domain, search, bell.
export function MobileAppBar() {
  const store = useTenantStore().data;
  const { pathname } = useLocation();
  // More 32:6541 has its own "More" app bar (rendered by MorePage).
  if (pathname === '/more') return null;
  return (
    <header className="sticky top-[var(--sp-banner-h,0px)] z-20 flex h-15 items-center gap-3 bg-surface-card px-4 lg:hidden">
      <Link to="/more" className="flex min-w-0 flex-1 items-center gap-3" aria-label="Switch shop">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent-100 text-body-lg font-medium text-accent-500">
          {(store?.name ?? '?').charAt(0).toUpperCase()}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1 truncate text-body-lg font-medium text-text-primary">
            {store?.name ?? 'Store Plix'} <ChevronDown className="size-4 text-text-muted" aria-hidden />
          </span>
          {store && <span className="truncate text-caption text-text-muted">{storeDomain(store)}</span>}
        </span>
      </Link>
      <span className="flex gap-2">
        <button type="button" aria-label="Search" className="flex size-11 items-center justify-center rounded-full border border-border-default bg-surface-card text-text-primary">
          <Search className="size-[22px]" aria-hidden />
        </button>
        <button type="button" aria-label="Notifications" className="flex size-11 items-center justify-center rounded-full border border-border-default bg-surface-card text-text-primary">
          <Bell className="size-[22px]" aria-hidden />
        </button>
      </span>
    </header>
  );
}

const tabs = [
  { to: '/', label: 'Today', icon: House, end: true },
  { to: '/orders', label: 'Orders', icon: ShoppingBag, end: false },
  { to: '/products', label: 'Products', icon: Package, end: false },
  { to: '/more', label: 'More', icon: Menu, end: false },
] as const;

function Tab({ tab, badge }: { tab: (typeof tabs)[number]; badge?: number }) {
  const Icon = tab.icon;
  return (
    <NavLink
      to={tab.to}
      end={tab.end}
      className={({ isActive }) =>
        cn(
          'flex min-h-13 flex-1 flex-col items-center justify-center gap-1 text-caption',
          isActive ? 'font-medium text-brand-600' : 'text-text-secondary',
        )
      }
    >
      <span className="relative">
        <Icon className="size-6" aria-hidden />
        {!!badge && (
          <span className="absolute -top-[7px] left-3.5 flex items-center justify-center rounded-[9px] border-2 border-surface-card bg-danger px-[5px] py-px text-caption font-medium text-text-inverse">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </span>
      {tab.label}
      {!!badge && <span className="sr-only"> ({badge} waiting)</span>}
    </NavLink>
  );
}

// Figma Components · MobileTabBar 30:3170 — surface-card, top border, pt 6 / pb 8, five slots,
// centre Create FAB (52px). FAB gradient/shadow are raw values in Figma (#6b63ff→#4d42e0).
export function MobileTabBar() {
  // Phase 5a §9: the Orders tab badge shows orders waiting for confirmation.
  const pending = useDashboard().data?.orders?.waiting.pending ?? 0;
  const { activeTenant } = useAuth();
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-20 flex items-center border-t border-border-default bg-surface-card px-2 pt-1.5 pb-[max(8px,env(safe-area-inset-bottom))] lg:hidden"
    >
      <Tab tab={tabs[0]} />
      {can.seeOrders(activeTenant) && <Tab tab={tabs[1]} badge={pending} />}
      <div className="flex min-h-13 flex-1 items-center justify-center">
        {can.editProducts(activeTenant) && (
        <Link
          to="/products/new"
          aria-label="Add product"
          className="flex size-13 items-center justify-center rounded-full bg-linear-to-r from-[#6b63ff] to-[#4d42e0] text-text-inverse shadow-[0_6px_7px_color-mix(in_srgb,var(--color-brand-600)_32%,transparent)]"
        >
          <Plus className="size-[26px]" aria-hidden />
        </Link>
        )}
      </div>
      <Tab tab={tabs[2]} />
      <Tab tab={tabs[3]} />
    </nav>
  );
}
