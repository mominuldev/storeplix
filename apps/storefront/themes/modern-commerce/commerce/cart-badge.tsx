'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon } from '../components/icon';

/** Fired after any cart Server Action so the header badge refetches. */
export const CART_EVENT = 'sp:cart';

export function notifyCartChanged(linesCount?: number) {
  window.dispatchEvent(new CustomEvent(CART_EVENT, { detail: linesCount }));
}

/**
 * Header bag button. The count comes from `GET /api/cart-summary` (no-store) on the client, so the
 * cached page HTML never carries cart data (PHASE-5-CONTRACT §5).
 */
export function CartBadgeButton() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/cart-summary', { cache: 'no-store', credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((b: { data?: { lines_count?: unknown } } | null) => {
          const n = b?.data?.lines_count;
          if (alive) setCount(typeof n === 'number' && n >= 0 ? Math.min(n, 99) : 0);
        })
        .catch(() => undefined);
    const onChange = (e: Event) => {
      const n = (e as CustomEvent<unknown>).detail;
      if (typeof n === 'number') setCount(Math.min(Math.max(0, n), 99));
      else void load();
    };
    void load();
    window.addEventListener(CART_EVENT, onChange);
    return () => {
      alive = false;
      window.removeEventListener(CART_EVENT, onChange);
    };
  }, []);

  return (
    <Link href="/cart" aria-label={`Bag${count ? `, ${count} ${count === 1 ? 'item' : 'items'}` : ''}`} className="relative flex h-12 w-[52px] items-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-brand text-on-brand">
        <Icon name="bag" />
      </span>
      {count > 0 ? (
        <span data-sp-cart-count className="type-label-s absolute top-0 left-8 rounded-full bg-accent px-1.5 py-px text-on-accent">
          {count}
        </span>
      ) : null}
    </Link>
  );
}
