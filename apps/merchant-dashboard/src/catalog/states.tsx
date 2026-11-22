import { isApiError } from '@storeplix/api-client';
import { Button, cn, SkeletonRows } from '@storeplix/ui';
import { AlertTriangle, Search } from 'lucide-react';
import type { ReactNode } from 'react';

// Figma States 148:35298 — Loading 148:35302 (skeleton rows), Error 148:35336 (danger-bg 48px circle, title,
// description, "Try again"), No results 148:35352 (surface-subtle circle + search icon, "Clear search").

export function LoadingRows({ rows = 5, label = 'Loading' }: { rows?: number; label?: string }) {
  return <SkeletonRows rows={rows} label={label} />;
}

function StateBlock({ icon, tone, title, description, actions, className }: { icon: ReactNode; tone: 'danger' | 'neutral'; title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div role={tone === 'danger' ? 'alert' : undefined} className={cn('flex flex-col items-center gap-3 px-6 py-10 text-center', className)}>
      <span className={cn('flex size-12 items-center justify-center rounded-full [&_svg]:size-6', tone === 'danger' ? 'bg-danger-bg text-text-secondary' : 'bg-surface-subtle text-text-secondary')}>{icon}</span>
      <div className="flex max-w-sm flex-col gap-1.5">
        <h3 className="text-body-lg font-medium text-text-primary">{title}</h3>
        {description && <p className="text-body text-text-secondary">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-3">{actions}</div>}
    </div>
  );
}

export function errorMessage(error: unknown, fallback = 'Check your connection and try again.'): string {
  if (isApiError(error)) return error.status === 0 ? 'Check your connection and try again.' : error.message || fallback;
  return fallback;
}

export function ErrorBlock({ error, message, title = 'We couldn’t load this', onRetry, className }: { error?: unknown; message?: string; title?: string; onRetry?: () => void; className?: string }) {
  return (
    <StateBlock
      icon={<AlertTriangle aria-hidden />}
      tone="danger"
      title={title}
      description={message ?? errorMessage(error)}
      actions={onRetry && <Button size="sm" onClick={onRetry}>Try again</Button>}
      className={className}
    />
  );
}

export function NoResults({ title, description, onClear, clearLabel = 'Clear search' }: { title: ReactNode; description?: ReactNode; onClear?: () => void; clearLabel?: string }) {
  return (
    <StateBlock
      icon={<Search aria-hidden />}
      tone="neutral"
      title={title}
      description={description}
      actions={
        onClear && (
          <Button size="sm" variant="secondary" onClick={onClear}>
            {clearLabel}
          </Button>
        )
      }
    />
  );
}

/** Card wrapper used for page-level error/loading states. */
export function StateCard({ children }: { children: ReactNode }) {
  return <section className="rounded-card border border-border-default bg-surface-card shadow-elevation-1">{children}</section>;
}
