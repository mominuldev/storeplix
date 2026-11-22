import 'server-only';
import { cache } from 'react';
import type { StorefrontMedia, StorefrontProductCard } from '@storeplix/types';
import { buildProductFeedRequest, type ProductFeedQuery } from './config-request';
import { serverEnv } from './env';
import { getPreviewToken } from './preview';
import { isAllowedMediaOrigin } from './media';
import { parseProductFeed, type ProductFeed } from './storefront-schemas';

/**
 * Product data for the home sections (contract §8). Real products come from
 * GET /api/v1/storefront/products; a store without feed-eligible products (or a failing feed) shows
 * PLACEHOLDER demo cards. Prices are integer paisa from the API: the UI only formats them.
 */

/** A card as rendered: the feed card plus display-only extras. */
export interface ProductCardView extends StorefrontProductCard {
  /** PLACEHOLDER demo product (not from the catalog). */
  placeholder: boolean;
  /** PDP link (`/products/{slug}`); null for placeholder demo cards. */
  href: string | null;
  rating: number | null;
  review_count: number;
  badge: { label: string; tone: 'sale' | 'new' | 'bestseller' | 'info' } | null;
  /** Server-decided next/image `unoptimized` (cards also render inside client grids). */
  image_unoptimized?: boolean;
}

/** Flash-sale card. Real deals have no stock meter (null fields → the bar is hidden). */
export interface FlashDeal extends ProductCardView {
  discount_label: string;
  stock_left: number | null;
  claimed_percent: number | null;
}

export type ProductSource = 'latest' | 'bestsellers';

export interface FeedOptions {
  /** The request is a valid merchant preview: forward the preview token, never cache. */
  preview?: boolean;
}

// ---------- placeholders (PLACEHOLDER, prices in paisa) ----------
const IMG = '/themes/modern-commerce/images';
const demoImage = (file: string): StorefrontMedia => ({ id: `placeholder-${file}`, url: `${IMG}/${file}`, width: 800, height: 1000, alt: null, srcset: [] });

type PlaceholderSeed = Pick<ProductCardView, 'id' | 'slug' | 'name' | 'subtitle' | 'price_amount' | 'compare_at_amount' | 'badge'> & { file: string };
const placeholder = ({ file, ...p }: PlaceholderSeed): ProductCardView => ({
  ...p,
  currency: 'BDT',
  on_sale: p.compare_at_amount !== null && p.compare_at_amount > p.price_amount,
  image: demoImage(file),
  placeholder: true,
  href: null,
  rating: 4.9,
  review_count: 128,
});

const PLACEHOLDER_PRODUCTS: ProductCardView[] = (
  [
    { id: 'placeholder-1', slug: 'merino-cable-knit-cardigan', name: 'Merino cable-knit cardigan', subtitle: 'Little Loom · 2–4 yrs', price_amount: 185000, compare_at_amount: 230000, badge: { label: '−20%', tone: 'sale' }, file: 'cardigan.png' },
    { id: 'placeholder-2', slug: 'fleece-lined-quilted-puffer', name: 'Fleece-lined quilted puffer', subtitle: 'Kantha Kids · 3–6 yrs', price_amount: 345000, compare_at_amount: null, badge: { label: 'New in', tone: 'new' }, file: 'puffer.png' },
    { id: 'placeholder-3', slug: 'rainbow-stacker-peg-friends', name: 'Rainbow stacker & peg friends', subtitle: 'Tiny Atelier · 1–3 yrs', price_amount: 129000, compare_at_amount: null, badge: { label: 'Bestseller', tone: 'bestseller' }, file: 'stacker.png' },
    { id: 'placeholder-4', slug: 'organic-newborn-gift-set', name: 'Organic newborn gift set', subtitle: 'Shishu Cotton · 0–3 m', price_amount: 215000, compare_at_amount: null, badge: { label: 'Organic', tone: 'info' }, file: 'gift-set.png' },
  ] satisfies PlaceholderSeed[]
).map(placeholder);

const MORE_PLACEHOLDERS: ProductCardView[] = (
  [
    { id: 'placeholder-5', slug: 'hand-knit-elephant-buddy', name: 'Hand-knit elephant buddy', subtitle: 'Tiny Atelier · 0+ m', price_amount: 99000, compare_at_amount: null, badge: { label: 'Bestseller', tone: 'bestseller' }, file: 'elephant.png' },
    { id: 'placeholder-6', slug: 'silicone-first-meal-set', name: 'Silicone first-meal set', subtitle: 'Mamma Mia Home · 6+ m', price_amount: 145000, compare_at_amount: 165000, badge: { label: '−12%', tone: 'sale' }, file: 'meal-set.png' },
    { id: 'placeholder-7', slug: 'striped-linen-romper-hat', name: 'Striped linen romper & hat', subtitle: 'Kantha Kids · 1–3 yrs', price_amount: 139000, compare_at_amount: null, badge: null, file: 'summer-wear.png' },
    { id: 'placeholder-8', slug: 'gentle-bath-skincare-set', name: 'Gentle bath & skincare set', subtitle: 'Shishu Cotton · 0+ m', price_amount: 130000, compare_at_amount: null, badge: { label: 'New in', tone: 'new' }, file: 'bath-set.png' },
  ] satisfies PlaceholderSeed[]
).map(placeholder);

const deal = (base: ProductCardView, price_amount: number, compare_at_amount: number, discount_label: string, stock_left: number, claimed_percent: number): FlashDeal => ({
  ...base,
  price_amount,
  compare_at_amount,
  on_sale: true,
  discount_label,
  stock_left,
  claimed_percent,
});

const PLACEHOLDER_DEALS: FlashDeal[] = [
  deal(PLACEHOLDER_PRODUCTS[1]!, 241500, 345000, '−30%', 15, 75),
  deal(MORE_PLACEHOLDERS[0]!, 79000, 99000, '−20%', 6, 90),
  deal(MORE_PLACEHOLDERS[1]!, 124000, 165000, '−25%', 30, 50),
  deal(MORE_PLACEHOLDERS[3]!, 110500, 130000, '−15%', 45, 25),
];

export function placeholderProducts(limit: number, source: ProductSource = 'latest'): ProductCardView[] {
  const list =
    source === 'bestsellers'
      ? [...MORE_PLACEHOLDERS.slice(0, 3), PLACEHOLDER_PRODUCTS[0]!, ...PLACEHOLDER_PRODUCTS.slice(1)]
      : [...PLACEHOLDER_PRODUCTS, ...MORE_PLACEHOLDERS];
  return list.slice(0, limit);
}

export function placeholderDeals(limit: number): FlashDeal[] {
  return Array.from({ length: Math.min(limit, 8) }, (_, i) => ({ ...PLACEHOLDER_DEALS[i % PLACEHOLDER_DEALS.length]!, id: `deal-${i + 1}` }));
}

// ---------- feed ----------
const EMPTY_FEED: ProductFeed = { products: [], has_products: false };

/**
 * Fetch and validate one feed query. Never throws: a missing key, network error, non-2xx
 * (including a 404 from an API without the endpoint yet) or an invalid payload is logged and treated
 * as `has_products: false`, so the storefront falls back to placeholders instead of failing the page.
 */
export async function loadProductFeed(host: string, query: ProductFeedQuery, previewToken: string | null): Promise<ProductFeed> {
  const where = `${host} /storefront/products?sort=${query.sort}&limit=${query.limit}${query.onSale ? '&on_sale=1' : ''}`;
  try {
    const apiKey = serverEnv.apiKey;
    if (!apiKey) throw new Error('STOREFRONT_API_KEY is not configured');
    const { url, init } = buildProductFeedRequest(host, query, previewToken, { apiUrl: serverEnv.apiUrl, apiKey });
    const res = await fetch(url, init);
    if (!res.ok) {
      console.error(`[storefront] product feed responded ${res.status} for ${where}; using placeholders`);
      return EMPTY_FEED;
    }
    const parsed = parseProductFeed(await res.json().catch(() => null));
    if (!parsed) {
      console.error(`[storefront] invalid product feed payload for ${where}; using placeholders`);
      return EMPTY_FEED;
    }
    return parsed;
  } catch (err) {
    console.error(`[storefront] product feed unavailable for ${where}: ${(err as Error).message}; using placeholders`);
    return EMPTY_FEED;
  }
}

/** Per-request dedupe (hero + featured often ask for the same query). Primitive args only. */
const cachedFeed = cache((host: string, sort: ProductSource, limit: number, onSale: boolean, previewToken: string | null) =>
  loadProductFeed(host, { sort, limit, onSale }, previewToken),
);

async function feed(host: string, query: ProductFeedQuery, opts: FeedOptions): Promise<ProductFeed> {
  // Only a request the API already accepted as a preview forwards the token (and bypasses the cache).
  const token = opts.preview ? await getPreviewToken() : null;
  return cachedFeed(host, query.sort, query.limit, query.onSale ?? false, token);
}

/** A real card links to its PDP (Phase 5); the sale badge is derived from compare-at. */
export const toCardView = (p: StorefrontProductCard): ProductCardView => {
  const off = discountLabel(p.price_amount, p.compare_at_amount);
  const url = p.image?.url ?? '';
  return {
    ...p,
    placeholder: false,
    href: `/products/${p.slug}`,
    rating: null,
    review_count: 0,
    badge: off ? { label: off, tone: 'sale' } : null,
    image_unoptimized: url !== '' && !url.startsWith('/') && !isAllowedMediaOrigin(url),
  };
};
const toView = toCardView;

/** `−{round((1 − price/compare_at) × 100)}%` (U+2212 minus), from API amounts. */
export function discountLabel(price: number, compareAt: number | null): string {
  if (compareAt === null || compareAt <= 0 || price >= compareAt) return '';
  return `−${Math.round((1 - price / compareAt) * 100)}%`;
}

/** Real cards when the store has feed-eligible products (never padded), else placeholders. */
export function featuredFromFeed(result: ProductFeed, limit: number, source: ProductSource = 'latest'): ProductCardView[] {
  return result.has_products ? result.products.slice(0, limit).map(toView) : placeholderProducts(limit, source);
}

export interface FlashDealsResult {
  source: 'placeholder' | 'feed';
  deals: FlashDeal[];
}

export function flashDealsFromFeed(result: ProductFeed, limit: number): FlashDealsResult {
  if (!result.has_products) return { source: 'placeholder', deals: placeholderDeals(limit) };
  const deals = result.products
    .filter((p) => p.compare_at_amount !== null && p.compare_at_amount > p.price_amount)
    .slice(0, limit)
    .map((p): FlashDeal => ({ ...toView(p), discount_label: discountLabel(p.price_amount, p.compare_at_amount), stock_left: null, claimed_percent: null }));
  return { source: 'feed', deals };
}

export async function getFeaturedProducts(host: string, limit: number, source: ProductSource = 'latest', opts: FeedOptions = {}): Promise<ProductCardView[]> {
  return featuredFromFeed(await feed(host, { sort: source, limit }, opts), limit, source);
}

/** `on_sale=1` results. `source: 'feed'` with no deals → hidden (live) or an inline note (preview). */
export async function getFlashDeals(host: string, limit: number, opts: FeedOptions = {}): Promise<FlashDealsResult> {
  return flashDealsFromFeed(await feed(host, { sort: 'latest', limit, onSale: true }, opts), limit);
}
