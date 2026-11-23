import { cn } from '@storeplix/ui';
import type { ReactNode } from 'react';
import { useReadOnly } from './hooks';

/**
 * Contract §7.2: in a read-only support session the page's primary create/save actions are shown but disabled. `inert`
 * blocks clicks and focus for buttons and links alike; the API refuses writes regardless (403 `impersonation_read_only`).
 */
export function ReadOnlyActions({ children, className }: { children: ReactNode; className?: string }) {
  const readOnly = useReadOnly();
  return (
    <div
      className={cn(className, readOnly && 'cursor-not-allowed opacity-50')}
      inert={readOnly}
      aria-disabled={readOnly || undefined}
      data-read-only={readOnly ? '' : undefined}
      title={readOnly ? 'Read-only support session' : undefined}
    >
      {children}
    </div>
  );
}
