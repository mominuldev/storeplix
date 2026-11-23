import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { api } from '../lib/api';
import { ImpersonationLinkExpiredScreen, ImpersonationStartingScreen } from './screens';
import { ticketFromHash } from './ticket';


/**
 * Contract §7.2 `/impersonate#ticket=…` (outside the auth guard): clear the fragment from the address bar and history,
 * exchange the single-use ticket for a read-only session, then open the dashboard of the impersonated shop.
 */
export function ImpersonatePage() {
  const { hash } = useLocation();
  const navigate = useNavigate();
  const { startSession, status } = useAuth();
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  // Read and clear the fragment at once (history, Referer, screenshots).
  const [ticket] = useState(() => ticketFromHash(hash));
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  }, []);

  useEffect(() => {
    // Let the boot `/auth/me` settle first: its late 401 must not end the session this ticket is about to start.
    if (!ticket || started.current || status === 'loading') return;
    started.current = true;
    api.auth
      .startImpersonation(ticket)
      .then((res) => {
        startSession({ user: res.user, expires_at: res.session_expires_at }, { impersonation: res.impersonation });
        navigate('/', { replace: true });
      })
      .catch(() => setFailed(true));
  }, [ticket, status, navigate, startSession]);

  return failed || !ticket ? <ImpersonationLinkExpiredScreen /> : <ImpersonationStartingScreen />;
}
