import { Button } from '@storeplix/ui';

export function CursorFooter({
  page,
  count,
  hasNext,
  onPrev,
  onNext,
}: {
  page: number;
  count: number;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex items-center gap-2 border-t border-border-default px-4 py-3">
      <p className="min-w-0 flex-1 text-caption text-text-secondary">
        Page {page} · {count} event{count === 1 ? '' : 's'}
      </p>
      <Button variant="secondary" size="sm" disabled={page <= 1} onClick={onPrev}>
        Previous
      </Button>
      <Button variant="secondary" size="sm" disabled={!hasNext} onClick={onNext}>
        Next
      </Button>
    </div>
  );
}
