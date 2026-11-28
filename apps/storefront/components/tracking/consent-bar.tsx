'use client';

/**
 * Storeplix consent bar (PHASE-8-9D P89D-14; not drawn in Figma — §18: existing tokens only). Shown only for a shop
 * that turned on "Wait for cookie consent" while the shopper hasn't decided. Nothing loads or fires until Accept.
 */
export function ConsentBar({ onDecide }: { onDecide: (decision: 'granted' | 'denied') => void }) {
  return (
    <section
      aria-label="Cookie consent"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-line bg-surface px-4 py-4 shadow-e3 lg:px-20"
      data-sp-consent-bar
    >
      <div className="mx-auto flex max-w-[1280px] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <p className="type-body-s text-ink">
          This shop uses cookies from advertising and analytics partners to measure visits and improve its ads. Allow them?
        </p>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => onDecide('denied')}
            className="type-label-m flex h-11 flex-1 items-center justify-center rounded-control border border-line bg-surface px-5 text-ink hover:border-ink sm:flex-none"
            data-sp-consent="decline"
          >
            Decline
          </button>
          <button
            type="button"
            onClick={() => onDecide('granted')}
            className="type-label-m flex h-11 flex-1 items-center justify-center rounded-control bg-brand px-5 text-on-brand hover:brightness-110 sm:flex-none"
            data-sp-consent="accept"
          >
            Accept
          </button>
        </div>
      </div>
    </section>
  );
}
