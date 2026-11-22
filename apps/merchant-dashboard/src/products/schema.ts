import { CATALOG_LIMITS } from '@storeplix/types';
import { z } from 'zod';
import { optionErrors, type ProductFormValues } from './variants';

// Mirrors the §3.2 rules client-side; the API stays the authority (server details are mapped back to fields).
const SKU = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const BARCODE = /^[A-Za-z0-9-]{1,64}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** True when the string has ASCII control characters (the API strips/rejects them). */
export const hasControlChars = (s: string) => Array.from(s).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

const MONEY_HINT = 'Enter an amount like 3450 or 3450.50.';
const moneyNumber = (label: string) => z.number({ error: (iss) => (iss.input === undefined || iss.input === null ? `Enter ${label}.` : MONEY_HINT) });

const amount = (label: string) =>
  moneyNumber(label)
    .refine((n) => Number.isFinite(n), `Enter an amount like 3450 or 3450.50.`)
    .refine((n) => !Number.isFinite(n) || (Number.isInteger(n) && n >= 0 && n <= CATALOG_LIMITS.max_amount), 'Amount is too large.');

const optionalAmount = moneyNumber('an amount')
  .nullable()
  .refine((n) => n === null || Number.isFinite(n), 'Enter an amount like 3450 or 3450.50.')
  .refine((n) => n === null || !Number.isFinite(n) || (Number.isInteger(n) && n >= 0 && n <= CATALOG_LIMITS.max_amount), 'Amount is too large.');

const variant = z
  .object({
    id: z.string().optional(),
    option_values: z.array(z.string()),
    sku: z.string().refine((s) => !s.trim() || SKU.test(s.trim()), 'Use letters, numbers and . _ / - (max 64).'),
    barcode: z.string().refine((s) => !s.trim() || BARCODE.test(s.trim()), 'Use letters, numbers and - (max 64).'),
    price_amount: amount('a price').nullable().refine((n) => n !== null, 'Enter a price.'),
    compare_at_amount: optionalAmount,
    cost_amount: optionalAmount,
    is_enabled: z.boolean(),
    track_inventory: z.boolean(),
    allow_backorder: z.boolean(),
    image_media_id: z.string().nullable(),
    low_stock_threshold: z.number().int().min(0).max(100_000).nullable(),
    weight_grams: z.number().int().min(0, 'Weight can’t be negative.').max(1_000_000, 'Weight is too large.').nullable(),
    stock: z
      .number()
      .nullable()
      .refine((n) => n === null || (Number.isInteger(n) && n >= 0 && n <= 1_000_000), 'Stock must be a whole number from 0.'),
    loaded_on_hand: z.number().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.compare_at_amount !== null && v.price_amount !== null && Number.isFinite(v.compare_at_amount) && v.compare_at_amount <= v.price_amount) {
      ctx.addIssue({ code: 'custom', path: ['compare_at_amount'], message: 'Compare-at price must be higher than the price.' });
    }
  });

export const productFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Give the product a name.')
      .max(200, 'Keep the name to 200 characters.')
      .refine((s) => !hasControlChars(s), 'Remove special characters.'),
    slug: z.string().refine((s) => !s.trim() || (SLUG.test(s.trim()) && s.trim().length <= 220), 'Use lowercase letters, numbers and dashes.'),
    status: z.enum(['draft', 'active', 'archived']),
    description: z.any().nullable(),
    tags: z.array(z.string()).max(CATALOG_LIMITS.tags, `Up to ${CATALOG_LIMITS.tags} tags.`),
    category_ids: z.array(z.string()).max(CATALOG_LIMITS.categories_per_product, `Up to ${CATALOG_LIMITS.categories_per_product} categories.`),
    options: z.array(z.object({ name: z.string(), values: z.array(z.string()) })).max(CATALOG_LIMITS.options),
    variants: z.array(variant).min(1, 'Add at least one variant.').max(CATALOG_LIMITS.variants, `Up to ${CATALOG_LIMITS.variants} variants.`),
    images: z.array(z.object({ media_id: z.string(), url: z.string(), alt: z.string().max(160) })).max(CATALOG_LIMITS.images, `Up to ${CATALOG_LIMITS.images} photos.`),
    seo_title: z.string().max(70, 'Keep the page title to 70 characters.'),
    seo_description: z.string().max(160, 'Keep the description to 160 characters.'),
  })
  .superRefine((v, ctx) => {
    for (const [path, message] of Object.entries(optionErrors(v.options))) ctx.addIssue({ code: 'custom', path: path.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)), message });
    const skus = new Map<string, number>();
    v.variants.forEach((r, i) => {
      const k = r.sku.trim().toLowerCase();
      if (!k) return;
      if (skus.has(k)) ctx.addIssue({ code: 'custom', path: ['variants', i, 'sku'], message: 'This SKU is already used above.' });
      skus.set(k, i);
    });
  }) satisfies z.ZodType<ProductFormValues, unknown>;
