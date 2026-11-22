import type { Category, ReorderCategoriesInput } from '@storeplix/types';
import { flattenTree, type TreeNode } from '@storeplix/ui';

/** 0-based max depth for the SortableTree: 2 → three levels (contract P4-8). */
export const CATEGORY_MAX_DEPTH = 2;

export interface CategoryNode extends TreeNode {
  id: string;
  category: Category;
  children?: CategoryNode[];
}

/** Flat depth-first API list → nested nodes (siblings ordered by `position`). Orphans become roots. */
export function toTree(categories: Category[]): CategoryNode[] {
  const byParent = new Map<string | null, Category[]>();
  const ids = new Set(categories.map((c) => c.id));
  for (const c of categories) {
    const key = c.parent_id && ids.has(c.parent_id) ? c.parent_id : null;
    byParent.set(key, [...(byParent.get(key) ?? []), c]);
  }
  const build = (parent: string | null): CategoryNode[] =>
    (byParent.get(parent) ?? [])
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((c) => {
        const children = build(c.id);
        return children.length ? { id: c.id, category: c, children } : { id: c.id, category: c };
      });
  return build(null);
}

/** Tree → the full `PUT /categories/order` body (every category, display order, with parent ids). */
export function toReorderInput(tree: CategoryNode[]): ReorderCategoriesInput {
  return { items: flattenTree(tree).map((f) => ({ id: f.id, parent_id: f.parentId })) };
}

/** Optimistic list after a reorder: depth/position recomputed from the tree. */
export function treeToCategories(tree: CategoryNode[]): Category[] {
  const counters = new Map<string | null, number>();
  return flattenTree(tree).map((f) => {
    const pos = counters.get(f.parentId) ?? 0;
    counters.set(f.parentId, pos + 1);
    return { ...f.node.category, parent_id: f.parentId, depth: (f.depth + 1) as Category['depth'], position: pos };
  });
}

/** Lowercase-dash slug like the API (Bangla-only names give '' → server picks `c-xxxxxx`). */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);
}
