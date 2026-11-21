import { Button } from '@storeplix/ui';
import { Bell, Menu, Search } from 'lucide-react';
import { useState } from 'react';
import { Outlet } from 'react-router';
import { Sidebar } from './Sidebar';

// Figma Platform Admin – Desktop · Dashboard 15:123 — sidebar 15:124, top bar 15:246 (65h, surface-card,
// bottom border, px 32, gap 12: search 460×40 · spacer · "Impersonate shop" · bell), content pt 28 px 32 gap 20.
export function AppShell() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-dvh bg-surface-canvas">
      <Sidebar open={open} onNavigate={() => setOpen(false)} />
      {open && <div className="fixed inset-0 z-30 bg-text-primary/40 lg:hidden" onClick={() => setOpen(false)} aria-hidden />}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-[65px] items-center gap-3 border-b border-border-default bg-surface-card px-4 lg:px-8">
          <button
            type="button"
            className="flex size-10 items-center justify-center rounded-control border border-border-default lg:hidden"
            aria-label="Open navigation"
            onClick={() => setOpen(true)}
          >
            <Menu className="size-5" aria-hidden />
          </button>
          <label className="flex h-10 w-full max-w-[460px] items-center gap-2 rounded-md bg-surface-canvas px-3 focus-within:shadow-focus">
            <Search className="size-4 text-text-muted" aria-hidden />
            <input
              type="search"
              aria-label="Search"
              placeholder="Find a shop, owner phone, domain or invoice"
              className="min-w-0 flex-1 bg-transparent text-body text-text-primary outline-none placeholder:text-text-muted"
            />
          </label>
          <div className="flex-1" />
          <Button variant="secondary" className="hidden sm:inline-flex" disabled title="Available in a later phase">
            Impersonate shop
          </Button>
          <button type="button" aria-label="Notifications" className="rounded-md p-2 text-text-secondary hover:bg-surface-subtle">
            <Bell className="size-5" aria-hidden />
          </button>
        </header>
        <main className="flex flex-1 flex-col gap-5 px-4 pt-7 pb-10 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
