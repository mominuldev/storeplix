import Link from 'next/link';
import type { SectionProps } from '../../types';
import type { ChipBlock, ChipLinksSettings } from '../schema';

// Figma chip fills in order: sun-soft, accent-soft, sage-soft, sky-soft, brand-soft, sunken.
const TONES = ['bg-sun-soft', 'bg-accent-soft', 'bg-sky-soft', 'bg-sky-tint', 'bg-brand-soft', 'bg-sunken'];

/** Figma "Shop by age" - desktop 1:10153 (pill row), tablet 1:10500 (3x2 pill grid), mobile 1:10355 (horizontal scroller). */
export function ChipLinksSection({ id, settings: s, blocks }: SectionProps<ChipLinksSettings, ChipBlock>) {
  if (blocks.length === 0 && !s.title) return null;
  return (
    <div className="flex flex-col gap-4 lg:gap-6">
      {s.title || s.subtitle ? (
        <div className="flex items-center gap-3 px-4 md:px-10 lg:px-20">
          {s.title ? <h2 id={`${id}-title`} className="type-h2 text-ink">{s.title}</h2> : null}
          {s.subtitle ? <p className="type-accent-italic-s hidden text-ink-muted lg:block">{s.subtitle}</p> : null}
        </div>
      ) : null}
      {blocks.length > 0 ? (
        <ul className="flex snap-x scroll-px-4 gap-2 overflow-x-auto px-4 pb-1 md:grid md:grid-cols-3 md:gap-3 md:overflow-visible md:px-10 md:pb-0 lg:flex lg:px-20 [scrollbar-width:none]">
          {blocks.map((b, i) => (
            <li key={b.id} className="shrink-0 snap-start md:min-w-0 lg:flex-1 lg:shrink">
              <Link
                href={b.settings.href}
                className={`flex h-full flex-col gap-0.5 rounded-sf-lg px-4 py-3.5 text-[#0e1a33] md:flex-row md:items-center md:gap-3 md:rounded-full md:p-2 md:pr-6 lg:gap-3.5 lg:py-2.5 lg:pl-2.5 ${TONES[i % TONES.length]}`}
              >
                {b.settings.badge ? (
                  <span className="type-price-m md:type-label-m md:font-body md:tracking-normal flex items-center justify-center md:size-12 md:shrink-0 md:rounded-full md:bg-surface lg:size-14">
                    {b.settings.badge}
                  </span>
                ) : null}
                <span className="flex min-w-0 flex-col">
                  <span className="type-body-s text-[#66728c] md:type-label-m md:truncate md:text-[#0e1a33]">{b.settings.label}</span>
                  {b.settings.sublabel ? <span className="type-body-s hidden text-[#66728c] md:block">{b.settings.sublabel}</span> : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
