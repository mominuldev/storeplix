import { z } from 'zod';
import type { PageStatus, StorefrontMedia, StorefrontNavItem, StorefrontNavMenu } from '@storeplix/types';
import { sanitizeImageUrl, sanitizeMediaId, sanitizeNavHref } from './sanitize';
import { cleanText } from './text';
import { parsePageBlocks, type SafePageBlock } from './page-blocks';

/**
 * Boundary parsers for the Phase 3 additions to the storefront payloads. Pure (no server-only) so
 * they are unit-testable. Every parser drops what it can't trust instead of failing the payload, so a
 * bad stored value never takes the storefront down.
 */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---------- media ----------
const MAX_MEDIA = 200;

function parseMedia(id: string, v: unknown): StorefrontMedia | null {
  if (!isObject(v)) return null;
  const url = sanitizeImageUrl(v.url);
  const width = typeof v.width === 'number' && v.width > 0 && v.width <= 20000 ? Math.round(v.width) : null;
  const height = typeof v.height === 'number' && v.height > 0 && v.height <= 20000 ? Math.round(v.height) : null;
  if (!url || !width || !height) return null;
  const srcset = Array.isArray(v.srcset)
    ? v.srcset.slice(0, 12).flatMap((s) => {
        if (!isObject(s)) return [];
        const u = sanitizeImageUrl(s.url);
        return u && typeof s.width === 'number' && s.width > 0 ? [{ url: u, width: Math.round(s.width) }] : [];
      })
    : [];
  return { id, url, width, height, alt: cleanText(v.alt, 500) ?? null, srcset };
}

/** `{id → StorefrontMedia}`; invalid entries are dropped (the section then shows its demo image). */
export function parseMediaMap(v: unknown): Record<string, StorefrontMedia> {
  if (!isObject(v)) return {};
  const out: Record<string, StorefrontMedia> = {};
  for (const [rawId, entry] of Object.entries(v).slice(0, MAX_MEDIA)) {
    const id = sanitizeMediaId(rawId);
    const media = id ? parseMedia(id, entry) : null;
    if (id && media) out[id] = media;
  }
  return out;
}

// ---------- navigation ----------
const MAX_TOP = 20;
const MAX_CHILDREN = 20;

function parseNavItems(v: unknown, depth: number): StorefrontNavItem[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, depth === 1 ? MAX_TOP : MAX_CHILDREN).flatMap((item, i): StorefrontNavItem[] => {
    if (!isObject(item)) return [];
    const label = cleanText(item.label, 40, 1);
    const href = sanitizeNavHref(item.href);
    if (!label || !href) return [];
    const id = typeof item.id === 'string' && /^[a-z0-9]{1,32}$/.test(item.id) ? item.id : `item${depth}${i}`;
    // Menus are at most two levels deep; anything deeper is ignored.
    return [{ id, label, href, children: depth < 2 ? parseNavItems(item.children, depth + 1) : [] }];
  });
}

function parseMenu(v: unknown, fallbackTitle: string): StorefrontNavMenu {
  if (!isObject(v)) return { title: fallbackTitle, items: [] };
  return { title: cleanText(v.title, 40, 1) ?? fallbackTitle, items: parseNavItems(v.items, 1) };
}

export interface StorefrontNavigation {
  main: StorefrontNavMenu;
  footer: StorefrontNavMenu;
  help: StorefrontNavMenu;
}

/** Optional on the wire (rolling deploys): missing → three empty menus. */
export function parseNavigation(v: unknown): StorefrontNavigation {
  const o = isObject(v) ? v : {};
  return { main: parseMenu(o.main, 'Main menu'), footer: parseMenu(o.footer, 'Shop'), help: parseMenu(o.help, 'Help') };
}

// ---------- pages ----------
export const PAGE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const isPageSlug = (slug: unknown): slug is string => typeof slug === 'string' && slug.length <= 80 && PAGE_SLUG_RE.test(slug);

const isoDate = z
  .string()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)));

export interface SafeStorefrontPage {
  id: string;
  slug: string;
  title: string;
  status: PageStatus;
  body: SafePageBlock[];
  media: Record<string, StorefrontMedia>;
  seo: { title: string | null; description: string | null; og_image_url: string | null };
  updated_at: string | null;
}

/** A page from `/storefront/pages/{slug}`, or null when the payload is unusable. */
export function parseStorefrontPage(v: unknown): SafeStorefrontPage | null {
  if (!isObject(v)) return null;
  const title = cleanText(v.title, 120, 1);
  if (!isPageSlug(v.slug) || !title || typeof v.id !== 'string' || v.id.length > 64) return null;
  const seo = isObject(v.seo) ? v.seo : {};
  const status = v.status === 'published' || v.status === 'hidden' || v.status === 'draft' ? v.status : 'draft';
  return {
    id: v.id,
    slug: v.slug,
    title,
    status,
    body: parsePageBlocks(v.body),
    media: parseMediaMap(v.media),
    seo: {
      title: cleanText(seo.title, 70, 1) ?? null,
      description: cleanText(seo.description, 160, 1) ?? null,
      og_image_url: sanitizeImageUrl(seo.og_image_url),
    },
    updated_at: isoDate.safeParse(v.updated_at).success ? (v.updated_at as string) : null,
  };
}

/** `/storefront/pages` (sitemap): published pages only; invalid entries dropped. */
export function parsePageIndex(v: unknown): Array<{ slug: string; updated_at: string | null }> {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 50).flatMap((e) => {
    if (!isObject(e) || !isPageSlug(e.slug)) return [];
    return [{ slug: e.slug, updated_at: isoDate.safeParse(e.updated_at).success ? (e.updated_at as string) : null }];
  });
}
