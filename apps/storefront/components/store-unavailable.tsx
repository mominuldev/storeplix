import { UNAVAILABLE_COPY } from '@/lib/unavailable';

/**
 * React twin of the proxy's 503 page (lib/unavailable.ts) for the rare render that learns about a suspension before
 * the proxy's short cache does: same copy and layout, platform tokens only, no theme and no shop name. Rendered from
 * the root 404 boundary, which Next marks `noindex`.
 */
export function StoreUnavailable() {
  const c = UNAVAILABLE_COPY;
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-10 bg-surface-canvas px-4 py-16 text-center font-[family-name:var(--font-inter)] text-text-primary">
      <section
        aria-labelledby="unavailable-heading"
        className="flex w-full max-w-[560px] flex-col items-center gap-6 rounded-card border border-border-default bg-surface-card px-6 py-12 shadow-elevation-1 sm:px-12"
      >
        <p className="rounded-full bg-brand-50 px-3.5 py-1.5 text-caption font-semibold tracking-wide text-brand-700 uppercase">{c.eyebrow}</p>
        <h1 id="unavailable-heading" className="text-[32px] leading-10 font-bold tracking-[-0.5px] sm:text-display">
          {c.heading}
        </h1>
        <p className="text-body-lg text-text-secondary">{c.body}</p>
      </section>
      <p className="text-body text-text-muted">{c.footer}</p>
    </main>
  );
}
