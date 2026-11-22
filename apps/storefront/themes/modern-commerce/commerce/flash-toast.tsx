'use client';

import { useEffect, useState } from 'react';
import { dismissFlash } from '@/app/actions/commerce';
import { Icon } from '../components/icon';

/** One-shot toast from the httpOnly `sp_flash` cookie (set by `/discount/{CODE}`); cleared on show. */
export function FlashToast({ flash }: { flash: { tone: 'ok' | 'error'; message: string } | null }) {
  // Kept in state: clearing the cookie re-renders the page with `flash = null`, the toast stays.
  const [current] = useState(flash);
  const [shown, setShown] = useState(flash !== null);
  useEffect(() => {
    if (!current) return;
    void dismissFlash();
    const t = setTimeout(() => setShown(false), 8000);
    return () => clearTimeout(t);
  }, [current]);
  if (!shown || !current) return null;
  const { tone, message } = current;
  return (
    <div role="status" className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-[480px] items-start gap-3 rounded-sf-sm bg-inverse px-5 py-4 text-paper shadow-e3" data-sp-toast={tone}>
      <Icon name={tone === 'ok' ? 'tag' : 'info'} className={tone === 'ok' ? 'text-accent' : 'text-sale'} />
      <p className="type-body-s min-w-0 flex-1">{message}</p>
      <button type="button" aria-label="Dismiss" onClick={() => setShown(false)} className="shrink-0 opacity-80 hover:opacity-100">
        <Icon name="x" size={18} />
      </button>
    </div>
  );
}
