import type { SectionProps } from '../../types';
import type { ImageWithTextSettings } from '../schema';
import { DEMO, themeImage } from '../../media';
import { ButtonLink } from '../components/button';
import { Icon } from '../components/icon';
import { ThemeImage } from '../components/theme-image';

/**
 * Figma "Editorial · Winter" - desktop 1:10238 (panel pinned 46px from the top), tablet 1:10572 (panel bottom-left, 24px inset) (photo banner with an inverse panel), mobile 1:10419
 * (photo on top, panel below). `layout` puts the panel on the left (image_right) or right.
 */
export function ImageWithTextSection({ id, settings: s, ctx }: SectionProps<ImageWithTextSettings>) {
  const img = themeImage(ctx.media, s.imageMediaId, `${DEMO}/editorial-winter.png`);
  const panelRight = s.layout === 'image_left';
  return (
    <div className="px-4 md:px-10 lg:px-20">
      <div className="relative flex flex-col overflow-hidden rounded-sf-sm md:min-h-[460px] md:justify-end md:p-6 lg:min-h-[560px] lg:justify-start lg:px-0 lg:py-[46px]">
        <div className="relative h-[240px] md:absolute md:inset-0 md:h-auto">
          <ThemeImage src={img.src} alt={s.imageAlt || img.alt || ''} sizes="(min-width: 1024px) 1280px, 100vw" />
        </div>
        <div
          className={`relative flex flex-col items-start gap-3.5 bg-inverse p-6 text-paper md:w-[360px] md:gap-4 md:rounded-sf-sm md:p-8 lg:w-[520px] lg:gap-6 lg:p-12 ${panelRight ? 'md:ml-auto lg:mr-10' : 'lg:ml-10'}`}
        >
          {s.eyebrow ? <p className="type-eyebrow text-orange">{s.eyebrow}</p> : null}
          <h2 id={`${id}-title`} className="type-h1 lg:type-display-m">
            {s.heading}
          </h2>
          {s.text ? <p className="type-body-m opacity-85">{s.text}</p> : null}
          {s.ctaLabel && s.ctaHref ? (
            <ButtonLink href={s.ctaHref} variant="accent" className="max-md:w-full max-lg:px-5 max-lg:py-3">
              {s.ctaLabel}
              <Icon name="arrow-right" className="max-lg:size-[18px]" />
            </ButtonLink>
          ) : null}
        </div>
      </div>
    </div>
  );
}
