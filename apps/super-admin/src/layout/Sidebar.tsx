import { cn, Logo } from '@storeplix/ui';
import { LogOut } from 'lucide-react';
import { NavLink } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
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

// Figma Platform Admin · PlatformSidebar 15:2 — 256 wide, dark (text-primary) to set it apart from the
// merchant admin; py 20 px 16; logo (inverse) + "Platform admin"; group headings; items h 38;
// active item white/10 bg; bottom user card. White-alpha fills are raw values in Figma.
export function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const { user, logout } = useAuth();
  return (
    <aside
      aria-label="Platform navigation"
      className={cn(
        'fixed inset-y-0 left-0 z-40 flex w-sidebar flex-col overflow-y-auto bg-text-primary px-4 py-5 transition-transform lg:sticky lg:top-0 lg:h-dvh lg:translate-x-0',
        open ? 'translate-x-0' : '-translate-x-full',
      )}
    >
      <div className="flex flex-col gap-1 pb-3 pl-2">
        <Logo tone="white" height={28} />
        <span className="text-caption text-text-muted">Platform admin</span>
      </div>
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
                      'flex h-[38px] items-center gap-2.5 rounded-md px-3 py-[9px] text-body text-text-inverse outline-none focus-visible:shadow-focus',
                      isActive ? 'bg-white/10 font-semibold' : 'font-medium text-text-inverse/72 hover:bg-white/6',
                    )
                  }
                >
                  <Icon className="size-[18px] shrink-0" aria-hidden />
                  <span className="truncate">{item.label}</span>
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="min-h-6 flex-1" />
      <div className="flex items-center gap-3 rounded-[10px] bg-white/6 px-3 py-2.5">
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
          className="rounded-md p-1.5 text-text-inverse/72 hover:bg-white/10 hover:text-text-inverse"
        >
          <LogOut className="size-4" aria-hidden />
        </button>
      </div>
    </aside>
  );
}
