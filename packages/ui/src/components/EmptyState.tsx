import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center gap-3 px-6 py-10 text-center', className)}>
      {icon && (
        <div className="flex size-12 items-center justify-center rounded-full bg-brand-50 text-brand-600 [&_svg]:size-6">
          {icon}
        </div>
      )}
      <div className="flex max-w-sm flex-col gap-1">
        <h3 className="text-body-lg font-semibold text-text-primary">{title}</h3>
        {description && <p className="text-body text-text-secondary">{description}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
