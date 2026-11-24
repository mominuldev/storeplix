import type { AdminTenantSummary } from '@storeplix/types';
import { Button } from '@storeplix/ui';
import { KeyRound, Menu, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { PageErrorBoundary } from '../components/PageErrorBoundary';
import { ShopPickerDialog } from '../components/ShopPickerDialog';
import { useCan } from '../lib/permissions';
import { ImpersonateDialog } from '../merchants/ImpersonateDialog';
import { GlobalSearch } from './GlobalSearch';
import { Sidebar } from './Sidebar';

// Figma Platform Admin – Desktop · Dashboard 15:123 — sidebar 15:124, top bar 15:246 (65h, surface-card,
// bottom border, px 32, gap 12: search 460×40 · spacer · "Impersonate shop"; the bell is hidden in 8.1), content
// pt 28 px 32 gap 20.
export function AppShell() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const { user, environment, security } = useAuth();
  const can = useCan();
  const [picker, setPicker] = useState(false);
  const [target, setTarget] = useState<AdminTenantSummary | null>(null);
  // Staff who never enrolled (two-step sign-in off, A1-3) have no codes to run low on.
  const lowCodes = user && user.totp_enrolled && user.recovery_codes_left < 3;
  // Amendment A1-5: persistent warning for whoever can switch it back on, except on a developer machine.
  const twoStepOff = can('manage_settings') && security?.staff_two_factor_required === false && environment !== null && environment !== 'local';

  return (
    <div className="flex min-h-dvh bg-surface-canvas">
      <Sidebar open={open} onNavigate={() => setOpen(false)} />
      {open && <div className="fixed inset-0 z-30 bg-text-primary/40 lg:hidden" onClick={() => setOpen(false)} aria-hidden />}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-[65px] items-center gap-3 border-b border-border-default bg-surface-card px-4 lg:px-8">
          <button
            type="button"
            className="flex size-10 shrink-0 items-center justify-center rounded-control border border-border-default lg:hidden"
            aria-label="Open navigation"
            onClick={() => setOpen(true)}
          >
            <Menu className="size-5" aria-hidden />
          </button>
          <GlobalSearch />
          <div className="flex-1" />
          {can('impersonate') && (
            <Button variant="secondary" className="hidden sm:inline-flex" onClick={() => setPicker(true)}>
              Impersonate shop
            </Button>
          )}
        </header>
        {twoStepOff && (
          <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-default bg-danger-bg px-4 py-2.5 text-body text-danger lg:px-8">
            <ShieldAlert aria-hidden className="size-4 shrink-0" />
            <span className="font-semibold">Two-step sign-in is off for platform staff</span>
            <span className="text-text-secondary">Staff sign in with a password only ({environment}).</span>
            {pathname !== '/settings' && (
              <Link to="/settings" className="rounded-sm font-medium text-brand-600 underline-offset-2 outline-none hover:underline focus-visible:shadow-focus">
                Review security settings
              </Link>
            )}
          </div>
        )}
        <main className="flex flex-1 flex-col gap-5 px-4 pt-7 pb-10 lg:px-8">
          {lowCodes && (
            <p role="status" className="flex items-center gap-2 rounded-lg bg-warning-bg px-4 py-3 text-body text-warning">
              <KeyRound aria-hidden className="size-4 shrink-0" />
              {user.recovery_codes_left === 0
                ? 'You have no recovery codes left. Ask a super admin to reset your 2FA to get new ones.'
                : `Only ${user.recovery_codes_left} recovery code${
                    user.recovery_codes_left === 1 ? '' : 's'
                  } left. Ask a super admin to reset your 2FA to get new ones.`}
            </p>
          )}
          <PageErrorBoundary key={pathname}>
            <Outlet />
          </PageErrorBoundary>
        </main>
      </div>
      {picker && (
        <ShopPickerDialog
          title="Impersonate shop"
          onClose={() => setPicker(false)}
          onPick={(t) => {
            setPicker(false);
            setTarget(t);
          }}
        />
      )}
      {target && <ImpersonateDialog tenant={target} onClose={() => setTarget(null)} />}
    </div>
  );
}
