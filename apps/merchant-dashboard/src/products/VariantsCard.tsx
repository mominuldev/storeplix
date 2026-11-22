import type { ProductOption } from '@storeplix/types';
import { CATALOG_LIMITS } from '@storeplix/types';
import { Button, cn, MoneyInput, Toggle } from '@storeplix/ui';
import { Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { FieldErrors } from 'react-hook-form';
import { formatCount } from '../catalog/format';
import { Panel } from '../online-store/components/Shell';
import { canAddValue, regenerateVariants, variantTitle, type ProductFormValues, type VariantRow } from './variants';

// Product editor 60:9381 · Variants card: option rows (name + value chips + "+ Add"), "+ Add option" (max 3),
// and the grid (Variant row 61:13220): thumb, title, price, cost (O A), stock, SKU, On-sale toggle.
// Changing options regenerates the grid and keeps existing variant ids per combination (contract §4).

export interface VariantsCardProps {
  options: ProductOption[];
  variants: VariantRow[];
  errors: FieldErrors<ProductFormValues>;
  canViewCosts: boolean;
  images: { media_id: string; url: string }[];
  onChange: (options: ProductOption[], variants: VariantRow[]) => void;
  onVariant: (index: number, patch: Partial<VariantRow>) => void;
}

const stockInput = (v: number | null) => (v === null || Number.isNaN(v) ? '' : String(v));
const parseStock = (s: string): number | null => {
  const t = s.trim();
  if (!t) return null;
  return /^\d{1,7}$/.test(t) ? Number(t) : Number.NaN;
};

export function VariantsCard({ options, variants, errors, canViewCosts, images, onChange, onVariant }: VariantsCardProps) {
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [valueError, setValueError] = useState<Record<number, string | null>>({});
  const [gridError, setGridError] = useState<string | null>(null);

  const apply = (next: ProductOption[]) => {
    try {
      onChange(next, regenerateVariants(next, variants));
      setGridError(null);
    } catch (e) {
      setGridError((e as Error).message);
    }
  };

  const addValue = (i: number) => {
    const v = (drafts[i] ?? '').trim();
    const problem = canAddValue(options, i, v);
    setValueError((m) => ({ ...m, [i]: problem }));
    if (problem) return;
    setDrafts((d) => ({ ...d, [i]: '' }));
    apply(options.map((o, idx) => (idx === i ? { ...o, values: [...o.values, v] } : o)));
  };

  const optionErr = (i: number, key: 'name' | 'values') => (errors.options as unknown as Record<number, Record<string, { message?: string }>> | undefined)?.[i]?.[key]?.message;
  const variantErr = (i: number, key: keyof VariantRow) => (errors.variants?.[i] as Record<string, { message?: string }> | undefined)?.[key]?.message;
  const isVariable = options.length > 0;

  return (
    <Panel
      title="Variants"
      description={isVariable ? `${formatCount(variants.length)} variants from ${options.length} option${options.length === 1 ? '' : 's'}. Set price and stock for each.` : 'Sizes, colours or materials. Each combination gets its own price and stock.'}
      actions={
        options.length < CATALOG_LIMITS.options && (
          <Button size="sm" variant="secondary" leftIcon={<Plus aria-hidden className="size-3.5" />} onClick={() => apply([...options, { name: options.length === 0 ? 'Size' : options.length === 1 ? 'Colour' : 'Material', values: [] }])}>
            Add option
          </Button>
        )
      }
    >
      {options.map((o, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-lg border border-border-default p-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              aria-label={`Option ${i + 1} name`}
              value={o.name}
              maxLength={40}
              onChange={(e) => onChange(options.map((x, idx) => (idx === i ? { ...x, name: e.target.value } : x)), variants)}
              className="h-9 w-32 rounded-md border border-border-default px-2.5 text-body font-semibold text-text-primary outline-none focus:border-brand-600"
            />
            <ul className="flex flex-wrap items-center gap-1.5" aria-label={`${o.name || 'Option'} values`}>
              {o.values.map((v) => (
                <li key={v} className="inline-flex h-8 items-center gap-1 rounded-full bg-brand-50 pr-1.5 pl-3 text-body font-medium text-brand-700 shadow-[inset_0_0_0_1px_var(--color-brand-500)]">
                  {v}
                  <button
                    type="button"
                    aria-label={`Remove ${v}`}
                    onClick={() => apply(options.map((x, idx) => (idx === i ? { ...x, values: x.values.filter((y) => y !== v) } : x)))}
                    className="rounded-full p-0.5 hover:bg-brand-100"
                  >
                    <X aria-hidden className="size-3" />
                  </button>
                </li>
              ))}
              <li>
                <input
                  aria-label={`Add ${o.name || 'option'} value`}
                  placeholder="+ Add"
                  value={drafts[i] ?? ''}
                  maxLength={40}
                  onChange={(e) => setDrafts((d) => ({ ...d, [i]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault();
                      addValue(i);
                    }
                  }}
                  onBlur={() => (drafts[i] ?? '').trim() && addValue(i)}
                  className="h-8 w-24 rounded-full border border-dashed border-border-strong px-3 text-caption outline-none focus:border-brand-600"
                />
              </li>
            </ul>
            <button type="button" aria-label={`Remove option ${o.name || i + 1}`} onClick={() => apply(options.filter((_, idx) => idx !== i))} className="ml-auto rounded-md p-1.5 text-text-muted hover:bg-surface-subtle hover:text-danger">
              <Trash2 aria-hidden className="size-4" />
            </button>
          </div>
          {(valueError[i] || optionErr(i, 'name') || optionErr(i, 'values')) && <p className="text-caption text-danger">{valueError[i] ?? optionErr(i, 'name') ?? optionErr(i, 'values')}</p>}
        </div>
      ))}
      {gridError && <p role="alert" className="text-caption text-danger">{gridError}</p>}

      {isVariable && variants.length > 0 && (
        <div role="table" aria-label="Variants" className="overflow-hidden rounded-lg border border-border-default">
          <div role="row" className="hidden items-center gap-3 bg-surface-subtle px-3 py-2 text-caption font-medium text-text-muted uppercase md:flex">
            <span role="columnheader" className="min-w-0 flex-1">
              Variant
            </span>
            <span role="columnheader" className="w-28">
              Price
            </span>
            {canViewCosts && (
              <span role="columnheader" className="w-28">
                Cost
              </span>
            )}
            <span role="columnheader" className="w-20">
              Stock
            </span>
            <span role="columnheader" className="w-28">
              SKU
            </span>
            <span role="columnheader" className="w-14 text-center">
              On sale
            </span>
          </div>
          {variants.map((r, i) => {
            const title = variantTitle(r.option_values);
            const img = images.find((m) => m.media_id === r.image_media_id) ?? images[0];
            return (
              <div key={r.id ?? title} role="row" className="flex flex-col gap-2 border-t border-border-default px-3 py-2.5 first:border-t-0 md:flex-row md:items-start md:gap-3 md:first:border-t">
                <span role="cell" className="flex min-w-0 flex-1 items-center gap-2.5 md:pt-1.5">
                  {img ? <img src={img.url} alt="" className="size-8 shrink-0 rounded-md object-cover" /> : <span className="size-8 shrink-0 rounded-md bg-surface-subtle" />}
                  <span className="truncate text-body font-medium text-text-primary">{title}</span>
                  {!r.id && <span className="text-caption text-text-muted">new</span>}
                </span>
                <span role="cell" className="grid grid-cols-2 gap-2 md:contents">
                  <MoneyInput
                    aria-label={`${title} price`}
                    containerClassName="md:w-28"
                    fieldClassName="min-h-9"
                    value={r.price_amount}
                    error={variantErr(i, 'price_amount') ?? variantErr(i, 'compare_at_amount')}
                    onChange={(v) => onVariant(i, { price_amount: v })}
                  />
                  {canViewCosts && (
                    <MoneyInput aria-label={`${title} cost`} containerClassName="md:w-28" fieldClassName="min-h-9" value={r.cost_amount} error={variantErr(i, 'cost_amount')} onChange={(v) => onVariant(i, { cost_amount: v })} />
                  )}
                  <StockCell title={title} row={r} error={variantErr(i, 'stock')} onChange={(stock) => onVariant(i, { stock })} />
                  <div className="flex flex-col gap-1 md:w-28">
                    <input
                      aria-label={`${title} SKU`}
                      value={r.sku}
                      maxLength={64}
                      onChange={(e) => onVariant(i, { sku: e.target.value })}
                      className={cn('h-9 rounded-md border px-2.5 text-body outline-none focus:border-brand-600', variantErr(i, 'sku') ? 'border-danger' : 'border-border-default')}
                      aria-invalid={variantErr(i, 'sku') ? true : undefined}
                    />
                    {variantErr(i, 'sku') && <span className="text-caption text-danger">{variantErr(i, 'sku')}</span>}
                  </div>
                </span>
                <span role="cell" className="flex items-center justify-between gap-2 md:w-14 md:justify-center md:pt-1.5">
                  <span className="text-caption text-text-muted md:hidden">On sale</span>
                  <Toggle label={`${title} on sale`} checked={r.is_enabled} onChange={(on) => onVariant(i, { is_enabled: on })} />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

/** Stock cell: plain number; existing variants show the change against the loaded value (sent as a `set` adjustment). */
export function StockCell({ title, row, error, onChange, className }: { title: string; row: VariantRow; error?: string; onChange: (v: number | null) => void; className?: string }) {
  const [text, setText] = useState(() => stockInput(row.stock));
  // Discard / reload replace the value from outside (adjust state while rendering, no effect).
  const [seen, setSeen] = useState(row.stock);
  if (!Object.is(seen, row.stock)) {
    setSeen(row.stock);
    if (!Object.is(parseStock(text), row.stock)) setText(stockInput(row.stock));
  }
  const changed = row.loaded_on_hand !== null && row.stock !== null && row.stock !== row.loaded_on_hand;
  const low = row.stock !== null && !Number.isNaN(row.stock) && row.stock <= (row.low_stock_threshold ?? 5);
  return (
    <div className={cn('flex flex-col gap-1 md:w-20', className)}>
      <input
        aria-label={`${title} stock`}
        inputMode="numeric"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseStock(e.target.value));
        }}
        className={cn(
          'h-9 w-full rounded-md border px-2.5 text-body outline-none focus:border-brand-600',
          error ? 'border-danger' : row.stock === 0 ? 'border-danger text-danger' : low ? 'border-warning text-warning' : 'border-border-default',
        )}
        aria-invalid={error ? true : undefined}
      />
      {error ? <span className="text-caption text-danger">{error}</span> : changed && <span className="text-caption text-text-muted">was {row.loaded_on_hand}</span>}
    </div>
  );
}
