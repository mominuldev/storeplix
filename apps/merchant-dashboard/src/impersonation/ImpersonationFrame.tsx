import type { MeImpersonation } from '@storeplix/types';
import { Clock, ExternalLink, Shield } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { formatCountdown, useCountdown, useImpersonation } from './hooks';
import { impersonation } from './store';

const Dot = () => <span aria-hidden className="size-1 shrink-0 rounded-full bg-warning max-md:hidden" />;

/**
 * Figma "Platform / Impersonation mode" 44:15709: sticky banner 44:15710 (warning-bg, warning bottom border, pl 20 /
 * pr 12, gap 12, h 52) over the real dashboard, framed by a 4px warning border (44:15732). The sticky top bar and
 * sidebar sit below it via `--sp-banner-h`. At 00:00 the session is over → "Impersonation ended".
 */
export function ImpersonationBanner({ info }: { info: MeImpersonation }) {
  const left = useCountdown(info.expires_at);
  const [exiting, setExiting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (left === 0) impersonation.end();
  }, [left]);

  // Keep the sticky app chrome under the banner (its height grows when it wraps on phones).
  useLayoutEffect(() => {
    const el = ref.current;
    const root = document.documentElement;
    if (!el) return;
    const apply = () => root.style.setProperty('--sp-banner-h', `${el.offsetHeight}px`);
    apply();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.style.removeProperty('--sp-banner-h');
    };
  }, []);

  const exit = async () => {
    setExiting(true);
    try {
      await api.auth.endImpersonation();
    } catch {
      /* already ended or offline: end locally either way */
    } finally {
      impersonation.end();
    }
  };

  return (
    <div
      ref={ref}
      role="region"
      aria-label="Support session"
      className="sticky top-0 z-[55] flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-warning bg-warning-bg py-2.5 pr-3 pl-4 md:min-h-13 md:flex-nowrap md:py-2 md:pl-5"
    >
      <span aria-hidden className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-warning text-text-inverse">
        <Shield className="size-4" />
      </span>
      <p className="min-w-0 text-body text-text-primary md:truncate">
        You are viewing <span className="font-semibold">{info.tenant_name}</span>
        {info.owner_name ? (
          <>
            {' '}as <span className="font-semibold">{info.owner_name} (owner)</span>
          </>
        ) : null}
      </p>
      <Dot />
      <p className="min-w-0 truncate text-body text-text-secondary max-md:hidden">
        Reason: <span className="font-medium">{info.reason}</span>
      </p>
      <Dot />
      <span className="shrink-0 rounded-full border border-warning bg-surface-card px-2 py-0.5 text-caption font-medium text-warning">Read-only</span>
      <span className="flex-1 max-md:hidden" />
      <span
        role="timer"
        aria-label="Time left"
        className="flex shrink-0 items-center gap-1.5 rounded-full border border-warning bg-surface-card px-2.5 py-1.5 text-caption font-medium text-warning tabular-nums max-md:ml-auto"
      >
        <Clock aria-hidden className="size-3.5" />
        {left === null ? '--:--' : formatCountdown(left)} left
      </span>
      <button
        type="button"
        onClick={() => void exit()}
        disabled={exiting}
        className="flex h-[34px] shrink-0 items-center gap-2 rounded-md bg-text-primary px-3.5 text-body font-semibold text-text-inverse outline-none hover:opacity-90 focus-visible:shadow-focus disabled:opacity-60"
      >
        Exit impersonation
        <ExternalLink aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}

/** Rendered once at the app root: banner + amber frame while an impersonation is active. */
export function ImpersonationFrame() {
  const info = useImpersonation();
  if (!info) return null;
  return (
    <>
      <ImpersonationBanner info={info} />
      <div aria-hidden className="pointer-events-none fixed inset-0 z-[70] border-4 border-warning" />
    </>
  );
}
