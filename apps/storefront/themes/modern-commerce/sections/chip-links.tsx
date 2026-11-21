import Link from 'next/link';
import type { SectionProps } from '../../types';
import type { ChipBlock, ChipLinksSettings } from '../schema';

// Figma chip fills in order: sun-soft, accent-soft, sage-soft, sky-soft, brand-soft, sunken.
const TONES = ['bg-sun-soft', 'bg-accent-soft', 'bg-sky-soft', 'bg-sky-tint', 'bg-brand-soft', 'bg-sunken'];

/** Figma "Shop by age" - desktop 1:10153 (pill row), mobile 1:10355 (horizontal scroller). */
export function ChipLinksSection({ id, settings: s, blocks }: SectionProps<ChipLinksSettings, ChipBlock>) {
  if (blocks.length === 0 && !s.title) return null;
  return (
    <div className="flex flex-col gap-4 lg:gap-6">
      {s.title || s.subtitle ? (
        <div className="flex items-center gap-3 px-4 lg:px-20">
          {s.title ? <h2 id={`${id}-title`} className="type-h2 text-ink">{s.title}</h2> : null}
          {s.subtitle ? <p className="type-accent-italic-s hidden text-ink-muted md:block">{s.subtitle}</p> : null}
        </div>
      ) : null}
      {blocks.length > 0 ? (
        <ul className="flex snap-x gap-3 overflow-x-auto px-4 pb-1 lg:overflow-visible lg:px-20 [scrollbar-width:none]">
          {blocks.map((b, i) => (
            <li key={b.id} className="shrink-0 snap-start lg:min-w-0 lg:flex-1 lg:shrink">
              <Link
                href={b.settings.href}
                className={`flex h-full flex-col gap-1 rounded-sf-lg px-4 py-3 text-[#0e1a33] lg:flex-row lg:items-center lg:gap-3.5 lg:rounded-full lg:py-2.5 lg:pr-6 lg:pl-2.5 ${TONES[i % TONES.length]}`}
              >
                {b.settings.badge ? (
                  <span className="type-price-m lg:type-label-m flex items-center justify-center lg:size-14 lg:shrink-0 lg:rounded-full lg:bg-surface">
                    {b.settings.badge}
                  </span>
                ) : null}
                <span className="flex min-w-0 flex-col">
                  <span className="type-body-s text-[#66728c] lg:type-label-m lg:truncate lg:text-[#0e1a33]">{b.settings.label}</span>
                  {b.settings.sublabel ? <span className="type-body-s hidden text-[#66728c] lg:block">{b.settings.sublabel}</span> : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
