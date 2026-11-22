import Link from 'next/link';
import type { CSSProperties } from 'react';
import type { SectionProps } from '../../types';
import type { CategoryBlock, CategoryGridSettings } from '../schema';
import { DEMO, themeImage } from '../../media';
import { SectionHeader } from '../components/section-header';
import { ThemeImage } from '../components/theme-image';

// Figma "Category Frame" offsets (BG/Frame/* effect styles): desktop 1:10216 runs Sun, Sky, Orange, Blue;
// the phone 3x2 grid 1:10391 runs Orange, Blue, Sun, Sky (tablet 1:10557 follows desktop).
const FRAMES = ['var(--color-sun)', 'var(--color-sky)', 'var(--color-orange)', 'var(--color-brand)'];
const FRAMES_MOBILE = ['var(--color-orange)', 'var(--color-brand)', 'var(--color-sun)', 'var(--color-sky)'];
const DEMO_IMAGES = ['puffer', 'summer-wear', 'gift-set', 'stacker', 'baby-food', 'bath-set'].map((n) => `${DEMO}/${n}.png`);

/** Figma "Categories" - desktop 1:10216 (6 across), mobile 1:10391 (3-column grid). */
export function CategoryGridSection({ id, settings: s, blocks, ctx }: SectionProps<CategoryGridSettings, CategoryBlock>) {
  if (blocks.length === 0) return null;
  return (
    <div className="flex flex-col gap-5 px-4 md:gap-8 md:px-10 lg:gap-10 lg:px-20">
      {s.title ? <SectionHeader id={`${id}-title`} eyebrow={s.subtitle || undefined} title={s.title} /> : null}
      <ul className="grid grid-cols-3 gap-x-4 gap-y-6 md:gap-x-5 md:gap-y-8 lg:flex lg:gap-6">
        {blocks.map((b, i) => {
          const img = themeImage(ctx.media, b.settings.imageMediaId, DEMO_IMAGES[i % DEMO_IMAGES.length]!);
          return (
            <li key={b.id} className="min-w-0 lg:flex-1">
              <Link href={b.settings.href} className="group flex flex-col gap-2.5 md:gap-4">
                <span
                  className="relative block h-[240px] overflow-hidden rounded-sf-xs border border-line bg-surface p-[7px] shadow-[10px_10px_0_0_var(--sp-frame-m)] md:shadow-[10px_10px_0_0_var(--sp-frame)]"
                  style={{ '--sp-frame': FRAMES[i % FRAMES.length], '--sp-frame-m': FRAMES_MOBILE[i % FRAMES_MOBILE.length] } as CSSProperties}
                >
                  <span className="relative block size-full overflow-hidden rounded-[2px]">
                    <ThemeImage src={img.src} alt="" sizes="(min-width: 1024px) 200px, 33vw" className="transition group-hover:scale-[1.03]" />
                  </span>
                </span>
                <span className="text-[15px] leading-[1.2] font-semibold tracking-[-0.25px] text-ink [font-family:var(--font-heading)] md:type-h3">
                  {b.settings.title}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
