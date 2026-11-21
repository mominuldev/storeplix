/** Sticky notice shown to merchants viewing their store with a valid preview token. */
export function PreviewBanner({ isPublic }: { isPublic: boolean }) {
  return (
    <div
      role="status"
      className="type-label-s sticky top-0 z-50 flex items-center justify-center gap-2 bg-ink px-4 py-2 text-center text-paper"
    >
      <span aria-hidden className="size-2 rounded-full bg-accent" />
      {isPublic ? 'Preview mode' : 'Preview — not public yet'}
    </div>
  );
}
