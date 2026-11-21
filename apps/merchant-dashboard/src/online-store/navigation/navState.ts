import type { NavItem, NavItemResolved, NavLink } from '@storeplix/types';
import { uniqueId } from '../lib/ids';
import { isSafeNavUrl, SLUG } from '../lib/safeHref';

// Navigation rules (contract §3.3, P3-16): ≤ 60 items, ≤ 20 top-level, ≤ 20 children each, depth ≤ 2,
// label 1–40 chars, link validated per type.

export const NAV_LIMITS = { total: 60, top: 20, children: 20, maxDepth: 2 } as const;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Strips server-resolved fields so the tree can be PUT back. */
export function toNavItems(items: NavItemResolved[]): NavItem[] {
  return items.map(({ id, label, link, children }) => ({ id, label, link, ...(children?.length ? { children: toNavItems(children) } : {}) }));
}

export function countItems(items: NavItem[]): number {
  return items.reduce((n, i) => n + 1 + countItems(i.children ?? []), 0);
}

function allIds(items: NavItem[], out = new Set<string>()): Set<string> {
  for (const i of items) {
    out.add(i.id);
    allIds(i.children ?? [], out);
  }
  return out;
}

export function newNavItem(items: NavItem[], label: string, link: NavLink): NavItem {
  return { id: uniqueId(allIds(items)), label, link };
}

export function linkError(link: NavLink): string | null {
  switch (link.type) {
    case 'home':
      return null;
    case 'page':
      return link.page_id ? null : 'Pick a page.';
    case 'url':
      return isSafeNavUrl(link.url.trim()) ? null : 'Use a full web address starting with http:// or https://';
    case 'collection':
      return SLUG.test(link.handle) && link.handle.length <= 80 ? null : 'Use the collection’s link name, e.g. winter-sale';
    case 'builtin':
      return ['track_order', 'cart', 'search'].includes(link.target) ? null : 'Pick a shop page.';
  }
}

export function labelError(label: string): string | null {
  const v = label.trim();
  if (!v) return 'Give the link a name.';
  if (v.length > 40) return 'Use at most 40 characters.';
  if (CONTROL.test(v)) return 'This contains characters that aren’t allowed.';
  return null;
}

/** Whole-menu check before saving; returns the first problem or null. */
export function menuError(items: NavItem[]): string | null {
  if (items.length > NAV_LIMITS.top) return `A menu can have up to ${NAV_LIMITS.top} top-level links.`;
  if (countItems(items) > NAV_LIMITS.total) return `A menu can have up to ${NAV_LIMITS.total} links.`;
  for (const i of items) {
    if ((i.children?.length ?? 0) > NAV_LIMITS.children) return `A link can have up to ${NAV_LIMITS.children} links under it.`;
    if (i.children?.some((c) => c.children?.length)) return 'Menus can only be two levels deep.';
    for (const x of [i, ...(i.children ?? [])]) {
      const e = labelError(x.label) ?? linkError(x.link);
      if (e) return `“${x.label || 'Untitled'}”: ${e}`;
    }
  }
  return null;
}

export function containsPage(items: NavItem[], pageId: string): boolean {
  return items.some((i) => (i.link.type === 'page' && i.link.page_id === pageId) || containsPage(i.children ?? [], pageId));
}

export function addPage(items: NavItem[], pageId: string, label: string): NavItem[] {
  if (containsPage(items, pageId)) return items;
  return [...items, newNavItem(items, label.slice(0, 40), { type: 'page', page_id: pageId })];
}

export function removePage(items: NavItem[], pageId: string): NavItem[] {
  return items
    .filter((i) => !(i.link.type === 'page' && i.link.page_id === pageId))
    .map((i) => (i.children ? { ...i, children: removePage(i.children, pageId) } : i));
}

export function updateItem(items: NavItem[], id: string, patch: Partial<NavItem>): NavItem[] {
  return items.map((i) => (i.id === id ? { ...i, ...patch } : i.children ? { ...i, children: updateItem(i.children, id, patch) } : i));
}

export function removeItem(items: NavItem[], id: string): NavItem[] {
  return items.filter((i) => i.id !== id).map((i) => (i.children ? { ...i, children: removeItem(i.children, id) } : i));
}

/** Moves a child up to the top level, right after its parent. */
export function unnest(items: NavItem[], id: string): NavItem[] {
  const out: NavItem[] = [];
  for (const i of items) {
    const child = i.children?.find((c) => c.id === id);
    if (child) {
      out.push({ ...i, children: i.children!.filter((c) => c.id !== id) }, child);
    } else out.push(i);
  }
  return out;
}

/** Nests a top-level item (without children) under the item above it. */
export function nestUnderPrevious(items: NavItem[], id: string): NavItem[] {
  const index = items.findIndex((i) => i.id === id);
  const item = items[index];
  const parent = items[index - 1];
  if (!item || !parent || item.children?.length || (parent.children?.length ?? 0) >= NAV_LIMITS.children) return items;
  const next = items.filter((i) => i.id !== id);
  return next.map((i) => (i.id === parent.id ? { ...i, children: [...(i.children ?? []), item] } : i));
}

export function describeLink(link: NavLink, pageTitle?: string | null): string {
  switch (link.type) {
    case 'home':
      return 'Home page';
    case 'page':
      return `Page · ${pageTitle ?? 'Page'}`;
    case 'url':
      return `Web address · ${link.url}`;
    case 'collection':
      return `Collection · ${link.handle}`;
    case 'builtin':
      return `Built-in · ${{ track_order: 'Track order', cart: 'Cart', search: 'Search' }[link.target]}`;
  }
}
