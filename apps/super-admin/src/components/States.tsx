import { Button, EmptyState, SkeletonRows } from '@storeplix/ui';
import { AlertTriangle, Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { errorMessage } from '../lib/errors';

// Figma States 148:34032 (the admin page has none): Loading 148:35302 skeleton rows, Error 148:35336 (warning icon,
// "We couldn't load this" + Try again), Empty 148:35352 (icon tile, title, one line).
export function LoadingRows({ label = 'Loading', rows = 5 }: { label?: string; rows?: number }) {
  return <SkeletonRows rows={rows} label={label} />;
}

export function ErrorState({ error, onRetry, title = 'We couldn’t load this' }: { error?: unknown; onRetry?: () => void; title?: string }) {
  return (
    <div role="alert">
      <EmptyState
        icon={<AlertTriangle />}
        title={title}
        description={error ? errorMessage(error, 'Check your connection and try again.') : 'Check your connection and try again.'}
        action={
          onRetry && (
            <Button variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          )
        }
      />
    </div>
  );
}

export function Empty({ title, description, icon, action }: { title: string; description?: string; icon?: ReactNode; action?: ReactNode }) {
  return <EmptyState icon={icon ?? <Inbox />} title={title} description={description} action={action} />;
}
