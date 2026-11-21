'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { acceptEditorMessage, previewMessage, referrerTargetOrigin } from '@/lib/editor-bridge';
import type { PreviewToEditorMessage } from '@storeplix/types';

const sectionEl = (id: string) =>
  [...document.querySelectorAll<HTMLElement>('[data-sp-section-id]')].find((el) => el.dataset.spSectionId === id) ?? null;

/**
 * Talks to the dashboard theme editor when the preview runs inside its iframe. Rendered only for
 * an embedded preview; the server passes the allowed editor origins (never the token).
 *  - in:  refresh → router.refresh() · select → outline a section · scroll-to → scroll it into view
 *  - out: ready (mount + after refresh), section-click, navigated
 */
export function PreviewBridge({ allowedOrigins }: { allowedOrigins: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [refreshes, setRefreshes] = useState(0);
  const target = useRef<string | null>(null);
  const firstPath = useRef(true);

  const post = (m: PreviewToEditorMessage) => {
    if (target.current && window.parent !== window) window.parent.postMessage(m, target.current);
  };

  useEffect(() => {
    target.current = referrerTargetOrigin(document.referrer, allowedOrigins);

    const onMessage = (event: MessageEvent) => {
      const msg = acceptEditorMessage(event, window.parent === window ? null : window.parent, allowedOrigins);
      if (!msg) return;
      if (msg.type === 'refresh') {
        startTransition(() => router.refresh());
        setRefreshes((n) => n + 1);
      } else if (msg.type === 'select') {
        document.querySelectorAll('[data-sp-selected]').forEach((el) => el.removeAttribute('data-sp-selected'));
        if (msg.section_id) sectionEl(msg.section_id)?.setAttribute('data-sp-selected', '');
      } else if (msg.type === 'scroll-to') {
        sectionEl(msg.section_id)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    };

    // Clicks select sections instead of navigating away from the page being edited.
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const el = event.target instanceof Element ? event.target : null;
      if (el?.closest('a[href]')) event.preventDefault();
      const section = el?.closest<HTMLElement>('[data-sp-section-id]');
      const id = section?.dataset.spSectionId;
      if (id && /^[a-z0-9-]{1,64}$/.test(id)) post(previewMessage({ type: 'section-click', section_id: id }));
    };

    window.addEventListener('message', onMessage);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('message', onMessage);
      document.removeEventListener('click', onClick, true);
    };
  }, [allowedOrigins]);

  // `ready` on mount and after each refresh has been applied.
  useEffect(() => {
    if (!isPending) post(previewMessage({ type: 'ready', path: window.location.pathname }));
  }, [isPending, refreshes]);

  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
    post(previewMessage({ type: 'navigated', path: pathname }));
  }, [pathname]);

  return null;
}
