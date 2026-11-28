import type {
  HelpArticleBlock,
  HelpArticleDoc,
  HelpCalloutTone,
  HelpTranslationInput,
  RichTextInline,
  RichTextMark,
  RichTextParagraph,
} from '@storeplix/types';
import { HELP_LIMITS } from '@storeplix/types';

// PHASE-8-9C P89C-5: the editor only ever produces `HelpArticleDoc` JSON (RichTextDoc subset + `image` + `callout`).
// Everything Tiptap or a paste hands us passes through `toHelpDoc` before it reaches the draft; the API's
// `HelpArticleDocValidator` is authoritative, these rules mirror it for instant feedback.

// eslint-disable-next-line no-control-regex
const CONTROL_TEST = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
const WHITESPACE = /\s/;
const MAILTO = /^mailto:[^\s@?/\\:]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const TEL = /^tel:\+?[0-9]{7,15}$/;

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isRelative(v: string): boolean {
  return v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') && !CONTROL_TEST.test(v) && !WHITESPACE.test(v);
}

function isAbsolute(v: string): boolean {
  if (CONTROL_TEST.test(v) || WHITESPACE.test(v) || v.includes('\\')) return false;
  if (!/^https?:\/\//i.test(v)) return false;
  try {
    const url = new URL(v);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** `SafeHref::richText` (relative, http(s), strict mailto, tel) — relative covers `/help/articles/{slug}`. */
export function isSafeHelpHref(value: string): boolean {
  if (!value || value.length > 2048) return false;
  const ok = (v: string) => isRelative(v) || isAbsolute(v) || MAILTO.test(v) || TEL.test(v);
  return ok(value) && ok(decoded(value));
}

export const CALLOUT_TONES: readonly HelpCalloutTone[] = ['info', 'warning', 'tip'];
export const CALLOUT_LABELS: Record<HelpCalloutTone, string> = { info: 'Info', warning: 'Warning', tip: 'Tip' };

type Json = { type?: unknown; text?: unknown; attrs?: Record<string, unknown>; marks?: unknown; content?: unknown };
const asNodes = (v: unknown): Json[] => (Array.isArray(v) ? (v.filter((n) => n && typeof n === 'object') as Json[]) : []);
const SIMPLE_MARKS = new Set(['bold', 'italic', 'underline', 'strike']);
const MARK_ORDER = ['link', 'bold', 'italic', 'underline', 'strike'];

function marksOf(raw: unknown): RichTextMark[] | undefined {
  const out: RichTextMark[] = [];
  for (const m of asNodes(raw)) {
    if (typeof m.type === 'string' && SIMPLE_MARKS.has(m.type)) {
      if (!out.some((o) => o.type === m.type)) out.push({ type: m.type as 'bold' });
    } else if (m.type === 'link' && typeof m.attrs?.href === 'string' && isSafeHelpHref(m.attrs.href.trim())) {
      if (!out.some((o) => o.type === 'link')) out.push({ type: 'link', attrs: { href: m.attrs.href.trim() } });
    }
  }
  out.sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
  return out.length ? out : undefined;
}

const sameMarks = (a?: RichTextMark[], b?: RichTextMark[]) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/** Inline nodes with adjacent same-mark text merged (keeps Markdown round trips stable). */
export function normalizeInlines(nodes: RichTextInline[]): RichTextInline[] {
  const out: RichTextInline[] = [];
  for (const n of nodes) {
    const prev = out.at(-1);
    if (n.type === 'text' && prev?.type === 'text' && sameMarks(prev.marks, n.marks)) {
      out[out.length - 1] = { ...prev, text: prev.text + n.text };
    } else out.push(n);
  }
  return out;
}

function inlines(raw: unknown): RichTextInline[] {
  const out: RichTextInline[] = [];
  for (const n of asNodes(raw)) {
    if (n.type === 'hardBreak') out.push({ type: 'hardBreak' });
    else if (n.type === 'text' && typeof n.text === 'string') {
      const text = n.text.replace(CONTROL, ' ');
      if (!text) continue;
      const marks = marksOf(n.marks);
      out.push(marks ? { type: 'text', text, marks } : { type: 'text', text });
    } else if (n.content) out.push(...inlines(n.content));
  }
  return normalizeInlines(out);
}

function paragraph(n: Json): RichTextParagraph {
  const content = inlines(n.content);
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
}

function paragraphsOf(n: Json): RichTextParagraph[] {
  if (n.type === 'paragraph' || n.type === 'heading') return [paragraph(n)];
  if (asNodes(n.content).some((c) => c.type === 'text' || c.type === 'hardBreak')) return [paragraph(n)];
  return asNodes(n.content).flatMap(paragraphsOf);
}

function block(n: Json): HelpArticleBlock[] {
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
        .map((li) => ({ type: 'listItem' as const, content: paragraphsOf(li) }))
        .filter((li) => li.content.length > 0);
      return items.length ? [{ type: n.type, content: items }] : [];
    }
    case 'blockquote': {
      const content = paragraphsOf(n);
      return content.length ? [{ type: 'blockquote', content }] : [];
    }
    case 'callout': {
      const tone = CALLOUT_TONES.find((t) => t === n.attrs?.tone) ?? 'info';
      const content = paragraphsOf(n);
      return [{ type: 'callout', attrs: { tone }, content: content.length ? content : [{ type: 'paragraph' }] }];
    }
    case 'image': {
      const mediaId = typeof n.attrs?.media_id === 'string' ? n.attrs.media_id : '';
      if (!mediaId) return [];
      const alt = typeof n.attrs?.alt === 'string' ? n.attrs.alt.replace(CONTROL, ' ').trim().slice(0, HELP_LIMITS.imageAlt) : '';
      const caption = typeof n.attrs?.caption === 'string' ? n.attrs.caption.replace(CONTROL, ' ').trim() : '';
      return [{ type: 'image', attrs: caption ? { media_id: mediaId, alt, caption } : { media_id: mediaId, alt } }];
    }
    default:
      // Unknown block (code block, table, embed…) → keep only its text.
      return paragraphsOf(n).filter((p) => p.content?.length);
  }
}

/** Strips anything outside the HelpArticleDoc subset (Tiptap JSON, pasted content, older drafts). */
export function toHelpDoc(raw: unknown): HelpArticleDoc {
  const doc = (raw && typeof raw === 'object' ? raw : {}) as Json;
  return { type: 'doc', content: asNodes(doc.content).flatMap(block) };
}

export const emptyHelpDoc = (): HelpArticleDoc => ({ type: 'doc', content: [] });

/** Tiptap needs at least one block to place the caret. */
export const editableDoc = (doc: HelpArticleDoc | null | undefined): HelpArticleDoc =>
  doc && doc.content.length ? doc : { type: 'doc', content: [{ type: 'paragraph' }] };

function inlineText(nodes: RichTextInline[] | undefined): string {
  return (nodes ?? []).map((n) => (n.type === 'text' ? n.text : ' ')).join('');
}

/** Plain text of a doc (word count, read time). */
export function docText(doc: HelpArticleDoc): string {
  const parts: string[] = [];
  for (const b of doc.content) {
    switch (b.type) {
      case 'paragraph':
      case 'heading':
        parts.push(inlineText(b.content));
        break;
      case 'bulletList':
      case 'orderedList':
        b.content.forEach((li) => li.content.forEach((p) => parts.push(inlineText(p.content))));
        break;
      case 'blockquote':
      case 'callout':
        b.content.forEach((p) => parts.push(inlineText(p.content)));
        break;
      case 'image':
        if (b.attrs.caption) parts.push(b.attrs.caption);
        break;
    }
  }
  return parts.join('\n');
}

/** True when the doc has no visible content (an empty paragraph counts as empty). */
export function isDocEmpty(doc: HelpArticleDoc): boolean {
  return !doc.content.some((b) => b.type === 'image' || b.type === 'callout' || (b.type === 'paragraph' ? !!b.content?.length : true));
}

/** Words + read time (⌈words / 200⌉, min 1) — mirrors the server's count. */
export function wordStats(doc: HelpArticleDoc): { words: number; minutes: number } {
  const words = docText(doc).split(/\s+/).filter(Boolean).length;
  return { words, minutes: Math.max(1, Math.ceil(words / 200)) };
}

/** Client checks the API would reject (200 blocks, 64 KB, image alt). */
export function docProblems(doc: HelpArticleDoc): string[] {
  const problems: string[] = [];
  if (doc.content.length > HELP_LIMITS.blocks) problems.push(`Keep the article under ${HELP_LIMITS.blocks} blocks.`);
  if (new TextEncoder().encode(JSON.stringify(doc)).length > HELP_LIMITS.bodyBytes) problems.push('The article is too long (64 KB max). Split it into two guides.');
  const missingAlt = doc.content.filter((b) => b.type === 'image' && !b.attrs.alt.trim()).length;
  if (missingAlt) problems.push(missingAlt === 1 ? 'An image needs alt text.' : `${missingAlt} images need alt text.`);
  return problems;
}

/** Image ids referenced by a doc. */
export function docMediaIds(doc: HelpArticleDoc): string[] {
  return doc.content.flatMap((b) => (b.type === 'image' ? [b.attrs.media_id] : []));
}

/** Kebab slug from a title (Bangla-only titles → empty; staff type one). */
export function slugify(input: string, max: number = HELP_LIMITS.slug): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

/** Title, summary and ≥ 1 body block (P89C-23). */
export function missingFields(t: HelpTranslationInput | null): ('title' | 'summary' | 'body')[] {
  if (!t) return ['title', 'summary', 'body'];
  const out: ('title' | 'summary' | 'body')[] = [];
  if (!t.title.trim()) out.push('title');
  if (!t.summary.trim()) out.push('summary');
  if (isDocEmpty(t.body)) out.push('body');
  return out;
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const HELP_IMAGE_ACCEPT = IMAGE_TYPES.join(',');

/** Client pre-check for help images (the API sniffs and re-encodes, P89C-6). */
export function imageFileProblem(file: File): string | null {
  if (!IMAGE_TYPES.includes(file.type)) return 'Use a PNG, JPG or WebP image.';
  if (file.size > HELP_LIMITS.imageBytes) return 'Images can be up to 5 MB.';
  return null;
}
