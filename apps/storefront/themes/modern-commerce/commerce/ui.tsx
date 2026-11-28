import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatMoney } from '@/lib/format';
import { Icon } from '../components/icon';

/** Small presentational pieces shared by PDP, PLP, cart, checkout and tracking (no hooks). */

export function Breadcrumb({ items }: { items: Array<{ label: string; href?: string }> }) {
  return (
    <nav aria-label="Breadcrumb" className="type-label-s text-ink-muted">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {items.map((item, i) => (
          <li key={`${item.label}-${i}`} className="flex min-w-0 items-center gap-2">
            {i > 0 ? <Icon name="caret-down" size={12} className="-rotate-90 text-ink-muted" /> : null}
            {item.href ? (
              <Link href={item.href} className="hover:text-ink hover:underline">
                {item.label}
              </Link>
            ) : (
              <span aria-current="page" className="truncate text-ink">
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Page title + count (Figma PLP 1:10831 Display L 64 / search 1:12447 Display M 44; phones H1 36 + Body S count). */
export function PageTitle({ title, count, size = 'l' }: { title: string; count?: string; size?: 'l' | 'm' }) {
  const desktop = size === 'l' ? 'lg:type-display-m lg:gap-x-4 lg:text-[64px] lg:leading-[1.04] lg:tracking-[-2.5px]' : 'lg:type-display-m lg:gap-x-3';
  return (
    <h1 className={`type-h1 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-ink ${desktop}`}>
      <span className="min-w-0 break-words">{title}</span>
      {count ? (
        <span className="type-body-s font-body font-normal tracking-normal text-ink-muted lg:type-accent-italic-s">{count}</span>
      ) : null}
    </h1>
  );
}

export function Money({ amount, currency, className = '' }: { amount: number; currency: string; className?: string }) {
  return <span className={className}>{formatMoney(amount, currency)}</span>;
}

/** Price + struck compare-at (with an sr-only "Was"). */
export function PriceLine({ price, compareAt, currency, size = 'm' }: { price: number; compareAt: number | null; currency: string; size?: 'm' | 'l' }) {
  return (
    <span className="flex flex-wrap items-baseline gap-2">
      <span className={size === 'l' ? 'type-price-l text-ink' : 'type-price-m text-ink'}>{formatMoney(price, currency)}</span>
      {compareAt !== null && compareAt > price ? (
        <s className="type-body-s text-ink-muted">
          <span className="sr-only">Was </span>
          {formatMoney(compareAt, currency)}
        </s>
      ) : null}
    </span>
  );
}

interface StepperProps {
  value: number;
  min?: number;
  max: number;
  disabled?: boolean;
  label: string;
  onChange: (n: number) => void;
}

/** Figma qty stepper (pill, − value +). */
export function QtyStepper({ value, min = 1, max, disabled, label, onChange }: StepperProps) {
  return (
    <div role="group" aria-label={label} className="flex h-[46px] shrink-0 items-center gap-1 rounded-full border border-line bg-surface p-1">
      <button
        type="button"
        aria-label="Decrease quantity"
        disabled={disabled || value <= min}
        onClick={() => onChange(value - 1)}
        className="flex size-9 items-center justify-center rounded-full bg-sunken text-ink disabled:opacity-40"
      >
        <Icon name="minus" />
      </button>
      <output aria-live="polite" className="type-label-m w-9 text-center text-ink">
        {value}
      </output>
      <button
        type="button"
        aria-label="Increase quantity"
        disabled={disabled || value >= max}
        onClick={() => onChange(value + 1)}
        className="flex size-9 items-center justify-center rounded-full bg-sunken text-ink disabled:opacity-40"
      >
        <Icon name="plus" />
      </button>
    </div>
  );
}

export function Panel({ children, className = '', as: As = 'section', labelledBy }: { children: ReactNode; className?: string; as?: 'section' | 'div' | 'aside'; labelledBy?: string }) {
  return (
    <As aria-labelledby={labelledBy} className={`rounded-sf-sm border border-line-subtle bg-surface p-5 lg:p-7 ${className}`}>
      {children}
    </As>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'error' | 'ok'; children: ReactNode }) {
  const cls = tone === 'error' ? 'bg-accent-soft text-sale' : tone === 'ok' ? 'bg-brand-soft text-brand' : 'bg-sky-soft text-ink';
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`type-body-s flex items-start gap-2 rounded-sf-sm px-4 py-3 ${cls}`}>
      <Icon name="info" className="mt-0.5" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** "Free delivery unlocked!" / "Add ৳ 450 more for free delivery" progress (P5-9). */
export function FreeDeliveryBar({ threshold, remaining, currency }: { threshold: number; remaining: number; currency: string }) {
  const pct = threshold > 0 ? Math.min(100, Math.max(0, Math.round(((threshold - remaining) / threshold) * 100))) : 100;
  return (
    <div className="flex flex-col gap-2.5 rounded-sf-md bg-brand-soft p-4 text-brand lg:p-[18px]" data-sp-free-delivery>
      <p className="type-label-s flex items-center gap-2">
        <Icon name="truck-sm" />
        {remaining <= 0 ? 'Free delivery unlocked!' : `Add ${formatMoney(remaining, currency)} more for free delivery`}
      </p>
      <span className="h-1.5 overflow-hidden rounded-[3px] bg-surface" aria-hidden>
        <span className="block h-full rounded-[3px] bg-brand" style={{ width: `${remaining <= 0 ? 100 : pct}%` }} />
      </span>
    </div>
  );
}

export function deliveryDays(min: number | null, max: number | null): string {
  if (min === null || max === null) return '';
  if (max === 0) return 'Same day';
  return min === max ? `${min} ${min === 1 ? 'day' : 'days'}` : `${min}–${max} days`;
}

export const PAYMENT_METHOD_LABELS = { cod: 'Cash on delivery', bkash: 'bKash', sslcommerz: 'Card', nagad: 'Nagad' } as const;

/** Empty / no-results block (States pattern, Figma 148:34032 "No results"): icon disc, title, hint, action. */
export function EmptyState({ icon = 'search', title, children, action }: { icon?: 'search' | 'bag' | 'tag'; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-sf-sm border border-line-subtle bg-surface px-6 py-12 text-center" data-sp-empty>
      <span className="flex size-12 items-center justify-center rounded-full bg-sunken text-ink-muted" aria-hidden>
        <Icon name={icon} size={20} />
      </span>
      <h2 className="type-h3 text-ink">{title}</h2>
      {children ? <p className="type-body-s max-w-[420px] text-ink-secondary">{children}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
