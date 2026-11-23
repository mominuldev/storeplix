import { ChecklistItem, ProgressBar, type ChecklistState } from '@storeplix/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { api } from '../lib/api';
import { can } from '../lib/permissions';
import { settingsKey } from '../settings/schema';
import { useTenantStore } from '../stores/useTenantStore';
import { useDashboard } from '../catalog/queries';
import { useLaunchChecklist } from '../commerce/queries';

interface Item {
  key: string;
  title: string;
  hint: string;
  state: ChecklistState;
  to?: string;
}

/**
 * Task 2.9 setup checklist (Checklist item 45:8102). Resumable: every state is derived from server data
 * (store, settings, staff), so it picks up where the merchant left off on any device. Later-phase steps are locked.
 */
export function SetupChecklist() {
  const navigate = useNavigate();
  const { activeTenant } = useAuth();
  const store = useTenantStore().data;
  const manage = can.manageStaff(activeTenant);
  const settings = useQuery({ queryKey: settingsKey(store?.id), queryFn: () => api.stores.getSettings(store!.id), enabled: !!store, retry: false });
  const themes = useQuery({ queryKey: ['store-themes', store?.id], queryFn: () => api.storeThemes.list(store!.id), enabled: !!store, retry: false });
  // Phase 4 §9.1: "Add products" is done once the store has any product.
  const dashboard = useDashboard();
  // Phase 5a §9: Delivery, Get paid and Go live come from GET /launch-checklist.
  const launch = useLaunchChecklist().data;
  const launchDone = (key: 'shipping' | 'payments') => !!launch?.items.find((i) => i.key === key)?.done;
  const staff = useQuery({ queryKey: ['staff', activeTenant?.id], queryFn: () => api.staff.list(), enabled: manage, retry: false });

  if (!store || settings.isPending) return null;

  const brandingDone = !!settings.data?.branding.logo && !!settings.data?.contact.phone;
  const teamDone = (staff.data?.data.length ?? 0) > 1;
  // Phase 3 §6: done once a theme was explicitly applied or the active theme was published after the initial copy.
  const activeTheme = themes.data?.find((t) => t.is_active);
  const themeDone = !!activeTheme && (!!activeTheme.applied_at || (activeTheme.published_revision ?? 0) > 1);
  const items: Item[] = [
    { key: 'name', title: 'Name your shop', hint: 'Name, link & category', state: 'done' },
    { key: 'brand', title: 'Add logo & contact', hint: 'Logo plus a phone customers can call', state: brandingDone ? 'done' : 'todo', to: '/settings/store' },
    ...(manage ? [{ key: 'team', title: 'Invite your team', hint: 'Managers and staff get their own sign-in', state: (teamDone ? 'done' : 'todo') as ChecklistState, to: '/staff' }] : []),
    { key: 'theme', title: 'Pick a theme', hint: 'Look & brand colour', state: themeDone ? 'done' : 'todo', to: '/online-store/themes' },
    { key: 'products', title: 'Add products', hint: 'Your first items', state: dashboard.data?.setup.has_products ? 'done' : 'todo', to: '/onboarding/products' },
    { key: 'delivery', title: 'Delivery', hint: 'Zones & charges', state: launchDone('shipping') ? 'done' : 'todo', to: '/onboarding/delivery' },
    { key: 'paid', title: 'Get paid', hint: 'Cash on delivery', state: launchDone('payments') ? 'done' : 'todo', to: '/onboarding/payments' },
    { key: 'live', title: 'Go live', hint: 'Publish your shop', state: launch?.status === 'active' || store.status === 'active' ? 'done' : 'todo', to: '/onboarding/payments' },
  ];
  const done = items.filter((i) => i.state === 'done').length;

  return (
    <section aria-label="Setup checklist" className="flex flex-col gap-4 rounded-card border border-border-default bg-surface-card p-6 shadow-elevation-1">
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-body-lg font-medium text-text-primary">Finish setting up {store.name}</h2>
          <span className="text-caption font-medium text-text-secondary">
            {done} of {items.length} done
          </span>
        </div>
        <ProgressBar value={done / items.length} label="Setup progress" />
      </div>
      <ul className="grid gap-2 md:grid-cols-2">
        {items.map((i) => (
          <li key={i.key}>
            <ChecklistItem title={i.title} hint={i.hint} state={i.state} onSelect={i.to ? () => navigate(i.to!) : undefined} />
          </li>
        ))}
      </ul>
    </section>
  );
}
