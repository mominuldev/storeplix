import type { SectionProps } from '../../types';
import type { RichTextSettings } from '../schema';
import { RichText } from '@/components/rich-text';

/** Generic "Text" section (no Figma frame): heading + rich text in the theme's type scale. */
export function RichTextSection({ id, settings: s }: SectionProps<RichTextSettings>) {
  const center = s.align === 'center';
  return (
    <div className={`mx-auto flex w-full flex-col gap-4 px-4 lg:px-20 ${s.width === 'narrow' ? 'max-w-[800px] lg:px-0' : ''} ${center ? 'items-center text-center' : ''}`}>
      {s.heading ? (
        <h2 id={`${id}-title`} className="type-display-m text-ink max-md:text-[32px]">
          {s.heading}
        </h2>
      ) : null}
      <RichText doc={s.doc} className="text-ink-secondary" />
    </div>
  );
}
