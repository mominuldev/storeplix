import { cn } from '../lib/cn';

// Figma States · Loading 148:35302 — surface-subtle blocks: 32px square, two lines (60% / 35%), a pill on the right.
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn('block animate-pulse rounded-md bg-surface-subtle', className)} />;
}

export function SkeletonRows({ rows = 5, label = 'Loading', className }: { rows?: number; label?: string; className?: string }) {
  return (
    <div role="status" aria-label={label} className={cn('flex flex-col gap-4 p-5', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-8 shrink-0 rounded-md" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-2.5 w-3/5 rounded-full" />
            <Skeleton className="h-2.5 w-1/3 rounded-full" />
          </div>
          <Skeleton className="h-5 w-14 shrink-0 rounded-full" />
        </div>
      ))}
    </div>
  );
}
