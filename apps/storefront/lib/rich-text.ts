import type { RichTextBlock, RichTextDoc, RichTextInline, RichTextMark, RichTextParagraph } from '@storeplix/types';
import { sanitizeRichTextHref } from './sanitize';

/**
 * Normalise untrusted RichTextDoc JSON (PHASE-3-CONTRACT §4.4) into a doc that contains only known
 * nodes, marks and safe links. Unknown nodes/marks are dropped, unsafe link marks are removed (the
 * text stays), and `dropped` reports whether anything was removed. Never throws.
 */
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const LIMITS = { blocks: 100, inline: 2000, listItems: 50, itemParagraphs: 5, quoteParagraphs: 10, marks: 5 };
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const SIMPLE_MARKS = new Set(['bold', 'italic', 'underline', 'strike']);

export function normalizeRichText(input: unknown): { doc: RichTextDoc; dropped: boolean } {
  let dropped = false;
  const drop = <T>(): T[] => {
    dropped = true;
    return [];
  };

  const marks = (v: unknown): RichTextMark[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) return drop();
    const out = v.slice(0, LIMITS.marks).flatMap((m): RichTextMark[] => {
      if (!isObject(m) || typeof m.type !== 'string') return drop();
      if (SIMPLE_MARKS.has(m.type)) return [{ type: m.type as 'bold' }];
      if (m.type === 'link' && isObject(m.attrs)) {
        const href = sanitizeRichTextHref(m.attrs.href);
        if (href) return [{ type: 'link', attrs: { href } }];
      }
      return drop();
    });
    if (v.length > LIMITS.marks) dropped = true;
    return out;
  };

  const inline = (v: unknown): RichTextInline[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) return drop();
    if (v.length > LIMITS.inline) dropped = true;
    return v.slice(0, LIMITS.inline).flatMap((n): RichTextInline[] => {
      if (!isObject(n)) return drop();
      if (n.type === 'hardBreak') return [{ type: 'hardBreak' }];
      if (n.type === 'text') {
        // Not trimmed: spaces between marked runs matter.
        const text = typeof n.text === 'string' && n.text.length > 0 && [...n.text].length <= 5000 && !CONTROL.test(n.text) ? n.text : undefined;
        if (!text) return drop();
        const m = marks(n.marks);
        return [m && m.length ? { type: 'text', text, marks: m } : { type: 'text', text }];
      }
      return drop();
    });
  };

  const paragraph = (n: unknown): RichTextParagraph[] => {
    if (!isObject(n) || n.type !== 'paragraph') return drop();
    const content = inline(n.content);
    return [content ? { type: 'paragraph', content } : { type: 'paragraph' }];
  };

  const paragraphs = (v: unknown, max: number): RichTextParagraph[] => {
    if (!Array.isArray(v)) return drop();
    if (v.length > max) dropped = true;
    return v.slice(0, max).flatMap(paragraph);
  };

  const block = (n: unknown): RichTextBlock[] => {
    if (!isObject(n)) return drop();
    switch (n.type) {
      case 'paragraph':
        return paragraph(n);
      case 'heading': {
        const level = isObject(n.attrs) ? n.attrs.level : undefined;
        if (level !== 2 && level !== 3) return drop();
        const content = inline(n.content);
        return [content ? { type: 'heading', attrs: { level }, content } : { type: 'heading', attrs: { level } }];
      }
      case 'bulletList':
      case 'orderedList': {
        if (!Array.isArray(n.content)) return drop();
        if (n.content.length > LIMITS.listItems) dropped = true;
        const items = n.content.slice(0, LIMITS.listItems).flatMap((li) => {
          if (!isObject(li) || li.type !== 'listItem') return drop<{ type: 'listItem'; content: RichTextParagraph[] }>();
          const content = paragraphs(li.content, LIMITS.itemParagraphs);
          return content.length ? [{ type: 'listItem' as const, content }] : drop<{ type: 'listItem'; content: RichTextParagraph[] }>();
        });
        return items.length ? [{ type: n.type, content: items }] : drop();
      }
      case 'blockquote': {
        const content = paragraphs(n.content, LIMITS.quoteParagraphs);
        return content.length ? [{ type: 'blockquote', content }] : drop();
      }
      default:
        return drop();
    }
  };

  if (!isObject(input) || input.type !== 'doc' || !Array.isArray(input.content)) {
    return { doc: { type: 'doc', content: [] }, dropped: input !== undefined };
  }
  if (input.content.length > LIMITS.blocks) dropped = true;
  const content = input.content.slice(0, LIMITS.blocks).flatMap(block);
  return { doc: { type: 'doc', content }, dropped };
}
