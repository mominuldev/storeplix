import { AlertTriangle, ImageOff, Info, Lightbulb } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { helpHeadingAnchor, isExternalHelpHref, isHttpUrl, isInternalHelpHref } from './helpLinks';

// PHASE-8-9C P89C-5 / §13: the one renderer for help article bodies (`HelpArticleDoc` = RichTextDoc subset + `image` +
// `callout`), used by the merchant article page and the super-admin editor preview. Content is data rendered by
// components: never `dangerouslySetInnerHTML`, unknown nodes/marks are dropped, links are http(s) or app-relative only.
// Figma article 71:21665 / mobile 2132:55211: H2 20/28 semibold, H3 16/24 semibold, Body/14 secondary paragraphs,
// ordered lists as numbered steps (24px brand-600 circles), callouts info (info-bg) / warning (warning-bg) / tip
// (success-bg), images in a rounded bordered frame with a caption.
// The types are structural mirrors of @storeplix/types `HelpArticleDoc` / `HelpMediaRef` (the UI package has no
// types dependency); a `HelpArticleDoc` is assignable to `HelpArticleBodyDoc`.

export interface HelpArticleBodyMark {
  type: string;
  attrs?: { [key: string]: unknown };
}
export interface HelpArticleBodyNode {
  type: string;
  text?: string;
  marks?: readonly HelpArticleBodyMark[];
  attrs?: { [key: string]: unknown };
  content?: readonly HelpArticleBodyNode[];
}
export interface HelpArticleBodyDoc {
  type: string;
  content?: readonly HelpArticleBodyNode[];
}
export interface HelpArticleBodyMedia {
  status: 'processing' | 'ready' | 'failed';
  url: string | null;
  width: number | null;
  height: number | null;
  variants: Partial<Record<'w640' | 'w1024' | 'w1600', string>>;
  alt?: string | null;
}

export interface HelpArticleBodyProps {
  /** `HelpArticleDoc` (validated server-side; re-checked here). */
  doc: HelpArticleBodyDoc | null | undefined;
  /** `HelpArticle.media` / `AdminHelpArticle.media`: media_id → image. Missing / not ready → placeholder. */
  media?: Readonly<Record<string, HelpArticleBodyMedia>>;
  /** Server TOC (`HelpTocEntry[]`): the n-th H2/H3 of the doc gets `toc[n].id` as its anchor id. */
  toc?: readonly { id: string }[];
  /** Served language; `bn` switches to the Bangla typeface and sets `lang`. */
  language?: 'en' | 'bn';
  /** Renders app-relative links (`/help/articles/…`) through the host router. Default: a plain `<a href>`. */
  renderInternalLink?: (href: string, children: ReactNode) => ReactNode;
  className?: string;
}

const plainText = (nodes: readonly HelpArticleBodyNode[] | undefined): string =>
  (nodes ?? []).map((n) => (n.type === 'text' && typeof n.text === 'string' ? n.text : n.type === 'hardBreak' ? ' ' : plainText(n.content))).join('');

type Ctx = Required<Pick<HelpArticleBodyProps, 'renderInternalLink'>> & {
  media: Readonly<Record<string, HelpArticleBodyMedia>>;
  toc: readonly { id: string }[];
  headingIndex: { n: number };
};

const linkClass = 'font-medium text-brand-600 underline underline-offset-2 hover:text-brand-700';

function renderInline(nodes: readonly HelpArticleBodyNode[] | undefined, ctx: Ctx): ReactNode[] {
  return (nodes ?? []).map((node, i) => {
    if (node.type === 'hardBreak') return <br key={i} />;
    if (node.type !== 'text' || typeof node.text !== 'string') return null;
    let out: ReactNode = node.text;
    let href: string | null | undefined;
    for (const mark of node.marks ?? []) {
      switch (mark.type) {
        case 'bold':
          out = <strong className="font-semibold text-text-primary">{out}</strong>;
          break;
        case 'italic':
          out = <em>{out}</em>;
          break;
        case 'underline':
          out = <u>{out}</u>;
          break;
        case 'strike':
          out = <s>{out}</s>;
          break;
        case 'link':
          href = typeof mark.attrs?.href === 'string' ? mark.attrs.href : null;
          break;
        default:
          break; // unknown mark: text only
      }
    }
    if (href !== undefined) {
      if (href && isInternalHelpHref(href)) out = ctx.renderInternalLink(href, out);
      else if (href && isExternalHelpHref(href))
        out = (
          <a href={href} target="_blank" rel="noopener noreferrer" className={linkClass}>
            {out}
          </a>
        );
      // anything else (javascript:, data:, //host, mailto:…) renders as plain text
    }
    return <span key={i}>{out}</span>;
  });
}

const calloutTones = {
  info: { box: 'bg-info-bg', icon: <Info aria-hidden className="text-info" />, label: 'Note' },
  warning: { box: 'bg-warning-bg', icon: <AlertTriangle aria-hidden className="text-warning" />, label: 'Warning' },
  tip: { box: 'bg-success-bg', icon: <Lightbulb aria-hidden className="text-success" />, label: 'Tip' },
} as const;

function paragraphs(nodes: readonly HelpArticleBodyNode[] | undefined, ctx: Ctx, className?: string): ReactNode[] {
  return (nodes ?? [])
    .filter((n) => n.type === 'paragraph')
    .map((n, i) => (
      <p key={i} className={className}>
        {renderInline(n.content, ctx)}
      </p>
    ));
}

function renderImage(node: HelpArticleBodyNode, key: number, ctx: Ctx): ReactNode {
  const mediaId = typeof node.attrs?.media_id === 'string' ? node.attrs.media_id : '';
  const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : '';
  const caption = typeof node.attrs?.caption === 'string' && node.attrs.caption ? node.attrs.caption : null;
  const media = mediaId ? ctx.media[mediaId] : undefined;
  const src = media && media.status === 'ready' && isHttpUrl(media.url) ? media.url : null;
  const srcSet = media
    ? (['w640', 'w1024', 'w1600'] as const)
        .map((k) => [k, media.variants?.[k]] as const)
        .filter((e): e is readonly ['w640' | 'w1024' | 'w1600', string] => isHttpUrl(e[1]))
        .map(([k, url]) => `${url} ${k.slice(1)}w`)
        .join(', ')
    : '';
  return (
    <figure key={key} className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-lg border border-border-default bg-surface-subtle">
        {src ? (
          <img
            src={src}
            srcSet={srcSet || undefined}
            sizes={srcSet ? '(min-width: 1024px) 720px, 100vw' : undefined}
            alt={alt}
            width={media?.width ?? undefined}
            height={media?.height ?? undefined}
            loading="lazy"
            decoding="async"
            className="block h-auto w-full"
          />
        ) : (
          <div role="img" aria-label={alt || 'Image unavailable'} className="flex min-h-32 flex-col items-center justify-center gap-2 p-6 text-center text-caption text-text-muted">
            <ImageOff aria-hidden className="size-6" />
            <span>{media?.status === 'processing' ? 'Image is processing' : 'Image unavailable'}</span>
          </div>
        )}
      </div>
      {caption && <figcaption className="text-caption text-text-muted">{caption}</figcaption>}
    </figure>
  );
}

function renderBlock(node: HelpArticleBodyNode, key: number, ctx: Ctx): ReactNode {
  switch (node.type) {
    case 'paragraph':
      return (
        <p key={key} className="text-body text-text-secondary">
          {renderInline(node.content, ctx)}
        </p>
      );
    case 'heading': {
      const level = node.attrs?.level === 3 ? 3 : 2;
      const n = ctx.headingIndex.n++;
      const id = ctx.toc[n]?.id ?? helpHeadingAnchor(n + 1, plainText(node.content));
      return level === 2 ? (
        <h2 key={key} id={id} className="scroll-mt-24 pt-2 text-heading text-text-primary">
          {renderInline(node.content, ctx)}
        </h2>
      ) : (
        <h3 key={key} id={id} className="scroll-mt-24 text-body-lg font-semibold text-text-primary">
          {renderInline(node.content, ctx)}
        </h3>
      );
    }
    case 'bulletList':
      return (
        <ul key={key} className="flex list-disc flex-col gap-1.5 pl-5 text-body text-text-secondary marker:text-text-muted">
          {(node.content ?? [])
            .filter((li) => li.type === 'listItem')
            .map((li, i) => (
              <li key={i} className="[&>p+p]:mt-1">
                {paragraphs(li.content, ctx)}
              </li>
            ))}
        </ul>
      );
    case 'orderedList':
      return (
        <ol key={key} className="flex flex-col gap-3 text-body text-text-secondary">
          {(node.content ?? [])
            .filter((li) => li.type === 'listItem')
            .map((li, i) => (
              <li key={i} className="flex items-start gap-3">
                <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-600 text-caption font-semibold text-text-inverse">
                  {i + 1}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">{paragraphs(li.content, ctx)}</div>
              </li>
            ))}
        </ol>
      );
    case 'blockquote':
      return (
        <blockquote key={key} className="flex flex-col gap-1.5 border-l-[3px] border-border-strong pl-3 text-body text-text-secondary italic">
          {paragraphs(node.content, ctx)}
        </blockquote>
      );
    case 'image':
      return renderImage(node, key, ctx);
    case 'callout': {
      const tone = node.attrs?.tone === 'warning' || node.attrs?.tone === 'tip' ? node.attrs.tone : 'info';
      const t = calloutTones[tone];
      return (
        <aside key={key} aria-label={t.label} data-tone={tone} className={cn('flex gap-3 rounded-lg px-4 py-3.5 text-body text-text-primary [&_svg]:size-5', t.box)}>
          <span className="mt-px shrink-0">{t.icon}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">{paragraphs(node.content, ctx)}</div>
        </aside>
      );
    }
    default:
      return null; // unknown block: dropped (S252)
  }
}

export function HelpArticleBody({ doc, media, toc, language = 'en', renderInternalLink, className }: HelpArticleBodyProps) {
  const ctx: Ctx = {
    media: media ?? {},
    toc: toc ?? [],
    headingIndex: { n: 0 },
    renderInternalLink:
      renderInternalLink ??
      ((href, children) => (
        <a href={href} className={linkClass}>
          {children}
        </a>
      )),
  };
  const blocks = doc && doc.type === 'doc' && Array.isArray(doc.content) ? doc.content : [];
  return (
    <div lang={language} className={cn('flex flex-col gap-4 break-words', language === 'bn' && 'font-bangla', className)} data-testid="help-article-body">
      {blocks.map((b, i) => renderBlock(b, i, ctx))}
    </div>
  );
}
