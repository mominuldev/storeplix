'use client';

import { useEffect, useState } from 'react';

/** Split a remaining duration into zero-padded hours/minutes/seconds (hours may exceed 24). */
export function countdownParts(ms: number): { hours: string; minutes: string; seconds: string } {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  return { hours: pad(Math.min(99, Math.floor(total / 3600))), minutes: pad(Math.floor((total % 3600) / 60)), seconds: pad(total % 60) };
}

/**
 * Figma "Countdown" (1:9605). The server renders the remaining time from its own clock; after
 * hydration the client ticks it down and hides the timer once it reaches zero.
 */
export function Countdown({ endsAt, initialRemainingMs }: { endsAt: string; initialRemainingMs: number }) {
  const [remaining, setRemaining] = useState(initialRemainingMs);

  useEffect(() => {
    const end = Date.parse(endsAt);
    const tick = () => setRemaining(Math.max(0, end - Date.now()));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [endsAt]);

  if (remaining <= 0) return null;
  const p = countdownParts(remaining);
  const unit = (value: string, label: string) => (
    <span className="flex flex-col items-center rounded-sf-md bg-surface px-3 py-2">
      <span className="type-price-l text-[#0e1a33]">{value}</span>
      <span className="type-label-s text-[#66728c]">{label}</span>
    </span>
  );
  return (
    <span className="flex items-center gap-2 whitespace-nowrap" role="timer" aria-live="off">
      {unit(p.hours, 'hrs')}
      <span aria-hidden className="type-price-l text-paper">:</span>
      {unit(p.minutes, 'min')}
      <span aria-hidden className="type-price-l text-paper">:</span>
      {unit(p.seconds, 'sec')}
    </span>
  );
}
