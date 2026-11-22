'use client';

import { useState, useTransition } from 'react';
import { quickAdd } from '@/app/actions/commerce';
import { Icon } from '../components/icon';
import { notifyCartChanged } from './cart-badge';

/**
 * Card "Add to cart" (PLP, search, home sections). Single-variant products are added in place;
 * products with options are sent to their PDP by the action.
 */
export function QuickAddButton({ slug, name, className = '' }: { slug: string; name: string; className?: string }) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const onClick = () =>
    start(async () => {
      const r = await quickAdd(slug);
      if (r.redirect) {
        // Products with options: choose them on the PDP.
        window.location.assign(r.redirect);
        return;
      }
      if (r.ok) {
        setState({ tone: 'ok', text: 'Added to your bag' });
        notifyCartChanged(r.linesCount);
      } else setState({ tone: 'error', text: r.message });
    });

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        aria-label={`Add ${name} to bag`}
        className="type-label-m flex w-full items-center justify-center gap-2 rounded-control bg-brand px-5 py-3 text-on-brand transition hover:brightness-110 disabled:opacity-60"
      >
        {pending ? 'Adding…' : 'Add to cart'}
        <Icon name="bag-inverse" />
      </button>
      <p aria-live="polite" className={`type-label-s empty:hidden ${state?.tone === 'error' ? 'text-sale' : 'text-brand'}`}>
        {state?.text}
      </p>
    </div>
  );
}
