import Link from 'next/link';
import type { SectionProps } from '../../types';
import type { FeatureTilesSettings, TileBlock } from '../schema';
import { DEMO, themeImage } from '../../media';
import { Icon } from '../components/icon';
import { SectionHeader } from '../components/section-header';
import { ThemeImage } from '../components/theme-image';

const TINTS = ['bg-sky-tint', 'bg-sky-soft', 'bg-sun-soft'];
const DEMO_IMAGES = ['shape-puzzle', 'baby-food', 'meal-set'].map((n) => `${DEMO}/${n}.png`);

function TileCopy({ b, big }: { b: TileBlock; big: boolean }) {
  return (
    <div className={`flex min-w-0 flex-1 flex-col items-start gap-1.5 p-5 lg:gap-3 lg:p-10 ${big ? 'md:gap-2.5 md:p-8' : 'md:gap-2 md:p-6'}`}>
      <h3 className={`type-h3 lg:type-h1 ${big ? 'md:type-h1' : 'md:type-h2'}`}>{b.title}</h3>
      {b.text ? <p className={`type-body-m hidden text-[#33405c] lg:block ${big ? 'md:block' : ''}`}>{b.text}</p> : null}
      <span className="type-label-s md:type-label-m flex items-center gap-1.5 pt-1.5 md:gap-2 md:pt-0 lg:pt-2">
        {b.linkLabel || 'Shop now'}
        <Icon name="arrow-right-sm" className="max-md:size-3.5 md:max-lg:size-4" />
      </span>
    </div>
  );
}

/**
 * Figma "Three worlds" - desktop 1:10248 (bento: one tall tile + two stacked), tablet 1:10579 (wide
 * row + photo-topped pair), mobile 1:10427
 * (stacked rows with the photo on the right).
 */
export function FeatureTilesSection({ id, settings: s, blocks, ctx }: SectionProps<FeatureTilesSettings, TileBlock>) {
  if (blocks.length === 0) return null;
  const [first, ...rest] = blocks;
  const img = (b: (typeof blocks)[number], i: number) => themeImage(ctx.media, b.settings.imageMediaId, DEMO_IMAGES[i % DEMO_IMAGES.length]!);

  return (
    <div className="flex flex-col gap-3 px-4 md:gap-4 md:px-10 lg:gap-10 lg:px-20">
      {s.title ? <SectionHeader id={`${id}-title`} eyebrow={s.subtitle || undefined} title={s.title} /> : null}
      <div className="flex flex-col gap-3 text-[#0e1a33] md:gap-4 lg:flex-row lg:gap-6">
        {first ? (
          <Link href={first.settings.href} className={`flex overflow-hidden rounded-sf-sm lg:w-[54.6875%] lg:shrink-0 lg:flex-col ${TINTS[0]}`}>
            <TileCopy b={first.settings} big />
            <span className="relative w-[132px] shrink-0 md:w-[320px] lg:h-[400px] lg:w-full">
              <ThemeImage src={img(first, 0).src} alt="" sizes="(min-width: 1024px) 700px, (min-width: 768px) 320px, 132px" />
            </span>
          </Link>
        ) : null}
        {rest.length > 0 ? (
          <div className="flex flex-col gap-3 md:flex-row md:gap-4 lg:min-w-0 lg:flex-1 lg:flex-col lg:gap-6">
            {rest.map((b, i) => (
              <Link key={b.id} href={b.settings.href} className={`flex overflow-hidden rounded-sf-sm md:flex-1 md:flex-col-reverse lg:flex-row ${TINTS[(i + 1) % TINTS.length]}`}>
                <TileCopy b={b.settings} big={false} />
                <span className="relative w-[132px] shrink-0 md:h-[200px] md:w-full lg:h-auto lg:w-[240px]">
                  <ThemeImage src={img(b, i + 1).src} alt="" sizes="(min-width: 1024px) 240px, (min-width: 768px) 370px, 132px" />
                </span>
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
