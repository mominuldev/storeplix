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

const MORE_PLACEHOLDERS: StorefrontProductCard[] = [
  {
    id: 'placeholder-5', slug: 'hand-knit-elephant-buddy', name: 'Hand-knit elephant buddy',
    subtitle: 'Tiny Atelier · 0+ m', price: 990, compare_at_price: null, rating: 4.9, review_count: 128,
    badge: { label: 'Bestseller', tone: 'bestseller' }, image_url: `${IMG}/elephant.png`,
  },
  {
    id: 'placeholder-6', slug: 'silicone-first-meal-set', name: 'Silicone first-meal set',
    subtitle: 'Mamma Mia Home · 6+ m', price: 1450, compare_at_price: 1650, rating: 4.9, review_count: 128,
    badge: { label: '−12%', tone: 'sale' }, image_url: `${IMG}/meal-set.png`,
  },
  {
    id: 'placeholder-7', slug: 'striped-linen-romper-hat', name: 'Striped linen romper & hat',
    subtitle: 'Kantha Kids · 1–3 yrs', price: 1390, compare_at_price: null, rating: 4.9, review_count: 128,
    badge: null, image_url: `${IMG}/summer-wear.png`,
  },
  {
    id: 'placeholder-8', slug: 'gentle-bath-skincare-set', name: 'Gentle bath & skincare set',
    subtitle: 'Shishu Cotton · 0+ m', price: 1300, compare_at_price: null, rating: 4.9, review_count: 128,
    badge: { label: 'New in', tone: 'new' }, image_url: `${IMG}/bath-set.png`,
  },
];

export type ProductSource = 'latest' | 'bestsellers';

export async function getFeaturedProducts(_host: string, limit: number, source: ProductSource = 'latest'): Promise<StorefrontProductCard[]> {
  const list = source === 'bestsellers' ? [...MORE_PLACEHOLDERS.slice(0, 3), PLACEHOLDER_PRODUCTS[0]!, ...PLACEHOLDER_PRODUCTS.slice(1)] : [...PLACEHOLDER_PRODUCTS, ...MORE_PLACEHOLDERS];
  return list.slice(0, limit);
}

/** Flash-sale card: sale price, compare-at price and stock meter. PLACEHOLDER until Phase 5. */
export interface FlashDeal extends StorefrontProductCard {
  discount_label: string;
  stock_left: number;
  claimed_percent: number;
}

const PLACEHOLDER_DEALS: FlashDeal[] = [
  { ...PLACEHOLDER_PRODUCTS[1]!, id: 'deal-1', price: 2415, compare_at_price: 3450, discount_label: '−30%', stock_left: 15, claimed_percent: 75 },
  { ...MORE_PLACEHOLDERS[0]!, id: 'deal-2', price: 790, compare_at_price: 990, discount_label: '−20%', stock_left: 6, claimed_percent: 90 },
  { ...MORE_PLACEHOLDERS[1]!, id: 'deal-3', price: 1240, compare_at_price: 1650, discount_label: '−25%', stock_left: 30, claimed_percent: 50 },
  { ...MORE_PLACEHOLDERS[3]!, id: 'deal-4', price: 1105, compare_at_price: 1300, discount_label: '−15%', stock_left: 45, claimed_percent: 25 },
];

export async function getFlashDeals(_host: string, limit: number): Promise<FlashDeal[]> {
  return Array.from({ length: Math.min(limit, 8) }, (_, i) => ({ ...PLACEHOLDER_DEALS[i % PLACEHOLDER_DEALS.length]!, id: `deal-${i + 1}` }));
}
