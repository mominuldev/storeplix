'use client';

import { useEffect, useRef, useTransition } from 'react';
import { applyDiscountLink } from '@/app/actions/commerce';

/**
 * `/discount/{CODE}`: applying the code is a Server Action (origin-checked), so the share link
 * renders this page and runs it immediately, then goes to `/` (never anywhere else, S14).
 */
export function DiscountApply({ code }: { code: string }) {
  const [pending, start] = useTransition();
  const sent = useRef(false);
  const apply = () =>
    start(async () => {
      await applyDiscountLink(code);
      // Full load so the home page reads the fresh sp_flash cookie (no client router cache).
      window.location.replace('/');
    });
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    apply();
  }, []);
  return (
    <div className="flex flex-col items-start gap-4">
      <p className="type-body-m text-ink-secondary" aria-live="polite">
        {pending ? `Adding code ${code} to your bag…` : `Use code ${code} on your next order.`}
      </p>
      <button type="button" onClick={apply} disabled={pending} className="type-label-m h-12 rounded-control bg-brand px-7 text-on-brand hover:brightness-110 disabled:opacity-60">
        Apply code and shop
      </button>
    </div>
  );
}
