import { cn } from '@storeplix/ui';
import { Bell, ChevronDown, House, Menu, Package, Plus, Search, ShoppingBag } from 'lucide-react';
import { Link, NavLink } from 'react-router';
import { storeDomain, useTenantStore } from '../stores/useTenantStore';

// Figma Merchant Admin – Mobile · Today app bar 31:4300 (60h): shop avatar, name + domain, search, bell.
export function MobileAppBar() {
  const store = useTenantStore().data;
  return (
    <header className="sticky top-0 z-20 flex h-15 items-center gap-3 border-b border-border-default bg-surface-card px-4 lg:hidden">
      <Link to="/more" className="flex min-w-0 flex-1 items-center gap-3" aria-label="Switch shop">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-accent-100 text-body font-semibold text-warning">
          {(store?.name ?? '?').charAt(0).toUpperCase()}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1 truncate text-body font-semibold text-text-primary">
            {store?.name ?? 'Store Plix'} <ChevronDown className="size-4 text-text-muted" aria-hidden />
          </span>
          {store && <span className="truncate text-caption text-text-muted">{storeDomain(store)}</span>}
        </span>
      </Link>
      <button type="button" aria-label="Search" className="flex size-11 items-center justify-center text-text-primary">
        <Search className="size-[22px]" aria-hidden />
      </button>
      <button type="button" aria-label="Notifications" className="flex size-11 items-center justify-center text-text-primary">
        <Bell className="size-[22px]" aria-hidden />
      </button>
    </header>
  );
}

const tabs = [
  { to: '/', label: 'Today', icon: House, end: true },
  { to: '/orders', label: 'Orders', icon: ShoppingBag, end: false },
  { to: '/products', label: 'Products', icon: Package, end: false },
  { to: '/more', label: 'More', icon: Menu, end: false },
] as const;

function Tab({ tab }: { tab: (typeof tabs)[number] }) {
  const Icon = tab.icon;
  return (
    <NavLink
      to={tab.to}
      end={tab.end}
      className={({ isActive }) =>
        cn(
          'flex min-h-13 flex-1 flex-col items-center justify-center gap-0.5 text-caption',
          isActive ? 'font-medium text-brand-600' : 'text-text-secondary',
        )
      }
    >
      <Icon className="size-6" aria-hidden />
      {tab.label}
    </NavLink>
  );
}

// Figma Components · MobileTabBar 30:3170 — surface-card, top border, pt 6 / pb 8, five slots,
// centre Create FAB (52px). FAB gradient/shadow are raw values in Figma (#6b63ff→#4d42e0).
export function MobileTabBar() {
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-20 flex items-end border-t border-border-default bg-surface-card px-2 pt-1.5 pb-[max(8px,env(safe-area-inset-bottom))] lg:hidden"
    >
      <Tab tab={tabs[0]} />
      <Tab tab={tabs[1]} />
      <div className="flex flex-1 justify-center">
        <Link
          to="/orders/new"
          aria-label="Create order"
          className="-mt-4 flex size-13 items-center justify-center rounded-full bg-linear-to-b from-[#6b63ff] to-[#4d42e0] text-text-inverse shadow-elevation-1"
        >
          <Plus className="size-[26px]" aria-hidden />
        </Link>
      </div>
      <Tab tab={tabs[2]} />
      <Tab tab={tabs[3]} />
    </nav>
  );
}
