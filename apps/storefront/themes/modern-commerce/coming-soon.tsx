import type { ThemeStore } from '../types';
import type { ModernCommerceSettings } from './schema';
import { StoreLogo } from './components/store-logo';
import { Icon } from './components/icon';

/**
 * Coming soon page for draft stores. No Figma frame exists; composed from modern-commerce tokens
 * (canvas, framed card with the hero's hard offset shadow, eyebrow pill, Display/M + italic accent).
 */
export function ComingSoon({ store }: { store: ThemeStore; settings: ModernCommerceSettings }) {
  return (
    <main className="theme-root flex min-h-dvh flex-col items-center justify-center gap-10 px-4 py-16">
      <StoreLogo store={store} />
      <section
        aria-labelledby="coming-soon-heading"
        className="flex w-full max-w-[560px] flex-col items-center gap-6 rounded-sf-xs border border-line bg-surface px-6 py-12 text-center shadow-[10px_10px_0_0_var(--color-sun)] sm:px-12"
      >
        <p className="type-eyebrow flex items-center gap-2 rounded-full bg-accent-soft px-3.5 py-1.5 text-accent-ink">
          <Icon name="sparkle" className="text-accent" />
          Coming soon
        </p>
        <h1 id="coming-soon-heading" className="type-display-m text-ink max-md:text-[36px]">
          <span className="block">Something new</span>
          <span className="type-accent-italic block text-brand">is on its way.</span>
        </h1>
        <p className="type-body-m text-ink-secondary">
          {store.name} is getting its shelves ready. Please check back soon.
        </p>
      </section>
      <p className="type-body-s text-ink-muted">Powered by Store Plix</p>
    </main>
  );
}
