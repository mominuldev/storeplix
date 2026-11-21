import type { SectionProps } from '../../types';
import type { ImageWithTextSettings } from '../schema';
import { DEMO, themeImage } from '../../media';
import { ButtonLink } from '../components/button';
import { Icon } from '../components/icon';
import { ThemeImage } from '../components/theme-image';

/**
 * Figma "Editorial · Winter" - desktop 1:10238 (photo banner with an inverse panel), mobile 1:10419
 * (photo on top, panel below). `layout` puts the panel on the left (image_right) or right.
 */
export function ImageWithTextSection({ id, settings: s, ctx }: SectionProps<ImageWithTextSettings>) {
  const img = themeImage(ctx.media, s.imageMediaId, `${DEMO}/editorial-winter.png`);
  const panelRight = s.layout === 'image_left';
  return (
    <div className="px-4 lg:px-20">
      <div className="relative flex flex-col overflow-hidden rounded-sf-sm lg:h-[560px] lg:justify-center">
        <div className="relative h-[240px] lg:absolute lg:inset-0 lg:h-auto">
          <ThemeImage src={img.src} alt={s.imageAlt || img.alt || ''} sizes="(min-width: 1024px) 1280px, 100vw" />
        </div>
        <div
          className={`relative flex flex-col items-start gap-6 bg-inverse p-6 text-paper lg:w-[520px] lg:rounded-sf-sm lg:p-12 ${panelRight ? 'lg:mr-10 lg:ml-auto' : 'lg:ml-10'}`}
        >
          {s.eyebrow ? <p className="type-eyebrow text-orange">{s.eyebrow}</p> : null}
          <h2 id={`${id}-title`} className="type-display-m max-md:text-[32px]">
            {s.heading}
          </h2>
          {s.text ? <p className="type-body-m opacity-85">{s.text}</p> : null}
          {s.ctaLabel && s.ctaHref ? (
            <ButtonLink href={s.ctaHref} variant="accent" className="max-lg:w-full">
              {s.ctaLabel}
              <Icon name="arrow-right" />
            </ButtonLink>
          ) : null}
        </div>
      </div>
    </div>
  );
}
