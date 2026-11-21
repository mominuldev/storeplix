import type { RichTextDoc } from '@storeplix/types';
import { normalizeRichText } from './rich-text';
import { sanitizeHref, sanitizeMediaId } from './sanitize';
import { whatsappHref } from './contact';
import { cleanText } from './text';

/**
 * Page body blocks (PHASE-3-CONTRACT §4.5), parsed defensively: an invalid block is dropped, never
 * rendered half-trusted. Output is safe to render with React elements.
 */
export type SafePageBlock =
  | { id: string; type: 'heading'; text: string; level: 2 | 3 }
  | { id: string; type: 'rich_text'; doc: RichTextDoc }
  | { id: string; type: 'image'; media_id: string | null; alt: string | null; caption: string | null }
  | { id: string; type: 'button'; label: string; href: string; style: 'primary' | 'secondary' }
  | { id: string; type: 'callout'; title: string | null; items: string[]; tone: 'info' | 'success' | 'warning' }
  | { id: string; type: 'table'; headers: string[]; rows: string[][] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const ID_RE = /^[a-z0-9]{8,16}$/;
const MAX_BLOCKS = 40;

/** Button href: theme href rule, or `https://wa.me/<digits>` / strict `tel:`. */
export function pageButtonHref(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (v.startsWith('tel:')) return /^tel:\+?[0-9]{7,15}$/.test(v) ? v : null;
  if (v.startsWith('https://wa.me/')) return whatsappHref(v.slice('https://wa.me/'.length)) === v ? v : null;
  return sanitizeHref(v);
}

const strings = (v: unknown, min: number, max: number, maxLen: number): string[] | null => {
  if (!Array.isArray(v) || v.length < min || v.length > max) return null;
  const out = v.map((s) => cleanText(s, maxLen));
  return out.every((s): s is string => s !== undefined) ? out : null;
};

function parseBlock(b: unknown, index: number, seen: Set<string>): SafePageBlock | null {
  if (!isObject(b) || typeof b.type !== 'string') return null;
  let id = typeof b.id === 'string' && ID_RE.test(b.id) ? b.id : `block${index}`;
  if (seen.has(id)) id = `${id}-${index}`;
  seen.add(id);

  switch (b.type) {
    case 'heading': {
      const text = cleanText(b.text, 120, 1);
      return text && (b.level === 2 || b.level === 3) ? { id, type: 'heading', text, level: b.level } : null;
    }
    case 'rich_text':
      return { id, type: 'rich_text', doc: normalizeRichText(b.doc).doc };
    case 'image': {
      const media_id = b.media_id === null ? null : sanitizeMediaId(b.media_id);
      return { id, type: 'image', media_id, alt: cleanText(b.alt, 160) ?? null, caption: cleanText(b.caption, 200) ?? null };
    }
    case 'button': {
      const label = cleanText(b.label, 40, 1);
      const href = pageButtonHref(b.href);
      return label && href ? { id, type: 'button', label, href, style: b.style === 'secondary' ? 'secondary' : 'primary' } : null;
    }
    case 'callout': {
      const items = strings(b.items, 1, 8, 200);
      if (!items) return null;
      const tone = b.tone === 'success' || b.tone === 'warning' ? b.tone : 'info';
      return { id, type: 'callout', title: cleanText(b.title, 80, 1) ?? null, items, tone };
    }
    case 'table': {
      const headers = strings(b.headers, 1, 6, 60);
      if (!headers || !Array.isArray(b.rows) || b.rows.length < 1 || b.rows.length > 50) return null;
      const rows = b.rows.map((r) => strings(r, headers.length, headers.length, 200));
      return rows.every((r): r is string[] => r !== null) ? { id, type: 'table', headers, rows } : null;
    }
    default:
      return null;
  }
}

export function parsePageBlocks(v: unknown): SafePageBlock[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  return v.slice(0, MAX_BLOCKS).flatMap((b, i) => {
    const block = parseBlock(b, i, seen);
    return block ? [block] : [];
  });
}
