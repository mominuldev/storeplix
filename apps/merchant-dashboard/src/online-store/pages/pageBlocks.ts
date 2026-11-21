import type { PageBlock, StorePage } from '@storeplix/types';
import { uniqueId } from '../lib/ids';
import { isSafeButtonHref, isSafeRichTextHref, RESERVED_SLUGS, SLUG } from '../lib/safeHref';
import { emptyDoc } from '../richtext/sanitize';

// Page body blocks (contract §4.5, V1 Edit page 74:22532 block list). Client checks mirror PageBodyValidator so
// invalid content never autosaves; the API stays authoritative.

export const PAGE_LIMITS = { blocks: 40, bodyBytes: 131_072 } as const;

export const blockTypes: { type: PageBlock['type']; label: string; hint: string }[] = [
  { type: 'heading', label: 'Heading', hint: 'A section title' },
  { type: 'rich_text', label: 'Text', hint: 'Paragraphs, lists and links' },
  { type: 'image', label: 'Image', hint: 'A photo with a caption' },
  { type: 'button', label: 'Button', hint: 'Link to a page, WhatsApp or phone' },
  { type: 'callout', label: 'Callout', hint: 'A highlighted list' },
  { type: 'table', label: 'Table', hint: 'Sizes, prices or delivery charges' },
];

export function newBlock(type: PageBlock['type'], body: PageBlock[]): PageBlock {
  const id = uniqueId(new Set(body.map((b) => b.id)));
  switch (type) {
    case 'heading':
      return { id, type, text: 'New heading', level: 2 };
    case 'rich_text':
      return { id, type, doc: emptyDoc() };
    case 'image':
      return { id, type, media_id: null, alt: null, caption: null };
    case 'button':
      return { id, type, label: 'Contact us', href: '/pages/contact', style: 'primary' };
    case 'callout':
      return { id, type, title: null, items: ['Write something buyers should know'], tone: 'info' };
    case 'table':
      return { id, type, headers: ['Size', 'Chest'], rows: [['M', '38"']] };
  }
}

export function blockTitle(b: PageBlock): string {
  switch (b.type) {
    case 'heading':
      return b.text || 'Heading';
    case 'rich_text':
      return 'Text';
    case 'image':
      return b.caption || b.alt || 'Image';
    case 'button':
      return `Button · ${b.label}`;
    case 'callout':
      return b.title || 'Callout';
    case 'table':
      return `Table · ${b.headers.join(', ')}`;
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function walkLinks(node: unknown, visit: (href: string) => void) {
  if (!node || typeof node !== 'object') return;
  const n = node as { marks?: { type: string; attrs?: { href?: string } }[]; content?: unknown[] };
  for (const m of n.marks ?? []) if (m.type === 'link') visit(m.attrs?.href ?? '');
  for (const c of n.content ?? []) walkLinks(c, visit);
}

/** Returns `{ "body.2.href": "…" }` style errors (API dot paths); `{}` when valid. */
export function validatePageBody(body: PageBlock[]): Record<string, string> {
  const errors: Record<string, string> = {};
  if (body.length > PAGE_LIMITS.blocks) errors.body = `A page can have up to ${PAGE_LIMITS.blocks} blocks.`;
  if (new TextEncoder().encode(JSON.stringify(body)).length > PAGE_LIMITS.bodyBytes) errors.body = 'This page is too long to save. Split it into two pages.';
  body.forEach((b, i) => {
    const p = `body.${i}`;
    const text = (key: string, v: string | null, max: number, required = false) => {
      if (required && !v?.trim()) errors[`${p}.${key}`] = 'This is required.';
      else if (v && v.length > max) errors[`${p}.${key}`] = `Use at most ${max} characters.`;
      else if (v && CONTROL.test(v)) errors[`${p}.${key}`] = 'This contains characters that aren’t allowed.';
    };
    switch (b.type) {
      case 'heading':
        text('text', b.text, 120, true);
        break;
      case 'rich_text':
        walkLinks(b.doc, (href) => {
          if (!isSafeRichTextHref(href)) errors[`${p}.doc`] = 'One of the links isn’t allowed. Use /page, https://, mailto: or tel: links.';
        });
        break;
      case 'image':
        text('alt', b.alt, 160);
        text('caption', b.caption, 200);
        break;
      case 'button':
        text('label', b.label, 40, true);
        if (!isSafeButtonHref(b.href)) errors[`${p}.href`] = 'Use a link starting with /, https:// (e.g. https://wa.me/880…) or tel:';
        break;
      case 'callout':
        text('title', b.title, 80);
        if (b.items.length < 1 || b.items.length > 8) errors[`${p}.items`] = 'Use 1 to 8 lines.';
        else if (b.items.some((x) => !x.trim() || x.length > 200)) errors[`${p}.items`] = 'Each line needs 1–200 characters.';
        break;
      case 'table':
        if (b.headers.length < 1 || b.headers.length > 6 || b.headers.some((h) => h.length > 60)) errors[`${p}.headers`] = 'Use 1 to 6 columns, each up to 60 characters.';
        if (b.rows.length < 1 || b.rows.length > 50) errors[`${p}.rows`] = 'Use 1 to 50 rows.';
        else if (b.rows.some((r) => r.length !== b.headers.length)) errors[`${p}.rows`] = 'Every row needs one value per column.';
        else if (b.rows.some((r) => r.some((c) => c.length > 200))) errors[`${p}.rows`] = 'Each cell can be up to 200 characters.';
        break;
    }
  });
  return errors;
}

export function slugError(slug: string, otherSlugs: string[] = []): string | null {
  if (!slug) return 'Add a link for this page.';
  if (slug.length > 80 || !SLUG.test(slug)) return 'Use lowercase letters, numbers and single hyphens.';
  if (RESERVED_SLUGS.has(slug)) return 'This link is reserved. Try another one.';
  if (otherSlugs.includes(slug)) return 'This link is already used by another page.';
  return null;
}

/** Fields a PATCH sends from an edited page (body + meta), with the revision it was based on. */
export function pagePatch(page: Pick<StorePage, 'title' | 'slug' | 'body' | 'seo'>, revision: number) {
  return {
    revision,
    title: page.title,
    slug: page.slug,
    body: page.body,
    seo: { title: page.seo.title, description: page.seo.description, share_image_media_id: page.seo.share_image?.id ?? null },
  };
}
