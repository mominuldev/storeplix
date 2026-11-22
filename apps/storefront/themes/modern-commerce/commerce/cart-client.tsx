'use client';

import { useActionState, useState, useTransition } from 'react';
import { applyCoupon, removeCoupon, removeLine, updateLine, type CouponState } from '@/app/actions/commerce';
import { Icon } from '../components/icon';
import { notifyCartChanged } from './cart-badge';
import { QtyStepper } from './ui';

/** Stepper + Remove for one bag line; the page re-renders from the server after each change. */
export function CartLineControls({ itemId, quantity, max, name, disabled }: { itemId: string; quantity: number; max: number; name: string; disabled?: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; message?: string; linesCount?: number }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (r.ok) notifyCartChanged(r.linesCount);
      else setError(r.message ?? 'Something went wrong. Try again.');
    });
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-4 max-lg:gap-5">
        <QtyStepper
          value={quantity}
          max={Math.max(1, Math.min(99, max))}
          disabled={pending || disabled}
          label={`Quantity of ${name}`}
          onChange={(n) => run(() => updateLine({ itemId, quantity: n }))}
        />
        <button type="button" disabled={pending} onClick={() => run(() => removeLine({ itemId }))} className="type-label-s flex items-center gap-1.5 text-ink-secondary hover:text-ink disabled:opacity-50">
          <Icon name="trash" />
          <span className="max-lg:sr-only">Remove</span>
          <span className="sr-only"> {name}</span>
        </button>
      </div>
      {error ? (
        <p role="alert" className="type-body-s text-sale">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Coupon field (Apply) or the applied code (Remove); error text comes from the API. */
export function CouponForm({ applied }: { applied: string | null }) {
  const [state, action, pending] = useActionState<CouponState, FormData>(applyCoupon, { status: 'idle' });
  const [removing, start] = useTransition();
  if (applied) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-sf-md border border-line bg-sunken px-3.5 py-3">
        <p className="type-label-s flex items-center gap-2 text-ink">
          <Icon name="tag" />
          {applied}
        </p>
        <button type="button" disabled={removing} onClick={() => start(async () => void (await removeCoupon()))} className="type-label-s text-brand hover:underline disabled:opacity-50">
          Remove
        </button>
      </div>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <label className="flex h-[47px] min-w-0 flex-1 items-center gap-2 rounded-sf-md border border-line bg-canvas px-3.5">
          <Icon name="tag" size={16} className="text-ink-muted" />
          <span className="sr-only">Coupon code</span>
          <input
            name="code"
            autoComplete="off"
            autoCapitalize="characters"
            maxLength={32}
            placeholder="Coupon code"
            aria-invalid={state.status === 'error'}
            aria-describedby="coupon-msg"
            className="type-body-s min-w-0 flex-1 bg-transparent text-ink uppercase outline-none placeholder:normal-case placeholder:text-ink-muted"
          />
        </label>
        <button type="submit" disabled={pending} className="type-label-m h-[46px] self-center rounded-control border-[1.5px] border-ink px-5 text-ink hover:bg-ink/5 disabled:opacity-60">
          {pending ? '…' : 'Apply'}
        </button>
      </div>
      <p id="coupon-msg" aria-live="polite" className={`type-body-s empty:hidden ${state.status === 'error' ? 'text-sale' : 'text-brand'}`}>
        {state.status === 'idle' ? '' : state.message}
      </p>
    </form>
  );
}
