import Link from 'next/link';
import type { SectionProps } from '../../types';
import type { CategoryBlock, CategoryGridSettings } from '../schema';
import { DEMO, themeImage } from '../../media';
import { SectionHeader } from '../components/section-header';
import { ThemeImage } from '../components/theme-image';

// Figma "Category Frame" offsets alternate Sun, Sky, Orange, Blue (BG/Frame/* effect styles).
const FRAMES = ['var(--color-sun)', 'var(--color-sky)', 'var(--color-orange)', 'var(--color-brand)'];
const DEMO_IMAGES = ['puffer', 'summer-wear', 'gift-set', 'stacker', 'baby-food', 'bath-set'].map((n) => `${DEMO}/${n}.png`);

/** Figma "Categories" - desktop 1:10216 (6 across), mobile 1:10391 (3-column grid). */
export function CategoryGridSection({ id, settings: s, blocks, ctx }: SectionProps<CategoryGridSettings, CategoryBlock>) {
  if (blocks.length === 0) return null;
  return (
    <div className="flex flex-col gap-6 px-4 lg:gap-10 lg:px-20">
      {s.title ? <SectionHeader id={`${id}-title`} eyebrow={s.subtitle || undefined} title={s.title} /> : null}
      <ul className="grid grid-cols-3 gap-x-3 gap-y-6 lg:flex lg:gap-6">
        {blocks.map((b, i) => {
          const img = themeImage(ctx.media, b.settings.imageMediaId, DEMO_IMAGES[i % DEMO_IMAGES.length]!);
          return (
            <li key={b.id} className="min-w-0 lg:flex-1">
              <Link href={b.settings.href} className="group flex flex-col gap-3 lg:gap-4">
                <span
                  className="relative block h-[232px] overflow-hidden rounded-sf-xs border border-line bg-surface p-[7px] max-lg:mr-2.5 lg:h-[240px]"
                  style={{ boxShadow: `10px 10px 0 0 ${FRAMES[i % FRAMES.length]}` }}
                >
                  <span className="relative block size-full overflow-hidden rounded-[2px]">
                    <ThemeImage src={img.src} alt="" sizes="(min-width: 1024px) 200px, 33vw" className="transition group-hover:scale-[1.03]" />
                  </span>
                </span>
                <span className="text-[15px] leading-[1.2] font-semibold tracking-[-0.25px] text-ink [font-family:var(--font-heading)] lg:type-h3">
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
