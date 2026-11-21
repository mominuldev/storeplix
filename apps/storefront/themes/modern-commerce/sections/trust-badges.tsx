import type { SectionProps } from '../../types';
import type { BadgeBlock, BadgeIcon, TrustBadgesSettings } from '../schema';
import { Icon, type IconName } from '../components/icon';

// Figma ships cash/truck/return/shield; chat/gift/star/leaf reuse the closest theme icons.
const ICONS: Record<BadgeIcon, IconName> = {
  cash: 'cash',
  truck: 'truck',
  return: 'return',
  shield: 'shield',
  chat: 'whatsapp',
  gift: 'tag',
  star: 'star-outline',
  leaf: 'sparkle',
};

/** Figma "Promises" - desktop 1:10292 (4 across), mobile 1:10456 (stacked). */
export function TrustBadgesSection({ blocks }: SectionProps<TrustBadgesSettings, BadgeBlock>) {
  if (blocks.length === 0) return null;
  return (
    <ul className="flex flex-col gap-5 px-4 lg:flex-row lg:items-center lg:gap-6 lg:px-20">
      {blocks.map((b) => (
        <li key={b.id} className="flex min-w-0 flex-1 items-center gap-4">
          <span className="flex size-[52px] shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
            <Icon name={ICONS[b.settings.icon]} size={24} />
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="type-label-m text-ink">{b.settings.title}</span>
            {b.settings.text ? <span className="type-body-s text-ink-muted">{b.settings.text}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
