import 'server-only';

/**
 * Storefront product card data. PLACEHOLDER until the public product API
 * (GET /api/v1/storefront/products) exists - then this moves to @storeplix/types and this module
 * fetches it with tag `store:{host}`. Prices always come from the API; the UI never computes them.
 */
export interface StorefrontProductCard {
  id: string;
  slug: string;
  name: string;
  /** Secondary line, e.g. brand · age range */
  subtitle: string | null;
  price: number;
  compare_at_price: number | null;
  rating: number | null;
  review_count: number;
  badge: { label: string; tone: 'sale' | 'new' | 'bestseller' | 'info' } | null;
  image_url: string;
}

const IMG = '/themes/modern-commerce/images';

const PLACEHOLDER_PRODUCTS: StorefrontProductCard[] = [
  {
    id: 'placeholder-1', slug: 'merino-cable-knit-cardigan', name: 'Merino cable-knit cardigan',
    subtitle: 'Little Loom · 2–4 yrs', price: 1850, compare_at_price: 2300, rating: 4.9, review_count: 128,
    badge: { label: '−20%', tone: 'sale' }, image_url: `${IMG}/cardigan.png`,
  },
  {
    id: 'placeholder-2', slug: 'fleece-lined-quilted-puffer', name: 'Fleece-lined quilted puffer',
    subtitle: 'Kantha Kids · 3–6 yrs', price: 3450, compare_at_price: null, rating: 4.9, review_count: 128,
    badge: { label: 'New in', tone: 'new' }, image_url: `${IMG}/puffer.png`,
  },
  {
    id: 'placeholder-3', slug: 'rainbow-stacker-peg-friends', name: 'Rainbow stacker & peg friends',
    subtitle: 'Tiny Atelier · 1–3 yrs', price: 1290, compare_at_price: null, rating: 4.9, review_count: 128,
    badge: { label: 'Bestseller', tone: 'bestseller' }, image_url: `${IMG}/stacker.png`,
  },
  {
    id: 'placeholder-4', slug: 'organic-newborn-gift-set', name: 'Organic newborn gift set',
    subtitle: 'Shishu Cotton · 0–3 m', price: 2150, compare_at_price: null, rating: 4.9, review_count: 128,
    badge: { label: 'Organic', tone: 'info' }, image_url: `${IMG}/gift-set.png`,
  },
];

export async function getFeaturedProducts(_host: string, limit: number): Promise<StorefrontProductCard[]> {
  return PLACEHOLDER_PRODUCTS.slice(0, limit);
}
