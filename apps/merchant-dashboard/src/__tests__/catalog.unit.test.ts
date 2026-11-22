import { flattenTree, getProjection, parseMoney, validParentIds } from '@storeplix/ui';
import { describe, expect, it } from 'vitest';
import { formatIntlPhone, profitOf } from '../catalog/format';
import { columnMapErrors, pollInterval, wizardStep } from '../imports/fields';
import { plainTextToDoc, quickAddToProduct } from '../onboarding/AddProductsPage';
import { CATEGORY_MAX_DEPTH, toReorderInput, toTree } from '../products/categoryTree';
import { productFormSchema } from '../products/schema';
import { blankVariant, canAddValue, emptyProductForm, formToPayload, optionErrors, productToForm, regenerateVariants, serverPathToField, stockAdjustments } from '../products/variants';
import { category, product } from './catalog.fixtures';

describe('money input parsing (contract §9.2)', () => {
  it('accepts Bangla digits, commas and 2 decimals; rejects 3 decimals', () => {
    expect(parseMoney('৩,৪৫০')).toBe(345000);
    expect(parseMoney('3,450.50')).toBe(345050);
    expect(parseMoney('3450.505')).toBeNaN();
  });
});

describe('variant grid', () => {
  it('regenerates combinations and keeps ids for unchanged combinations', () => {
    const form = productToForm(product());
    const next = regenerateVariants(
      [
        { name: 'Size', values: ['M', 'L', 'XL'] },
        { name: 'Colour', values: ['Red'] },
      ],
      form.variants,
    );
    expect(next.map((v) => v.option_values.join('/'))).toEqual(['M/Red', 'L/Red', 'XL/Red']);
    expect(next.map((v) => v.id)).toEqual(['V1', 'V2', undefined]);
    // New rows copy price/cost from the first row and start with 0 stock.
    expect(next[2]).toMatchObject({ price_amount: 345000, cost_amount: 210000, stock: 0, loaded_on_hand: null });
  });

  it('drops combinations that no longer exist', () => {
    const form = productToForm(product());
    const next = regenerateVariants([{ name: 'Size', values: ['L'] }, { name: 'Colour', values: ['Red'] }], form.variants);
    expect(next.map((v) => v.id)).toEqual(['V2']);
  });

  it('refuses more than 100 variants', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `v${i}`);
    expect(() => regenerateVariants([{ name: 'A', values: many(11) }, { name: 'B', values: many(10) }], [])).toThrow(/100 variants/);
    expect(canAddValue([{ name: 'A', values: many(10) }, { name: 'B', values: many(10) }], 0, 'extra')).toMatch(/more than 100/);
  });

  it('option rules: names distinct, values distinct case-insensitively, ≤ 20 values', () => {
    expect(optionErrors([{ name: 'Size', values: ['M', 'm'] }])['options.0.values']).toMatch(/twice/);
    expect(optionErrors([{ name: 'Size', values: ['M'] }, { name: 'size', values: ['Red'] }])['options.1.name']).toMatch(/different name/);
    expect(optionErrors([{ name: 'Size', values: Array.from({ length: 21 }, (_, i) => `s${i}`) }])['options.0.values']).toMatch(/20/);
    expect(canAddValue([{ name: 'Size', values: ['M'] }], 0, 'm')).toMatch(/already/);
  });

  it('payload: staff never send cost; only new variants send initial_on_hand', () => {
    const form = productToForm(product());
    form.variants.push(blankVariant({ option_values: ['XL', 'Red'], price_amount: 100, cost_amount: 50, stock: 7 }));
    const staff = formToPayload(form, { canViewCosts: false });
    expect(staff.variants.every((v) => !('cost_amount' in v))).toBe(true);
    expect(staff.variants.map((v) => v.initial_on_hand)).toEqual([undefined, undefined, 7]);
    const owner = formToPayload(form, { canViewCosts: true });
    expect(owner.variants[0]).toMatchObject({ id: 'V1', cost_amount: 210000, option_values: ['M', 'Red'] });
  });

  it('stock edits on existing variants become set adjustments with expected_on_hand', () => {
    const p = product();
    const form = productToForm(p);
    form.variants[0]!.stock = 20;
    expect(stockAdjustments(form, p)).toEqual([{ variant_id: 'V1', mode: 'set', quantity: 20, expected_on_hand: 14 }]);
  });

  it('maps server paths to form fields', () => {
    expect(serverPathToField('variants.3.sku')).toBe('variants.3.sku');
    expect(serverPathToField('variants.1.initial_on_hand')).toBe('variants.1.stock');
    expect(serverPathToField('seo.title')).toBe('seo_title');
  });

  it('schema: compare-at must be higher than price; NaN money is rejected', () => {
    const f = emptyProductForm();
    f.name = 'Kurti';
    f.variants[0] = blankVariant({ price_amount: 1000, compare_at_amount: 900 });
    const r = productFormSchema.safeParse(f);
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.join('.') === 'variants.0.compare_at_amount')).toBe(true);
    f.variants[0] = blankVariant({ price_amount: Number.NaN });
    expect(productFormSchema.safeParse(f).error?.issues[0]?.message).toMatch(/amount like/);
  });

  it('schema: duplicate SKUs in the grid are flagged on the later row', () => {
    const f = productToForm(product());
    f.variants[1]!.sku = 'jt-rd-m';
    const r = productFormSchema.safeParse(f);
    expect(r.error?.issues.find((i) => i.path.join('.') === 'variants.1.sku')?.message).toMatch(/already used/);
  });
});

describe('category tree (depth 3, no self-nesting)', () => {
  const cats = [
    category({ id: 'A', name: 'A', children_count: 1 }),
    category({ id: 'A1', name: 'A1', parent_id: 'A', depth: 2, children_count: 1 }),
    category({ id: 'A11', name: 'A11', parent_id: 'A1', depth: 3 }),
    category({ id: 'B', name: 'B', position: 1 }),
  ];
  it('builds the tree and the reorder body', () => {
    const tree = toTree(cats);
    expect(toReorderInput(tree).items).toEqual([
      { id: 'A', parent_id: null },
      { id: 'A1', parent_id: 'A' },
      { id: 'A11', parent_id: 'A1' },
      { id: 'B', parent_id: null },
    ]);
  });
  it('B can nest under A or A1 but never under A11 (4th level)', () => {
    expect(validParentIds(toTree(cats), 'B', CATEGORY_MAX_DEPTH)).toEqual(['A', 'A1']);
    const flat = flattenTree(toTree(cats));
    expect(getProjection(flat, 'B', 'B', 10, CATEGORY_MAX_DEPTH).depth).toBeLessThanOrEqual(2);
  });
  it('A cannot move inside its own subtree', () => {
    expect(validParentIds(toTree(cats), 'A', CATEGORY_MAX_DEPTH)).toEqual([]);
    // A1 has a child (height 1) → only top-level parents.
    expect(validParentIds(toTree(cats), 'A1', CATEGORY_MAX_DEPTH)).toEqual(['A', 'B']);
  });
});

describe('import wizard state machine', () => {
  it('maps statuses to steps and polls only while working', () => {
    expect(['uploaded', 'validating', 'validated', 'importing', 'completed', 'failed', 'cancelled'].map((s) => wizardStep({ status: s as never }))).toEqual([
      'map',
      'validating',
      'review',
      'importing',
      'done',
      'failed',
      'upload',
    ]);
    expect(wizardStep(null)).toBe('upload');
    expect(pollInterval({ status: 'validating' })).toBe(2000);
    expect(pollInterval({ status: 'importing' })).toBe(2000);
    expect(pollInterval({ status: 'validated' })).toBe(false);
  });
  it('column map requires name + price and no duplicates', () => {
    expect(columnMapErrors('products', { A: 'name' })).toEqual(['Match a column to Price.']);
    expect(columnMapErrors('products', { A: 'name', B: 'price', C: 'price' })[0]).toMatch(/both/);
    expect(columnMapErrors('customers', { A: 'name' })).toEqual(['Match a column to Phone or Email.']);
  });
});

describe('formatting', () => {
  it('customer phone display', () => {
    expect(formatIntlPhone('8801712345678')).toBe('+880 1712-345678');
    expect(formatIntlPhone(null)).toBe('—');
  });
  it('profit per unit', () => {
    expect(profitOf(345000, 210000)).toEqual({ amount: 135000, percent: 39 });
    expect(profitOf(345000, null)).toBeNull();
  });
});

describe('onboarding 05 helpers', () => {
  it('plain text → RichTextDoc paragraphs and hard breaks', () => {
    expect(plainTextToDoc('Line one\nline two\n\nPara two')).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Line one' }, { type: 'hardBreak' }, { type: 'text', text: 'line two' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Para two' }] },
      ],
    });
    expect(plainTextToDoc('  ')).toBeNull();
  });
  it('sizes make a variable product with stock per size', () => {
    const body = quickAddToProduct({ name: 'Kurti', description: '', price: 95000, compare: null, stock: '4', sizes: ['M', 'L'], colours: [] }, []);
    expect(body.options).toEqual([{ name: 'Size', values: ['M', 'L'] }]);
    expect(body.variants).toEqual([
      { option_values: ['M'], price_amount: 95000, compare_at_amount: null, initial_on_hand: 4 },
      { option_values: ['L'], price_amount: 95000, compare_at_amount: null, initial_on_hand: 4 },
    ]);
    expect(body.status).toBe('active');
  });
});
