import Link from 'next/link';
import { Icon } from './icon';

interface SectionHeaderProps {
  eyebrow?: string;
  title: string;
  linkLabel?: string;
  linkHref?: string;
  id?: string;
}

/** Figma "Section Header" (instance 1:10226). */
export function SectionHeader({ eyebrow, title, linkLabel, linkHref, id }: SectionHeaderProps) {
  return (
    <div className="flex items-end justify-between gap-6">
      <div className="flex min-w-0 flex-col gap-2">
        {eyebrow ? <p className="type-eyebrow text-accent-ink">{eyebrow}</p> : null}
        <h2 id={id} className="type-display-m text-ink max-md:text-[32px]">
          {title}
        </h2>
      </div>
      {linkLabel && linkHref ? (
        <Link href={linkHref} className="type-label-m flex shrink-0 items-center gap-2 text-ink hover:underline">
          {linkLabel}
          <Icon name="arrow-up-right" />
        </Link>
      ) : null}
    </div>
  );
}
