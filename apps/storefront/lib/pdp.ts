import type { ProductOption, StorefrontProduct } from '@storeplix/types';

/** PDP variant selection (pure; shared by the client buy box and tests). */
export interface PdpVariant {
  id: string;
  option_values: string[];
  price_amount: number;
  compare_at_amount: number | null;
  /** Index into the gallery images, or null when the variant has no own image. */
  image_index: number | null;
}

export function toPdpVariants(product: Pick<StorefrontProduct, 'variants' | 'images'>): PdpVariant[] {
  const index = new Map(product.images.map((img, i) => [img.media_id, i]));
  return product.variants.map((v) => ({
    id: v.id,
    option_values: v.option_values,
    price_amount: v.price_amount,
    compare_at_amount: v.compare_at_amount,
    image_index: v.image_media_id ? (index.get(v.image_media_id) ?? null) : null,
  }));
}

export function findVariant(variants: PdpVariant[], selection: string[]): PdpVariant | undefined {
  if (variants.length === 1 && selection.length === 0) return variants[0];
  return variants.find((v) => v.option_values.length === selection.length && v.option_values.every((x, i) => x === selection[i]));
}

export function initialSelection(variants: PdpVariant[], options: ProductOption[]): string[] {
  return options.length ? [...(variants[0]?.option_values ?? [])] : [];
}

/** Chip state for `value` at option `index` given the rest of the selection. */
export function optionState(
  variants: PdpVariant[],
  selection: string[],
  index: number,
  value: string,
  avail: Record<string, { available: boolean }> | null,
): 'available' | 'sold_out' | 'missing' {
  const next = [...selection];
  next[index] = value;
  const v = findVariant(variants, next);
  if (!v) {
    // Another combination with this value exists: keep it choosable (the other options adapt).
    return variants.some((x) => x.option_values[index] === value) ? 'available' : 'missing';
  }
  if (avail && avail[v.id]?.available === false) return 'sold_out';
  return 'available';
}

/** Paisa → schema.org decimal string ("1850.00"). */
export function paisaToDecimal(paisa: number): string {
  return `${Math.floor(paisa / 100)}.${String(paisa % 100).padStart(2, '0')}`;
}

/** JSON-LD Product + BreadcrumbList for a live PDP (PHASE-5-CONTRACT §5). */
export function productJsonLd(product: StorefrontProduct, origin: string, inStock: boolean, descriptionText: string | null): object[] {
  const url = `${origin}/products/${product.slug}`;
  const availability = inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock';
  const offers =
    product.price_min_amount === product.price_max_amount
      ? { '@type': 'Offer', url, price: paisaToDecimal(product.price_min_amount), priceCurrency: product.currency, availability }
      : {
          '@type': 'AggregateOffer',
          url,
          lowPrice: paisaToDecimal(product.price_min_amount),
          highPrice: paisaToDecimal(product.price_max_amount),
          offerCount: product.variants.length,
          priceCurrency: product.currency,
          availability,
        };
  const item: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    url,
    offers,
  };
  if (product.images.length) item.image = product.images.slice(0, 8).map((i) => i.media.url);
  if (descriptionText) item.description = descriptionText;
  const primary = product.categories[0];
  const crumbs = [{ name: 'Home', item: `${origin}/` }, ...(primary ? [{ name: primary.name, item: `${origin}/c/${primary.slug}` }] : []), { name: product.name, item: url }];
  return [
    item,
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.item })),
    },
  ];
}

/** Plain text of a rich-text doc (meta description, JSON-LD), collapsed and capped. */
export function richTextPlain(doc: StorefrontProduct['description'], max = 160): string | null {
  if (!doc) return null;
  const parts: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: unknown; text?: unknown; content?: unknown };
    if (typeof n.text === 'string') parts.push(n.text);
    if (n.type === 'hardBreak') parts.push(' ');
    if (Array.isArray(n.content)) n.content.forEach(walk);
    if (n.type !== 'text') parts.push(' ');
  };
  walk(doc);
  const text = parts.join('').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return [...text].length > max ? `${[...text].slice(0, max - 1).join('').trimEnd()}…` : text;
}
