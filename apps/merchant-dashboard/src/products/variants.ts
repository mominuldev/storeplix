import type { CreateProductInput, Product, ProductOption, ProductVariant, ProductVariantInput, RichTextDoc, StockAdjustmentItem } from '@storeplix/types';
import { CATALOG_LIMITS } from '@storeplix/types';

// Pure product-form logic (contract §3.2, P4-1, P4-12): variant grid regeneration, payload building and
// mapping server `details` paths back to form fields. Kept framework-free so it is unit-tested directly.

export interface VariantRow {
  /** Server id; absent for variants created in this session. */
  id?: string;
  option_values: string[];
  sku: string;
  barcode: string;
  price_amount: number | null;
  compare_at_amount: number | null;
  cost_amount: number | null;
  is_enabled: boolean;
  track_inventory: boolean;
  allow_backorder: boolean;
  image_media_id: string | null;
  low_stock_threshold: number | null;
  weight_grams: number | null;
  /** Desired on-hand. New variants → `initial_on_hand`; existing → a `set` adjustment when it changed. */
  stock: number | null;
  /** On-hand when loaded (null for new variants) — sent as `expected_on_hand`. */
  loaded_on_hand: number | null;
}

export interface ImageRow {
  media_id: string;
  url: string;
  alt: string;
}

export interface ProductFormValues {
  name: string;
  slug: string;
  status: Product['status'];
  description: RichTextDoc | null;
  tags: string[];
  category_ids: string[];
  options: ProductOption[];
  variants: VariantRow[];
  images: ImageRow[];
  seo_title: string;
  seo_description: string;
}

export const comboKey = (values: string[]) => values.map((v) => v.trim().toLowerCase()).join('\u0000');

export function blankVariant(overrides: Partial<VariantRow> = {}): VariantRow {
  return {
    option_values: [],
    sku: '',
    barcode: '',
    price_amount: null,
    compare_at_amount: null,
    cost_amount: null,
    is_enabled: true,
    track_inventory: true,
    allow_backorder: false,
    image_media_id: null,
    low_stock_threshold: null,
    weight_grams: null,
    stock: 0,
    loaded_on_hand: null,
    ...overrides,
  };
}

export function emptyProductForm(): ProductFormValues {
  return {
    name: '',
    slug: '',
    status: 'draft',
    description: null,
    tags: [],
    category_ids: [],
    options: [],
    variants: [blankVariant()],
    images: [],
    seo_title: '',
    seo_description: '',
  };
}

/** Cartesian product of option values in option order. `[]` options → one empty combination. */
export function combinations(options: ProductOption[]): string[][] {
  return options.reduce<string[][]>((acc, o) => acc.flatMap((prefix) => o.values.map((v) => [...prefix, v])), [[]]);
}

export function combinationCount(options: ProductOption[]): number {
  return options.reduce((n, o) => n * Math.max(1, o.values.length), 1);
}

/**
 * Rebuilds the grid after options change. Rows whose combination still exists keep their id and values;
 * new combinations copy price / compare-at / cost / flags from the first existing row so the merchant only
 * fills stock and SKU. Throws when the result would exceed 100 variants.
 */
export function regenerateVariants(options: ProductOption[], current: VariantRow[]): VariantRow[] {
  const usable = options.filter((o) => o.values.length > 0);
  if (combinationCount(usable) > CATALOG_LIMITS.variants) throw new Error(`A product can have up to ${CATALOG_LIMITS.variants} variants.`);
  const byKey = new Map(current.map((r) => [comboKey(r.option_values), r]));
  const template = current[0] ?? blankVariant();
  return combinations(usable).map((values) => {
    const existing = byKey.get(comboKey(values));
    if (existing) return { ...existing, option_values: values };
    return blankVariant({
      option_values: values,
      price_amount: template.price_amount,
      compare_at_amount: template.compare_at_amount,
      cost_amount: template.cost_amount,
      track_inventory: template.track_inventory,
      allow_backorder: template.allow_backorder,
      weight_grams: template.weight_grams,
      stock: 0,
    });
  });
}

/** Option rules from §3.2: ≤ 3 options, names 1–40 and distinct, 1–20 values each 1–40 and distinct (case-insensitive). */
export function optionErrors(options: ProductOption[]): Record<string, string> {
  const errors: Record<string, string> = {};
  if (options.length > CATALOG_LIMITS.options) errors.options = `Up to ${CATALOG_LIMITS.options} options.`;
  const names = new Set<string>();
  options.forEach((o, i) => {
    const name = o.name.trim();
    if (!name) errors[`options.${i}.name`] = 'Name this option, e.g. Size.';
    else if (name.length > 40) errors[`options.${i}.name`] = 'Keep option names to 40 characters.';
    else if (names.has(name.toLowerCase())) errors[`options.${i}.name`] = 'Each option needs a different name.';
    names.add(name.toLowerCase());
    if (o.values.length === 0) errors[`options.${i}.values`] = 'Add at least one value.';
    else if (o.values.length > CATALOG_LIMITS.option_values) errors[`options.${i}.values`] = `Up to ${CATALOG_LIMITS.option_values} values per option.`;
    const seen = new Set<string>();
    for (const v of o.values) {
      const k = v.trim().toLowerCase();
      if (!k || v.length > 40) errors[`options.${i}.values`] = 'Values must be 1–40 characters.';
      else if (seen.has(k)) errors[`options.${i}.values`] = `“${v}” is listed twice.`;
      seen.add(k);
    }
  });
  return errors;
}

/** Can `value` be added to option `index` without breaking the rules or the 100-variant cap? */
export function canAddValue(options: ProductOption[], index: number, value: string): string | null {
  const v = value.trim();
  if (!v) return 'Type a value.';
  if (v.length > 40) return 'Keep values to 40 characters.';
  const o = options[index];
  if (!o) return 'Unknown option.';
  if (o.values.some((x) => x.toLowerCase() === v.toLowerCase())) return `“${v}” is already there.`;
  if (o.values.length >= CATALOG_LIMITS.option_values) return `Up to ${CATALOG_LIMITS.option_values} values per option.`;
  const next = options.map((x, i) => (i === index ? { ...x, values: [...x.values, v] } : x));
  if (combinationCount(next.filter((x) => x.values.length)) > CATALOG_LIMITS.variants) return `That would make more than ${CATALOG_LIMITS.variants} variants.`;
  return null;
}

export function variantTitle(values: string[]): string {
  return values.length ? values.join(' / ') : 'Default';
}

export function productToForm(p: Product): ProductFormValues {
  return {
    name: p.name,
    slug: p.slug,
    status: p.status,
    description: p.description,
    tags: p.tags,
    category_ids: p.categories.map((c) => c.id),
    options: p.options,
    variants: p.variants
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((v: ProductVariant) => ({
        id: v.id,
        option_values: v.option_values,
        sku: v.sku ?? '',
        barcode: v.barcode ?? '',
        price_amount: v.price_amount,
        compare_at_amount: v.compare_at_amount,
        cost_amount: v.cost_amount,
        is_enabled: v.is_enabled,
        track_inventory: v.track_inventory,
        allow_backorder: v.allow_backorder,
        image_media_id: v.image_media_id,
        low_stock_threshold: v.inventory.low_stock_threshold,
        weight_grams: v.weight_grams,
        stock: v.inventory.on_hand,
        loaded_on_hand: v.inventory.on_hand,
      })),
    images: p.images
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((i) => ({ media_id: i.media_id, url: i.media.url, alt: i.alt ?? '' })),
    seo_title: p.seo.title ?? '',
    seo_description: p.seo.description ?? '',
  };
}

const orNull = (s: string) => (s.trim() ? s.trim() : null);

/** Form → create/update body. Staff never send `cost_amount` (P4-5); existing variants never send stock (P4-12). */
export function formToPayload(v: ProductFormValues, { canViewCosts }: { canViewCosts: boolean }): CreateProductInput {
  const imageIds = new Set(v.images.map((i) => i.media_id));
  return {
    name: v.name.trim(),
    ...(v.slug.trim() ? { slug: v.slug.trim() } : {}),
    status: v.status,
    description: v.description,
    tags: v.tags,
    category_ids: v.category_ids,
    options: v.options.map((o) => ({ name: o.name.trim(), values: o.values.map((x) => x.trim()) })),
    images: v.images.map((i) => ({ media_id: i.media_id, alt: orNull(i.alt) })),
    seo: { title: orNull(v.seo_title), description: orNull(v.seo_description) },
    variants: v.variants.map((r) => {
      const base: ProductVariantInput = {
        ...(r.id ? { id: r.id } : {}),
        option_values: v.options.length ? r.option_values : [],
        sku: orNull(r.sku),
        barcode: orNull(r.barcode),
        price_amount: r.price_amount ?? 0,
        compare_at_amount: r.compare_at_amount,
        weight_grams: r.weight_grams,
        is_enabled: r.is_enabled,
        track_inventory: r.track_inventory,
        allow_backorder: r.allow_backorder,
        image_media_id: r.image_media_id && imageIds.has(r.image_media_id) ? r.image_media_id : null,
        low_stock_threshold: r.low_stock_threshold,
      };
      if (canViewCosts) base.cost_amount = r.cost_amount;
      if (!r.id) base.initial_on_hand = Math.max(0, r.stock ?? 0);
      return base;
    }),
  };
}

/** Stock edits on existing variants → `set` adjustments guarded by `expected_on_hand` (P4-12, P4-13). */
export function stockAdjustments(v: ProductFormValues, saved: Product): StockAdjustmentItem[] {
  const savedIds = new Set(saved.variants.map((x) => x.id));
  return v.variants
    .filter((r) => r.id && savedIds.has(r.id) && r.loaded_on_hand !== null && r.stock !== null && r.stock !== r.loaded_on_hand)
    .map((r) => ({ variant_id: r.id!, mode: 'set' as const, quantity: r.stock!, expected_on_hand: r.loaded_on_hand! }));
}

/** API dot path → form field path (`seo.title` → `seo_title`, `variants.3.initial_on_hand` → `variants.3.stock`). */
export function serverPathToField(path: string): string {
  if (path === 'seo.title') return 'seo_title';
  if (path === 'seo.description') return 'seo_description';
  return path.replace(/^variants\.(\d+)\.initial_on_hand$/, 'variants.$1.stock');
}

export function totalStock(rows: VariantRow[]): number {
  return rows.reduce((n, r) => n + Math.max(0, r.stock ?? 0), 0);
}
