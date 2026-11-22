import Link from 'next/link';
import { Icon } from './icon';

interface SectionHeaderProps {
  eyebrow?: string;
  title: string;
  linkLabel?: string;
  linkHref?: string;
  id?: string;
}

/** Figma "Section Header" (instance 1:10226; mobile 1:10407 - H2 title, Label/S link). */
export function SectionHeader({ eyebrow, title, linkLabel, linkHref, id }: SectionHeaderProps) {
  return (
    <div className="flex items-end justify-between gap-3 md:gap-6">
      <div className="flex min-w-0 flex-col gap-1.5 md:gap-2">
        {eyebrow ? <p className="type-eyebrow text-accent-ink">{eyebrow}</p> : null}
        <h2 id={id} className="type-h2 text-ink md:type-display-m">
          {title}
        </h2>
      </div>
      {linkLabel && linkHref ? (
        <Link href={linkHref} className="type-label-s md:type-label-m flex shrink-0 items-center gap-1 text-ink hover:underline md:gap-2">
          {linkLabel}
          <Icon name="arrow-up-right" className="max-md:size-3.5" />
        </Link>
      ) : null}
    </div>
  );
}
