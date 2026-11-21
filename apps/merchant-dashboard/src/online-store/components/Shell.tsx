import { Badge, Button, cn, Dialog, EmptyState, Spinner } from '@storeplix/ui';
import { AlertTriangle, Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';

// V3 local component OS3/NavPill 2033:46029 inside the "OS3 / Section nav" track 2033:46088:
// surface-subtle, radius 12, p 4, gap 2; pill px 14 py 7 radius 8; active = card + elevation; dividers after
// Overview and Brand style. Landing pages and Popups are out of scope → disabled with "Coming soon".
const tabs: ({ label: string; to: string; end?: boolean } | { label: string; disabled: true } | 'divider')[] = [
  { label: 'Overview', to: '/online-store', end: true },
  'divider',
  { label: 'Themes', to: '/online-store/themes' },
  { label: 'Brand style', to: '/online-store/brand-style' },
  'divider',
  { label: 'Pages', to: '/online-store/pages' },
  { label: 'Landing pages', disabled: true },
  { label: 'Navigation', to: '/online-store/navigation' },
  { label: 'Popups', disabled: true },
];

const pill = 'shrink-0 rounded-md px-3.5 py-[7px] text-[13px] leading-[18px] whitespace-nowrap outline-none focus-visible:shadow-focus';

export function SectionNav() {
  return (
    <nav aria-label="Online store" className="-mx-4 overflow-x-auto px-4 lg:mx-0 lg:px-0">
      <ul className="flex w-max items-center gap-0.5 rounded-lg bg-surface-subtle p-1">
        {tabs.map((t, i) =>
          t === 'divider' ? (
            <li key={`d${i}`} aria-hidden className="px-1.5">
              <span className="block h-4 w-px bg-border-strong" />
            </li>
          ) : 'disabled' in t ? (
            <li key={t.label}>
              <span aria-disabled="true" title="Coming soon" className={cn(pill, 'block cursor-not-allowed font-medium text-text-muted')}>
                {t.label}
              </span>
            </li>
          ) : (
            <li key={t.to}>
              <NavLink
                to={t.to}
                end={t.end}
                className={({ isActive }) =>
                  cn(pill, 'block', isActive ? 'bg-surface-card font-semibold text-text-primary shadow-elevation-1' : 'font-medium text-text-secondary hover:text-text-primary')
                }
              >
                {t.label}
              </NavLink>
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}

/** Figma page header (2032:44896): Heading/32 title, Body/16 secondary description, actions on the right. */
export function OnlineStoreHeader({ title, description, actions, nav = true }: { title: string; description: string; actions?: ReactNode; nav?: boolean }) {
  return (
    <div className="flex flex-col gap-5 lg:gap-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="text-heading-24 text-text-primary lg:text-heading-32">{title}</h1>
          <p className="text-body text-text-secondary lg:text-body-lg">{description}</p>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {nav && <SectionNav />}
    </div>
  );
}

/** Staff banner (contract §6): every Online store screen is read-only for the staff role. */
export function ReadOnlyBanner({ className }: { className?: string }) {
  return (
    <div role="note" className={cn('flex items-center gap-2.5 rounded-lg border border-border-default bg-surface-subtle px-4 py-3 text-body text-text-secondary', className)}>
      <Lock aria-hidden className="size-4 shrink-0" />
      <span>
        <span className="font-semibold text-text-primary">View only.</span> Ask a manager to make changes.
      </span>
    </div>
  );
}

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex min-h-[240px] items-center justify-center">
      <Spinner size="lg" label={label} />
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <EmptyState
      icon={<AlertTriangle />}
      title="We couldn’t load this"
      description={message ?? 'Check your connection and try again.'}
      action={onRetry && <Button onClick={onRetry}>Try again</Button>}
    />
  );
}

/** Contract P3-17: 409 revision_conflict → "Changed in another tab or by a teammate. Reload to continue". */
export function ConflictDialog({ open, onReload, loading }: { open: boolean; onReload: () => void; loading?: boolean }) {
  return (
    <Dialog
      open={open}
      title="Changed somewhere else"
      description="Changed in another tab or by a teammate. Reload to continue."
      confirmLabel="Reload"
      cancelLabel={null}
      loading={loading}
      onConfirm={onReload}
      onCancel={onReload}
    />
  );
}

export function StatusBadge({ status }: { status: 'draft' | 'published' | 'hidden' | 'live' }) {
  const map = { published: ['success', 'Published'], live: ['success', 'Live'], draft: ['warning', 'Draft'], hidden: ['neutral', 'Hidden'] } as const;
  const [tone, label] = map[status];
  return (
    <Badge tone={tone} dot>
      {label}
    </Badge>
  );
}

/** Section card used across V3 settings screens (radius 16, p 20, elevation 1, 15px semibold title). */
export function Panel({ title, description, actions, children, className }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={cn('flex flex-col gap-4 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1', className)}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            {title && <h2 className="text-[15px] leading-[22px] font-semibold text-text-primary">{title}</h2>}
            {description && <p className="text-[13px] leading-[18px] text-text-muted">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}
