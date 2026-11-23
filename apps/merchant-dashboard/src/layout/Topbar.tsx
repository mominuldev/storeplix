import { buttonVariants, cn } from '@storeplix/ui';
import { Bell, ExternalLink, PanelLeft, Search } from 'lucide-react';
import { PreviewStoreButton } from '../stores/PreviewStoreButton';
import { storeDomain, useTenantStore } from '../stores/useTenantStore';
import { UserMenu } from './UserMenu';

// Figma Merchant Admin – Desktop · TopBar 10:755 — h 64, surface-card, bottom border,
// pl 20 / pr 32, gap 12: collapse · search (420×40) · spacer · View shop · bell · avatar.
export function Topbar({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const store = useTenantStore().data;
  // Live stores: "View shop" (Figma). Draft stores aren't public yet → "Preview store" (contract D2).
  const shopUrl = store?.status === 'active' ? `https://${storeDomain(store)}` : undefined;

  return (
    <header className="sticky top-[var(--sp-banner-h,0px)] z-20 hidden h-topbar items-center gap-3 border-b border-border-default bg-surface-card pr-8 pl-5 lg:flex">
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label="Toggle sidebar"
        className="flex size-10 items-center justify-center rounded-control border border-border-default text-text-secondary outline-none hover:bg-surface-subtle focus-visible:shadow-focus"
      >
        <PanelLeft className="size-5" aria-hidden />
      </button>
      <label className="flex h-10 w-[420px] items-center gap-2 rounded-md bg-surface-canvas px-3 focus-within:shadow-focus">
        <Search className="size-4 text-text-muted" aria-hidden />
        <input
          type="search"
          placeholder="Search orders, phone numbers, products"
          aria-label="Search"
          className="min-w-0 flex-1 bg-transparent text-body text-text-primary outline-none placeholder:text-text-muted"
        />
        <kbd className="rounded-[4px] border border-border-default bg-surface-card px-1.5 py-px text-caption text-text-muted">/</kbd>
      </label>
      <div className="flex-1" />
      {store && <PreviewStoreButton store={store} className="px-3 font-medium" />}
      {shopUrl && (
        <a
          href={shopUrl}
          target="_blank"
          rel="noreferrer"
          className={cn(buttonVariants({ variant: 'secondary' }), 'gap-1.5 px-3 font-medium')}
        >
          View shop <ExternalLink className="size-3.5" aria-hidden />
        </a>
      )}
      <button
        type="button"
        aria-label="Notifications"
        className="rounded-md p-2 text-text-secondary outline-none hover:bg-surface-subtle focus-visible:shadow-focus"
      >
        <Bell className="size-5" aria-hidden />
      </button>
      <UserMenu />
    </header>
  );
}
