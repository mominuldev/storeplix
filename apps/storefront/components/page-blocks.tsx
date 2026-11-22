import type { StorefrontMedia } from '@storeplix/types';
import type { SafePageBlock } from '@/lib/page-blocks';
import { isExternalHref, sanitizeHref } from '@/lib/sanitize';
import { ThemeImage } from '@/themes/modern-commerce/components/theme-image';
import { RichText } from './rich-text';

const TONES = {
  info: 'bg-sky-soft border-brand/20',
  success: 'bg-[#e3f4e8] border-[#14833b]/20',
  warning: 'bg-sun-soft border-sun/40',
} as const;

/** In-page anchor for an H2 block ("On this page" list, Figma policy page 149:1453). */
export function headingAnchor(blockId: string): string {
  return `section-${blockId.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

/** Button links: theme href rule, wa.me or tel (re-checked; an unsafe href drops the button). */
function safeButtonHref(href: string): string | null {
  if (/^tel:\+?[0-9]{7,15}$/.test(href)) return href;
  if (/^https:\/\/wa\.me\/[0-9]{7,15}$/.test(href)) return href;
  return sanitizeHref(href);
}

function Block({ block, media }: { block: SafePageBlock; media: Record<string, StorefrontMedia> }) {
  switch (block.type) {
    case 'heading':
      return block.level === 3 ? (
        <h3 className="type-h3 text-ink">{block.text}</h3>
      ) : (
        <h2 id={headingAnchor(block.id)} className="type-h2 scroll-mt-[200px] text-ink max-md:text-[22px] max-md:leading-[1.2]">
          {block.text}
        </h2>
      );
    case 'rich_text':
      return <RichText doc={block.doc} className="text-ink-secondary" />;
    case 'image': {
      // Page images only render when the media map resolves them (no demo fallback on pages).
      const m = block.media_id ? media[block.media_id] : undefined;
      if (!m) return null;
      return (
        <figure className="flex flex-col gap-2">
          <span className="relative block overflow-hidden rounded-sf-xs bg-sunken" style={{ aspectRatio: `${m.width} / ${m.height}` }}>
            <ThemeImage src={m.url} alt={block.alt ?? m.alt ?? ''} sizes="(min-width: 1024px) 760px, 100vw" />
          </span>
          {block.caption ? <figcaption className="type-body-s text-ink-muted">{block.caption}</figcaption> : null}
        </figure>
      );
    }
    case 'button': {
      const href = safeButtonHref(block.href);
      if (!href) return null;
      const cls = `type-label-m inline-flex w-fit items-center justify-center gap-2 rounded-control px-7 py-4 ${
        block.style === 'secondary' ? 'border-[1.5px] border-ink text-ink hover:bg-ink/5' : 'bg-brand text-on-brand hover:brightness-110'
      }`;
      return isExternalHref(href) ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
          {block.label}
        </a>
      ) : (
        <a href={href} className={cls}>
          {block.label}
        </a>
      );
    }
    case 'callout':
      return (
        <aside className={`flex flex-col gap-2 rounded-sf-lg border p-5 text-[#0e1a33] ${TONES[block.tone]}`}>
          {block.title ? <p className="type-label-m">{block.title}</p> : null}
          <ul className="type-body-m flex list-disc flex-col gap-1 pl-5 text-[#33405c]">
            {block.items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </aside>
      );
    case 'table':
      return (
        <div className="overflow-x-auto rounded-sf-lg border border-line">
          <table className="type-body-s w-full border-collapse text-left">
            <thead className="bg-sunken text-ink">
              <tr>
                {block.headers.map((h, i) => (
                  <th key={i} scope="col" className="px-4 py-3 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="text-ink-secondary">
              {block.rows.map((row, r) => (
                <tr key={r} className="border-t border-line-subtle">
                  {row.map((cell, c) => (
                    <td key={c} className="px-4 py-3">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}

/** Page body blocks → React elements. Unknown blocks render nothing. */
export function PageBlocks({ blocks, media }: { blocks: SafePageBlock[]; media: Record<string, StorefrontMedia> }) {
  return (
    <div className="flex flex-col gap-4 md:gap-6">
      {blocks.map((b) => (
        <Block key={b.id} block={b} media={media} />
      ))}
    </div>
  );
}
