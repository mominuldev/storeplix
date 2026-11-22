import { cn, Logo } from '@storeplix/ui';
import { LogOut } from 'lucide-react';
import { NavLink } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { useHealth } from '../lib/health';
import { navGroups } from './nav';

function initials(name: string | undefined) {
  return (
    (name ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join('') || '?'
  );
}

// Figma Platform Admin · PlatformSidebar 15:2 (instance 15:124) — 256 wide, dark (text-primary) to set it
// apart from the merchant admin; py 20 px 16, column gap 2; logo + "Platform admin" (gap 6, pb 12, pl 8);
// environment pill 15:9 (white/6, radius 8, px 12 py 8, 8px dot + Caption Medium white/85) then a 10px spacer;
// group headings pt 14 pb 6 pl 12; items px 12 py 9 gap 10, 18px icons (inactive icon white/60, label white/72
// Medium; active white/10 bg, Semibold); bottom user card (white/6, radius 10, px 12 py 10, gap 10).
// White-alpha fills are raw values in Figma.
export function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const { user, logout } = useAuth();
  const health = useHealth();
  const status = health.isPending
    ? { dot: 'bg-text-muted', label: 'Production · checking status' }
    : health.isError
    ? { dot: 'bg-danger', label: 'Production · API unreachable' }
    : { dot: 'bg-success', label: 'Production · all systems normal' };
  return (
    <aside
      aria-label="Platform navigation"
      className={cn(
        'fixed inset-y-0 left-0 z-40 flex w-sidebar flex-col gap-0.5 overflow-y-auto bg-text-primary px-4 py-5 transition-transform lg:sticky lg:top-0 lg:h-dvh lg:translate-x-0',
        open ? 'translate-x-0' : '-translate-x-full'
      )}
    >
      <div className="flex flex-col gap-1.5 pb-3 pl-2">
        <Logo tone="inverse" height={28} />
        <span className="text-caption text-text-muted">Platform admin</span>
      </div>
      <p role="status" className="flex items-center gap-2 rounded-md bg-white/6 px-3 py-2">
        <span aria-hidden className={cn('size-2 shrink-0 rounded-full', status.dot)} />
        <span className="truncate text-caption font-medium text-text-inverse/85">{status.label}</span>
      </p>
      <div aria-hidden className="h-2.5 shrink-0" />
      <nav className="flex flex-col gap-0.5">
        {navGroups.map((group) => (
          <div key={group.heading} className="flex flex-col gap-0.5">
            <h2 className="pt-3.5 pb-1.5 pl-3 text-caption font-medium tracking-[0.72px] text-text-muted uppercase">{group.heading}</h2>
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    cn(
                      'flex h-[38px] shrink-0 items-center gap-2.5 rounded-md px-3 py-[9px] text-body text-text-inverse outline-none focus-visible:shadow-focus',
                      isActive ? 'bg-white/10 font-semibold' : 'font-medium hover:bg-white/6'
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <Icon className={cn('size-[18px] shrink-0', !isActive && 'opacity-60')} strokeWidth={2.25} aria-hidden />
                      <span className={cn('truncate', !isActive && 'opacity-72')}>{item.label}</span>
                    </>
                  )}
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="min-h-6 flex-1" />
      <div className="flex shrink-0 items-center gap-2.5 rounded-control bg-white/6 px-3 py-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-500 text-caption font-medium text-text-inverse">
          {initials(user?.name)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body font-semibold text-text-inverse">{user?.name}</span>
          <span className="truncate text-caption text-text-muted">{user?.email}</span>
        </span>
        <button
          type="button"
          onClick={() => void logout()}
          aria-label="Sign out"
          className="-mr-1 rounded-md p-1 text-text-muted outline-none hover:bg-white/10 hover:text-text-inverse focus-visible:shadow-focus"
        >
          <LogOut className="size-4" aria-hidden />
        </button>
      </div>
    </aside>
  );
}
