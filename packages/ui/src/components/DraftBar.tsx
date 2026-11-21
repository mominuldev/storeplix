import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

// Figma V3 Brand style 2035:46056 / Navigation 2037:46512 bottom bar — ink (text-primary) surface, radius 12,
// coral dot, white title (Body/14 Semibold) + muted subtitle, actions on the right. Sticks to the bottom of the
// scroll container; on phones it sits above the tab bar.
export interface DraftBarProps {
  title: ReactNode;
  description?: ReactNode;
  actions: ReactNode;
  className?: string;
}

export function DraftBar({ title, description, actions, className }: DraftBarProps) {
  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      className={cn(
        'sticky bottom-24 z-20 flex flex-col gap-3 rounded-lg bg-text-primary px-5 py-3.5 text-text-inverse shadow-elevation-1 sm:flex-row sm:items-center lg:bottom-4',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-accent-500" />
        <div className="flex min-w-0 flex-col">
          <p className="text-body font-semibold">{title}</p>
          {description && <p className="truncate text-caption text-text-muted">{description}</p>}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>
    </div>
  );
}

/** Ghost button styled for the dark DraftBar ("Discard"). */
export function DraftBarGhostButton({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        'min-h-10 rounded-md px-3 text-body font-medium text-text-inverse/80 outline-none hover:text-text-inverse focus-visible:shadow-focus disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
