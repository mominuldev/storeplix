import { Spinner } from '@storeplix/ui';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useImpersonationEnded } from '../impersonation/hooks';
import { ImpersonationEndedScreen } from '../impersonation/screens';
import { useAuth } from './AuthProvider';

/** Gate for authenticated routes: redirects to /login and remembers where the user was going. */
export function ProtectedRoute() {
  const { status } = useAuth();
  const location = useLocation();
  const impersonationEnded = useImpersonationEnded();

  if (status === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-surface-canvas">
        <Spinner size="lg" label="Loading your workspace" />
      </div>
    );
  }
  // Phase 8.1 §7.2: an expired, revoked or exited impersonation ends here, not on the login page.
  if (status === 'anonymous' && impersonationEnded) return <ImpersonationEndedScreen />;
  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet />;
}

/** Inverse gate for /login and /register. */
export function GuestRoute() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'authenticated') {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from && from !== '/login' ? from : '/'} replace />;
  }
  return <Outlet />;
}
