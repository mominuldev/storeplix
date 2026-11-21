import { LogOut, UserRound } from 'lucide-react';
import { Link } from 'react-router';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';

function initials(name: string | undefined) {
  return (name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('') || '?';
}

// Figma TopBar 5:163 avatar — 36px circle, brand-100, Caption/12 Medium brand-700 initials.
export function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Account menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex size-9 items-center justify-center rounded-full bg-brand-100 text-caption font-medium text-brand-700 outline-none focus-visible:shadow-focus"
      >
        {initials(user?.name)}
      </button>
      {open && (
        <div className="absolute top-full right-0 z-30 mt-2 w-60 rounded-lg border border-border-default bg-surface-card p-1 shadow-elevation-1">
          <div className="px-3 py-2">
            <p className="truncate text-body font-semibold text-text-primary">{user?.name}</p>
            <p className="truncate text-caption text-text-muted">{user?.email}</p>
          </div>
          <Link to="/account" onClick={() => setOpen(false)} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-body text-text-primary hover:bg-surface-subtle">
            <UserRound className="size-4" aria-hidden /> Your account
          </Link>
          <button
            type="button"
            onClick={() => void logout()}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-body text-text-primary hover:bg-surface-subtle"
          >
            <LogOut className="size-4" aria-hidden /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
