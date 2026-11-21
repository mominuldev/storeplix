import { Card } from '@storeplix/ui';
import { ChevronRight, LogOut } from 'lucide-react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { PageHeader } from '../layout/PageHeader';
import { TenantSwitcher } from '../layout/TenantSwitcher';
import { mainNav, mobileMoreGroups } from '../layout/nav';

// Figma Merchant Admin – Mobile · More 32:6541 — shop switcher card + grouped menu cards.
export function MorePage() {
  const { logout } = useAuth();
  return (
    <>
      <PageHeader title="More" />
      <Card className="p-3">
        <TenantSwitcher />
      </Card>
      {mobileMoreGroups.map((group) => (
        <section key={group.heading} className="flex flex-col gap-2">
          <h2 className="px-1 text-caption font-medium tracking-[0.06em] text-text-muted uppercase">{group.heading}</h2>
          <Card className="divide-y divide-border-default overflow-hidden">
            {group.items.map((to) => {
              const item = mainNav.find((n) => n.to === to)!;
              const Icon = item.icon;
              return (
                <Link key={to} to={to} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-subtle">
                  <span className="flex size-8 items-center justify-center rounded-control bg-brand-50 text-brand-600">
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <span className="flex-1 text-body font-medium text-text-primary">{item.label}</span>
                  <ChevronRight className="size-4 text-text-muted" aria-hidden />
                </Link>
              );
            })}
          </Card>
        </section>
      ))}
      <button
        type="button"
        onClick={() => void logout()}
        className="flex items-center justify-center gap-2 rounded-md py-3 text-body font-semibold text-danger hover:bg-danger-bg"
      >
        <LogOut className="size-4" aria-hidden /> Sign out
      </button>
    </>
  );
}
