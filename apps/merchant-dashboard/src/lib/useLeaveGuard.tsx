import { Dialog } from '@storeplix/ui';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

/**
 * Unsaved-changes guard for editors (PHASE-8-3 §7.2/§7.3 "route-leave guard", W-1).
 *
 * The app uses `<BrowserRouter>` (not a data router), so `useBlocker` isn't available. Instead, while `dirty`:
 * - a full page leave (reload, close, typed URL) gets the browser's own `beforeunload` prompt;
 * - a click on any in-app link (`<a href>` to this origin — sidebar, breadcrumbs, cards) is held and a `Dialog` from
 *   `@storeplix/ui` asks first; "Leave" then navigates;
 * - programmatic navigations the page starts itself go through `guard(fn)`.
 *
 * Render `dialog` once in the page.
 */
export function useLeaveGuard(dirty: boolean): { dialog: ReactNode; guard: (proceed: () => void) => void } {
  const navigate = useNavigate();
  const [pending, setPending] = useState<(() => void) | null>(null);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = e.target instanceof Element ? e.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if ((anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const to = `${url.pathname}${url.search}${url.hash}`;
      if (to === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
      // Capture phase on document: runs before React Router's own click handler, which never sees the click.
      e.preventDefault();
      e.stopPropagation();
      setPending(() => () => navigate(to));
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty, navigate]);

  const guard = useCallback(
    (proceed: () => void) => {
      if (dirty) setPending(() => proceed);
      else proceed();
    },
    [dirty],
  );

  const dialog = (
    <Dialog
      open={!!pending}
      title="Leave without saving?"
      description="Your changes on this page haven’t been saved. If you leave now, they’ll be lost."
      confirmLabel="Leave without saving"
      cancelLabel="Keep editing"
      tone="danger"
      onCancel={() => setPending(null)}
      onConfirm={() => {
        const proceed = pending;
        setPending(null);
        proceed?.();
      }}
    />
  );

  return { dialog, guard };
}
