import type { RichTextBlock, RichTextDoc, RichTextInline, RichTextMark, RichTextParagraph } from '@storeplix/types';
import { isSafeRichTextHref } from '../lib/safeHref';

// Contract §4.4: the dashboard strips anything outside the RichTextDoc subset before sending. Tiptap only has
// these extensions enabled, but pasted content and older drafts still pass through here.

type Json = { type?: unknown; text?: unknown; attrs?: Record<string, unknown>; marks?: unknown; content?: unknown };
const asNodes = (v: unknown): Json[] => (Array.isArray(v) ? (v.filter((n) => n && typeof n === 'object') as Json[]) : []);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
const SIMPLE_MARKS = new Set(['bold', 'italic', 'underline', 'strike']);

function marksOf(raw: unknown): RichTextMark[] | undefined {
  const out: RichTextMark[] = [];
  for (const m of asNodes(raw)) {
    if (typeof m.type === 'string' && SIMPLE_MARKS.has(m.type)) out.push({ type: m.type as 'bold' });
    else if (m.type === 'link' && typeof m.attrs?.href === 'string' && isSafeRichTextHref(m.attrs.href.trim())) out.push({ type: 'link', attrs: { href: m.attrs.href.trim() } });
  }
  return out.length ? out : undefined;
}

function inlines(raw: unknown): RichTextInline[] {
  const out: RichTextInline[] = [];
  for (const n of asNodes(raw)) {
    if (n.type === 'hardBreak') out.push({ type: 'hardBreak' });
    else if (n.type === 'text' && typeof n.text === 'string') {
      const text = n.text.replace(CONTROL, ' ').slice(0, 5000);
      if (!text) continue;
      const marks = marksOf(n.marks);
      out.push(marks ? { type: 'text', text, marks } : { type: 'text', text });
    } else if (n.content) out.push(...inlines(n.content)); // unknown inline wrapper → keep its text
  }
  return out;
}

function paragraph(n: Json): RichTextParagraph {
  const content = inlines(n.content);
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
}

/** Flattens any block (including nested lists) into paragraphs. */
function paragraphsOf(n: Json): RichTextParagraph[] {
  if (n.type === 'paragraph' || n.type === 'heading') return [paragraph(n)];
  if (asNodes(n.content).some((c) => c.type === 'text' || c.type === 'hardBreak')) return [paragraph(n)];
  return asNodes(n.content).flatMap(paragraphsOf);
}

function block(n: Json): RichTextBlock[] {
  switch (n.type) {
    case 'paragraph':
      return [paragraph(n)];
    case 'heading': {
      const level = Number(n.attrs?.level) <= 2 ? 2 : 3;
      const content = inlines(n.content);
      return [content.length ? { type: 'heading', attrs: { level }, content } : { type: 'heading', attrs: { level } }];
    }
    case 'bulletList':
    case 'orderedList': {
      const items = asNodes(n.content)
        .slice(0, 50)
        .map((li) => ({ type: 'listItem' as const, content: paragraphsOf(li).slice(0, 5) }))
        .filter((li) => li.content.length > 0);
      return items.length ? [{ type: n.type, content: items }] : [];
    }
    case 'blockquote': {
      const content = paragraphsOf(n).slice(0, 10);
      return content.length ? [{ type: 'blockquote', content }] : [];
    }
    default:
      // Unknown block (code block, image, table, html…) → keep only its text as paragraphs.
      return paragraphsOf(n).filter((p) => p.content?.length);
  }
}

export function sanitizeRichText(raw: unknown): RichTextDoc {
  const doc = (raw && typeof raw === 'object' ? raw : {}) as Json;
  return { type: 'doc', content: asNodes(doc.content).flatMap(block).slice(0, 100) };
}

export const emptyDoc = (): RichTextDoc => ({ type: 'doc', content: [{ type: 'paragraph' }] });

/** Plain text of a doc (list summaries, counters). */
export function richTextToPlain(doc: RichTextDoc | null | undefined): string {
  const walk = (nodes: unknown): string =>
    asNodes(nodes)
      .map((n) => (n.type === 'text' ? String(n.text ?? '') : n.type === 'hardBreak' ? ' ' : walk(n.content)))
      .join(n_sep(nodes));
  const n_sep = (nodes: unknown) => (asNodes(nodes).some((n) => n.type === 'text') ? '' : ' ');
  return walk(doc?.content).replace(/\s+/g, ' ').trim();
}
