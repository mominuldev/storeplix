import { cn } from '@storeplix/ui';
import { Bell, Building2, CreditCard, ExternalLink, LifeBuoy, Plug, ShoppingBag, Star, Truck, type LucideIcon } from 'lucide-react';
import { NavLink, Outlet } from 'react-router';
import { PageHeader } from '../layout/PageHeader';
import { storeDomain, useTenantStore } from '../stores/useTenantStore';

type Item = { label: string; to: string; icon: LucideIcon; external?: boolean };

// Figma Settings 60:13854 sub-nav (240 wide card): groups and order as designed.
export const settingsNav: { heading: string; items: Item[] }[] = [
  {
    heading: 'Store',
    items: [
      { label: 'Store details', to: '/settings/store', icon: Building2 },
      { label: 'Shipping & delivery', to: '/settings/shipping', icon: Truck },
      { label: 'Payments & checkout', to: '/settings/payments', icon: CreditCard },
      { label: 'Taxes & invoices', to: '/settings/invoices', icon: ShoppingBag },
      { label: 'Policies & legal pages', to: '/settings/policies', icon: LifeBuoy },
    ],
  },
  {
    heading: 'Team & account',
    items: [
      { label: 'Notifications', to: '/settings/notifications', icon: Bell },
      { label: 'Plan & billing', to: '/settings/plan', icon: Star },
    ],
  },
  {
    heading: 'Connected',
    items: [
      { label: 'Integrations', to: '/integrations', icon: Plug, external: true },
    ],
  },
];

export function SettingsLayout() {
  const store = useTenantStore().data;
  return (
    <>
      <PageHeader title="Settings" subtitle={store ? `${store.name} · ${storeDomain(store)} — changes here apply to your whole shop.` : undefined} />
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <nav aria-label="Settings" className="shrink-0 rounded-card border border-border-default bg-surface-card p-3 shadow-elevation-1 lg:w-60">
          {settingsNav.map((g, gi) => (
            <div key={g.heading} className="flex flex-col gap-0.5">
              <h2 className={cn('px-3 pb-1.5 text-caption font-medium text-text-muted uppercase', gi === 0 ? 'pt-1' : 'pt-4')}>{g.heading}</h2>
              {g.items.map(({ label, to, icon: Icon, external }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) =>
                    cn(
                      'flex h-10 items-center gap-3 rounded-md px-3 text-body outline-none focus-visible:shadow-focus',
                      isActive && !external ? 'bg-brand-50 font-semibold text-brand-600' : 'font-medium text-text-secondary hover:bg-surface-subtle',
                    )
                  }
                >
                  <Icon aria-hidden className="size-5 shrink-0" />
                  <span className="flex-1 truncate">{label}</span>
                  {external && <ExternalLink aria-hidden className="size-4 text-text-muted" />}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <Outlet />
        </div>
      </div>
    </>
  );
}

export function SettingsCard({
  title,
  badge,
  description,
  action,
  children,
  className,
}: {
  title: string;
  /** Tag next to the title (Figma "Title row", gap 8). */
  badge?: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned header action (Figma "Card header": title column + sm secondary button, gap 12). */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col gap-5 rounded-card border border-border-default bg-surface-card p-6 shadow-elevation-1', className)} aria-label={title}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-body-lg font-medium text-text-primary">{title}</h2>
            {badge}
          </div>
          {description && <p className="text-body text-text-secondary">{description}</p>}
        </div>
        {action && <div className="shrink-0 self-start sm:self-auto">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/** Figma "Settings / Toggle row": 14/20 medium title + 14/20 secondary description, toggle on the right, gap 16. */
export function SettingsToggleRow({ title, description, children }: { title: React.ReactNode; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-body font-medium text-text-primary">{title}</span>
        {description && <span className="text-body text-text-secondary">{description}</span>}
      </div>
      {children}
    </div>
  );
}

export function SettingsComingSoon({ title }: { title: string }) {
  return (
    <SettingsCard title={title} description="This section is coming in a later update.">
      <p className="text-body text-text-muted">Coming soon</p>
    </SettingsCard>
  );
}
