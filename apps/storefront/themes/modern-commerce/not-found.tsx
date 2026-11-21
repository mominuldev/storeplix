import { ButtonLink } from './components/button';
import { ThemeImage } from './components/theme-image';
import { DEMO } from '../media';

/** Figma 404 (desktop 1:13565 / mobile 1:13588): framed photo with a "404" swing tag. */
export function ThemeNotFound() {
  return (
    <section className="flex flex-col items-center gap-10 px-4 py-12 lg:flex-row lg:justify-center lg:gap-24 lg:px-20 lg:py-24">
      <div className="relative w-[240px] shrink-0 rotate-[-3deg] lg:w-[300px]">
        <div className="relative aspect-[4/5] overflow-hidden rounded-sf-xs border border-line bg-surface p-[9px] shadow-[10px_10px_0_0_var(--color-sun)]">
          <div className="relative size-full overflow-hidden rounded-[2px]">
            <ThemeImage src={`${DEMO}/elephant.png`} alt="" sizes="300px" />
          </div>
        </div>
        <p className="type-accent-italic absolute -top-4 -right-4 rotate-6 rounded-sf-sm bg-accent px-4 py-2 text-[20px] text-on-accent shadow-[6px_6px_0_0_var(--color-brand)]">
          404
        </p>
      </div>
      <div className="flex max-w-[520px] flex-col items-start gap-5">
        <h1 className="type-display-m text-ink lg:text-[64px] lg:leading-[1.04]">This page wandered off.</h1>
        <p className="type-body-m text-ink-secondary lg:type-body-l">
          The link may be old, or the product may have sold out for good. Try a search, or start from somewhere familiar.
        </p>
        <div className="flex flex-wrap gap-3">
          <ButtonLink href="/">Back to home</ButtonLink>
        </div>
      </div>
    </section>
  );
}
