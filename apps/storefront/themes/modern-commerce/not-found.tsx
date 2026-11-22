import { ButtonLink } from './components/button';
import { Icon } from './components/icon';
import { ThemeImage } from './components/theme-image';
import { DEMO } from '../media';

/**
 * Figma 404 (desktop 1:13565 / mobile 1:13588): tilted print with a "404" swing tag, Display/L copy,
 * a search field and two buttons. The "Popular" category chips are left out: this page gets no menu
 * data, and chips that link nowhere would be fake.
 */
export function ThemeNotFound() {
  return (
    <section className="flex flex-col items-center gap-8 px-4 pt-10 pb-12 lg:flex-row lg:gap-20 lg:px-40 lg:pt-24 lg:pb-[120px]">
      {/* Prints: 300px box (mobile) / 420px box (desktop); print rotated 4deg, tag rotated 10deg. */}
      <div className="relative size-[300px] shrink-0 lg:size-[420px]">
        <div className="absolute top-5 left-3 flex h-[275px] w-[238px] items-center justify-center lg:left-[25px] lg:h-[380px] lg:w-[324px]">
          <div className="relative h-[260px] w-[220px] shrink-0 rotate-4 overflow-hidden rounded-sf-xs border border-line bg-surface p-[11px] shadow-[10px_10px_0_0_var(--color-sun)] lg:h-[360px] lg:w-[300px]">
            <div className="relative size-full overflow-hidden rounded-[2px]">
              <ThemeImage src={`${DEMO}/elephant.png`} alt="" sizes="(min-width: 1024px) 278px, 198px" />
            </div>
          </div>
        </div>
        <div className="absolute top-0 left-[183px] flex h-14 w-[91px] items-center justify-center lg:left-[273px]">
          <p className="type-price-m flex shrink-0 rotate-10 items-center gap-2 rounded-sf-sm bg-accent py-2.5 pr-4 pl-3 text-on-accent shadow-[10px_10px_0_0_var(--color-brand)]">
            <Icon name="eyelet" original />
            404
          </p>
        </div>
      </div>
      <div className="flex w-full min-w-0 flex-col items-center gap-4 lg:flex-1 lg:items-start">
        <h1 className="type-h1 w-full text-center text-ink lg:text-left lg:text-[64px] lg:leading-[1.04] lg:tracking-[-2.5px]">This page wandered off.</h1>
        <p className="type-body-l w-full text-center text-ink-secondary lg:text-left">
          The link may be old, or the product may have sold out for good. Try a search, or start from somewhere familiar.
        </p>
        <form
          role="search"
          action="/search"
          className="flex h-12 w-full items-center gap-3 rounded-full border border-line-subtle bg-sunken py-1 pr-1 pl-5"
        >
          <Icon name="search" className="text-ink-muted" />
          <label htmlFor="not-found-search" className="sr-only">
            Search
          </label>
          <input
            id="not-found-search"
            name="q"
            type="search"
            placeholder="Search clothing, toys, baby food…"
            className="type-body-m min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-muted"
          />
          <button type="submit" className="type-label-s rounded-control bg-brand px-4 py-2 text-on-brand hover:brightness-110">
            Search
          </button>
        </form>
        <div className="flex w-full gap-2.5 lg:w-auto">
          <ButtonLink href="/" className="max-lg:min-w-0 max-lg:flex-1 max-lg:px-2">
            Back to home
          </ButtonLink>
          <ButtonLink href="/search?sort=latest" variant="outline" className="max-lg:min-w-0 max-lg:flex-1 max-lg:px-2">
            Shop new arrivals
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}
