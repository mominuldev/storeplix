import { cn } from '@storeplix/ui';
import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { storeDomain, useTenantStore } from '../stores/useTenantStore';

function initial(name: string | undefined) {
  return (name ?? '?').trim().charAt(0).toUpperCase() || '?';
}

// Figma Components · Store switcher 5:15 — surface-canvas, radius 10, px 12 py 8, gap 10;
// 28px accent-100 tile (rounded-sm) with Body/14 Semibold initial in status-warning.
// Contract D1 (revised): one store per tenant — this switches TENANT (membership from GET /auth/me);
// the label shows the active tenant's store name and domain.
export function TenantSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const { tenants, activeTenant, setTenant } = useAuth();
  const store = useTenantStore().data;
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const name = store?.name ?? activeTenant?.name ?? 'No shop yet';
  const sub = store ? storeDomain(store) : (activeTenant?.role_name || activeTenant?.role || '');

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Switch shop, current: ${name}`}
        disabled={tenants.length <= 1}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-control bg-surface-canvas px-3 py-2 text-left outline-none focus-visible:shadow-focus',
          collapsed && 'justify-center px-0',
        )}
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-sm bg-accent-100 text-body font-semibold text-warning">
          {initial(name)}
        </span>
        {!collapsed && (
          <>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-body font-semibold text-text-primary">{name}</span>
              <span className="truncate text-caption text-text-muted">{sub}</span>
            </span>
            {tenants.length > 1 && <ChevronDown className="size-4 shrink-0 text-text-muted" aria-hidden />}
          </>
        )}
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label="Your shops"
          className="absolute top-full right-0 left-0 z-30 mt-1 min-w-56 rounded-lg border border-border-default bg-surface-card p-1 shadow-elevation-1"
        >
          {tenants.map((t) => (
            <li key={t.id} role="option" aria-selected={t.id === activeTenant?.id}>
              <button
                type="button"
                onClick={() => {
                  setTenant(t.id);
                  setOpen(false);
                  navigate('/');
                }}
                className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left hover:bg-surface-subtle"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-sm bg-accent-100 text-body font-semibold text-warning">
                  {initial(t.name)}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-body font-semibold text-text-primary">{t.name}</span>
                  <span className="truncate text-caption text-text-muted capitalize">{t.role_name || t.role}</span>
                </span>
                {t.id === activeTenant?.id && <Check className="size-4 text-brand-600" aria-hidden />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
