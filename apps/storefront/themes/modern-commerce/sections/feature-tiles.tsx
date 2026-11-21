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
    <div className={`flex min-w-0 flex-1 flex-col items-start gap-2 p-5 lg:gap-3 ${big ? 'lg:p-10' : 'lg:p-10'}`}>
      <h3 className="text-[24px] leading-[1.12] font-semibold tracking-[-0.5px] [font-family:var(--font-heading)] lg:type-h1">{b.title}</h3>
      {b.text ? <p className="type-body-m hidden text-[#33405c] lg:block">{b.text}</p> : null}
      <span className="type-label-m flex items-center gap-2 pt-1 lg:pt-2">
        {b.linkLabel || 'Shop now'}
        <Icon name="arrow-right-sm" />
      </span>
    </div>
  );
}

/**
 * Figma "Three worlds" - desktop 1:10248 (bento: one tall tile + two stacked), mobile 1:10427
 * (stacked rows with the photo on the right).
 */
export function FeatureTilesSection({ id, settings: s, blocks, ctx }: SectionProps<FeatureTilesSettings, TileBlock>) {
  if (blocks.length === 0) return null;
  const [first, ...rest] = blocks;
  const img = (b: (typeof blocks)[number], i: number) => themeImage(ctx.media, b.settings.imageMediaId, DEMO_IMAGES[i % DEMO_IMAGES.length]!);

  return (
    <div className="flex flex-col gap-6 px-4 lg:gap-10 lg:px-20">
      {s.title ? <SectionHeader id={`${id}-title`} eyebrow={s.subtitle || undefined} title={s.title} /> : null}
      <div className="flex flex-col gap-3 text-[#0e1a33] lg:flex-row lg:gap-6">
        {first ? (
          <Link href={first.settings.href} className={`flex overflow-hidden rounded-sf-sm lg:w-[55%] lg:shrink-0 lg:flex-col ${TINTS[0]}`}>
            <TileCopy b={first.settings} big />
            <span className="relative w-[132px] shrink-0 lg:h-[400px] lg:w-full">
              <ThemeImage src={img(first, 0).src} alt="" sizes="(min-width: 1024px) 700px, 132px" />
            </span>
          </Link>
        ) : null}
        {rest.length > 0 ? (
          <div className="flex flex-col gap-3 lg:min-w-0 lg:flex-1 lg:gap-6">
            {rest.map((b, i) => (
              <Link key={b.id} href={b.settings.href} className={`flex overflow-hidden rounded-sf-sm lg:flex-1 ${TINTS[(i + 1) % TINTS.length]}`}>
                <TileCopy b={b.settings} big={false} />
                <span className="relative w-[132px] shrink-0 lg:w-[240px]">
                  <ThemeImage src={img(b, i + 1).src} alt="" sizes="(min-width: 1024px) 240px, 132px" />
                </span>
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
