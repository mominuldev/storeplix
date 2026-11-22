import { z } from 'zod';

/**
 * PLP / search URL state (PHASE-5-CONTRACT §5): `?page&sort&min&max&stock&q`. Prices in the URL are
 * whole taka (what the shopper typed); the API wants paisa. Invalid values are dropped, never errors.
 */

export const PLP_PER_PAGE = 24;
export const SORTS = ['bestsellers', 'latest', 'price_asc', 'price_desc'] as const;
export type CatalogSort = (typeof SORTS)[number];
export const SORT_LABELS: Record<CatalogSort, string> = {
  bestsellers: 'Most popular',
  latest: 'Newest',
  price_asc: 'Price: low to high',
  price_desc: 'Price: high to low',
};

export interface CatalogState {
  page: number;
  sort: CatalogSort;
  /** Whole taka. */
  min: number | null;
  max: number | null;
  inStock: boolean;
  q: string;
}

type RawParams = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const taka = z.coerce.number().int().min(0).max(10_000_000);

export function parseCatalogState(params: RawParams, defaultSort: CatalogSort = 'bestsellers'): CatalogState {
  const page = z.coerce.number().int().min(1).max(1000).safeParse(first(params.page));
  const sort = z.enum(SORTS).safeParse(first(params.sort));
  const min = taka.safeParse(first(params.min) || undefined);
  const max = taka.safeParse(first(params.max) || undefined);
  // eslint-disable-next-line no-control-regex
  const q = (first(params.q) ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100);
  let lo = min.success ? min.data : null;
  let hi = max.success ? max.data : null;
  if (lo !== null && hi !== null && lo > hi) [lo, hi] = [hi, lo];
  return {
    page: page.success ? page.data : 1,
    sort: sort.success ? sort.data : defaultSort,
    min: lo,
    max: hi,
    inStock: first(params.stock) === '1',
    q,
  };
}

/** API query for GET /storefront/products (paginated mode). */
export function catalogApiQuery(state: CatalogState, scope: { category?: string; q?: string }, perPage = PLP_PER_PAGE): URLSearchParams {
  const p = new URLSearchParams({ page: String(state.page), per_page: String(perPage), sort: state.sort });
  if (scope.category) p.set('category', scope.category);
  if (scope.q) p.set('q', scope.q);
  if (state.min !== null) p.set('price_min', String(state.min * 100));
  if (state.max !== null) p.set('price_max', String(state.max * 100));
  if (state.inStock) p.set('in_stock', '1');
  return p;
}

/** Page URL for a state (only non-default values are written). */
export function catalogHref(basePath: string, state: CatalogState, over: Partial<CatalogState> = {}, defaultSort: CatalogSort = 'bestsellers'): string {
  const s = { ...state, ...over };
  const p = new URLSearchParams();
  if (s.q) p.set('q', s.q);
  if (s.sort !== defaultSort) p.set('sort', s.sort);
  if (s.min !== null) p.set('min', String(s.min));
  if (s.max !== null) p.set('max', String(s.max));
  if (s.inStock) p.set('stock', '1');
  if (s.page > 1) p.set('page', String(s.page));
  const qs = p.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/** Page numbers with gaps: [1, '…', 4, 5, 6, '…', 20]. */
export function pageList(current: number, last: number): Array<number | '…'> {
  if (last <= 7) return Array.from({ length: last }, (_, i) => i + 1);
  const out: Array<number | '…'> = [1];
  const from = Math.max(2, current - 1);
  const to = Math.min(last - 1, current + 1);
  if (from > 2) out.push('…');
  for (let i = from; i <= to; i++) out.push(i);
  if (to < last - 1) out.push('…');
  out.push(last);
  return out;
}
