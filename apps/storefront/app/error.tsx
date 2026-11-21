'use client';

/** Shown when the storefront API is unreachable or returns an unexpected error. */
export default function StoreError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-surface-canvas px-6 text-center font-[family-name:var(--font-inter)] text-text-primary">
      <h1 className="text-heading-24">This store is temporarily unavailable</h1>
      <p className="text-body text-text-secondary">Please try again in a moment.</p>
      <button
        type="button"
        onClick={reset}
        className="rounded-md bg-brand-600 px-4 py-2.5 text-body font-semibold text-text-inverse hover:bg-brand-700"
      >
        Try again
      </button>
    </main>
  );
}
